// Vault 多端同步：本地扫描 + prevSync 持久化。
// 提供 scanLocalFiles（遍历 vault、计算 hash）和 PrevSyncStore（读写状态 JSON）。
// 依赖 Obsidian Vault API，但通过接口注入便于测试。

import type { App, TFile } from "obsidian";
import { normalizeVaultPath, portableVaultPathComparisonKey, portableVaultPathKey, SHA256_PATTERN, VAULT_SYNC_SKIP_PREFIXES } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { FileEntity } from "./vault-sync-diff.ts";

/** 扫描结果：path → FileEntity。 */
export type LocalIndex = Map<string, FileEntity>;

export interface ScanResult {
  index: LocalIndex;
  unreadablePaths: string[];
  /** Files larger than the caller's read budget, rejected before readBinary. */
  oversizedPaths: string[];
  /** Paths that collide under portable case and Unicode normalization rules. */
  pathCollisions: string[][];
  /** User files rejected by the portable path contract, not internal skips. */
  invalidPaths: string[];
  /** Number of file bodies read in this pass. */
  hashesComputed: number;
  /** Number of hashes reused from a metadata-matching local cache. */
  cacheHits: number;
  /** Number of cache entries rehashed by the bounded audit wheel. */
  auditRehashes: number;
}

/** V2 writes must pause when any in-scope file could not be represented safely. */
export function assertV2LocalScanComplete(scan: ScanResult): void {
  const issueCount = scan.unreadablePaths.length + scan.oversizedPaths.length
    + scan.invalidPaths.length + scan.pathCollisions.length;
  if (!issueCount) return;
  throw Object.assign(new Error(
    `本地文件清单不完整，已暂停 v2 写入（读取失败 ${scan.unreadablePaths.length}、超过单文件上限 ${scan.oversizedPaths.length}、路径无效 ${scan.invalidPaths.length}、路径冲突 ${scan.pathCollisions.length}）`,
  ), { code: "vault_sync_v2_local_scan_incomplete" });
}

/** Enter the V2 push lane only after the complete local manifest is verified. */
export async function runV2PushAfterCompleteLocalScan<Result>(
  scan: ScanResult,
  runPush: (index: LocalIndex) => Promise<Result>,
): Promise<Result> {
  assertV2LocalScanComplete(scan);
  return runPush(scan.index);
}

export interface LocalHashCacheFile {
  path: string;
  byteSize: number;
  mtimeMs: number;
}

/** Optional cache used by the v1 scanner until the v2 engine replaces it. */
export interface LocalFileHashCache {
  prepare(files: LocalHashCacheFile[]): void;
  get(path: string, byteSize: number, mtimeMs: number): { hash: string } | null;
  isAuditPath(path: string): boolean;
  set(path: string, hash: string, byteSize: number, mtimeMs: number): boolean;
  isCurrent(path: string): boolean;
  finish(paths: string[], pruneMissing: boolean): Promise<void>;
}

