// Conservative Obsidian-side application for v2 snapshots and inbox changes.
// Remote data is never allowed to replace untracked or locally changed bytes.
import type { App } from "obsidian";
import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import {
  assertVaultPathGeneration,
  isVaultPathOpenInMarkdownEditor,
  writeBinaryAssetSafely,
  writeTextAtomically,
  withVaultPathWriteLock,
  withVaultPathWriteLocks,
  type VaultPathGenerationReader,
} from "./vault-sync-write-safety.ts";
import type { VaultSyncInboxEntry, VaultSyncInboxResolution, VaultSyncOutboxStore, VaultSyncV2Identity } from "./vault-sync-outbox.ts";
import type { VaultSyncV2ChangeItem, VaultSyncV2SnapshotItem } from "./vault-sync-v2-remote.ts";
import type { VaultSyncV2BaselineEntry, VaultSyncV2BaselineStore } from "./vault-sync-v2-baseline.ts";
import type { VaultSyncV2BaseContentStore } from "./vault-sync-v2-base-content.ts";
import type { VaultSyncPathIntentStore } from "./vault-sync-path-intents.ts";
import { withVaultSyncV2StateWriteLock } from "./vault-sync-v2-locks.ts";
import { mergeMarkdown3Way } from "./vault-sync-v2-merge.ts";
import {
  isVaultSyncContentWithinPlaintextLimit,
  isVaultSyncPlaintextSizeCompatible,
  uniqueVaultConflictCopyPath,
  VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES,
} from "./vault-sync-history.ts";
import type { createVaultSyncObjectWorkGate } from "./vault-sync-object-work-gate.ts";
import type { VaultSyncDeleteMode } from "./vault-sync-deletion-policy.ts";
import { pruneEmptySourceFoldersAfterMove } from "./vault-sync-empty-source-folders.ts";
import type { VaultSyncV2VerifiedPlaintextStage } from "./vault-sync-v2-plaintext-stage.ts";

type ApplyItem = Pick<VaultSyncV2ChangeItem,
  "fileId" | "fileVersionId" | "path" | "previousPath" | "previousVersionId" | "isDeleted" | "byteSize" | "content">
  & { cursor: string; mtimeMs: number; eventType?: VaultSyncV2ChangeItem["eventType"] };

interface StagedApplyMarker {
  version: 1;
  identity: VaultSyncV2Identity;
  fileId: string;
  fileVersionId: string;
  cursor: string;
  path: string;
  objectId: string;
  ciphertextHash: string;
  plaintextHash: string;
  byteSize: number;
  stagePath: string;
}

interface RemoteRenameApplyMarker {
  version: 1;
  identity: VaultSyncV2Identity;
  fileId: string;
  fileVersionId: string;
  previousVersionId: string;
  cursor: string;
  sourcePath: string;
  targetPath: string;
  sourceHash: string;
  outputHash: string | null;
  outputByteSize: number | null;
}

interface CaseDirectoryRenameMarker {
  version: 1;
  identity: VaultSyncV2Identity;
  sourcePath: string;
  targetPath: string;
  triggerFileId: string;
  triggerCursor: string;
  members: Array<{ fileId: string; sourcePath: string; targetPath: string }>;
}

const MAX_CONFLICT_RESOLUTION_BYTES = VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function contentFitsPlaintextLimit(
  item: Pick<ApplyItem, "byteSize" | "content">,
  maxBytes = MAX_CONFLICT_RESOLUTION_BYTES,
  allowEncryptedSize = false,
): boolean {
  return !!item.content && isVaultSyncContentWithinPlaintextLimit(item.byteSize, item.content, maxBytes, allowEncryptedSize);
}

function downloadedPlaintextMatchesItem(
  item: Pick<ApplyItem, "byteSize" | "content">,
  bytes: unknown,
  maxBytes = MAX_CONFLICT_RESOLUTION_BYTES,
  allowEncryptedSize = false,
): bytes is Uint8Array {
  return bytes instanceof Uint8Array && !!item.content && isVaultSyncPlaintextSizeCompatible({
    itemByteSize: item.byteSize,
    content: item.content,
    plaintextByteSize: bytes.byteLength,
    maxPlaintextBytes: maxBytes,
    allowEncryptedSize,
  });
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function decodeExactUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const roundTrip = new TextEncoder().encode(text);
    return roundTrip.byteLength === bytes.byteLength && roundTrip.every((byte, index) => byte === bytes[index])
      ? text
      : null;
  } catch {
    return null;
  }
}

function portableEqual(left: string, right: string): boolean {
  return portableVaultPathKey(left) === portableVaultPathKey(right);
}

