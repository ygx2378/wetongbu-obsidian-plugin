export interface VaultSyncSchedulerRunContext {
  /** System-clock elapsed time from the first coalesced event to this run; includes sleep but can reflect clock corrections. */
  queueWaitMs: number;
  /** Monotonic elapsed time in intervals where the scheduler was not paused. */
  activeQueueWaitMs: number;
}

export interface VaultSyncIntervalTimerHost {
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(handle: number): void;
}

/** Own a periodic task that can be paused without losing its configured cadence. */
export function createPausableIntervalScheduler(
  run: () => void | Promise<unknown>,
  intervalMs: number,
  timers: VaultSyncIntervalTimerHost = window,
  onError: (error: unknown) => void = (error) => console.error("Vault sync interval failed", error),
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive safe integer");
  }

  let handle: number | null = null;
  let stopped = false;
  let paused = false;
  let running = false;
  let pending = false;

  function reportFailure(error: unknown) {
    try {
      onError(error);
    } catch (reporterError) {
      try {
        console.error("Vault sync interval error reporter failed", reporterError);
      } catch {
        // Error reporting is best-effort; it must not strand the periodic queue.
      }
    }
  }

  function drainPending() {
    if (!pending || stopped || paused || running) return;
    pending = false;
    runOnce();
  }

  function finishRun(error?: unknown, failed = false) {
    running = false;
    try {
      if (failed) reportFailure(error);
    } finally {
      drainPending();
    }
  }

  function runOnce() {
    if (stopped || paused) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = run();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).then(
          () => finishRun(),
          (error) => finishRun(error, true),
        );
      } else {
        finishRun();
      }
    } catch (error) {
      finishRun(error, true);
    }
  }

  function pause() {
    paused = true;
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  }

  function resume() {
    if (stopped || handle !== null) return;
    paused = false;
    handle = timers.setInterval(runOnce, intervalMs);
    drainPending();
  }

  return {
    pause,
    resume,
    restart() {
      if (stopped) return;
      pause();
      resume();
    },
    stop() {
      stopped = true;
      pending = false;
      pause();
    },
  };
}

/** Coalesce file events without dropping changes that arrive during a sync. */
export function createDebouncedVaultSyncScheduler(
  run: (context: VaultSyncSchedulerRunContext) => Promise<unknown>,
  delayMs = 800,
  maxWaitMs = 5000,
  now: () => number = () => globalThis.performance?.now?.() ?? Date.now(),
  wallNow: () => number = () => Date.now(),
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let running = false;
  let stopped = false;
  let paused = false;
  let pendingWallSinceMs: number | null = null;
  let pendingActiveSinceMs: number | null = null;
  let pendingActiveWaitMs = 0;

  function arm() {
    if (stopped || paused) return;
    if (timer !== null) clearTimeout(timer);
    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      if (maxTimer !== null) clearTimeout(maxTimer);
      timer = null;
      maxTimer = null;
      void drain().catch(() => {});
    };
    timer = setTimeout(flush, delayMs);
    if (maxTimer === null) maxTimer = setTimeout(flush, Math.max(delayMs, maxWaitMs));
  }

  async function drain() {
    if (stopped || paused || !pending || running) return;
    pending = false;
    running = true;
    const startedAtMs = now();
    // Date.now includes time spent in OS sleep on WebKit versions whose
    // performance.now() clock pauses during sleep. Clamp clock corrections
    // rather than recording a negative queue duration.
    const queueWaitMs = pendingWallSinceMs === null ? 0 : Math.max(0, wallNow() - pendingWallSinceMs);
    const activeQueueWaitMs = pendingActiveWaitMs
      + (pendingActiveSinceMs === null ? 0 : Math.max(0, startedAtMs - pendingActiveSinceMs));
    pendingWallSinceMs = null;
    pendingActiveSinceMs = null;
    pendingActiveWaitMs = 0;
    try {
      await run({ queueWaitMs, activeQueueWaitMs });
    } finally {
      running = false;
      if (pending) arm();
    }
  }

  return {
    notify() {
      if (stopped) return;
      if (!pending) {
        pendingWallSinceMs = wallNow();
        pendingActiveWaitMs = 0;
        pendingActiveSinceMs = paused ? null : now();
      }
      pending = true;
      arm();
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      if (pendingActiveSinceMs !== null) {
        pendingActiveWaitMs += Math.max(0, now() - pendingActiveSinceMs);
        pendingActiveSinceMs = null;
      }
      if (timer !== null) clearTimeout(timer);
      if (maxTimer !== null) clearTimeout(maxTimer);
      timer = null;
      maxTimer = null;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      if (pending && pendingActiveSinceMs === null) pendingActiveSinceMs = now();
      if (pending) arm();
    },
    stop() {
      stopped = true;
      pending = false;
      pendingWallSinceMs = null;
      pendingActiveSinceMs = null;
      pendingActiveWaitMs = 0;
      if (timer !== null) clearTimeout(timer);
      if (maxTimer !== null) clearTimeout(maxTimer);
      timer = null;
      maxTimer = null;
    },
  };
}
