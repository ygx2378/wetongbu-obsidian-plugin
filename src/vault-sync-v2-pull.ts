// Coordinates durable v2 bootstrap and REST changes application. WSS events
// can wake this runner but never replace its authenticated REST cursor flow.
import type { VaultSyncOutboxSnapshot, VaultSyncOutboxStore } from "./vault-sync-outbox.ts";
import type { VaultSyncRemoteClient } from "./vault-sync-remote.ts";
import type { VaultSyncV2SnapshotStageStore } from "./vault-sync-v2-snapshot-store.ts";
import { createVaultSyncV2SnapshotPump } from "./vault-sync-v2-snapshot-pump.ts";
import { createVaultSyncV2InboxPump } from "./vault-sync-v2-inbox-pump.ts";
import type { VaultSyncV2ApplyOptions } from "./vault-sync-v2-apply.ts";
import { createVaultSyncV2ApplyEngine } from "./vault-sync-v2-apply.ts";

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export interface VaultSyncV2PullEngineOptions {
  remote: VaultSyncRemoteClient;
  journal: VaultSyncOutboxStore;
  staging: VaultSyncV2SnapshotStageStore;
  apply: VaultSyncV2ApplyOptions;
  snapshotPageLimit?: number;
  changePageLimit?: number;
  maxPagesPerRun?: number;
  snapshotApplyLeaseEnabled?: boolean;
}

export interface VaultSyncV2PullResult {
  status: "complete" | "snapshot_building" | "page_budget" | "blocked";
  pagesReceived: number;
  applied: number;
  blocked: number;
  /** Cloud-authorized tombstones held only because their Markdown editor is open. */
  deferredPaths?: string[];
  snapshot?: { pagesFetched: number; snapshotId: string };
  snapshotState?: VaultSyncOutboxSnapshot;
}

export type VaultSyncV2PullDisposition = "complete" | "continue_snapshot" | "resolve_conflict";

/** Keep a blocked inbox distinct from a snapshot that still needs more pages. */
export function classifyVaultSyncV2PullResult(result: Pick<VaultSyncV2PullResult, "status" | "blocked">): VaultSyncV2PullDisposition {
  if (result.status === "blocked" || result.blocked > 0) return "resolve_conflict";
  if (result.status !== "complete") return "continue_snapshot";
  return "complete";
}

/** Let unrelated local files push after a blocked incremental pull, but never before a required scope snapshot. */
export function canPushIndependentFilesAfterBlockedPull(
  result: Pick<VaultSyncV2PullResult, "status" | "blocked">,
  forceSnapshot: boolean,
): boolean {
  if (forceSnapshot || result.status === "snapshot_building" || result.status === "page_budget") return false;
  return result.status === "blocked" || result.blocked > 0;
}

