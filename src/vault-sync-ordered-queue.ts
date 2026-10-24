export interface VaultSyncOrderedQueue {
  readonly pendingCount: number;
  run<T>(work: () => Promise<T> | T): Promise<T>;
  drain(): Promise<void>;
}

/** Runs locally captured Vault events in arrival order without poisoning the
 * queue when one task fails. The caller still receives each task's rejection.
 */
export function createVaultSyncOrderedQueue(): VaultSyncOrderedQueue {
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return {
    get pendingCount() { return pendingCount; },
    run<T>(work: () => Promise<T> | T): Promise<T> {
      pendingCount += 1;
      const result = tail.then(work);
      tail = result.then(
        () => { pendingCount -= 1; },
        () => { pendingCount -= 1; },
      );
      return result;
    },
    drain() { return tail; },
  };
}
