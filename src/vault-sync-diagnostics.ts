import type { VaultSyncEventIssue } from "./vault-sync-v2-events.ts";

export type VaultSyncDiagnosticOutcome = "complete" | "incomplete" | "failed" | "paused" | "read_only";
export type VaultSyncDiagnosticProtocol = "v1" | "v2";
export type VaultSyncDiagnosticConnectionStatus = "stopped" | "offline" | "connecting" | "connected" | "polling";
export type VaultSyncDiagnosticStage =
  | "device_auth"
  | "remote_status"
  | "encryption_setup"
  | "capability_read"
  | "local_prepare"
  | "pull"
  | "push"
  | "finalize"
  | "legacy_sync";
export type VaultSyncPushCasAutoMergePhase = "attempt_started" | "retry_queued" | "retry_committed";

export interface VaultSyncDiagnosticWorkSummary {
  scanEntryCount?: number;
  scanIssueCount?: number;
  /** Push operations with a confirmed cloud commit receipt in the latest round. */
  pushCommittedCount?: number;
  pushRenamedCount?: number;
  pushDeletedCount?: number;
  pushConflictCount?: number;
  pushFailedCount?: number;
  pushNeedsRebaseCount?: number;
  pushSkippedForBudgetCount?: number;
  pendingDeletionReviewCount?: number;
  outboxReadable?: boolean;
  outboxSnapshotPresent?: boolean;
  outboxQueuedCount?: number;
  outboxPreparingCount?: number;
  outboxUploadedCount?: number;
  outboxCommittingCount?: number;
  outboxConfirmedCount?: number;
  outboxConflictCount?: number;
  outboxNeedsRebaseCount?: number;
  inboxReceivedCount?: number;
  inboxNeedsResolutionCount?: number;
}

const diagnosticStages = new Set<VaultSyncDiagnosticStage>([
  "device_auth", "remote_status", "encryption_setup", "capability_read", "local_prepare",
  "pull", "push", "finalize", "legacy_sync",
]);

const workCountFields = [
  "scanEntryCount", "scanIssueCount", "pushCommittedCount", "pushRenamedCount", "pushDeletedCount",
  "pushConflictCount", "pushFailedCount", "pushNeedsRebaseCount", "pushSkippedForBudgetCount",
  "pendingDeletionReviewCount", "outboxQueuedCount", "outboxPreparingCount", "outboxUploadedCount",
  "outboxCommittingCount", "outboxConfirmedCount", "outboxConflictCount", "outboxNeedsRebaseCount", "inboxReceivedCount",
  "inboxNeedsResolutionCount",
] as const satisfies readonly (keyof VaultSyncDiagnosticWorkSummary)[];

function sanitizeWorkSummary(value: VaultSyncDiagnosticWorkSummary | undefined): VaultSyncDiagnosticWorkSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const result: VaultSyncDiagnosticWorkSummary = {};
  for (const field of workCountFields) {
    const count = input[field];
    if (Number.isSafeInteger(count) && (count as number) >= 0) result[field] = count as number;
  }
  for (const field of ["outboxReadable", "outboxSnapshotPresent"] as const) {
    if (typeof input[field] === "boolean") result[field] = input[field];
  }
  return Object.keys(result).length ? result : undefined;
}

export interface VaultSyncDiagnosticSample {
  durationMs: number;
  outcome: VaultSyncDiagnosticOutcome;
  protocol: VaultSyncDiagnosticProtocol;
  pullMs?: number;
  pushMs?: number;
  queueWaitMs?: number;
  activeQueueWaitMs?: number;
  failureCode?: string;
  stage?: VaultSyncDiagnosticStage;
  work?: VaultSyncDiagnosticWorkSummary;
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

/** Process-local timings only: no paths, content, identifiers, or network reporting. */
export function createVaultSyncDiagnostics(maxSamples = 100) {
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 1000) {
    throw new Error("Vault sync diagnostic sample limit is invalid");
  }
  const samples: VaultSyncDiagnosticSample[] = [];
  const appliedLatencySamples: number[] = [];
  let connectionStatus: VaultSyncDiagnosticConnectionStatus = "stopped";
  let successfulReconnectCount = 0;
  let pushCasAutoMergeAttemptCount = 0;
  let pushCasAutoMergeRetryQueuedCount = 0;
  let pushCasAutoMergeRetryCommittedCount = 0;
  let lastEventIssue: VaultSyncEventIssue | null = null;

