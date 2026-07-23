export interface VaultSyncRetrySchedulerOptions {
  run: () => void | Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
  now?: () => number;
  retryDelayMs?: number;
  wakeDelayMs?: number;
}

export function isRetryableVaultSyncError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:tls|network|offline|failed to fetch|request failed|timed?\s*out|timeout|econn|enotfound|temporar|请求过于频繁|网络|连接[^，。]*失败|http\s+(?:408|425|429|5\d\d))/i.test(message);
}

export function createVaultSyncRetryScheduler(options: VaultSyncRetrySchedulerOptions) {
  const setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timerId) => window.clearTimeout(timerId));
  const now = options.now ?? (() => Date.now());
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const wakeDelayMs = options.wakeDelayMs ?? 1_000;
  let timerId: number | null = null;
  let dueAt = 0;

  function schedule(delayMs: number) {
    const nextDueAt = now() + Math.max(0, delayMs);
    if (timerId !== null && dueAt <= nextDueAt) return;
    if (timerId !== null) clearTimer(timerId);
    dueAt = nextDueAt;
    timerId = setTimer(() => {
      timerId = null;
      dueAt = 0;
      void options.run();
    }, Math.max(0, delayMs));
  }

  return {
    scheduleRetry() {
      schedule(retryDelayMs);
    },
    wake() {
      if (timerId !== null) schedule(wakeDelayMs);
    },
    clear() {
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
      dueAt = 0;
    },
    hasPendingRetry() {
      return timerId !== null;
    },
  };
}
