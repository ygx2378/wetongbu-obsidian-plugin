// Vault 多端同步：编排器。
// 串联 local 扫描、远端 manifest、三方 diff、存储读写。
// 设计为可注入依赖（app、storage、remote、store），便于单测。
//
// 同步流程（每次 runOnce）：
//   1. 读 prevSync
//   2. 扫描本地 vault → local index
//   3. 拉远端 manifest（since=prevSync.lastCursor）→ remote index
//   4. 三方 diff → plan
//   5. 安全阀：按插件设置的比例（默认 > 50%）中止
//   6. 执行：
//      a. 本地新增/修改 → 上传到 storage + commit 到服务端
//      b. 远端新增/修改 → 从 storage 下载 + 写入 vault
//      c. 本地删除 → storage delete + commit tombstone
//      d. 远端删除 → vault trash
//      e. 冲突 → 本地改名（冲突副本）+ 重新上传
//   7. 推进 prevSync
//
// 前向保证：每个文件成功后立即更新内存中的 prevSync；整体成功后一次持久化。
// 中断时已成功文件不会重做（下次同步会看到 prevSync 已记录）。

import type { App } from "obsidian";
import { VAULT_SYNC_DECISION } from "./shared/vault-sync-protocol.mjs";
import {
  type FileEntity, type PlannedOp, type DiffPlan,
  planSync, shouldAbortForSafety, shouldAbortForBootstrap, conflictCopyName, safetyPlanFingerprint,
} from "./vault-sync-diff.ts";
import {
  type LocalIndex, type PrevSyncState, type PrevSyncStore,
  scanLocalFiles, prevSyncAsMap, advancePrevSync,
} from "./vault-sync-local.ts";
import type { VaultSyncStorage } from "./vault-sync-storage";
import { sha256Hex as computeHash } from "./shared/hash.ts";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import type { VaultSyncRemoteClient, ManifestItem } from "./vault-sync-remote";

function manifestAsMap(items: ManifestItem[]): Map<string, FileEntity> {
  const map = new Map<string, FileEntity>();
  for (const item of items) {
    const path = normalizeVaultPath(item.path);
    if (!path) continue;
    map.set(path, {
      path,
      contentHash: item.contentHash,
      byteSize: item.byteSize,
      mtimeMs: item.mtimeMs,
      revision: item.revision,
      isDeleted: item.isDeleted,
    });
  }
  return map;
}

export interface VaultSyncOrchestratorDeps {
  app: App;
  storage: VaultSyncStorage;
  remote: VaultSyncRemoteClient;
  store: PrevSyncStore;
  deviceId: string;
  /** 同步范围根目录（undefined = 整个 vault）。 */
  rootFolder?: string | undefined;
  /** 首次双侧都有内容时的明确方向；未提供则安全暂停等待用户选择。 */
  bootstrapDirection?: "remote" | "local";
  /** 是否在 UI 弹 Notice。后台静默同步传 false。 */
  notify?: (msg: string) => void;
  /** 大比例变更保护；默认启用并使用 50%。 */
  safetyEnabled?: boolean;
  safetyRatio?: number;
  /** 仅允许与该 fingerprint 完全一致的一次计划执行。 */
  safetyOverrideFingerprint?: string;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  failed: number;
  failureMessages?: string[];
  aborted?: boolean;
  needsBootstrapDecision?: boolean;
  safetyBlocked?: boolean;
  safetyChangeCount?: number;
  safetyTotalCount?: number;
  safetyRatio?: number;
  safetyCounts?: DiffPlan["counts"];
  safetyPlanFingerprint?: string;
  /** 冲突文件的本地副本路径（供 UI 提示）。 */
  conflictPaths?: string[];
}

// Keep the orchestrator importable in a headless test and on mobile. The
// plugin UI injects an Obsidian Notice callback for interactive runs.
const DEFAULT_NOTIFY = (_msg: string) => {};

