export interface VaultSyncRetrySchedulerOptions {
  run: () => void | Promise<void>;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (timerId: number) => void;
  now?: () => number;
  random?: () => number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  wakeDelayMs?: number;
  jitterRatio?: number;
}

export function isVaultSyncActiveEditorBusyError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "v2_apply_active_editor_busy"
    || code === "vault_sync_active_editor_busy"
    || code === "vault_write_active_editor_busy"
    || code === "inbox_keep_local_editor_busy"
    || code === "outbox_create_conflict_editor_busy";
}

export function isRetryableVaultSyncError(error: unknown) {
  if (isVaultSyncActiveEditorBusyError(error)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "vault_sync_disabled") return false;
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status) : 0;
  return code === "block_reclamation_in_progress" || code === "retryable_storage_error"
    || code === "initialization_lease_at_risk" || code === "initialization_lease_lost"
    || code === "initialization_lease_replaced" || code === "initialization_lease_renewal_unavailable"
    || status === 408 || status === 425 || status === 429 || status >= 500
    || /(?:tls|network|offline|failed to fetch|request failed|timed?\s*out|timeout|econn|enotfound|temporar|请求过于频繁|网络|连接[^，。]*失败|http\s+(?:408|425|429|5\d\d))/i.test(message);
}

/** Active-editor protection waits for a workspace change instead of a timer retry. */
export function shouldScheduleVaultSyncFailureRetry(error: unknown, automaticRetryEnabled: boolean): boolean {
  return automaticRetryEnabled
    && !isVaultSyncActiveEditorBusyError(error)
    && isRetryableVaultSyncError(error);
}

/** Parse the HTTP Retry-After value (delta seconds or HTTP date). */
export function parseVaultSyncRetryAfter(value: unknown, nowMs = Date.now()): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds * 1000)) : null;
  }
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : null;
}

/** Read retry guidance from an Obsidian requestUrl response without retaining its body. */
export function getVaultSyncRetryAfterFromResponse(response: unknown, nowMs = Date.now()): number | null {
  if (typeof response !== "object" || response === null) return null;
  const value = response as {
    headers?: Record<string, unknown>;
    json?: Record<string, unknown>;
  };
  let headerValue: unknown;
  for (const [name, candidate] of Object.entries(value.headers ?? {})) {
    if (name.toLowerCase() === "retry-after") {
      headerValue = candidate;
      break;
    }
  }
  const values = [
    parseVaultSyncRetryAfter(headerValue, nowMs),
    parseVaultSyncRetryAfter(value.json?.retryAfterSeconds, 0),
    parseVaultSyncRetryAfter(value.json?.retry_after, 0),
  ].filter((candidate): candidate is number => candidate !== null);
  return values.length ? Math.max(...values) : null;
}

export function getVaultSyncRetryAfterFromError(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const value = error as { retryAfterMs?: unknown; retryAfterSeconds?: unknown };
  const delays = [
    typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs)
      ? Math.max(0, value.retryAfterMs) : null,
    typeof value.retryAfterSeconds === "number" && Number.isFinite(value.retryAfterSeconds)
      ? Math.max(0, Math.ceil(value.retryAfterSeconds * 1000)) : null,
  ].filter((candidate): candidate is number => candidate !== null);
  return delays.length ? Math.max(...delays) : null;
}

export function getVaultSyncFailureNotice(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "protocol_upgrade_required") {
    return "此 Vault 的服务端策略要求新版同步协议，当前微同步 Obsidian 插件无法安全读取或写入。请更新 Obsidian 插件后再运行同步；本机文件不会因此错误被覆盖。";
  }
  return null;
}

export function createVaultSyncRetryScheduler(options: VaultSyncRetrySchedulerOptions) {
  const setTimer = options.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timerId) => window.clearTimeout(timerId));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 15 * 60_000;
  const wakeDelayMs = options.wakeDelayMs ?? 1_000;
  const jitterRatio = Math.min(0.5, Math.max(0, options.jitterRatio ?? 0.2));
  let timerId: number | null = null;
  let dueAt = 0;
  let consecutiveFailures = 0;
  let retryAfterNotBefore = 0;

  function scheduleAt(nextDueAt: number, respectRetryAfter = false) {
    const boundedDueAt = Math.max(now(), nextDueAt);
    if (timerId !== null && dueAt <= boundedDueAt
      && (!respectRetryAfter || dueAt >= retryAfterNotBefore)) return;
    if (timerId !== null) clearTimer(timerId);
    dueAt = boundedDueAt;
    const arm = () => {
      const remainingMs = Math.max(0, dueAt - now());
      // Browser timers have a signed 32-bit delay ceiling. Re-arm long waits
      // without ever running before the server's Retry-After deadline.
      const delayMs = Math.min(remainingMs, 2_147_000_000);
      timerId = setTimer(() => {
        if (now() < dueAt) {
          arm();
          return;
        }
        timerId = null;
        dueAt = 0;
        void Promise.resolve().then(options.run).catch((error) => {
          if (isRetryableVaultSyncError(error)) scheduleRetry(error);
        });
      }, delayMs);
    };
    arm();
  }

  function scheduleRetry(error?: unknown) {
    const retryAfterMs = getVaultSyncRetryAfterFromError(error);
    if (retryAfterMs !== null) retryAfterNotBefore = Math.max(retryAfterNotBefore, now() + retryAfterMs);

    if (timerId === null) consecutiveFailures += 1;
    const exponent = Math.min(30, Math.max(0, consecutiveFailures - 1));
    const unjittered = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** exponent));
    const jitterFactor = 1 - jitterRatio + (2 * jitterRatio * Math.min(1, Math.max(0, random())));
    const delayMs = Math.min(maxRetryDelayMs, Math.round(unjittered * jitterFactor));
    scheduleAt(Math.max(now() + delayMs, retryAfterNotBefore), true);
  }

  return {
    scheduleRetry,
    wake() {
      if (timerId !== null) scheduleAt(Math.max(now() + wakeDelayMs, retryAfterNotBefore), true);
    },
    clear() {
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
      dueAt = 0;
      consecutiveFailures = 0;
      retryAfterNotBefore = 0;
    },
    hasPendingRetry() {
      return timerId !== null;
    },
  };
}
