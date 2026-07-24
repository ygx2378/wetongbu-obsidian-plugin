// Vault 多端同步：删除审核的纯函数。
// 删除是不可逆的跨设备操作，编排器先返回审核计划，只有用户明确选择
// “同步删除”或“恢复”后才执行对应操作。

import { VAULT_SYNC_DECISION } from "./shared/vault-sync-protocol.mjs";
import type { DiffPlan, PlannedOp } from "./vault-sync-diff.ts";

export type DeletionAction = "keep" | "delete" | "restore";

export interface DeletionResolution {
  fingerprint: string;
  decisions: Record<string, DeletionAction>;
}

export interface PendingDeletion {
  path: string;
  decision: typeof VAULT_SYNC_DECISION.LOCAL_DELETED_PROPAGATE | typeof VAULT_SYNC_DECISION.REMOTE_DELETED_PROPAGATE;
  direction: "local_to_remote" | "remote_to_local";
  previousRevision?: number;
  remoteRevision?: number;
}

export function isDeletionDecision(decision: string): decision is PendingDeletion["decision"] {
  return decision === VAULT_SYNC_DECISION.LOCAL_DELETED_PROPAGATE
    || decision === VAULT_SYNC_DECISION.REMOTE_DELETED_PROPAGATE;
}

export function deletionPlanFingerprint(plan: DiffPlan): string {
  return plan.ops
    .filter((op) => isDeletionDecision(op.decision))
    .map((op) => [
      op.path,
      op.decision,
      op.local?.contentHash ?? "",
      op.remote?.contentHash ?? "",
      op.prev?.contentHash ?? "",
      op.local?.mtimeMs ?? "",
      op.remote?.mtimeMs ?? "",
      op.prev?.mtimeMs ?? "",
      op.remote?.revision ?? "",
      op.prev?.revision ?? "",
      op.remote?.isDeleted ? "1" : "0",
      op.prev?.isDeleted ? "1" : "0",
    ].join("\u0000"))
    .sort()
    .join("\n");
}

export function pendingDeletions(plan: DiffPlan): PendingDeletion[] {
  return plan.ops
    .filter((op): op is PlannedOp & { decision: PendingDeletion["decision"] } => isDeletionDecision(op.decision))
    .map((op) => ({
      path: op.path,
      decision: op.decision,
      direction: op.decision === VAULT_SYNC_DECISION.LOCAL_DELETED_PROPAGATE
        ? "local_to_remote"
        : "remote_to_local",
      previousRevision: op.prev?.revision,
      remoteRevision: op.remote?.revision,
    }));
}

export function actionFor(
  op: PlannedOp,
  resolution: DeletionResolution | undefined,
  fingerprint: string,
): DeletionAction {
  if (!resolution || resolution.fingerprint !== fingerprint || !isDeletionDecision(op.decision)) return "keep";
  const action = resolution.decisions[op.path];
  return action === "delete" || action === "restore" ? action : "keep";
}