export function createVaultSyncOrchestrator(deps: VaultSyncOrchestratorDeps) {
  const { app, storage, remote, store, deviceId } = deps;
  const rootFolder = deps.rootFolder;
  const bootstrapDirection = deps.bootstrapDirection;
  const notify = deps.notify ?? DEFAULT_NOTIFY;

  async function runOnce(): Promise<SyncResult> {
    const result: SyncResult = {
      uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, failed: 0,
    };

    // 1. 读 prevSync
    const prev = await store.load();
    const prevMap = prevSyncAsMap(prev);

    // 2. 扫描本地
    const scan = await scanLocalFiles(app, rootFolder);
    const localIndex = scan.index;
    if (scan.unreadablePaths.length > 0) {
      notify(`Vault 同步暂停：有 ${scan.unreadablePaths.length} 个文件暂时无法读取，未传播删除`);
      return { ...result, aborted: true };
    }

    // 3. 拉远端 manifest（增量）
    const since = prev?.lastCursor ?? 0;
    const manifestPages: ManifestItem[] = [];
    let manifestCursor = since;
    let manifestMaxRevision = since;
    for (;;) {
      const page = await remote.getManifest(manifestCursor);
      manifestPages.push(...page.items);
      const nextCursor = Number(page.nextCursor ?? page.maxRevision ?? manifestCursor);
      manifestMaxRevision = Math.max(manifestMaxRevision, nextCursor);
      if (!page.hasMore) break;
      if (nextCursor <= manifestCursor) throw new Error("远端 manifest 游标未前进");
      manifestCursor = nextCursor;
    }
    const manifest = { items: manifestPages, maxRevision: manifestMaxRevision, scope: "" };
    // 增量合并：把 manifest 的新条目覆盖到 prevMap 派生的"已知远端"上。
    // 但更准确的做法是：diff 用 (local, remote增量后的全量, prev)。
    // 由于 server manifest 只返回 since 后变更，我们用一个保守策略：
    // 首次同步（prev 为空）→ 全量比较；后续 → batch-get 校验本地仍存在的文件。
    let remoteMap: Map<string, FileEntity>;
    if (!prev || since === 0) {
      remoteMap = manifestAsMap(manifest.items);
    } else {
      // 增量：先从 prev 派生"已知远端"，再用 manifest 覆盖最新状态。
      remoteMap = new Map();
      for (const [p, ent] of prevMap) {
        remoteMap.set(p, { ...ent, revision: ent.revision ?? 0 });
      }
      for (const item of manifest.items) {
        const n = item.path;
        remoteMap.set(n, {
          path: n, contentHash: item.contentHash, byteSize: item.byteSize,
          mtimeMs: item.mtimeMs, revision: item.revision, isDeleted: item.isDeleted,
        });
      }
    }

    // A first run that failed before committing any file can leave an empty
    // state file behind. Treat that state as no baseline; otherwise the safety
    // guard would classify every local note as a mass change and block the
    // retry forever.
    const isBootstrap = !prev || (prev.lastCursor === 0 && Object.keys(prev.files).length === 0);

    // 4. diff。首次双侧都有内容时，用用户明确选择的一侧作为基线：
    // remote 表示把电脑端内容下载到本机，local 表示把本机内容上传到远端。
    const bootstrapBaseline = isBootstrap && bootstrapDirection === "remote"
      ? localIndex
      : isBootstrap && bootstrapDirection === "local"
        ? remoteMap
        : prevMap;
    const plan = planSync(localIndex, remoteMap, bootstrapBaseline);

    // 5. 安全阀。首次同步只有一侧有内容时可安全建立基线；两侧同时
    // 有内容而没有 prevSync 时，无法判断覆盖方向，必须先让用户确认。
    const oneSidedBootstrap = isBootstrap && (localIndex.size === 0 || remoteMap.size === 0);
    if (isBootstrap && shouldAbortForBootstrap(localIndex.size, remoteMap.size, plan)
      && !bootstrapDirection) {
      notify("首次同步发现本机和电脑端都有内容，请在设置中选择“从电脑同步到本机”或“从本机上传到电脑”后重试。\n选择会决定首次同步方向，不会自动覆盖内容。");
      return { ...result, aborted: true, needsBootstrapDecision: true };
    }
    const safetyRatio = deps.safetyRatio ?? 0.5;
    const safetyFingerprint = safetyPlanFingerprint(plan);
    const safetyBypassed = deps.safetyOverrideFingerprint === safetyFingerprint;
    if (!isBootstrap && !oneSidedBootstrap && deps.safetyEnabled !== false
      && !safetyBypassed && shouldAbortForSafety(plan, safetyRatio)) {
      return {
        ...result,
        aborted: true,
        safetyBlocked: true,
        safetyChangeCount: plan.modifyCount,
        safetyTotalCount: plan.totalCount,
        safetyRatio,
        safetyCounts: plan.counts,
        safetyPlanFingerprint: safetyFingerprint,
      };
    }

    const conflictPaths: string[] = [];
    let hadFailures = false;
    const prevUpdates: Array<{ path: string; contentHash: string | null; byteSize: number; mtimeMs: number; revision?: number; isDeleted?: boolean }> = [];

    // 6. 执行：按决策分派。顺序：先冲突副本（避免覆盖），再上传/下载/删除。
    const sorted = [...plan.ops].sort((a, b) => priority(a.decision) - priority(b.decision));

    for (const op of sorted) {
      try {
        const applied = await apply(op);
        if (applied.prevUpdate) prevUpdates.push(applied.prevUpdate);
        if (applied.counts.uploaded) result.uploaded += applied.counts.uploaded;
        if (applied.counts.downloaded) result.downloaded += applied.counts.downloaded;
        if (applied.counts.deletedLocal) result.deletedLocal += applied.counts.deletedLocal;
        if (applied.counts.deletedRemote) result.deletedRemote += applied.counts.deletedRemote;
        if (applied.counts.conflicts) result.conflicts += applied.counts.conflicts;
        if (applied.conflictPath) conflictPaths.push(applied.conflictPath);
      } catch (error) {
        // 单文件失败不阻塞整体；该文件下次同步会重试（prevSync 未推进）。
        hadFailures = true;
        result.failed += 1;
        const rawMessage = error instanceof Error ? error.message : String(error);
        const safeMessage = rawMessage
          .replace(/https?:\/\/[^\s)]+/gi, "[url]")
          .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
          .slice(0, 160);
        result.failureMessages ??= [];
        if (result.failureMessages.length < 3 && !result.failureMessages.includes(safeMessage)) {
          result.failureMessages.push(safeMessage || "未知错误");
        }
        console.error("vault sync operation failed", { code: error instanceof Error ? error.name : "unknown" });
      }
    }

    // 7. 推进 prevSync
    const cursor = hadFailures ? (prev?.lastCursor ?? 0) : Math.max(manifest.maxRevision, prev?.lastCursor ?? 0);
    const nextState = advancePrevSync(prev, deviceId, prevUpdates, cursor);
    await store.save(nextState);

    result.conflictPaths = conflictPaths;
    return result;
  }

  function priority(decision: string): number {
    // 冲突先处理（改名后才上传），其他无强顺序。
    if (decision === VAULT_SYNC_DECISION.CONFLICT) return 0;
    return 1;
  }

  async function apply(op: PlannedOp): Promise<{
    counts: Partial<SyncResult>;
    prevUpdate?: { path: string; contentHash: string | null; byteSize: number; mtimeMs: number; revision?: number; isDeleted?: boolean };
    conflictPath?: string;
  }> {
    const { decision, path } = op;
    const empty = { counts: {} };

    if (decision === VAULT_SYNC_DECISION.EQUAL) {
      return empty;
    }

    if (decision === VAULT_SYNC_DECISION.LOCAL_CREATED || decision === VAULT_SYNC_DECISION.LOCAL_MODIFIED) {
      // 上传本地 → storage（按 hash 寻址）+ commit。
      const local = op.local!;
      const body = await app.vault.readBinary(fileByPath(app, path));
      const bytes = new Uint8Array(body);
      const hash = await computeHash(bytes);
      await storage.put(hash, bytes);
      const resp = await remote.commit([{
        path, contentHash: hash, byteSize: bytes.byteLength, mtimeMs: local.mtimeMs,
        expectedRevision: op.prev?.revision,
      }]);
      const r = resp.results[0];
      if (r.status === "conflict") {
        // commit 被判冲突（别的设备刚写了）：走冲突副本路径。
        return await applyConflict(op);
      }
      return {
        counts: { uploaded: 1 },
        prevUpdate: { path, contentHash: hash, byteSize: body.byteLength, mtimeMs: local.mtimeMs, revision: r.revision, isDeleted: false },
      };
    }

    if (decision === VAULT_SYNC_DECISION.REMOTE_CREATED || decision === VAULT_SYNC_DECISION.REMOTE_MODIFIED) {
      // 从 storage 下载（按 hash 寻址）→ 写入 vault。
      const remoteEnt = op.remote!;
      if (!remoteEnt.contentHash) throw new Error(`远端条目缺 contentHash：${path}`);
      const body = await storage.get(remoteEnt.contentHash);
      await writeVaultFile(app, path, body);
      return {
        counts: { downloaded: 1 },
        prevUpdate: { path, contentHash: remoteEnt.contentHash, byteSize: body.byteLength, mtimeMs: remoteEnt.mtimeMs, revision: remoteEnt.revision, isDeleted: false },
      };
    }

    if (decision === VAULT_SYNC_DECISION.LOCAL_DELETED_PROPAGATE) {
      // 本地已删 → 远端 tombstone。内容寻址存储的 block 不直接删（由服务端 GC），
      // 这里只清理本地可能残留的旧 hash 副本（Free 场景，hash 从 prev 取）。
      if (op.prev?.contentHash) {
        try { await storage.delete(op.prev.contentHash); } catch { /* 删除幂等，忽略 NotFound */ }
      }
      const resp = await remote.commit([{ path, byteSize: 0, mtimeMs: Date.now(), isDeleted: true, expectedRevision: op.prev?.revision }]);
      const r = resp.results[0];
      return {
        counts: { deletedRemote: 1 },
        prevUpdate: r.status === "committed" ? { path, contentHash: null, byteSize: 0, mtimeMs: Date.now(), revision: r.revision, isDeleted: true } : undefined,
      };
    }

    if (decision === VAULT_SYNC_DECISION.REMOTE_DELETED_PROPAGATE) {
      // 远端已删 → 本地 trash。
      await trashVaultFile(app, path);
      return {
        counts: { deletedLocal: 1 },
        prevUpdate: { path, contentHash: null, byteSize: 0, mtimeMs: Date.now(), revision: op.remote?.revision, isDeleted: true },
      };
    }

    if (decision === VAULT_SYNC_DECISION.CONFLICT) {
      return await applyConflict(op);
    }

    return empty;
  }

  async function applyConflict(op: PlannedOp): Promise<{
    counts: Partial<SyncResult>;
    prevUpdate?: { path: string; contentHash: string | null; byteSize: number; mtimeMs: number; revision?: number; isDeleted?: boolean };
    conflictPath?: string;
  }> {
    // 双方都改：本地版本改名为冲突副本并上传，远端版本下载覆盖本地原路径。
    const local = op.local;
    const remoteEnt = op.remote;
    const conflictPath = conflictCopyName(op.path);
    if (local) {
      const localBody = await app.vault.readBinary(fileByPath(app, op.path));
      const localBytes = new Uint8Array(localBody);
      const localHash = await computeHash(localBytes);
      // 上传冲突副本到 storage（按 hash 寻址，新 path 指向同 hash）+ commit 为新文件。
      await storage.put(localHash, localBytes);
      await remote.commit([{
        path: conflictPath, contentHash: localHash, byteSize: localBytes.byteLength, mtimeMs: local.mtimeMs,
      }]);
    }
    if (remoteEnt) {
      if (!remoteEnt.contentHash) throw new Error(`冲突的远端条目缺 contentHash：${op.path}`);
      const body = await storage.get(remoteEnt.contentHash);
      // 把远端版本写到原路径（覆盖本地旧内容）。为安全：先把本地原文件改名成冲突副本，
      // 再写远端版本到原路径。Obsidian 的 vault.rename 实现原子改名。
      if (local) {
        await renameVaultFile(app, op.path, conflictPath);
      }
      await writeVaultFile(app, op.path, body);
    }
    return {
      counts: { conflicts: 1 },
      conflictPath,
      // 冲突路径的 prevSync 不推进，让用户手动处理；原路径以远端为准。
      prevUpdate: remoteEnt ? {
        path: op.path, contentHash: remoteEnt.contentHash, byteSize: remoteEnt.byteSize,
        mtimeMs: remoteEnt.mtimeMs, revision: remoteEnt.revision, isDeleted: false,
      } : undefined,
    };
  }

  return { runOnce };
}