function caseOnlyDirectoryRoots(sourcePath: string, targetPath: string): { sourcePath: string; targetPath: string } | null {
  const source = normalizeVaultPath(sourcePath)?.split("/");
  const target = normalizeVaultPath(targetPath)?.split("/");
  if (!source || !target || source.length !== target.length || source.length < 2) return null;
  let changedDirectory = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === target[index]) continue;
    if (changedDirectory >= 0 || index === source.length - 1 || !portableEqual(source[index], target[index])) return null;
    changedDirectory = index;
  }
  if (changedDirectory < 0) return null;
  for (let index = changedDirectory + 1; index < source.length; index += 1) {
    if (source[index] !== target[index]) return null;
  }
  return {
    sourcePath: source.slice(0, changedDirectory + 1).join("/"),
    targetPath: target.slice(0, changedDirectory + 1).join("/"),
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export interface VaultSyncV2ApplyOptions {
  app: App;
  identity: VaultSyncV2Identity;
  baseline: VaultSyncV2BaselineStore;
  journal?: Pick<VaultSyncOutboxStore, "load" | "markInboxItem" | "beginInboxConflictResolution" | "resolveInboxItem">;
  baseContent?: Pick<VaultSyncV2BaseContentStore, "get" | "put">;
  pathIntents?: Pick<VaultSyncPathIntentStore, "load" | "withReadLock" | "bindFile" | "remove">;
  deleteMode?: VaultSyncDeleteMode;
  deleteSafetyEnabled?: boolean;
  deleteSafetyRatio?: number;
  trashLocalFile?(file: any): Promise<void>;
  download(item: ApplyItem): Promise<Uint8Array>;
  /** Optional authenticated plaintext staging path for large chunked objects. */
  downloadToStage?(item: ApplyItem): Promise<VaultSyncV2VerifiedPlaintextStage | null>;
  rootFolder?: string;
  /** Event-fed local generation used to detect edit-then-revert races during downloads. */
  getPathGeneration?: VaultPathGenerationReader;
  /** Native Obsidian filename input may be composing even when no Markdown leaf is open. */
  isPathComposing?(path: string): boolean;
  /** Rebase the sole matching local update conflict after a complete net-zero remote chain is proven. */
  rebaseNetZeroConflict?(input: { operationId: string; expectedVersionId: string }): Promise<boolean>;
  /** Batch durable metadata writes to avoid quadratic work for large snapshots. */
  baselineBatchSize?: number;
  /** Disable implicit non-overlap merges while retaining explicit conflict resolution. */
  autoMergeEnabled?: boolean;
  /** Fail closed before snapshot file mutations if its target lease cannot be renewed. */
  assertApplyLease?: () => Promise<void>;
  /** Allow plaintext/ciphertext size separation for this client-encrypted Vault. */
  allowEncryptedSize?: boolean;
  /** A new local device may adopt an identical snapshot file or preserve any same-path collision. */
  preserveUntrackedSnapshotCollisions?: boolean;
  /** Uses the host's tracked-rename callback to suppress remote moves from becoming local path intents. */
  renameFileAndUpdateLinks?(file: any, path: string): Promise<void>;
  onBootstrapCollisionPreserved?(sourcePath: string, copyPath: string): void;
  objectWorkGate?: ReturnType<typeof createVaultSyncObjectWorkGate>;
}

/** Applies authenticated v2 changes; confirmed deletes preserve divergent local bytes before ACK. */
export function createVaultSyncV2ApplyEngine(options: VaultSyncV2ApplyOptions) {
  const batchSize = options.baselineBatchSize ?? 50;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("v2 baseline batch size is invalid");
  const app: any = options.app;
  const adapter: any = app.vault.adapter;
  const rootFolder = normalizeVaultPath(options.rootFolder ?? "");
  let snapshotApplyLeaseAssertion = options.assertApplyLease;
  const caseDirectoryMarkersByTrigger = new Map<string, { path: string; marker: CaseDirectoryRenameMarker }>();

  function caseDirectoryMarkerKey(fileId: string, cursor: string): string {
    return `${fileId}\u0000${cursor}`;
  }

  const caseDirectoryMarkerPrefix = `.wetongbu/sync-v2/case-directory-rename-e${options.identity.protocolEpoch}-${options.identity.targetId.toLowerCase()}-${options.identity.deviceId.toLowerCase()}-`;

  async function caseDirectoryMarkerPath(sourcePath: string, targetPath: string): Promise<string> {
    const key = await sha256Hex(new TextEncoder().encode(`${sourcePath}\u0000${targetPath}`));
    return `${caseDirectoryMarkerPrefix}${key}.json`;
  }

  async function assertSnapshotApplyLease(): Promise<void> {
    await snapshotApplyLeaseAssertion?.();
  }

  function isSnapshotApplyLeaseFailure(error: unknown): boolean {
    const code = String((error as any)?.code ?? "");
    return code.startsWith("snapshot_apply_lease_")
      || code === "snapshot_expired"
      || code === "snapshot_not_found"
      || code === "epoch_mismatch";
  }

  function inScope(path: string): boolean {
    if (!rootFolder) return true;
    return path === rootFolder || path.startsWith(rootFolder + "/");
  }

  function fileAt(path: string): any | null {
    const direct = app.vault.getAbstractFileByPath(path);
    if (direct) return direct;
    return app.vault.getFiles?.().find((file: any) => {
      const existing = normalizeVaultPath(file.path);
      return existing === path || (!!existing && portableEqual(existing, path));
    }) ?? null;
  }

  async function localBytes(path: string): Promise<Uint8Array | null> {
    const file = fileAt(path);
    if (!file || "children" in file) return null;
    const declaredSize = Number(file.stat?.size);
    if (Number.isSafeInteger(declaredSize) && declaredSize > MAX_CONFLICT_RESOLUTION_BYTES) {
      throw fail("v2_apply_local_file_too_large", "本机文件超过 Vault 同步单文件上限；已暂停应用并保留待处理状态");
    }
    const bytes = new Uint8Array(await app.vault.readBinary(file));
    if (bytes.byteLength > MAX_CONFLICT_RESOLUTION_BYTES) {
      throw fail("v2_apply_local_file_too_large", "本机文件超过 Vault 同步单文件上限；已暂停应用并保留待处理状态");
    }
    return bytes;
  }

  async function localHash(path: string): Promise<string | null> {
    const bytes = await localBytes(path);
    return bytes ? sha256Hex(bytes) : null;
  }

  async function renameTrackedFileAndUpdateLinks(file: any, path: string): Promise<void> {
    await assertSnapshotApplyLease();
    if (options.renameFileAndUpdateLinks) {
      await options.renameFileAndUpdateLinks(file, path);
      return;
    }
    const renameFile = app.fileManager?.renameFile;
    if (typeof renameFile !== "function") {
      throw fail("v2_apply_file_manager_unavailable", "Obsidian 文件管理 API 不可用；已暂停远端改名以保护笔记引用");
    }
    await renameFile.call(app.fileManager, file, path);
  }

  function isPathComposing(path: string): boolean {
    try {
      return options.isPathComposing?.(path) ?? false;
    } catch {
      return true;
    }
  }

  function assertNotComposing(path: string): void {
    if (isPathComposing(path)) {
      throw Object.assign(fail("v2_apply_composition_busy", "文件名仍处于输入组合状态，远端变更已暂缓"), { path });
    }
  }

  function assertNotEditing(path: string): void {
    assertNotComposing(path);
    if (isVaultPathOpenInMarkdownEditor(options.app, path)) {
      throw Object.assign(fail("v2_apply_active_editor_busy", "该笔记仍在编辑器中打开，远端更新已暂缓"), { path });
    }
  }

  async function parentPathState(path: string): Promise<"folder" | "file" | "missing"> {
    if (typeof adapter.stat === "function") {
      const stat = await adapter.stat(path).catch(() => null);
      if (stat?.type === "folder") return "folder";
      if (stat?.type === "file") return "file";
    }
    if (app.vault.getFolderByPath?.(path)) return "folder";
    const abstract = app.vault.getAbstractFileByPath(path);
    if (!abstract) return "missing";
    return Array.isArray(abstract.children) ? "folder" : "file";
  }

  async function ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const parentState = await parentPathState(current);
      if (parentState === "folder") continue;
      if (parentState === "file") {
        throw fail("v2_apply_parent_path_collision", "远端文件的父路径已被本机文件占用；本机内容保持不变");
      }

      try {
        await assertSnapshotApplyLease();
        await app.vault.createFolder(current);
      } catch (error) {
        if (isSnapshotApplyLeaseFailure(error)) throw error;
        // Another Vault writer can create the same parent after the lookup
        // above. Only a positively identified folder makes that race safe.
        const currentState = await parentPathState(current);
        if (currentState === "folder") continue;
        if (currentState === "file") {
          throw fail("v2_apply_parent_path_collision", "远端文件的父路径已被本机文件占用；本机内容保持不变");
        }
        throw error;
      }
    }
  }

  function stagedPlaintextPrefix(objectId: string, ciphertextHash: string): string {
    const host = new URL(options.identity.apiBaseUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
    return `.wetongbu/sync-v2/plaintext-download-${host}-${options.identity.targetId.toLowerCase()}-${options.identity.deviceId.toLowerCase()}-e${options.identity.protocolEpoch}-${objectId.toLowerCase()}-${ciphertextHash.toLowerCase()}-`;
  }

  function stagedApplyMarkerPath(fileId: string, cursor: string): string {
    const host = new URL(options.identity.apiBaseUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
    return `.wetongbu/sync-v2/staged-apply-${host}-${options.identity.targetId.toLowerCase()}-${options.identity.deviceId.toLowerCase()}-e${options.identity.protocolEpoch}-${fileId.toLowerCase()}-${cursor}.json`;
  }

  function stagedMarkerMatchesItem(marker: StagedApplyMarker, item: ApplyItem, path: string): boolean {
    const content = item.content;
    return !!content && content.kind === "object"
      && stableJson(marker.identity) === stableJson(options.identity)
      && marker.fileId === item.fileId && marker.fileVersionId === item.fileVersionId
      && marker.cursor === item.cursor && marker.path === path
      && marker.objectId === content.objectId && marker.ciphertextHash === content.ciphertextHash.toLowerCase()
      && isVaultSyncPlaintextSizeCompatible({
        itemByteSize: item.byteSize, content, plaintextByteSize: marker.byteSize,
        allowEncryptedSize: options.allowEncryptedSize,
      })
      && marker.stagePath.startsWith(stagedPlaintextPrefix(content.objectId, content.ciphertextHash))
      && /^\d+-[a-f0-9]{16}\.tmp$/i.test(marker.stagePath.slice(stagedPlaintextPrefix(content.objectId, content.ciphertextHash).length));
  }

  async function loadStagedApplyMarker(item: ApplyItem, path: string): Promise<StagedApplyMarker | null> {
    const markerPath = stagedApplyMarkerPath(item.fileId, item.cursor);
    if (!(await adapter.exists(markerPath))) return null;
    let serialized: string;
    try { serialized = await adapter.read(markerPath); } catch (error) { throw error; }
    let parsed: unknown;
    try { parsed = JSON.parse(serialized); } catch {
      throw fail("v2_apply_stage_marker_invalid", "大对象落盘恢复记录损坏；本机文件保持不变");
    }
    const keys = ["version", "identity", "fileId", "fileVersionId", "cursor", "path", "objectId",
      "ciphertextHash", "plaintextHash", "byteSize", "stagePath", "digest"];
    if (!hasExactKeys(parsed, keys) || parsed.version !== 1 || !isRecord(parsed.identity)
      || typeof parsed.fileId !== "string" || !UUID_PATTERN.test(parsed.fileId)
      || typeof parsed.fileVersionId !== "string" || !UUID_PATTERN.test(parsed.fileVersionId)
      || typeof parsed.cursor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(parsed.cursor)
      || typeof parsed.path !== "string" || typeof parsed.objectId !== "string" || !UUID_PATTERN.test(parsed.objectId)
      || typeof parsed.ciphertextHash !== "string" || !SHA256_PATTERN.test(parsed.ciphertextHash)
      || typeof parsed.plaintextHash !== "string" || !SHA256_PATTERN.test(parsed.plaintextHash)
      || !Number.isSafeInteger(parsed.byteSize) || Number(parsed.byteSize) < 0
      || typeof parsed.stagePath !== "string" || typeof parsed.digest !== "string" || !SHA256_PATTERN.test(parsed.digest)) {
      throw fail("v2_apply_stage_marker_invalid", "大对象落盘恢复记录字段无效；本机文件保持不变");
    }
    const { digest, ...body } = parsed;
    if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) {
      throw fail("v2_apply_stage_marker_invalid", "大对象落盘恢复记录摘要无效；本机文件保持不变");
    }
    const marker = body as unknown as StagedApplyMarker;
    if (!stagedMarkerMatchesItem(marker, item, path)) {
      throw fail("v2_apply_stage_marker_conflict", "大对象落盘恢复记录与当前远端版本不一致；本机文件保持不变");
    }
    return marker;
  }

  async function persistStagedApplyMarker(marker: StagedApplyMarker): Promise<void> {
    const markerPath = stagedApplyMarkerPath(marker.fileId, marker.cursor);
    const digest = await sha256Hex(new TextEncoder().encode(stableJson(marker)));
    const serialized = stableJson({ ...marker, digest }) + "\n";
    const markerItem: ApplyItem = {
      fileId: marker.fileId,
      fileVersionId: marker.fileVersionId,
      cursor: marker.cursor,
      path: marker.path,
      previousPath: null,
      previousVersionId: null,
      content: { kind: "object", objectId: marker.objectId, ciphertextHash: marker.ciphertextHash,
        byteSize: marker.byteSize } as any,
      byteSize: marker.byteSize,
      mtimeMs: 0,
      isDeleted: false,
    };

    await withVaultPathWriteLock(markerPath, async () => {
      const markerDirectory = markerPath.slice(0, markerPath.lastIndexOf("/"));
      await ensureParent(markerPath);
      const markerTemps = (await adapter.list(markerDirectory)).files
        .filter((candidate: string) => candidate.startsWith(markerPath + ".tmp-"));
      for (const temporaryPath of markerTemps) await adapter.remove(temporaryPath).catch(() => {});

      if (await adapter.exists(markerPath)) {
        const existing = await loadStagedApplyMarker(markerItem, marker.path);
        if (!existing || stableJson(existing) !== stableJson(marker)) {
          throw fail("v2_apply_stage_marker_conflict", "已有的大对象落盘恢复记录不匹配；本机文件保持不变");
        }
        return;
      }

      if (typeof adapter.rename !== "function") {
        throw fail("v2_apply_stage_marker_rename_unsupported", "当前文件适配器不支持安全保存大对象恢复记录；文件保持不变");
      }

      const temporaryPath = `${markerPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await adapter.write(temporaryPath, serialized);
        if (await adapter.read(temporaryPath) !== serialized) {
          throw fail("v2_apply_stage_marker_write_failed", "大对象落盘恢复记录未能回读确认；本机文件保持不变");
        }

        // Publish the verified marker with one adapter rename. A process exit
        // while writing the temporary file then leaves no marker that could
        // poison inbox recovery on the next run.
        try {
          await adapter.rename(temporaryPath, markerPath);
        } catch (error) {
          // Some adapters can report an error after the move completed. Accept
          // that case only when the final path contains the exact marker bytes.
          if (await adapter.read(markerPath).catch(() => null) !== serialized) throw error;
        }
        if (await adapter.read(markerPath) !== serialized) {
          throw fail("v2_apply_stage_marker_write_failed", "大对象落盘恢复记录未能回读确认；本机文件保持不变");
        }

        const checked = await loadStagedApplyMarker(markerItem, marker.path);
        if (!checked || stableJson(checked) !== stableJson(marker)) {
          throw fail("v2_apply_stage_marker_write_failed", "大对象落盘恢复记录摘要校验失败；本机文件保持不变");
        }
      } finally {
        await adapter.remove(temporaryPath).catch(() => {});
      }
    });
  }

  async function clearStagedApplyMarker(fileId: string, cursor: string): Promise<void> {
    const path = stagedApplyMarkerPath(fileId, cursor);
    if (await adapter.exists(path)) await adapter.remove(path).catch(() => {});
  }

  async function clearRecoveredPlaintextStage(path: string): Promise<void> {
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
      if (await adapter.exists(path)) throw new Error("stage remains after remove");
    } catch {
      throw fail("v2_apply_stage_cleanup_failed", "同步暂存清理未完成；本机内容保持不变，稍后重试");
    }
  }

  async function stagedFileMatches(path: string, byteSize: number, plaintextHash: string): Promise<boolean> {
    const file = fileAt(path);
    if (!file || "children" in file || byteSize > MAX_CONFLICT_RESOLUTION_BYTES) return false;
    const declaredSize = Number(file.stat?.size);
    if (Number.isSafeInteger(declaredSize) && declaredSize !== byteSize) return false;
    try {
      const bytes = new Uint8Array(await adapter.readBinary(path));
      return bytes.byteLength === byteSize && bytes.byteLength <= MAX_CONFLICT_RESOLUTION_BYTES
        && await sha256Hex(bytes) === plaintextHash;
    } catch {
      return false;
    }
  }

  async function promoteStagedApplyMarker(marker: StagedApplyMarker, expectedGeneration?: number): Promise<void> {
    await withVaultPathWriteLock(marker.path, async () => {
      assertVaultPathGeneration(marker.path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(marker.path);
      const target = fileAt(marker.path);
      if (target) {
        if (await stagedFileMatches(marker.path, marker.byteSize, marker.plaintextHash)) return;
        throw fail("v2_apply_stage_recovery_conflict", "大对象暂存目标已被本机内容占用；文件保持不变");
      }
      const staged = fileAt(marker.stagePath);
      if (!staged || "children" in staged
        || !(await stagedFileMatches(marker.stagePath, marker.byteSize, marker.plaintextHash))) {
        throw fail("v2_apply_stage_recovery_missing", "已认证的大对象暂存文件缺失或校验失败；同步稍后重试");
      }
      await ensureParent(marker.path);
      if (fileAt(marker.path)) throw fail("v2_apply_path_collision", "远端文件目标刚被本机内容占用；文件保持不变");
      await assertSnapshotApplyLease();
      assertVaultPathGeneration(marker.path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      if (fileAt(marker.path)) throw fail("v2_apply_path_collision", "远端文件目标刚被本机内容占用；文件保持不变");
      await app.vault.rename(staged, marker.path);
      const promoted = fileAt(marker.path);
      const promotedStat = await adapter.stat(marker.path).catch(() => null);
      if (!promoted || "children" in promoted || (promotedStat && promotedStat.size !== marker.byteSize)) {
        throw fail("v2_apply_write_unverified", "大对象落盘回读校验失败；同步恢复记录已保留");
      }
    });
  }

  async function discardInterruptedStagedApplyMarker(item: ApplyItem, path: string,
    prior: VaultSyncV2BaselineEntry | null, pathMove: { state: string } | null): Promise<boolean> {
    const content = item.content;
    if (pathMove || (prior && !prior.isDeleted) || fileAt(path)
      || !content || content.kind !== "object") return false;

    const markerPath = stagedApplyMarkerPath(item.fileId, item.cursor);
    return withVaultPathWriteLock(markerPath, () => withVaultSyncV2StateWriteLock(options.identity, async () => {
      // The baseline may have changed while this operation waited for the
      // marker-path lock. Serialize this final check and marker removal with
      // baseline writers, then inspect the latest path intents under their
      // own store lock. Never discard recovery evidence using the earlier
      // applyOne snapshot.
      const latestPrior = await options.baseline.get(item.fileId);
      const removeInvalidMarker = async (latestPathMove: boolean): Promise<boolean> => {
        if (latestPathMove || (latestPrior && !latestPrior.isDeleted) || fileAt(path)
          || !(await adapter.exists(markerPath))) return false;
        try {
          await loadStagedApplyMarker(item, path);
          return false;
        } catch (error: any) {
          if (error?.code !== "v2_apply_stage_marker_invalid") throw error;
        }

        await adapter.remove(markerPath);
        const markerDirectory = markerPath.slice(0, markerPath.lastIndexOf("/"));
        const markerTemps = (await adapter.list(markerDirectory)).files
          .filter((candidate: string) => candidate.startsWith(markerPath + ".tmp-"));
        for (const temporaryPath of markerTemps) await adapter.remove(temporaryPath).catch(() => {});
        return true;
      };
      if (options.pathIntents?.withReadLock) {
        return options.pathIntents.withReadLock(async (entries) => {
          const latestPathMove = entries.some((entry) => entry.fileId === item.fileId
            || (!!latestPrior && !latestPrior.isDeleted && !entry.fileId && entry.fromPath === latestPrior.path));
          return removeInvalidMarker(latestPathMove);
        });
      }
      return removeInvalidMarker(!!pathMove);
    }));
  }

  async function resumeStagedApply(item: ApplyItem, path: string, prior: VaultSyncV2BaselineEntry | null,
    pathMove: { state: string } | null, expectedGeneration?: number): Promise<VaultSyncV2BaselineEntry | null> {
    let marker: StagedApplyMarker | null;
    try {
      marker = await loadStagedApplyMarker(item, path);
    } catch (error) {
      if (await discardInterruptedStagedApplyMarker(item, path, prior, pathMove)) return null;
      throw error;
    }
    if (!marker) return null;
    if (pathMove || (prior && !(prior.fileVersionId === marker.fileVersionId && prior.cursor === marker.cursor
      && prior.path === marker.path && prior.plaintextHash === marker.plaintextHash && prior.byteSize === marker.byteSize
      && !prior.isDeleted))) {
      throw fail("v2_apply_stage_marker_conflict", "大对象落盘期间文件身份已变化；本机文件保持不变");
    }
    if (fileAt(path)) {
      if (!(await stagedFileMatches(path, marker.byteSize, marker.plaintextHash))) {
        throw fail("v2_apply_stage_recovery_conflict", "大对象落盘后本机文件已变化；本机内容保持不变");
      }
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      // Some adapters can leave both the promoted destination and its source
      // stage after an interrupted move/copy. The destination is already
      // verified against the authenticated marker, so remove the private
      // plaintext duplicate before allowing the baseline or ACK to advance.
      await clearRecoveredPlaintextStage(marker.stagePath);
      // Removing the duplicate stage is asynchronous and can overlap with a
      // local edit to the promoted destination. Never acknowledge the remote
      // version from the earlier byte check if an intervening vault event ran.
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
    } else if (await adapter.exists(marker.stagePath)) {
      try {
        await promoteStagedApplyMarker(marker, options.getPathGeneration?.(path));
      } catch (error: any) {
        if (error?.code !== "v2_apply_stage_recovery_missing") throw error;
        await adapter.remove(marker.stagePath).catch(() => {});
        await clearStagedApplyMarker(item.fileId, item.cursor);
        return null;
      }
    } else {
      await clearStagedApplyMarker(item.fileId, item.cursor);
      return null;
    }
    return { fileId: marker.fileId, fileVersionId: marker.fileVersionId, cursor: marker.cursor,
      path: marker.path, plaintextHash: marker.plaintextHash, byteSize: marker.byteSize, isDeleted: false };
  }

  function caseRenamePaths(fileId: string, cursor: string) {
    if (!/^\d{1,19}$/.test(cursor)) throw fail("v2_case_rename_cursor_invalid", "大小写改名游标无效");
    const stem = `.wetongbu/sync-v2/case-rename-${options.identity.protocolEpoch}-${fileId}-${cursor}`;
    return { markerPath: `${stem}.json`, stagePath: `${stem}.stage` };
  }

  async function ensureCaseRenameMarker(input: {
    fileId: string; cursor: string; sourcePath: string; targetPath: string; plaintextHash: string;
  }): Promise<{ markerPath: string; stagePath: string }> {
    const paths = caseRenamePaths(input.fileId, input.cursor);
    const body = { version: 1, ...input };
    const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(body)));
    const serialized = JSON.stringify({ ...body, digest }) + "\n";
    if (await adapter.exists(paths.markerPath)) {
      let parsed: any;
      try { parsed = JSON.parse(await adapter.read(paths.markerPath)); } catch {
        throw fail("v2_case_rename_marker_invalid", "大小写改名恢复记录损坏；文件已保留");
      }
      if (JSON.stringify(parsed) !== JSON.stringify({ ...body, digest })) {
        throw fail("v2_case_rename_marker_invalid", "大小写改名恢复记录与当前版本不符；文件已保留");
      }
    } else {
      await ensureParent(paths.markerPath);
      await adapter.write(paths.markerPath, serialized);
      if (await adapter.read(paths.markerPath) !== serialized) {
        throw fail("v2_case_rename_marker_write_failed", "大小写改名恢复记录未能回读确认；文件已保留");
      }
    }
    return paths;
  }

  async function clearCaseRenameMarker(fileId: string, cursor: string): Promise<void> {
    const { markerPath } = caseRenamePaths(fileId, cursor);
    if (await adapter.exists(markerPath)) await adapter.remove(markerPath).catch(() => {});
  }

  async function parseCaseDirectoryRenameMarker(path: string): Promise<CaseDirectoryRenameMarker> {
    let parsed: unknown;
    try { parsed = JSON.parse(await adapter.read(path)); } catch {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录损坏；本机文件已保留");
    }
    const keys = ["version", "identity", "sourcePath", "targetPath", "triggerFileId", "triggerCursor", "members", "digest"];
    if (!hasExactKeys(parsed, keys) || parsed.version !== 1 || !isRecord(parsed.identity)
      || typeof parsed.sourcePath !== "string" || typeof parsed.targetPath !== "string"
      || normalizeVaultPath(parsed.sourcePath) !== parsed.sourcePath || normalizeVaultPath(parsed.targetPath) !== parsed.targetPath
      || parsed.sourcePath === parsed.targetPath || !portableEqual(parsed.sourcePath, parsed.targetPath)
      || typeof parsed.triggerFileId !== "string" || !UUID_PATTERN.test(parsed.triggerFileId)
      || typeof parsed.triggerCursor !== "string" || !/^\d{1,19}$/.test(parsed.triggerCursor)
      || !Array.isArray(parsed.members) || !parsed.members.length
      || !parsed.members.every((member: unknown) => isRecord(member) && hasExactKeys(member, ["fileId", "sourcePath", "targetPath"])
        && typeof member.fileId === "string" && UUID_PATTERN.test(member.fileId)
        && typeof member.sourcePath === "string" && normalizeVaultPath(member.sourcePath) === member.sourcePath
        && typeof member.targetPath === "string" && normalizeVaultPath(member.targetPath) === member.targetPath)
      || typeof parsed.digest !== "string" || !SHA256_PATTERN.test(parsed.digest)) {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录字段无效；本机文件已保留");
    }
    const marker = parsed as unknown as CaseDirectoryRenameMarker & { digest: string };
    if (stableJson(marker.identity) !== stableJson(options.identity)
      || await caseDirectoryMarkerPath(marker.sourcePath, marker.targetPath) !== path
      || new Set(marker.members.map((member) => member.fileId)).size !== marker.members.length
      || marker.members.some((member) => !member.sourcePath.startsWith(`${marker.sourcePath}/`)
        || member.targetPath !== `${marker.targetPath}${member.sourcePath.slice(marker.sourcePath.length)}`)) {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录与当前同步身份或路径映射不符；本机文件已保留");
    }
    const { digest, ...body } = marker;
    if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录摘要无效；本机文件已保留");
    }
    return body;
  }

  async function loadCaseDirectoryRenameMarker(roots: { sourcePath: string; targetPath: string }): Promise<{
    path: string; marker: CaseDirectoryRenameMarker;
  } | null> {
    const path = await caseDirectoryMarkerPath(roots.sourcePath, roots.targetPath);
    if (!(await adapter.exists(path))) return null;
    const marker = await parseCaseDirectoryRenameMarker(path);
    if (marker.sourcePath !== roots.sourcePath || marker.targetPath !== roots.targetPath) {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录对应其他路径；本机文件已保留");
    }
    caseDirectoryMarkersByTrigger.set(caseDirectoryMarkerKey(marker.triggerFileId, marker.triggerCursor), { path, marker });
    return { path, marker };
  }

  async function ensureCaseDirectoryRenameMarker(input: {
    roots: { sourcePath: string; targetPath: string };
    fileId: string;
    cursor: string;
    members: Array<{ fileId: string; sourcePath: string; targetPath: string }>;
  }): Promise<{ path: string; marker: CaseDirectoryRenameMarker }> {
    const existing = await loadCaseDirectoryRenameMarker(input.roots);
    if (existing) {
      if (!existing.marker.members.some((member) => member.fileId === input.fileId
        && member.sourcePath !== input.roots.sourcePath && member.targetPath !== input.roots.targetPath)) {
        throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录没有当前文件成员；本机文件已保留");
      }
      return existing;
    }
    const marker: CaseDirectoryRenameMarker = {
      version: 1, identity: options.identity,
      sourcePath: input.roots.sourcePath, targetPath: input.roots.targetPath,
      triggerFileId: input.fileId, triggerCursor: input.cursor,
      members: input.members.slice().sort((left, right) => left.fileId.localeCompare(right.fileId)),
    };
    const path = await caseDirectoryMarkerPath(marker.sourcePath, marker.targetPath);
    const digest = await sha256Hex(new TextEncoder().encode(stableJson(marker)));
    const serialized = stableJson({ ...marker, digest }) + "\n";
    await ensureParent(path);
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名恢复记录未能回读确认；本机文件保持原路径");
    }
    const saved = await parseCaseDirectoryRenameMarker(path);
    caseDirectoryMarkersByTrigger.set(caseDirectoryMarkerKey(saved.triggerFileId, saved.triggerCursor), { path, marker: saved });
    return { path, marker: saved };
  }

  async function caseDirectoryRenameAlreadyApplied(roots: { sourcePath: string; targetPath: string }, fileId: string): Promise<boolean> {
    const entries = await options.baseline.load();
    return entries.some((entry) => entry.fileId !== fileId && entry.path.startsWith(`${roots.targetPath}/`));
  }

  async function caseDirectoryRenameComplete(marker: CaseDirectoryRenameMarker): Promise<boolean> {
    const entries = new Map((await options.baseline.load()).map((entry) => [entry.fileId, entry]));
    return marker.members.every((member) => entries.get(member.fileId)?.path === member.targetPath);
  }

  async function clearCompletedCaseDirectoryRenameMarkers(force = false): Promise<void> {
    if (!force && caseDirectoryMarkersByTrigger.size === 0) return;
    const listed = await adapter.list(".wetongbu/sync-v2").catch(() => ({ files: [], folders: [] }));
    for (const path of listed.files.filter((candidate: string) => candidate.startsWith(caseDirectoryMarkerPrefix)
      && candidate.endsWith(".json"))) {
      const marker = await parseCaseDirectoryRenameMarker(path);
      if (!(await caseDirectoryRenameComplete(marker))) continue;
      await adapter.remove(path).catch(() => {});
      caseDirectoryMarkersByTrigger.delete(caseDirectoryMarkerKey(marker.triggerFileId, marker.triggerCursor));
    }
  }

  async function moveCaseOnlyDirectory(roots: { sourcePath: string; targetPath: string }, current: {
    fileId: string; cursor: string; sourcePath: string; targetPath: string;
  }, expectedTargetGeneration?: number, expectedSourceGeneration?: number): Promise<boolean> {
    const existingMarker = await loadCaseDirectoryRenameMarker(roots);
    const alreadyApplied = !!existingMarker || await caseDirectoryRenameAlreadyApplied(roots, current.fileId);
    const sourceFolder = fileAt(roots.sourcePath);
    const sourceActualPath = sourceFolder ? normalizeVaultPath(sourceFolder.path) : null;
    const targetFolder = fileAt(roots.targetPath);
    const targetActualPath = targetFolder ? normalizeVaultPath(targetFolder.path) : null;
    if (targetFolder && targetActualPath !== roots.sourcePath && targetActualPath !== roots.targetPath) {
      throw fail("v2_apply_rename_collision", "大小写目录改名目标被其他目录占用；本机文件已保留");
    }
    if (sourceActualPath === roots.sourcePath && targetActualPath === roots.targetPath) {
      throw fail("v2_apply_rename_collision", "源目录和目标目录同时存在；本机文件均已保留");
    }
    const targetDirectoryProven = targetActualPath === roots.targetPath
      && (sourceActualPath === roots.targetPath || (!sourceActualPath && alreadyApplied));
    if (sourceActualPath !== roots.sourcePath && !targetDirectoryProven) {
      throw fail("v2_apply_local_move_unresolved", "大小写目录改名源文件夹不存在；本机内容保持待处理");
    }
    if (sourceActualPath === roots.targetPath && !alreadyApplied) {
      throw fail("v2_apply_rename_collision", "目标目录已存在但没有可验证的改名恢复记录；本机文件已保留");
    }

    const baselines = await options.baseline.load();
    const sourcePrefix = `${roots.sourcePath}/`;
    const members = baselines.filter((entry) => !entry.isDeleted && entry.path.startsWith(sourcePrefix))
      .map((entry) => ({ fileId: entry.fileId, sourcePath: entry.path,
        targetPath: `${roots.targetPath}${entry.path.slice(roots.sourcePath.length)}` }));
    if (!members.some((member) => member.fileId === current.fileId
      && member.sourcePath === current.sourcePath && member.targetPath === current.targetPath)) {
      members.push({ fileId: current.fileId, sourcePath: current.sourcePath, targetPath: current.targetPath });
    }
    const marker = existingMarker ?? await ensureCaseDirectoryRenameMarker({ roots,
      fileId: current.fileId, cursor: current.cursor, members });

    if (sourceActualPath === roots.sourcePath) {
      const folder = sourceFolder as any;
      if (!Array.isArray(folder?.children)) {
        throw fail("v2_apply_local_move_unresolved", "大小写目录改名源路径不是 Obsidian 文件夹；本机文件保持不变");
      }
      const currentFiles = (options.app.vault.getFiles?.() ?? []) as any[];
      const affectedFiles = currentFiles.filter((file) => normalizeVaultPath(file.path)?.startsWith(sourcePrefix));
      const composingFile = affectedFiles.find((file) => isPathComposing(file.path));
      if (composingFile) assertNotComposing(composingFile.path);
      const openFile = affectedFiles.find((file) => isVaultPathOpenInMarkdownEditor(options.app, file.path));
      if (openFile) {
        throw Object.assign(fail("v2_apply_active_editor_busy", "改名目录中有笔记仍在编辑器打开，远端改名已暂缓"), { path: openFile.path });
      }
      assertVaultPathGeneration(current.sourcePath, expectedSourceGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertVaultPathGeneration(current.targetPath, expectedTargetGeneration, options.getPathGeneration, "v2_apply_local_changed");
      await renameTrackedFileAndUpdateLinks(folder, roots.targetPath);
      assertVaultPathGeneration(current.sourcePath, expectedSourceGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertVaultPathGeneration(current.targetPath, expectedTargetGeneration, options.getPathGeneration, "v2_apply_local_changed");
    } else if (!existingMarker && !await caseDirectoryRenameAlreadyApplied(roots, current.fileId)) {
      throw fail("v2_apply_local_move_unresolved", "目录大小写改名无法确认上次移动结果；本机文件保持待处理");
    }

    const indexedTarget = fileAt(roots.targetPath);
    if (!indexedTarget || normalizeVaultPath(indexedTarget.path) !== roots.targetPath
      || !Array.isArray((indexedTarget as any).children)) {
      throw fail("v2_apply_local_move_unresolved", "Obsidian 文件索引没有精确显示改名后的目录；恢复记录已保留");
    }
    const remainsAtSource = ((options.app.vault.getFiles?.() ?? []) as any[])
      .some((file) => normalizeVaultPath(file.path)?.startsWith(sourcePrefix));
    if (remainsAtSource) throw fail("v2_apply_local_move_unresolved", "目录改名后仍有文件留在源路径；恢复记录已保留");
    caseDirectoryMarkersByTrigger.set(caseDirectoryMarkerKey(marker.marker.triggerFileId, marker.marker.triggerCursor), marker);
    return true;
  }

  function remoteRenameApplyMarkerPath(fileId: string, cursor: string): string {
    if (!/^\d{1,19}$/.test(cursor)) throw fail("v2_rename_marker_cursor_invalid", "改名恢复游标无效");
    return `.wetongbu/sync-v2/remote-rename-e${options.identity.protocolEpoch}-${options.identity.targetId.toLowerCase()}-${options.identity.deviceId.toLowerCase()}-${fileId.toLowerCase()}-${cursor}.json`;
  }

  async function saveRemoteRenameApplyMarker(marker: RemoteRenameApplyMarker): Promise<RemoteRenameApplyMarker> {
    const markerPath = remoteRenameApplyMarkerPath(marker.fileId, marker.cursor);
    let saved = marker;
    if (await adapter.exists(markerPath)) {
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(markerPath)); } catch {
        throw fail("v2_apply_local_move_unresolved", "改名恢复记录损坏；本机文件已保留");
      }
      const keys = ["version", "identity", "fileId", "fileVersionId", "previousVersionId", "cursor",
        "sourcePath", "targetPath", "sourceHash", "outputHash", "outputByteSize", "digest"];
      if (!hasExactKeys(parsed, keys) || parsed.version !== 1 || !isRecord(parsed.identity)
        || typeof parsed.fileId !== "string" || !UUID_PATTERN.test(parsed.fileId)
        || typeof parsed.fileVersionId !== "string" || !UUID_PATTERN.test(parsed.fileVersionId)
        || typeof parsed.previousVersionId !== "string" || !UUID_PATTERN.test(parsed.previousVersionId)
        || typeof parsed.cursor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(parsed.cursor)
        || typeof parsed.sourcePath !== "string" || typeof parsed.targetPath !== "string"
        || typeof parsed.sourceHash !== "string" || !SHA256_PATTERN.test(parsed.sourceHash)
        || !(parsed.outputHash === null || (typeof parsed.outputHash === "string" && SHA256_PATTERN.test(parsed.outputHash)))
        || !(parsed.outputByteSize === null || (Number.isSafeInteger(parsed.outputByteSize) && Number(parsed.outputByteSize) >= 0))
        || typeof parsed.digest !== "string" || !SHA256_PATTERN.test(parsed.digest)) {
        throw fail("v2_apply_local_move_unresolved", "改名恢复记录字段无效；本机文件已保留");
      }
      const { digest, ...body } = parsed;
      if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) {
        throw fail("v2_apply_local_move_unresolved", "改名恢复记录摘要无效；本机文件已保留");
      }
      const old = body as unknown as RemoteRenameApplyMarker;
      const oldImmutable = { ...old, outputHash: null, outputByteSize: null };
      const newImmutable = { ...marker, outputHash: null, outputByteSize: null };
      if (stableJson(oldImmutable) !== stableJson(newImmutable)
        || (old.outputHash !== null && marker.outputHash !== null && old.outputHash !== marker.outputHash)
        || (old.outputHash === null) !== (old.outputByteSize === null)) {
        throw fail("v2_apply_local_move_unresolved", "改名恢复记录与当前操作不一致；本机文件已保留");
      }
      if (old.outputHash !== null && marker.outputHash === null) return old;
      saved = old.outputHash !== null ? old : marker;
      if (stableJson(old) === stableJson(saved)) return old;
    }

    const digest = await sha256Hex(new TextEncoder().encode(stableJson(saved)));
    const serialized = stableJson({ ...saved, digest }) + "\n";
    await ensureParent(markerPath);
    await adapter.write(markerPath, serialized);
    if (await adapter.read(markerPath) !== serialized) {
      throw fail("v2_apply_local_move_unresolved", "改名恢复记录未能回读确认；本机文件保持不变");
    }
    return saved;
  }

  async function loadRemoteRenameApplyMarker(item: ApplyItem, prior: VaultSyncV2BaselineEntry, path: string): Promise<RemoteRenameApplyMarker | null> {
    const exactRenameEvent = item.eventType === "rename" && item.previousPath === prior.path
      && item.previousVersionId === prior.fileVersionId;
    const snapshotMove = item.eventType === undefined && item.previousPath === null && item.previousVersionId === null;
    if ((!exactRenameEvent && !snapshotMove)
      || prior.isDeleted || !prior.plaintextHash || portableEqual(prior.path, path)) return null;
    const markerPath = remoteRenameApplyMarkerPath(item.fileId, item.cursor);
    if (!(await adapter.exists(markerPath))) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(await adapter.read(markerPath)); } catch {
      throw fail("v2_apply_local_move_unresolved", "改名恢复记录损坏；本机文件已保留");
    }
    const keys = ["version", "identity", "fileId", "fileVersionId", "previousVersionId", "cursor",
      "sourcePath", "targetPath", "sourceHash", "outputHash", "outputByteSize", "digest"];
    if (!hasExactKeys(parsed, keys) || parsed.version !== 1 || !isRecord(parsed.identity)
      || typeof parsed.fileId !== "string" || !UUID_PATTERN.test(parsed.fileId)
      || typeof parsed.fileVersionId !== "string" || !UUID_PATTERN.test(parsed.fileVersionId)
      || typeof parsed.previousVersionId !== "string" || !UUID_PATTERN.test(parsed.previousVersionId)
      || typeof parsed.cursor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(parsed.cursor)
      || typeof parsed.sourcePath !== "string" || typeof parsed.targetPath !== "string"
      || typeof parsed.sourceHash !== "string" || !SHA256_PATTERN.test(parsed.sourceHash)
      || !(parsed.outputHash === null || (typeof parsed.outputHash === "string" && SHA256_PATTERN.test(parsed.outputHash)))
      || !(parsed.outputByteSize === null || (Number.isSafeInteger(parsed.outputByteSize) && Number(parsed.outputByteSize) >= 0))
      || typeof parsed.digest !== "string") {
      throw fail("v2_apply_local_move_unresolved", "改名恢复记录字段无效；本机文件已保留");
    }
    const { digest, ...body } = parsed;
    if (!SHA256_PATTERN.test(digest) || await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) {
      throw fail("v2_apply_local_move_unresolved", "改名恢复记录摘要无效；本机文件已保留");
    }
    const marker = body as unknown as RemoteRenameApplyMarker;
    if (stableJson(marker.identity) !== stableJson(options.identity)
      || marker.fileId !== item.fileId || marker.fileVersionId !== item.fileVersionId
      || marker.previousVersionId !== prior.fileVersionId || marker.cursor !== item.cursor
      || marker.sourcePath !== prior.path || marker.targetPath !== path
      || marker.sourceHash !== prior.plaintextHash
      || (marker.outputHash === null) !== (marker.outputByteSize === null)
      || (marker.outputHash !== null && (!SHA256_PATTERN.test(marker.outputHash)
        || !Number.isSafeInteger(marker.outputByteSize) || marker.outputByteSize! < 0))) {
      throw fail("v2_apply_local_move_unresolved", "改名恢复记录与当前文件基线不一致；本机文件已保留");
    }
    return marker;
  }

  async function updateRemoteRenameApplyMarkerOutput(marker: RemoteRenameApplyMarker, bytes: Uint8Array): Promise<RemoteRenameApplyMarker> {
    return saveRemoteRenameApplyMarker({ ...marker, outputHash: await sha256Hex(bytes), outputByteSize: bytes.byteLength });
  }

  async function clearRemoteRenameApplyMarker(fileId: string, cursor: string): Promise<void> {
    const path = remoteRenameApplyMarkerPath(fileId, cursor);
    if (await adapter.exists(path)) await adapter.remove(path).catch(() => {});
  }

  async function persistBaseline(entries: VaultSyncV2BaselineEntry[]): Promise<void> {
    await options.baseline.setMany(entries);
    for (const entry of entries) {
      await clearCaseRenameMarker(entry.fileId, entry.cursor);
      await clearRemoteRenameApplyMarker(entry.fileId, entry.cursor);
      await clearStagedApplyMarker(entry.fileId, entry.cursor);
    }
    await clearCompletedCaseDirectoryRenameMarkers();
  }

  async function preserveBootstrapCollision(
    path: string,
    cursor: string,
    remoteBytes: Uint8Array,
    expectedGeneration?: number,
  ): Promise<void> {
    const copyPath = uniqueVaultConflictCopyPath(path, cursor, (candidate) => !!fileAt(candidate), options.identity.deviceId);
    assertNotEditing(path);
    await withVaultPathWriteLocks([path, copyPath], async () => {
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      if (fileAt(copyPath)) throw fail("v2_apply_local_conflict", "首次加入的冲突副本路径已被占用；本机文件保持不变");
      const sourceFile = fileAt(path);
      if (!sourceFile || "children" in sourceFile) throw fail("v2_apply_local_changed", "首次加入期间本机文件已变化；本机文件保持不变");
      const sourceBytes = await localBytes(path);
      if (!sourceBytes) throw fail("v2_apply_local_changed", "首次加入期间本机文件已变化；本机文件保持不变");
      const sourceHash = await sha256Hex(sourceBytes);
      await ensureParent(copyPath);
      await assertSnapshotApplyLease();
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      if (fileAt(copyPath)) {
        throw fail("v2_apply_local_changed", "首次加入期间本机路径已变化；本机文件保持不变");
      }
      const latestSourceFile = fileAt(path);
      const latestSourceBytes = latestSourceFile && !("children" in latestSourceFile) ? await localBytes(path) : null;
      if (!latestSourceFile || "children" in latestSourceFile || !latestSourceBytes
        || latestSourceBytes.byteLength !== sourceBytes.byteLength || await sha256Hex(latestSourceBytes) !== sourceHash) {
        throw fail("v2_apply_local_changed", "首次加入期间本机路径已变化；本机文件保持不变");
      }
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      if (fileAt(copyPath)) throw fail("v2_apply_local_conflict", "首次加入的冲突副本路径已被占用；本机文件保持不变");
      await app.vault.rename(latestSourceFile, copyPath);
      const preserved = fileAt(copyPath);
      if (!preserved || fileAt(path)) {
        throw fail("v2_apply_write_unverified", "首次加入的本机冲突副本未能确认；云端内容尚未写入");
      }
      await ensureParent(path);
      try {
        await assertSnapshotApplyLease();
        const exactBuffer = remoteBytes.buffer.slice(remoteBytes.byteOffset, remoteBytes.byteOffset + remoteBytes.byteLength) as ArrayBuffer;
        await app.vault.createBinary(path, exactBuffer);
      } catch (error) {
        if (isSnapshotApplyLeaseFailure(error)) throw error;
        throw fail("v2_apply_path_collision", "本机冲突副本已保留，但远端原路径被占用；同步稍后重试");
      }
      const applied = await localBytes(path);
      if (!applied || await sha256Hex(applied) !== await sha256Hex(remoteBytes)) {
        throw fail("v2_apply_write_unverified", "远端笔记落盘回读校验失败；本机冲突副本仍已保留");
      }
    });
    options.onBootstrapCollisionPreserved?.(path, copyPath);
  }

  async function createExclusive(path: string, bytes: Uint8Array, expectedGeneration?: number): Promise<void> {
    await ensureParent(path);
    try {
      await assertSnapshotApplyLease();
      await writeBinaryAssetSafely(options.app, path, bytes, () => {
        assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      });
    } catch (error) {
      if (isSnapshotApplyLeaseFailure(error)) throw error;
      if ((error as any)?.code === "v2_apply_local_changed") throw error;
      const racedHash = await localHash(path).catch(() => null);
      if (racedHash === await sha256Hex(bytes)) return;
      throw fail("v2_apply_path_collision", "远端文件目标已被本地内容占用，已保留现有文件");
    }
    if (await localHash(path) !== await sha256Hex(bytes)) {
      throw fail("v2_apply_write_unverified", "远端文件落盘回读校验失败");
    }
  }

  async function replaceIfUnchanged(
    path: string,
    bytes: Uint8Array,
    expectedHash: string,
    expectedGeneration?: number,
    beforeWrite?: (bytes: Uint8Array) => Promise<void>,
  ): Promise<void> {
    if (path.toLowerCase().endsWith(".md")) {
      const current = await localBytes(path);
      if (!current || await sha256Hex(current) !== expectedHash) {
        throw fail("v2_apply_local_changed", "远端准备期间本地文件已变化，已保留本地内容");
      }
      const currentText = decodeExactUtf8(current);
      const outputText = decodeExactUtf8(bytes);
      if (currentText === null || outputText === null) {
        throw fail("v2_apply_text_encoding_unsupported", "Markdown 编码无法安全验证，已保留本机文件并暂缓应用");
      }
      try {
        await writeTextAtomically(options.app, path, outputText, currentText, {
          expectedGeneration,
          getPathGeneration: options.getPathGeneration,
          beforeReplace: async () => {
            await beforeWrite?.(bytes);
            await assertSnapshotApplyLease();
          },
        });
      } catch (error) {
        const code = (error as any)?.code;
        if (code === "vault_write_active_editor_busy") {
          throw Object.assign(fail("v2_apply_active_editor_busy", "该文件仍在 Markdown 编辑器中打开，远端写入已延后"), { path });
        }
        if (["vault_write_generation_changed", "vault_write_note_changed", "vault_write_note_missing"].includes(code)) {
          throw fail("v2_apply_local_changed", "远端准备期间本地文件已变化，已保留本地内容");
        }
        throw error;
      }
      return;
    }

    await withVaultPathWriteLock(path, async () => {
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      await beforeWrite?.(bytes);
      await assertSnapshotApplyLease();
      // Marker persistence and apply-lease renewal are asynchronous. Recheck
      // the target only after both have finished, immediately before starting
      // the replacement, so a note opened or edited during preparation stays
      // local and the inbox item remains retryable.
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      const current = await localBytes(path);
      if (!current || await sha256Hex(current) !== expectedHash) {
        throw fail("v2_apply_local_changed", "远端准备期间本地文件已变化，已保留本地内容");
      }
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      await adapter.writeBinary(path, exactBuffer(bytes));
      if (await localHash(path) !== await sha256Hex(bytes)) {
        throw fail("v2_apply_write_unverified", "远端文件落盘回读校验失败");
      }
    });
  }

  async function mergeIfUnchanged(
    path: string,
    bytes: Uint8Array,
    currentHash: string,
    baseHash: string,
    expectedGeneration?: number,
    beforeWrite?: (bytes: Uint8Array) => Promise<void>,
  ): Promise<boolean> {
    if (options.autoMergeEnabled === false) return false;
    if (!options.baseContent || !path.toLowerCase().endsWith(".md")) return false;
    const [baseBytes, local] = await Promise.all([options.baseContent.get(baseHash), localBytes(path)]);
    if (!baseBytes || !local || await sha256Hex(local) !== currentHash || await sha256Hex(baseBytes) !== baseHash) return false;
    const result = await mergeMarkdown3Way(baseBytes, local, bytes);
    if (result.status !== "merged") return false;
    await withVaultPathWriteLock(path, async () => {
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      await beforeWrite?.(result.bytes);
      await assertSnapshotApplyLease();
      // The merge marker and apply-lease operations can yield to editor input.
      // Validate the source again after those awaits, then start the write
      // without another asynchronous preparation step.
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      const current = await localBytes(path);
      if (!current || await sha256Hex(current) !== currentHash) {
        throw fail("v2_merge_local_changed", "自动合并期间本地笔记再次变化，已保留当前内容");
      }
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertNotEditing(path);
      await adapter.writeBinary(path, exactBuffer(result.bytes));
      if (await localHash(path) !== result.plaintextHash) {
        throw fail("v2_merge_write_unverified", "自动合并内容落盘校验失败");
      }
    });
    return true;
  }

  async function maybeMoveTrackedFile(
    path: string,
    previous: VaultSyncV2BaselineEntry,
    cursor: string,
    expectedGeneration?: number,
    expectedPreviousGeneration?: number,
    remoteChange?: ApplyItem,
  ): Promise<boolean> {
    if (previous.isDeleted || previous.path === path) return false;
    const expectedHash = previous.plaintextHash;
    if (!expectedHash) throw fail("v2_apply_local_move_unresolved", "本机基线缺少已验证正文摘要；远端改名已暂停");
    const caseOnly = portableEqual(previous.path, path);
    if (caseOnly) {
      const directoryRoots = caseOnlyDirectoryRoots(previous.path, path);
      const previousParent = previous.path.includes("/") ? previous.path.slice(0, previous.path.lastIndexOf("/")) : "";
      const nextParent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (previousParent !== nextParent && portableEqual(previousParent, nextParent) && !directoryRoots) {
        throw fail("v2_apply_local_move_unresolved", "多个目录层级同时改变大小写；本机文件保持原路径并等待安全处理");
      }
      const markerPaths = caseRenamePaths(previous.fileId, cursor);
      const markerExists = await adapter.exists(markerPaths.markerPath);
      const directoryMarker = directoryRoots ? await loadCaseDirectoryRenameMarker(directoryRoots) : null;
      const directoryAlreadyApplied = directoryRoots && (directoryMarker
        || await caseDirectoryRenameAlreadyApplied(directoryRoots, previous.fileId));
      return withVaultPathWriteLocks([previous.path, path,
        ...(directoryRoots ? [directoryRoots.sourcePath, directoryRoots.targetPath] : [])], async () => {
        assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertVaultPathGeneration(previous.path, expectedPreviousGeneration, options.getPathGeneration, "v2_apply_local_changed");

        const source = fileAt(previous.path);
        const sourceActualPath = source ? normalizeVaultPath(source.path) : null;
        const stage = fileAt(markerPaths.stagePath);
        const target = fileAt(path);
        const targetActualPath = target ? normalizeVaultPath(target.path) : null;
        if (!markerExists && (stage || (target && targetActualPath === path && sourceActualPath === path && !directoryAlreadyApplied))) {
          throw fail("v2_apply_rename_collision", "大小写改名恢复记录不存在；目标文件身份无法确认，本机文件已保留");
        }
        if (!markerExists) {
          const alreadyMovedWithDirectory = !!directoryRoots && !!directoryAlreadyApplied
            && targetActualPath === path && (!source || sourceActualPath === path);
          if (!source || (sourceActualPath !== previous.path && !alreadyMovedWithDirectory)) {
            if (!alreadyMovedWithDirectory) {
              throw fail("v2_apply_local_move_unresolved", "上次同步的本地文件已不存在，无法安全完成大小写改名");
            }
          }
          const original = await localBytes(alreadyMovedWithDirectory ? path : previous.path);
          if (!original || await sha256Hex(original) !== previous.plaintextHash) {
            throw fail("v2_apply_local_move_unresolved", "本地文件在远端改名前已编辑，需先处理冲突");
          }
          await ensureCaseRenameMarker({
            fileId: previous.fileId, cursor, sourcePath: previous.path, targetPath: path,
            plaintextHash: expectedHash,
          });
        } else {
          await ensureCaseRenameMarker({
            fileId: previous.fileId, cursor, sourcePath: previous.path, targetPath: path,
            plaintextHash: expectedHash,
          });
        }
        if (directoryRoots) {
          await moveCaseOnlyDirectory(directoryRoots, { fileId: previous.fileId, cursor,
            sourcePath: previous.path, targetPath: path }, expectedGeneration, expectedPreviousGeneration);
        } else if (stage && sourceActualPath === previous.path) {
          throw fail("v2_apply_local_move_unresolved", "大小写改名恢复时源文件和暂存文件同时存在；两份内容均保留");
        } else if (stage) {
          const stagedBytes = await localBytes(markerPaths.stagePath);
          if (!stagedBytes || await sha256Hex(stagedBytes) !== previous.plaintextHash) {
            throw fail("v2_apply_local_move_unresolved", "大小写改名暂存文件校验失败；文件已保留");
          }
          if (target && targetActualPath === path) {
            throw fail("v2_apply_rename_collision", "大小写改名目标已被其他文件占用；暂存文件已保留");
          }
          await ensureParent(path);
          await renameTrackedFileAndUpdateLinks(stage, path);
        } else if (target && targetActualPath === path && sourceActualPath === path) {
          const targetBytes = await localBytes(path);
          if (!markerExists || !targetBytes || await sha256Hex(targetBytes) !== previous.plaintextHash) {
            throw fail("v2_apply_rename_collision", "大小写改名目标已被其他文件占用；本机文件已保留");
          }
          if (expectedGeneration !== undefined) {
            assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
          }
          if (expectedPreviousGeneration !== undefined) {
            assertVaultPathGeneration(previous.path, expectedPreviousGeneration, options.getPathGeneration, "v2_apply_local_changed");
          }
          return true;
        } else {
          if (!source || sourceActualPath !== previous.path) {
            throw fail("v2_apply_local_move_unresolved", "上次同步的本地文件已不存在，无法安全完成大小写改名");
          }
          const original = await localBytes(previous.path);
          if (!original || await sha256Hex(original) !== previous.plaintextHash) {
            throw fail("v2_apply_local_move_unresolved", "本地文件在远端改名前已编辑，需先处理冲突");
          }
          if (target && targetActualPath !== previous.path) {
            throw fail("v2_apply_rename_collision", "大小写改名目标已被其他文件占用；本机文件已保留");
          }
          await ensureParent(markerPaths.stagePath);
          await renameTrackedFileAndUpdateLinks(source, markerPaths.stagePath);
          const staged = fileAt(markerPaths.stagePath);
          const stagedBytes = await localBytes(markerPaths.stagePath);
          if (!staged || !stagedBytes || await sha256Hex(stagedBytes) !== previous.plaintextHash || fileAt(previous.path)) {
            throw fail("v2_apply_local_move_unresolved", "本机文件已进入大小写改名暂存，但暂存状态未能确认；将保留待恢复");
          }
          await ensureParent(path);
          await renameTrackedFileAndUpdateLinks(staged, path);
        }

        const applied = fileAt(path);
        const appliedBytes = await localBytes(path);
        const exactPathIndexed = app.vault.getFiles?.().some((file: any) => normalizeVaultPath(file.path) === path)
          ?? (applied ? normalizeVaultPath(applied.path) === path : false);
        if (!applied || normalizeVaultPath(applied.path) !== path || !appliedBytes
          || await sha256Hex(appliedBytes) !== previous.plaintextHash || !exactPathIndexed) {
          throw fail("v2_apply_local_move_unresolved", "大小写改名未在 Vault 文件索引中精确落到目标路径；恢复记录已保留");
        }
        const generationDelta = directoryRoots ? 0 : stage ? 1 : 2;
        if (expectedGeneration !== undefined) {
          assertVaultPathGeneration(path, expectedGeneration + generationDelta, options.getPathGeneration, "v2_apply_local_changed");
        }
        if (expectedPreviousGeneration !== undefined) {
          assertVaultPathGeneration(previous.path, expectedPreviousGeneration + generationDelta, options.getPathGeneration, "v2_apply_local_changed");
        }
        return true;
      });
    }
    const oldBytes = await localBytes(previous.path);
    if (!oldBytes) throw fail("v2_apply_local_move_unresolved", "上次同步的本地文件已不存在，无法安全应用远端改名");
    if (await sha256Hex(oldBytes) !== previous.plaintextHash) {
      throw fail("v2_apply_local_move_unresolved", "本地文件在远端改名前已编辑，需先处理冲突");
    }
    if (fileAt(path)) throw fail("v2_apply_rename_collision", "远端改名目标已被本地文件占用，需先处理冲突");
    assertNotEditing(previous.path);
    await withVaultPathWriteLocks([previous.path, path], async () => {
      assertVaultPathGeneration(path, expectedGeneration, options.getPathGeneration, "v2_apply_local_changed");
      assertVaultPathGeneration(previous.path, expectedPreviousGeneration, options.getPathGeneration, "v2_apply_local_changed");
      const again = await localBytes(previous.path);
      if (!again || await sha256Hex(again) !== previous.plaintextHash || fileAt(path)) {
        throw fail("v2_apply_local_move_unresolved", "远端改名期间本地文件状态变化，已暂停");
      }
      // The source read above yields to the host; an editor may have opened
      // after the preflight check. Reject before creating any rename recovery
      // state when an active buffer already owns the source path.
      assertNotEditing(previous.path);
      const renameLineage = !!remoteChange && (remoteChange.eventType === "rename"
        ? remoteChange.previousPath === previous.path && remoteChange.previousVersionId === previous.fileVersionId
        : remoteChange.eventType === undefined && remoteChange.previousPath === null && remoteChange.previousVersionId === null);
      if (remoteChange && renameLineage) {
        await saveRemoteRenameApplyMarker({
          version: 1, identity: options.identity, fileId: remoteChange.fileId,
          fileVersionId: remoteChange.fileVersionId, previousVersionId: previous.fileVersionId,
          cursor: remoteChange.cursor, sourcePath: previous.path, targetPath: path,
          sourceHash: previous.plaintextHash, outputHash: null, outputByteSize: null,
        });
      }
      await ensureParent(path);
      // Marker persistence and destination checks also yield to the host.
      // Recheck at the mutation boundary so an editor opened during either
      // step keeps ownership of its current path.
      assertNotEditing(previous.path);
      await renameTrackedFileAndUpdateLinks(fileAt(previous.path), path);
      const renameGenerationDelta = portableEqual(previous.path, path) ? 2 : 1;
      if (expectedGeneration !== undefined) {
        assertVaultPathGeneration(path, expectedGeneration + renameGenerationDelta, options.getPathGeneration, "v2_apply_local_changed");
      }
      if (expectedPreviousGeneration !== undefined) {
        assertVaultPathGeneration(previous.path, expectedPreviousGeneration + renameGenerationDelta, options.getPathGeneration, "v2_apply_local_changed");
      }
    });
    return true;
  }

  async function normalizeItem(item: VaultSyncV2SnapshotItem | VaultSyncV2ChangeItem): Promise<ApplyItem> {
    const cursor = "changeCursor" in item ? item.changeCursor : item.cursor;
    return { ...item, cursor,
      previousPath: "previousPath" in item ? item.previousPath : null,
      previousVersionId: "previousVersionId" in item ? item.previousVersionId : null,
      mtimeMs: item.mtimeMs,
      eventType: "eventType" in item ? item.eventType : undefined };
  }

  async function applyOne(
    raw: VaultSyncV2SnapshotItem | VaultSyncV2ChangeItem,
    resolution?: { expectedLocalHash: string; downloadedBytes: Uint8Array },
  ): Promise<VaultSyncV2BaselineEntry> {
    await assertSnapshotApplyLease();
    const item = await normalizeItem(raw);
    const path = normalizeVaultPath(item.path);
    if (!path || path !== item.path || !inScope(path)) throw fail("v2_apply_path_invalid", "远端路径不符合当前 Vault 同步范围");
    let targetGeneration = options.getPathGeneration?.(path);
    const cacheableMarkdown = path.toLowerCase().endsWith(".md");
    const existingAtTarget = fileAt(path);
    const prior = await options.baseline.get(item.fileId);
    const trackedCaseAlias = !!existingAtTarget && !!prior && !prior.isDeleted
      && prior.path !== path && portableEqual(prior.path, path)
      && normalizeVaultPath(existingAtTarget.path) === prior.path;
    if (existingAtTarget && normalizeVaultPath(existingAtTarget.path) !== path && !trackedCaseAlias) {
      throw fail("v2_apply_path_collision", "本地存在大小写或 Unicode 规范化后相同的路径，远端写入已暂停");
    }
    const priorGeneration = prior && !prior.isDeleted ? options.getPathGeneration?.(prior.path) : undefined;
    const pathMove = prior && !prior.isDeleted
      ? (await options.pathIntents?.load() ?? []).find((entry) => entry.fileId === item.fileId
        || (!entry.fileId && entry.fromPath === prior.path)) ?? null
      : null;
    if (pathMove?.state === "conflict") {
      throw fail("v2_apply_local_rename_conflict", "本机改名待处理；远端内容保持待处理");
    }
    if (pathMove && !pathMove.fileId) await options.pathIntents?.bindFile(pathMove.intentId, item.fileId);
    if (pathMove && item.eventType === "rename" && pathMove.toPath !== path) {
      throw fail("v2_apply_local_rename_conflict", "本机与云端同时改名到不同路径；两端文件均已保留待处理");
    }
    const recoveredStage = await resumeStagedApply(item, path, prior, pathMove, targetGeneration);
    if (recoveredStage) return recoveredStage;

    async function cacheMarkdownBase(hash: string, content?: Uint8Array): Promise<void> {
      if (!options.baseContent || !cacheableMarkdown || !content || content.byteLength > 2 * 1024 * 1024) return;
      // Cache pressure or local-storage failure only disables automatic merge;
      // it must not stop a safe synchronization operation.
      await options.baseContent.put(hash, content).catch(() => ({ stored: false as const }));
    }

    if (item.isDeleted) {
      if ("changeCursor" in raw && options.trashLocalFile) {
        return applySnapshotDeleteToTrash(item);
      }
      const candidatePath = pathMove?.toPath ?? prior?.path ?? path;
      const currentHash = await localHash(candidatePath);
      if (currentHash !== null) {
        if (prior && currentHash !== prior.plaintextHash) throw fail("v2_delete_requires_resolution", "云端删除已由发起设备确认；接收端本机修改需要先保留副本");
        throw fail("v2_delete_requires_review", "远端删除需要在删除审核中确认；本地文件已保留");
      }
      return { fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor, path,
        plaintextHash: null, byteSize: 0, isDeleted: true };
    }

    if (!item.content) throw fail("v2_apply_content_missing", "远端活动版本缺少内容引用");
    const staged = resolution ? null : await options.downloadToStage?.(item) ?? null;
    let bytes: Uint8Array | null = resolution?.downloadedBytes ?? null;
    const loadBytes = async (): Promise<Uint8Array> => {
      if (!bytes) {
        if (staged) {
          const stageFile = fileAt(staged.path);
          const declaredSize = Number(stageFile?.stat?.size);
          if (!stageFile || "children" in stageFile || staged.byteSize > MAX_CONFLICT_RESOLUTION_BYTES
            || (Number.isSafeInteger(declaredSize) && declaredSize !== staged.byteSize)) {
            throw fail("v2_apply_integrity_mismatch", "分块明文暂存尺寸无效；同步恢复记录保持待处理");
          }
          bytes = new Uint8Array(await adapter.readBinary(staged.path));
          if (bytes.byteLength !== staged.byteSize || bytes.byteLength > MAX_CONFLICT_RESOLUTION_BYTES
            || await sha256Hex(bytes) !== staged.plaintextHash) {
            throw fail("integrity_mismatch", "分块明文暂存回读摘要或尺寸校验失败");
          }
        } else {
          bytes = await options.download(item);
        }
      }
      if (!downloadedPlaintextMatchesItem(item, bytes, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)) {
        throw fail("v2_apply_integrity_mismatch", "远端明文尺寸与文件版本或安全上限不一致");
      }
      return bytes;
    };
    try {
      if (staged && (item.content.kind !== "object" || !isVaultSyncPlaintextSizeCompatible({
        itemByteSize: item.byteSize, content: item.content, plaintextByteSize: staged.byteSize,
        allowEncryptedSize: options.allowEncryptedSize,
      })
        || staged.objectId !== item.content.objectId
        || staged.ciphertextHash.toLowerCase() !== item.content.ciphertextHash.toLowerCase()
        || !SHA256_PATTERN.test(staged.plaintextHash))) {
        throw fail("v2_apply_integrity_mismatch", "分块明文暂存与远端对象身份不一致");
      }
      const remoteHash = staged?.plaintextHash ?? await sha256Hex(await loadBytes());
    let remoteRenameMarker = prior ? await loadRemoteRenameApplyMarker(item, prior, path) : null;
    let currentPath = pathMove?.toPath ?? path;
    let currentHash = await localHash(currentPath);
    let movedFromPrior = !!pathMove;
    if (pathMove && options.getPathGeneration) targetGeneration = options.getPathGeneration(currentPath);

    if (remoteRenameMarker && !pathMove) {
      const sourceExists = !!fileAt(remoteRenameMarker.sourcePath);
      const targetExists = !!fileAt(remoteRenameMarker.targetPath);
      if (!sourceExists && targetExists) {
        if (!currentHash) throw fail("v2_apply_local_move_unresolved", "改名恢复目标不是可读取文件；本机内容已保留");
        if (currentHash === remoteRenameMarker.outputHash) {
          const output = await localBytes(remoteRenameMarker.targetPath);
          if (!output || output.byteLength !== remoteRenameMarker.outputByteSize) {
            throw fail("v2_apply_local_move_unresolved", "改名恢复目标尺寸与记录不符；本机内容已保留");
          }
          const remoteBytes = await loadBytes();
          await cacheMarkdownBase(remoteHash, remoteBytes);
          return { fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor, path,
            plaintextHash: remoteHash, byteSize: remoteBytes.byteLength, isDeleted: false };
        }
        if (currentHash !== remoteRenameMarker.sourceHash) {
          throw fail("v2_apply_local_move_unresolved", "改名中断后目标内容再次变化；本机内容已保留待确认");
        }
        movedFromPrior = true;
      } else if (sourceExists && !targetExists) {
        // The marker is written before the destination rename; resume it below.
      } else {
        throw fail("v2_apply_local_move_unresolved", "改名恢复记录对应的源/目标状态不明确；本机内容已保留");
      }
    }

    const beforeRenameContentWrite = async (output: Uint8Array) => {
      if (remoteRenameMarker) remoteRenameMarker = await updateRemoteRenameApplyMarkerOutput(remoteRenameMarker, output);
    };

    if (!pathMove && prior && !prior.isDeleted && prior.path !== path && portableEqual(prior.path, path)) {
      const moved = await maybeMoveTrackedFile(path, prior, item.cursor, targetGeneration, priorGeneration, item);
      if (moved) {
        movedFromPrior = true;
        currentHash = await localHash(path);
        if (options.getPathGeneration) targetGeneration = options.getPathGeneration(path);
      }
    }

    if (currentHash === null && pathMove) {
      throw fail("v2_apply_local_move_unresolved", "本机改名目标已不存在；远端内容保持待处理");
    }
    if (currentHash === null && prior && !prior.isDeleted) {
      if (prior.path === path) throw fail("v2_apply_local_delete_unresolved", "本地文件在同步期间被删除，远端版本已保留待处理");
      const moved = await maybeMoveTrackedFile(path, prior, item.cursor, targetGeneration, priorGeneration, item);
      if (moved && options.getPathGeneration) targetGeneration = options.getPathGeneration(path);
      movedFromPrior = true;
      currentHash = await localHash(path);
      if (currentHash === null) throw fail("v2_apply_local_move_unresolved", "远端改名后未找到本地文件");
      if (moved && prior) {
        remoteRenameMarker = await loadRemoteRenameApplyMarker(item, prior, path);
      }
    }

    if (currentHash === null) {
      if (prior && !prior.isDeleted) throw fail("v2_apply_local_delete_unresolved", "本地删除与远端版本存在冲突");
      if (staged && !pathMove && (!prior || prior.isDeleted)) {
        const marker: StagedApplyMarker = {
          version: 1, identity: options.identity, fileId: item.fileId, fileVersionId: item.fileVersionId,
          cursor: item.cursor, path, objectId: staged.objectId, ciphertextHash: staged.ciphertextHash.toLowerCase(),
          plaintextHash: staged.plaintextHash.toLowerCase(), byteSize: staged.byteSize, stagePath: staged.path,
        };
        if (!stagedMarkerMatchesItem(marker, item, path)) {
          throw fail("v2_apply_integrity_mismatch", "分块明文暂存路径与当前同步身份不一致");
        }
        await persistStagedApplyMarker(marker);
        await promoteStagedApplyMarker(marker, targetGeneration);
      } else {
        await createExclusive(path, await loadBytes(), targetGeneration);
      }
    } else if (currentHash !== remoteHash) {
      if (resolution) {
        if (currentHash !== resolution.expectedLocalHash || !prior || prior.isDeleted
          || prior.path !== currentPath || prior.path !== path) {
          throw fail("v2_apply_local_changed", "冲突处理期间本地文件发生变化；已保留当前文件和副本");
        }
          await replaceIfUnchanged(currentPath, await loadBytes(), resolution.expectedLocalHash, targetGeneration,
            beforeRenameContentWrite);
      } else if (!prior || prior.isDeleted || (!movedFromPrior && prior.path !== currentPath)) {
        if (options.preserveUntrackedSnapshotCollisions && !prior && "changeCursor" in raw) {
          await preserveBootstrapCollision(path, item.cursor, await loadBytes(), targetGeneration);
        } else {
          throw fail("v2_apply_local_conflict", "本地文件与远端版本不同，且没有可验证的共同基线；双方内容均已保留");
        }
      } else if (currentHash === prior.plaintextHash) {
        const priorBytes = await localBytes(path);
        if (priorBytes && await sha256Hex(priorBytes) === prior.plaintextHash) {
          await cacheMarkdownBase(prior.plaintextHash, priorBytes);
        }
          await replaceIfUnchanged(currentPath, await loadBytes(), prior.plaintextHash!, targetGeneration,
            beforeRenameContentWrite);
      } else {
        const merged = await mergeIfUnchanged(currentPath, await loadBytes(), currentHash, prior.plaintextHash ?? "", targetGeneration,
          beforeRenameContentWrite);
        if (!merged) throw fail("v2_apply_local_conflict", "本地和远端笔记存在重叠修改或缺少共同正文，双方内容均已保留");
      }
    } else if (!prior || prior.isDeleted) {
      if (!(options.preserveUntrackedSnapshotCollisions && !prior && "changeCursor" in raw)) {
        throw fail("v2_apply_local_conflict", "本机已有相同字节但没有可验证的共同文件身份；双方内容均已保留");
      }
    } else if (prior.path !== path && !movedFromPrior) {
      // Matching bytes at a new path do not prove that a local file has the
      // remote fileId. Keep path identity explicit and let rename conflicts
      // take the user-confirmed resolution path below.
      throw fail("v2_apply_rename_collision", "远端改名目标已被本地文件占用；相同内容不足以证明文件身份");
    }

    await cacheMarkdownBase(remoteHash, bytes ?? undefined);

    if (remoteRenameMarker && !remoteRenameMarker.outputHash) {
      const output = await localBytes(currentPath);
      if (!output) throw fail("v2_apply_local_move_unresolved", "改名恢复后目标文件消失；本机内容已保留待重试");
      remoteRenameMarker = await updateRemoteRenameApplyMarkerOutput(remoteRenameMarker, output);
    } else if (remoteRenameMarker?.outputHash) {
      const outputHash = await localHash(currentPath);
      if (outputHash !== remoteRenameMarker.outputHash) {
        throw fail("v2_apply_local_move_unresolved", "改名恢复输出摘要与本机文件不符；本机内容已保留待确认");
      }
    }

    const plaintextByteSize = staged?.byteSize ?? bytes?.byteLength;
    if (!Number.isSafeInteger(plaintextByteSize)) {
      throw fail("v2_apply_integrity_mismatch", "远端明文尺寸缺失，未推进本机基线");
    }
    return { fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor, path,
      plaintextHash: remoteHash, byteSize: plaintextByteSize as number, isDeleted: false };
    } finally {
      await staged?.clear().catch(() => {});
    }
  }

  async function applySnapshot(input: {
    items: AsyncGenerator<VaultSyncV2SnapshotItem>;
    assertApplyLease?: () => Promise<void>;
  }): Promise<void> {
    await clearCompletedCaseDirectoryRenameMarkers(true);
    const previousAssertion = snapshotApplyLeaseAssertion;
    snapshotApplyLeaseAssertion = input.assertApplyLease ?? previousAssertion;
    let pending: VaultSyncV2BaselineEntry[] = [];
    try {
      for await (const item of input.items) {
        if (!inScope(item.path)) continue;
        pending.push(await applyOne(item));
        if (pending.length >= batchSize) {
          await assertSnapshotApplyLease();
          await persistBaseline(pending);
          pending = [];
        }
      }
      if (pending.length) {
        await assertSnapshotApplyLease();
        await persistBaseline(pending);
      }
    } finally {
      snapshotApplyLeaseAssertion = previousAssertion;
    }
  }

  async function inboxEntryAlreadyRepresentedByBaseline(entry: VaultSyncInboxEntry): Promise<boolean> {
    const prior = await options.baseline.get(entry.item.fileId);
    if (!prior) return false;
    const eventCursor = BigInt(entry.cursor);
    const baselineCursor = BigInt(prior.cursor);
    if (baselineCursor > eventCursor) return true;
    if (baselineCursor !== eventCursor || entry.item.isDeleted
      || prior.fileVersionId !== entry.item.fileVersionId
      || prior.path !== entry.item.path || prior.isDeleted !== entry.item.isDeleted) return false;
    // A baseline may be durable while the staged-apply marker still records
    // unfinished crash recovery. Let applyOne resume and clean that marker
    // before acknowledging the inbox echo.
    return !(await adapter.exists(stagedApplyMarkerPath(entry.item.fileId, entry.item.cursor)));
  }

  async function advanceNetZeroRemoteUpdateChain(entry: VaultSyncInboxEntry): Promise<boolean> {
    const item = entry.item;
    const maxBytes = 2 * 1024 * 1024;
    const path = normalizeVaultPath(item.path);
    if (entry.state === "applied" || item.eventType !== "update" || item.isDeleted
      || item.content?.kind !== "object" || !path || path !== item.path || !path.toLowerCase().endsWith(".md")
      || !contentFitsPlaintextLimit(item, maxBytes, options.allowEncryptedSize)) return false;

    const initial = await options.journal?.load();
    const currentEntry = initial?.inbox.find((candidate) => candidate.cursor === entry.cursor);
    if (!initial || !currentEntry || currentEntry.state === "applied" || currentEntry.resolution
      || currentEntry.item.fileId !== item.fileId || currentEntry.item.fileVersionId !== item.fileVersionId) return false;
    const initialFileOperations = initial.operations.filter((operation) => operation.fileId === item.fileId);
    if (initialFileOperations.length > 1) return false;
    const conflictOperation = initialFileOperations[0];
    if (conflictOperation && (conflictOperation.state !== "conflict"
      || conflictOperation.request.operation.type !== "update")) return false;

    const chain = initial.inbox.filter((candidate) => candidate.item.fileId === item.fileId
      && BigInt(candidate.cursor) >= BigInt(entry.cursor))
      .sort((left, right) => BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0);
    if (!chain.length || chain[0].cursor !== entry.cursor) return false;

    const prior = await options.baseline.get(item.fileId);
    if (!prior || prior.isDeleted || prior.path !== path || !prior.plaintextHash
      || prior.fileVersionId !== item.previousVersionId) return false;
    if (conflictOperation && conflictOperation.request.expectedVersionId !== prior.fileVersionId) return false;
    if (isVaultPathOpenInMarkdownEditor(options.app, path) || !fileAt(path)) return false;
    const localBytesBefore = await localBytes(path);
    if (!localBytesBefore || localBytesBefore.byteLength > maxBytes) return false;
    const localHashBefore = await sha256Hex(localBytesBefore);
    if (localHashBefore === prior.plaintextHash) return false;
    if (conflictOperation && (conflictOperation.localByteSize !== localBytesBefore.byteLength
      || conflictOperation.localContentHash !== localHashBefore)) return false;
    const generationBefore = options.getPathGeneration?.(path);

    let expectedPreviousVersionId = prior.fileVersionId;
    for (const candidate of chain) {
      const change = candidate.item;
      if (candidate.state === "applied" || candidate.resolution || change.eventType !== "update"
        || change.isDeleted || change.path !== path || change.previousVersionId !== expectedPreviousVersionId
        || change.content?.kind !== "object" || !contentFitsPlaintextLimit(change, maxBytes, options.allowEncryptedSize)) {
        return false;
      }
      if (await adapter.exists(stagedApplyMarkerPath(change.fileId, change.cursor))) return false;
      expectedPreviousVersionId = change.fileVersionId;
    }

    const latest = chain[chain.length - 1];
    const latestBytes = await options.download(latest.item);
    if (!downloadedPlaintextMatchesItem(latest.item, latestBytes, maxBytes, options.allowEncryptedSize)) {
      throw fail("v2_apply_integrity_mismatch", "同路径远端更新链的最新 Markdown 正文校验失败；本机内容保持不变");
    }
    const latestHash = await sha256Hex(latestBytes);
    if (latestHash !== prior.plaintextHash || latestBytes.byteLength !== prior.byteSize) return false;

    return withVaultPathWriteLock(path, async () => {
      const current = await options.journal?.load();
      const currentChain = current?.inbox.filter((candidate) => candidate.item.fileId === item.fileId
        && BigInt(candidate.cursor) >= BigInt(entry.cursor))
        .sort((left, right) => BigInt(left.cursor) < BigInt(right.cursor) ? -1 : BigInt(left.cursor) > BigInt(right.cursor) ? 1 : 0);
      const currentFileOperations = current?.operations.filter((operation) => operation.fileId === item.fileId) ?? [];
      if (!current || !currentChain || currentChain.length !== chain.length
        || currentFileOperations.length !== initialFileOperations.length
        || currentFileOperations.some((operation, index) => stableJson(operation) !== stableJson(initialFileOperations[index]))
        || currentChain.some((candidate, index) => candidate.cursor !== chain[index].cursor
          || candidate.item.fileVersionId !== chain[index].item.fileVersionId
          || candidate.item.previousVersionId !== chain[index].item.previousVersionId
          || candidate.item.path !== chain[index].item.path || candidate.state === "applied" || !!candidate.resolution)) {
        return false;
      }
      for (const candidate of currentChain) {
        if (await adapter.exists(stagedApplyMarkerPath(candidate.item.fileId, candidate.cursor))) return false;
      }
      const latestPrior = await options.baseline.get(item.fileId);
      if (!latestPrior || latestPrior.isDeleted || latestPrior.fileVersionId !== prior.fileVersionId
        || latestPrior.cursor !== prior.cursor || latestPrior.path !== prior.path
        || latestPrior.plaintextHash !== prior.plaintextHash || latestPrior.byteSize !== prior.byteSize
        || isVaultPathOpenInMarkdownEditor(options.app, path) || !fileAt(path)) return false;
      if (generationBefore !== undefined && options.getPathGeneration?.(path) !== generationBefore) return false;
      const localBytesAfter = await localBytes(path);
      if (!localBytesAfter || localBytesAfter.byteLength !== localBytesBefore.byteLength
        || await sha256Hex(localBytesAfter) !== localHashBefore) return false;

      if (conflictOperation) {
        if (!options.rebaseNetZeroConflict) return false;
        return options.rebaseNetZeroConflict({
          operationId: conflictOperation.operationId,
          expectedVersionId: latest.item.fileVersionId,
        });
      }

      await persistBaseline([{
        fileId: item.fileId, fileVersionId: latest.item.fileVersionId, cursor: latest.cursor,
        path, plaintextHash: latestHash, byteSize: latestBytes.byteLength, isDeleted: false,
      }]);
      return true;
    });
  }

  async function applyReceivedInbox(): Promise<{ applied: number; blocked: number; deferredPaths?: string[] }> {
    if (!options.journal) throw new Error("v2 inbox journal is required");
    await clearCompletedCaseDirectoryRenameMarkers(true);
    const state = await options.journal.load();
    if (!state) throw fail("snapshot_required", "尚未安装远端基线");
    let applied = 0;
    let blocked = 0;
    const deferredPaths: string[] = [];
    const deferredFileIds = new Set<string>();
    for (const entry of state.inbox) {
      if (entry.state === "applied") continue;
      if (!inScope(entry.item.path)) {
        await options.journal.markInboxItem(entry.cursor, "applied");
        applied += 1;
        continue;
      }
      // A file can have several ordered remote updates in one inbox. Once its
      // open editor defers the first update, leave the rest of that file's
      // chain untouched while still applying unrelated files from this page.
      if (deferredFileIds.has(entry.item.fileId)) continue;
      // A local push can advance the per-file baseline before this device's
      // durable inbox catches up with that same change. Never replay an older
      // event over a newer version of the same fileId, or replay the exact
      // version already recorded at the same cursor. Create-then-rename events
      // are especially likely to echo on their source device, where the final
      // path may already be present.
      if (await inboxEntryAlreadyRepresentedByBaseline(entry)) {
        await options.journal.markInboxItem(entry.cursor, "applied");
        applied += 1;
        continue;
      }
      if (await advanceNetZeroRemoteUpdateChain(entry)) {
        await options.journal.markInboxItem(entry.cursor, "applied");
        applied += 1;
        continue;
      }
      const composingPath = [entry.item.path, entry.item.previousPath]
        .find((path): path is string => !!path && isPathComposing(path));
      if (composingPath) {
        blocked += 1;
        deferredPaths.push(normalizeVaultPath(composingPath) ?? composingPath);
        deferredFileIds.add(entry.item.fileId);
        continue;
      }
      // Older builds parked every received tombstone in `needs_resolution`
      // when the receiver's delete mode required review. Re-check unresolved
      // tombstones with no explicit user resolution under the new one-confirm
      // policy; the same local-baseline guards still decide whether it is safe.
      const retryCommittedDelete = entry.item.eventType === "delete" && entry.item.isDeleted && !entry.resolution;
      const retryPreservedDelete = entry.item.eventType === "delete" && entry.item.isDeleted
        && entry.resolution?.kind === "keep_local_on_delete";
      if (entry.state === "needs_resolution" && !retryCommittedDelete && !retryPreservedDelete) { blocked += 1; continue; }
      try {
        if (retryPreservedDelete) {
          await resolveInboxKeepingLocalOnDelete(entry);
          applied += 1;
          continue;
        }
        // A cloud tombstone is already authorized by the device that committed
        // it. Apply it on this device without asking for a second confirmation,
        // but only through the unchanged-baseline, path-intent, active-editor,
        // generation, and Obsidian-trash checks below.
        const baseline = entry.item.eventType === "delete" && entry.item.isDeleted && options.trashLocalFile
          ? await applyRemoteDeleteToTrash(entry)
          : await applyOne(entry.item);
        await persistBaseline([baseline]);
        if (entry.item.eventType === "rename" && entry.item.previousPath) {
          await pruneEmptySourceFoldersAfterMove(options.app.vault as any, entry.item.previousPath, entry.item.path)
            .catch(() => []);
        }
        await options.journal.markInboxItem(entry.cursor, "applied");
        applied += 1;
      } catch (error: any) {
        if (error?.code === "v2_apply_composition_busy") {
          blocked += 1;
          deferredPaths.push(normalizeVaultPath(error.path ?? entry.item.path) ?? entry.item.path);
          deferredFileIds.add(entry.item.fileId);
          continue;
        }
        if (error?.code === "v2_apply_active_editor_busy") {
          if (entry.item.eventType !== "update" || entry.item.isDeleted) throw error;
          // A normal content update can wait for its editor to close while
          // unrelated inbox items continue. Keep the rest of this file's
          // ordered chain received; rename/delete operations stay fail-fast.
          blocked += 1;
          deferredPaths.push(normalizeVaultPath(error.path ?? entry.item.path) ?? entry.item.path);
          deferredFileIds.add(entry.item.fileId);
          continue;
        }
        if (error?.code === "v2_apply_stage_cleanup_failed") {
          // Keep this inbox event received so the next sync can retry cleanup;
          // other independent paths in the page may still be applied.
          blocked += 1;
          deferredPaths.push(entry.item.path);
          continue;
        }
        if (error?.code === "v2_delete_requires_resolution"
          && entry.item.eventType === "delete" && entry.item.isDeleted && !entry.resolution) {
          // The sender already confirmed the cloud deletion. If this device has
          // divergent bytes for the exact same file identity, preserve them as
          // a durable local side copy and apply the tombstone instead of asking
          // the receiver to authorize the deletion a second time.
          await options.journal.markInboxItem(entry.cursor, "needs_resolution");
          const pendingEntry = (await options.journal.load())?.inbox.find((item) => item.cursor === entry.cursor);
          if (pendingEntry?.state === "needs_resolution") {
            try {
              await resolveInboxKeepingLocalOnDelete(pendingEntry);
              applied += 1;
              continue;
            } catch (preserveError: any) {
              if (preserveError?.code === "v2_apply_active_editor_busy"
                || preserveError?.code === "v2_delete_editor_busy") {
                blocked += 1;
                deferredPaths.push(entry.item.path);
                continue;
              }
              if (typeof preserveError?.code === "string"
                && (preserveError.code.startsWith("v2_conflict_") || preserveError.code.startsWith("v2_delete_"))) {
                blocked += 1;
                continue;
              }
              throw preserveError;
            }
          }
          blocked += 1;
          continue;
        }
        if (error?.code === "v2_delete_editor_busy") {
          await options.journal.markInboxItem(entry.cursor, "needs_resolution");
          blocked += 1;
          deferredPaths.push(entry.item.path);
          continue;
        }
        if ((typeof error?.code === "string" && error.code.startsWith("v2_delete_requires_"))
          || ["v2_apply_local_file_too_large", "v2_apply_local_changed", "v2_merge_local_changed", "v2_apply_local_conflict", "v2_apply_local_delete_unresolved", "v2_apply_local_move_unresolved",
            "v2_apply_local_rename_conflict", "v2_apply_rename_collision", "v2_apply_path_collision",
            "v2_apply_stage_marker_conflict", "v2_apply_stage_recovery_conflict"].includes(error?.code)) {
          await options.journal.markInboxItem(entry.cursor, "needs_resolution");
          blocked += 1;
          continue;
        }
        throw error;
      }
    }
    return deferredPaths.length ? { applied, blocked, deferredPaths } : { applied, blocked };
  }

  async function applySnapshotDeleteToTrash(item: ApplyItem): Promise<VaultSyncV2BaselineEntry> {
    if (!item.isDeleted || !options.trashLocalFile) {
      throw fail("v2_delete_requires_review", "远端删除尚未通过自动保护条件；本机文件保持不变");
    }
    const prior = await options.baseline.get(item.fileId);
    const tombstone = { fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor,
      path: item.path, plaintextHash: null, byteSize: 0, isDeleted: true } satisfies VaultSyncV2BaselineEntry;

    // An already-installed tombstone has no local bytes owned by this file ID
    // to remove. Do not mistake a later file at the same path for this file.
    if (prior && BigInt(prior.cursor) > BigInt(item.cursor)) {
      throw fail("v2_delete_requires_resolution", "快照删除版本早于本机基线；为避免回退，删除暂缓应用");
    }
    if (prior?.isDeleted) {
      if (prior.cursor === item.cursor && (prior.fileVersionId !== item.fileVersionId || prior.path !== item.path)) {
        throw fail("v2_delete_requires_resolution", "快照删除与本机墓碑身份不一致；删除暂缓应用");
      }
      return tombstone;
    }
    if (!prior) {
      if (fileAt(item.path)) {
        throw fail("v2_delete_requires_resolution", "本机路径没有对应的同步基线；远端删除不会删除本机文件");
      }
      return tombstone;
    }
    if (prior.path !== item.path) {
      throw fail("v2_delete_requires_resolution", "快照删除路径与本机同步基线不一致；远端删除暂缓应用");
    }
    if (BigInt(prior.cursor) >= BigInt(item.cursor)) {
      throw fail("v2_delete_requires_resolution", "快照删除版本不晚于本机基线；为避免回退，删除暂缓应用");
    }
    if (!prior.plaintextHash || !Number.isSafeInteger(prior.byteSize) || prior.byteSize < 0) {
      throw fail("v2_delete_requires_resolution", "本机删除基线不完整；远端删除暂缓应用");
    }
    const candidatePath = normalizeVaultPath(prior.path);
    if (!candidatePath || candidatePath !== prior.path) {
      throw fail("v2_delete_requires_resolution", "本机删除基线路径无效；远端删除暂缓应用");
    }
    if (!inScope(candidatePath)) return tombstone;
    const pathMove = (await options.pathIntents?.load() ?? []).find((move) => move.fileId === item.fileId
      || (!move.fileId && move.fromPath === prior.path));
    if (pathMove) {
      const movedPath = normalizeVaultPath(pathMove.toPath);
      if (pathMove.state === "conflict" || pathMove.fromPath !== prior.path || pathMove.toPath === prior.path
        || !movedPath || movedPath !== pathMove.toPath || !inScope(movedPath)
        || (pathMove.fileId && pathMove.fileId !== item.fileId)) {
        throw fail("v2_delete_requires_resolution", "本机改名路径与云端删除身份不一致；文件保持不变");
      }
      const movedFile = fileAt(movedPath);
      const movedBytes = await localBytes(movedPath);
      if (!movedFile || "children" in movedFile || !movedBytes) {
        throw fail("v2_delete_requires_resolution", "本机改名后的文件无法核验；云端删除暂缓应用");
      }
      assertNotComposing(movedPath);
      if (isVaultPathOpenInMarkdownEditor(options.app, movedPath)) {
        throw fail("v2_delete_editor_busy", "本机改名后的文件仍在编辑器中打开；自动删除已暂缓");
      }
      const movedGeneration = options.getPathGeneration?.(movedPath);
      const movedHash = await sha256Hex(movedBytes);
      await withVaultPathWriteLock(movedPath, async () => {
        await assertSnapshotApplyLease();
        assertVaultPathGeneration(movedPath, movedGeneration, options.getPathGeneration, "v2_delete_requires_review");
        assertNotComposing(movedPath);
        if (isVaultPathOpenInMarkdownEditor(options.app, movedPath)) {
          throw fail("v2_delete_editor_busy", "本机改名后的文件在应用删除时打开；自动删除已暂缓");
        }
        const latest = await localBytes(movedPath);
        if (!latest || latest.byteLength !== movedBytes.byteLength || await sha256Hex(latest) !== movedHash) {
          throw fail("v2_delete_requires_resolution", "本机改名后的文件发生变化；保留文件并重试云端删除");
        }
        const currentMove = (await options.pathIntents?.load() ?? []).find((move) => move.intentId === pathMove.intentId);
        if (!currentMove || currentMove.fromPath !== prior.path || currentMove.toPath !== movedPath
          || (currentMove.fileId && currentMove.fileId !== item.fileId)) {
          throw fail("v2_delete_requires_resolution", "本机改名待办在应用删除期间发生变化；文件保持不变");
        }
        if (!currentMove.fileId) await options.pathIntents?.bindFile(currentMove.intentId, item.fileId);
        await options.pathIntents?.remove(currentMove.intentId);
      });
      // The file moved locally is retained as a new local note while its prior
      // cloud identity becomes a tombstone. The next push publishes the move as
      // a new path instead of asking the receiver to approve the same delete.
      return tombstone;
    }
    const generation = options.getPathGeneration?.(candidatePath);
    assertNotComposing(candidatePath);
    if (isVaultPathOpenInMarkdownEditor(options.app, candidatePath)) {
      throw fail("v2_delete_editor_busy", "本机文件仍在编辑器中打开；自动删除已暂缓");
    }

    let divergentLocalBytes: Uint8Array | null = null;
    await withVaultPathWriteLock(candidatePath, async () => {
      await assertSnapshotApplyLease();
      assertVaultPathGeneration(candidatePath, generation, options.getPathGeneration, "v2_delete_requires_review");
      assertNotComposing(candidatePath);
      if (isVaultPathOpenInMarkdownEditor(options.app, candidatePath)) {
        throw fail("v2_delete_editor_busy", "删除期间文件在编辑器中打开；自动删除已暂缓");
      }
      const source = await localBytes(candidatePath);
      if (!source) {
        if (fileAt(candidatePath)) {
          throw fail("v2_delete_requires_review", "本机删除路径当前不是可读取文件；本机内容保持不变");
        }
        return;
      }
      if (source.byteLength !== prior.byteSize || await sha256Hex(source) !== prior.plaintextHash) {
        divergentLocalBytes = source;
        return;
      }
      const file = fileAt(candidatePath);
      if (!file || "children" in file) {
        throw fail("v2_delete_requires_review", "待删除路径不是本机文件；文件保持不变");
      }
      try { await options.trashLocalFile!(file); }
      catch (error) {
        throw fail("v2_delete_requires_review", `Obsidian 回收站无法接收文件；本机文件保持不变（${error instanceof Error ? error.message : String(error)}）`);
      }
      if (fileAt(candidatePath)) throw fail("v2_delete_requires_review", "Obsidian 回收站操作后路径仍存在；远端删除尚未确认");
    });
    if (divergentLocalBytes) {
      const sourceHash = await sha256Hex(divergentLocalBytes);
      const conflictCopyPath = uniqueVaultConflictCopyPath(candidatePath, item.cursor, (path) => !!fileAt(path));
      const conflictCopyGeneration = options.getPathGeneration?.(conflictCopyPath);
      await withVaultPathWriteLocks([candidatePath, conflictCopyPath], async () => {
        await assertSnapshotApplyLease();
        assertVaultPathGeneration(candidatePath, generation, options.getPathGeneration, "v2_delete_requires_review");
        assertVaultPathGeneration(conflictCopyPath, conflictCopyGeneration, options.getPathGeneration, "v2_delete_requires_review");
        assertNotComposing(candidatePath);
        if (isVaultPathOpenInMarkdownEditor(options.app, candidatePath)) {
          throw fail("v2_delete_editor_busy", "本机文件在保留副本时打开；自动删除已暂缓");
        }
        const latest = await localBytes(candidatePath);
        if (!latest || latest.byteLength !== divergentLocalBytes!.byteLength || await sha256Hex(latest) !== sourceHash) {
          throw fail("v2_delete_requires_resolution", "本机文件在保留副本期间发生变化；请重试云端删除");
        }
        if (fileAt(conflictCopyPath)) throw fail("v2_delete_requires_review", "本机副本目标路径已被占用；远端删除暂缓应用");
        const file = fileAt(candidatePath);
        if (!file || "children" in file) throw fail("v2_delete_requires_review", "本机删除路径不是文件；内容保持不变");
        await ensureParent(conflictCopyPath);
        assertVaultPathGeneration(candidatePath, generation, options.getPathGeneration, "v2_delete_requires_review");
        assertVaultPathGeneration(conflictCopyPath, conflictCopyGeneration, options.getPathGeneration, "v2_delete_requires_review");
        assertNotComposing(candidatePath);
        if (isVaultPathOpenInMarkdownEditor(options.app, candidatePath)) {
          throw fail("v2_delete_editor_busy", "本机文件在保留副本时打开；自动删除已暂缓");
        }
        const latestAfterParent = await localBytes(candidatePath);
        if (!latestAfterParent || latestAfterParent.byteLength !== divergentLocalBytes!.byteLength
          || await sha256Hex(latestAfterParent) !== sourceHash) {
          throw fail("v2_delete_requires_resolution", "本机文件在准备冲突副本时发生变化；请重试云端删除");
        }
        assertVaultPathGeneration(candidatePath, generation, options.getPathGeneration, "v2_delete_requires_review");
        assertVaultPathGeneration(conflictCopyPath, conflictCopyGeneration, options.getPathGeneration, "v2_delete_requires_review");
        assertNotComposing(candidatePath);
        if (isVaultPathOpenInMarkdownEditor(options.app, candidatePath)) {
          throw fail("v2_delete_editor_busy", "本机文件在保留副本时打开；自动删除已暂缓");
        }
        if (fileAt(conflictCopyPath)) throw fail("v2_delete_requires_review", "本机副本目标路径已被占用；远端删除暂缓应用");
        const latestFile = fileAt(candidatePath);
        if (!latestFile || "children" in latestFile) throw fail("v2_delete_requires_review", "本机删除路径不是文件；内容保持不变");
        await options.app.vault.rename(latestFile, conflictCopyPath);
        const preserved = await localBytes(conflictCopyPath);
        if (!preserved || preserved.byteLength !== divergentLocalBytes!.byteLength
          || await sha256Hex(preserved) !== sourceHash || fileAt(candidatePath)) {
          throw fail("v2_delete_requires_review", "本机修改副本回读校验失败；云端删除暂缓应用");
        }
      });
    }
    return tombstone;
  }

  async function applyRemoteDeleteToTrash(entry: VaultSyncInboxEntry): Promise<VaultSyncV2BaselineEntry> {
    const item = await normalizeItem(entry.item);
    if (item.eventType !== "delete" || !item.isDeleted || !options.trashLocalFile) {
      throw fail("v2_delete_requires_review", "远端删除尚未通过自动保护条件；本机文件保持不变");
    }
    const prior = await options.baseline.get(item.fileId);
    if (prior?.isDeleted && prior.fileVersionId === item.fileVersionId
      && prior.cursor === item.cursor && prior.path === item.path
      && prior.plaintextHash === null && prior.byteSize === 0) {
      const pendingMove = (await options.pathIntents?.load() ?? []).find((move) => move.fileId === item.fileId
        || (!move.fileId && move.fromPath === prior.path));
      if (pendingMove || fileAt(item.path)) {
        throw fail("v2_delete_requires_resolution", "已确认的云端删除正在等待本机路径处理；请检查本机文件后再同步 ACK");
      }
      // The local trash and tombstone baseline may have completed before the
      // inbox ACK was persisted. Replay only the ACK when the exact tombstone
      // is already durable and no local file or rename intent needs preserving.
      return prior;
    }
    if (!prior || prior.isDeleted || prior.path !== item.path || !prior.plaintextHash
      || item.previousPath !== item.path || item.previousVersionId !== prior.fileVersionId) {
      throw fail("v2_delete_requires_resolution", "删除路径或 fileId 与本机基线不同；本机文件保持不变");
    }
    const pathMove = (await options.pathIntents?.load() ?? []).find((move) => move.fileId === item.fileId
      || (!move.fileId && move.fromPath === prior.path));
    if (pathMove) throw fail("v2_delete_requires_resolution", "云端删除已由发起设备确认；接收端改名文件需要核验后再应用");
    assertNotComposing(item.path);
    if (isVaultPathOpenInMarkdownEditor(options.app, item.path)) {
      throw fail("v2_delete_editor_busy", "本机文件仍在编辑器中打开；自动删除已暂缓");
    }
    const source = await localBytes(item.path);
    if (!source) {
      const current = fileAt(item.path);
      if (current) throw fail("v2_delete_requires_review", "待删除路径当前不是可读取文件；本机内容保持不变");
      const generation = options.getPathGeneration?.(item.path);
      await withVaultPathWriteLock(item.path, async () => {
        assertVaultPathGeneration(item.path, generation, options.getPathGeneration, "v2_delete_requires_review");
          assertNotComposing(item.path);
        if (isVaultPathOpenInMarkdownEditor(options.app, item.path)) {
          throw fail("v2_delete_editor_busy", "本机删除文件仍在编辑器中打开；云端删除已暂缓");
        }
        if (fileAt(item.path)) {
          throw fail("v2_delete_requires_resolution", "本机文件在应用云端删除前重新出现；本机内容保持不变");
        }
      });
      // The receiver may have deleted the same unchanged file locally before
      // learning that another device already committed its tombstone. The
      // exact previous version plus an absent path proves the local delete has
      // converged; persist the remote tombstone and ACK without asking again.
      return { fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor,
        path: item.path, plaintextHash: null, byteSize: 0, isDeleted: true };
    }
    if (await sha256Hex(source) !== prior.plaintextHash || source.byteLength !== prior.byteSize) {
      throw fail("v2_delete_requires_resolution", "云端删除已由发起设备确认；接收端本机修改需要保留后再应用");
    }
    const file = fileAt(item.path);
    if (!file || "children" in file) throw fail("v2_delete_requires_review", "待删除路径不是本机文件；文件保持不变");
    const generation = options.getPathGeneration?.(item.path);
    await withVaultPathWriteLock(item.path, async () => {
      assertVaultPathGeneration(item.path, generation, options.getPathGeneration, "v2_delete_requires_review");
      assertNotComposing(item.path);
      if (isVaultPathOpenInMarkdownEditor(options.app, item.path)) {
        throw fail("v2_delete_editor_busy", "删除期间文件在编辑器中打开；自动删除已暂缓");
      }
      const latest = await localBytes(item.path);
      if (!latest || latest.byteLength !== prior.byteSize || await sha256Hex(latest) !== prior.plaintextHash) {
        throw fail("v2_delete_requires_resolution", "删除期间本机文件发生变化；文件保持不变");
      }
      assertVaultPathGeneration(item.path, generation, options.getPathGeneration, "v2_delete_requires_review");
      assertNotComposing(item.path);
      if (isVaultPathOpenInMarkdownEditor(options.app, item.path)) {
        throw fail("v2_delete_editor_busy", "删除期间文件在编辑器中打开；自动删除已暂缓");
      }
      const currentFile = fileAt(item.path);
      if (!currentFile || "children" in currentFile) {
        throw fail("v2_delete_requires_resolution", "本机文件在删除确认期间已移动或消失；文件保持不变");
      }
      try { await options.trashLocalFile!(currentFile); }
      catch (error) {
        throw fail("v2_delete_requires_review", `Obsidian 回收站无法接收文件；本机文件保持不变（${error instanceof Error ? error.message : String(error)}）`);
      }
      if (fileAt(item.path)) throw fail("v2_delete_requires_review", "Obsidian 回收站操作后路径仍存在；远端删除尚未确认");
    });
    return applyOne(entry.item);
  }

  async function canResolveRemoteRename(entry: VaultSyncInboxEntry): Promise<boolean> {
    const item = entry.item;
    if (entry.state !== "needs_resolution" || item.eventType !== "rename" || item.isDeleted
      || !item.previousPath || item.previousPath === item.path || !item.content || item.content.kind !== "object"
      || !contentFitsPlaintextLimit(item, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)
      || !inScope(item.previousPath) || !inScope(item.path)) return false;
    const resolution = entry.resolution;
    if (resolution && (resolution.kind !== "keep_local_on_rename" || resolution.sourcePath === item.path
      || resolution.targetPath !== item.path)) return false;
    const prior = await options.baseline.get(item.fileId);
    if (!prior || prior.isDeleted) return false;
    const moves = await options.pathIntents?.load() ?? [];
    const localMove = moves.find((move) => move.fromPath === item.previousPath
      && move.toPath !== item.path && (move.fileId === item.fileId || move.fileId === null)
      && inScope(move.toPath));
    if (!resolution && prior.path !== item.previousPath
      && (!localMove || prior.path !== localMove.fromPath)) return false;
    if (resolution && prior.path !== item.previousPath
      && (prior.path !== item.path || prior.fileVersionId !== item.fileVersionId
        || prior.plaintextHash !== resolution.remoteContentHash)) return false;
    if (resolution?.localMoveIntentId && prior.path === item.previousPath
      && (!localMove || localMove.intentId !== resolution.localMoveIntentId
        || localMove.toPath !== resolution.sourcePath || (localMove.fileId && localMove.fileId !== item.fileId))) return false;
    const sourcePath = resolution?.sourcePath ?? localMove?.toPath ?? item.previousPath;
    if (sourcePath === item.path) return false;
    const sourceFile = fileAt(sourcePath);
    if (!sourceFile || "children" in sourceFile
      || Number(sourceFile.stat?.size ?? 0) > MAX_CONFLICT_RESOLUTION_BYTES) return false;
    if (resolution) {
      const source = await localBytes(sourcePath);
      if (!source || source.byteLength > MAX_CONFLICT_RESOLUTION_BYTES
        || await sha256Hex(source) !== resolution.sourceContentHash) return false;
    }
    if (isVaultPathOpenInMarkdownEditor(options.app, sourcePath) || isVaultPathOpenInMarkdownEditor(options.app, item.path)) return false;
    const targetFile = fileAt(item.path);
    if (!targetFile) return true;
    const target = await localBytes(item.path);
    if (!target) return false;
    return !!resolution && await sha256Hex(target) === resolution.remoteContentHash;
  }

  async function resolveInboxKeepingLocalOnRename(entry: VaultSyncInboxEntry): Promise<{
    conflictCopyPath: string; preservedLocalPath: string; baseline: VaultSyncV2BaselineEntry;
  }> {
    if (!options.journal) throw new Error("v2 inbox journal is required");
    const item = await normalizeItem(entry.item);
    const previousPath = entry.item.previousPath;
    if (entry.state !== "needs_resolution" || entry.item.eventType !== "rename" || item.isDeleted
      || !previousPath || previousPath === item.path || !item.content || item.content.kind !== "object"
      || !contentFitsPlaintextLimit(item, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)
      || !inScope(previousPath) || !inScope(item.path)) {
      throw fail("v2_conflict_resolution_unsupported", "当前改名冲突不支持安全自动处理；两端文件均已保留");
    }
    assertNotEditing(item.path);
    const prior = await options.baseline.get(item.fileId);
    const existingResolution = entry.resolution;
    const moves = await options.pathIntents?.load() ?? [];
    const localMove = moves.find((move) => move.fromPath === previousPath
      && move.toPath !== item.path && (move.fileId === item.fileId || move.fileId === null)
      && inScope(move.toPath));
    const sourcePath = existingResolution?.sourcePath ?? localMove?.toPath ?? previousPath;
    if (!prior || prior.isDeleted || (!existingResolution && prior.path !== previousPath
      && (!localMove || prior.path !== localMove.fromPath))) {
      throw fail("v2_conflict_resolution_unsupported", "本机基线与远端改名前路径不一致；文件保持不变");
    }
    if (existingResolution && (existingResolution.kind !== "keep_local_on_rename"
      || existingResolution.sourcePath !== sourcePath || sourcePath === item.path || existingResolution.targetPath !== item.path
      )) {
      throw fail("v2_conflict_resolution_invalid", "持久化的改名恢复意图与远端变更不一致");
    }
    if (!existingResolution && localMove) {
      if (localMove.fileId && localMove.fileId !== item.fileId) {
        throw fail("v2_conflict_resolution_invalid", "本机改名待办关联到其他文件；文件保持不变");
      }
      if (!localMove.fileId) await options.pathIntents?.bindFile(localMove.intentId, item.fileId);
    }
    if (existingResolution?.localMoveIntentId && prior.path === previousPath
      && (!localMove || localMove.intentId !== existingResolution.localMoveIntentId
        || localMove.toPath !== sourcePath || (localMove.fileId && localMove.fileId !== item.fileId))) {
      throw fail("v2_conflict_resolution_invalid", "本机改名恢复待办缺失或不一致；文件保持不变");
    }
    if (existingResolution && prior.path !== previousPath
      && (prior.path !== item.path || prior.fileVersionId !== item.fileVersionId
        || prior.plaintextHash !== existingResolution.remoteContentHash)) {
      throw fail("v2_conflict_resolution_invalid", "改名恢复期间云端基线已继续变化；请重新同步后检查冲突");
    }
    assertNotEditing(sourcePath);
    const sourceBytes = await localBytes(sourcePath);
    if (!sourceBytes || sourceBytes.byteLength > MAX_CONFLICT_RESOLUTION_BYTES) {
      throw fail("v2_conflict_local_missing", "改名前的本机文件不存在或超过 24 MiB；本地与云端数据均已保留");
    }
    const sourceHash = await sha256Hex(sourceBytes);
    if (existingResolution && sourceHash !== existingResolution.sourceContentHash) {
      throw fail("v2_conflict_local_changed", "原路径本机内容在恢复期间发生变化；两个路径均保留，请先检查文件");
    }
    const sourceGeneration = options.getPathGeneration?.(sourcePath);
    const targetGeneration = options.getPathGeneration?.(item.path);
    let resolution: Extract<VaultSyncInboxResolution, { kind: "keep_local_on_rename" }>;
    let remoteBytes: Uint8Array;
    if (existingResolution) {
      resolution = existingResolution;
      remoteBytes = await options.download(item);
      if (!(remoteBytes instanceof Uint8Array) || remoteBytes.byteLength !== resolution.byteSize
        || await sha256Hex(remoteBytes) !== resolution.remoteContentHash) {
        throw fail("v2_conflict_remote_unavailable", "改名目标云端内容与已持久化恢复意图不一致；本地文件保持不变");
      }
    } else {
      if (fileAt(item.path)) {
        throw fail("v2_apply_rename_collision", "云端改名目标已被本地文件占用；本机内容保持不变");
      }
      remoteBytes = await options.download(item);
    if (!downloadedPlaintextMatchesItem(item, remoteBytes, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)) {
        throw fail("v2_conflict_remote_unavailable", "改名目标云端内容不可读取，或尺寸与变更记录不一致");
      }
      resolution = {
        kind: "keep_local_on_rename", sourcePath, sourceContentHash: sourceHash,
        targetPath: item.path, remoteContentHash: await sha256Hex(remoteBytes), byteSize: remoteBytes.byteLength,
        ...(localMove ? { localMoveIntentId: localMove.intentId } : {}),
      };
      assertVaultPathGeneration(sourcePath, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
      assertVaultPathGeneration(item.path, targetGeneration, options.getPathGeneration, "v2_apply_local_changed");
      const sourceAgain = await localBytes(sourcePath);
      if (!sourceAgain || await sha256Hex(sourceAgain) !== sourceHash || fileAt(item.path)) {
        throw fail("v2_conflict_local_changed", "改名冲突准备期间文件发生变化；请重新打开冲突处理");
      }
      await options.journal.beginInboxConflictResolution(entry.cursor, resolution);
    }

    const targetFile = fileAt(item.path);
    const targetBytes = await localBytes(item.path);
    if (!targetFile) {
      await createExclusive(item.path, remoteBytes, targetGeneration);
    } else if (!targetBytes || await sha256Hex(targetBytes) !== resolution.remoteContentHash) {
      throw fail("v2_apply_rename_collision", "云端改名目标在恢复期间被本地内容占用；两端文件均已保留");
    }
    assertVaultPathGeneration(sourcePath, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
    const sourceAfter = await localBytes(sourcePath);
    const targetAfter = await localBytes(item.path);
    if (!sourceAfter || await sha256Hex(sourceAfter) !== resolution.sourceContentHash
      || !targetAfter || await sha256Hex(targetAfter) !== resolution.remoteContentHash) {
      throw fail("v2_apply_write_unverified", "改名冲突处理后的文件校验失败；本地数据仍保留");
    }
    const baselineEntry: VaultSyncV2BaselineEntry = {
      fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor,
      path: item.path, plaintextHash: resolution.remoteContentHash, byteSize: targetAfter.byteLength, isDeleted: false,
    };
    if (item.path.toLowerCase().endsWith(".md")) {
      await options.baseContent?.put(resolution.remoteContentHash, remoteBytes).catch(() => ({ stored: false as const }));
    }
    await persistBaseline([baselineEntry]);
    if (resolution.localMoveIntentId) await options.pathIntents?.remove(resolution.localMoveIntentId);
    await options.journal.resolveInboxItem(entry.cursor, resolution.sourceContentHash);
    return { conflictCopyPath: "", preservedLocalPath: sourcePath, baseline: baselineEntry };
  }

  async function canResolveRemoteCreate(entry: VaultSyncInboxEntry): Promise<boolean> {
    const item = entry.item;
    if (entry.state !== "needs_resolution" || item.eventType !== "create" || item.previousPath !== null
      || item.isDeleted || !item.content || item.content.kind !== "object"
      || !contentFitsPlaintextLimit(item, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize) || !inScope(item.path)) return false;
    const resolution = entry.resolution;
    if (resolution && (resolution.kind !== "keep_local_on_create" || resolution.sourcePath !== item.path
      || resolution.targetPath !== item.path)) return false;
    const prior = await options.baseline.get(item.fileId);
    if (!resolution && prior) return false;
    if (resolution && prior && (prior.isDeleted || prior.path !== item.path || prior.fileVersionId !== item.fileVersionId
      || prior.plaintextHash !== resolution.remoteContentHash)) return false;
    if (isVaultPathOpenInMarkdownEditor(options.app, item.path)) return false;
    const sourceFile = fileAt(item.path);
    if (!resolution) {
      return !!sourceFile && !("children" in sourceFile)
        && Number(sourceFile.stat?.size ?? 0) <= MAX_CONFLICT_RESOLUTION_BYTES;
    }
    if (sourceFile && ("children" in sourceFile
      || Number(sourceFile.stat?.size ?? 0) > MAX_CONFLICT_RESOLUTION_BYTES)) return false;
    const source = sourceFile ? await localBytes(item.path) : null;
    const copyFile = fileAt(resolution.conflictCopyPath);
    const copy = await localBytes(resolution.conflictCopyPath);
    const sourceIsLocal = !!source && await sha256Hex(source) === resolution.sourceContentHash;
    const copyIsLocal = !!copy && await sha256Hex(copy) === resolution.sourceContentHash;
    if (sourceIsLocal && copyIsLocal) return sourceIsLocal && resolution.sourceContentHash === resolution.remoteContentHash;
    if (sourceIsLocal === copyIsLocal) return false;
    if (copyFile && !copyIsLocal) return false;
    if (sourceFile && source && !sourceIsLocal && await sha256Hex(source) !== resolution.remoteContentHash) return false;
    return true;
  }

  async function canResolveRemoteUpdate(entry: VaultSyncInboxEntry): Promise<boolean> {
    const item = entry.item;
    if (entry.state !== "needs_resolution" || item.eventType !== "update" || item.isDeleted
      || !item.content || item.content.kind !== "object"
      || !contentFitsPlaintextLimit(item, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)
      || !inScope(item.path)) return false;
    const prior = await options.baseline.get(item.fileId);
    if (!prior || prior.isDeleted || prior.path !== item.path || isVaultPathOpenInMarkdownEditor(options.app, item.path)) return false;
    const localFile = fileAt(item.path);
    return !!localFile && !("children" in localFile)
      && Number((localFile as any).stat?.size ?? 0) <= MAX_CONFLICT_RESOLUTION_BYTES;
  }

  async function resolveInboxKeepingLocalOnCreate(entry: VaultSyncInboxEntry): Promise<{
    conflictCopyPath: string; baseline: VaultSyncV2BaselineEntry;
  }> {
    if (!options.journal) throw new Error("v2 inbox journal is required");
    const item = await normalizeItem(entry.item);
    if (entry.state !== "needs_resolution" || entry.item.eventType !== "create" || entry.item.previousPath !== null
      || item.isDeleted || !item.content || item.content.kind !== "object"
      || !contentFitsPlaintextLimit(item, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize) || !inScope(item.path)) {
      throw fail("v2_conflict_resolution_unsupported", "当前新增文件冲突不支持安全自动处理；双方文件均已保留");
    }
    const prior = await options.baseline.get(item.fileId);
    const existingResolution = entry.resolution;
    if (existingResolution && (existingResolution.kind !== "keep_local_on_create"
      || existingResolution.sourcePath !== item.path || existingResolution.targetPath !== item.path)) {
      throw fail("v2_conflict_resolution_invalid", "持久化的新建冲突恢复意图与远端变更不一致");
    }
    if (!existingResolution && prior) throw fail("v2_conflict_resolution_invalid", "本机文件身份已建立基线；请重新同步后检查冲突");
    if (existingResolution && prior && (prior.isDeleted || prior.path !== item.path || prior.fileVersionId !== item.fileVersionId
      || prior.plaintextHash !== existingResolution.remoteContentHash)) {
      throw fail("v2_conflict_resolution_invalid", "冲突恢复期间云端基线已继续变化；请重新同步后检查冲突");
    }
    assertNotEditing(item.path);

    let resolution: Extract<VaultSyncInboxResolution, { kind: "keep_local_on_create" }>;
    let remoteBytes: Uint8Array;
    if (existingResolution) {
      resolution = existingResolution;
      remoteBytes = await options.download(item);
      if (!(remoteBytes instanceof Uint8Array) || remoteBytes.byteLength !== resolution.byteSize
        || await sha256Hex(remoteBytes) !== resolution.remoteContentHash) {
        throw fail("v2_conflict_remote_unavailable", "云端新增内容与已持久化恢复意图不一致；本机文件保持不变");
      }
    } else {
      const sourceFile = fileAt(item.path);
      const source = await localBytes(item.path);
      if (!sourceFile || "children" in sourceFile || !source || source.byteLength > MAX_CONFLICT_RESOLUTION_BYTES) {
        throw fail("v2_conflict_local_missing", "本机冲突文件不存在、是目录或超过 24 MiB；双方内容均已保留");
      }
      const sourceHash = await sha256Hex(source);
      remoteBytes = await options.download(item);
      if (!downloadedPlaintextMatchesItem(item, remoteBytes, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)) {
        throw fail("v2_conflict_remote_unavailable", "云端新增内容不可读取，或尺寸与变更记录不一致");
      }
      const conflictCopyPath = uniqueVaultConflictCopyPath(item.path, item.cursor, (path) => !!fileAt(path));
      resolution = {
        kind: "keep_local_on_create", sourcePath: item.path, sourceContentHash: sourceHash,
        conflictCopyPath, targetPath: item.path, remoteContentHash: await sha256Hex(remoteBytes), byteSize: remoteBytes.byteLength,
      };
      const sourceAgain = await localBytes(item.path);
      if (!sourceAgain || await sha256Hex(sourceAgain) !== sourceHash || fileAt(conflictCopyPath)) {
        throw fail("v2_conflict_local_changed", "新建冲突准备期间本机文件发生变化；请重新打开冲突处理");
      }
      await options.journal.beginInboxConflictResolution(entry.cursor, resolution);
    }

    const sourceFile = fileAt(item.path);
    const source = await localBytes(item.path);
    const copyFile = fileAt(resolution.conflictCopyPath);
    const copy = await localBytes(resolution.conflictCopyPath);
    const sourceIsLocal = !!source && await sha256Hex(source) === resolution.sourceContentHash;
    const copyIsLocal = !!copy && await sha256Hex(copy) === resolution.sourceContentHash;
    const sourceIsRemote = !!source && await sha256Hex(source) === resolution.remoteContentHash;
    if (sourceIsRemote && copyIsLocal) {
      // A prior attempt created the remote path after moving the local bytes.
    } else if (sourceIsLocal && !copyFile) {
      const sourceGeneration = options.getPathGeneration?.(item.path);
      const copyGeneration = options.getPathGeneration?.(resolution.conflictCopyPath);
      await withVaultPathWriteLocks([item.path, resolution.conflictCopyPath], async () => {
        assertVaultPathGeneration(item.path, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertVaultPathGeneration(resolution.conflictCopyPath, copyGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertNotEditing(item.path);
        const latest = await localBytes(item.path);
        if (!latest || await sha256Hex(latest) !== resolution.sourceContentHash || fileAt(resolution.conflictCopyPath)) {
          throw fail("v2_conflict_local_changed", "本机文件在保留副本期间发生变化；原文件保持不变");
        }
        await ensureParent(resolution.conflictCopyPath);
        assertVaultPathGeneration(item.path, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertVaultPathGeneration(resolution.conflictCopyPath, copyGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertNotEditing(item.path);
        const latestAfterParent = await localBytes(item.path);
        if (!latestAfterParent || await sha256Hex(latestAfterParent) !== resolution.sourceContentHash) {
          throw fail("v2_conflict_local_changed", "本机文件在保留副本期间发生变化；原文件保持不变");
        }
        assertVaultPathGeneration(item.path, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertVaultPathGeneration(resolution.conflictCopyPath, copyGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertNotEditing(item.path);
        if (fileAt(resolution.conflictCopyPath)) throw fail("v2_conflict_copy_collision", "恢复副本路径在操作期间被占用；本机原文保持不变");
        const currentSource = fileAt(item.path);
        if (!currentSource || "children" in currentSource) {
          throw fail("v2_conflict_local_changed", "本机原文在保留副本期间已移动；文件保持不变");
        }
        await app.vault.rename(currentSource, resolution.conflictCopyPath);
      });
    } else if (sourceIsLocal && copyFile) {
      throw fail("v2_conflict_copy_collision", "恢复副本路径在操作期间被占用；本机原文保持不变");
    } else if (!sourceFile && copyIsLocal) {
      // A prior attempt moved the local bytes and stopped before remote creation.
    } else {
      throw fail("v2_conflict_local_changed", "本机原文或持久副本在恢复期间发生变化；两端文件均保留");
    }

    const preservedCopy = await localBytes(resolution.conflictCopyPath);
    if (!preservedCopy || await sha256Hex(preservedCopy) !== resolution.sourceContentHash) {
      throw fail("v2_conflict_copy_unverified", "本机冲突副本回读校验失败；云端文件尚未应用");
    }
    const targetFile = fileAt(item.path);
    const targetBytes = await localBytes(item.path);
    if (!targetFile) {
      const targetGeneration = options.getPathGeneration?.(item.path);
      await createExclusive(item.path, remoteBytes, targetGeneration);
    } else if (!targetBytes || await sha256Hex(targetBytes) !== resolution.remoteContentHash) {
      throw fail("v2_apply_path_collision", "远端新增路径在恢复期间被本机内容占用；副本与现有文件均保留");
    }
    const remoteAfter = await localBytes(item.path);
    if (!remoteAfter || await sha256Hex(remoteAfter) !== resolution.remoteContentHash) {
      throw fail("v2_apply_write_unverified", "云端新增文件落盘回读校验失败；本机副本仍保留");
    }
    const baselineEntry: VaultSyncV2BaselineEntry = {
      fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor,
      path: item.path, plaintextHash: resolution.remoteContentHash, byteSize: remoteAfter.byteLength, isDeleted: false,
    };
    if (item.path.toLowerCase().endsWith(".md")) {
      await options.baseContent?.put(resolution.remoteContentHash, remoteBytes).catch(() => ({ stored: false as const }));
    }
    await persistBaseline([baselineEntry]);
    await options.journal.resolveInboxItem(entry.cursor, resolution.sourceContentHash);
    return { conflictCopyPath: resolution.conflictCopyPath, baseline: baselineEntry };
  }

  async function canResolveRemoteDelete(entry: VaultSyncInboxEntry): Promise<boolean> {
    const item = entry.item;
    if (entry.state !== "needs_resolution" || item.eventType !== "delete" || !item.isDeleted
      || item.content !== null || item.byteSize !== 0 || !inScope(item.path)) return false;
    const resolution = entry.resolution;
    if (resolution && (resolution.kind !== "keep_local_on_delete" || resolution.targetPath !== item.path)) return false;
    const prior = await options.baseline.get(item.fileId);
    if (!resolution && (!prior || prior.isDeleted || prior.path !== item.path)) return false;
    if (resolution && (!prior || (prior.path !== item.path
      || (prior.isDeleted && prior.fileVersionId !== item.fileVersionId)))) return false;
    const moves = await options.pathIntents?.load() ?? [];
    const localMove = moves.find((move) => move.fromPath === item.path && move.toPath !== item.path
      && (move.fileId === item.fileId || move.fileId === null) && inScope(move.toPath));
    const movedResolution = resolution?.localMoveIntentId !== undefined;
    if (movedResolution) {
      if (resolution!.sourcePath === item.path || resolution!.conflictCopyPath !== "") return false;
      if (!prior!.isDeleted && (!localMove || localMove.intentId !== resolution!.localMoveIntentId
        || localMove.toPath !== resolution!.sourcePath || (localMove.fileId && localMove.fileId !== item.fileId))) return false;
    } else if (resolution && (resolution.sourcePath !== item.path || resolution.conflictCopyPath === "")) return false;
    const sourcePath = resolution?.sourcePath ?? localMove?.toPath ?? item.path;
    if (isVaultPathOpenInMarkdownEditor(options.app, sourcePath)) return false;
    const sourceFile = fileAt(sourcePath);
    if (!resolution) {
      return !!sourceFile && !("children" in sourceFile)
        && Number(sourceFile.stat?.size ?? 0) <= MAX_CONFLICT_RESOLUTION_BYTES;
    }
    if (sourceFile && ("children" in sourceFile
      || Number(sourceFile.stat?.size ?? 0) > MAX_CONFLICT_RESOLUTION_BYTES)) return false;
    const source = sourceFile ? await localBytes(sourcePath) : null;
    const sourceMatches = !!source && source.byteLength === resolution.localByteSize
      && await sha256Hex(source) === resolution.sourceContentHash;
    if (movedResolution) return sourceMatches;
    const copy = await localBytes(resolution.conflictCopyPath);
    const copyMatches = !!copy && copy.byteLength === resolution.localByteSize
      && await sha256Hex(copy) === resolution.sourceContentHash;
    return sourceMatches || copyMatches;
  }

  async function resolveInboxKeepingLocalOnDelete(entry: VaultSyncInboxEntry): Promise<{
    conflictCopyPath: string; preservedLocalPath?: string; baseline: VaultSyncV2BaselineEntry;
  }> {
    if (!options.journal) throw new Error("v2 inbox journal is required");
    const item = await normalizeItem(entry.item);
    if (entry.state !== "needs_resolution" || entry.item.eventType !== "delete" || !item.isDeleted
      || item.content !== null || item.byteSize !== 0 || !inScope(item.path)) {
      throw fail("v2_conflict_resolution_unsupported", "当前删除冲突不支持安全自动处理；本机文件保持不变");
    }
    const prior = await options.baseline.get(item.fileId);
    const existingResolution = entry.resolution;
    const moves = await options.pathIntents?.load() ?? [];
    const localMove = moves.find((move) => move.fromPath === item.path && move.toPath !== item.path
      && (move.fileId === item.fileId || move.fileId === null) && inScope(move.toPath));
    if (existingResolution && (existingResolution.kind !== "keep_local_on_delete"
      || existingResolution.targetPath !== item.path)) {
      throw fail("v2_conflict_resolution_invalid", "持久化的删除冲突恢复意图与远端变更不一致");
    }
    if (!existingResolution && (!prior || prior.isDeleted || prior.path !== item.path)) {
      throw fail("v2_conflict_resolution_invalid", "删除冲突缺少对应的有效本机基线；文件保持不变");
    }
    if (existingResolution && prior && (prior.path !== item.path
      || (prior.isDeleted && prior.fileVersionId !== item.fileVersionId))) {
      throw fail("v2_conflict_resolution_invalid", "删除冲突期间本机文件路径已变化；请重新同步后检查");
    }
    let resolution: Extract<VaultSyncInboxResolution, { kind: "keep_local_on_delete" }>;
    if (existingResolution) {
      resolution = existingResolution;
    } else {
      const sourcePath = localMove?.toPath ?? item.path;
      assertNotEditing(sourcePath);
      if (localMove && localMove.fileId && localMove.fileId !== item.fileId) {
        throw fail("v2_conflict_resolution_invalid", "本机改名待办关联到其他文件；文件保持不变");
      }
      if (localMove && !localMove.fileId) await options.pathIntents?.bindFile(localMove.intentId, item.fileId);
      const source = await localBytes(sourcePath);
      if (!source || source.byteLength > MAX_CONFLICT_RESOLUTION_BYTES) {
        throw fail("v2_conflict_local_missing", "本机删除冲突文件不存在或超过 24 MiB；本机内容保持不变");
      }
      const conflictCopyPath = localMove ? "" : uniqueVaultConflictCopyPath(item.path, item.cursor, (path) => !!fileAt(path));
      resolution = { kind: "keep_local_on_delete", sourcePath, sourceContentHash: await sha256Hex(source),
        conflictCopyPath, targetPath: item.path, localByteSize: source.byteLength,
        ...(localMove ? { localMoveIntentId: localMove.intentId } : {}) };
      const sourceAgain = await localBytes(sourcePath);
      if (!sourceAgain || await sha256Hex(sourceAgain) !== resolution.sourceContentHash
        || (!localMove && fileAt(conflictCopyPath))) {
        throw fail("v2_conflict_local_changed", "删除冲突准备期间本机文件发生变化；请重新打开冲突处理");
      }
      await options.journal.beginInboxConflictResolution(entry.cursor, resolution);
    }

    const sourcePath = resolution.sourcePath;
    const isMovedLocalFile = resolution.localMoveIntentId !== undefined;
    if (isMovedLocalFile) {
      if (sourcePath === item.path || resolution.conflictCopyPath !== "") {
        throw fail("v2_conflict_resolution_invalid", "本机改名恢复意图的路径信息无效；文件保持不变");
      }
      if (prior && !prior.isDeleted && (!localMove || localMove.intentId !== resolution.localMoveIntentId
        || localMove.toPath !== sourcePath || (localMove.fileId && localMove.fileId !== item.fileId))) {
        throw fail("v2_conflict_resolution_invalid", "本机改名恢复待办缺失或不一致；文件保持不变");
      }
      const sourceGeneration = options.getPathGeneration?.(sourcePath);
      await withVaultPathWriteLock(sourcePath, async () => {
        assertVaultPathGeneration(sourcePath, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertNotEditing(sourcePath);
        const source = await localBytes(sourcePath);
        if (!source || source.byteLength !== resolution.localByteSize
          || await sha256Hex(source) !== resolution.sourceContentHash) {
          throw fail("v2_conflict_local_changed", "已改名的本机文件在恢复期间发生变化；本机内容保持不变");
        }
        const baselineEntry: VaultSyncV2BaselineEntry = {
          fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor,
          path: item.path, plaintextHash: null, byteSize: 0, isDeleted: true,
        };
        await persistBaseline([baselineEntry]);
      });
      await options.pathIntents?.remove(resolution.localMoveIntentId!);
      const baselineEntry = await options.baseline.get(item.fileId);
      if (!baselineEntry || !baselineEntry.isDeleted || baselineEntry.fileVersionId !== item.fileVersionId) {
        throw fail("v2_conflict_resolution_invalid", "删除确认后的云端基线回读失败；本机文件仍已保留");
      }
      await options.journal.resolveInboxItem(entry.cursor, resolution.sourceContentHash);
      return { conflictCopyPath: "", preservedLocalPath: sourcePath, baseline: baselineEntry };
    }

    assertNotEditing(item.path);

    const sourceFile = fileAt(item.path);
    const source = await localBytes(item.path);
    const copyFile = fileAt(resolution.conflictCopyPath);
    const copy = await localBytes(resolution.conflictCopyPath);
    const sourceMatches = !!source && await sha256Hex(source) === resolution.sourceContentHash
      && source.byteLength === resolution.localByteSize;
    const copyMatches = !!copy && await sha256Hex(copy) === resolution.sourceContentHash
      && copy.byteLength === resolution.localByteSize;
    if (sourceMatches && !copyFile) {
      const sourceGeneration = options.getPathGeneration?.(item.path);
      const copyGeneration = options.getPathGeneration?.(resolution.conflictCopyPath);
      await withVaultPathWriteLocks([item.path, resolution.conflictCopyPath], async () => {
        assertVaultPathGeneration(item.path, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertVaultPathGeneration(resolution.conflictCopyPath, copyGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertNotEditing(item.path);
        const latest = await localBytes(item.path);
        if (!latest || latest.byteLength !== resolution.localByteSize
          || await sha256Hex(latest) !== resolution.sourceContentHash || fileAt(resolution.conflictCopyPath)) {
          throw fail("v2_conflict_local_changed", "本机文件在保留副本期间发生变化；原文件保持不变");
        }
        await ensureParent(resolution.conflictCopyPath);
        assertVaultPathGeneration(item.path, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertVaultPathGeneration(resolution.conflictCopyPath, copyGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertNotEditing(item.path);
        const latestAfterParent = await localBytes(item.path);
        if (!latestAfterParent || latestAfterParent.byteLength !== resolution.localByteSize
          || await sha256Hex(latestAfterParent) !== resolution.sourceContentHash) {
          throw fail("v2_conflict_local_changed", "本机文件在保留副本期间发生变化；原文件保持不变");
        }
        assertVaultPathGeneration(item.path, sourceGeneration, options.getPathGeneration, "v2_conflict_local_changed");
        assertVaultPathGeneration(resolution.conflictCopyPath, copyGeneration, options.getPathGeneration, "v2_apply_local_changed");
        assertNotEditing(item.path);
        if (fileAt(resolution.conflictCopyPath)) throw fail("v2_conflict_copy_collision", "恢复副本路径在操作期间被占用；本机原文保持不变");
        const currentSource = fileAt(item.path);
        if (!currentSource || "children" in currentSource) {
          throw fail("v2_conflict_local_changed", "本机原文在保留副本期间已移动；文件保持不变");
        }
        await app.vault.rename(currentSource, resolution.conflictCopyPath);
      });
    } else if (!copyMatches) {
      throw fail("v2_conflict_copy_unverified", "本机删除冲突副本尚未可靠保存；已确认的云端删除暂缓应用");
    }
    const preservedCopy = await localBytes(resolution.conflictCopyPath);
    if (!preservedCopy || preservedCopy.byteLength !== resolution.localByteSize
      || await sha256Hex(preservedCopy) !== resolution.sourceContentHash) {
      throw fail("v2_conflict_copy_unverified", "本机删除冲突副本回读校验失败；已确认的云端删除暂缓应用");
    }
    const baselineEntry: VaultSyncV2BaselineEntry = {
      fileId: item.fileId, fileVersionId: item.fileVersionId, cursor: item.cursor,
      path: item.path, plaintextHash: null, byteSize: 0, isDeleted: true,
    };
    await persistBaseline([baselineEntry]);
    await options.journal.resolveInboxItem(entry.cursor, resolution.sourceContentHash);
    return { conflictCopyPath: resolution.conflictCopyPath, baseline: baselineEntry };
  }

  async function resolveInboxWithRemoteInner(cursor: string): Promise<{
    conflictCopyPath: string; preservedLocalPath?: string; baseline: VaultSyncV2BaselineEntry;
  }> {
    if (!options.journal) throw new Error("v2 inbox journal is required");
    const state = await options.journal.load();
    const entry = state?.inbox.find((item) => item.cursor === cursor);
    if (!entry || entry.state !== "needs_resolution") throw fail("v2_conflict_missing", "待处理的远端冲突不存在");
    if (entry.item.eventType === "rename") return resolveInboxKeepingLocalOnRename(entry);
    if (entry.item.eventType === "create") return resolveInboxKeepingLocalOnCreate(entry);
    if (entry.item.eventType === "delete") return resolveInboxKeepingLocalOnDelete(entry);
    if (entry.item.eventType !== "update" || entry.item.isDeleted || !entry.item.content
      || entry.item.content.kind !== "object"
      || !contentFitsPlaintextLimit(entry.item, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)) {
      throw fail("v2_conflict_resolution_unsupported", "当前仅支持 24 MiB 内的同路径对象更新冲突；本地与远端数据均已保留");
    }
    const item = await normalizeItem(entry.item);
    const prior = await options.baseline.get(item.fileId);
    if (!prior || prior.isDeleted || prior.path !== item.path) {
      throw fail("v2_conflict_resolution_unsupported", "改名、删除或首次加入冲突需要专门处理；当前文件保持不变");
    }
    assertNotEditing(prior.path);
    const existingResolution = entry.resolution;
    if (existingResolution && (existingResolution.kind !== "keep_local_on_update"
      || existingResolution.sourcePath !== prior.path || existingResolution.targetPath !== prior.path)) {
      throw fail("v2_conflict_resolution_invalid", "同路径更新冲突的恢复记录与云端变更不一致；本机文件保持不变");
    }
    const localFile = fileAt(prior.path);
    const localFileSize = Number((localFile as any)?.stat?.size ?? 0);
    if (localFileSize > MAX_CONFLICT_RESOLUTION_BYTES) {
      throw fail("v2_conflict_resolution_unsupported", "本机冲突文件超过 24 MiB 安全处理上限；本地与远端数据均已保留");
    }
    const local = await localBytes(prior.path);
    if (!local && !existingResolution) throw fail("v2_conflict_local_missing", "本地冲突文件已不存在；请先找回本地文件");
    if (local && local.byteLength > MAX_CONFLICT_RESOLUTION_BYTES) {
      throw fail("v2_conflict_resolution_unsupported", "本机冲突文件超过 24 MiB 安全处理上限；本地与远端数据均已保留");
    }
    const expectedLocalHash = local ? await sha256Hex(local) : null;
    const remoteBytes = await options.download(item);
    if (!downloadedPlaintextMatchesItem(entry.item, remoteBytes, MAX_CONFLICT_RESOLUTION_BYTES, options.allowEncryptedSize)) {
      throw fail("v2_conflict_remote_unavailable", "远端冲突版本不可读取，或字节尺寸与变更记录不一致");
    }
    const remoteHash = await sha256Hex(remoteBytes);
    if (existingResolution && (existingResolution.remoteContentHash !== remoteHash
      || existingResolution.byteSize !== remoteBytes.byteLength)) {
      throw fail("v2_conflict_resolution_invalid", "冲突处理期间云端版本已变化；本机文件保持不变");
    }
    if (expectedLocalHash === remoteHash) {
      let conflictCopyPath = "";
      let preservedLocalHash = expectedLocalHash ?? remoteHash;
      if (existingResolution) {
        conflictCopyPath = existingResolution.conflictCopyPath;
        const savedLocal = await localBytes(conflictCopyPath);
        if (!savedLocal || savedLocal.byteLength > MAX_CONFLICT_RESOLUTION_BYTES
          || await sha256Hex(savedLocal) !== existingResolution.sourceContentHash) {
          throw fail("v2_conflict_copy_unverified", "原本地冲突副本无法校验；云端版本保持待处理");
        }
        preservedLocalHash = existingResolution.sourceContentHash;
      } else {
        const preferredConflictPath = uniqueVaultConflictCopyPath(prior.path, cursor, () => false);
        const savedLocal = await localBytes(preferredConflictPath);
        if (savedLocal && await sha256Hex(savedLocal) !== remoteHash) {
          conflictCopyPath = preferredConflictPath;
          preservedLocalHash = await sha256Hex(savedLocal);
        }
      }
      const baseline = await applyOne(entry.item, { expectedLocalHash: expectedLocalHash!, downloadedBytes: remoteBytes });
      await persistBaseline([baseline]);
      await options.journal.resolveInboxItem(cursor, preservedLocalHash);
      return { conflictCopyPath, baseline };
    }

    let resolution = existingResolution;
    if (!resolution) {
      if (!local || !expectedLocalHash) throw fail("v2_conflict_local_missing", "本地冲突文件已不存在；请先找回本地文件");
      const conflictCopyPath = uniqueVaultConflictCopyPath(prior.path, cursor, (path) => !!fileAt(path));
      resolution = {
        kind: "keep_local_on_update", sourcePath: prior.path, sourceContentHash: expectedLocalHash,
        conflictCopyPath, targetPath: prior.path, remoteContentHash: remoteHash, byteSize: remoteBytes.byteLength,
      };
      await options.journal.beginInboxConflictResolution(cursor, resolution);
    }

    let savedLocal = await localBytes(resolution.conflictCopyPath);
    if (!savedLocal || await sha256Hex(savedLocal) !== resolution.sourceContentHash) {
      if (!local || expectedLocalHash !== resolution.sourceContentHash) {
        throw fail("v2_conflict_copy_unverified", "原本地冲突副本无法校验；云端版本保持待处理");
      }
      if (fileAt(resolution.conflictCopyPath)) {
        const isPartialLocalCopy = !!savedLocal && savedLocal.byteLength < local.byteLength
          && savedLocal.every((byte, index) => byte === local[index]);
        if (!isPartialLocalCopy) {
          throw fail("v2_conflict_copy_unverified", "冲突副本路径包含其他内容；为避免覆盖，本机与云端版本均保持不变");
        }
        await adapter.remove(resolution.conflictCopyPath);
        if (fileAt(resolution.conflictCopyPath)) {
          throw fail("v2_conflict_copy_unverified", "不完整的冲突副本无法安全清理；云端版本保持待处理");
        }
      }
      await ensureParent(resolution.conflictCopyPath);
      await writeBinaryAssetSafely(options.app, resolution.conflictCopyPath, local);
      savedLocal = await localBytes(resolution.conflictCopyPath);
    }
    if (!savedLocal || await sha256Hex(savedLocal) !== resolution.sourceContentHash) {
      throw fail("v2_conflict_copy_unverified", "原本地冲突副本回读校验失败；云端版本保持待处理");
    }

    let applyHash = expectedLocalHash ?? remoteHash;
    if (!local) {
      await createExclusive(prior.path, remoteBytes);
      applyHash = remoteHash;
    } else if (expectedLocalHash !== resolution.sourceContentHash && expectedLocalHash !== remoteHash) {
      const isPartialRemoteWrite = local.byteLength < remoteBytes.byteLength
        && local.every((byte, index) => byte === remoteBytes[index]);
      if (!isPartialRemoteWrite) {
        const baseCopyPath = uniqueVaultConflictCopyPath(prior.path, cursor, () => false);
        const dot = baseCopyPath.lastIndexOf(".");
        const slash = baseCopyPath.lastIndexOf("/");
        const copyStem = dot > slash ? baseCopyPath.slice(0, dot) : baseCopyPath;
        const copyExtension = dot > slash ? baseCopyPath.slice(dot) : "";
        const candidates = (options.app.vault.getFiles?.() ?? []).map((file: any) => String(file.path))
          .filter((path) => {
            if (path === baseCopyPath) return true;
            if (!path.startsWith(`${copyStem}-`) || (copyExtension && !path.endsWith(copyExtension))) return false;
            const sequence = path.slice(copyStem.length, copyExtension ? -copyExtension.length : undefined);
            return /^-\d+$/.test(sequence);
          });
        let preservedCurrent = false;
        for (const candidate of candidates) {
          const candidateBytes = await localBytes(candidate);
          if (candidateBytes && await sha256Hex(candidateBytes) === expectedLocalHash) {
            preservedCurrent = true;
            break;
          }
        }
        if (!preservedCurrent) {
          const extraCopyPath = uniqueVaultConflictCopyPath(prior.path, cursor, (path) => !!fileAt(path));
          await ensureParent(extraCopyPath);
          await writeBinaryAssetSafely(options.app, extraCopyPath, local);
          const extraCopy = await localBytes(extraCopyPath);
          if (!extraCopy || await sha256Hex(extraCopy) !== expectedLocalHash) {
            throw fail("v2_conflict_copy_unverified", "重启后的本机编辑副本校验失败；云端版本保持待处理");
          }
        }
      }
    }
    const baseline = await applyOne(entry.item, { expectedLocalHash: applyHash, downloadedBytes: remoteBytes });
    await persistBaseline([baseline]);
    await options.journal.resolveInboxItem(cursor, resolution.sourceContentHash);
    return { conflictCopyPath: resolution.conflictCopyPath, baseline };
  }

  async function resolveInboxWithRemote(cursor: string) {
    if (!options.objectWorkGate) return resolveInboxWithRemoteInner(cursor);
    const result = await options.objectWorkGate.run(() => resolveInboxWithRemoteInner(cursor));
    if (!result.started) throw fail("v2_conflict_resolution_busy", "另一个大对象恢复正在运行，请完成后再处理此冲突");
    return result.value;
  }

  return { applySnapshot, applyReceivedInbox, canResolveRemoteRename, canResolveRemoteCreate, canResolveRemoteUpdate, canResolveRemoteDelete, resolveInboxWithRemote };
}
