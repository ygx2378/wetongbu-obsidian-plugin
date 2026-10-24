// Snapshot bootstrap runner. Pages are durably staged first; the host applies
// them idempotently, the journal records the new baseline, and only then does
// the device ACK the snapshot cursor on the server.
import type { VaultSyncOutboxStore } from "./vault-sync-outbox.ts";
import type { VaultSyncV2Ack, VaultSyncV2SnapshotApplyLease, VaultSyncV2SnapshotPage, VaultSyncV2SnapshotSummary } from "./vault-sync-v2-remote.ts";
import type { VaultSyncV2SnapshotStageStore } from "./vault-sync-v2-snapshot-store.ts";
import type { VaultSyncV2SnapshotItem } from "./vault-sync-v2-remote.ts";
import { createVaultSyncSnapshotApplyLeaseKeeper } from "./vault-sync-snapshot-apply-lease.ts";

export interface VaultSyncV2SnapshotRemote {
  createV2Snapshot(input: { protocolEpoch: number; sessionGeneration: string; snapshotRequestId?: string }): Promise<VaultSyncV2SnapshotSummary>;
  getV2SnapshotPage(input: { snapshotId: string; afterItem: string; limit: number }): Promise<VaultSyncV2SnapshotPage>;
  renewV2Snapshot(snapshotId: string): Promise<{ snapshotId: string; expiresAt: string }>;
  acquireV2SnapshotApplyLease?(snapshotId: string, input: {
    protocolEpoch: number; scopeVersion: number; sessionGeneration: string;
  }): Promise<VaultSyncV2SnapshotApplyLease>;
  renewV2SnapshotApplyLease?(snapshotId: string, leaseId: string): Promise<Omit<VaultSyncV2SnapshotApplyLease, "reused">>;
  releaseV2SnapshotApplyLease?(snapshotId: string, leaseId: string): Promise<{ snapshotId: string; leaseId: string; released: boolean }>;
  completeV2Snapshot(snapshotId: string, input: {
    protocolEpoch: number; sessionGeneration: string; snapshotCursor: string; itemCount: number; applyLeaseId?: string;
  }): Promise<VaultSyncV2Ack>;
}

export interface VaultSyncV2SnapshotSession {
  protocolEpoch: number;
  sessionGeneration: string;
}

export interface VaultSyncV2SnapshotPumpOptions {
  remote: VaultSyncV2SnapshotRemote;
  journal: Pick<VaultSyncOutboxStore, "installSnapshotBaseline">;
  staging: VaultSyncV2SnapshotStageStore;
  session: VaultSyncV2SnapshotSession;
  applySnapshot(input: {
    snapshot: VaultSyncV2SnapshotSummary;
    items: AsyncGenerator<VaultSyncV2SnapshotItem>;
    assertApplyLease?: () => Promise<void>;
  }): Promise<void>;
  snapshotApplyLeaseEnabled?: boolean;
  now?: () => Date;
  pageLimit?: number;
  maxPagesPerRun?: number;
  renewBeforeMs?: number;
}

