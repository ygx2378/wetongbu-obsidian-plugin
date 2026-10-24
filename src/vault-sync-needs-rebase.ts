import type { VaultSyncV2BaselineEntry } from "./vault-sync-v2-baseline.ts";
import type { VaultSyncNeedsRebaseReason, VaultSyncOutboxOperation, VaultSyncOutboxSnapshot } from "./vault-sync-outbox.ts";

export interface VaultSyncNeedsRebaseViewItem {
  operationId: string;
  fileId: string;
  action: string;
  reason: string;
  location: string;
}

const ACTION_LABELS: Record<string, string> = {
  create: "新增",
  update: "修改",
  delete: "删除",
  restore: "恢复",
  rename: "改名",
};

const REASON_LABELS: Record<VaultSyncNeedsRebaseReason, string> = {
  local_file_missing: "本机文件已不存在",
  local_content_mismatch: "本机内容与待办记录不一致",
  baseline_unavailable: "本机缺少有效基线",
  operation_receipt_expired: "云端操作回执已过期",
  prepared_content_mismatch: "准备上传的内容校验不一致",
  operation_path_unavailable: "无法从本机基线定位文件",
  operation_recovery_unresolved: "恢复后仍需核对云端提交结果",
  delete_review_context_changed: "确认期间账号、同步目标或范围已变化；需重新检查删除",
  snapshot_rebuilt: "重建同步快照时保留的旧请求",
  unknown: "原因未记录（旧版本或未分类记录）",
};

/** Build a content-free, read-only summary of retained operations that need a fresh baseline. */
export function summarizeVaultSyncNeedsRebase(
  snapshot: VaultSyncOutboxSnapshot,
  baselineEntries: VaultSyncV2BaselineEntry[],
): VaultSyncNeedsRebaseViewItem[] {
  const pathsByFileId = new Map(baselineEntries.map((entry) => [entry.fileId, entry.path]));
  return snapshot.operations
    .filter((operation) => operation.state === "needs_rebase")
    .map((operation) => summarizeOperation(operation, pathsByFileId));
}

function summarizeOperation(
  operation: VaultSyncOutboxOperation,
  pathsByFileId: Map<string, string>,
): VaultSyncNeedsRebaseViewItem {
  const request = operation.request.operation;
  const type = typeof request.type === "string" ? request.type : "unknown";
  let location = "";
  if (type === "rename" && typeof request.basePath === "string" && typeof request.path === "string") {
    location = `请求改名：${request.basePath} → ${request.path}`;
  } else if ((type === "create" || type === "restore") && typeof request.path === "string") {
    location = `请求路径：${request.path}`;
  } else {
    const baselinePath = pathsByFileId.get(operation.fileId);
    if (baselinePath) location = `最近本机基线路径：${baselinePath}`;
  }
  if (!location) location = `文件 ID：${operation.fileId.slice(0, 8)}…`;

  return {
    operationId: operation.operationId,
    fileId: operation.fileId,
    action: ACTION_LABELS[type] ?? "未知操作",
    reason: REASON_LABELS[operation.needsRebaseReason ?? "unknown"],
    location,
  };
}
