/** Serialize Vault sync rounds and large object work that share the same memory budget. */
export function createVaultSyncObjectWorkGate() {
  let active = false;
  const waiters: Array<{ wake?: () => void }> = [];
  const wakeNext = () => waiters[0]?.wake?.();
  const execute = async <T>(task: () => Promise<T>): Promise<{ started: true; value: T }> => {
    active = true;
    try {
      return { started: true, value: await task() };
    } finally {
      active = false;
      wakeNext();
    }
  };
  const run = async <T>(task: () => Promise<T>): Promise<{ started: true; value: T } | { started: false }> => {
    // Preserve an already queued sync round's FIFO turn. Large object work
    // remains fail-fast and must not repeatedly overtake the queue.
    if (active || waiters.length > 0) return { started: false };
    return execute(task);
  };

  return {
    get active() { return active; },
    get queuedCount() { return waiters.length; },
    run,
    async runQueued<T>(task: () => Promise<T>): Promise<{ started: true; value: T }> {
      const waiter: { wake?: () => void } = {};
      waiters.push(waiter);
      while (waiters[0] !== waiter || active) {
        await new Promise<void>((resolve) => { waiter.wake = resolve; });
        waiter.wake = undefined;
      }
      waiters.shift();
      // Claim the gate synchronously before yielding so no fail-fast task can
      // steal the slot between dequeue and execution.
      return execute(task);
    },
  };
}
