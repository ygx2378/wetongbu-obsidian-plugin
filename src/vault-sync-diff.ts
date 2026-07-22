// Vault 多端同步：三方比较决策（纯函数）。
// 参考 Remotely Save V3 的决策树，但做了简化：使用 hash + mtimeMs + size
// 三元组判定，比单纯 (mtimeMs, size) 更稳健（Obsidian 写回 mtime 精度不一致）。
// 决策结果供 vault-sync.ts 编排器消费；本模块无副作用，可独立单测。

import { VAULT_SYNC_DECISION } from "./shared/vault-sync-protocol.mjs";

export interface FileEntity {
  /** 相对 vault 根的 POSIX 路径（已 normalizeVaultPath）。 */
  path: string;
  /** 内容 SHA-256（小写 hex）；删除态可为 null。 */
  contentHash: string | null;
  byteSize: number;
  mtimeMs: number;
  /** 服务端 revision（仅 remote 有意义；local/prevSync 用 0 占位）。 */
  revision?: number;
  isDeleted?: boolean;
}

export interface MixedEntry {
  path: string;
  local?: FileEntity;
  remote?: FileEntity;
  prev?: FileEntity;
}

export type Decision = typeof VAULT_SYNC_DECISION[keyof typeof VAULT_SYNC_DECISION];

export interface PlannedOp {
  path: string;
  decision: Decision;
  // 推给编排器使用：上传/下载所需字段。
  local?: FileEntity;
  remote?: FileEntity;
  prev?: FileEntity;
}

function sameContent(a: FileEntity | undefined, b: FileEntity | undefined): boolean {
  if (!a || !b) return false;
  // 优先用 hash（内容寻址最可靠）；hash 缺失时退回 (mtimeMs, size)。
  if (a.contentHash && b.contentHash) return a.contentHash === b.contentHash;
  return a.mtimeMs === b.mtimeMs && a.byteSize === b.byteSize;
}

/**
 * 对单个文件做三方决策。
 *
 * 关键规则（对照 Remotely Save V3 决策表）：
 *  - 三方一致 → EQUAL
 *  - 一侧等于 prev、另一侧变了 → 改变的一侧赢，向另一侧传播
 *  - 双方都改（都不等于 prev）→ CONFLICT（编排器生成冲突副本）
 *  - 一侧缺失 + 另一侧未变 → 缺失是删除，向存在侧传播 tombstone
 *  - 一侧缺失 + 另一侧已改 → 改变侧赢，删除被撤销（不算冲突）
 *  - 一侧缺失 + 无 prev → 视为另一侧新增
 */
export function decideEntry(entry: MixedEntry): PlannedOp {
  const { path, local } = entry;
  // Tombstones are remote/baseline metadata, not present files. Keeping them
  // in the state prevents a deletion from being re-propagated every cycle.
  const remote = entry.remote?.isDeleted ? undefined : entry.remote;
  const prev = entry.prev?.isDeleted ? undefined : entry.prev;
  const base = { path, local, remote: entry.remote, prev: entry.prev };

  // 双侧都没有（只在 prev 里）→ 静默清理 prev，无操作。
  if (!local && !remote) {
    return { ...base, decision: VAULT_SYNC_DECISION.EQUAL };
  }

  // 本地存在、远端缺失。
  if (local && !remote) {
    if (!prev) {
      // 无 prev：本地新增。
      return { ...base, decision: VAULT_SYNC_DECISION.LOCAL_CREATED };
    }
    if (sameContent(local, prev)) {
      // 本地未变、远端被删 → 远端删除传播到本地。
      return { ...base, decision: VAULT_SYNC_DECISION.REMOTE_DELETED_PROPAGATE };
    }
    // 本地改了、远端被删 → 本地修改保留，重新上传（撤销删除）。
    return { ...base, decision: VAULT_SYNC_DECISION.LOCAL_MODIFIED };
  }

  // 远端存在、本地缺失。
  if (remote && !local) {
    if (!prev) {
      return { ...base, decision: VAULT_SYNC_DECISION.REMOTE_CREATED };
    }
    if (sameContent(remote, prev)) {
      // 远端未变、本地被删 → 本地删除传播到远端（tombstone）。
      return { ...base, decision: VAULT_SYNC_DECISION.LOCAL_DELETED_PROPAGATE };
    }
    // 远端改了、本地被删 → 远端修改保留，重新下载（撤销删除）。
    return { ...base, decision: VAULT_SYNC_DECISION.REMOTE_MODIFIED };
  }

  // 双侧都存在。
  if (local && remote) {
    if (sameContent(local, remote)) {
      return { ...base, decision: VAULT_SYNC_DECISION.EQUAL };
    }
    const localChanged = !sameContent(local, prev);
    const remoteChanged = !sameContent(remote, prev);
    if (localChanged && !remoteChanged) {
      return { ...base, decision: VAULT_SYNC_DECISION.LOCAL_MODIFIED };
    }
    if (remoteChanged && !localChanged) {
      return { ...base, decision: VAULT_SYNC_DECISION.REMOTE_MODIFIED };
    }
    if (localChanged && remoteChanged) {
      return { ...base, decision: VAULT_SYNC_DECISION.CONFLICT };
    }
    // 双方都未变但不一致（prev 与两边都不同）→ 视为冲突，让用户介入。
    return { ...base, decision: VAULT_SYNC_DECISION.CONFLICT };
  }

  // 兜底（理论上不会到这里）。
  return { ...base, decision: VAULT_SYNC_DECISION.EQUAL };
}

