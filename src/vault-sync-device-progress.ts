export function formatPendingDeletionDeviceProgress(count: number): string | null {
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  return `本机当前检测到 ${count} 项删除待确认（尚未提交云端）。`;
}

export function formatVaultSyncDeviceCursors(input: {
  receivedCursor: string | null;
  appliedCursor: string | null;
}): string {
  return `已应用游标 ${input.appliedCursor ?? "未知"} / 已接收游标 ${input.receivedCursor ?? "未知"}`;
}