export function createVaultSyncV2PullEngine(options: VaultSyncV2PullEngineOptions) {
  const apply = createVaultSyncV2ApplyEngine({ ...options.apply, journal: options.journal });

  async function runSnapshot() {
    const session = await options.remote.startV2DeviceSession();
    const pump = createVaultSyncV2SnapshotPump({
      remote: options.remote, journal: options.journal, staging: options.staging,
      session: { protocolEpoch: session.protocolEpoch, sessionGeneration: session.sessionGeneration },
      pageLimit: options.snapshotPageLimit, maxPagesPerRun: options.maxPagesPerRun,
      snapshotApplyLeaseEnabled: options.snapshotApplyLeaseEnabled,
      applySnapshot: async (input) => {
        // Re-check after all snapshot pages are staged. A pending conflict can
        // arrive while the snapshot is being fetched; applying the snapshot
        // first would mutate the Vault before installSnapshotBaseline rejects it.
        const latest = await options.journal.load();
        if (latest?.inbox.some((entry) => entry.state !== "applied")) {
          throw fail("resync_conflict_pending", "存在尚未处理的远端变更；先解决冲突，再应用同步快照");
        }
        if (latest?.operations.some((operation) => operation.state !== "confirmed")) {
          throw fail("snapshot_required_outbox_present", "本机仍有未完成的本地操作，不能应用同步快照；请先完成上传或恢复原设备会话");
        }
        await input.assertApplyLease?.();
        await apply.applySnapshot(input);
      },
    });
    return pump.run();
  }

  async function runOnce(input: { forceSnapshot?: boolean } = {}): Promise<VaultSyncV2PullResult> {
    const before = await options.journal.load();
    const stagedSnapshot = await options.staging.load();
    let snapshotResult: { pagesFetched: number; snapshotId: string } | undefined;
    const mustReconcileScope = input.forceSnapshot === true;
    if (mustReconcileScope && before?.inbox.some((entry) => entry.state !== "applied")) {
      throw fail("scope_reconcile_conflict_pending", "同步范围已变化，但仍有未处理的远端冲突；请先处理冲突，再重建范围快照");
    }
    if (mustReconcileScope && before?.operations.some((operation) => operation.state !== "confirmed")) {
      throw fail("scope_reconcile_outbox_pending", "同步范围已变化，但本机仍有未完成的本地操作；请先完成上传，再重建范围快照");
    }
    if (!before || stagedSnapshot || mustReconcileScope) {
      const result = await runSnapshot();
      const snapshotState = await options.journal.load();
      if (result.status !== "complete") return {
        status: result.status === "building" ? "snapshot_building" : "page_budget",
        pagesReceived: 0, applied: 0, blocked: 0,
        snapshot: { pagesFetched: result.pagesFetched, snapshotId: result.snapshotId }, snapshotState: snapshotState ?? undefined,
      };
      snapshotResult = { pagesFetched: result.pagesFetched, snapshotId: result.snapshotId };
    }

    const inbox = createVaultSyncV2InboxPump(options.remote, options.journal, {
      pageSize: options.changePageLimit,
      maxPagesPerRun: options.maxPagesPerRun,
    });
    let received: Awaited<ReturnType<typeof inbox.runOnce>>;
    try {
      received = await inbox.runOnce();
    } catch (error: any) {
      if (error?.code !== "resync_required") throw error;
      const latest = await options.journal.load();
      if (latest?.inbox.some((entry) => entry.state !== "applied")) {
        throw fail("resync_conflict_pending", "存在尚未处理的远端变更；先解决冲突，再重建同步快照");
      }
      if (latest?.operations.some((operation) => operation.state !== "confirmed")) {
        throw fail("snapshot_required_outbox_present", "本机仍有未完成的本地操作，不能用同步快照重建基线；请先完成上传或恢复原设备会话");
      }
      const result = await runSnapshot();
      const snapshotState = await options.journal.load();
      if (result.status !== "complete") return {
        status: result.status === "building" ? "snapshot_building" : "page_budget",
        pagesReceived: 0, applied: 0, blocked: 0,
        snapshot: { pagesFetched: result.pagesFetched, snapshotId: result.snapshotId }, snapshotState: snapshotState ?? undefined,
      };
      snapshotResult = { pagesFetched: result.pagesFetched, snapshotId: result.snapshotId };
      received = await inbox.runOnce();
    }
    const applied = await apply.applyReceivedInbox();
    const state = await options.journal.load();
    if (!state?.sessionGeneration) throw fail("v2_session_lost", "本地没有当前设备会话，不能确认应用进度");
    // The inbox pump already durably ACKed its last page. Reuse that verified
    // ACK when applying the inbox did not advance either cursor; this is the
    // common idle-poll path and avoids an extra serial network round-trip.
    // Keep the final ACK when apply advances appliedCursor, or when the pump
    // did not fetch/ACK a page (for example while an unresolved conflict waits).
    const pageAckCoversFinalState = received.pagesReceived > 0
      && received.snapshot.identity.protocolEpoch === state.identity.protocolEpoch
      && received.snapshot.sessionGeneration === state.sessionGeneration
      && received.snapshot.receivedCursor === state.receivedCursor
      && received.snapshot.appliedCursor === state.appliedCursor;
    if (!pageAckCoversFinalState) {
      const ack = await options.remote.acknowledgeV2Changes({
        protocolEpoch: state.identity.protocolEpoch,
        sessionGeneration: state.sessionGeneration,
        receivedCursor: state.receivedCursor,
        appliedCursor: state.appliedCursor,
      });
      if (ack.protocolEpoch !== state.identity.protocolEpoch || ack.sessionGeneration !== state.sessionGeneration
        || ack.receivedCursor !== state.receivedCursor || ack.appliedCursor !== state.appliedCursor) {
        throw fail("v2_apply_ack_mismatch", "服务端确认的游标与本地 journal 不一致");
      }
    }
    return {
      status: applied.blocked ? "blocked" : "complete",
      pagesReceived: received.pagesReceived, applied: applied.applied, blocked: applied.blocked,
      ...(applied.deferredPaths?.length ? { deferredPaths: applied.deferredPaths } : {}),
      snapshot: snapshotResult, snapshotState: state,
    };
  }

  return { runOnce };
}