export interface DiffPlan {
  ops: PlannedOp[];
  /** 统计：按决策分类的计数，便于安全阀判断。 */
  counts: Record<Decision, number>;
  /** 真实改动数（不含 EQUAL）。 */
  modifyCount: number;
  /** 总文件数。 */
  totalCount: number;
}

/**
 * 对整棵文件树批量决策。输入是三张 path → FileEntity 的表。
 */
export function planSync(
  local: Map<string, FileEntity>,
  remote: Map<string, FileEntity>,
  prev: Map<string, FileEntity>,
): DiffPlan {
  const paths = new Set<string>([...local.keys(), ...remote.keys(), ...prev.keys()]);
  const ops: PlannedOp[] = [];
  const counts: Record<Decision, number> = {
    [VAULT_SYNC_DECISION.EQUAL]: 0,
    [VAULT_SYNC_DECISION.LOCAL_CREATED]: 0,
    [VAULT_SYNC_DECISION.LOCAL_MODIFIED]: 0,
    [VAULT_SYNC_DECISION.REMOTE_CREATED]: 0,
    [VAULT_SYNC_DECISION.REMOTE_MODIFIED]: 0,
    [VAULT_SYNC_DECISION.LOCAL_DELETED_PROPAGATE]: 0,
    [VAULT_SYNC_DECISION.REMOTE_DELETED_PROPAGATE]: 0,
    [VAULT_SYNC_DECISION.CONFLICT]: 0,
  };
  for (const path of paths) {
    const op = decideEntry({
      path,
      local: local.get(path),
      remote: remote.get(path),
      prev: prev.get(path),
    });
    ops.push(op);
    counts[op.decision] += 1;
  }
  const totalCount = ops.length;
  const modifyCount = totalCount - counts[VAULT_SYNC_DECISION.EQUAL];
  return { ops, counts, modifyCount, totalCount };
}

/**
 * 安全阀：如果改动比例超过阈值（默认 50%），返回 true 中止同步。
 * 防止远端被误清空导致本地也全删的灾难。对照 Remotely Save 的 protectModifyPercentage。
 */
export function shouldAbortForSafety(
  plan: DiffPlan,
  ratio = 0.5,
): boolean {
  if (plan.totalCount === 0) return false;
  // EQUAL 不算改动；其余都算（含冲突，因为冲突往往伴随本地或远端写入）。
  const changeCount = plan.modifyCount;
  return changeCount / plan.totalCount > ratio;
}

/** First-sync guard: without a baseline, only one-sided content can be
 * auto-seeded. When both sides already contain files, require user review. */
export function shouldAbortForBootstrap(localCount: number, remoteCount: number, plan: DiffPlan): boolean {
  return localCount > 0 && remoteCount > 0 && plan.modifyCount > 0;
}

/**
 * 生成冲突副本文件名：note.md → note.sync-conflict-YYYYMMDD-HHMMSS.md
 * 对照 Remotely Save 的命名风格（带时间戳，便于多设备分辨）。
 */
export function conflictCopyName(originalPath: string, now: Date = new Date()): string {
  const slash = originalPath.lastIndexOf("/");
  const dir = slash >= 0 ? originalPath.slice(0, slash) : "";
  const base = slash >= 0 ? originalPath.slice(slash + 1) : originalPath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const renamed = `${stem}.sync-conflict-${stamp}${ext}`;
  return dir ? `${dir}/${renamed}` : renamed;
}
