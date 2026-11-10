// One status for the status bar and the sync center header. The order of the
// checks is the product rule: something the user must decide outranks
// progress, and progress outranks the last result.

export type SyncCenterTone = "idle" | "ok" | "busy" | "attention" | "paused" | "error";

export interface SyncCenterStatusInput {
  loggedIn: boolean;
  canVaultSync: boolean;
  enabled: boolean;
  syncing: boolean;
  paused: boolean;
  offline: boolean;
  conflicts: number;
  pendingDeletions: number;
  lastOutcome: "complete" | "incomplete" | "failed" | "paused" | "read_only" | null;
  lastFinishedAt: number | null;
}

export interface SyncCenterStatus {
  tone: SyncCenterTone;
  label: string;
  detail: string;
  attentionCount: number;
}

export function syncCenterAttentionCount(input: Pick<SyncCenterStatusInput, "conflicts" | "pendingDeletions">) {
  return Math.max(0, input.conflicts) + Math.max(0, input.pendingDeletions);
}

export function formatSyncAge(finishedAt: number | null, now = Date.now()) {
  if (finishedAt === null) return "";
  const seconds = Math.max(0, Math.round((now - finishedAt) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function summarizeSyncCenterStatus(input: SyncCenterStatusInput, now = Date.now()): SyncCenterStatus {
  const attentionCount = syncCenterAttentionCount(input);
  if (!input.loggedIn) {
    return { tone: "idle", label: "未登录", detail: "登录 Plus 账号后，可在所有设备同步同一个 Vault。", attentionCount: 0 };
  }
  if (!input.canVaultSync) {
    return { tone: "idle", label: "未开通同步", detail: "多端同步是 Plus 功能；剪藏不受影响。", attentionCount: 0 };
  }
  if (!input.enabled) {
    return { tone: "idle", label: "同步已关闭", detail: "打开多端同步后，这台设备会和云端保持一致。", attentionCount: 0 };
  }
  if (attentionCount > 0) {
    return { tone: "attention", label: `需要你处理 ${attentionCount} 项`, detail: "其余文件照常同步。", attentionCount };
  }
  if (input.syncing) {
    return { tone: "busy", label: "正在同步…", detail: "可以继续编辑，改动会在下一轮带上。", attentionCount };
  }
  if (input.paused || input.lastOutcome === "paused") {
    return { tone: "paused", label: "同步已暂停", detail: "恢复后会自动补齐这段时间的改动。", attentionCount };
  }
  if (input.offline) {
    return { tone: "paused", label: "离线", detail: "改动已保存在本机，联网后自动同步。", attentionCount };
  }
  if (input.lastOutcome === "failed") {
    return { tone: "error", label: "同步未完成", detail: "会自动重试；也可以点“立即同步”。", attentionCount };
  }
  if (input.lastOutcome === "read_only") {
    return { tone: "paused", label: "云端只读", detail: "订阅已到期：可以下载云端内容，暂不能上传新改动。", attentionCount };
  }
  const age = formatSyncAge(input.lastFinishedAt, now);
  if (input.lastOutcome === "incomplete") {
    return { tone: "busy", label: "还有改动待同步", detail: age ? `上次同步 ${age}，稍后自动继续。` : "稍后自动继续。", attentionCount };
  }
  if (input.lastOutcome === "complete") {
    return { tone: "ok", label: "已同步", detail: age ? `上次同步 ${age}` : "", attentionCount };
  }
  return { tone: "busy", label: "等待首次同步", detail: "第一次同步完成后，这里会显示最新状态。", attentionCount };
}

export function trashDaysLeft(expiresAt: string, now = Date.now()) {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