  return {
    record(input: VaultSyncDiagnosticSample) {
      if (!Number.isFinite(input.durationMs) || input.durationMs < 0
        || (input.pullMs !== undefined && (!Number.isFinite(input.pullMs) || input.pullMs < 0))
        || (input.pushMs !== undefined && (!Number.isFinite(input.pushMs) || input.pushMs < 0))
        || (input.queueWaitMs !== undefined && (!Number.isFinite(input.queueWaitMs) || input.queueWaitMs < 0))
        || (input.activeQueueWaitMs !== undefined && (!Number.isFinite(input.activeQueueWaitMs) || input.activeQueueWaitMs < 0))) return;
      const failureCode = typeof input.failureCode === "string" && /^[a-z0-9_]{1,64}$/i.test(input.failureCode)
        ? input.failureCode
        : undefined;
      const stage = diagnosticStages.has(input.stage as VaultSyncDiagnosticStage) ? input.stage : undefined;
      const work = sanitizeWorkSummary(input.work);
      samples.push({
        durationMs: Math.round(input.durationMs), outcome: input.outcome, protocol: input.protocol,
        ...(input.pullMs === undefined ? {} : { pullMs: Math.round(input.pullMs) }),
        ...(input.pushMs === undefined ? {} : { pushMs: Math.round(input.pushMs) }),
        ...(input.queueWaitMs === undefined ? {} : { queueWaitMs: Math.round(input.queueWaitMs) }),
        ...(input.activeQueueWaitMs === undefined ? {} : { activeQueueWaitMs: Math.round(input.activeQueueWaitMs) }),
        ...(failureCode ? { failureCode } : {}),
        ...(stage ? { stage } : {}),
        ...(work ? { work } : {}),
      });
      if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
    },
    snapshot() {
      const completed = samples.filter((sample) => sample.outcome === "complete");
      const queueWaits = samples.flatMap((sample) => sample.queueWaitMs === undefined ? [] : [sample.queueWaitMs]);
      const activeQueueWaits = samples.flatMap((sample) => sample.activeQueueWaitMs === undefined
        ? [] : [sample.activeQueueWaitMs]);
      return {
        count: samples.length,
        completedCount: completed.length,
        latest: samples.at(-1) ?? null,
        queueWaitSampleCount: queueWaits.length,
        queueWaitP95Ms: percentile(queueWaits, 0.95),
        activeQueueWaitSampleCount: activeQueueWaits.length,
        activeQueueWaitP95Ms: percentile(activeQueueWaits, 0.95),
        connectionStatus,
        successfulReconnectCount,
        pushCasAutoMergeAttemptCount,
        pushCasAutoMergeRetryQueuedCount,
        pushCasAutoMergeRetryCommittedCount,
        lastEventIssue,
        durationP50Ms: percentile(completed.map((sample) => sample.durationMs), 0.5),
        durationP95Ms: percentile(completed.map((sample) => sample.durationMs), 0.95),
        pullP95Ms: percentile(completed.flatMap((sample) => sample.pullMs === undefined ? [] : [sample.pullMs]), 0.95),
        pushP95Ms: percentile(completed.flatMap((sample) => sample.pushMs === undefined ? [] : [sample.pushMs]), 0.95),
        appliedLatencySampleCount: appliedLatencySamples.length,
        appliedLatencyP50Ms: percentile(appliedLatencySamples, 0.5),
        appliedLatencyP95Ms: percentile(appliedLatencySamples, 0.95),
      };
    },
    recordAppliedLatency(durationMs: number) {
      if (!Number.isSafeInteger(durationMs) || durationMs < 0) return;
      appliedLatencySamples.push(durationMs);
      if (appliedLatencySamples.length > maxSamples) appliedLatencySamples.splice(0, appliedLatencySamples.length - maxSamples);
    },
    setConnectionStatus(status: VaultSyncDiagnosticConnectionStatus) { connectionStatus = status; },
    setLastEventIssue(issue: VaultSyncEventIssue) {
      if (issue === "ticket_unauthorized" || issue === "ticket_rate_limited" || issue === "ticket_server_error"
        || issue === "ticket_http_error" || issue === "ticket_response_invalid" || issue === "ticket_session_mismatch"
        || issue === "ticket_transport_error" || issue === "websocket_unavailable"
        || issue === "websocket_open_timeout" || issue === "websocket_ready_timeout"
        || /^websocket_closed_(?:before_open|before_ready|after_ready)_(?:0|[1-4][0-9]{3})$/.test(issue)
        || /^websocket_closed_(?:0|[1-4][0-9]{3})$/.test(issue)) {
        lastEventIssue = issue;
      }
    },
    recordSuccessfulReconnect() {
      successfulReconnectCount = Math.min(Number.MAX_SAFE_INTEGER, successfulReconnectCount + 1);
    },
    recordPushCasAutoMergePhase(phase: VaultSyncPushCasAutoMergePhase) {
      if (phase === "attempt_started") {
        pushCasAutoMergeAttemptCount = Math.min(Number.MAX_SAFE_INTEGER, pushCasAutoMergeAttemptCount + 1);
      } else if (phase === "retry_queued") {
        pushCasAutoMergeRetryQueuedCount = Math.min(Number.MAX_SAFE_INTEGER, pushCasAutoMergeRetryQueuedCount + 1);
      } else if (phase === "retry_committed") {
        pushCasAutoMergeRetryCommittedCount = Math.min(Number.MAX_SAFE_INTEGER, pushCasAutoMergeRetryCommittedCount + 1);
      }
    },
    clear() {
      samples.length = 0;
      appliedLatencySamples.length = 0;
      successfulReconnectCount = 0;
      pushCasAutoMergeAttemptCount = 0;
      pushCasAutoMergeRetryQueuedCount = 0;
      pushCasAutoMergeRetryCommittedCount = 0;
      lastEventIssue = null;
    },
  };
}
