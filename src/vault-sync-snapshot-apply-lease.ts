import type { VaultSyncV2SnapshotApplyLease } from "./vault-sync-v2-remote.ts";

export interface VaultSyncSnapshotApplyLeaseKeeperOptions {
  lease: VaultSyncV2SnapshotApplyLease;
  renew(): Promise<Omit<VaultSyncV2SnapshotApplyLease, "reused">>;
  intervalMs?: number;
  retryMs?: number;
  safetyMarginMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface VaultSyncSnapshotApplyLeaseKeeper {
  assertValid(): Promise<void>;
  renewNow(): Promise<void>;
  stop(): void;
}

function leaseError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const DEFINITIVE_LEASE_ERRORS = new Set([
  "epoch_mismatch", "snapshot_expired", "snapshot_not_found",
  "snapshot_apply_lease_expired", "snapshot_apply_lease_lost",
]);

/** Renews the server lease during long local snapshot application and fails closed before later writes. */
export function createVaultSyncSnapshotApplyLeaseKeeper(
  options: VaultSyncSnapshotApplyLeaseKeeperOptions,
): VaultSyncSnapshotApplyLeaseKeeper {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 25_000;
  const retryMs = options.retryMs ?? 5_000;
  const safetyMarginMs = options.safetyMarginMs ?? 12_000;
  const setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  let expiryMs = Date.parse(options.lease.expiresAt);
  let timer: unknown = null;
  let renewal: Promise<void> | null = null;
  let transientFailure: unknown = null;
  let definitiveFailure: (Error & { code: string }) | null = null;
  let stopped = false;

  if (!Number.isFinite(expiryMs) || expiryMs <= now()) {
    definitiveFailure = leaseError("snapshot_apply_lease_expired", "Vault 快照应用租约无效或已过期");
  }

  function schedule(delayMs: number) {
    if (stopped || definitiveFailure || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void renewNow();
    }, delayMs);
  }

  function markFailure(error: unknown) {
    if (DEFINITIVE_LEASE_ERRORS.has(String((error as any)?.code ?? ""))) {
      definitiveFailure = error as Error & { code: string };
    } else {
      transientFailure = error;
    }
  }

  async function renewNow(): Promise<void> {
    if (stopped || definitiveFailure) return;
    if (renewal) return renewal;
    if (timer !== null) clearTimer(timer);
    timer = null;
    const task = (async () => {
      try {
        const renewed = await options.renew();
        if (stopped) return;
        if (renewed.snapshotId !== options.lease.snapshotId || renewed.leaseId !== options.lease.leaseId
          || renewed.protocolEpoch !== options.lease.protocolEpoch || renewed.scopeVersion !== options.lease.scopeVersion) {
          throw leaseError("snapshot_apply_lease_lost", "Vault 快照应用租约身份或范围已变化");
        }
        const nextExpiry = Date.parse(renewed.expiresAt);
        if (!Number.isFinite(nextExpiry) || nextExpiry <= now()) {
          throw leaseError("snapshot_apply_lease_expired", "服务端返回的 Vault 快照应用租约已过期");
        }
        expiryMs = nextExpiry;
        transientFailure = null;
      } catch (error) {
        markFailure(error);
      }
    })();
    renewal = task;
    try {
      await task;
    } finally {
      if (renewal === task) renewal = null;
      schedule(transientFailure ? retryMs : intervalMs);
    }
  }

  schedule(intervalMs);

  return {
    async assertValid() {
      if (definitiveFailure) throw definitiveFailure;
      if (now() >= expiryMs - safetyMarginMs) await renewNow();
      if (definitiveFailure) throw definitiveFailure;
      if (now() >= expiryMs - safetyMarginMs) {
        const code = transientFailure ? "snapshot_apply_lease_renewal_unavailable" : "snapshot_apply_lease_at_risk";
        throw leaseError(code, "无法确认 Vault 快照应用租约仍有效；已暂停后续本机写入");
      }
    },
    renewNow,
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