// ---- Obsidian Vault 操作辅助 ----

function fileByPath(app: App, path: string) {
  const file = app.vault.getAbstractFileByPath(path);
  if (!file) throw new Error(`vault file not found: ${path}`);
  return file as any;
}

async function writeVaultFile(app: App, path: string, body: Uint8Array) {
  // writeBinary 需要 ArrayBuffer；Uint8Array 的 buffer 可能是更大 ArrayBuffer 的视图，
  // 用 slice 切出精确范围。
  const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) {
    await app.vault.adapter.writeBinary(path, arrayBuffer);
  } else {
    // 确保父目录存在。
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      const dir = path.slice(0, slash);
      if (!app.vault.getAbstractFileByPath(dir)) {
        await app.vault.createFolder(dir);
      }
    }
    await app.vault.create(path, "");
    await app.vault.adapter.writeBinary(path, arrayBuffer);
  }
}

async function trashVaultFile(app: App, path: string) {
  const file = app.vault.getAbstractFileByPath(path);
  if (file) {
    await app.fileManager.trashFile(file as any);
  }
}

async function renameVaultFile(app: App, oldPath: string, newPath: string) {
  const file = app.vault.getAbstractFileByPath(oldPath);
  if (!file) return;
  const slash = newPath.lastIndexOf("/");
  if (slash > 0) {
    const dir = newPath.slice(0, slash);
    if (!app.vault.getAbstractFileByPath(dir)) {
      await app.vault.createFolder(dir);
    }
  }
  await app.vault.rename(file as any, newPath);
}
