import type { VaultSyncV2Request } from "./vault-sync-outbox.ts";
import { isValidVaultSyncInt8Decimal, normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";

export interface VaultSyncCapabilities {
  protocolVersion: 2;
  activeProtocolVersion: number;
  protocolEpoch: number;
  minimumWriterVersion: number;
  canRead: boolean;
  canWrite: boolean;
  baselineReady: boolean;
  v2WriteEnabled: boolean;
  v2WriteAvailable: boolean;
  scopePolicy: { scope: string; version: number };
  historyPolicy: { enabled: boolean };
  retentionPolicy: {
    version: 1;
    status: "experimental" | "approved";
    markdownCheckpointDays: number;
    attachmentVersionDays: number;
    changeReplayDays: number;
  };
  supportedFeatures: string[];
  changeCursor: string;
}

export interface VaultSyncOperationWindow {
  windowId: string;
  protocolEpoch: number;
  issuedAt: string;
  expiresAt: string;
  receiptRetentionUntil: string;
  maxOperations: number;
}

export interface VaultSyncV2DeviceSession {
  protocolEpoch: number;
  sessionGeneration: string;
  receivedCursor: string;
  appliedCursor: string;
}

export interface VaultSyncV2EventTicket {
  ticket: string;
  expiresAt: string;
  protocolEpoch: number;
  sessionGeneration: string;
}

export type VaultSyncV2Initialization =
  | { status: "owner"; protocolEpoch: number; scope: "whole_vault" | "root_folder"; scopeVersion: number; changeCursor: string; leaseId: string; leaseExpiresAt: string; requiresSnapshot: boolean }
  | { status: "waiting"; protocolEpoch: number; scope: "whole_vault" | "root_folder"; scopeVersion: number; changeCursor: string; leaseExpiresAt: string }
  | { status: "ready"; protocolEpoch: number; scope: "whole_vault" | "root_folder"; scopeVersion: number; changeCursor: string };

export interface VaultSyncV2ChangeItem {
  cursor: string;
  operationId: string;
  fileId: string;
  fileVersionId: string;
  eventType: "create" | "update" | "delete" | "restore" | "rename";
  createdByDeviceId: string;
  path: string;
  previousPath: string | null;
  previousVersionId: string | null;
  isDeleted: boolean;
  byteSize: number;
  mtimeMs: number;
  content: null | {
    kind: "object"; objectId: string; encryptionDomainId: string; keyVersion: number; ciphertextHash: string; byteSize: number;
  } | { kind: "legacy"; contentHash: string | null; byteSize: number };
}

export interface VaultSyncV2ChangePage {
  protocolEpoch: number;
  throughCursor: string;
  items: VaultSyncV2ChangeItem[];
  nextCursor: string;
  hasMore: boolean;
  minReplayCursor: string;
}

export interface VaultSyncV2SnapshotSummary {
  snapshotId: string;
  protocolEpoch: number;
  snapshotCursor: string;
  scope: string;
  scopeVersion: number;
  status: "building" | "ready";
  itemCount: string;
  expiresAt: string;
  completedAt: string | null;
}

export interface VaultSyncV2SnapshotApplyLease {
  snapshotId: string;
  leaseId: string;
  protocolEpoch: number;
  scopeVersion: number;
  expiresAt: string;
  reused: boolean;
}

export interface VaultSyncV2SnapshotItem {
  item: string;
  fileId: string;
  fileVersionId: string;
  changeCursor: string;
  path: string;
  isDeleted: boolean;
  byteSize: number;
  mtimeMs: number;
  createdByDeviceId: string | null;
  content: VaultSyncV2ChangeItem["content"];
}

export interface VaultSyncV2SnapshotPage extends VaultSyncV2SnapshotSummary {
  status: "building" | "ready";
  items: VaultSyncV2SnapshotItem[];
  nextItem: string;
  hasMore: boolean;
  minReplayCursor: string;
}

export interface VaultSyncV2Ack {
  protocolEpoch: number;
  sessionGeneration: string;
  receivedCursor: string;
  appliedCursor: string;
}

export interface VaultSyncV2AckResponse extends VaultSyncV2Ack {
  /** Present only when this ACK advanced appliedCursor and the server supports the opt-in diagnostic. */
  appliedLatencyMs?: number;
}

export interface VaultSyncV2DeviceProgress {
  protocolEpoch: number;
  changeCursor: string;
  devices: Array<{
    deviceId: string;
    deviceName: string;
    lastSyncAt: string | null;
    lastAckAt: string | null;
    receivedCursor: string | null;
    appliedCursor: string | null;
    changeCursor: string;
    state: "up_to_date" | "catching_up" | "unknown";
  }>;
}

export interface VaultSyncV2ObjectReservation {
  objectId: string;
  reservationId: string;
  encryptionDomainId: string;
  keyVersion: number;
  byteSize: number;
  ciphertextHash: string;
  uploadUrl: string | null;
  uploadExpiresAt: string;
  deduped: boolean;
}

export interface VaultSyncV2MultipartUploadSession {
  deduped: boolean;
  partSize: number | null;
  partCount: number;
  uploadedParts: Array<{ partNumber: number; byteSize: number }>;
  expiresAt: string;
}

export type VaultSyncV2ObjectBatchResult =
  | { index: number; status: "prepared"; objectId: string; reservationId: string; encryptionDomainId: string;
      keyVersion: number; byteSize: number; ciphertextHash: string; uploadUrl: string | null;
      uploadExpiresAt: string; deduped: boolean }
  | { index: number; status: "failed"; code: string };

export interface VaultSyncV2ReservationCancellation {
  reservationId: string;
  status: "cancelled" | "already_cancelled" | "already_finalized" | "unavailable";
}

export interface VaultSyncV2ObjectDownload {
  objectId: string;
  encryptionDomainId: string;
  keyVersion: number;
  ciphertextHash: string;
  byteSize: number;
  downloadUrl: string;
  leaseId: string;
  leaseExpiresAt: string;
}

export type VaultSyncV2EncryptionRotationStatus = "rewriting" | "ready_to_activate" | "activation_unknown" | "activated" | "complete" | "aborted";

export interface VaultSyncV2EncryptionRotation {
  rotationId: string;
  encryptionDomainId: string;
  operationId: string;
  sourceKeyVersion: number;
  targetKeyVersion: number;
  sourceSaltHex: string;
  targetSaltHex: string;
  inventoryHighWatermark: string;
  totalObjects: string;
  totalSourceBytes: string;
  completedObjects: string;
  completedSourceBytes: string;
  status: VaultSyncV2EncryptionRotationStatus;
  activationOperationId: string | null;
  activationReceiptId: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  completedAt: string | null;
}

export interface VaultSyncV2EncryptionRotationObject {
  sourceObjectId: string;
  sourceVersionId: string;
  sourceCiphertextHash: string;
  sourceByteSize: string;
  sourceRefCount: string;
  status: "pending" | "reserved" | "verified" | "switched";
  replacementOperationId: string | null;
  replacementObjectId: string | null;
  replacementReservationId: string | null;
  replacementCiphertextHash: string | null;
  replacementByteSize: string | null;
  providerVerifiedAt: string | null;
  switchedAt: string | null;
}

export interface VaultSyncV2EncryptionRotationObjectPage {
  rotationId: string;
  items: VaultSyncV2EncryptionRotationObject[];
  hasMore: boolean;
  nextAfterObjectId: string | null;
}

export interface VaultSyncV2EncryptionRotationReservation {
  rotationId: string;
  sourceObjectId: string;
  reservationId: string;
  objectId: string;
  encryptionDomainId: string;
  keyVersion: number;
  ciphertextHash: string;
  byteSize: number;
  status: "pending" | "verified" | "committed";
  deduped: boolean;
  uploadUrl: string | null;
  uploadExpiresAt: string;
}

export interface VaultSyncV2FileVersion {
  versionId: string;
  versionNumber: string;
  changeCursor: string;
  previousVersionId: string | null;
  path: string;
  isDeleted: boolean;
  byteSize: number;
  createdAt: string;
  createdByDeviceId: string | null;
  isCurrent: boolean;
  contentStatus: "object_referenced" | "legacy_unverified" | "unavailable" | "deleted" | "pruned";
  contentObjectId: string | null;
}

export interface VaultSyncV2FileVersionsPage {
  fileId: string;
  items: VaultSyncV2FileVersion[];
  hasMore: boolean;
  nextBeforeVersionNumber: string | null;
}

export type VaultSyncOperationResult =
  | { protocolVersion: 2; protocolEpoch: number; operationId: string; status: "committed"; fileId: string; fileVersionId: string; changeCursor: string; alreadyApplied: boolean }
  | { protocolVersion: 2; protocolEpoch: number; operationId: string; status: "conflict"; fileId: string; currentHead: { fileVersionId: string; changeCursor: string; path: string }; alreadyApplied: false };

type Request = (path: string, init: { method: string; token: "plugin" | "device"; body?: unknown; headers?: Record<string, string> }) => Promise<any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/i;

function invalidResponse(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function isDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] = match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const daysInMonth = new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate();
  if (numericMonth < 1 || numericMonth > 12 || numericDay < 1 || numericDay > daysInMonth
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone.toUpperCase() !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function parseAck(value: unknown): VaultSyncV2Ack {
  const fail = () => invalidResponse("invalid_ack_response", "同步确认响应不符合 Vault Sync v2 合同");
  if (!exactKeys(value, ["protocolEpoch", "sessionGeneration", "receivedCursor", "appliedCursor"])
    || !isSafeInteger(value.protocolEpoch, 1)
    || !isValidVaultSyncInt8Decimal(value.sessionGeneration, { allowZero: false })
    || !isValidVaultSyncInt8Decimal(value.receivedCursor)
    || !isValidVaultSyncInt8Decimal(value.appliedCursor)
    || BigInt(value.appliedCursor) > BigInt(value.receivedCursor)) throw fail();
  return value as VaultSyncV2Ack;
}

function parseAckResponse(value: unknown): VaultSyncV2AckResponse {
  const fail = () => invalidResponse("invalid_ack_response", "同步确认响应不符合 Vault Sync v2 合同");
  if (!isRecord(value)) throw fail();
  const hasLatency = Object.hasOwn(value, "appliedLatencyMs");
  if (!exactKeys(value, ["protocolEpoch", "sessionGeneration", "receivedCursor", "appliedCursor", ...(hasLatency ? ["appliedLatencyMs"] : [])])
    || (hasLatency && (!Number.isSafeInteger(value.appliedLatencyMs) || Number(value.appliedLatencyMs) < 0))) throw fail();
  const { appliedLatencyMs, ...ackValue } = value;
  const ack = parseAck(ackValue);
  return hasLatency ? { ...ack, appliedLatencyMs: Number(appliedLatencyMs) } : ack;
}

function parseContentRef(value: unknown): VaultSyncV2ChangeItem["content"] {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (value.kind === "object"
    && exactKeys(value, ["kind", "objectId", "encryptionDomainId", "keyVersion", "ciphertextHash", "byteSize"])
    && UUID.test(value.objectId) && UUID.test(value.encryptionDomainId)
    && isSafeInteger(value.keyVersion, 1) && SHA256.test(value.ciphertextHash)
    && isSafeInteger(value.byteSize)) return value as NonNullable<VaultSyncV2ChangeItem["content"]>;
  if (value.kind === "legacy"
    && exactKeys(value, ["kind", "contentHash", "byteSize"])
    && (value.contentHash === null || (typeof value.contentHash === "string" && SHA256.test(value.contentHash)))
    && isSafeInteger(value.byteSize)) return value as NonNullable<VaultSyncV2ChangeItem["content"]>;
  return null;
}

function isValidContentRef(value: unknown): boolean {
  return value === null || parseContentRef(value) !== null;
}

function contentSizeMatches(value: unknown, plaintextByteSize: number): boolean {
  const content = parseContentRef(value);
  if (!content) return false;
  // Object references describe stored ciphertext while the change/snapshot
  // byteSize is the Vault plaintext size. Only legacy references share the
  // plaintext size field and can be compared directly.
  return content.kind === "object" || content.byteSize === plaintextByteSize;
}

function hasConsistentChangeSemantics(item: Record<string, any>): boolean {
  if (item.isDeleted) {
    return item.eventType === "delete" && item.byteSize === 0 && item.content === null
      && item.previousPath === item.path && item.previousVersionId !== null;
  }
  if (item.eventType === "delete" || !contentSizeMatches(item.content, item.byteSize)) return false;
  if (item.eventType === "create") return item.previousPath === null && item.previousVersionId === null;
  if (item.previousVersionId === null) return false;
  if (item.eventType === "update") return item.previousPath === item.path;
  if (item.eventType === "rename") return item.previousPath !== null && item.previousPath !== item.path;
  return item.eventType === "restore";
}

function parseSnapshotSummary(value: unknown): VaultSyncV2SnapshotSummary {
  const fail = () => invalidResponse("invalid_snapshot_response", "同步快照响应不符合 Vault Sync v2 合同");
  if (!exactKeys(value, ["snapshotId", "protocolEpoch", "snapshotCursor", "scope", "scopeVersion", "status", "itemCount", "expiresAt", "completedAt"])
    || !UUID.test(value.snapshotId) || !isSafeInteger(value.protocolEpoch, 1)
    || !isValidVaultSyncInt8Decimal(value.snapshotCursor)
    || !["whole_vault", "root_folder"].includes(value.scope)
    || !isSafeInteger(value.scopeVersion, 1) || !["building", "ready"].includes(value.status)
    || !isValidVaultSyncInt8Decimal(value.itemCount) || !isDateTime(value.expiresAt)
    || !(value.completedAt === null || isDateTime(value.completedAt))
    || (value.status === "building" && value.completedAt !== null)
    || (value.status === "ready" && value.completedAt === null)) throw fail();
  return value as VaultSyncV2SnapshotSummary;
}

function parseSnapshotItem(value: unknown): VaultSyncV2SnapshotItem | null {
  if (!exactKeys(value, ["item", "fileId", "fileVersionId", "changeCursor", "path", "isDeleted", "byteSize", "mtimeMs", "createdByDeviceId", "content"])
    || !isValidVaultSyncInt8Decimal(value.item, { allowZero: false })
    || !UUID.test(value.fileId) || !UUID.test(value.fileVersionId)
    || !isValidVaultSyncInt8Decimal(value.changeCursor, { allowZero: false })
    || typeof value.path !== "string" || value.path.length === 0 || normalizeVaultPath(value.path) !== value.path
    || typeof value.isDeleted !== "boolean" || !isSafeInteger(value.byteSize) || !isSafeInteger(value.mtimeMs)
    || !(value.createdByDeviceId === null || (typeof value.createdByDeviceId === "string" && UUID.test(value.createdByDeviceId)))
    || !isValidContentRef(value.content)
    || (value.isDeleted ? value.byteSize !== 0 || value.content !== null : !contentSizeMatches(value.content, value.byteSize))) return null;
  return value as VaultSyncV2SnapshotItem;
}

function parseSnapshotPage(value: unknown, expected: { snapshotId: string; afterItem: string }): VaultSyncV2SnapshotPage {
  const fail = () => invalidResponse("invalid_snapshot_page", "同步快照分页响应不符合 Vault Sync v2 合同");
  const keys = ["snapshotId", "protocolEpoch", "snapshotCursor", "scope", "scopeVersion", "status", "itemCount", "expiresAt", "completedAt", "items", "nextItem", "hasMore", "minReplayCursor"];
  if (!exactKeys(value, keys) || typeof value.snapshotId !== "string"
    || value.snapshotId.toLowerCase() !== expected.snapshotId.toLowerCase() || !Array.isArray(value.items)
    || !isValidVaultSyncInt8Decimal(expected.afterItem)
    || !isValidVaultSyncInt8Decimal(value.nextItem)
    || typeof value.hasMore !== "boolean"
    || !isValidVaultSyncInt8Decimal(value.minReplayCursor)) throw fail();
  const summary = parseSnapshotSummary({
    snapshotId: value.snapshotId, protocolEpoch: value.protocolEpoch, snapshotCursor: value.snapshotCursor,
    scope: value.scope, scopeVersion: value.scopeVersion, status: value.status, itemCount: value.itemCount,
    expiresAt: value.expiresAt, completedAt: value.completedAt,
  });
  const items = value.items.map(parseSnapshotItem);
  if (items.some((item) => item === null)) throw fail();
  const after = BigInt(expected.afterItem);
  const next = BigInt(value.nextItem);
  const total = BigInt(summary.itemCount);
  if (summary.status === "building") {
    if (items.length !== 0 || next !== after || !value.hasMore) throw fail();
  } else {
    let expectedItem = after + 1n;
    for (const item of items as VaultSyncV2SnapshotItem[]) {
      if (BigInt(item.item) !== expectedItem || BigInt(item.changeCursor) > BigInt(summary.snapshotCursor)) throw fail();
      expectedItem++;
    }
    if ((items.length ? BigInt((items.at(-1) as VaultSyncV2SnapshotItem).item) : after) !== next
      || next > total || value.hasMore !== (next < total)) throw fail();
  }
  return { ...summary, items: items as VaultSyncV2SnapshotItem[], nextItem: value.nextItem,
    hasMore: value.hasMore, minReplayCursor: value.minReplayCursor };
}

function parseChangePage(value: unknown, expected: { protocolEpoch: number; after: string; through?: string }): VaultSyncV2ChangePage {
  const fail = () => invalidResponse("invalid_changes_response", "增量变更响应不符合 Vault Sync v2 合同");
  if (!exactKeys(value, ["protocolEpoch", "throughCursor", "items", "nextCursor", "hasMore", "minReplayCursor"])
    || value.protocolEpoch !== expected.protocolEpoch || !Array.isArray(value.items)
    || !isValidVaultSyncInt8Decimal(expected.after)
    || !isValidVaultSyncInt8Decimal(value.throughCursor)
    || (expected.through !== undefined && value.throughCursor !== expected.through)
    || !isValidVaultSyncInt8Decimal(value.nextCursor)
    || !isValidVaultSyncInt8Decimal(value.minReplayCursor) || typeof value.hasMore !== "boolean") throw fail();
  const after = BigInt(expected.after);
  const through = BigInt(value.throughCursor);
  let next = after;
  const items: VaultSyncV2ChangeItem[] = [];
  for (const item of value.items) {
    if (!exactKeys(item, ["cursor", "operationId", "fileId", "fileVersionId", "eventType", "createdByDeviceId", "path", "previousPath", "previousVersionId", "isDeleted", "byteSize", "mtimeMs", "content"])
      || !isValidVaultSyncInt8Decimal(item.cursor, { allowZero: false })
      || !UUID.test(item.operationId) || !UUID.test(item.fileId) || !UUID.test(item.fileVersionId)
      || !["create", "update", "delete", "restore", "rename"].includes(item.eventType)
      || !UUID.test(item.createdByDeviceId) || typeof item.path !== "string" || !item.path
      || normalizeVaultPath(item.path) !== item.path
      || !(item.previousPath === null || (typeof item.previousPath === "string" && normalizeVaultPath(item.previousPath) === item.previousPath))
      || !(item.previousVersionId === null || (typeof item.previousVersionId === "string" && UUID.test(item.previousVersionId)))
      || typeof item.isDeleted !== "boolean" || !isSafeInteger(item.byteSize) || !isSafeInteger(item.mtimeMs)
      || !isValidContentRef(item.content) || !hasConsistentChangeSemantics(item)) throw fail();
    const cursor = BigInt(item.cursor);
    if (cursor !== next + 1n || cursor > through) throw fail();
    next = cursor;
    items.push(item as VaultSyncV2ChangeItem);
  }
  if (BigInt(value.nextCursor) !== next || next > through || value.hasMore !== (next < through)) throw fail();
  return value as VaultSyncV2ChangePage;
}

function parseObjectDownload(value: unknown, expectedObjectId?: string): VaultSyncV2ObjectDownload {
  const fail = () => invalidResponse("invalid_content_object_response", "同步对象下载响应不符合合同");
  if (!exactKeys(value, ["object_id", "encryption_domain_id", "key_version", "ciphertext_hash", "byte_size", "download_url", "lease_id", "lease_expires_at"])
    || !UUID.test(value.object_id) || (expectedObjectId !== undefined && value.object_id.toLowerCase() !== expectedObjectId.toLowerCase())
    || !UUID.test(value.encryption_domain_id)
    || !isSafeInteger(value.key_version, 1) || !SHA256.test(value.ciphertext_hash) || !isSafeInteger(value.byte_size)
    || !isHttpUrl(value.download_url) || !UUID.test(value.lease_id) || !isDateTime(value.lease_expires_at)) throw fail();
  return { objectId: value.object_id, encryptionDomainId: value.encryption_domain_id, keyVersion: value.key_version,
    ciphertextHash: value.ciphertext_hash, byteSize: value.byte_size, downloadUrl: value.download_url,
    leaseId: value.lease_id, leaseExpiresAt: value.lease_expires_at };
}

function parseEncryptionRotation(value: unknown, expectedRotationId?: string): VaultSyncV2EncryptionRotation {
  const keys = ["rotation_id", "encryption_domain_id", "operation_id", "source_key_version", "target_key_version",
    "source_salt_hex", "target_salt_hex", "inventory_high_watermark", "total_objects", "total_source_bytes",
    "completed_objects", "completed_source_bytes", "status", "activation_operation_id", "activation_receipt_id",
    "created_at", "updated_at", "activated_at", "completed_at"];
  const fail = () => invalidResponse("invalid_key_rotation_response", "Vault 密钥轮换响应不符合合同");
  if (!exactKeys(value, keys) || !UUID.test(value.rotation_id)
    || (expectedRotationId !== undefined && value.rotation_id.toLowerCase() !== expectedRotationId.toLowerCase())
    || !UUID.test(value.encryption_domain_id) || !UUID.test(value.operation_id)
    || !isSafeInteger(value.source_key_version, 1) || value.target_key_version !== value.source_key_version + 1
    || typeof value.source_salt_hex !== "string" || !/^(?:[a-f0-9]{2}){16,64}$/i.test(value.source_salt_hex)
    || typeof value.target_salt_hex !== "string" || !/^(?:[a-f0-9]{2}){16,64}$/i.test(value.target_salt_hex)
    || value.source_salt_hex.toLowerCase() === value.target_salt_hex.toLowerCase()
    || !isValidVaultSyncInt8Decimal(value.inventory_high_watermark)
    || !isValidVaultSyncInt8Decimal(value.total_objects)
    || !isValidVaultSyncInt8Decimal(value.total_source_bytes)
    || !isValidVaultSyncInt8Decimal(value.completed_objects)
    || !isValidVaultSyncInt8Decimal(value.completed_source_bytes)
    || !["rewriting", "ready_to_activate", "activation_unknown", "activated", "complete", "aborted"].includes(value.status)
    || !(value.activation_operation_id === null || UUID.test(value.activation_operation_id))
    || !(value.activation_receipt_id === null || UUID.test(value.activation_receipt_id))
    || !isDateTime(value.created_at) || !isDateTime(value.updated_at)
    || !(value.activated_at === null || isDateTime(value.activated_at))
    || !(value.completed_at === null || isDateTime(value.completed_at))) throw fail();
  if ((value.activation_operation_id === null) !== (value.activation_receipt_id === null)
    || (["activated", "complete"].includes(value.status) !== (value.activation_operation_id !== null))
    || (value.status === "complete") !== (value.completed_at !== null)
    || BigInt(value.completed_objects) > BigInt(value.total_objects)
    || BigInt(value.completed_source_bytes) > BigInt(value.total_source_bytes)) throw fail();
  return {
    rotationId: value.rotation_id, encryptionDomainId: value.encryption_domain_id,
    operationId: value.operation_id, sourceKeyVersion: value.source_key_version,
    targetKeyVersion: value.target_key_version, sourceSaltHex: value.source_salt_hex.toLowerCase(),
    targetSaltHex: value.target_salt_hex.toLowerCase(), inventoryHighWatermark: value.inventory_high_watermark,
    totalObjects: value.total_objects, totalSourceBytes: value.total_source_bytes,
    completedObjects: value.completed_objects, completedSourceBytes: value.completed_source_bytes,
    status: value.status, activationOperationId: value.activation_operation_id,
    activationReceiptId: value.activation_receipt_id, createdAt: value.created_at,
    updatedAt: value.updated_at, activatedAt: value.activated_at, completedAt: value.completed_at,
  };
}

function parseEncryptionRotationObjectPage(value: unknown, expected: { rotationId: string; after: string | null }): VaultSyncV2EncryptionRotationObjectPage {
  const fail = () => invalidResponse("invalid_key_rotation_inventory", "密钥轮换对象清单不符合合同");
  if (!exactKeys(value, ["rotation_id", "items", "has_more", "next_after_object_id"])
    || !UUID.test(value.rotation_id) || value.rotation_id.toLowerCase() !== expected.rotationId.toLowerCase()
    || !Array.isArray(value.items) || value.items.length > 100 || typeof value.has_more !== "boolean"
    || !(value.next_after_object_id === null || UUID.test(value.next_after_object_id))) throw fail();
  const items: VaultSyncV2EncryptionRotationObject[] = [];
  let previousId = expected.after?.toLowerCase() ?? null;
  for (const item of value.items) {
    if (!exactKeys(item, ["source_object_id", "source_version_id", "source_ciphertext_hash", "source_byte_size",
      "source_ref_count", "status", "replacement_operation_id", "replacement_object_id", "replacement_reservation_id",
      "replacement_ciphertext_hash", "replacement_byte_size", "provider_verified_at", "switched_at"])
      || !UUID.test(item.source_object_id) || !UUID.test(item.source_version_id)
      || (previousId !== null && item.source_object_id.toLowerCase() <= previousId)
      || !SHA256.test(item.source_ciphertext_hash)
      || !isValidVaultSyncInt8Decimal(item.source_byte_size)
      || BigInt(item.source_byte_size) > BigInt(Number.MAX_SAFE_INTEGER)
      || !isValidVaultSyncInt8Decimal(item.source_ref_count, { allowZero: false })
      || !["pending", "reserved", "verified", "switched"].includes(item.status)
      || !(item.replacement_operation_id === null || UUID.test(item.replacement_operation_id))
      || !(item.replacement_object_id === null || UUID.test(item.replacement_object_id))
      || !(item.replacement_reservation_id === null || UUID.test(item.replacement_reservation_id))
      || !(item.replacement_ciphertext_hash === null || SHA256.test(item.replacement_ciphertext_hash))
      || !(item.replacement_byte_size === null || isValidVaultSyncInt8Decimal(item.replacement_byte_size))
      || !(item.provider_verified_at === null || isDateTime(item.provider_verified_at))
      || !(item.switched_at === null || isDateTime(item.switched_at))) throw fail();
    if (item.status === "pending"
      ? item.replacement_operation_id !== null || item.replacement_object_id !== null || item.replacement_reservation_id !== null
        || item.replacement_ciphertext_hash !== null || item.replacement_byte_size !== null
        || item.provider_verified_at !== null || item.switched_at !== null
      : item.status === "reserved"
        ? !item.replacement_operation_id || item.replacement_object_id !== null || !item.replacement_reservation_id
          || !item.replacement_ciphertext_hash || item.replacement_byte_size === null
          || item.provider_verified_at !== null || item.switched_at !== null
        : !item.replacement_operation_id || !item.replacement_object_id || !item.replacement_reservation_id
          || !item.replacement_ciphertext_hash || item.replacement_byte_size === null
          || !item.provider_verified_at || (item.status === "verified" && item.switched_at !== null)
          || (item.status === "switched" && item.switched_at === null)) throw fail();
    previousId = item.source_object_id.toLowerCase();
    items.push({
      sourceObjectId: item.source_object_id, sourceVersionId: item.source_version_id,
      sourceCiphertextHash: item.source_ciphertext_hash, sourceByteSize: item.source_byte_size,
      sourceRefCount: item.source_ref_count, status: item.status, replacementOperationId: item.replacement_operation_id,
      replacementObjectId: item.replacement_object_id, replacementReservationId: item.replacement_reservation_id,
      replacementCiphertextHash: item.replacement_ciphertext_hash, replacementByteSize: item.replacement_byte_size,
      providerVerifiedAt: item.provider_verified_at, switchedAt: item.switched_at,
    });
  }
  const next = items.at(-1)?.sourceObjectId ?? expected.after;
  if (value.next_after_object_id !== (value.has_more ? next : null)
    || (value.has_more && (items.length === 0 || next === expected.after))) throw fail();
  return { rotationId: value.rotation_id, items, hasMore: value.has_more, nextAfterObjectId: value.next_after_object_id };
}

function parseEncryptionRotationReservation(value: unknown, expected: {
  rotationId: string; sourceObjectId: string; ciphertextHash: string; byteSize: number; keyVersion: number;
}): VaultSyncV2EncryptionRotationReservation {
  const fail = () => invalidResponse("invalid_key_rotation_reservation", "密钥轮换对象 reservation 不符合合同");
  if (!exactKeys(value, ["rotation_id", "source_object_id", "reservation_id", "object_id", "encryption_domain_id",
    "key_version", "ciphertext_hash", "byte_size", "status", "deduped", "upload_url", "upload_expires_at"])
    || !UUID.test(value.rotation_id) || value.rotation_id.toLowerCase() !== expected.rotationId.toLowerCase()
    || !UUID.test(value.source_object_id) || value.source_object_id.toLowerCase() !== expected.sourceObjectId.toLowerCase()
    || !UUID.test(value.reservation_id) || !UUID.test(value.object_id) || !UUID.test(value.encryption_domain_id)
    || value.key_version !== expected.keyVersion || value.ciphertext_hash !== expected.ciphertextHash
    || value.byte_size !== expected.byteSize || !["pending", "verified", "committed"].includes(value.status)
    || typeof value.deduped !== "boolean" || !(value.upload_url === null || isHttpUrl(value.upload_url))
    || !isDateTime(value.upload_expires_at)
    || (value.status === "pending") !== (value.upload_url !== null)) throw fail();
  return {
    rotationId: value.rotation_id, sourceObjectId: value.source_object_id,
    reservationId: value.reservation_id, objectId: value.object_id,
    encryptionDomainId: value.encryption_domain_id, keyVersion: value.key_version,
    ciphertextHash: value.ciphertext_hash, byteSize: value.byte_size,
    status: value.status, deduped: value.deduped, uploadUrl: value.upload_url,
    uploadExpiresAt: value.upload_expires_at,
  };
}

function invalidOperationResponse(receipt = false): Error & { code: string } {
  const code = receipt ? "invalid_operation_receipt" : "invalid_operation_response";
  return Object.assign(new Error(receipt ? "操作回执不符合 Vault Sync v2 合同" : "操作结果不符合 Vault Sync v2 合同"), { code });
}

function parseOperationWindow(value: unknown): VaultSyncOperationWindow {
  const fail = () => Object.assign(new Error("操作窗口响应不符合 Vault Sync v2 合同"), { code: "invalid_operation_window" });
  if (!exactKeys(value, ["windowId", "protocolEpoch", "issuedAt", "expiresAt", "receiptRetentionUntil", "maxOperations"])
    || !UUID.test(value.windowId)
    || !Number.isSafeInteger(value.protocolEpoch) || value.protocolEpoch < 1
    || !Number.isSafeInteger(value.maxOperations) || value.maxOperations < 1 || value.maxOperations > 1000
    || !isDateTime(value.issuedAt) || !isDateTime(value.expiresAt) || !isDateTime(value.receiptRetentionUntil)) throw fail();
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  const retention = Date.parse(value.receiptRetentionUntil);
  if (![issuedAt, expiresAt, retention].every(Number.isFinite) || expiresAt <= issuedAt || retention < expiresAt) throw fail();
  return value as VaultSyncOperationWindow;
}

function parseDeviceSession(value: unknown): VaultSyncV2DeviceSession {
  const fail = () => Object.assign(new Error("设备会话响应不符合 Vault Sync v2 合同"), { code: "invalid_device_session" });
  if (!exactKeys(value, ["protocolEpoch", "sessionGeneration", "receivedCursor", "appliedCursor"])
    || !Number.isSafeInteger(value.protocolEpoch) || value.protocolEpoch < 1
    || !isValidVaultSyncInt8Decimal(value.sessionGeneration, { allowZero: false })
    || !isValidVaultSyncInt8Decimal(value.receivedCursor)
    || !isValidVaultSyncInt8Decimal(value.appliedCursor)
    || BigInt(value.appliedCursor) > BigInt(value.receivedCursor)) throw fail();
  return value as VaultSyncV2DeviceSession;
}

function parseInitialization(value: unknown): VaultSyncV2Initialization {
  const common = ["status", "protocolEpoch", "scope", "scopeVersion", "changeCursor"];
  const validCommon = isRecord(value) && isSafeInteger(value.protocolEpoch, 1)
    && ["whole_vault", "root_folder"].includes(value.scope)
    && isSafeInteger(value.scopeVersion, 1)
    && isValidVaultSyncInt8Decimal(value.changeCursor);
  if (!validCommon) throw invalidResponse("invalid_initialization_response", "Vault 初始化状态响应不符合合同");
  if (value.status === "owner" && exactKeys(value, [...common, "leaseId", "leaseExpiresAt", "requiresSnapshot"])
    && UUID.test(value.leaseId) && isDateTime(value.leaseExpiresAt) && typeof value.requiresSnapshot === "boolean") {
    return { ...value, leaseId: value.leaseId.toLowerCase() } as VaultSyncV2Initialization;
  }
  if (value.status === "waiting" && exactKeys(value, [...common, "leaseExpiresAt"])
    && isDateTime(value.leaseExpiresAt)) return value as VaultSyncV2Initialization;
  if (value.status === "ready" && exactKeys(value, common)) return value as VaultSyncV2Initialization;
  throw invalidResponse("invalid_initialization_response", "Vault 初始化状态响应不符合合同");
}

function parseOperationResult(
  value: unknown,
  expected: { operationId: string; fileId?: string; protocolEpoch?: number },
  receipt = false,
): VaultSyncOperationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidOperationResponse(receipt);
  const result = value as Record<string, any>;
  const common = result.protocolVersion === 2 && Number.isSafeInteger(result.protocolEpoch) && result.protocolEpoch >= 1
    && result.operationId === expected.operationId.toLowerCase()
    && UUID.test(String(result.fileId))
    && (expected.fileId === undefined || result.fileId === expected.fileId.toLowerCase())
    && (expected.protocolEpoch === undefined || result.protocolEpoch === expected.protocolEpoch);
  if (!common) throw invalidOperationResponse(receipt);
  if (result.status === "committed"
    && exactKeys(result, ["protocolVersion", "protocolEpoch", "operationId", "status", "fileId", "fileVersionId", "changeCursor", "alreadyApplied"])
    && UUID.test(result.fileVersionId) && isValidVaultSyncInt8Decimal(result.changeCursor)
    && typeof result.alreadyApplied === "boolean") {
    return result as VaultSyncOperationResult;
  }
  if (result.status === "conflict"
    && exactKeys(result, ["protocolVersion", "protocolEpoch", "operationId", "status", "fileId", "currentHead", "alreadyApplied"])
    && exactKeys(result.currentHead, ["fileVersionId", "changeCursor", "path"])
    && UUID.test(result.currentHead.fileVersionId)
    && isValidVaultSyncInt8Decimal(result.currentHead.changeCursor)
    && typeof result.currentHead.path === "string"
    && normalizeVaultPath(result.currentHead.path) === result.currentHead.path
    && result.alreadyApplied === false) {
    return result as VaultSyncOperationResult;
  }
  throw invalidOperationResponse(receipt);
}

export class VaultSyncV2RemoteClient {
  constructor(private targetId: string, private request: Request) {}

  async startEncryptionKeyRotation(input: {
    operationId: string; sourceKeyVersion: number; sourceSaltHex: string;
    targetKeyVersion: number; targetSaltHex: string;
  }): Promise<VaultSyncV2EncryptionRotation> {
    if (!UUID.test(input.operationId) || !isSafeInteger(input.sourceKeyVersion, 1)
      || input.targetKeyVersion !== input.sourceKeyVersion + 1
      || !/^(?:[a-f0-9]{2}){16,64}$/i.test(input.sourceSaltHex)
      || !/^(?:[a-f0-9]{2}){16,64}$/i.test(input.targetSaltHex)
      || input.sourceSaltHex.toLowerCase() === input.targetSaltHex.toLowerCase()) {
      throw invalidResponse("invalid_key_rotation_request", "密钥轮换参数无效");
    }
    const response = await this.request(`/api/sync-targets/${this.targetId}/vault/keys/rotations`, {
      method: "POST", token: "device", body: {
        operation_id: input.operationId.toLowerCase(), source_key_version: input.sourceKeyVersion,
        source_salt_hex: input.sourceSaltHex.toLowerCase(), target_key_version: input.targetKeyVersion,
        target_salt_hex: input.targetSaltHex.toLowerCase(),
      },
    });
    const rotation = parseEncryptionRotation(response);
    if (rotation.operationId.toLowerCase() !== input.operationId.toLowerCase()
      || rotation.sourceKeyVersion !== input.sourceKeyVersion || rotation.targetKeyVersion !== input.targetKeyVersion
      || rotation.sourceSaltHex !== input.sourceSaltHex.toLowerCase()
      || rotation.targetSaltHex !== input.targetSaltHex.toLowerCase()) {
      throw invalidResponse("invalid_key_rotation_response", "服务端轮换清单与本机请求不一致");
    }
    return rotation;
  }

  async getEncryptionKeyRotation(rotationId: string): Promise<VaultSyncV2EncryptionRotation> {
    if (!UUID.test(rotationId)) throw invalidResponse("invalid_key_rotation_request", "密钥轮换 ID 无效");
    return parseEncryptionRotation(await this.request(
      `/api/sync-targets/${this.targetId}/vault/keys/rotations/${rotationId}`,
      { method: "GET", token: "device" },
    ), rotationId);
  }

  async listEncryptionKeyRotationObjects(input: { rotationId: string; after?: string | null; limit?: number }): Promise<VaultSyncV2EncryptionRotationObjectPage> {
    const after = input.after ?? null;
    const limit = input.limit ?? 100;
    if (!UUID.test(input.rotationId) || (after !== null && !UUID.test(after)) || !isSafeInteger(limit, 1, 100)) {
      throw invalidResponse("invalid_key_rotation_request", "密钥轮换清单分页参数无效");
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (after) query.set("after", after.toLowerCase());
    return parseEncryptionRotationObjectPage(await this.request(
      `/api/sync-targets/${this.targetId}/vault/keys/rotations/${input.rotationId}/objects?${query}`,
      { method: "GET", token: "device" },
    ), { rotationId: input.rotationId, after });
  }

  async getEncryptionRotationSourceContent(input: { rotationId: string; sourceObjectId: string }): Promise<VaultSyncV2ObjectDownload> {
    if (!UUID.test(input.rotationId) || !UUID.test(input.sourceObjectId)) {
      throw invalidResponse("invalid_key_rotation_request", "密钥轮换源对象参数无效");
    }
    return parseObjectDownload(await this.request(
      `/api/sync-targets/${this.targetId}/vault/keys/rotations/${input.rotationId}/objects/${input.sourceObjectId}/content`,
      { method: "GET", token: "device" },
    ), input.sourceObjectId);
  }

  async prepareEncryptionRotationObject(input: {
    rotationId: string; sourceObjectId: string; operationId: string;
    ciphertextHash: string; byteSize: number; keyVersion: number;
  }): Promise<VaultSyncV2EncryptionRotationReservation> {
    if (!UUID.test(input.rotationId) || !UUID.test(input.sourceObjectId) || !UUID.test(input.operationId)
      || !SHA256.test(input.ciphertextHash) || !isSafeInteger(input.byteSize)
      || !isSafeInteger(input.keyVersion, 1)) {
      throw invalidResponse("invalid_key_rotation_request", "密钥轮换对象 reservation 参数无效");
    }
    return parseEncryptionRotationReservation(await this.request(
      `/api/sync-targets/${this.targetId}/vault/keys/rotations/${input.rotationId}/objects/${input.sourceObjectId}/reservations`,
      { method: "POST", token: "device", body: {
        operation_id: input.operationId.toLowerCase(), ciphertext_hash: input.ciphertextHash.toLowerCase(), byte_size: input.byteSize,
      } },
    ), { ...input, ciphertextHash: input.ciphertextHash.toLowerCase() });
  }

  async finalizeEncryptionRotationObject(input: {
    rotationId: string; sourceObjectId: string; reservationId: string;
  }): Promise<{ rotationId: string; sourceObjectId: string; objectId: string; status: "switched"; alreadySwitched: boolean; completedObjects: string | null; totalObjects: string | null }> {
    if (!UUID.test(input.rotationId) || !UUID.test(input.sourceObjectId) || !UUID.test(input.reservationId)) {
      throw invalidResponse("invalid_key_rotation_request", "密钥轮换 finalize 参数无效");
    }
    const value = await this.request(
      `/api/sync-targets/${this.targetId}/vault/keys/rotations/${input.rotationId}/objects/${input.sourceObjectId}/finalize`,
      { method: "POST", token: "device", body: { reservation_id: input.reservationId.toLowerCase() } },
    );
    if (!exactKeys(value, ["rotation_id", "source_object_id", "object_id", "status", "already_switched", "completed_objects", "total_objects"])
      || !UUID.test(value.rotation_id) || value.rotation_id.toLowerCase() !== input.rotationId.toLowerCase()
      || !UUID.test(value.source_object_id) || value.source_object_id.toLowerCase() !== input.sourceObjectId.toLowerCase()
      || !UUID.test(value.object_id) || value.status !== "switched" || typeof value.already_switched !== "boolean"
      || !(value.completed_objects === null || isValidVaultSyncInt8Decimal(value.completed_objects))
      || !(value.total_objects === null || isValidVaultSyncInt8Decimal(value.total_objects))) {
      throw invalidResponse("invalid_key_rotation_finalize", "密钥轮换对象切换回执不符合合同");
    }
    return { rotationId: value.rotation_id, sourceObjectId: value.source_object_id, objectId: value.object_id,
      status: "switched", alreadySwitched: value.already_switched,
      completedObjects: value.completed_objects, totalObjects: value.total_objects };
  }

  async activateEncryptionKeyRotation(input: { rotationId: string; operationId: string }): Promise<VaultSyncV2EncryptionRotation> {
    if (!UUID.test(input.rotationId) || !UUID.test(input.operationId)) {
      throw invalidResponse("invalid_key_rotation_request", "密钥轮换激活参数无效");
    }
    const rotation = parseEncryptionRotation(await this.request(
      `/api/sync-targets/${this.targetId}/vault/keys/rotations/${input.rotationId}/activate`,
      { method: "POST", token: "device", body: { operation_id: input.operationId.toLowerCase() } },
    ), input.rotationId);
    if (rotation.status !== "activated" && rotation.status !== "complete") {
      throw invalidResponse("invalid_key_rotation_activation", "服务端没有确认密钥激活");
    }
    if (rotation.activationOperationId?.toLowerCase() !== input.operationId.toLowerCase()
      || !rotation.activationReceiptId) throw invalidResponse("invalid_key_rotation_activation", "密钥激活回执与请求不一致");
    return rotation;
  }

  async completeEncryptionKeyRotation(rotationId: string): Promise<{ rotationId: string; status: "activated" | "complete"; remainingSourceObjects: string; completed: boolean }> {
    if (!UUID.test(rotationId)) throw invalidResponse("invalid_key_rotation_request", "密钥轮换 ID 无效");
    const value = await this.request(`/api/sync-targets/${this.targetId}/vault/keys/rotations/${rotationId}/complete`, {
      method: "POST", token: "device", body: {},
    });
    if (!exactKeys(value, ["rotationId", "status", "remainingSourceObjects", "completed"])
      || !UUID.test(value.rotationId) || value.rotationId.toLowerCase() !== rotationId.toLowerCase()
      || !["activated", "complete"].includes(value.status)
      || !isValidVaultSyncInt8Decimal(value.remainingSourceObjects)
      || typeof value.completed !== "boolean"
      || (value.completed !== (value.status === "complete" && value.remainingSourceObjects === "0"))) {
      throw invalidResponse("invalid_key_rotation_completion", "密钥轮换清理回执不符合合同");
    }
    return value as { rotationId: string; status: "activated" | "complete"; remainingSourceObjects: string; completed: boolean };
  }

  async abortEncryptionKeyRotation(rotationId: string): Promise<{ rotationId: string; status: "aborted"; alreadyAborted: boolean }> {
    if (!UUID.test(rotationId)) throw invalidResponse("invalid_key_rotation_request", "密钥轮换 ID 无效");
    const value = await this.request(`/api/sync-targets/${this.targetId}/vault/keys/rotations/${rotationId}/abort`, {
      method: "POST", token: "device", body: {},
    });
    if (!exactKeys(value, ["rotationId", "status", "alreadyAborted"])
      || !UUID.test(value.rotationId) || value.rotationId.toLowerCase() !== rotationId.toLowerCase()
      || value.status !== "aborted" || typeof value.alreadyAborted !== "boolean") {
      throw invalidResponse("invalid_key_rotation_abort", "密钥轮换中止回执不符合合同");
    }
    return value as { rotationId: string; status: "aborted"; alreadyAborted: boolean };
  }

  async getCapabilities(): Promise<VaultSyncCapabilities> {
    const value = await this.request("/api/sync-targets/" + this.targetId + "/vault/capabilities?retention_policy_version=1", { method: "GET", token: "plugin" });
    const keys = ["protocolVersion", "activeProtocolVersion", "protocolEpoch", "minimumWriterVersion", "canRead", "canWrite", "baselineReady", "v2WriteEnabled", "v2WriteAvailable", "scopePolicy", "historyPolicy", "retentionPolicy", "supportedFeatures", "changeCursor"];
    if (!exactKeys(value, keys) || value.protocolVersion !== 2 || ![1, 2].includes(value.activeProtocolVersion)
      || !isSafeInteger(value.protocolEpoch, 1) || !isSafeInteger(value.minimumWriterVersion, 1)
      || [value.canRead, value.canWrite, value.baselineReady, value.v2WriteEnabled, value.v2WriteAvailable].some((item) => typeof item !== "boolean")
      || !exactKeys(value.scopePolicy, ["scope", "version"]) || !["whole_vault", "root_folder"].includes(value.scopePolicy.scope)
      || !isSafeInteger(value.scopePolicy.version, 1)
      || !exactKeys(value.historyPolicy, ["enabled"]) || typeof value.historyPolicy.enabled !== "boolean"
      || !exactKeys(value.retentionPolicy, ["version", "status", "markdownCheckpointDays", "attachmentVersionDays", "changeReplayDays"])
      || value.retentionPolicy.version !== 1 || !["experimental", "approved"].includes(value.retentionPolicy.status)
      || !isSafeInteger(value.retentionPolicy.markdownCheckpointDays, 1, 3650)
      || !isSafeInteger(value.retentionPolicy.attachmentVersionDays, 1, 3650)
      || !isSafeInteger(value.retentionPolicy.changeReplayDays, 1, 3650)
      || !Array.isArray(value.supportedFeatures) || value.supportedFeatures.some((item: unknown) => typeof item !== "string" || item.length === 0)
      || new Set(value.supportedFeatures).size !== value.supportedFeatures.length
      || !isValidVaultSyncInt8Decimal(value.changeCursor)) {
      throw invalidResponse("invalid_capabilities_response", "Vault Sync 能力响应不符合合同");
    }
    if (value.activeProtocolVersion === 1 && value.canWrite) {
      throw invalidResponse("invalid_capabilities_response", "Vault Sync 能力响应包含矛盾的协议状态");
    }
    return value as VaultSyncCapabilities;
  }

  async getDeviceProgress(): Promise<VaultSyncV2DeviceProgress> {
    const value = await this.request("/api/sync-targets/" + this.targetId + "/vault/devices/progress", { method: "GET", token: "plugin" });
    if (!exactKeys(value, ["protocolEpoch", "changeCursor", "devices"]) || !isSafeInteger(value.protocolEpoch, 1)
      || !isValidVaultSyncInt8Decimal(value.changeCursor) || !Array.isArray(value.devices) || value.devices.length > 100) {
      throw invalidResponse("invalid_device_progress", "设备同步进度响应不符合合同");
    }
    const seenDeviceIds = new Set<string>();
    for (const device of value.devices) {
      if (!exactKeys(device, ["deviceId", "deviceName", "lastSyncAt", "lastAckAt", "receivedCursor", "appliedCursor", "changeCursor", "state"])
        || !UUID.test(device.deviceId) || typeof device.deviceName !== "string"
        || !(device.lastSyncAt === null || isDateTime(device.lastSyncAt))
        || !(device.lastAckAt === null || isDateTime(device.lastAckAt))
        || !(device.receivedCursor === null || isValidVaultSyncInt8Decimal(device.receivedCursor))
        || !(device.appliedCursor === null || isValidVaultSyncInt8Decimal(device.appliedCursor))
        || !isValidVaultSyncInt8Decimal(device.changeCursor)
        || !["up_to_date", "catching_up", "unknown"].includes(device.state)) {
        throw invalidResponse("invalid_device_progress", "设备同步进度响应不符合合同");
      }
      if (device.changeCursor !== value.changeCursor) {
        throw invalidResponse("invalid_device_progress", "设备进度游标与 Vault 当前游标不一致");
      }
      if (seenDeviceIds.has(device.deviceId.toLowerCase())) {
        throw invalidResponse("invalid_device_progress", "设备进度响应包含重复设备");
      }
      seenDeviceIds.add(device.deviceId.toLowerCase());
      if (device.state === "unknown" && (device.receivedCursor !== null || device.appliedCursor !== null || device.lastAckAt !== null)) {
        throw invalidResponse("invalid_device_progress", "未知设备状态不得携带已确认游标");
      }
      if (device.appliedCursor !== null && device.receivedCursor !== null
        && BigInt(device.appliedCursor) > BigInt(device.receivedCursor)) {
        throw invalidResponse("invalid_device_progress", "设备 applied cursor 超过 received cursor");
      }
      if (device.state === "up_to_date" && (device.appliedCursor === null
        || BigInt(device.appliedCursor) < BigInt(device.changeCursor))) {
        throw invalidResponse("invalid_device_progress", "已追平设备的 applied cursor 仍落后于 Vault");
      }
      if (device.state === "catching_up" && (device.appliedCursor === null
        || BigInt(device.appliedCursor) >= BigInt(device.changeCursor))) {
        throw invalidResponse("invalid_device_progress", "追赶中设备的 applied cursor 已达到 Vault 游标");
      }
    }
    return value as VaultSyncV2DeviceProgress;
  }

  async createOperationWindow(): Promise<VaultSyncOperationWindow> {
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/operation-windows", {
      method: "POST", token: "device", body: {},
    });
    return parseOperationWindow(response);
  }

  async startDeviceSession(): Promise<VaultSyncV2DeviceSession> {
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/sessions", {
      method: "POST", token: "device", body: {},
    });
    return parseDeviceSession(response);
  }

  async claimInitialization(protocolEpoch: number): Promise<VaultSyncV2Initialization> {
    if (!isSafeInteger(protocolEpoch, 1)) {
      throw invalidResponse("initialization_request_invalid", "Vault 初始化协议代数无效");
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/initialization/claim", {
      method: "POST", token: "device", body: { protocolEpoch },
    });
    const state = parseInitialization(response);
    if (state.protocolEpoch !== protocolEpoch) {
      throw invalidResponse("invalid_initialization_response", "Vault 初始化状态与请求协议代数不一致");
    }
    return state;
  }

  async completeInitialization(input: { protocolEpoch: number; leaseId: string }): Promise<VaultSyncV2Initialization> {
    if (!exactKeys(input, ["protocolEpoch", "leaseId"]) || !isSafeInteger(input.protocolEpoch, 1) || !UUID.test(input.leaseId)) {
      throw invalidResponse("initialization_request_invalid", "Vault 初始化完成参数无效");
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/initialization/complete", {
      method: "POST", token: "device", body: { protocolEpoch: input.protocolEpoch, leaseId: input.leaseId.toLowerCase() },
    });
    const state = parseInitialization(response);
    if (state.status !== "ready" || state.protocolEpoch !== input.protocolEpoch) {
      throw invalidResponse("invalid_initialization_response", "Vault 初始化完成回执不符合请求");
    }
    return state;
  }

  async createEventTicket(): Promise<VaultSyncV2EventTicket> {
    const value = await this.request("/api/sync-targets/" + this.targetId + "/vault/events/ticket", { method: "POST", token: "device", body: {} });
    if (!exactKeys(value, ["ticket", "expiresAt", "protocolEpoch", "sessionGeneration"])
      || typeof value.ticket !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(value.ticket)
      || !isDateTime(value.expiresAt) || !isSafeInteger(value.protocolEpoch, 1)
      || !isValidVaultSyncInt8Decimal(value.sessionGeneration, { allowZero: false })) {
      throw invalidResponse("invalid_event_ticket", "同步事件票据响应不符合合同");
    }
    return value as VaultSyncV2EventTicket;
  }

  async getChanges(input: { protocolEpoch: number; sessionGeneration: string; after: string; through?: string; limit?: number }): Promise<VaultSyncV2ChangePage> {
    if (!isSafeInteger(input.protocolEpoch, 1) || !isValidVaultSyncInt8Decimal(input.sessionGeneration, { allowZero: false })
      || !isValidVaultSyncInt8Decimal(input.after)
      || (input.through !== undefined && !isValidVaultSyncInt8Decimal(input.through))
      || (input.through !== undefined && BigInt(input.through) < BigInt(input.after))
      || (input.limit !== undefined && !isSafeInteger(input.limit, 1, 500))) {
      throw invalidResponse("invalid_change_request", "增量同步请求参数无效");
    }
    const query = new URLSearchParams({
      protocolEpoch: String(input.protocolEpoch),
      sessionGeneration: input.sessionGeneration,
      after: input.after,
      limit: String(input.limit ?? 100),
    });
    if (input.through !== undefined) query.set("through", input.through);
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/changes?" + query.toString(), { method: "GET", token: "device" });
    return parseChangePage(response, { protocolEpoch: input.protocolEpoch, after: input.after, through: input.through });
  }

  async createSnapshot(input: { protocolEpoch: number; sessionGeneration: string; snapshotRequestId?: string }): Promise<VaultSyncV2SnapshotSummary> {
    const hasRequestId = Object.prototype.hasOwnProperty.call(input, "snapshotRequestId");
    if (!exactKeys(input, hasRequestId
      ? ["protocolEpoch", "sessionGeneration", "snapshotRequestId"]
      : ["protocolEpoch", "sessionGeneration"])
      || !isSafeInteger(input.protocolEpoch, 1) || !isValidVaultSyncInt8Decimal(input.sessionGeneration, { allowZero: false })
      || (hasRequestId && (typeof input.snapshotRequestId !== "string" || !UUID.test(input.snapshotRequestId)))) {
      throw invalidResponse("invalid_snapshot_request", "同步快照请求参数无效");
    }
    const path = "/api/sync-targets/" + this.targetId + "/vault/snapshots";
    let response: unknown;
    try {
      response = await this.request(path, { method: "POST", token: "device", body: input });
    } catch (error: any) {
      const requestIdUnsupported = hasRequestId
        && ["invalid_snapshot_request", "snapshot_request_invalid"].includes(String(error?.code ?? ""));
      if (!requestIdUnsupported) throw error;
      // Older servers require the original two-key request shape. Their
      // validation rejects before creating a snapshot, so retrying without
      // the optional id preserves client/server compatibility during rollout.
      response = await this.request(path, {
        method: "POST", token: "device",
        body: { protocolEpoch: input.protocolEpoch, sessionGeneration: input.sessionGeneration },
      });
    }
    const summary = parseSnapshotSummary(response);
    if (summary.protocolEpoch !== input.protocolEpoch) throw invalidResponse("invalid_snapshot_response", "快照协议代数与请求不一致");
    return summary;
  }

  async getSnapshotPage(input: { snapshotId: string; afterItem?: string; limit?: number }): Promise<VaultSyncV2SnapshotPage> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.snapshotId)) {
      throw Object.assign(new Error("snapshotId 无效"), { code: "snapshot_not_found" });
    }
    const afterItem = input.afterItem ?? "0";
    const limit = input.limit ?? 100;
    if (!isValidVaultSyncInt8Decimal(afterItem) || !isSafeInteger(limit, 1, 500)) {
      throw invalidResponse("invalid_snapshot_request", "快照分页参数无效");
    }
    const query = new URLSearchParams({ afterItem, limit: String(limit) });
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/snapshots/" + input.snapshotId + "?" + query.toString(), {
      method: "GET", token: "device",
    });
    return parseSnapshotPage(response, { snapshotId: input.snapshotId, afterItem });
  }

  async renewSnapshot(snapshotId: string): Promise<{ snapshotId: string; expiresAt: string }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
      throw Object.assign(new Error("snapshotId 无效"), { code: "snapshot_not_found" });
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/snapshots/" + snapshotId + "/renew", {
      method: "POST", token: "device", body: {},
    });
    if (!exactKeys(response, ["snapshotId", "expiresAt"]) || typeof response.snapshotId !== "string"
      || response.snapshotId.toLowerCase() !== snapshotId.toLowerCase() || !isDateTime(response.expiresAt)) {
      throw invalidResponse("invalid_snapshot_renewal", "同步快照续期响应不符合合同");
    }
    return response as { snapshotId: string; expiresAt: string };
  }

  async acquireSnapshotApplyLease(snapshotId: string, input: {
    protocolEpoch: number; scopeVersion: number; sessionGeneration: string;
  }): Promise<VaultSyncV2SnapshotApplyLease> {
    if (!UUID.test(snapshotId) || !exactKeys(input, ["protocolEpoch", "scopeVersion", "sessionGeneration"])
      || !isSafeInteger(input.protocolEpoch, 1) || !isSafeInteger(input.scopeVersion, 1)
      || !isValidVaultSyncInt8Decimal(input.sessionGeneration, { allowZero: false })) {
      throw invalidResponse("invalid_snapshot_apply_lease_request", "快照应用租约参数无效");
    }
    const value = await this.request(`/api/sync-targets/${this.targetId}/vault/snapshots/${snapshotId}/apply-lease`, {
      method: "POST", token: "device", body: input,
    });
    if (!exactKeys(value, ["snapshotId", "leaseId", "protocolEpoch", "scopeVersion", "expiresAt", "reused"])
      || !UUID.test(value.snapshotId) || value.snapshotId.toLowerCase() !== snapshotId.toLowerCase()
      || !UUID.test(value.leaseId) || value.protocolEpoch !== input.protocolEpoch || value.scopeVersion !== input.scopeVersion
      || !isDateTime(value.expiresAt) || typeof value.reused !== "boolean") {
      throw invalidResponse("invalid_snapshot_apply_lease", "快照应用租约响应不符合合同");
    }
    return { ...value, snapshotId: value.snapshotId.toLowerCase(), leaseId: value.leaseId.toLowerCase() } as VaultSyncV2SnapshotApplyLease;
  }

  async renewSnapshotApplyLease(snapshotId: string, leaseId: string): Promise<Omit<VaultSyncV2SnapshotApplyLease, "reused">> {
    if (!UUID.test(snapshotId) || !UUID.test(leaseId)) {
      throw invalidResponse("invalid_snapshot_apply_lease_request", "快照应用租约 ID 无效");
    }
    const value = await this.request(`/api/sync-targets/${this.targetId}/vault/snapshots/${snapshotId}/apply-lease/${leaseId}/renew`, {
      method: "POST", token: "device", body: {},
    });
    if (!exactKeys(value, ["snapshotId", "leaseId", "protocolEpoch", "scopeVersion", "expiresAt"])
      || !UUID.test(value.snapshotId) || value.snapshotId.toLowerCase() !== snapshotId.toLowerCase()
      || !UUID.test(value.leaseId) || value.leaseId.toLowerCase() !== leaseId.toLowerCase()
      || !isSafeInteger(value.protocolEpoch, 1) || !isSafeInteger(value.scopeVersion, 1) || !isDateTime(value.expiresAt)) {
      throw invalidResponse("invalid_snapshot_apply_lease", "快照应用租约续期响应不符合合同");
    }
    return { snapshotId: value.snapshotId.toLowerCase(), leaseId: value.leaseId.toLowerCase(),
      protocolEpoch: value.protocolEpoch, scopeVersion: value.scopeVersion, expiresAt: value.expiresAt };
  }

  async releaseSnapshotApplyLease(snapshotId: string, leaseId: string): Promise<{ snapshotId: string; leaseId: string; released: boolean }> {
    if (!UUID.test(snapshotId) || !UUID.test(leaseId)) {
      throw invalidResponse("invalid_snapshot_apply_lease_request", "快照应用租约 ID 无效");
    }
    const value = await this.request(`/api/sync-targets/${this.targetId}/vault/snapshots/${snapshotId}/apply-lease/${leaseId}/release`, {
      method: "POST", token: "device", body: {},
    });
    if (!exactKeys(value, ["snapshotId", "leaseId", "released"])
      || !UUID.test(value.snapshotId) || value.snapshotId.toLowerCase() !== snapshotId.toLowerCase()
      || !UUID.test(value.leaseId) || value.leaseId.toLowerCase() !== leaseId.toLowerCase()
      || typeof value.released !== "boolean") {
      throw invalidResponse("invalid_snapshot_apply_lease", "快照应用租约释放响应不符合合同");
    }
    return { snapshotId: value.snapshotId.toLowerCase(), leaseId: value.leaseId.toLowerCase(), released: value.released };
  }

  async completeSnapshot(snapshotId: string, input: {
    protocolEpoch: number; sessionGeneration: string; snapshotCursor: string; itemCount: number; applyLeaseId?: string;
  }): Promise<VaultSyncV2Ack> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
      throw Object.assign(new Error("snapshotId 无效"), { code: "snapshot_not_found" });
    }
    const baseKeys = ["protocolEpoch", "sessionGeneration", "snapshotCursor", "itemCount"];
    const requestKeys = Object.keys(input).sort().join(",");
    if ((requestKeys !== [...baseKeys].sort().join(",")
      && requestKeys !== [...baseKeys, "applyLeaseId"].sort().join(","))
      || !isSafeInteger(input.protocolEpoch, 1) || !isValidVaultSyncInt8Decimal(input.sessionGeneration, { allowZero: false })
      || !isValidVaultSyncInt8Decimal(input.snapshotCursor) || !isSafeInteger(input.itemCount)
      || (input.applyLeaseId !== undefined && !UUID.test(input.applyLeaseId))) {
      throw invalidResponse("invalid_snapshot_request", "快照完成参数无效");
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/snapshots/" + snapshotId + "/complete", {
      method: "POST", token: "device", body: input,
    });
    const ack = parseAck(response);
    if (ack.protocolEpoch !== input.protocolEpoch || ack.sessionGeneration !== input.sessionGeneration
      || ack.receivedCursor !== input.snapshotCursor || ack.appliedCursor !== input.snapshotCursor) {
      throw invalidResponse("invalid_snapshot_completion", "快照完成响应与提交边界不一致");
    }
    return ack;
  }

  async acknowledgeChanges(input: VaultSyncV2Ack): Promise<VaultSyncV2AckResponse> {
    const request = parseAck(input);
    const response = parseAckResponse(await this.request("/api/sync-targets/" + this.targetId + "/vault/acks", {
      method: "POST", token: "device", body: input,
      headers: { "x-wtb-sync-diagnostics": "apply-latency-v1" },
    }));
    if (response.protocolEpoch !== request.protocolEpoch || response.sessionGeneration !== request.sessionGeneration
      || response.receivedCursor !== request.receivedCursor || response.appliedCursor !== request.appliedCursor) {
      throw invalidResponse("invalid_ack_response", "同步确认响应与请求不一致");
    }
    return response;
  }

  async reserveContentObject(input: { ciphertextHash: string; byteSize: number; keyVersion?: number }): Promise<VaultSyncV2ObjectReservation> {
    const keyVersion = input.keyVersion ?? 1;
    if (!SHA256.test(input.ciphertextHash) || !isSafeInteger(input.byteSize) || !isSafeInteger(keyVersion, 1)) {
      throw invalidResponse("invalid_object_reservation_request", "对象 reservation 参数无效");
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/content-objects/reservations", {
      method: "POST", token: "device",
      body: { ciphertext_hash: input.ciphertextHash, byte_size: input.byteSize, key_version: keyVersion },
    });
    const keys = ["object_id", "reservation_id", "encryption_domain_id", "key_version", "byte_size", "ciphertext_hash", "upload_url", "upload_expires_at", "deduped"];
    if (!exactKeys(response, keys) || !UUID.test(response.object_id) || !UUID.test(response.reservation_id)
      || !UUID.test(response.encryption_domain_id) || response.key_version !== keyVersion
      || response.byte_size !== input.byteSize || response.ciphertext_hash !== input.ciphertextHash
      || !(response.upload_url === null || isHttpUrl(response.upload_url))
      || !isDateTime(response.upload_expires_at) || typeof response.deduped !== "boolean"
      || (response.deduped ? response.upload_url !== null : response.upload_url === null)) {
      throw invalidResponse("invalid_object_reservation_response", "对象 reservation 响应与请求不匹配");
    }
    return {
      objectId: response.object_id,
      reservationId: response.reservation_id,
      encryptionDomainId: response.encryption_domain_id,
      keyVersion: response.key_version,
      byteSize: response.byte_size,
      ciphertextHash: response.ciphertext_hash,
      uploadUrl: response.upload_url,
      uploadExpiresAt: response.upload_expires_at,
      deduped: response.deduped,
    };
  }

  async prepareContentObjects(items: Array<{ ciphertextHash: string; byteSize: number; keyVersion?: number }>): Promise<VaultSyncV2ObjectBatchResult[]> {
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      throw Object.assign(new Error("对象批量准备数量必须在 1 到 100 项之间"), { code: "invalid_object_batch" });
    }
    if (items.some((item) => !item || !SHA256.test(item.ciphertextHash) || !isSafeInteger(item.byteSize)
      || !isSafeInteger(item.keyVersion ?? 1, 1))) {
      throw invalidResponse("invalid_object_batch", "对象批量准备内容无效");
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/content-objects/prepare-batch", {
      method: "POST", token: "device",
      body: { items: items.map((item) => ({
        ciphertext_hash: item.ciphertextHash,
        byte_size: item.byteSize,
        key_version: item.keyVersion ?? 1,
      })) },
    });
    const results = response?.results;
    if (!exactKeys(response, ["results"]) || !Array.isArray(results) || results.length !== items.length
      || results.some((item: any, index: number) => {
        if (!isRecord(item) || item.index !== index) return true;
        if (item.status === "failed") return !exactKeys(item, ["index", "status", "code"])
          || typeof item.code !== "string" || item.code.length === 0;
        const input = items[index];
        return item.status !== "prepared"
          || !exactKeys(item, ["index", "status", "object_id", "reservation_id", "encryption_domain_id", "key_version", "byte_size", "ciphertext_hash", "upload_url", "upload_expires_at", "deduped"])
          || !UUID.test(item.object_id) || !UUID.test(item.reservation_id) || !UUID.test(item.encryption_domain_id)
          || item.key_version !== (input.keyVersion ?? 1) || item.byte_size !== input.byteSize
          || item.ciphertext_hash !== input.ciphertextHash
          || !(item.upload_url === null || isHttpUrl(item.upload_url)) || !isDateTime(item.upload_expires_at)
          || typeof item.deduped !== "boolean"
          || (item.deduped ? item.upload_url !== null : item.upload_url === null);
      })) {
      throw Object.assign(new Error("对象批量准备响应顺序或数量无效"), { code: "invalid_object_batch_response" });
    }
    return results.map((item: any) => item.status === "prepared" ? {
      index: item.index, status: item.status,
      objectId: item.object_id, reservationId: item.reservation_id,
      encryptionDomainId: item.encryption_domain_id, keyVersion: item.key_version,
      byteSize: item.byte_size, ciphertextHash: item.ciphertext_hash,
      uploadUrl: item.upload_url, uploadExpiresAt: item.upload_expires_at, deduped: item.deduped,
    } : { index: item.index, status: "failed", code: item.code });
  }

  async cancelContentObjectReservations(reservationIds: string[]): Promise<VaultSyncV2ReservationCancellation[]> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!Array.isArray(reservationIds) || reservationIds.length < 1 || reservationIds.length > 100
      || reservationIds.some((id) => typeof id !== "string" || !uuid.test(id))) {
      throw Object.assign(new Error("reservation 取消数量或 ID 无效"), { code: "invalid_reservation_batch" });
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/content-objects/reservations/cancel-batch", {
      method: "POST", token: "device", body: { reservation_ids: reservationIds },
    });
    const results = response?.results;
    const validStatuses = ["cancelled", "already_cancelled", "already_finalized", "unavailable"];
    if (!exactKeys(response, ["results"]) || !Array.isArray(results) || results.length !== reservationIds.length
      || results.some((item: any, index: number) => !exactKeys(item, ["reservation_id", "status"])
        || typeof item.reservation_id !== "string"
        || item.reservation_id.toLowerCase() !== reservationIds[index].toLowerCase()
        || !validStatuses.includes(item.status))) {
      throw Object.assign(new Error("reservation 取消响应顺序或数量无效"), { code: "invalid_reservation_cancel_response" });
    }
    return results.map((item: any) => ({ reservationId: item.reservation_id, status: item.status }));
  }

  async beginContentObjectMultipartUpload(reservationId: string): Promise<VaultSyncV2MultipartUploadSession> {
    if (!UUID.test(reservationId)) throw invalidResponse("upload_reservation_invalid", "reservationId 无效");
    const response = await this.request(
      `/api/sync-targets/${this.targetId}/vault/content-objects/reservations/${reservationId}/multipart`,
      { method: "POST", token: "device", body: {} },
    );
    const uploadedParts = response?.uploaded_parts;
    if (!exactKeys(response, ["deduped", "part_size", "part_count", "uploaded_parts", "expires_at"])
      || typeof response.deduped !== "boolean" || !isDateTime(response.expires_at)
      || !Array.isArray(uploadedParts)
      || uploadedParts.some((part: any, index: number) => !exactKeys(part, ["part_number", "byte_size"])
        || !isSafeInteger(part.part_number, 1, 10_000)
        || (index > 0 && part.part_number <= uploadedParts[index - 1].part_number)
        || !isSafeInteger(part.byte_size))) {
      throw invalidResponse("invalid_multipart_upload_response", "分段上传状态响应不符合合同");
    }
    if (response.deduped) {
      if (response.part_size !== null || response.part_count !== 0 || uploadedParts.length !== 0) {
        throw invalidResponse("invalid_multipart_upload_response", "已存在对象的分段状态不应包含上传内容");
      }
    } else if (!isSafeInteger(response.part_size, 5 * 1024 * 1024, 5 * 1024 ** 3)
      || !isSafeInteger(response.part_count, 1, 10_000)
      || uploadedParts.some((part: any) => part.part_number > response.part_count || part.byte_size > response.part_size)) {
      throw invalidResponse("invalid_multipart_upload_response", "分段上传大小或序号无效");
    }
    return {
      deduped: response.deduped,
      partSize: response.part_size,
      partCount: response.part_count,
      uploadedParts: uploadedParts.map((part: any) => ({ partNumber: part.part_number, byteSize: part.byte_size })),
      expiresAt: response.expires_at,
    };
  }

  async getContentObjectMultipartPartUrl(reservationId: string, partNumber: number): Promise<{
    uploadUrl: string; expiresAt: string; partNumber: number;
  }> {
    if (!UUID.test(reservationId) || !isSafeInteger(partNumber, 1, 10_000)) {
      throw invalidResponse("multipart_part_invalid", "reservationId 或 partNumber 无效");
    }
    const response = await this.request(
      `/api/sync-targets/${this.targetId}/vault/content-objects/reservations/${reservationId}/multipart/parts/${partNumber}/url`,
      { method: "POST", token: "device", body: {} },
    );
    if (!exactKeys(response, ["upload_url", "expires_at", "part_number"])
      || !isHttpUrl(response.upload_url) || !isDateTime(response.expires_at)
      || response.part_number !== partNumber) {
      throw invalidResponse("invalid_multipart_part_url_response", "分段上传地址与请求不匹配");
    }
    return { uploadUrl: response.upload_url, expiresAt: response.expires_at, partNumber };
  }

  async completeContentObjectMultipartUpload(reservationId: string): Promise<{
    completed: boolean; alreadyCompleted: boolean;
  }> {
    if (!UUID.test(reservationId)) throw invalidResponse("upload_reservation_invalid", "reservationId 无效");
    const response = await this.request(
      `/api/sync-targets/${this.targetId}/vault/content-objects/reservations/${reservationId}/multipart/complete`,
      { method: "POST", token: "device", body: {} },
    );
    if (!exactKeys(response, ["completed", "already_completed"]) || response.completed !== true
      || typeof response.already_completed !== "boolean") {
      throw invalidResponse("invalid_multipart_complete_response", "分段完成响应无效");
    }
    return { completed: response.completed, alreadyCompleted: response.already_completed };
  }

  async finalizeContentObject(reservationId: string): Promise<{
    objectId: string; encryptionDomainId: string; keyVersion: number; byteSize: number;
    ciphertextHash: string; finalized: boolean; alreadyFinalized: boolean;
  }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)) {
      throw Object.assign(new Error("reservationId 无效"), { code: "upload_reservation_invalid" });
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/content-objects/reservations/" + reservationId + "/finalize", {
      method: "POST", token: "device", body: {},
    });
    if (!exactKeys(response, ["object_id", "encryption_domain_id", "key_version", "byte_size", "ciphertext_hash", "finalized", "already_finalized"])
      || !UUID.test(response.object_id) || !UUID.test(response.encryption_domain_id)
      || !isSafeInteger(response.key_version, 1) || !isSafeInteger(response.byte_size)
      || !SHA256.test(response.ciphertext_hash) || response.finalized !== true
      || typeof response.already_finalized !== "boolean") {
      throw invalidResponse("invalid_object_finalize_response", "对象 finalize 响应不符合合同");
    }
    return {
      objectId: response.object_id,
      encryptionDomainId: response.encryption_domain_id,
      keyVersion: response.key_version,
      byteSize: response.byte_size,
      ciphertextHash: response.ciphertext_hash,
      finalized: response.finalized,
      alreadyFinalized: response.already_finalized,
    };
  }

  async getContentObject(objectId: string): Promise<VaultSyncV2ObjectDownload> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)) {
      throw Object.assign(new Error("objectId 无效"), { code: "content_object_unavailable" });
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/content-objects/" + objectId, {
      method: "GET", token: "device",
    });
    return parseObjectDownload(response, objectId);
  }

  async getFileVersions(input: { fileId: string; beforeVersionNumber?: string; limit?: number }): Promise<VaultSyncV2FileVersionsPage> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(input.fileId) || (input.beforeVersionNumber !== undefined
      && !isValidVaultSyncInt8Decimal(input.beforeVersionNumber, { allowZero: false }))) {
      throw Object.assign(new Error("历史文件或版本游标无效"), { code: "version_cursor_invalid" });
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw Object.assign(new Error("历史版本页大小无效"), { code: "version_limit_invalid" });
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (input.beforeVersionNumber !== undefined) query.set("before", input.beforeVersionNumber);
    const response = await this.request(
      "/api/sync-targets/" + this.targetId + "/vault/files/" + input.fileId + "/versions?" + query.toString(),
      { method: "GET", token: "device" },
    );
    if (!exactKeys(response, ["fileId", "items", "hasMore", "nextBeforeVersionNumber"])
      || typeof response.fileId !== "string" || response.fileId.toLowerCase() !== input.fileId.toLowerCase() || !Array.isArray(response.items)
      || typeof response.hasMore !== "boolean"
      || !(response.nextBeforeVersionNumber === null || isValidVaultSyncInt8Decimal(response.nextBeforeVersionNumber, { allowZero: false }))) {
      throw Object.assign(new Error("历史版本响应不符合合同"), { code: "invalid_history_response" });
    }
    let previousNumber: bigint | null = null;
    let previousCursor: bigint | null = null;
    let currentItems = 0;
    const before = input.beforeVersionNumber === undefined ? null : BigInt(input.beforeVersionNumber);
    for (const [index, item] of response.items.entries()) {
      if (!exactKeys(item, ["versionId", "versionNumber", "changeCursor", "previousVersionId", "path", "isDeleted", "byteSize", "createdAt", "createdByDeviceId", "isCurrent", "contentStatus", "contentObjectId"])
        || !UUID.test(item.versionId) || !isValidVaultSyncInt8Decimal(item.versionNumber, { allowZero: false })
        || !isValidVaultSyncInt8Decimal(item.changeCursor)
        || !(item.previousVersionId === null || (typeof item.previousVersionId === "string" && UUID.test(item.previousVersionId)))
        || typeof item.path !== "string" || !item.path || normalizeVaultPath(item.path) !== item.path
        || typeof item.isDeleted !== "boolean" || !isSafeInteger(item.byteSize) || !isDateTime(item.createdAt)
        || !(item.createdByDeviceId === null || (typeof item.createdByDeviceId === "string" && UUID.test(item.createdByDeviceId)))
        || typeof item.isCurrent !== "boolean"
        || !["object_referenced", "legacy_unverified", "unavailable", "deleted", "pruned"].includes(item.contentStatus)
        || !(item.contentObjectId === null || (typeof item.contentObjectId === "string" && UUID.test(item.contentObjectId)))) {
        throw Object.assign(new Error("历史版本条目不符合合同"), { code: "invalid_history_response" });
      }
      const currentNumber = BigInt(item.versionNumber);
      const currentCursor = BigInt(item.changeCursor);
      const deleted = item.isDeleted === true;
      const objectReferenced = item.contentStatus === "object_referenced";
      if ((previousNumber !== null && currentNumber >= previousNumber)
        || (previousCursor !== null && currentCursor >= previousCursor)
        || (before !== null && currentNumber >= before)
        || (item.isCurrent && index !== 0)
        || (deleted !== (item.contentStatus === "deleted"))
        || (deleted && item.byteSize !== 0)
        || (objectReferenced !== (item.contentObjectId !== null))) {
        throw Object.assign(new Error("历史版本顺序或状态字段组合不一致"), { code: "invalid_history_response" });
      }
      previousNumber = currentNumber;
      previousCursor = currentCursor;
      if (item.isCurrent) currentItems += 1;
    }
    if (currentItems > 1 || (before === null && response.items.length > 0 && !response.items[0].isCurrent)) {
      throw Object.assign(new Error("历史版本当前 head 与版本顺序不一致"), { code: "invalid_history_response" });
    }
    if (response.hasMore !== (response.nextBeforeVersionNumber !== null)
      || (response.hasMore && response.items.length === 0)
      || (response.items.length > 0 && response.hasMore
        && response.nextBeforeVersionNumber !== response.items.at(-1).versionNumber)) {
      throw Object.assign(new Error("历史版本分页游标与条目不一致"), { code: "invalid_history_response" });
    }
    return response as VaultSyncV2FileVersionsPage;
  }

  async getFileVersionContent(fileId: string, versionId: string): Promise<VaultSyncV2ObjectDownload> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuid.test(fileId) || !uuid.test(versionId)) {
      throw Object.assign(new Error("历史版本 ID 无效"), { code: "history_version_unavailable" });
    }
    const response = await this.request(
      "/api/sync-targets/" + this.targetId + "/vault/files/" + fileId + "/versions/" + versionId + "/content",
      { method: "GET", token: "device" },
    );
    return parseObjectDownload(response);
  }

  async commitOperation(request: VaultSyncV2Request): Promise<VaultSyncOperationResult> {
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/operations", {
      method: "POST", token: "device", body: request,
    });
    return parseOperationResult(response, {
      operationId: request.operationId, fileId: request.fileId, protocolEpoch: request.protocolEpoch,
    });
  }

  async getOperationReceipt(operationId: string): Promise<VaultSyncOperationResult | { operationId: string; receiptStatus: "unknown" | "expired" }> {
    if (!UUID.test(operationId)) {
      throw Object.assign(new Error("operationId 无效"), { code: "invalid_operation" });
    }
    const response = await this.request("/api/sync-targets/" + this.targetId + "/vault/operations/" + operationId, {
      method: "GET", token: "device",
    });
    if (exactKeys(response, ["operationId", "receiptStatus"])
      && typeof response.operationId === "string" && response.operationId.toLowerCase() === operationId.toLowerCase()
      && ["unknown", "expired"].includes(response.receiptStatus)) {
      return response as { operationId: string; receiptStatus: "unknown" | "expired" };
    }
    return parseOperationResult(response, { operationId }, true);
  }
}