function summaryFromPage(page: VaultSyncV2SnapshotPage): VaultSyncV2SnapshotSummary {
  return {
    snapshotId: page.snapshotId, protocolEpoch: page.protocolEpoch,
    snapshotCursor: page.snapshotCursor, scope: page.scope, scopeVersion: page.scopeVersion,
    status: page.status, itemCount: page.itemCount, expiresAt: page.expiresAt, completedAt: page.completedAt,
  };
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function createVaultSyncV2SnapshotPump(options: VaultSyncV2SnapshotPumpOptions) {
  const now = options.now ?? (() => new Date());
  const pageLimit = Math.min(Math.max(1, options.pageLimit ?? 100), 500);
  const maxPages = Math.min(Math.max(1, options.maxPagesPerRun ?? 20), 200);
  const renewBeforeMs = Math.max(0, options.renewBeforeMs ?? 60 * 60 * 1000);

  async function run(retriedSnapshotRebuild = false): Promise<{ status: "building" | "page_budget" | "complete"; pagesFetched: number; snapshotId: string }> {
      if (!Number.isSafeInteger(options.session.protocolEpoch) || options.session.protocolEpoch < 1
        || !/^[1-9][0-9]*$/.test(options.session.sessionGeneration)) {
        throw fail("snapshot_session_invalid", "快照初始化需要当前设备会话");
      }
      let state = await options.staging.load();
      let snapshotRebuildUsed = retriedSnapshotRebuild;
      if (state?.status === "acknowledged") {
        const snapshotId = state.summary.snapshotId;
        await options.staging.clear();
        return { status: "complete", pagesFetched: 0, snapshotId };
      }
      const createSnapshot = async () => {
        let snapshotRequestId = await options.staging.getOrCreateSnapshotRequestId();
        let summary: VaultSyncV2SnapshotSummary;
        try {
          summary = await options.remote.createV2Snapshot({ ...options.session, snapshotRequestId });
        } catch (error: any) {
          if (error?.code !== "snapshot_request_conflict") throw error;
          snapshotRequestId = await options.staging.rotateSnapshotRequestId();
          summary = await options.remote.createV2Snapshot({ ...options.session, snapshotRequestId });
        }
        return options.staging.begin(summary);
      };
      if (state && Date.parse(state.summary.expiresAt) <= now().getTime()) {
        await options.staging.discardExpired(now());
        state = null;
      }
      if (!state || state.status === "acknowledged") {
        if (state?.status === "acknowledged") await options.staging.clear();
        state = await createSnapshot();
      }
      if (state.summary.protocolEpoch !== options.session.protocolEpoch) {
        throw fail("snapshot_epoch_mismatch", "本地快照协议代数与当前设备会话不同");
      }
      if (Date.parse(state.summary.expiresAt) - now().getTime() <= renewBeforeMs) {
        try {
          const renewed = await options.remote.renewV2Snapshot(state.summary.snapshotId);
          if (renewed.snapshotId !== state.summary.snapshotId) throw fail("snapshot_renewal_mismatch", "服务端续期返回了其他快照");
          state = await options.staging.updateSummary({ ...state.summary, expiresAt: renewed.expiresAt });
        } catch (error: any) {
          if (error?.code !== "snapshot_expired" || snapshotRebuildUsed) throw error;
          await options.staging.discardExpired(now(), true);
          state = await createSnapshot();
          snapshotRebuildUsed = true;
        }
      }

      let pagesFetched = 0;
      while (state.status === "collecting" && pagesFetched < maxPages) {
        let page: VaultSyncV2SnapshotPage;
        try {
          page = await options.remote.getV2SnapshotPage({
            snapshotId: state.summary.snapshotId, afterItem: state.nextItem, limit: pageLimit,
          });
        } catch (error: any) {
          if (error?.code !== "snapshot_expired" || snapshotRebuildUsed) throw error;
          await options.staging.discardExpired(now(), true);
          state = await createSnapshot();
          snapshotRebuildUsed = true;
          continue;
        }
        pagesFetched += 1;
        if (page.status === "building") {
          state = await options.staging.updateSummary(summaryFromPage(page));
          return { status: "building", pagesFetched, snapshotId: state.summary.snapshotId };
        }
        state = await options.staging.persistPage(state.nextItem, page);
      }
      if (state.status === "collecting") {
        return { status: "page_budget", pagesFetched, snapshotId: state.summary.snapshotId };
      }

      if (state.status === "ready") state = await options.staging.markApplying();
      let applyLease: VaultSyncV2SnapshotApplyLease | null = null;
      let leaseKeeper: ReturnType<typeof createVaultSyncSnapshotApplyLeaseKeeper> | null = null;
      let applyLeaseReleased = false;
      const releaseApplyLease = async () => {
        if (!applyLease || applyLeaseReleased) return;
        await options.remote.releaseV2SnapshotApplyLease!(applyLease.snapshotId, applyLease.leaseId);
        applyLeaseReleased = true;
      };
      if (options.snapshotApplyLeaseEnabled) {
        if (!options.remote.acquireV2SnapshotApplyLease || !options.remote.renewV2SnapshotApplyLease
          || !options.remote.releaseV2SnapshotApplyLease) {
          throw fail("snapshot_apply_lease_unsupported", "服务端声明了快照应用租约，但客户端接口未实现");
        }
        try {
          applyLease = await options.remote.acquireV2SnapshotApplyLease(state.summary.snapshotId, {
            protocolEpoch: options.session.protocolEpoch,
            scopeVersion: state.summary.scopeVersion,
            sessionGeneration: options.session.sessionGeneration,
          });
        } catch (error: any) {
          if (error?.code !== "snapshot_expired" || snapshotRebuildUsed) throw error;
          await options.staging.discardExpired(now(), true);
          return run(true);
        }
      }
      try {
        if (applyLease && (applyLease.snapshotId !== state.summary.snapshotId
          || applyLease.protocolEpoch !== state.summary.protocolEpoch
          || applyLease.scopeVersion !== state.summary.scopeVersion)) {
          throw fail("snapshot_apply_lease_mismatch", "服务端租约与当前快照身份或范围不匹配");
        }
        if (applyLease) {
          leaseKeeper = createVaultSyncSnapshotApplyLeaseKeeper({
            lease: applyLease,
            renew: () => options.remote.renewV2SnapshotApplyLease!(state!.summary.snapshotId, applyLease!.leaseId),
            now: () => now().getTime(),
          });
        }
        if (state.status === "applying") {
          await leaseKeeper?.assertValid();
          await options.applySnapshot({ snapshot: state.summary, items: options.staging.readItems(),
            assertApplyLease: leaseKeeper ? () => leaseKeeper!.assertValid() : undefined });
          await leaseKeeper?.assertValid();
          await options.journal.installSnapshotBaseline(state.summary.snapshotCursor);
          state = await options.staging.markApplied();
        }
        if (state.status === "applied") {
          const itemCount = Number(state.summary.itemCount);
          if (!Number.isSafeInteger(itemCount) || itemCount < 0) throw fail("snapshot_item_count_invalid", "快照项目总数超出本地安全范围");
          let ack: VaultSyncV2Ack;
          try {
            await leaseKeeper?.assertValid();
            ack = await options.remote.completeV2Snapshot(state.summary.snapshotId, {
              protocolEpoch: options.session.protocolEpoch,
              sessionGeneration: options.session.sessionGeneration,
              snapshotCursor: state.summary.snapshotCursor,
              itemCount,
              ...(applyLease ? { applyLeaseId: applyLease.leaseId } : {}),
            });
          } catch (error: any) {
            const canRebuild = error?.code === "snapshot_replay_boundary_invalid" || error?.code === "snapshot_expired";
            if (!canRebuild || snapshotRebuildUsed) throw error;
            if (applyLease) await releaseApplyLease().catch(() => {});
            leaseKeeper?.stop();
            await options.staging.discardExpired(now(), true);
            return run(true);
          }
          if (!ack || ack.protocolEpoch !== options.session.protocolEpoch
            || ack.sessionGeneration !== options.session.sessionGeneration
            || ack.receivedCursor !== state.summary.snapshotCursor
            || ack.appliedCursor !== state.summary.snapshotCursor) {
            throw fail("snapshot_ack_mismatch", "服务端确认的快照游标与本地基线不一致");
          }
          state = await options.staging.markAcknowledged();
          if (applyLease) {
            await releaseApplyLease();
          }
        }
      } finally {
        leaseKeeper?.stop();
        if (applyLease && !applyLeaseReleased) await releaseApplyLease().catch(() => {});
      }
      await options.staging.clear();
      return { status: "complete", pagesFetched, snapshotId: state.summary.snapshotId };
  }

  return { run: () => run(false) };
}