function createEventLoopYielder(): { yield(): Promise<void>; dispose(): void } {
  let channel: MessageChannel | null = null;
  let pendingResolve: (() => void) | null = null;
  let disposed = false;
  return {
    yield() {
      if (disposed) return Promise.resolve();
      if (typeof globalThis.MessageChannel !== "function") {
        return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
      try {
        channel ??= new MessageChannel();
      } catch {
        channel?.port1.close();
        channel?.port2.close();
        channel = null;
        return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
      }
      return new Promise((resolve) => {
        pendingResolve = resolve;
        try {
          channel!.port1.onmessage = () => {
            const finish = pendingResolve;
            pendingResolve = null;
            finish?.();
          };
          channel!.port2.postMessage(null);
        } catch {
          pendingResolve = null;
          channel?.port1.close();
          channel?.port2.close();
          channel = null;
          globalThis.setTimeout(resolve, 0);
        }
      });
    },
    dispose() {
      disposed = true;
      const finish = pendingResolve;
      pendingResolve = null;
      channel?.port1.close();
      channel?.port2.close();
      channel = null;
      finish?.();
    },
  };
}

/**
 * 判断文件是否应参与同步：跳过配置目录、wetongbu 内部目录、以 . 开头的隐藏文件。
 * rootFolder 模式下额外要求文件位于 rootFolder 下。
 */
export function shouldSyncPath(rawPath: string, rootFolder?: string): boolean {
  const normalized = normalizeVaultPath(rawPath);
  if (!normalized) return false;
  // root_folder 模式：仅同步 rootFolder 之下。
  if (rootFolder) {
    const root = rootFolder.replace(/\/+$/, "");
    if (normalized !== root && !normalized.startsWith(`${root}/`)) return false;
  }
  // Crash-recovery scratch files must never become durable Vault entries. The
  // writer removes them on success, but a process can stop between write and
  // cleanup; filtering here keeps them out of the remote manifest as well.
  const basename = normalized.split("/").at(-1) ?? "";
  if (/\.wetongbu-(?:update|complete)-[^/]+\.(?:tmp|bak)$/i.test(basename)) return false;
  return true;
}

function isWithinRootFolder(rawPath: string, rootFolder?: string): boolean {
  if (!rootFolder) return true;
  const root = normalizeVaultPath(rootFolder);
  if (!root) return true;
  const normalized = normalizeVaultPath(rawPath);
  if (normalized) return normalized === root || normalized.startsWith(`${root}/`);
  const raw = rawPath.replace(/\\/g, "/").normalize("NFC").replace(/^\/+/, "");
  return raw === root || raw.startsWith(`${root}/`);
}

/**
 * 扫描 vault 内所有文件，构造本地索引。
 * 对每个文件读取字节并计算 SHA-256。
 *
 * @param app Obsidian App（用于 vault.getFiles、adapter.read）
 * @param rootFolder 可选根目录限制
 * @param onProgress 可选进度回调（已扫描数）
 */
export async function scanLocalFiles(
  app: App,
  rootFolder: string | undefined,
  onProgress?: (scanned: number, total: number) => void,
  hashCache?: LocalFileHashCache,
  options: { maxFileBytes?: number; yieldEveryHashes?: number; yieldToEventLoop?: () => Promise<void> } = {},
): Promise<ScanResult> {
  const maxFileBytes = options.maxFileBytes;
  if (maxFileBytes !== undefined && (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 0)) {
    throw new Error("本地扫描文件尺寸上限无效");
  }
  const yieldEveryHashes = options.yieldEveryHashes ?? 0;
  if (!Number.isSafeInteger(yieldEveryHashes) || yieldEveryHashes < 0) {
    throw new Error("本地扫描让出间隔无效");
  }
  const index: LocalIndex = new Map();
  const unreadablePaths: string[] = [];
  const oversizedPaths: string[] = [];
  const pathsByComparisonKey = new Map<string, { normalized: string; raw: string }>();
  const pathCollisions = new Map<string, Set<string>>();
  const files = app.vault.getFiles();
  const invalidPaths = files
    .filter((file) => !isIntentionalSkip(file.path)
      && isWithinRootFolder(file.path, rootFolder)
      && !shouldSyncPath(file.path, rootFolder))
    .map((file) => file.path);
  const candidates = files.filter((f) => shouldSyncPath(f.path, rootFolder));
  hashCache?.prepare(candidates.map((file) => ({ path: file.path, byteSize: file.stat.size, mtimeMs: file.stat.mtime })));
  const total = candidates.length;
  let scanned = 0;
  let hashesComputed = 0;
  let hashesSinceYield = 0;
  let cacheHits = 0;
  let auditRehashes = 0;
  const scannedPaths: string[] = [];
  const eventLoopYielder = yieldEveryHashes > 0 && !options.yieldToEventLoop
    ? createEventLoopYielder()
    : undefined;
  try {
    for (const file of candidates) {
      const normalized = normalizeVaultPath(file.path);
      const comparisonKey = portableVaultPathComparisonKey(file.path);
      if (!normalized || !comparisonKey) {
        scanned += 1;
        continue;
      }
      const previousPath = pathsByComparisonKey.get(comparisonKey);
      if (previousPath && previousPath.raw !== file.path) {
        const group = pathCollisions.get(comparisonKey) ?? new Set<string>([previousPath.raw]);
        group.add(file.path);
        pathCollisions.set(comparisonKey, group);
        index.delete(previousPath.normalized);
        scanned += 1;
        continue;
      }
      pathsByComparisonKey.set(comparisonKey, { normalized, raw: file.path });
      scannedPaths.push(file.path);
      if (maxFileBytes !== undefined && (!Number.isSafeInteger(file.stat?.size) || file.stat.size < 0)) {
        unreadablePaths.push(file.path);
        scanned += 1;
        continue;
      }
      if (maxFileBytes !== undefined && file.stat.size > maxFileBytes) {
        oversizedPaths.push(file.path);
        scanned += 1;
        continue;
      }
      try {
        const cached = hashCache?.get(file.path, file.stat.size, file.stat.mtime) ?? null;
        let hash: string;
        let byteSize: number;
        if (cached) {
          hash = cached.hash;
          byteSize = file.stat.size;
          cacheHits += 1;
        } else {
          if (hashCache?.isAuditPath(file.path)) auditRehashes += 1;
          const body = await app.vault.readBinary(file);
          if (maxFileBytes !== undefined && body.byteLength > maxFileBytes) {
            oversizedPaths.push(file.path);
            scanned += 1;
            continue;
          }
          hash = await sha256Hex(new Uint8Array(body));
          byteSize = body.byteLength;
          hashesComputed += 1;
          hashesSinceYield += 1;
          hashCache?.set(file.path, hash, body.byteLength, file.stat.mtime);
        }
        if (hashCache && !hashCache.isCurrent(file.path)) {
          unreadablePaths.push(file.path);
          scanned += 1;
          continue;
        }
        index.set(normalized, {
          path: normalized,
          contentHash: hash,
          byteSize,
          mtimeMs: file.stat.mtime,
        });
        if (!cached && yieldEveryHashes > 0 && hashesSinceYield >= yieldEveryHashes) {
          hashesSinceYield = 0;
          await (options.yieldToEventLoop?.() ?? eventLoopYielder?.yield());
        }
      } catch {
        // 读失败不是删除：把路径交给编排器作为安全阀，下一轮重试。
        unreadablePaths.push(file.path);
      }
      scanned += 1;
      if (onProgress && scanned % 50 === 0) onProgress(scanned, total);
    }
  } finally {
    eventLoopYielder?.dispose();
  }
  if (onProgress) onProgress(total, total);
  if (hashCache) await hashCache.finish(scannedPaths, rootFolder === undefined).catch(() => {});
  return {
    index,
    unreadablePaths,
    oversizedPaths,
    pathCollisions: [...pathCollisions.values()].map((paths) => [...paths].sort()),
    invalidPaths,
    hashesComputed,
    cacheHits,
    auditRehashes,
  };
}

function isIntentionalSkip(rawPath: string): boolean {
  const path = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (VAULT_SYNC_SKIP_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return true;
  const basename = path.split("/").at(-1) ?? "";
  return /\.wetongbu-(?:update|complete)-[^/]+\.(?:tmp|bak)$/i.test(basename);
}

/** prevSync JSON 结构。 */
export interface PrevSyncState {
  version: 1;
  deviceId: string;
  lastCursor: number;
  lastSyncAt: string;
  files: Record<string, {
    contentHash: string | null;
    byteSize: number;
    mtimeMs: number;
    revision?: number;
    isDeleted?: boolean;
  }>;
  /** 冲突副本索引，供恢复/审计使用；不把正文复制进状态文件。 */
  conflicts?: Record<string, {
    originalPath: string;
    createdAt: string;
    localHash: string | null;
    remoteHash: string | null;
    status: "pending" | "resolved";
  }>;
}

/** prevSync 存储抽象：默认实现写 .wetongbu/vault-sync-state.json。 */
export interface PrevSyncStore {
  load(): Promise<PrevSyncState | null>;
  save(state: PrevSyncState): Promise<void>;
  clear(): Promise<void>;
}

const STATE_PATH = ".wetongbu/vault-sync-state.json";
const STATE_RECOVERY_PATH = `${STATE_PATH}.recovery`;

type StoredStateRead =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unreadable" }
  | { status: "valid"; raw: string; state: PrevSyncState };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/** Reject malformed state instead of letting it manufacture deletes/uploads. */
export function isValidPrevSyncState(value: unknown): value is PrevSyncState {
  if (!isRecord(value) || value.version !== 1 || typeof value.deviceId !== "string"
    || typeof value.lastSyncAt !== "string" || !isNonNegativeInteger(value.lastCursor)
    || !isRecord(value.files)) return false;
  const portablePaths = new Set<string>();
  for (const [rawPath, rawInfo] of Object.entries(value.files)) {
    const path = normalizeVaultPath(rawPath);
    if (!path || path !== rawPath || !portableVaultPathKey(path) || portablePaths.has(portableVaultPathKey(path)!)) return false;
    portablePaths.add(portableVaultPathKey(path)!);
    if (!isRecord(rawInfo) || (rawInfo.contentHash !== null && !SHA256_PATTERN.test(String(rawInfo.contentHash)))
      || !isNonNegativeInteger(rawInfo.byteSize) || !isNonNegativeInteger(rawInfo.mtimeMs)
      || (rawInfo.revision !== undefined && !isNonNegativeInteger(rawInfo.revision))
      || (rawInfo.isDeleted !== undefined && typeof rawInfo.isDeleted !== "boolean")) return false;
  }
  if (value.conflicts !== undefined) {
    if (!isRecord(value.conflicts)) return false;
    for (const [rawPath, rawConflict] of Object.entries(value.conflicts)) {
      if (!normalizeVaultPath(rawPath) || !isRecord(rawConflict)
        || !normalizeVaultPath(rawConflict.originalPath as string)
        || typeof rawConflict.createdAt !== "string"
        || (rawConflict.localHash !== null && !SHA256_PATTERN.test(String(rawConflict.localHash)))
        || (rawConflict.remoteHash !== null && !SHA256_PATTERN.test(String(rawConflict.remoteHash)))
        || !["pending", "resolved"].includes(String(rawConflict.status))) return false;
    }
  }
  return true;
}

export function createPrevSyncStore(app: App): PrevSyncStore {
  const adapter = app.vault.adapter as any;

  async function readStoredState(path: string): Promise<StoredStateRead> {
    let exists: boolean;
    try {
      exists = await adapter.exists(path);
    } catch {
      return { status: "unreadable" };
    }
    if (!exists) return { status: "missing" };
    let raw: string;
    try { raw = await adapter.read(path); }
    catch { return { status: "unreadable" }; }
    const state = parseValidState(raw);
    return state ? { status: "valid", raw, state } : { status: "invalid" };
  }

  function parseValidState(raw: string): PrevSyncState | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isValidPrevSyncState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function removeRecoveryCopy() {
    if (await adapter.exists(STATE_RECOVERY_PATH)) {
      await adapter.remove(STATE_RECOVERY_PATH);
      if (await adapter.exists(STATE_RECOVERY_PATH)) {
        throw new Error("Vault 同步状态恢复副本清理校验失败");
      }
    }
  }

  return {
    async load() {
      const current = await readStoredState(STATE_PATH);
      if (current.status === "valid") {
        // A valid current state proves that any remaining recovery copy is a
        // stale artifact from a save that completed before cleanup.
        await removeRecoveryCopy().catch(() => {});
        return current.state;
      }

      const recovery = await readStoredState(STATE_RECOVERY_PATH);
      if (recovery.status === "missing" && current.status === "missing") return null;
      if (recovery.status !== "valid") {
        throw new Error("Vault 同步状态损坏或不可读且没有可用恢复副本；已暂停同步");
      }

      try {
        await adapter.write(STATE_PATH, recovery.raw);
        if (await adapter.read(STATE_PATH) !== recovery.raw) {
          throw new Error("Vault 同步状态恢复校验失败");
        }
        await removeRecoveryCopy();
        return recovery.state;
      } catch {
        // A missing/torn baseline must never be treated as an empty first sync
        // while a known-good recovery copy exists but cannot be restored.
        throw new Error("Vault 同步状态损坏且恢复副本暂时无法恢复；已暂停同步");
      }
    },
    async save(state) {
      // 确保 .wetongbu/ 目录存在。
      if (!(await app.vault.adapter.exists(".wetongbu"))) {
        await app.vault.adapter.mkdir(".wetongbu");
      }
      // Stage and verify the next state before replacing the current file.
      const temporary = `${STATE_PATH}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      try {
        await app.vault.adapter.write(temporary, serialized);
        if ((await app.vault.adapter.read(temporary)) !== serialized) throw new Error("Vault 同步状态写入校验失败");
      } catch (error) {
        await app.vault.adapter.remove(temporary).catch(() => {});
        throw error;
      }
      let hadPrevious = false;
      let previous: string | null = null;
      try {
        hadPrevious = typeof adapter.exists === "function" && await adapter.exists(STATE_PATH);
        previous = hadPrevious ? await adapter.read(STATE_PATH) : null;
      } catch (error) {
        await adapter.remove(temporary).catch(() => {});
        throw error;
      }
      if (hadPrevious && previous !== null && parseValidState(previous) === null) {
        await adapter.remove(temporary).catch(() => {});
        throw new Error("Vault 同步状态已损坏，拒绝覆盖并暂停同步");
      }
      let recoveryReady = false;
      let replacementStarted = false;
      try {
        if (hadPrevious && previous !== null) {
          const existingRecovery = await adapter.exists(STATE_RECOVERY_PATH);
          if (existingRecovery) {
            const existingRecoveryContents = await adapter.read(STATE_RECOVERY_PATH).catch(() => null);
            if (existingRecoveryContents !== previous) {
              await removeRecoveryCopy();
            }
          }
          if (!(await adapter.exists(STATE_RECOVERY_PATH))) {
            await adapter.write(STATE_RECOVERY_PATH, previous);
          }
          if (await adapter.read(STATE_RECOVERY_PATH) !== previous) {
            throw new Error("Vault 同步状态恢复副本写入校验失败");
          }
          recoveryReady = parseValidState(previous) !== null;
        }
        if (!hadPrevious && typeof adapter.rename === "function") {
          replacementStarted = true;
          try {
            await adapter.rename(temporary, STATE_PATH);
            if (await adapter.read(STATE_PATH) === serialized) return;
          } catch {
            // Some adapters report an error after moving the file. Accept it
            // only when the destination contains the complete staged value.
          }
          if (await adapter.read(STATE_PATH).catch(() => "") === serialized) return;
        }
        // Obsidian's local adapter does not rename over an existing path.
        // Keep the previous state in memory and verify any in-place replacement.
        replacementStarted = true;
        await adapter.write(STATE_PATH, serialized);
        let valid = false;
        try {
          valid = (await adapter.read(STATE_PATH)) === serialized;
        } catch { /* handled below */ }
        if (!valid) {
          throw new Error("Vault 同步状态替换校验失败");
        }
        if (hadPrevious) await removeRecoveryCopy().catch(() => {});
      } catch (error) {
        if (!replacementStarted) {
          if (recoveryReady) await removeRecoveryCopy().catch(() => {});
          throw error;
        }
        if (hadPrevious && previous !== null) {
          let restored = false;
          try {
            await adapter.write(STATE_PATH, previous);
            restored = (await adapter.read(STATE_PATH)) === previous;
          } catch { /* Keep the verified recovery copy for the next load. */ }
          if (restored) await removeRecoveryCopy().catch(() => {});
          else {
            if (recoveryReady) {
              throw new Error("Vault 同步状态替换失败；旧状态已保存在恢复副本中，下次同步会先尝试恢复");
            }
            throw new Error("Vault 同步状态替换失败且旧状态回滚未通过校验；已暂停同步");
          }
        } else if (typeof adapter.remove === "function") {
          await adapter.remove(STATE_PATH).catch(() => {});
        }
        throw error;
      } finally {
        if (typeof adapter.remove === "function") await adapter.remove(temporary).catch(() => {});
      }
    },
    async clear() {
      await removeRecoveryCopy();
      const exists = await adapter.exists(STATE_PATH);
      if (exists) await adapter.remove(STATE_PATH);
    },
  };
}

/** 把 PrevSyncState 转成 diff 用的 Map。 */
export function prevSyncAsMap(state: PrevSyncState | null): Map<string, FileEntity> {
  const map = new Map();
  if (!state) return map;
  for (const [p, info] of Object.entries(state.files)) {
    const normalized = normalizeVaultPath(p);
    if (!normalized) continue;
    map.set(normalized, {
      path: normalized,
      contentHash: info.contentHash,
      byteSize: info.byteSize,
      mtimeMs: info.mtimeMs,
      revision: info.revision,
      isDeleted: info.isDeleted,
    });
  }
  return map;
}

/** 为下次同步写出新的 prevSync：用当前已知的文件状态更新。 */
export function advancePrevSync(
  prev: PrevSyncState | null,
  deviceId: string,
  updates: Iterable<{ path: string; contentHash: string | null; byteSize: number; mtimeMs: number; revision?: number; isDeleted?: boolean }>,
  cursor: number,
  conflictUpdates: Iterable<{ path: string; originalPath: string; createdAt: string; localHash: string | null; remoteHash: string | null }> = [],
): PrevSyncState {
  const files = prev ? { ...prev.files } : {};
  const conflicts = { ...(prev?.conflicts ?? {}) };
  for (const u of updates) {
    const n = normalizeVaultPath(u.path);
    if (!n) continue;
    files[n] = {
      contentHash: u.contentHash,
      byteSize: u.byteSize,
      mtimeMs: u.mtimeMs,
      revision: u.revision,
      isDeleted: u.isDeleted,
    };
  }
  for (const conflict of conflictUpdates) {
    const n = normalizeVaultPath(conflict.path);
    const originalPath = normalizeVaultPath(conflict.originalPath);
    if (!n || !originalPath) continue;
    conflicts[n] = {
      originalPath,
      createdAt: conflict.createdAt,
      localHash: conflict.localHash,
      remoteHash: conflict.remoteHash,
      status: "pending",
    };
  }
  return {
    version: 1,
    deviceId,
    lastCursor: cursor,
    lastSyncAt: new Date().toISOString(),
    files,
    ...(Object.keys(conflicts).length > 0 ? { conflicts } : {}),
  };
}

// 对外暴露 VAULT_SYNC_SKIP_PREFIXES 便于 UI 显示说明。
export { VAULT_SYNC_SKIP_PREFIXES };
