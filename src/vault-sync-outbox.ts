// Local v2 outbox snapshots. Records contain protocol metadata and object refs,
// never note bytes or decrypted text. Immutable snapshots avoid replacing the
// last known-good state on adapters whose rename semantics vary by platform.
import type { App, DataAdapter } from "obsidian";
import { isValidVaultSyncInt8Decimal, normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { VaultSyncV2ChangeItem, VaultSyncV2ChangePage } from "./vault-sync-v2-remote.ts";
import { withVaultSyncV2StateWriteLock } from "./vault-sync-v2-locks.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CURSOR = /^(0|[1-9][0-9]*)$/;
const APPLIED_INBOX_HISTORY_LIMIT = 200;

export interface VaultSyncV2Identity {
  apiBaseUrl: string;
  targetId: string;
  deviceId: string;
  protocolEpoch: number;
}

export interface VaultSyncV2Request {
  protocolVersion: 2;
  protocolEpoch: number;
  operationWindowId: string;
  operationId: string;
  fileId: string;
  expectedVersionId: string | null;
  operation: Record<string, unknown>;
}

export type VaultSyncOutboxState = "queued" | "preparing" | "uploaded" | "committing" | "confirmed" | "conflict" | "needs_rebase";
export type VaultSyncNeedsRebaseReason =
  | "local_file_missing"
  | "local_content_mismatch"
  | "baseline_unavailable"
  | "operation_receipt_expired"
  | "prepared_content_mismatch"
  | "operation_path_unavailable"
  | "operation_recovery_unresolved"
  | "snapshot_rebuilt"
  | "unknown";

export interface VaultSyncOutboxOperation {
  operationId: string;
  fileId: string;
  operationDigest: string;
  /** Client-only plaintext hash used to recover a committed operation after a crash. */
  localContentHash: string;
  localByteSize: number;
  localGeneration: number;
  request: VaultSyncV2Request;
  state: VaultSyncOutboxState;
  /** Content-free diagnostic category explaining why this operation was retained for manual rebasing. */
  needsRebaseReason?: VaultSyncNeedsRebaseReason;
  /** Durable path move intent for a user-approved, unassociated create conflict. */
  createResolution?: VaultSyncOutboxCreateResolution;
  /** Inbox event whose remote version the user explicitly chose to supersede with this local update. */
  resolvesInboxCursor?: string;
  /** Number of automatic update-CAS merges already attempted for this durable operation (bounded to one). */
  autoMergeAttempts?: number;
}

export interface VaultSyncOutboxCreateResolution {
  kind: "repath_create";
  sourcePath: string;
  targetPath: string;
  sourceContentHash: string;
  byteSize: number;
  localGeneration: number;
}

export interface VaultSyncInboxEntry {
  cursor: string;
  item: VaultSyncV2ChangeItem;
  state: "received" | "applied" | "needs_resolution";
  /** Durable, content-free recovery metadata for a user-approved remote conflict resolution. */
  resolution?: VaultSyncInboxResolution;
}

export type VaultSyncInboxResolution = {
  kind: "keep_local_on_update";
  sourcePath: string;
  sourceContentHash: string;
  conflictCopyPath: string;
  targetPath: string;
  remoteContentHash: string;
  byteSize: number;
} | {
  kind: "keep_local_on_rename";
  sourcePath: string;
  sourceContentHash: string;
  targetPath: string;
  remoteContentHash: string;
  byteSize: number;
  /** Present when the local side was already renamed before the remote conflict arrived. */
  localMoveIntentId?: string;
} | {
  kind: "keep_local_on_create";
  sourcePath: string;
  sourceContentHash: string;
  conflictCopyPath: string;
  targetPath: string;
  remoteContentHash: string;
  byteSize: number;
} | {
  kind: "keep_local_on_delete";
  sourcePath: string;
  sourceContentHash: string;
  conflictCopyPath: string;
  targetPath: string;
  localByteSize: number;
  /** Present when the local file was already moved away from the cloud path. */
  localMoveIntentId?: string;
};

export interface VaultSyncOutboxSnapshot {
  generation: string;
  identity: VaultSyncV2Identity;
  receivedCursor: string;
  appliedCursor: string;
  sessionGeneration: string | null;
  throughCursor: string | null;
  operations: VaultSyncOutboxOperation[];
  inbox: VaultSyncInboxEntry[];
}

export interface VaultSyncOutboxStore {
  load(): Promise<VaultSyncOutboxSnapshot | null>;
  enqueue(input: Omit<VaultSyncOutboxOperation, "state">): Promise<VaultSyncOutboxOperation>;
  replacePendingOperation(operationId: string, input: Omit<VaultSyncOutboxOperation, "state">): Promise<VaultSyncOutboxOperation>;
  replaceConflictOperation(operationId: string, input: Omit<VaultSyncOutboxOperation, "state">): Promise<VaultSyncOutboxOperation>;
  replaceConflictWithMergedUpdate(operationId: string, input: Omit<VaultSyncOutboxOperation, "state">): Promise<VaultSyncOutboxOperation>;
  resolveDeleteConflict(operationId: string): Promise<VaultSyncOutboxSnapshot>;
  replaceExpiredOperation(operationId: string, input: Omit<VaultSyncOutboxOperation, "state">): Promise<VaultSyncOutboxOperation>;
  beginCreateConflictResolution(operationId: string, resolution: VaultSyncOutboxCreateResolution): Promise<VaultSyncOutboxOperation>;
  transition(operationId: string, state: VaultSyncOutboxState, needsRebaseReason?: VaultSyncNeedsRebaseReason): Promise<VaultSyncOutboxOperation>;
  discardSupersededUpdatesByReviewedDelete(fileId: string, deletedVersionId: string): Promise<VaultSyncOutboxOperation[]>;
  setSessionGeneration(sessionGeneration: string): Promise<VaultSyncOutboxSnapshot>;
  receivePage(page: VaultSyncV2ChangePage): Promise<VaultSyncOutboxSnapshot>;
  markInboxItem(cursor: string, state: "applied" | "needs_resolution"): Promise<VaultSyncOutboxSnapshot>;
  beginInboxConflictResolution(cursor: string, resolution: VaultSyncInboxResolution): Promise<VaultSyncOutboxSnapshot>;
  resolveInboxItem(cursor: string, preservedLocalHash: string): Promise<VaultSyncOutboxSnapshot>;
  setSnapshotBaseline(cursor: string): Promise<VaultSyncOutboxSnapshot>;
  installSnapshotBaseline(cursor: string): Promise<VaultSyncOutboxSnapshot>;
  pruneConfirmed(operationIds: string[]): Promise<VaultSyncOutboxSnapshot>;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",")}}`;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function normalizedIdentity(input: VaultSyncV2Identity): VaultSyncV2Identity {
  let apiBaseUrl: string;
  try {
    const url = new URL(input.apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    url.search = "";
    url.hash = "";
    apiBaseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw fail("outbox_identity_invalid", "同步服务地址无效");
  }
  if (!UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) {
    throw fail("outbox_identity_invalid", "同步 target、设备或协议版本无效");
  }
  return { apiBaseUrl, targetId: input.targetId.toLowerCase(), deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch };
}

function contentRef(value: unknown): boolean {
  return exactKeys(value, ["reservationId", "objectId", "keyVersion", "byteSize", "ciphertextHash"])
    && typeof value.reservationId === "string" && UUID.test(value.reservationId)
    && typeof value.objectId === "string" && UUID.test(value.objectId)
    && Number.isSafeInteger(value.keyVersion) && Number(value.keyVersion) >= 1
    && Number.isSafeInteger(value.byteSize) && Number(value.byteSize) >= 0
    && typeof value.ciphertextHash === "string" && SHA256.test(value.ciphertextHash);
}

function validChangeItem(value: unknown): value is VaultSyncV2ChangeItem {
  if (!exactKeys(value, ["cursor", "operationId", "fileId", "fileVersionId", "eventType", "createdByDeviceId", "path", "previousPath", "previousVersionId", "isDeleted", "byteSize", "mtimeMs", "content"])) return false;
  if (typeof value.cursor !== "string" || !isValidVaultSyncInt8Decimal(value.cursor)
    || typeof value.operationId !== "string" || !UUID.test(value.operationId)
    || typeof value.fileId !== "string" || !UUID.test(value.fileId)
    || typeof value.fileVersionId !== "string" || !UUID.test(value.fileVersionId)
    || typeof value.createdByDeviceId !== "string" || !UUID.test(value.createdByDeviceId)
    || !["create", "update", "delete", "restore", "rename"].includes(String(value.eventType))
    || typeof value.path !== "string" || normalizeVaultPath(value.path) !== value.path
    || (value.previousPath !== null && (typeof value.previousPath !== "string" || normalizeVaultPath(value.previousPath) !== value.previousPath))
    || (value.previousVersionId !== null && (typeof value.previousVersionId !== "string" || !UUID.test(value.previousVersionId)))
    || typeof value.isDeleted !== "boolean"
    || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0
    || !Number.isSafeInteger(value.mtimeMs) || Number(value.mtimeMs) < 0) return false;
  if (value.isDeleted) return value.content === null;
  if (exactKeys(value.content, ["kind", "objectId", "encryptionDomainId", "keyVersion", "ciphertextHash", "byteSize"])) {
    return value.content.kind === "object" && typeof value.content.objectId === "string" && UUID.test(value.content.objectId)
      && typeof value.content.encryptionDomainId === "string" && UUID.test(value.content.encryptionDomainId)
      && Number.isSafeInteger(value.content.keyVersion) && Number(value.content.keyVersion) >= 1
      && typeof value.content.ciphertextHash === "string" && SHA256.test(value.content.ciphertextHash)
      && Number.isSafeInteger(value.content.byteSize) && Number(value.content.byteSize) >= 0;
  }
  return exactKeys(value.content, ["kind", "contentHash", "byteSize"])
    && value.content.kind === "legacy"
    && (value.content.contentHash === null || (typeof value.content.contentHash === "string" && SHA256.test(value.content.contentHash)))
    && Number.isSafeInteger(value.content.byteSize) && Number(value.content.byteSize) >= 0;
}

function validInboxEntry(value: unknown): value is VaultSyncInboxEntry {
  if (!isRecord(value) || !(exactKeys(value, ["cursor", "item", "state"])
    || exactKeys(value, ["cursor", "item", "state", "resolution"]))) return false;
  if (typeof value.cursor !== "string" || !isValidVaultSyncInt8Decimal(value.cursor)
    || !validChangeItem(value.item) || value.item.cursor !== value.cursor
    || !["received", "applied", "needs_resolution"].includes(String(value.state))) return false;
  if (!("resolution" in value)) return true;
  const resolution = value.resolution;
  const updateKeys = ["kind", "sourcePath", "sourceContentHash", "conflictCopyPath", "targetPath", "remoteContentHash", "byteSize"];
  if (exactKeys(resolution, updateKeys) && resolution.kind === "keep_local_on_update") {
    return value.item.eventType === "update" && !value.item.isDeleted && value.item.content?.kind === "object"
      && typeof resolution.sourcePath === "string" && normalizeVaultPath(resolution.sourcePath) === resolution.sourcePath
      && resolution.sourcePath === value.item.path
      && typeof resolution.targetPath === "string" && normalizeVaultPath(resolution.targetPath) === resolution.targetPath
      && resolution.targetPath === value.item.path
      && typeof resolution.conflictCopyPath === "string" && normalizeVaultPath(resolution.conflictCopyPath) === resolution.conflictCopyPath
      && resolution.conflictCopyPath !== resolution.sourcePath
      && typeof resolution.sourceContentHash === "string" && SHA256.test(resolution.sourceContentHash)
      && typeof resolution.remoteContentHash === "string" && SHA256.test(resolution.remoteContentHash)
      && Number.isSafeInteger(resolution.byteSize) && Number(resolution.byteSize) === value.item.byteSize;
  }
  if ((exactKeys(resolution, ["kind", "sourcePath", "sourceContentHash", "targetPath", "remoteContentHash", "byteSize"])
      || exactKeys(resolution, ["kind", "sourcePath", "sourceContentHash", "targetPath", "remoteContentHash", "byteSize", "localMoveIntentId"]))
    && resolution.kind === "keep_local_on_rename") {
    return value.item.eventType === "rename" && !value.item.isDeleted && value.item.content?.kind === "object"
      && typeof resolution.sourcePath === "string" && normalizeVaultPath(resolution.sourcePath) === resolution.sourcePath
      && (resolution.localMoveIntentId === undefined
        ? resolution.sourcePath === value.item.previousPath
        : typeof resolution.localMoveIntentId === "string" && UUID.test(resolution.localMoveIntentId)
          && resolution.sourcePath !== value.item.path)
      && typeof resolution.targetPath === "string" && normalizeVaultPath(resolution.targetPath) === resolution.targetPath
      && resolution.targetPath === value.item.path
      && typeof resolution.sourceContentHash === "string" && SHA256.test(resolution.sourceContentHash)
      && typeof resolution.remoteContentHash === "string" && SHA256.test(resolution.remoteContentHash)
      && Number.isSafeInteger(resolution.byteSize) && Number(resolution.byteSize) === value.item.byteSize;
  }
  if (exactKeys(resolution, ["kind", "sourcePath", "sourceContentHash", "conflictCopyPath", "targetPath", "remoteContentHash", "byteSize"])
    && resolution.kind === "keep_local_on_create"
    && value.item.eventType === "create" && value.item.previousPath === null && !value.item.isDeleted
    && value.item.content?.kind === "object"
    && typeof resolution.sourcePath === "string" && normalizeVaultPath(resolution.sourcePath) === resolution.sourcePath
    && resolution.sourcePath === value.item.path
    && typeof resolution.targetPath === "string" && normalizeVaultPath(resolution.targetPath) === resolution.targetPath
    && resolution.targetPath === value.item.path
    && typeof resolution.conflictCopyPath === "string" && normalizeVaultPath(resolution.conflictCopyPath) === resolution.conflictCopyPath
    && resolution.conflictCopyPath !== resolution.sourcePath
    && typeof resolution.sourceContentHash === "string" && SHA256.test(resolution.sourceContentHash)
    && typeof resolution.remoteContentHash === "string" && SHA256.test(resolution.remoteContentHash)
    && Number.isSafeInteger(resolution.byteSize) && Number(resolution.byteSize) === value.item.byteSize) return true;
  const deleteKeys = ["kind", "sourcePath", "sourceContentHash", "conflictCopyPath", "targetPath", "localByteSize"];
  const hasLocalMove = isRecord(resolution) && Object.hasOwn(resolution, "localMoveIntentId");
  return (exactKeys(resolution, deleteKeys)
    || exactKeys(resolution, [...deleteKeys, "localMoveIntentId"]))
    && resolution.kind === "keep_local_on_delete"
    && value.item.eventType === "delete" && value.item.isDeleted && value.item.content === null && value.item.byteSize === 0
    && typeof resolution.sourcePath === "string" && normalizeVaultPath(resolution.sourcePath) === resolution.sourcePath
    && (hasLocalMove
      ? typeof resolution.localMoveIntentId === "string" && UUID.test(resolution.localMoveIntentId)
        && resolution.sourcePath !== value.item.path
      : resolution.sourcePath === value.item.path)
    && typeof resolution.targetPath === "string" && normalizeVaultPath(resolution.targetPath) === resolution.targetPath
    && resolution.targetPath === value.item.path
    && typeof resolution.conflictCopyPath === "string"
    && (hasLocalMove ? resolution.conflictCopyPath === "" : normalizeVaultPath(resolution.conflictCopyPath) === resolution.conflictCopyPath)
    && (hasLocalMove ? resolution.conflictCopyPath === "" : resolution.conflictCopyPath !== resolution.sourcePath)
    && typeof resolution.sourceContentHash === "string" && SHA256.test(resolution.sourceContentHash)
    && Number.isSafeInteger(resolution.localByteSize) && Number(resolution.localByteSize) >= 0
    && Number(resolution.localByteSize) <= 2 * 1024 * 1024;
}

function validRequest(value: unknown, operationId: string, fileId: string, epoch: number): value is VaultSyncV2Request {
  if (!exactKeys(value, ["protocolVersion", "protocolEpoch", "operationWindowId", "operationId", "fileId", "expectedVersionId", "operation"])) return false;
  if (value.protocolVersion !== 2 || value.protocolEpoch !== epoch
    || typeof value.operationWindowId !== "string" || !UUID.test(value.operationWindowId)
    || value.operationId !== operationId || value.fileId !== fileId
    || (value.expectedVersionId !== null && (typeof value.expectedVersionId !== "string" || !UUID.test(value.expectedVersionId)))
    || !isRecord(value.operation)) return false;
  const op = value.operation;
  if (op.type === "create") return exactKeys(op, ["type", "path", "content"]) && value.expectedVersionId === null
    && typeof op.path === "string" && normalizeVaultPath(op.path) === op.path && contentRef(op.content);
  if (op.type === "update") return exactKeys(op, ["type", "content"]) && typeof value.expectedVersionId === "string" && contentRef(op.content);
  if (op.type === "delete") return exactKeys(op, ["type"]) && typeof value.expectedVersionId === "string";
  if (op.type === "restore" && exactKeys(op, ["type", "sourceVersionId", "path", "reuseSourceContent"])) {
    return typeof value.expectedVersionId === "string" && typeof op.sourceVersionId === "string" && UUID.test(op.sourceVersionId)
      && typeof op.path === "string" && normalizeVaultPath(op.path) === op.path && op.reuseSourceContent === true;
  }
  if (op.type === "restore") return exactKeys(op, ["type", "sourceVersionId", "path", "content"])
    && typeof value.expectedVersionId === "string" && typeof op.sourceVersionId === "string" && UUID.test(op.sourceVersionId)
    && typeof op.path === "string" && normalizeVaultPath(op.path) === op.path && contentRef(op.content);
  if (op.type === "rename") return exactKeys(op, ["type", "basePath", "path"]) && typeof value.expectedVersionId === "string"
    && typeof op.basePath === "string" && normalizeVaultPath(op.basePath) === op.basePath
    && typeof op.path === "string" && normalizeVaultPath(op.path) === op.path;
  return false;
}

function validOperation(value: unknown, identity: VaultSyncV2Identity): value is VaultSyncOutboxOperation {
  const baseKeys = ["operationId", "fileId", "operationDigest", "localContentHash", "localByteSize", "localGeneration", "request", "state"];
  const optionalKeys = ["createResolution", "resolvesInboxCursor", "autoMergeAttempts", "needsRebaseReason"];
  if (!isRecord(value) || !baseKeys.every((key) => key in value)
    || Object.keys(value).some((key) => !baseKeys.includes(key) && !optionalKeys.includes(key))) return false;
  const baseValid =
    typeof value.operationId === "string" && UUID.test(value.operationId)
    && typeof value.fileId === "string" && UUID.test(value.fileId)
    && typeof value.operationDigest === "string" && SHA256.test(value.operationDigest)
    && typeof value.localContentHash === "string" && SHA256.test(value.localContentHash)
    && Number.isSafeInteger(value.localByteSize) && Number(value.localByteSize) >= 0
    && Number.isSafeInteger(value.localGeneration) && Number(value.localGeneration) >= 0
    && validRequest(value.request, value.operationId as string, value.fileId as string, identity.protocolEpoch)
    && ["queued", "preparing", "uploaded", "committing", "confirmed", "conflict", "needs_rebase"].includes(String(value.state));
  if (!baseValid) return false;
  if ("needsRebaseReason" in value && (value.state !== "needs_rebase"
    || !["local_file_missing", "local_content_mismatch", "baseline_unavailable", "operation_receipt_expired",
      "prepared_content_mismatch", "operation_path_unavailable", "operation_recovery_unresolved", "snapshot_rebuilt", "unknown"]
      .includes(String(value.needsRebaseReason)))) return false;
  const request = value.request as VaultSyncV2Request;
  if ("createResolution" in value) {
    const resolution = value.createResolution;
    if (!(exactKeys(resolution, ["kind", "sourcePath", "targetPath", "sourceContentHash", "byteSize", "localGeneration"])
      && resolution.kind === "repath_create" && value.state === "conflict" && request.operation.type === "create"
      && typeof resolution.sourcePath === "string" && normalizeVaultPath(resolution.sourcePath) === resolution.sourcePath
      && resolution.sourcePath === request.operation.path
      && typeof resolution.targetPath === "string" && normalizeVaultPath(resolution.targetPath) === resolution.targetPath
      && resolution.targetPath !== resolution.sourcePath
      && typeof resolution.sourceContentHash === "string" && SHA256.test(resolution.sourceContentHash)
      && resolution.sourceContentHash === value.localContentHash
      && Number.isSafeInteger(resolution.byteSize) && resolution.byteSize === value.localByteSize
      && Number.isSafeInteger(resolution.localGeneration) && resolution.localGeneration === value.localGeneration)) return false;
  }
  if ("resolvesInboxCursor" in value && (typeof value.resolvesInboxCursor !== "string" || !CURSOR.test(value.resolvesInboxCursor)
    || request.operation.type !== "update" || "createResolution" in value)) return false;
  if ("autoMergeAttempts" in value && (!Number.isSafeInteger(value.autoMergeAttempts)
    || Number(value.autoMergeAttempts) < 0 || Number(value.autoMergeAttempts) > 1
    || request.operation.type !== "update" || "createResolution" in value || "resolvesInboxCursor" in value)) return false;
  return true;
}

function operationIntent(request: VaultSyncV2Request): Record<string, unknown> {
  const operation = { ...request.operation };
  delete operation.content;
  return {
    protocolVersion: request.protocolVersion,
    protocolEpoch: request.protocolEpoch,
    fileId: request.fileId,
    expectedVersionId: request.expectedVersionId,
    operation,
  };
}

function compactAppliedInbox(inbox: VaultSyncInboxEntry[], appliedCursor: string): VaultSyncInboxEntry[] {
  const applied = BigInt(appliedCursor);
  // Keep unresolved conflicts and work not yet covered by the contiguous ACK.
  // Retain a bounded applied tail for restart/audit and exact duplicate checks;
  // older applied events are replayed as no-ops from the durable cursor alone.
  // Inbox order is validated as strictly cursor-increasing when loaded and new
  // pages append only a contiguous suffix, so slicing preserves the newest tail.
  const settled = inbox.filter((entry) => entry.state === "applied" && BigInt(entry.cursor) <= applied);
  const retained = new Set(settled.slice(-APPLIED_INBOX_HISTORY_LIMIT).map((entry) => entry.cursor));
  return inbox.filter((entry) => entry.state !== "applied"
    || BigInt(entry.cursor) > applied
    || retained.has(entry.cursor));
}

function validSnapshot(value: unknown, identity: VaultSyncV2Identity): value is VaultSyncOutboxSnapshot & { digest: string } {
  return exactKeys(value, ["generation", "identity", "receivedCursor", "appliedCursor", "sessionGeneration", "throughCursor", "operations", "inbox", "digest"])
    && typeof value.generation === "string" && CURSOR.test(value.generation)
    && isRecord(value.identity) && stableJson(value.identity) === stableJson(identity)
    && typeof value.receivedCursor === "string" && isValidVaultSyncInt8Decimal(value.receivedCursor)
    && typeof value.appliedCursor === "string" && isValidVaultSyncInt8Decimal(value.appliedCursor)
    && BigInt(value.appliedCursor) <= BigInt(value.receivedCursor)
    && (value.sessionGeneration === null || (typeof value.sessionGeneration === "string" && isValidVaultSyncInt8Decimal(value.sessionGeneration, { allowZero: false })))
    && (value.throughCursor === null || (typeof value.throughCursor === "string" && isValidVaultSyncInt8Decimal(value.throughCursor) && BigInt(value.throughCursor) >= BigInt(value.receivedCursor)))
    && Array.isArray(value.operations) && value.operations.every((operation) => validOperation(operation, identity))
    && Array.isArray(value.inbox) && value.inbox.every(validInboxEntry)
    && value.inbox.every((entry, index, entries) => (index === 0 || BigInt((entries[index - 1] as VaultSyncInboxEntry).cursor) < BigInt((entry as VaultSyncInboxEntry).cursor))
      && BigInt((entry as VaultSyncInboxEntry).cursor) <= BigInt(value.receivedCursor as string))
    && value.operations.every((operation) => {
      if (!operation.resolvesInboxCursor) return true;
      const entry = (value.inbox as unknown[]).find((item: unknown) => (item as VaultSyncInboxEntry).cursor === operation.resolvesInboxCursor) as VaultSyncInboxEntry | undefined;
      return !!entry && ["needs_resolution", "applied"].includes(entry.state)
        && entry.item.eventType === "update" && !entry.item.isDeleted && entry.item.fileId === operation.fileId;
    })
    && typeof value.digest === "string" && SHA256.test(value.digest);
}

function snapshotPrefix(identity: VaultSyncV2Identity): string {
  return DIR + "/outbox-" + identity.targetId + "-" + identity.deviceId + "-e" + identity.protocolEpoch + "-";
}

export async function loadLatestVaultSyncOutboxSnapshot(
  app: App,
  rawIdentity: Omit<VaultSyncV2Identity, "protocolEpoch">,
): Promise<VaultSyncOutboxSnapshot | null> {
  const normalizedBase = normalizedIdentity({ ...rawIdentity, protocolEpoch: 1 });
  const adapter: DataAdapter = app.vault.adapter;
  const filePrefix = DIR + "/outbox-" + normalizedBase.targetId + "-" + normalizedBase.deviceId + "-e";
  const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
  const candidates = listed.files.flatMap((path) => {
    if (!path.startsWith(filePrefix) || !path.endsWith(".json")) return [];
    const suffix = path.slice(filePrefix.length, -5);
    const match = /^(\d+)-(\d{20})$/.exec(suffix);
    if (!match) return [];
    const protocolEpoch = Number(match[1]);
    if (!Number.isSafeInteger(protocolEpoch) || protocolEpoch < 1) return [];
    return [{ path, protocolEpoch, generation: BigInt(match[2]) }];
  }).sort((a, b) => a.protocolEpoch !== b.protocolEpoch
    ? b.protocolEpoch - a.protocolEpoch
    : a.generation > b.generation ? -1 : a.generation < b.generation ? 1 : 0);

  for (const candidate of candidates) {
    const identity = normalizedIdentity({ ...normalizedBase, protocolEpoch: candidate.protocolEpoch });
    let parsed: unknown;
    try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
    if (!validSnapshot(parsed, identity)) continue;
    const { digest, ...snapshot } = parsed;
    if (await sha256Hex(new TextEncoder().encode(stableJson(snapshot))) !== digest
      || parsed.generation !== candidate.generation.toString()) continue;
    return snapshot;
  }
  return null;
}

export function createVaultSyncOutboxStore(app: App, rawIdentity: VaultSyncV2Identity): VaultSyncOutboxStore {
  const identity = normalizedIdentity(rawIdentity);
  const adapter: DataAdapter = app.vault.adapter;
  const prefix = snapshotPrefix(identity);

  async function digestSnapshot(snapshot: Omit<VaultSyncOutboxSnapshot, "generation"> & { generation: string }): Promise<string> {
    return sha256Hex(new TextEncoder().encode(stableJson(snapshot)));
  }

  async function scan(): Promise<{ state: VaultSyncOutboxSnapshot | null; maxGeneration: bigint; validPaths: string[] }> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const candidates = listed.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const rawGeneration = path.slice(prefix.length, -5);
      if (!/^\d{20}$/.test(rawGeneration)) return [];
      return [{ path, generation: BigInt(rawGeneration) }];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let state: VaultSyncOutboxSnapshot | null = null;
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      maxGeneration = candidate.generation > maxGeneration ? candidate.generation : maxGeneration;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
      if (!validSnapshot(parsed, identity)) {
        if (isRecord(parsed) && isRecord(parsed.identity) && parsed.identity.targetId === identity.targetId
          && parsed.identity.deviceId === identity.deviceId && parsed.identity.protocolEpoch === identity.protocolEpoch
          && typeof parsed.identity.apiBaseUrl === "string") {
          throw fail("outbox_identity_mismatch", "本地待办属于其他 API 环境；拒绝跨环境重放");
        }
        continue;
      }
      const { digest, ...withoutDigest } = parsed;
      if (await digestSnapshot(withoutDigest) !== digest) continue;
      if (parsed.generation !== candidate.generation.toString()) continue;
      state = parsed;
      validPaths.push(candidate.path);
    }
    return { state, maxGeneration, validPaths };
  }

  async function persist(state: Omit<VaultSyncOutboxSnapshot, "generation">): Promise<VaultSyncOutboxSnapshot> {
    const current = await scan();
    const generation = (current.maxGeneration + 1n).toString();
    const base = { ...state, generation };
    const snapshot = { ...base, digest: await digestSnapshot(base) };
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = prefix + generation.padStart(20, "0") + ".json";
    // Existing generations are never overwritten; a partially written newest
    // file is ignored on load while the previous verified snapshot survives.
    const serialized = stableJson(snapshot) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("outbox_write_unverified", "本地待办快照回读校验失败");
    const check = await scan();
    if (!check.state || check.state.generation !== generation) throw fail("outbox_write_unverified", "本地待办快照摘要校验失败");
    // Keep the last two verified immutable snapshots for fallback. Damaged
    // snapshots are retained as evidence; only older verified generations go.
    for (const oldPath of check.validPaths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
    return check.state;
  }

  async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return withVaultSyncV2StateWriteLock(identity, work);
  }

  async function currentOrEmpty(): Promise<VaultSyncOutboxSnapshot> {
    const { state } = await scan();
    return state ?? { generation: "0", identity, receivedCursor: "0", appliedCursor: "0", sessionGeneration: null, throughCursor: null, operations: [], inbox: [] };
  }

  return {
    async load() { return (await scan()).state; },
    enqueue(input) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const operation = { ...input, state: "queued" as const };
        if (!validOperation(operation, identity)) throw fail("outbox_operation_invalid", "待发送操作不符合 v2 元数据合同");
        const prior = current.operations.find((item) => item.operationId === operation.operationId);
        if (prior) {
          if (stableJson(prior) !== stableJson(operation)) throw fail("outbox_operation_mutated", "同一 operationId 的本地请求载荷不可修改");
          return prior;
        }
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor,
          operations: [...current.operations, operation], inbox: current.inbox });
        return next.operations.find((item) => item.operationId === operation.operationId)!;
      });
    },
    replacePendingOperation(operationId, input) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const index = current.operations.findIndex((item) => item.operationId === operationId);
        if (index < 0) throw fail("outbox_operation_missing", "本地待办不存在");
        const prior = current.operations[index];
        const replacement = { ...input, state: "queued" as const };
        if (!validOperation(replacement, identity) || !["queued", "preparing", "uploaded"].includes(prior.state)
          || current.operations.some((item) => item.operationId === replacement.operationId)
          || prior.fileId !== replacement.fileId || prior.localContentHash !== replacement.localContentHash
          || prior.localByteSize !== replacement.localByteSize || prior.localGeneration !== replacement.localGeneration
          || (prior.autoMergeAttempts ?? 0) !== (replacement.autoMergeAttempts ?? 0)
          || prior.resolvesInboxCursor !== replacement.resolvesInboxCursor
          || stableJson(operationIntent(prior.request)) !== stableJson(operationIntent(replacement.request))) {
          throw fail("outbox_pending_replacement_invalid", "只有尚未提交且操作意图未变的待办可以重新绑定上传 reservation");
        }
        const operations = [...current.operations];
        operations[index] = replacement;
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: current.inbox });
        return next.operations[index];
      });
    },
    replaceConflictOperation(operationId, input) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const index = current.operations.findIndex((item) => item.operationId === operationId);
        if (index < 0) throw fail("outbox_operation_missing", "本地待办不存在");
        const prior = current.operations[index];
        const replacement = { ...input, state: "queued" as const };
        const priorType = prior.request.operation.type;
        const replacementType = replacement.request.operation.type;
        if (!validOperation(replacement, identity) || prior.state !== "conflict"
          || current.operations.some((item) => item.operationId === replacement.operationId)
          || prior.fileId !== replacement.fileId || prior.localContentHash !== replacement.localContentHash
          || prior.localByteSize !== replacement.localByteSize || prior.localGeneration !== replacement.localGeneration
          || (prior.autoMergeAttempts ?? 0) !== (replacement.autoMergeAttempts ?? 0)
          || prior.resolvesInboxCursor !== replacement.resolvesInboxCursor) {
          throw fail("outbox_conflict_replacement_invalid", "冲突替换必须保留相同文件 ID、本机正文和本地版本");
        }
        if (priorType === "update" && replacementType === "update") {
          const priorIntent = operationIntent(prior.request);
          const replacementIntent = operationIntent(replacement.request);
          delete priorIntent.expectedVersionId;
          delete replacementIntent.expectedVersionId;
          if (prior.request.expectedVersionId === replacement.request.expectedVersionId
            || stableJson(priorIntent) !== stableJson(replacementIntent)) {
            throw fail("outbox_conflict_replacement_invalid", "update 冲突只能将相同本机正文和目标文件重基到新的云端版本");
          }
        } else if (priorType === "delete" && replacementType === "delete") {
          const priorIntent = operationIntent(prior.request);
          const replacementIntent = operationIntent(replacement.request);
          delete priorIntent.expectedVersionId;
          delete replacementIntent.expectedVersionId;
          if (prior.request.expectedVersionId === replacement.request.expectedVersionId
            || stableJson(priorIntent) !== stableJson(replacementIntent)) {
            throw fail("outbox_conflict_replacement_invalid", "delete 冲突只能在同一文件上重新确认一个不同的云端版本");
          }
        } else if (priorType === "create" && replacementType === "create") {
          const resolution = prior.createResolution;
          if (!resolution || replacement.createResolution
            || prior.request.operation.path !== resolution.sourcePath
            || replacement.request.operation.path !== resolution.targetPath
            || prior.request.expectedVersionId !== null || replacement.request.expectedVersionId !== null) {
            throw fail("outbox_conflict_replacement_invalid", "create 冲突只能按已持久化的换路径意图替换");
          }
        } else if (priorType === "rename" && replacementType === "rename") {
          const priorIntent = operationIntent(prior.request);
          const replacementIntent = operationIntent(replacement.request);
          delete priorIntent.expectedVersionId;
          delete replacementIntent.expectedVersionId;
          const priorOperation = priorIntent.operation as Record<string, unknown>;
          const replacementOperation = replacementIntent.operation as Record<string, unknown>;
          delete priorOperation.basePath;
          delete replacementOperation.basePath;
          if (prior.request.expectedVersionId === replacement.request.expectedVersionId
            || stableJson(priorIntent) !== stableJson(replacementIntent)
            || typeof (replacement.request.operation as any).basePath !== "string") {
            throw fail("outbox_conflict_replacement_invalid", "rename 冲突只能将相同目标路径重基到更新的云端 head");
          }
        } else {
          throw fail("outbox_conflict_replacement_invalid", "不支持以不同操作类型替换 outbox 冲突");
        }
        const replaced = (operation: VaultSyncOutboxOperation) => operation.operationId === prior.operationId
          || (priorType === "update" && operation.state === "conflict"
            && operation.fileId === prior.fileId && operation.localContentHash === prior.localContentHash
            && operation.resolvesInboxCursor === prior.resolvesInboxCursor
            && operation.request.operation.type === "update")
          || (priorType === "delete" && operation.state === "conflict"
            && operation.fileId === prior.fileId && operation.request.operation.type === "delete")
          || (priorType === "rename" && operation.state === "conflict"
            && operation.fileId === prior.fileId && operation.localContentHash === prior.localContentHash
            && operation.request.operation.type === "rename");
        const firstIndex = current.operations.findIndex(replaced);
        const operations = current.operations.filter((operation) => !replaced(operation));
        operations.splice(Math.min(Math.max(0, firstIndex), operations.length), 0, replacement);
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: current.inbox });
        return next.operations.find((operation) => operation.operationId === replacement.operationId)!;
      });
    },
    replaceConflictWithMergedUpdate(operationId, input) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const index = current.operations.findIndex((item) => item.operationId === operationId);
        if (index < 0) throw fail("outbox_operation_missing", "本地待办不存在");
        const prior = current.operations[index];
        const replacement = { ...input, state: "queued" as const };
        const priorIntent = operationIntent(prior.request);
        const replacementIntent = operationIntent(replacement.request);
        delete priorIntent.expectedVersionId;
        delete replacementIntent.expectedVersionId;
        if (!validOperation(replacement, identity) || prior.state !== "conflict"
          || prior.request.operation.type !== "update" || replacement.request.operation.type !== "update"
          || prior.resolvesInboxCursor !== undefined || replacement.resolvesInboxCursor !== undefined
          || prior.autoMergeAttempts === 1 || replacement.autoMergeAttempts !== 1
          || current.operations.some((item) => item.operationId === replacement.operationId)
          || prior.fileId !== replacement.fileId || prior.localGeneration !== replacement.localGeneration
          || prior.request.expectedVersionId === replacement.request.expectedVersionId
          || stableJson(priorIntent) !== stableJson(replacementIntent)) {
          throw fail("outbox_conflict_merge_replacement_invalid", "自动合并只能将未尝试的 update 冲突，以新正文和新 CAS head 替换一次");
        }
        const replaced = (operation: VaultSyncOutboxOperation) => operation.operationId === prior.operationId
          || (operation.state === "conflict" && operation.fileId === prior.fileId
            && operation.localContentHash === prior.localContentHash
            && operation.request.operation.type === "update" && operation.resolvesInboxCursor === undefined);
        const firstIndex = current.operations.findIndex(replaced);
        const operations = current.operations.filter((operation) => !replaced(operation));
        operations.splice(Math.min(Math.max(0, firstIndex), operations.length), 0, replacement);
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: current.inbox });
        return next.operations.find((operation) => operation.operationId === replacement.operationId)!;
      });
    },
    resolveDeleteConflict(operationId) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const prior = current.operations.find((operation) => operation.operationId === operationId);
        if (!prior || prior.state !== "conflict" || prior.request.operation.type !== "delete") {
          throw fail("outbox_delete_conflict_invalid", "只有冲突中的 delete 操作可以由用户撤销");
        }
        return persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor,
          operations: current.operations.filter((operation) => operation.operationId !== operationId), inbox: current.inbox });
      });
    },
    beginCreateConflictResolution(operationId, resolution) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const index = current.operations.findIndex((item) => item.operationId === operationId);
        if (index < 0) throw fail("outbox_operation_missing", "本地待办不存在");
        const prior = current.operations[index];
        const candidate = { ...prior, createResolution: resolution };
        if (prior.state !== "conflict" || prior.request.operation.type !== "create"
          || (prior.createResolution && stableJson(prior.createResolution) !== stableJson(resolution))
          || !validOperation(candidate, identity)) {
          throw fail("outbox_create_resolution_invalid", "仅可为未关联的 create 冲突保存与原请求一致的换路径意图");
        }
        if (prior.createResolution) return prior;
        const operations = [...current.operations];
        operations[index] = candidate;
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: current.inbox });
        return next.operations[index];
      });
    },
    replaceExpiredOperation(operationId, input) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const index = current.operations.findIndex((item) => item.operationId === operationId);
        if (index < 0) throw fail("outbox_operation_missing", "本地待办不存在");
        const prior = current.operations[index];
        const replacement = { ...input, state: "queued" as const };
        if (!validOperation(replacement, identity) || prior.state !== "committing"
          || current.operations.some((item) => item.operationId === replacement.operationId)
          || prior.fileId !== replacement.fileId || prior.localContentHash !== replacement.localContentHash
          || prior.localByteSize !== replacement.localByteSize || prior.localGeneration !== replacement.localGeneration
          || (prior.autoMergeAttempts ?? 0) !== (replacement.autoMergeAttempts ?? 0)
          || prior.resolvesInboxCursor !== replacement.resolvesInboxCursor
          || stableJson(operationIntent(prior.request)) !== stableJson(operationIntent(replacement.request))) {
          throw fail("outbox_expired_replacement_invalid", "只有 receipt 确认未知的过期提交，才能以相同文件意图和内容换新 operation");
        }
        const operations = [...current.operations];
        operations[index] = replacement;
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: current.inbox });
        return next.operations[index];
      });
    },
    transition(operationId, state, needsRebaseReason) {
      return runExclusive(async () => {
        if ((state === "needs_rebase" && needsRebaseReason !== undefined
          && !["local_file_missing", "local_content_mismatch", "baseline_unavailable", "operation_receipt_expired",
            "prepared_content_mismatch", "operation_path_unavailable", "operation_recovery_unresolved", "snapshot_rebuilt", "unknown"]
            .includes(needsRebaseReason)) || (state !== "needs_rebase" && needsRebaseReason !== undefined)) {
          throw fail("outbox_rebase_reason_invalid", "需重基原因只能使用已知类别并绑定 needs_rebase 状态");
        }
        const current = await currentOrEmpty();
        const index = current.operations.findIndex((item) => item.operationId === operationId);
        if (index < 0) throw fail("outbox_operation_missing", "本地待办不存在");
        const prior = current.operations[index];
        const transitions: Record<VaultSyncOutboxState, VaultSyncOutboxState[]> = {
          queued: ["preparing", "committing", "conflict", "needs_rebase"],
          preparing: ["uploaded", "committing", "conflict", "needs_rebase"],
          uploaded: ["committing", "conflict", "needs_rebase"],
          committing: ["confirmed", "conflict", "needs_rebase"],
          confirmed: [], conflict: [], needs_rebase: [],
        };
        if (prior.state !== state && !transitions[prior.state].includes(state)) throw fail("outbox_transition_invalid", "待办状态不能回退或跳过确认步骤");
        if (prior.state === state) {
          if (state !== "needs_rebase" || !needsRebaseReason || prior.needsRebaseReason) return prior;
        }
        const operations = [...current.operations];
        operations[index] = state === "needs_rebase"
          ? { ...prior, state, needsRebaseReason: needsRebaseReason ?? prior.needsRebaseReason ?? "unknown" }
          : { ...prior, state };
        const next = await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: current.inbox });
        return next.operations[index];
      });
    },
    setSessionGeneration(sessionGeneration) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        if (!isValidVaultSyncInt8Decimal(sessionGeneration, { allowZero: false })
          || (current.sessionGeneration !== null && BigInt(sessionGeneration) <= BigInt(current.sessionGeneration))) {
          throw fail("outbox_session_invalid", "设备会话代数必须严格递增");
        }
        return persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration, throughCursor: null, operations: current.operations, inbox: current.inbox });
      });
    },
    receivePage(page) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        if (!page || page.protocolEpoch !== identity.protocolEpoch || !isValidVaultSyncInt8Decimal(page.throughCursor)
          || !isValidVaultSyncInt8Decimal(page.nextCursor) || !isValidVaultSyncInt8Decimal(page.minReplayCursor)
          || typeof page.hasMore !== "boolean" || !Array.isArray(page.items)) {
          throw fail("inbox_page_invalid", "服务端增量页不符合当前协议或游标格式");
        }
        const through = BigInt(page.throughCursor);
        const nextCursor = BigInt(page.nextCursor);
        const received = BigInt(current.receivedCursor);
        const known = new Map(current.inbox.map((entry) => [entry.cursor, entry]));
        let expected = received + 1n;
        let previousPageCursor: bigint | null = null;
        const newEntries: VaultSyncInboxEntry[] = [];
        for (const item of page.items) {
          if (!validChangeItem(item)) throw fail("inbox_item_invalid", "服务端变更项格式无效");
          const itemCursor = BigInt(item.cursor);
          if (previousPageCursor !== null && itemCursor !== previousPageCursor + 1n) {
            throw fail("inbox_page_cursor_gap", "单个服务端变更页中的游标不连续");
          }
          previousPageCursor = itemCursor;
          if (itemCursor <= received) {
            const existing = known.get(item.cursor);
            if (existing) {
              if (stableJson(existing.item) === stableJson(item)) continue;
              throw fail("inbox_duplicate_mismatch", "重复变更项与本地已持久记录不一致");
            }
            if (itemCursor <= BigInt(current.appliedCursor)) continue;
            throw fail("inbox_duplicate_mismatch", "重复变更项与本地已持久记录不一致");
          }
          if (itemCursor !== expected) throw fail("inbox_cursor_gap", "服务端增量页没有从本地接收游标连续推进");
          newEntries.push({ cursor: item.cursor, item, state: "received" });
          expected += 1n;
        }
        const pageLastCursor = previousPageCursor ?? received;
        if (nextCursor !== pageLastCursor || nextCursor > through || page.hasMore !== (nextCursor < through)) {
          throw fail("inbox_page_boundary_invalid", "服务端增量页游标边界不一致");
        }
        if (current.throughCursor !== null && current.throughCursor !== page.throughCursor) {
          throw fail("inbox_page_boundary_changed", "当前追赶批次的固定 high-watermark 发生变化");
        }
        if (page.items.length === 0 && nextCursor < through) {
          throw fail("inbox_page_empty_before_boundary", "固定增量边界之前不能返回空页");
        }
        if (newEntries.length === 0) {
          if (nextCursor > received) throw fail("inbox_cursor_gap", "重复变更页不能越过本地接收游标");
          // The page may have been persisted before the response/ACK was lost.
          // Identical already-recorded pages are safe no-ops; changed items and
          // pages from a different active high-watermark were rejected above.
          return current;
        }
        const nextReceived = nextCursor > received ? nextCursor.toString() : current.receivedCursor;
        return persist({
          identity,
          receivedCursor: nextReceived,
          appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration,
          throughCursor: page.hasMore ? page.throughCursor : null,
          operations: current.operations,
          inbox: [...current.inbox, ...newEntries],
        });
      });
    },
    markInboxItem(cursor, state) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        if (!CURSOR.test(cursor) || !["applied", "needs_resolution"].includes(state)) {
          throw fail("inbox_state_invalid", "变更应用状态无效");
        }
        const index = current.inbox.findIndex((entry) => entry.cursor === cursor);
        if (index < 0) throw fail("inbox_item_missing", "本地 inbox 中不存在该变更");
        const prior = current.inbox[index];
        if (prior.state === state) return current;
        if (prior.state === "applied" || (prior.state === "needs_resolution" && state !== "applied")) {
          throw fail("inbox_state_regression", "变更应用状态不能回退");
        }
        const inbox = [...current.inbox];
        inbox[index] = { ...prior, state };
        let applied = BigInt(current.appliedCursor);
        const byCursor = new Map(inbox.map((entry) => [entry.cursor, entry]));
        while (true) {
          const next = byCursor.get((applied + 1n).toString());
          // A durable conflict is recoverable state, not an applied event;
          // keep the server progress catching up until the user resolves it.
          if (!next || next.state !== "applied") break;
          applied += 1n;
        }
        const compactedInbox = compactAppliedInbox(inbox, applied.toString());
        return persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: applied.toString(),
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor,
          operations: current.operations, inbox: compactedInbox });
      });
    },
    beginInboxConflictResolution(cursor, resolution) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        const index = current.inbox.findIndex((entry) => entry.cursor === cursor);
        if (index < 0) throw fail("inbox_item_missing", "本地 inbox 中不存在该变更");
        const prior = current.inbox[index];
        const candidate = { ...prior, resolution };
        if (prior.state !== "needs_resolution" || !validInboxEntry(candidate)
          || (prior.resolution && stableJson(prior.resolution) !== stableJson(resolution))) {
          throw fail("inbox_conflict_resolution_invalid", "冲突恢复记录无效或与已持久记录不一致");
        }
        if (prior.resolution) return current;
        const inbox = [...current.inbox];
        inbox[index] = candidate;
        return persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor,
          operations: current.operations, inbox });
      });
    },
    resolveInboxItem(cursor, preservedLocalHash) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        if (!CURSOR.test(cursor) || typeof preservedLocalHash !== "string" || !SHA256.test(preservedLocalHash)) {
          throw fail("inbox_resolution_invalid", "冲突解决回执格式无效");
        }
        const index = current.inbox.findIndex((entry) => entry.cursor === cursor);
        if (index < 0) throw fail("inbox_item_missing", "本地 inbox 中不存在该变更");
        const prior = current.inbox[index];
        if (prior.state === "applied") return current;
        if (prior.state !== "needs_resolution") throw fail("inbox_resolution_state_invalid", "只有已进入待处理状态的 inbox 项可以显式解决");
        const inbox = [...current.inbox];
        inbox[index] = { ...prior, state: "applied" };
        let applied = BigInt(current.appliedCursor);
        const byCursor = new Map(inbox.map((entry) => [entry.cursor, entry]));
        while (true) {
          const next = byCursor.get((applied + 1n).toString());
          // Explicit resolution changes the state to applied, allowing this
          // scan to bridge the conflict and any already-applied later events.
          if (!next || next.state !== "applied") break;
          applied += 1n;
        }
        const compactedInbox = compactAppliedInbox(inbox, applied.toString());
        // Only discard an outbound CAS request whose exact local bytes were
        // preserved by the user-selected action. A create collision has a
        // different fileId from the remote create, so its path is also bound
        // to the inbox event before the old request can be cleared.
        const operations = current.operations.filter((operation) => !(operation.state === "conflict"
          && operation.localContentHash === preservedLocalHash
          && (operation.fileId === prior.item.fileId
            || (operation.request.operation.type === "create" && operation.request.operation.path === prior.item.path))));
        return persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: applied.toString(),
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor, operations, inbox: compactedInbox });
      });
    },
    setSnapshotBaseline(cursor) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        if (!isValidVaultSyncInt8Decimal(cursor) || current.receivedCursor !== "0" || current.appliedCursor !== "0"
          || current.operations.length || current.inbox.length) {
          throw fail("outbox_baseline_state_invalid", "只有空 journal 可安装初始快照游标");
        }
        return persist({ identity, receivedCursor: cursor, appliedCursor: cursor,
          sessionGeneration: current.sessionGeneration, throughCursor: null, operations: current.operations, inbox: current.inbox });
      });
    },
    installSnapshotBaseline(cursor) {
      return runExclusive(async () => {
        const current = await currentOrEmpty();
        if (!isValidVaultSyncInt8Decimal(cursor) || BigInt(cursor) < BigInt(current.receivedCursor)
          || BigInt(cursor) < BigInt(current.appliedCursor)
          || current.inbox.some((entry) => entry.state !== "applied")) {
          throw fail("outbox_snapshot_rebase_invalid", "快照重建必须前进游标，且先处理完本地增量 inbox");
        }
        const operations = current.operations.map((operation) => ({
          ...operation,
          state: ["confirmed", "conflict"].includes(operation.state) ? operation.state : "needs_rebase",
          ...(["confirmed", "conflict"].includes(operation.state) ? {} : { needsRebaseReason: "snapshot_rebuilt" as const }),
        }));
        return persist({ identity, receivedCursor: cursor, appliedCursor: cursor,
          sessionGeneration: current.sessionGeneration, throughCursor: null,
          operations, inbox: [] });
      });
    },
    pruneConfirmed(operationIds) {
      return runExclusive(async () => {
        if (!Array.isArray(operationIds) || operationIds.some((id) => typeof id !== "string" || !UUID.test(id))) {
          throw fail("outbox_prune_invalid", "本地待办清理列表格式无效");
        }
        const current = await currentOrEmpty();
        const remove = new Set(operationIds);
        for (const operation of current.operations) {
          if (remove.has(operation.operationId) && operation.state !== "confirmed") {
            throw fail("outbox_prune_unconfirmed", "只有已确认的操作才能清理");
          }
        }
        return persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor,
          operations: current.operations.filter((operation) => !remove.has(operation.operationId)), inbox: current.inbox });
      });
    },
    discardSupersededUpdatesByReviewedDelete(fileId, deletedVersionId) {
      return runExclusive(async () => {
        if (typeof fileId !== "string" || !UUID.test(fileId)
          || typeof deletedVersionId !== "string" || !UUID.test(deletedVersionId)) {
          throw fail("outbox_delete_supersede_invalid", "删除确认对应的文件标识无效");
        }
        const current = await currentOrEmpty();
        const superseded = current.operations.filter((operation) => operation.fileId === fileId
          && operation.request.operation.type === "update"
          && operation.request.expectedVersionId === deletedVersionId);
        if (!superseded.length) return [];
        const supersededIds = new Set(superseded.map((operation) => operation.operationId));
        await persist({ identity, receivedCursor: current.receivedCursor, appliedCursor: current.appliedCursor,
          sessionGeneration: current.sessionGeneration, throughCursor: current.throughCursor,
          operations: current.operations.filter((operation) => !supersededIds.has(operation.operationId)), inbox: current.inbox });
        return superseded;
      });
    },
  };
}
