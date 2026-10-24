export type VaultSyncV2TransferKind = "note" | "attachment";

type TransferJob<T> = {
  sequence: number;
  kind: VaultSyncV2TransferKind;
  foregroundPriority: boolean;
  memoryCostBytes: number;
  run(signal: AbortSignal): Promise<T> | T;
  resolve(value: T): void;
  reject(error: unknown): void;
  controller: AbortController;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
};

function queueError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Bound concurrent bytes and favor notes while guaranteeing attachment progress. */
export function createVaultSyncV2TransferQueue(options: {
  maxConcurrent: number;
  maxInFlightBytes: number;
  maxNoteBurst?: number;
}) {
  const { maxConcurrent, maxInFlightBytes } = options;
  const maxNoteBurst = options.maxNoteBurst ?? 3;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32
    || !Number.isSafeInteger(maxInFlightBytes) || maxInFlightBytes < 1
    || !Number.isSafeInteger(maxNoteBurst) || maxNoteBurst < 1) {
    throw new Error("Vault transfer queue limits must be positive bounded integers");
  }

  const pending: TransferJob<unknown>[] = [];
  const active = new Set<TransferJob<unknown>>();
  let activeBytes = 0;
  let sequence = 0;
  let consecutiveNotes = 0;
  let closed = false;

  const detachSignal = (job: TransferJob<unknown>) => {
    if (job.externalSignal && job.onExternalAbort) {
      job.externalSignal.removeEventListener("abort", job.onExternalAbort);
    }
  };

  const eligible = (job: TransferJob<unknown>) => activeBytes + job.memoryCostBytes <= maxInFlightBytes;

  const chooseNext = () => {
    const foreground = pending.findIndex((job) => job.kind === "note" && job.foregroundPriority && eligible(job));
    const oldestAttachment = pending.findIndex((job) => job.kind === "attachment");
    if (consecutiveNotes >= maxNoteBurst && oldestAttachment >= 0) {
      // Do not keep admitting notes or smaller attachments that consume the
      // bytes an older attachment needs. Let active work drain until it fits.
      return eligible(pending[oldestAttachment]) ? oldestAttachment : -1;
    }
    if (foreground >= 0) {
      return foreground;
    }
    const eligibleNotes = pending.findIndex((job) => job.kind === "note" && eligible(job));
    if (eligibleNotes >= 0) return eligibleNotes;
    if (oldestAttachment >= 0) {
      return eligible(pending[oldestAttachment]) ? oldestAttachment : -1;
    }
    return -1;
  };

  const drain = () => {
    while (!closed && active.size < maxConcurrent) {
      const index = chooseNext();
      if (index < 0) return;
      const [job] = pending.splice(index, 1);
      if (job.externalSignal?.aborted) {
        detachSignal(job);
        job.reject(queueError("transfer_cancelled", "对象传输已取消"));
        continue;
      }
      active.add(job);
      activeBytes += job.memoryCostBytes;
      consecutiveNotes = job.kind === "note" ? consecutiveNotes + 1 : 0;
      void Promise.resolve().then(() => job.run(job.controller.signal)).then(job.resolve, job.reject).finally(() => {
        active.delete(job);
        activeBytes -= job.memoryCostBytes;
        detachSignal(job);
        drain();
      });
    }
  };

  return {
    schedule<T>(input: {
      kind: VaultSyncV2TransferKind;
      memoryCostBytes: number;
      foregroundPriority?: boolean;
      run(signal: AbortSignal): Promise<T> | T;
      signal?: AbortSignal;
    }): Promise<T> {
      if (closed) return Promise.reject(queueError("transfer_queue_closed", "对象传输队列已关闭"));
      if (!Number.isSafeInteger(input.memoryCostBytes) || input.memoryCostBytes < 1
        || input.memoryCostBytes > maxInFlightBytes) {
        return Promise.reject(queueError("transfer_memory_budget_exceeded", "对象超过当前传输内存预算"));
      }
      if (input.signal?.aborted) return Promise.reject(queueError("transfer_cancelled", "对象传输已取消"));
      return new Promise<T>((resolve, reject) => {
        const job: TransferJob<T> = {
          sequence: ++sequence,
          kind: input.kind,
          foregroundPriority: input.foregroundPriority === true,
          memoryCostBytes: input.memoryCostBytes,
          run: input.run,
          resolve,
          reject,
          controller: new AbortController(),
          externalSignal: input.signal,
        };
        const onAbort = () => {
          job.controller.abort();
          const index = pending.indexOf(job as TransferJob<unknown>);
          if (index >= 0) {
            pending.splice(index, 1);
            detachSignal(job as TransferJob<unknown>);
            reject(queueError("transfer_cancelled", "对象传输已取消"));
            drain();
          }
        };
        if (input.signal) {
          job.onExternalAbort = onAbort;
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
        pending.push(job as TransferJob<unknown>);
        drain();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const job of pending.splice(0)) {
        detachSignal(job);
        job.controller.abort();
        job.reject(queueError("transfer_queue_closed", "对象传输队列已关闭"));
      }
      for (const job of active) job.controller.abort();
    },
    getSnapshot() {
      return {
        activeCount: active.size,
        activeBytes,
        queuedCount: pending.length,
        closed,
      };
    },
  };
}
