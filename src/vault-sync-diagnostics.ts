import type { VaultSyncEventIssue } from "./vault-sync-v2-events.ts";

export type VaultSyncDiagnosticOutcome = "complete" | "incomplete" | "failed" | "paused" | "read_only";
export type VaultSyncDiagnosticProtocol = "v1" | "v2";
export type VaultSyncDiagnosticConnectionStatus = "stopped" | "offline" | "connecting" | "connected" | "polling";
export type VaultSyncMultipartDiagnosticStage = "initialize" | "part_url" | "part_upload" | "complete" | "finalize";
export type VaultSyncMultipartDiagnosticOutcome = "started" | "succeeded" | "failed";
export interface VaultSyncMultipartTransferDiagnostic {
  stage: VaultSyncMultipartDiagnosticStage;
  outcome: VaultSyncMultipartDiagnosticOutcome;
  httpStatus?: number;
  errorCode?: string;
}
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
  v1UploadedCount?: number;
  v1DownloadedCount?: number;
  v1DeletedLocalCount?: number;
  v1DeletedRemoteCount?: number;
  v1ConflictCount?: number;
  v1FailedCount?: number;
  v1Aborted?: boolean;
  v1NeedsBootstrapDecision?: boolean;
  v1SafetyBlocked?: boolean;
  v1DeletionReviewRequired?: boolean;
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
const multipartDiagnosticStages = new Set<VaultSyncMultipartDiagnosticStage>([
  "initialize", "part_url", "part_upload", "complete", "finalize",
]);
const multipartDiagnosticErrorCodes = new Set([
  "vault_sync_disabled", "vault_sync_unavailable", "vault_sync_not_enabled_on_target",
  "v2_write_unavailable", "v2_write_disabled", "target_not_found", "device_not_found",
  "protocol_upgrade_required", "v2_protocol_not_active", "epoch_mismatch",
  "upload_reservation_invalid", "upload_integrity_mismatch", "multipart_upload_unavailable",
  "multipart_upload_in_progress", "multipart_upload_lease_invalid", "multipart_upload_lease_lost",
  "multipart_operation_lease_invalid", "multipart_upload_invalid", "multipart_parts_invalid",
  "multipart_object_too_large", "storage_switch_in_progress", "storage_access_throttled",
  "storage_access_read_only", "storage_access_suspended", "hosted_storage_unavailable",
  "object_upload_failed",
]);

function sanitizeMultipartTransfer(value: VaultSyncMultipartTransferDiagnostic | undefined): VaultSyncMultipartTransferDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as unknown as Record<string, unknown>;
  if (!multipartDiagnosticStages.has(input.stage as VaultSyncMultipartDiagnosticStage)
    || !["started", "succeeded", "failed"].includes(String(input.outcome))) return undefined;
  return {
    stage: input.stage as VaultSyncMultipartDiagnosticStage,
    outcome: input.outcome as VaultSyncMultipartDiagnosticOutcome,
    ...(Number.isSafeInteger(input.httpStatus) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599
      ? { httpStatus: Number(input.httpStatus) } : {}),
    ...(multipartDiagnosticErrorCodes.has(String(input.errorCode)) ? { errorCode: String(input.errorCode) } : {}),
  };
}

const workCountFields = [
  "v1UploadedCount", "v1DownloadedCount", "v1DeletedLocalCount", "v1DeletedRemoteCount",
  "v1ConflictCount", "v1FailedCount",
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
  for (const field of [
    "v1Aborted", "v1NeedsBootstrapDecision", "v1SafetyBlocked", "v1DeletionReviewRequired",
    "outboxReadable", "outboxSnapshotPresent",
  ] as const) {
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
  multipartTransfer?: VaultSyncMultipartTransferDiagnostic;
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
      const multipartTransfer = sanitizeMultipartTransfer(input.multipartTransfer);
      const work = sanitizeWorkSummary(input.work);
      samples.push({
        durationMs: Math.round(input.durationMs), outcome: input.outcome, protocol: input.protocol,
        ...(input.pullMs === undefined ? {} : { pullMs: Math.round(input.pullMs) }),
        ...(input.pushMs === undefined ? {} : { pushMs: Math.round(input.pushMs) }),
        ...(input.queueWaitMs === undefined ? {} : { queueWaitMs: Math.round(input.queueWaitMs) }),
        ...(input.activeQueueWaitMs === undefined ? {} : { activeQueueWaitMs: Math.round(input.activeQueueWaitMs) }),
        ...(failureCode ? { failureCode } : {}),
        ...(stage ? { stage } : {}),
        ...(multipartTransfer ? { multipartTransfer } : {}),
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
