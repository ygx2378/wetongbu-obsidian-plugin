import type { VaultSyncV2Initialization } from "./vault-sync-v2-remote.ts";

export interface VaultSyncInitializationLeaseKeeperOptions {
  protocolEpoch: number;
  scope: "whole_vault" | "root_folder";
  scopeVersion: number;
  leaseId: string;
  leaseExpiresAt: string;
  claimInitialization(protocolEpoch: number): Promise<VaultSyncV2Initialization>;
  intervalMs?: number;
  retryMs?: number;
  safetyMarginMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface VaultSyncInitializationLeaseKeeper {
  assertValid(): Promise<void>;
  renewNow(): Promise<void>;
  markCompleted(): void;
  stop(): void;
}

function leaseError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const DEFINITIVE_LEASE_ERRORS = new Set([
  "epoch_mismatch",
  "initialization_lease_invalid",
  "initialization_lease_expired",
  "initialization_lease_lost",
  "initialization_lease_replaced",
  "initialization_required",
  "initialization_scope_changed",
]);

/** Renews an owner lease during a long first sync and fails closed before later writes. */
export function createVaultSyncInitializationLeaseKeeper(
  options: VaultSyncInitializationLeaseKeeperOptions,
): VaultSyncInitializationLeaseKeeper {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 10 * 60_000;
  const retryMs = options.retryMs ?? 60_000;
  const safetyMarginMs = options.safetyMarginMs ?? 2 * 60_000;
  const setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  let expiryMs = Date.parse(options.leaseExpiresAt);
  let timer: unknown = null;
  let renewal: Promise<void> | null = null;
  let transientFailure: unknown = null;
  let definitiveFailure: (Error & { code: string }) | null = null;
  let stopped = false;
  let completed = false;

  if (!Number.isFinite(expiryMs) || expiryMs <= now()) {
    definitiveFailure = leaseError("initialization_lease_invalid", "Vault 首次初始化租约无效或已过期");
  }

  function schedule(delayMs: number) {
    if (stopped || completed || definitiveFailure || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void renewNow();
    }, delayMs);
  }

  function markDefinitive(error: unknown) {
    const code = String((error as any)?.code ?? "");
    if (DEFINITIVE_LEASE_ERRORS.has(code)) {
      definitiveFailure = error as Error & { code: string };
      return;
    }
    transientFailure = error;
  }

  async function renewNow(): Promise<void> {
    if (stopped || completed || definitiveFailure) return;
    if (renewal) return renewal;
    if (timer !== null) clearTimer(timer);
    timer = null;
    const task = (async () => {
      try {
        const claim = await options.claimInitialization(options.protocolEpoch);
        if (stopped || completed) return;
        if (claim.status !== "owner") {
          throw leaseError("initialization_lease_lost", "Vault 首次初始化租约已不属于本设备");
        }
        if (claim.protocolEpoch !== options.protocolEpoch
          || claim.scope !== options.scope
          || claim.scopeVersion !== options.scopeVersion) {
          throw leaseError("initialization_scope_changed", "Vault 同步范围或协议已变化，需要重新建立快照");
        }
        if (claim.leaseId !== options.leaseId || claim.requiresSnapshot) {
          throw leaseError("initialization_lease_replaced", "Vault 首次初始化租约已更换，需要重新建立快照");
        }
        const nextExpiry = Date.parse(claim.leaseExpiresAt);
        if (!Number.isFinite(nextExpiry) || nextExpiry <= now()) {
          throw leaseError("initialization_lease_invalid", "服务端返回的首次初始化租约已过期");
        }
        expiryMs = Math.max(expiryMs, nextExpiry);
        transientFailure = null;
      } catch (error) {
        markDefinitive(error);
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
      if (completed) return;
      if (definitiveFailure) throw definitiveFailure;
      if (now() >= expiryMs - safetyMarginMs) {
        const code = transientFailure ? "initialization_lease_renewal_unavailable" : "initialization_lease_at_risk";
        throw leaseError(code, "无法确认 Vault 首次初始化租约仍有效；已暂停后续云端写入，请重新同步");
      }
    },
    renewNow,
    markCompleted() {
      completed = true;
      this.stop();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
