// Durable local-to-cloud v2 operations. The request is journaled before object
// transfer and commit; receipt recovery and file hash checks make retries safe.
import type { App } from "obsidian";
import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import { shouldSyncPath, type LocalIndex } from "./vault-sync-local.ts";
import type { VaultSyncInboxEntry, VaultSyncOutboxOperation, VaultSyncOutboxStore, VaultSyncV2Request, VaultSyncV2Identity } from "./vault-sync-outbox.ts";
import type { VaultSyncRemoteClient } from "./vault-sync-remote.ts";
import type { VaultSyncV2BaselineEntry, VaultSyncV2BaselineStore } from "./vault-sync-v2-baseline.ts";
import type { VaultSyncV2PreparedUpload } from "./vault-sync-v2-storage.ts";
import type { VaultSyncV2BaseContentStore } from "./vault-sync-v2-base-content.ts";
import type { VaultSyncPushCasAutoMergePhase } from "./vault-sync-diagnostics.ts";
import type { VaultSyncPathIntentStore } from "./vault-sync-path-intents.ts";
import { createVaultSyncV2TransferQueue } from "./vault-sync-v2-transfer-queue.ts";
import { isVaultPathOpenInMarkdownEditor, withVaultPathWriteLocks } from "./vault-sync-write-safety.ts";
import { tryWithVaultSyncV2FileOperationLock, withVaultSyncV2FileOperationLock } from "./vault-sync-v2-locks.ts";
import { writeTextAtomically } from "./vault-sync-write-safety.ts";
import { HISTORY_RESTORE_MAX_BYTES, VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES, uniqueVaultConflictCopyPath } from "./vault-sync-history.ts";
import { getVaultSyncRetryAfterFromError } from "./vault-sync-retry.ts";
import { mergeMarkdown3Way } from "./vault-sync-v2-merge.ts";

type V2ObjectTransport = {
  fingerprint(bytes: Uint8Array): Promise<{ plaintextHash: string; ciphertextHash: string }>;
  prepare(bytes: Uint8Array): Promise<VaultSyncV2PreparedUpload>;
  prepareOwned?(bytes: Uint8Array): Promise<VaultSyncV2PreparedUpload>;
  prepareBatch?(bytes: Uint8Array[], onPlaintextConsumed?: (index: number) => void): Promise<Array<
    | { status: "prepared"; upload: VaultSyncV2PreparedUpload }
    | { status: "failed"; code: string }
  >>;
  prepareBatchOwned?(bytes: Uint8Array[], onPlaintextConsumed?: (index: number) => void): Promise<Array<
    | { status: "prepared"; upload: VaultSyncV2PreparedUpload }
    | { status: "failed"; code: string }
  >>;
  cancelReservations?(reservationIds: string[]): Promise<void>;
  transfer(prepared: VaultSyncV2PreparedUpload): Promise<void>;
  downloadVersion?(input: { fileId: string; versionId: string; expectedObjectId: string }): Promise<{ plaintext: Uint8Array }>;
};

type PushOperationOutcome = {
  status: "committed" | "conflict" | "needs_rebase" | "skipped" | "skipped_for_budget" | "failed";
  baseline?: VaultSyncV2BaselineEntry;
  operationId: string;
  failureCode?: string;
  retryAfterMs?: number;
  supersededOperationCount?: number;
};

export interface VaultSyncV2PendingDeletion {
  fileId: string;
  expectedVersionId: string;
  path: string;
  plaintextHash: string;
  byteSize: number;
  /** Local-only outbox work that explicit confirmation would supersede. */
  pendingOperationCount?: number;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",")}}`;
}

function operationPath(operation: VaultSyncOutboxOperation, baselineById: Map<string, VaultSyncV2BaselineEntry>): string | null {
  const value = operation.request.operation.path;
  if (typeof value === "string") return normalizeVaultPath(value);
  return baselineById.get(operation.fileId)?.path ?? null;
}

export interface VaultSyncV2PushOptions {
  app: App;
  identity: VaultSyncV2Identity;
  remote: Pick<VaultSyncRemoteClient, "createOperationWindow" | "commitOperation" | "getOperationReceipt" | "getFileVersions">;
  journal: Pick<VaultSyncOutboxStore, "load" | "enqueue" | "transition" | "pruneConfirmed" | "discardSupersededUpdatesByReviewedDelete" | "replacePendingOperation" | "replaceConflictOperation" | "replaceConflictWithMergedUpdate" | "replaceExpiredOperation" | "beginCreateConflictResolution" | "resolveDeleteConflict" | "resolveInboxItem">;
  baseline: VaultSyncV2BaselineStore;
  baseContent?: Pick<VaultSyncV2BaseContentStore, "get" | "put">;
  autoMergeEnabled?: boolean;
  /** Version byteSize is ciphertext size for encrypted Vaults; downloads still verify ciphertext before decrypting. */
  allowEncryptedSize?: boolean;
  pathIntents?: VaultSyncPathIntentStore;
  rootFolder?: string;
  transport: V2ObjectTransport;
  maxConcurrent: number;
  maxInFlightBytes: number;
  maxNoteBurst?: number;
  /** Current foreground Markdown path, captured once at the start of a push round. */
  getForegroundPath?(): string | null;
  /** Local-only, best-effort progress signal; failures must never affect sync. */
  onAutoMergePhase?(phase: VaultSyncPushCasAutoMergePhase): void;
  /** Confirms the first-initialization owner lease immediately before each remote write. */
  assertInitializationLease?(): Promise<void>;
  now?: () => Date;
}

export interface VaultSyncV2PushResult {
  uploaded: number;
  renamed: number;
  deleted: number;
  conflicts: number;
  deletionsPendingReview: number;
  pendingDeletions: VaultSyncV2PendingDeletion[];
  needsRebase: number;
  failed: number;
  skippedForBudget: number;
  failureCodes: string[];
  retryAfterMs?: number;
}

/** Pushes only live creates/updates. Local deletion remains a separate reviewed operation. */
export function createVaultSyncV2PushEngine(options: VaultSyncV2PushOptions) {
  const app: any = options.app;
  const now = options.now ?? (() => new Date());

  function recordAutoMergePhase(phase: VaultSyncPushCasAutoMergePhase) {
    try { options.onAutoMergePhase?.(phase); } catch { /* diagnostics must not affect sync */ }
  }

  function recordAutoMergeCommit(operation: VaultSyncOutboxOperation) {
    if (operation.autoMergeAttempts === 1) recordAutoMergePhase("retry_committed");
  }

  function commitRemote(operation: VaultSyncOutboxOperation, request = operation.request) {
    return options.remote.commitOperation(request);
  }

  function prepareOwned(bytes: Uint8Array): Promise<VaultSyncV2PreparedUpload> {
    return options.transport.prepareOwned ? options.transport.prepareOwned(bytes) : options.transport.prepare(bytes);
  }

  function preparedUploadMatchesLocal(upload: VaultSyncV2PreparedUpload, expectedPlaintextHash: string): boolean {
    // content.byteSize is the stored object size, so it includes encryption
    // framing. Compare it with the prepared ciphertext buffer, not the Vault
    // plaintext byte count kept in the local outbox/baseline.
    return upload.plaintextHash === expectedPlaintextHash
      && upload.content.byteSize === upload.objectBytes.byteLength
      && upload.content.ciphertextHash === upload.ciphertextHash;
  }

  async function currentBytes(path: string): Promise<Uint8Array | null> {
    const file = fileAt(path);
    if (!file) return null;
    const declaredSize = Number(file.stat?.size);
    if (Number.isSafeInteger(declaredSize) && declaredSize > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES) {
      throw fail("v2_push_local_file_too_large", "本机文件超过 Vault 同步单文件上限；推送与恢复已暂停");
    }
    const bytes = new Uint8Array(await app.vault.readBinary(file));
    if (bytes.byteLength > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES) {
      throw fail("v2_push_local_file_too_large", "本机文件超过 Vault 同步单文件上限；推送与恢复已暂停");
    }
    return bytes;
  }

  function fileAt(path: string): any | null {
    const found = app.vault.getAbstractFileByPath(path)
      ?? app.vault.getFiles?.().find((entry: any) => normalizeVaultPath(entry.path) === path);
    return found && !("children" in found) ? found : null;
  }

  async function transitionToCommitting(operation: VaultSyncOutboxOperation): Promise<VaultSyncOutboxOperation> {
    let current = operation;
    if (current.state === "queued") current = await options.journal.transition(current.operationId, "preparing");
    if (current.state === "preparing") current = await options.journal.transition(current.operationId, "uploaded");
    if (current.state === "uploaded") current = await options.journal.transition(current.operationId, "committing");
    return current;
  }

  async function transitionDeleteToCommitting(operation: VaultSyncOutboxOperation): Promise<VaultSyncOutboxOperation> {
    let current = operation;
    if (["queued", "preparing", "uploaded"].includes(current.state)) {
      current = await options.journal.transition(current.operationId, "committing");
    }
    return current;
  }

  async function rebindExpiredDelete(operation: VaultSyncOutboxOperation): Promise<VaultSyncOutboxOperation> {
    const window = await options.remote.createOperationWindow();
    if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
      throw fail("operation_window_expired", "远端写入窗口不可用");
    }
    const operationId = globalThis.crypto.randomUUID();
    const request: VaultSyncV2Request = {
      ...operation.request, operationWindowId: window.windowId, operationId,
      operation: { type: "delete" },
    };
    return options.journal.replaceExpiredOperation(operation.operationId, {
      operationId, fileId: operation.fileId,
      operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
      localContentHash: operation.localContentHash, localByteSize: operation.localByteSize,
      localGeneration: operation.localGeneration, request,
    });
  }

  async function processDeleteOperation(
    original: VaultSyncOutboxOperation,
    path: string,
    allowWindowRecovery = true,
    assertReviewContextCurrent?: () => void,
  ): Promise<PushOperationOutcome> {
    let operation = original;
    let receipt: any;
    if (operation.state === "committing") {
      receipt = await options.remote.getOperationReceipt(operation.operationId);
      if (receipt.receiptStatus === "expired") {
        if (allowWindowRecovery) {
          const replacement = await rebindExpiredDelete(operation);
          return processDeleteOperation(replacement, path, false, assertReviewContextCurrent);
        }
        await options.journal.transition(operation.operationId, "conflict");
        return { status: "conflict", operationId: operation.operationId };
      }
      if (receipt.receiptStatus === "unknown") receipt = null;
    }
    if (receipt?.status === "conflict") {
      await options.journal.transition(operation.operationId, "conflict");
      return { status: "conflict", operationId: operation.operationId };
    }
    if (receipt?.status === "committed") {
      await transitionDeleteToCommitting(operation);
      return {
        status: "committed", operationId: operation.operationId,
        baseline: {
          fileId: operation.fileId, fileVersionId: receipt.fileVersionId, cursor: receipt.changeCursor,
          path, plaintextHash: null, byteSize: 0, isDeleted: true,
        },
      };
    }
    if (fileAt(path)) {
      await options.journal.transition(operation.operationId, "conflict");
      return { status: "conflict", operationId: operation.operationId };
    }
    operation = await transitionDeleteToCommitting(operation);
    if (operation.state !== "committing") return { status: "skipped", operationId: operation.operationId };
    try {
      await options.assertInitializationLease?.();
      assertReviewContextCurrent?.();
      const committed = await commitRemote(operation);
      if (committed.status === "conflict") {
        await options.journal.transition(operation.operationId, "conflict");
        return { status: "conflict", operationId: operation.operationId };
      }
      return {
        status: "committed", operationId: operation.operationId,
        baseline: {
          fileId: operation.fileId, fileVersionId: committed.fileVersionId, cursor: committed.changeCursor,
          path, plaintextHash: null, byteSize: 0, isDeleted: true,
        },
      };
    } catch (error: any) {
      if (error?.code === "delete_review_stale") {
        await options.journal.transition(operation.operationId, "needs_rebase", "delete_review_context_changed");
        return { status: "needs_rebase", operationId: operation.operationId };
      }
      if (["operation_window_expired", "operation_window_exhausted"].includes(error?.code)) {
        const recovered: any = await options.remote.getOperationReceipt(operation.operationId);
        if (recovered?.status === "committed") {
          return {
            status: "committed", operationId: operation.operationId,
            baseline: {
              fileId: operation.fileId, fileVersionId: recovered.fileVersionId, cursor: recovered.changeCursor,
              path, plaintextHash: null, byteSize: 0, isDeleted: true,
            },
          };
        }
        if (recovered?.status === "conflict") {
          await options.journal.transition(operation.operationId, "conflict");
          return { status: "conflict", operationId: operation.operationId };
        }
        if (allowWindowRecovery) {
          const replacement = await rebindExpiredDelete(operation);
          return processDeleteOperation(replacement, path, false);
        }
        await options.journal.transition(operation.operationId, "conflict");
        return { status: "conflict", operationId: operation.operationId };
      }
      throw error;
    }
  }

  async function rebindExpiredCommit(operation: VaultSyncOutboxOperation, path: string): Promise<{
    operation: VaultSyncOutboxOperation;
    upload: VaultSyncV2PreparedUpload;
  } | null> {
    const bytes = await currentBytes(path);
    if (!bytes) {
      await options.journal.transition(operation.operationId, "needs_rebase", "local_file_missing");
      return null;
    }
    if (bytes.byteLength !== operation.localByteSize || await sha256Hex(bytes) !== operation.localContentHash) {
      await options.journal.transition(operation.operationId, "needs_rebase", "local_content_mismatch");
      return null;
    }
    const upload = await prepareOwned(bytes);
    if (!preparedUploadMatchesLocal(upload, operation.localContentHash)) {
      await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      await options.journal.transition(operation.operationId, "needs_rebase", "prepared_content_mismatch");
      return null;
    }
    let replacementPersisted = false;
    try {
      const latestBytes = await currentBytes(path);
      if (!latestBytes || latestBytes.byteLength !== operation.localByteSize
        || await sha256Hex(latestBytes) !== operation.localContentHash) {
        await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
        await options.journal.transition(operation.operationId, "needs_rebase", latestBytes ? "local_content_mismatch" : "local_file_missing");
        return null;
      }
      const window = await options.remote.createOperationWindow();
      if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
        throw fail("operation_window_expired", "远端写入窗口不可用");
      }
      const operationId = globalThis.crypto.randomUUID();
      const operationContent = (operation.request.operation as any).content;
      const request: VaultSyncV2Request = {
        ...operation.request,
        operationWindowId: window.windowId,
        operationId,
        operation: operationContent ? {
          ...operation.request.operation,
          content: {
            reservationId: upload.content.reservationId,
            objectId: upload.content.objectId,
            keyVersion: upload.content.keyVersion,
            byteSize: upload.content.byteSize,
            ciphertextHash: upload.content.ciphertextHash,
          },
        } : operation.request.operation,
      };
      const replacement = await options.journal.replaceExpiredOperation(operation.operationId, {
        operationId,
        fileId: operation.fileId,
        operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
        localContentHash: operation.localContentHash,
        localByteSize: operation.localByteSize,
        localGeneration: operation.localGeneration,
        request,
        ...(operation.autoMergeAttempts !== undefined ? { autoMergeAttempts: operation.autoMergeAttempts } : {}),
        ...(operation.resolvesInboxCursor ? { resolvesInboxCursor: operation.resolvesInboxCursor } : {}),
      });
      replacementPersisted = true;
      const oldReservationId = operationContent?.reservationId;
      if (oldReservationId && oldReservationId !== upload.content.reservationId) {
        await options.transport.cancelReservations?.([oldReservationId])?.catch(() => {});
      }
      return { operation: replacement, upload };
    } catch (error) {
      if (!replacementPersisted) await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      throw error;
    }
  }

  async function rebindExpiredRename(operation: VaultSyncOutboxOperation): Promise<{
    operation: VaultSyncOutboxOperation | null;
    alreadyApplied?: VaultSyncV2BaselineEntry;
  }> {
    const page = await options.remote.getFileVersions({ fileId: operation.fileId, limit: 2 });
        const head = page.items.find((entry) => entry.isCurrent);
    if (!head || head.isDeleted) return { operation: null };
    const expectedVersionId = operation.request.expectedVersionId;
    const desiredPath = (operation.request.operation as any).path;
    if (head.versionId !== expectedVersionId) {
      if (head.path === desiredPath && head.previousVersionId === expectedVersionId) {
        const previous = (await options.baseline.get(operation.fileId))
          ?? { plaintextHash: operation.localContentHash, byteSize: operation.localByteSize };
        return { operation: null, alreadyApplied: {
          fileId: operation.fileId, fileVersionId: head.versionId, cursor: head.changeCursor,
          path: desiredPath, plaintextHash: previous.plaintextHash, byteSize: previous.byteSize, isDeleted: false,
        } };
      }
      return { operation: null };
    }
    const window = await options.remote.createOperationWindow();
    if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
      throw fail("operation_window_expired", "远端写入窗口不可用");
    }
    const operationId = globalThis.crypto.randomUUID();
    const request: VaultSyncV2Request = { ...operation.request, operationWindowId: window.windowId, operationId };
    const replacement = await options.journal.replaceExpiredOperation(operation.operationId, {
      operationId, fileId: operation.fileId,
      operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
      localContentHash: operation.localContentHash, localByteSize: operation.localByteSize,
      localGeneration: operation.localGeneration, request,
    });
    return { operation: replacement };
  }

  async function processRenameOperation(
    original: VaultSyncOutboxOperation,
    prior: VaultSyncV2BaselineEntry,
    allowExpiredWindowRecovery = true,
  ): Promise<PushOperationOutcome> {
    let operation = original;
    let receipt: any;
    if (operation.state === "committing") {
      receipt = await options.remote.getOperationReceipt(operation.operationId);
      if (receipt.receiptStatus === "expired") {
        if (!allowExpiredWindowRecovery) {
          await options.journal.transition(operation.operationId, "conflict");
          return { status: "conflict", operationId: operation.operationId };
        }
        const rebound = await rebindExpiredRename(operation);
        if (rebound.alreadyApplied) return { status: "committed", operationId: operation.operationId, baseline: rebound.alreadyApplied };
        if (!rebound.operation) {
          await options.journal.transition(operation.operationId, "conflict");
          return { status: "conflict", operationId: operation.operationId };
        }
        return processRenameOperation(rebound.operation, prior, false);
      }
      if (receipt.receiptStatus === "unknown") receipt = null;
    }
    if (receipt?.status === "conflict") {
      await options.journal.transition(operation.operationId, "conflict");
      return { status: "conflict", operationId: operation.operationId };
    }
    if (receipt?.status === "committed") {
      await transitionToCommitting(operation);
      return { status: "committed", operationId: operation.operationId, baseline: {
        fileId: operation.fileId, fileVersionId: receipt.fileVersionId, cursor: receipt.changeCursor,
        path: (operation.request.operation as any).path, plaintextHash: prior.plaintextHash,
        byteSize: prior.byteSize, isDeleted: false,
      } };
    }
    const path = (operation.request.operation as any).path as string;
    if (!fileAt(path)) {
      await options.journal.transition(operation.operationId, "needs_rebase", "local_file_missing");
      return { status: "needs_rebase", operationId: operation.operationId };
    }
    operation = await transitionToCommitting(operation);
    try {
      await options.assertInitializationLease?.();
      const committed = await commitRemote(operation);
      if (committed.status === "conflict") {
        await options.journal.transition(operation.operationId, "conflict");
        return { status: "conflict", operationId: operation.operationId };
      }
      return { status: "committed", operationId: operation.operationId, baseline: {
        fileId: operation.fileId, fileVersionId: committed.fileVersionId, cursor: committed.changeCursor,
        path, plaintextHash: prior.plaintextHash, byteSize: prior.byteSize, isDeleted: false,
      } };
    } catch (error: any) {
      if (["operation_window_expired", "operation_window_exhausted"].includes(error?.code) && allowExpiredWindowRecovery) {
        const recovered: any = await options.remote.getOperationReceipt(operation.operationId);
        if (recovered?.status === "committed") return { status: "committed", operationId: operation.operationId, baseline: {
          fileId: operation.fileId, fileVersionId: recovered.fileVersionId, cursor: recovered.changeCursor,
          path, plaintextHash: prior.plaintextHash, byteSize: prior.byteSize, isDeleted: false,
        } };
        if (recovered?.status === "conflict") {
          await options.journal.transition(operation.operationId, "conflict");
          return { status: "conflict", operationId: operation.operationId };
        }
        const rebound = await rebindExpiredRename(operation);
        if (rebound.alreadyApplied) return { status: "committed", operationId: operation.operationId, baseline: rebound.alreadyApplied };
        if (rebound.operation) return processRenameOperation(rebound.operation, prior, false);
        await options.journal.transition(operation.operationId, "conflict");
        return { status: "conflict", operationId: operation.operationId };
      }
      throw error;
    }
  }

  async function processSourceRestoreOperation(
    original: VaultSyncOutboxOperation,
    path: string,
    allowExpiredWindowRecovery = true,
  ): Promise<PushOperationOutcome> {
    let operation = original;
    let request = operation.request;
    let receiptUnknownBeforeCommit = operation.state !== "committing";
    let receipt: any;

    if (request.operation.type !== "restore" || request.operation.reuseSourceContent !== true
      || typeof request.operation.sourceVersionId !== "string" || request.operation.path !== path) {
      throw fail("history_restore_request_invalid", "历史恢复引用参数无效");
    }

    if (operation.state === "committing") {
      receipt = await options.remote.getOperationReceipt(operation.operationId);
      if (receipt.receiptStatus === "expired") {
        await options.journal.transition(operation.operationId, "needs_rebase", "operation_receipt_expired");
        return { status: "needs_rebase", operationId: operation.operationId };
      }
      if (receipt.receiptStatus === "unknown") {
        receipt = null;
        receiptUnknownBeforeCommit = true;
      }
    }

    if (receipt?.status === "conflict") {
      await transitionToCommitting(operation);
      await options.journal.transition(operation.operationId, "conflict");
      return { status: "conflict", operationId: operation.operationId };
    }
    if (receipt?.status === "committed") {
      await transitionToCommitting(operation);
      return {
        status: "committed", operationId: operation.operationId,
        baseline: {
          fileId: operation.fileId, fileVersionId: receipt.fileVersionId, cursor: receipt.changeCursor,
          path, plaintextHash: operation.localContentHash, byteSize: operation.localByteSize, isDeleted: false,
        },
      };
    }

    const localCopyMatches = async () => {
      const bytes = await currentBytes(path);
      return !!bytes && bytes.byteLength === operation.localByteSize
        && await sha256Hex(bytes) === operation.localContentHash;
    };
    if (["queued", "preparing", "uploaded"].includes(operation.state) && !(await localCopyMatches())) {
      await options.journal.transition(operation.operationId, "needs_rebase", fileAt(path) ? "local_content_mismatch" : "local_file_missing");
      return { status: "needs_rebase", operationId: operation.operationId };
    }
    if (operation.state === "queued") operation = await options.journal.transition(operation.operationId, "preparing");
    if (operation.state === "preparing") operation = await options.journal.transition(operation.operationId, "uploaded");
    if (operation.state === "uploaded") operation = await options.journal.transition(operation.operationId, "committing");
    if (operation.state !== "committing") return { status: "skipped", operationId: operation.operationId };
    if (!(await localCopyMatches())) {
      await options.journal.transition(operation.operationId, "needs_rebase", fileAt(path) ? "local_content_mismatch" : "local_file_missing");
      return { status: "needs_rebase", operationId: operation.operationId };
    }

    try {
      await options.assertInitializationLease?.();
      const committed = await commitRemote(operation, request);
      if (committed.status === "conflict") {
        await options.journal.transition(operation.operationId, "conflict");
        return { status: "conflict", operationId: operation.operationId };
      }
      return {
        status: "committed", operationId: operation.operationId,
        baseline: {
          fileId: operation.fileId, fileVersionId: committed.fileVersionId, cursor: committed.changeCursor,
          path, plaintextHash: operation.localContentHash, byteSize: operation.localByteSize, isDeleted: false,
        },
      };
    } catch (error: any) {
      if (!["operation_window_expired", "operation_window_exhausted"].includes(error?.code)) throw error;
      if (receiptUnknownBeforeCommit) {
        const latestReceipt: any = await options.remote.getOperationReceipt(operation.operationId);
        if (latestReceipt.status === "committed") {
          return {
            status: "committed", operationId: operation.operationId,
            baseline: {
              fileId: operation.fileId, fileVersionId: latestReceipt.fileVersionId,
              cursor: latestReceipt.changeCursor, path, plaintextHash: operation.localContentHash,
              byteSize: operation.localByteSize, isDeleted: false,
            },
          };
        }
        if (latestReceipt.status === "conflict") {
          await options.journal.transition(operation.operationId, "conflict");
          return { status: "conflict", operationId: operation.operationId };
        }
        if (latestReceipt.receiptStatus === "unknown" && allowExpiredWindowRecovery) {
          const window = await options.remote.createOperationWindow();
          if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
            throw fail("operation_window_expired", "远端写入窗口不可用");
          }
          const operationId = globalThis.crypto.randomUUID();
          const nextRequest: VaultSyncV2Request = {
            ...request,
            operationWindowId: window.windowId,
            operationId,
            operation: { ...request.operation },
          };
          const operationDigest = await sha256Hex(new TextEncoder().encode(stableJson(nextRequest)));
          const replacement = await options.journal.replaceExpiredOperation(operation.operationId, {
            operationId,
            fileId: operation.fileId,
            operationDigest,
            localContentHash: operation.localContentHash,
            localByteSize: operation.localByteSize,
            localGeneration: operation.localGeneration,
            request: nextRequest,
            ...(operation.autoMergeAttempts !== undefined ? { autoMergeAttempts: operation.autoMergeAttempts } : {}),
            ...(operation.resolvesInboxCursor ? { resolvesInboxCursor: operation.resolvesInboxCursor } : {}),
          });
          return processSourceRestoreOperation(replacement, path, false);
        }
      }
      await options.journal.transition(operation.operationId, "needs_rebase", "operation_recovery_unresolved");
      return { status: "needs_rebase", operationId: operation.operationId };
    }
  }

  async function tryAutoMergeUpdateConflict(
    prior: VaultSyncOutboxOperation,
    path: string,
    signal?: AbortSignal,
    fileOperationLockHeld = false,
  ): Promise<PushOperationOutcome | null> {
    if (!fileOperationLockHeld) {
      return withVaultSyncV2FileOperationLock(options.identity, prior.fileId, () =>
        tryAutoMergeUpdateConflict(prior, path, signal, true));
    }
    if (options.autoMergeEnabled === false || prior.state !== "conflict" || prior.request.operation.type !== "update"
      || prior.resolvesInboxCursor !== undefined || (prior.autoMergeAttempts ?? 0) >= 1
      || !path.toLowerCase().endsWith(".md") || !options.transport.downloadVersion || signal?.aborted
      || isVaultPathOpenInMarkdownEditor(app, path)) return null;
    const expectedVersionId = prior.request.expectedVersionId;
    if (typeof expectedVersionId !== "string") return null;

    const localBytes = await currentBytes(path);
    if (!localBytes || localBytes.byteLength > HISTORY_RESTORE_MAX_BYTES) return null;
    const pages = await options.remote.getFileVersions({ fileId: prior.fileId, limit: 100 });
    const head = pages.items.find((entry) => entry.isCurrent);
    const base = pages.items.find((entry) => entry.versionId === expectedVersionId);
    if (!head || !base || head.versionId === expectedVersionId || head.isDeleted || base.isDeleted
      || head.path !== path || base.path !== path || head.contentStatus !== "object_referenced"
      || base.contentStatus !== "object_referenced" || !head.contentObjectId || !base.contentObjectId
      || head.byteSize > HISTORY_RESTORE_MAX_BYTES || base.byteSize > HISTORY_RESTORE_MAX_BYTES) return null;

    recordAutoMergePhase("attempt_started");
    const [baseObject, remoteObject] = await Promise.all([
      options.transport.downloadVersion({ fileId: prior.fileId, versionId: base.versionId, expectedObjectId: base.contentObjectId }),
      options.transport.downloadVersion({ fileId: prior.fileId, versionId: head.versionId, expectedObjectId: head.contentObjectId }),
    ]);
    if (!options.allowEncryptedSize
      && (baseObject.plaintext.byteLength !== base.byteSize || remoteObject.plaintext.byteLength !== head.byteSize)) return null;
    const merged = await mergeMarkdown3Way(baseObject.plaintext, localBytes, remoteObject.plaintext);
    if (merged.status !== "merged" || merged.bytes.byteLength > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES) return null;

    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let localText: string;
    let mergedText: string;
    try {
      localText = decoder.decode(localBytes);
      mergedText = decoder.decode(merged.bytes);
    } catch { return null; }
    await writeTextAtomically(app, path, mergedText, localText);
    const persisted = await currentBytes(path);
    if (!persisted || persisted.byteLength !== merged.bytes.byteLength
      || await sha256Hex(persisted) !== merged.plaintextHash) {
      throw fail("outbox_conflict_merge_write_unverified", "自动合并正文落盘校验失败；冲突待办仍保留");
    }

    let upload: VaultSyncV2PreparedUpload | null = null;
    let replacementPersisted = false;
    try {
      upload = await prepareOwned(merged.bytes);
      if (!preparedUploadMatchesLocal(upload, merged.plaintextHash)) {
        throw fail("outbox_conflict_merge_upload_mismatch", "自动合并上传内容与本机合并正文不一致");
      }
      const window = await options.remote.createOperationWindow();
      if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
        throw fail("operation_window_expired", "远端写入窗口不可用");
      }
      const operationId = globalThis.crypto.randomUUID();
      const request: VaultSyncV2Request = {
        ...prior.request,
        operationWindowId: window.windowId,
        operationId,
        expectedVersionId: head.versionId,
        operation: { ...prior.request.operation, content: {
          reservationId: upload.content.reservationId,
          objectId: upload.content.objectId,
          keyVersion: upload.content.keyVersion,
          byteSize: upload.content.byteSize,
          ciphertextHash: upload.content.ciphertextHash,
        } },
      };
      const replacement = await options.journal.replaceConflictWithMergedUpdate(prior.operationId, {
        operationId,
        fileId: prior.fileId,
        operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
        localContentHash: merged.plaintextHash,
        localByteSize: merged.bytes.byteLength,
        localGeneration: prior.localGeneration,
        request,
        autoMergeAttempts: 1,
      });
      replacementPersisted = true;
      recordAutoMergePhase("retry_queued");
      const oldReservationId = (prior.request.operation as any).content?.reservationId;
      if (oldReservationId && oldReservationId !== upload.content.reservationId) {
        await options.transport.cancelReservations?.([oldReservationId])?.catch(() => {});
      }
      return processOperation(replacement, path, upload, signal, true, false, true);
    } catch (error) {
      if (!replacementPersisted && upload) {
        await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      }
      throw error;
    }
  }

  async function processOperation(
    original: VaultSyncOutboxOperation,
    path: string,
    prepared?: VaultSyncV2PreparedUpload,
    signal?: AbortSignal,
    allowExpiredWindowRecovery = true,
    allowAutomaticMerge = true,
    fileOperationLockHeld = false,
  ): Promise<PushOperationOutcome> {
    if (!fileOperationLockHeld) {
      return withVaultSyncV2FileOperationLock(options.identity, original.fileId, async () => {
        // Another lane may have completed and pruned this operation while we
        // waited for its per-file lock. Never replay a stale snapshot or try to
        // transition an operation that no longer exists.
        const latest = (await options.journal.load())?.operations.find((entry) => entry.operationId === original.operationId);
        if (!latest || latest.state === "confirmed") return { status: "skipped", operationId: original.operationId };
        if (latest.state === "conflict") return { status: "conflict", operationId: latest.operationId };
        if (latest.state === "needs_rebase") return { status: "needs_rebase", operationId: latest.operationId };
        return processOperation(latest, path, prepared, signal, allowExpiredWindowRecovery, allowAutomaticMerge, true);
      });
    }
    if (original.request.operation.type === "restore" && original.request.operation.reuseSourceContent === true) {
      return processSourceRestoreOperation(original, path);
    }
    if (original.request.operation.type === "delete") {
      return withVaultPathWriteLocks([path], () => processDeleteOperation(original, path));
    }
    if (original.request.operation.type === "rename") {
      const prior = await options.baseline.get(original.fileId);
      if (!prior || prior.isDeleted) {
        await options.journal.transition(original.operationId, "needs_rebase", "baseline_unavailable");
        return { status: "needs_rebase", operationId: original.operationId };
      }
      return withVaultPathWriteLocks([prior.path, path], () => processRenameOperation(original, prior));
    }
    let operation = original;
    let request = operation.request;
    let savedContent = (request.operation as any).content as { reservationId: string; objectId: string; keyVersion: number; byteSize: number; ciphertextHash: string };
    let receiptUnknownBeforeCommit = operation.state !== "committing";
    let receipt: any;
    if (operation.state === "committing") {
      receipt = await options.remote.getOperationReceipt(operation.operationId);
      if (receipt.receiptStatus === "expired") {
        await options.journal.transition(operation.operationId, "needs_rebase", "operation_receipt_expired");
        return { status: "needs_rebase", operationId: operation.operationId };
      }
      if (receipt.receiptStatus === "unknown") {
        receipt = null;
        receiptUnknownBeforeCommit = true;
      }
    }

    if (receipt?.status === "conflict") {
      await transitionToCommitting(operation);
      await options.journal.transition(operation.operationId, "conflict");
      if (allowAutomaticMerge) {
        const merged = await tryAutoMergeUpdateConflict({ ...operation, state: "conflict" }, path, signal, true);
        if (merged) return merged;
      }
      return { status: "conflict", operationId: operation.operationId };
    }
    if (receipt?.status === "committed") {
      await transitionToCommitting(operation);
      recordAutoMergeCommit(operation);
      return {
        status: "committed", operationId: operation.operationId,
        baseline: {
          fileId: operation.fileId, fileVersionId: receipt.fileVersionId, cursor: receipt.changeCursor,
          path, plaintextHash: operation.localContentHash, byteSize: operation.localByteSize, isDeleted: false,
        },
      };
    }

    if (operation.state === "queued" || operation.state === "preparing" || operation.state === "uploaded") {
      const bytes = await currentBytes(path);
      if (!bytes || await sha256Hex(bytes) !== operation.localContentHash) {
        await options.journal.transition(operation.operationId, "needs_rebase", bytes ? "local_content_mismatch" : "local_file_missing");
        return { status: "needs_rebase", operationId: operation.operationId };
      }
      const upload = prepared ?? await prepareOwned(bytes);
      if (!preparedUploadMatchesLocal(upload, operation.localContentHash)) {
        await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
        await options.journal.transition(operation.operationId, "needs_rebase", "prepared_content_mismatch");
        return { status: "needs_rebase", operationId: operation.operationId };
      }
      const uploadRef = {
        reservationId: upload.content.reservationId,
        objectId: upload.content.objectId,
        keyVersion: upload.content.keyVersion,
        byteSize: upload.content.byteSize,
        ciphertextHash: upload.content.ciphertextHash,
      };
      if (stableJson(uploadRef) !== stableJson(savedContent) || !prepared) {
        // A recovered pre-commit operation always receives a fresh operation
        // window and id, even when object dedupe returns the same reservation.
        // Persist the new binding before cancelling or transferring anything.
        const beforeRebind = await currentBytes(path);
        if (!beforeRebind || await sha256Hex(beforeRebind) !== operation.localContentHash) {
          await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
          await options.journal.transition(operation.operationId, "needs_rebase", beforeRebind ? "local_content_mismatch" : "local_file_missing");
          return { status: "needs_rebase", operationId: operation.operationId };
        }
        let window: Awaited<ReturnType<VaultSyncRemoteClient["createOperationWindow"]>>;
        let replacementPersisted = false;
        try {
          window = await options.remote.createOperationWindow();
          if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
            throw fail("operation_window_expired", "远端写入窗口不可用");
          }
          const nextOperationId = globalThis.crypto.randomUUID();
          const nextRequest: VaultSyncV2Request = {
            ...request,
            operationWindowId: window.windowId,
            operationId: nextOperationId,
            operation: { ...request.operation, content: uploadRef },
          };
          const operationDigest = await sha256Hex(new TextEncoder().encode(stableJson(nextRequest)));
          const replacement = await options.journal.replacePendingOperation(operation.operationId, {
            operationId: nextOperationId,
            fileId: operation.fileId,
            operationDigest,
            localContentHash: operation.localContentHash,
            localByteSize: operation.localByteSize,
            localGeneration: operation.localGeneration,
            request: nextRequest,
            ...(operation.autoMergeAttempts !== undefined ? { autoMergeAttempts: operation.autoMergeAttempts } : {}),
            ...(operation.resolvesInboxCursor ? { resolvesInboxCursor: operation.resolvesInboxCursor } : {}),
          });
          replacementPersisted = true;
          if (savedContent.reservationId !== upload.content.reservationId) {
            await options.transport.cancelReservations?.([savedContent.reservationId])?.catch(() => {});
          }
          operation = replacement;
          request = replacement.request;
          savedContent = (request.operation as any).content;
        } catch (error) {
          // If replacement was not persisted, the old durable request remains
          // authoritative and the newly allocated reservation is an orphan.
          if (!replacementPersisted) {
            await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
          }
          throw error;
        }
      }
      if (operation.state === "queued") operation = await options.journal.transition(operation.operationId, "preparing");
      if (signal?.aborted) throw fail("transfer_cancelled", "对象传输已取消；待办已保留以供恢复");
      await options.transport.transfer(upload);
      if (signal?.aborted) throw fail("transfer_cancelled", "对象传输已取消；待办已保留以供恢复");
      operation = await options.journal.transition(operation.operationId, "uploaded");
    }

    if (operation.state === "uploaded") operation = await options.journal.transition(operation.operationId, "committing");
    if (operation.state !== "committing") return { status: "skipped", operationId: operation.operationId };
    const bytesBeforeCommit = await currentBytes(path);
    if (!bytesBeforeCommit || await sha256Hex(bytesBeforeCommit) !== operation.localContentHash) {
      await options.journal.transition(operation.operationId, "needs_rebase", bytesBeforeCommit ? "local_content_mismatch" : "local_file_missing");
      return { status: "needs_rebase", operationId: operation.operationId };
    }
    let committed: Awaited<ReturnType<VaultSyncRemoteClient["commitOperation"]>>;
    try {
      await options.assertInitializationLease?.();
      committed = await commitRemote(operation, request);
    } catch (error: any) {
      if (["upload_reservation_invalid", "content_object_unavailable", "operation_window_expired", "operation_window_exhausted"].includes(error?.code)) {
        if (allowExpiredWindowRecovery && receiptUnknownBeforeCommit) {
          const recoveredReceipt: any = await options.remote.getOperationReceipt(operation.operationId);
          if (recoveredReceipt.receiptStatus === "unknown") {
            const replacement = await rebindExpiredCommit(operation, path);
            if (!replacement) return { status: "needs_rebase", operationId: operation.operationId };
            return processOperation(replacement.operation, path, replacement.upload, signal, false, true, true);
          }
          if (recoveredReceipt.receiptStatus === "expired") {
            await options.journal.transition(operation.operationId, "needs_rebase", "operation_receipt_expired");
            return { status: "needs_rebase", operationId: operation.operationId };
          }
          if (recoveredReceipt.status === "conflict") {
            await options.journal.transition(operation.operationId, "conflict");
            return { status: "conflict", operationId: operation.operationId };
          }
          if (recoveredReceipt.status === "committed") {
            recordAutoMergeCommit(operation);
            return {
              status: "committed", operationId: operation.operationId,
              baseline: {
                fileId: operation.fileId, fileVersionId: recoveredReceipt.fileVersionId,
                cursor: recoveredReceipt.changeCursor, path, plaintextHash: operation.localContentHash,
                byteSize: operation.localByteSize, isDeleted: false,
              },
            };
          }
        }
        await options.journal.transition(operation.operationId, "needs_rebase", "operation_recovery_unresolved");
        return { status: "needs_rebase", operationId: operation.operationId };
      }
      throw error;
    }
    if (committed.status === "conflict") {
      await options.journal.transition(operation.operationId, "conflict");
      if (allowAutomaticMerge) {
        const merged = await tryAutoMergeUpdateConflict({ ...operation, state: "conflict" }, path, signal, true);
        if (merged) return merged;
      }
      return { status: "conflict", operationId: operation.operationId };
    }
    recordAutoMergeCommit(operation);
    return {
      status: "committed", operationId: operation.operationId,
      baseline: {
        fileId: operation.fileId, fileVersionId: committed.fileVersionId, cursor: committed.changeCursor,
        path, plaintextHash: operation.localContentHash, byteSize: operation.localByteSize, isDeleted: false,
      },
    };
  }

  async function tryProcessCandidateOperation(
    operation: VaultSyncOutboxOperation,
    path: string,
    prepared: VaultSyncV2PreparedUpload,
    signal?: AbortSignal,
  ): Promise<PushOperationOutcome> {
    const acquired = await tryWithVaultSyncV2FileOperationLock(options.identity, operation.fileId, () =>
      processOperation(operation, path, prepared, signal, true, true, true));
    return acquired.acquired ? acquired.value : { status: "skipped", operationId: operation.operationId };
  }

  async function runOnce(localIndex: LocalIndex): Promise<VaultSyncV2PushResult> {
    const result: VaultSyncV2PushResult = {
      uploaded: 0, renamed: 0, deleted: 0, conflicts: 0, deletionsPendingReview: 0, pendingDeletions: [],
      needsRebase: 0, failed: 0, skippedForBudget: 0, failureCodes: [],
    };
    const noteRetryAfter = (error: unknown) => {
      const retryAfterMs = getVaultSyncRetryAfterFromError(error);
      if (retryAfterMs !== null) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, retryAfterMs);
    };
    const foregroundPath = normalizeVaultPath(options.getForegroundPath?.() ?? "");
    const isForegroundNote = (path: string) => !!foregroundPath
      && path === foregroundPath && path.toLowerCase().endsWith(".md");
    const initial = await options.journal.load();
    if (!initial) throw fail("snapshot_required", "本机尚无 v2 快照基线，不能提交本地改动");
    const alreadyConfirmed = initial.operations.filter((operation) => operation.state === "confirmed").map((operation) => operation.operationId);
    if (alreadyConfirmed.length) await options.journal.pruneConfirmed(alreadyConfirmed);
    let baselineEntries = await options.baseline.load();
    let baselineById = new Map(baselineEntries.map((entry) => [entry.fileId, entry]));
    const terminalByPath = new Map<string, "conflict">();
    const blockedPaths = new Set<string>();
    const unresolvedInboxFileIds = new Set<string>();
    const unresolvedInboxPaths = new Set<string>();
    const inboxPathKey = (path: string) => portableVaultPathKey(path) ?? path;
    for (const entry of initial.inbox) {
      if (entry.state === "applied") continue;
      unresolvedInboxFileIds.add(entry.item.fileId);
      const itemPath = normalizeVaultPath(entry.item.path);
      if (itemPath) unresolvedInboxPaths.add(inboxPathKey(itemPath));
      const priorPath = baselineById.get(entry.item.fileId)?.path;
      if (priorPath) unresolvedInboxPaths.add(inboxPathKey(priorPath));
    }
    const handledRenameIds = new Set<string>();
    const isAutoMergeCandidate = (operation: VaultSyncOutboxOperation) => operation.state === "conflict"
      && operation.request.operation.type === "update" && operation.resolvesInboxCursor === undefined
      && (operation.autoMergeAttempts ?? 0) < 1;
    for (const operation of initial.operations) {
      if (operation.state !== "conflict") continue;
      if (isAutoMergeCandidate(operation)) continue;
      const path = operationPath(operation, baselineById);
      if (path) terminalByPath.set(path, "conflict");
      if (operation.request.operation.type === "rename") {
        const basePath = (operation.request.operation as any).basePath;
        if (typeof basePath === "string") terminalByPath.set(basePath, "conflict");
      }
    }

    const pathMoves = [...(await options.pathIntents?.load() ?? [])];
    pathMoves.sort((left, right) => Number(isForegroundNote(right.toPath)) - Number(isForegroundNote(left.toPath)));
    for (const move of pathMoves) {
      if (!shouldSyncPath(move.fromPath, options.rootFolder) || !shouldSyncPath(move.toPath, options.rootFolder)) {
        if (shouldSyncPath(move.fromPath, options.rootFolder)) blockedPaths.add(move.fromPath);
        if (shouldSyncPath(move.toPath, options.rootFolder)) blockedPaths.add(move.toPath);
        continue;
      }
      blockedPaths.add(move.fromPath);
      blockedPaths.add(move.toPath);
      const prior = move.fileId
        ? baselineById.get(move.fileId) ?? null
        : baselineEntries.find((entry) => !entry.isDeleted && entry.path === move.fromPath) ?? null;
      if (!prior) {
        // A rename before this path ever acquired a cloud fileId is simply a
        // new local file at its final path.
        // However, a create may already have committed while its response was
        // lost. Keep the move intent until that receipt establishes the fileId
        // baseline, or the final path could be uploaded as a second cloud file.
        const activeCreate = !move.fileId && initial.operations.some((operation) =>
          ["queued", "preparing", "uploaded", "committing"].includes(operation.state)
          && operation.request.operation.type === "create"
          && operation.request.operation.path === move.fromPath);
        if (activeCreate) continue;
        if (!move.fileId) {
          await options.pathIntents?.remove(move.intentId);
          // This is a local-only move, so the final path is now a normal create
          // candidate in this same push round.
          blockedPaths.delete(move.fromPath);
          blockedPaths.delete(move.toPath);
        } else { result.failed += 1; result.failureCodes.push("rename_baseline_missing"); }
        continue;
      }
      if (!move.fileId) await options.pathIntents?.bindFile(move.intentId, prior.fileId);
      else if (move.fileId !== prior.fileId) {
        result.failed += 1;
        if (result.failureCodes.length < 5) result.failureCodes.push("rename_file_identity_mismatch");
        continue;
      }
      if (unresolvedInboxFileIds.has(prior.fileId) || unresolvedInboxPaths.has(inboxPathKey(move.fromPath))
        || unresolvedInboxPaths.has(inboxPathKey(move.toPath))) continue;
      if (prior.path === move.toPath && !prior.isDeleted) {
        await options.pathIntents?.remove(move.intentId);
        blockedPaths.delete(move.fromPath);
        blockedPaths.delete(move.toPath);
        continue;
      }
      if (move.state === "conflict") {
        result.conflicts += 1;
        continue;
      }
      const file = localIndex.get(move.toPath);
      if (!file) {
        // Rename followed by a local delete before upload remains the reviewed
        // delete flow for the original cloud head.
        if (localIndex.has(move.fromPath)) await options.pathIntents?.remove(move.intentId);
        else await options.pathIntents?.remove(move.intentId);
        continue;
      }
      const forFile = initial.operations.filter((operation) => operation.fileId === prior.fileId);
      const conflictingRename = forFile.find((operation) => operation.state === "conflict"
        && operation.request.operation.type === "rename");
      if (conflictingRename) {
        await options.pathIntents?.markConflict(move.intentId);
        result.conflicts += 1;
        continue;
      }
      const otherActive = forFile.find((operation) => ["queued", "preparing", "uploaded", "committing"].includes(operation.state)
        && operation.request.operation.type !== "rename");
      if (otherActive) continue;

      let operation = forFile.find((entry) => ["queued", "preparing", "uploaded", "committing"].includes(entry.state)
        && entry.request.operation.type === "rename");
      if (!operation) {
        try {
          const window = await options.remote.createOperationWindow();
          if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
            throw fail("operation_window_expired", "远端改名窗口不可用");
          }
          const operationId = globalThis.crypto.randomUUID();
          const request: VaultSyncV2Request = {
            protocolVersion: 2, protocolEpoch: options.identity.protocolEpoch,
            operationWindowId: window.windowId, operationId, fileId: prior.fileId,
            expectedVersionId: prior.fileVersionId,
            operation: { type: "rename", basePath: move.fromPath, path: move.toPath },
          };
          operation = await options.journal.enqueue({
            operationId, fileId: prior.fileId,
            operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
            localContentHash: file.contentHash ?? prior.plaintextHash ?? "",
            localByteSize: file.byteSize,
            localGeneration: Math.max(0, Math.floor(file.mtimeMs)), request,
          });
        } catch (error: any) {
          noteRetryAfter(error);
          result.failed += 1;
          if (result.failureCodes.length < 5) result.failureCodes.push(String(error?.code ?? "rename_prepare_failed"));
          continue;
        }
      }
      handledRenameIds.add(operation.operationId);
      try {
        const outcome = await withVaultPathWriteLocks([move.fromPath, move.toPath], () => processRenameOperation(operation!, prior));
        if (outcome.status === "committed" && outcome.baseline) {
          const newest = baselineEntries.find((entry) => entry.fileId === prior.fileId);
          if (!newest || BigInt(outcome.baseline.cursor) >= BigInt(newest.cursor)) {
            await options.baseline.setMany([outcome.baseline]);
            baselineEntries = baselineEntries.map((entry) => entry.fileId === prior.fileId ? outcome.baseline! : entry);
            baselineById = new Map(baselineEntries.map((entry) => [entry.fileId, entry]));
          }
          if (operation.state !== "confirmed") await options.journal.transition(operation.operationId, "confirmed");
          await options.journal.pruneConfirmed([operation.operationId]);
          await options.pathIntents?.remove(move.intentId);
          result.renamed += 1;
          blockedPaths.delete(move.fromPath);
          blockedPaths.delete(move.toPath);
        } else if (outcome.status === "conflict") {
          await options.pathIntents?.markConflict(move.intentId);
          terminalByPath.set(move.fromPath, "conflict");
          terminalByPath.set(move.toPath, "conflict");
          result.conflicts += 1;
        } else if (outcome.status === "needs_rebase") {
          result.needsRebase += 1;
        }
      } catch (error: any) {
        noteRetryAfter(error);
        result.failed += 1;
        if (result.failureCodes.length < 5) result.failureCodes.push(String(error?.code ?? "rename_commit_failed"));
      }
    }
    baselineById = new Map(baselineEntries.map((entry) => [entry.fileId, entry]));
    const liveByPath = new Map<string, VaultSyncV2BaselineEntry[]>();
    for (const entry of baselineEntries) {
      if (entry.isDeleted) continue;
      const rows = liveByPath.get(entry.path) ?? [];
      rows.push(entry);
      liveByPath.set(entry.path, rows);
    }

    const queue = createVaultSyncV2TransferQueue({
      maxConcurrent: options.maxConcurrent, maxInFlightBytes: options.maxInFlightBytes, maxNoteBurst: options.maxNoteBurst,
    });
    const baselineUpdates: VaultSyncV2BaselineEntry[] = [];
    const confirmedIds: string[] = [];
    const activeByPath = new Set<string>();
    const scheduledJobs: Array<Promise<PushOperationOutcome | PushOperationOutcome[]>> = [];
    const activeOperations = initial.operations.filter((entry) =>
      (["queued", "preparing", "uploaded", "committing"].includes(entry.state) || isAutoMergeCandidate(entry))
      && !handledRenameIds.has(entry.operationId)).sort((left, right) => {
      const leftPath = operationPath(left, baselineById) ?? "";
      const rightPath = operationPath(right, baselineById) ?? "";
      return Number(isForegroundNote(rightPath)) - Number(isForegroundNote(leftPath));
    });
    const activeRenameIds = new Set(activeOperations.filter((entry) => entry.request.operation.type === "rename")
      .map((entry) => entry.operationId));
    for (const operation of activeOperations) {
      const path = operationPath(operation, baselineById);
      if (!path) {
        await options.journal.transition(operation.operationId, "needs_rebase", "operation_path_unavailable");
        result.needsRebase += 1;
        continue;
      }
      const operationPaths = operation.request.operation.type === "rename"
        && typeof operation.request.operation.basePath === "string"
        ? [path, operation.request.operation.basePath]
        : [path];
      if (unresolvedInboxFileIds.has(operation.fileId)
        || operationPaths.some((operationPath) => unresolvedInboxPaths.has(inboxPathKey(operationPath)))) {
        for (const operationPath of operationPaths) activeByPath.add(operationPath);
        continue;
      }
      if (operationPaths.some((operationPath) => !shouldSyncPath(operationPath, options.rootFolder))) {
        // Keep durable work queued while its path is outside this device's
        // selected scope. A later scope expansion can resume it safely.
        for (const operationPath of operationPaths) {
          if (shouldSyncPath(operationPath, options.rootFolder)) activeByPath.add(operationPath);
        }
        continue;
      }
      activeByPath.add(path);
      const memoryCostBytes = operation.request.operation.type === "delete"
        ? 1 : Math.max(1, operation.localByteSize * 4);
      if (!Number.isSafeInteger(memoryCostBytes) || memoryCostBytes > options.maxInFlightBytes) {
        result.skippedForBudget += 1;
        continue;
      }
      scheduledJobs.push(queue.schedule({ kind: path.toLowerCase().endsWith(".md") ? "note" : "attachment", memoryCostBytes,
        foregroundPriority: isForegroundNote(path),
        async run(signal) {
          const acquired = await tryWithVaultSyncV2FileOperationLock(options.identity, operation.fileId, async () => {
            const latest = (await options.journal.load())?.operations.find((entry) => entry.operationId === operation.operationId);
            if (!latest || latest.state === "confirmed") return { status: "skipped", operationId: operation.operationId } as const;
            if (latest.state === "conflict") {
              return await tryAutoMergeUpdateConflict(latest, path, signal, true)
                ?? { status: "conflict", operationId: latest.operationId } as const;
            }
            if (latest.state === "needs_rebase") return { status: "needs_rebase", operationId: latest.operationId } as const;
            return processOperation(latest, path, undefined, signal, true, true, true);
          });
          return acquired.acquired ? acquired.value : { status: "skipped", operationId: operation.operationId };
        } }));
    }

    const newCandidates: Array<{
      path: string;
      entity: LocalIndex extends Map<string, infer T> ? T : never;
      previous: VaultSyncV2BaselineEntry | null;
      fileId: string;
      operationId: string;
      memoryCostBytes: number;
      kind: "note" | "attachment";
    }> = [];
    for (const [path, entity] of localIndex) {
      if (!shouldSyncPath(path, options.rootFolder) || blockedPaths.has(path)
        || unresolvedInboxPaths.has(inboxPathKey(path))) continue;
      if (activeByPath.has(path)) continue;
      const terminal = terminalByPath.get(path);
      if (terminal === "conflict") { result.conflicts += 1; continue; }
      if (!entity.contentHash) { result.failed += 1; continue; }
      const existing = liveByPath.get(path) ?? [];
      if (existing.length > 1) { result.conflicts += 1; continue; }
      const previous = existing[0] ?? null;
      if (previous && unresolvedInboxFileIds.has(previous.fileId)) {
        activeByPath.add(path);
        continue;
      }
      const tombstone = baselineEntries.find((entry) => entry.path === path && entry.isDeleted);
      if (tombstone && !previous) { result.conflicts += 1; continue; }
      if (previous?.plaintextHash === entity.contentHash) continue;
      if (!previous && !tombstone && entity.isDeleted) continue;
      const memoryCostBytes = Math.max(1, entity.byteSize * 4);
      if (!Number.isSafeInteger(memoryCostBytes) || memoryCostBytes > options.maxInFlightBytes) {
        result.skippedForBudget += 1;
        continue;
      }
      const fileId = previous?.fileId ?? globalThis.crypto.randomUUID();
      const operationId = globalThis.crypto.randomUUID();
      newCandidates.push({ path, entity, previous, fileId, operationId, memoryCostBytes,
        kind: path.toLowerCase().endsWith(".md") ? "note" : "attachment" });
    }

    newCandidates.sort((left, right) => Number(isForegroundNote(right.path)) - Number(isForegroundNote(left.path)));
    if ((options.transport.prepareBatchOwned || options.transport.prepareBatch) && newCandidates.length) {
      const maxBatchItems = 100;
      for (const kind of ["note", "attachment"] as const) {
        const candidates = newCandidates.filter((entry) => entry.kind === kind);
        let group: typeof candidates = [];
        let groupCost = 0;
        const flush = () => {
          if (!group.length) return;
          const batch = group;
          const memoryCostBytes = groupCost;
          scheduledJobs.push(queue.schedule({ kind, memoryCostBytes,
            foregroundPriority: batch.some((candidate) => isForegroundNote(candidate.path)), async run(signal) {
            const outcomes: PushOperationOutcome[] = [];
            const ready: Array<{ candidate: typeof batch[number]; bytes: Uint8Array }> = [];
            for (const candidate of batch) {
              let bytes: Uint8Array | null;
              try {
                bytes = await currentBytes(candidate.path);
              } catch (error: any) {
                if (error?.code === "v2_push_local_file_too_large") {
                  outcomes.push({ status: "skipped_for_budget", operationId: candidate.operationId });
                  continue;
                }
                bytes = null;
              }
              if (!bytes || await sha256Hex(bytes) !== candidate.entity.contentHash) {
                outcomes.push({ status: "skipped", operationId: candidate.operationId });
                continue;
              }
              ready.push({ candidate, bytes });
            }
            if (!ready.length) return outcomes;

            let prepared: Awaited<ReturnType<NonNullable<V2ObjectTransport["prepareBatch"]>>>;
            let window: Awaited<ReturnType<VaultSyncRemoteClient["createOperationWindow"]>>;
            const releasePlaintextBuffers = () => {
              for (const entry of ready) entry.bytes = new Uint8Array(0);
            };
            try {
              window = await options.remote.createOperationWindow();
              if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
                throw fail("operation_window_expired", "远端写入窗口不可用");
              }
              const prepareBatch = options.transport.prepareBatchOwned ?? options.transport.prepareBatch!;
              prepared = await prepareBatch(ready.map((entry) => entry.bytes), (index) => {
                if (ready[index]) ready[index].bytes = new Uint8Array(0);
              });
              releasePlaintextBuffers();
              if (!Array.isArray(prepared) || prepared.length !== ready.length) {
                throw fail("invalid_object_batch_response", "对象批量准备响应数量无效");
              }
            } catch (error: any) {
              releasePlaintextBuffers();
              noteRetryAfter(error);
              const code = String(error?.code ?? "object_prepare_failed");
              const retryAfterMs = getVaultSyncRetryAfterFromError(error) ?? undefined;
              return outcomes.concat(ready.map(({ candidate }) => ({
                status: "failed" as const, operationId: candidate.operationId, failureCode: code, retryAfterMs,
              })));
            }

            if (signal.aborted) {
              const preparedIds = prepared.flatMap((item) => item.status === "prepared" ? [item.upload.content.reservationId] : []);
              if (preparedIds.length) await options.transport.cancelReservations?.([...new Set(preparedIds)])?.catch(() => {});
              return outcomes.concat(ready.map(({ candidate }) => ({
                status: "failed" as const, operationId: candidate.operationId, failureCode: "transfer_cancelled",
              })));
            }

            const queued: Array<{ operation: VaultSyncOutboxOperation; candidate: typeof batch[number]; upload: VaultSyncV2PreparedUpload }> = [];
            const orphanReservationIds: string[] = [];
            for (let index = 0; index < ready.length; index += 1) {
              const { candidate } = ready[index];
              const item = prepared[index];
              if (!item || item.status === "failed") {
                outcomes.push({ status: "failed", operationId: candidate.operationId,
                  failureCode: item?.status === "failed" ? item.code : "invalid_object_batch_response" });
                continue;
              }
              const upload = item.upload;
              if (upload.plaintextHash !== candidate.entity.contentHash) {
                orphanReservationIds.push(upload.content.reservationId);
                outcomes.push({ status: "failed", operationId: candidate.operationId, failureCode: "local_file_changed" });
                continue;
              }
              const objectRef = {
                reservationId: upload.content.reservationId, objectId: upload.content.objectId,
                keyVersion: upload.content.keyVersion, byteSize: upload.content.byteSize,
                ciphertextHash: upload.content.ciphertextHash,
              };
              const request: VaultSyncV2Request = {
                protocolVersion: 2, protocolEpoch: options.identity.protocolEpoch,
                operationWindowId: window.windowId, operationId: candidate.operationId,
                fileId: candidate.fileId, expectedVersionId: candidate.previous?.fileVersionId ?? null,
                operation: candidate.previous
                  ? { type: "update", content: objectRef }
                  : { type: "create", path: candidate.path, content: objectRef },
              };
              const operationDigest = await sha256Hex(new TextEncoder().encode(stableJson(request)));
              const localGeneration = Math.max(0, Math.floor(candidate.entity.mtimeMs));
              if (!Number.isSafeInteger(localGeneration)) {
                orphanReservationIds.push(upload.content.reservationId);
                outcomes.push({ status: "failed", operationId: candidate.operationId, failureCode: "local_generation_invalid" });
                continue;
              }
              try {
                const operation = await options.journal.enqueue({
                  operationId: candidate.operationId, fileId: candidate.fileId, operationDigest,
                  localContentHash: candidate.entity.contentHash!, localByteSize: candidate.entity.byteSize,
                  localGeneration, request,
                });
                queued.push({ operation, candidate, upload });
              } catch (error: any) {
                outcomes.push({ status: "failed", operationId: candidate.operationId,
                  failureCode: String(error?.code ?? "outbox_persist_failed") });
              }
            }
            const queuedReservations = new Set(queued.map((entry) => entry.upload.content.reservationId));
            const orphanReservations = [...new Set(orphanReservationIds)].filter((id) => !queuedReservations.has(id));
            if (orphanReservations.length) await options.transport.cancelReservations?.(orphanReservations)?.catch(() => {});
            // Persist every immutable operation before any member of this batch uploads bytes.
            for (const entry of queued) {
              if (signal.aborted) {
                outcomes.push({ status: "failed", operationId: entry.candidate.operationId, failureCode: "transfer_cancelled" });
                continue;
              }
              try {
                outcomes.push(await tryProcessCandidateOperation(entry.operation, entry.candidate.path, entry.upload, signal));
              } catch (error: any) {
                noteRetryAfter(error);
                outcomes.push({ status: "failed", operationId: entry.candidate.operationId,
                  failureCode: String(error?.code ?? "transfer_failed"),
                  retryAfterMs: getVaultSyncRetryAfterFromError(error) ?? undefined });
              }
            }
            return outcomes;
          } }));
          group = [];
          groupCost = 0;
        };
        for (const candidate of candidates) {
          if (isForegroundNote(candidate.path)) {
            flush();
            group.push(candidate);
            groupCost = candidate.memoryCostBytes;
            flush();
            continue;
          }
          if (group.length && (group.length >= maxBatchItems || groupCost + candidate.memoryCostBytes > options.maxInFlightBytes)) flush();
          group.push(candidate);
          groupCost += candidate.memoryCostBytes;
        }
        flush();
      }
    } else {
      for (const candidate of newCandidates) {
        scheduledJobs.push(queue.schedule({ kind: candidate.kind, memoryCostBytes: candidate.memoryCostBytes,
          foregroundPriority: isForegroundNote(candidate.path),
          async run(signal) {
          const { path, entity, previous, fileId, operationId } = candidate;
          let file: Uint8Array | null;
          try {
            file = await currentBytes(path);
          } catch (error: any) {
            if (error?.code === "v2_push_local_file_too_large") {
              return { status: "skipped_for_budget" as const, operationId };
            }
            throw error;
          }
          if (!file || await sha256Hex(file) !== entity.contentHash) return { status: "skipped" as const, operationId };
          const prepared = await prepareOwned(file);
          if (prepared.plaintextHash !== entity.contentHash) throw fail("local_file_changed", "文件在准备上传期间发生变化");
          const window = await options.remote.createOperationWindow();
          if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
            throw fail("operation_window_expired", "远端写入窗口不可用");
          }
          const objectRef = {
            reservationId: prepared.content.reservationId, objectId: prepared.content.objectId,
            keyVersion: prepared.content.keyVersion, byteSize: prepared.content.byteSize,
            ciphertextHash: prepared.content.ciphertextHash,
          };
          const request: VaultSyncV2Request = {
            protocolVersion: 2, protocolEpoch: options.identity.protocolEpoch,
            operationWindowId: window.windowId, operationId, fileId, expectedVersionId: previous?.fileVersionId ?? null,
            operation: previous
              ? { type: "update", content: objectRef }
              : { type: "create", path, content: objectRef },
          };
          const operationDigest = await sha256Hex(new TextEncoder().encode(stableJson(request)));
          const localGeneration = Math.max(0, Math.floor(entity.mtimeMs));
          if (!Number.isSafeInteger(localGeneration)) throw fail("local_generation_invalid", "本地文件版本号超出安全范围");
          const queued = await options.journal.enqueue({
            operationId, fileId, operationDigest, localContentHash: entity.contentHash,
            localByteSize: entity.byteSize, localGeneration, request,
          });
          return tryProcessCandidateOperation(queued, path, prepared, signal);
        },
      }));
      }
    }

    const settled = await Promise.allSettled(scheduledJobs);
    for (const entry of settled) {
      if (entry.status === "rejected") {
        result.failed += 1;
        noteRetryAfter(entry.reason);
        const code = String((entry.reason as any)?.code ?? "transfer_failed");
        if (result.failureCodes.length < 5 && !result.failureCodes.includes(code)) result.failureCodes.push(code);
        continue;
      }
      const outcomes = Array.isArray(entry.value) ? entry.value : [entry.value];
      for (const outcome of outcomes) {
      if (outcome.status === "committed") {
        const operation = initial.operations.find((candidate) => candidate.operationId === outcome.operationId);
        if (operation?.request.operation.type === "delete") result.deleted += 1;
        else if (activeRenameIds.has(outcome.operationId)) result.renamed += 1;
        else result.uploaded += 1;
        if (outcome.baseline) baselineUpdates.push(outcome.baseline);
        confirmedIds.push(outcome.operationId);
      } else if (outcome.status === "conflict") result.conflicts += 1;
      else if (outcome.status === "needs_rebase") result.needsRebase += 1;
      else if (outcome.status === "skipped_for_budget") result.skippedForBudget += 1;
      else if (outcome.status === "failed") {
        result.failed += 1;
        if (outcome.retryAfterMs !== undefined) result.retryAfterMs = Math.max(result.retryAfterMs ?? 0, outcome.retryAfterMs);
        const code = outcome.failureCode ?? "transfer_failed";
        if (result.failureCodes.length < 5 && !result.failureCodes.includes(code)) result.failureCodes.push(code);
      }
      }
    }
    queue.close();
    if (baselineUpdates.length) await options.baseline.setMany(baselineUpdates);
    if (options.baseContent) {
      for (const entry of baselineUpdates) {
        if (entry.isDeleted || !entry.plaintextHash || !entry.path.toLowerCase().endsWith(".md")) continue;
        const bytes = await currentBytes(entry.path).catch(() => null);
        if (!bytes || await sha256Hex(bytes) !== entry.plaintextHash) continue;
        await options.baseContent.put(entry.plaintextHash, bytes).catch(() => ({ stored: false as const }));
      }
    }
    for (const operationId of confirmedIds) {
      const operation = initial.operations.find((entry) => entry.operationId === operationId);
      if (operation?.resolvesInboxCursor) {
        await options.journal.resolveInboxItem(operation.resolvesInboxCursor, operation.localContentHash);
      }
    }
    for (const operationId of confirmedIds) await options.journal.transition(operationId, "confirmed");
    if (confirmedIds.length) await options.journal.pruneConfirmed(confirmedIds);

    // A reviewed-delete confirmation can finish while this push round is in
    // flight. Read durable state after scheduled work settles so this round
    // cannot resurrect a pending review from its earlier baseline snapshot.
    const [latestBaselineEntries, latestJournal] = await Promise.all([
      options.baseline.load(), options.journal.load(),
    ]);
    const latestOperations = latestJournal?.operations ?? [];
    for (const entry of latestBaselineEntries) {
      if (entry.isDeleted || !shouldSyncPath(entry.path, options.rootFolder)
        || unresolvedInboxFileIds.has(entry.fileId) || unresolvedInboxPaths.has(inboxPathKey(entry.path))
        || localIndex.has(entry.path) || activeByPath.has(entry.path) || blockedPaths.has(entry.path)
        || terminalByPath.has(entry.path) || !entry.plaintextHash) continue;
      const pendingOperationCount = latestOperations.filter((operation) => operation.fileId === entry.fileId
        && operation.request.operation.type === "update"
        && operation.request.expectedVersionId === entry.fileVersionId
        && operation.state !== "confirmed").length;
      result.pendingDeletions.push({
        fileId: entry.fileId, expectedVersionId: entry.fileVersionId, path: entry.path,
        plaintextHash: entry.plaintextHash, byteSize: entry.byteSize,
        ...(pendingOperationCount ? { pendingOperationCount } : {}),
      });
    }
    result.deletionsPendingReview = result.pendingDeletions.length;
    return result;
  }

  async function restoreVersion(input: {
    fileId: string;
    sourceVersionId: string;
    path: string;
    bytes: Uint8Array;
  }): Promise<PushOperationOutcome> {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > HISTORY_RESTORE_MAX_BYTES) {
      throw fail("history_restore_too_large", "单次历史恢复最多支持 24 MiB；更大的对象需要流式恢复支持");
    }
    const current = await options.baseline.get(input.fileId);
    if (!current) throw fail("history_restore_head_missing", "当前文件没有可验证的云端版本");
    const bytes = input.bytes.slice();
    const localContentHash = await sha256Hex(bytes);
    const local = await currentBytes(input.path);
    if (!local || await sha256Hex(local) !== localContentHash) {
      throw fail("history_restore_local_changed", "恢复副本在提交前发生变化；文件已保留，请重试");
    }

    let window: Awaited<ReturnType<VaultSyncRemoteClient["createOperationWindow"]>>;
    window = await options.remote.createOperationWindow();
    if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
      throw fail("operation_window_expired", "远端写入窗口不可用");
    }

    const operationId = globalThis.crypto.randomUUID();
    const request: VaultSyncV2Request = {
      protocolVersion: 2,
      protocolEpoch: options.identity.protocolEpoch,
      operationWindowId: window.windowId,
      operationId,
      fileId: input.fileId,
      expectedVersionId: current.fileVersionId,
      operation: {
        type: "restore",
        sourceVersionId: input.sourceVersionId,
        path: input.path,
        reuseSourceContent: true,
      },
    };
    const operationDigest = await sha256Hex(new TextEncoder().encode(stableJson(request)));
    let queued: VaultSyncOutboxOperation;
    queued = await options.journal.enqueue({
      operationId,
      fileId: input.fileId,
      operationDigest,
      localContentHash,
      localByteSize: bytes.byteLength,
      localGeneration: Math.max(0, Math.floor(now().getTime())),
      request,
    });

    const outcome = await processOperation(queued, input.path);
    if (outcome.status !== "committed" || !outcome.baseline) return outcome;
    await options.baseline.setMany([outcome.baseline]);
    if (options.baseContent && input.path.toLowerCase().endsWith(".md")) {
      await options.baseContent.put(localContentHash, bytes).catch(() => ({ stored: false as const }));
    }
    await options.journal.transition(outcome.operationId, "confirmed");
    await options.journal.pruneConfirmed([outcome.operationId]);
    return outcome;
  }

  async function rebaseConflict(input: { operationId: string; expectedVersionId: string }): Promise<PushOperationOutcome> {
    const snapshot = await options.journal.load();
    const prior = snapshot?.operations.find((entry) => entry.operationId === input.operationId && entry.state === "conflict");
    if (!prior || prior.request.operation.type !== "update") {
      throw fail("outbox_conflict_not_rebasable", "只有本机 update CAS 冲突可以重基");
    }
    const baseline = await options.baseline.get(prior.fileId);
    if (!baseline || baseline.isDeleted) throw fail("outbox_conflict_baseline_missing", "冲突文件缺少有效的本机云端基线");
    const path = baseline.path;
    const initialBytes = await currentBytes(path);
    if (!initialBytes || initialBytes.byteLength !== prior.localByteSize
      || await sha256Hex(initialBytes) !== prior.localContentHash) {
      throw fail("outbox_conflict_local_changed", "本机文件已变化；先重新同步后再决定如何处理冲突");
    }
    const page = await options.remote.getFileVersions({ fileId: prior.fileId, limit: 1 });
    const head = page.items.find((entry) => entry.isCurrent);
    if (!head || head.isDeleted || head.path !== path || head.versionId !== input.expectedVersionId
      || head.versionId === prior.request.expectedVersionId) {
      throw fail("outbox_conflict_head_changed", "云端最新版本与预览不一致；请重新打开冲突预览");
    }
    const bytes = await currentBytes(path);
    if (!bytes || bytes.byteLength !== prior.localByteSize || await sha256Hex(bytes) !== prior.localContentHash) {
      throw fail("outbox_conflict_local_changed", "本机文件在预览期间发生变化；冲突待办仍保留");
    }
    const upload = await prepareOwned(bytes);
    if (!preparedUploadMatchesLocal(upload, prior.localContentHash)) {
      await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      throw fail("outbox_conflict_upload_mismatch", "重新准备的本机内容与冲突记录不一致");
    }
    let durableReplacement = false;
    try {
      const latestBytes = await currentBytes(path);
      if (!latestBytes || latestBytes.byteLength !== prior.localByteSize || await sha256Hex(latestBytes) !== prior.localContentHash) {
        throw fail("outbox_conflict_local_changed", "本机文件在准备上传期间发生变化；冲突待办仍保留");
      }
      const window = await options.remote.createOperationWindow();
      if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
        throw fail("operation_window_expired", "远端写入窗口不可用");
      }
      const operationId = globalThis.crypto.randomUUID();
      const objectRef = {
        reservationId: upload.content.reservationId,
        objectId: upload.content.objectId,
        keyVersion: upload.content.keyVersion,
        byteSize: upload.content.byteSize,
        ciphertextHash: upload.content.ciphertextHash,
      };
      const request: VaultSyncV2Request = {
        ...prior.request,
        operationWindowId: window.windowId,
        operationId,
        expectedVersionId: head.versionId,
        operation: { ...prior.request.operation, content: objectRef },
      };
      const replacement = await options.journal.replaceConflictOperation(prior.operationId, {
        operationId,
        fileId: prior.fileId,
        operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
        localContentHash: prior.localContentHash,
        localByteSize: prior.localByteSize,
        localGeneration: prior.localGeneration,
        request,
        ...(prior.autoMergeAttempts !== undefined ? { autoMergeAttempts: prior.autoMergeAttempts } : {}),
        ...(prior.resolvesInboxCursor ? { resolvesInboxCursor: prior.resolvesInboxCursor } : {}),
      });
      durableReplacement = true;
      const oldReservationId = (prior.request.operation as any).content?.reservationId;
      if (oldReservationId && oldReservationId !== upload.content.reservationId) {
        await options.transport.cancelReservations?.([oldReservationId])?.catch(() => {});
      }
      const outcome = await processOperation(replacement, path, upload);
      if (outcome.status !== "committed" || !outcome.baseline) return outcome;
      await options.baseline.setMany([outcome.baseline]);
      if (options.baseContent && path.toLowerCase().endsWith(".md")) {
        await options.baseContent.put(prior.localContentHash, bytes).catch(() => ({ stored: false as const }));
      }
      if (replacement.resolvesInboxCursor) {
        await options.journal.resolveInboxItem(replacement.resolvesInboxCursor, replacement.localContentHash);
      }
      await options.journal.transition(outcome.operationId, "confirmed");
      await options.journal.pruneConfirmed([outcome.operationId]);
      return outcome;
    } catch (error) {
      if (!durableReplacement) await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      throw error;
    }
  }

  async function canKeepLocalForRemoteUpdate(entry: VaultSyncInboxEntry): Promise<boolean> {
    const item = entry.item;
    if (entry.state !== "needs_resolution" || item.eventType !== "update" || item.isDeleted
      || item.content?.kind !== "object") return false;
    const snapshot = await options.journal.load();
    if (!snapshot?.inbox.some((candidate) => candidate.cursor === entry.cursor
      && candidate.state === "needs_resolution" && candidate.item.fileId === item.fileId)) return false;
    const prior = await options.baseline.get(item.fileId);
    if (!prior || prior.isDeleted || prior.path !== item.path || prior.fileVersionId !== item.previousVersionId) return false;
    const file = fileAt(item.path);
    if (!file || isVaultPathOpenInMarkdownEditor(app, item.path)) return false;
    const declaredSize = Number(file.stat?.size);
    if (Number.isSafeInteger(declaredSize)) return declaredSize <= VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES;
    const bytes = await currentBytes(item.path);
    return !!bytes && bytes.byteLength <= VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES;
  }

  async function keepLocalForRemoteUpdate(cursor: string, expectedLocalHash?: string): Promise<PushOperationOutcome> {
    const first = await options.journal.load();
    const entry = first?.inbox.find((candidate) => candidate.cursor === cursor);
    if (!entry || entry.state !== "needs_resolution" || entry.item.eventType !== "update" || entry.item.isDeleted
      || entry.item.content?.kind !== "object") {
      throw fail("inbox_keep_local_update_missing", "待处理的远端更新冲突不存在");
    }
    const path = entry.item.path;
    return withVaultSyncV2FileOperationLock(options.identity, entry.item.fileId, () =>
      withVaultPathWriteLocks([path], async () => {
      const snapshot = await options.journal.load();
      const currentEntry = snapshot?.inbox.find((candidate) => candidate.cursor === cursor);
      if (!currentEntry || currentEntry.state !== "needs_resolution" || currentEntry.item.eventType !== "update"
        || currentEntry.item.fileId !== entry.item.fileId || currentEntry.item.fileVersionId !== entry.item.fileVersionId) {
        throw fail("inbox_keep_local_update_stale", "待处理冲突已变化；请刷新冲突中心后重新检查");
      }
      const prior = await options.baseline.get(currentEntry.item.fileId);
      if (!prior || prior.isDeleted || prior.path !== path || prior.fileVersionId !== currentEntry.item.previousVersionId) {
        throw fail("inbox_keep_local_baseline_stale", "本机共同基线与冲突记录不一致；请先重新同步");
      }
      if (isVaultPathOpenInMarkdownEditor(app, path)) {
        throw fail("inbox_keep_local_editor_busy", "请先保存并关闭这篇笔记，再重新提交本机版本");
      }
      const file = fileAt(path);
      if (!file) throw fail("inbox_keep_local_file_missing", "本机冲突文件已不存在；请先找回本机文件");
      const bytes = await currentBytes(path);
      if (!bytes || bytes.byteLength > HISTORY_RESTORE_MAX_BYTES) {
        throw fail("inbox_keep_local_too_large", "本机文件超过 24 MiB 安全提交上限；本地和云端数据仍保留");
      }
      const localContentHash = await sha256Hex(bytes);
      if (expectedLocalHash !== undefined && localContentHash !== expectedLocalHash) {
        throw fail("inbox_keep_local_preview_stale", "本机文件在预览后又有变化；请重新打开冲突中心检查当前内容");
      }
      let operation = (snapshot?.operations ?? []).find((candidate) => candidate.resolvesInboxCursor === cursor);
      let prepared: VaultSyncV2PreparedUpload | undefined;
      if (operation && (operation.fileId !== currentEntry.item.fileId || operation.localContentHash !== localContentHash
        || operation.localByteSize !== bytes.byteLength || operation.request.operation.type !== "update")) {
        throw fail("inbox_keep_local_operation_stale", "已保存的本机重提内容与当前文件不一致；请保留现有文件并重新检查");
      }
      if (operation?.state === "needs_rebase") {
        throw fail("inbox_keep_local_operation_rebase", "本机重提待办需要重新检查；冲突数据仍保存在本地");
      }
      if (!operation || operation.state === "conflict") {
        const page = await options.remote.getFileVersions({ fileId: currentEntry.item.fileId, limit: 1 });
        const head = page.items.find((candidate) => candidate.isCurrent);
        if (!head || head.isDeleted || head.path !== path) {
          throw fail("inbox_keep_local_head_unavailable", "云端最新版本已删除或改名；本机文件保持不变");
        }
        if (head.versionId !== currentEntry.item.fileVersionId) {
          throw fail("inbox_keep_local_head_advanced", "云端版本在冲突进入待处理后又有新变化；本机和云端内容均已保留，请先同步并重新检查冲突");
        }
        prepared = await prepareOwned(bytes);
        if (!preparedUploadMatchesLocal(prepared, localContentHash)) {
          await options.transport.cancelReservations?.([prepared.content.reservationId])?.catch(() => {});
          throw fail("inbox_keep_local_integrity_mismatch", "准备上传的本机内容与当前文件不一致");
        }
        let window: Awaited<ReturnType<VaultSyncRemoteClient["createOperationWindow"]>>;
        try {
          window = await options.remote.createOperationWindow();
          if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
            throw fail("operation_window_expired", "远端写入窗口不可用");
          }
        } catch (error) {
          await options.transport.cancelReservations?.([prepared.content.reservationId])?.catch(() => {});
          throw error;
        }
        const operationId = globalThis.crypto.randomUUID();
        const request: VaultSyncV2Request = {
          protocolVersion: 2, protocolEpoch: options.identity.protocolEpoch, operationWindowId: window.windowId,
          operationId, fileId: currentEntry.item.fileId, expectedVersionId: head.versionId,
          operation: { type: "update", content: {
            reservationId: prepared.content.reservationId, objectId: prepared.content.objectId,
            keyVersion: prepared.content.keyVersion, byteSize: prepared.content.byteSize,
            ciphertextHash: prepared.content.ciphertextHash,
          } },
        };
        const metadata = {
          operationId, fileId: currentEntry.item.fileId,
          operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
          localContentHash, localByteSize: bytes.byteLength,
          localGeneration: operation?.localGeneration ?? Math.max(0, Math.floor(now().getTime())),
          request, resolvesInboxCursor: cursor,
        };
        try {
          operation = operation?.state === "conflict"
            ? await options.journal.replaceConflictOperation(operation.operationId, metadata)
            : await options.journal.enqueue(metadata);
        } catch (error) {
          await options.transport.cancelReservations?.([prepared.content.reservationId])?.catch(() => {});
          throw error;
        }
      }
      const outcome = await processOperation(operation, path, prepared, undefined, true, true, true);
      if (outcome.status !== "committed" || !outcome.baseline) return outcome;
      await options.baseline.setMany([outcome.baseline]);
      if (options.baseContent && path.toLowerCase().endsWith(".md")) {
        await options.baseContent.put(localContentHash, bytes).catch(() => ({ stored: false as const }));
      }
      await options.journal.resolveInboxItem(cursor, localContentHash);
      await options.journal.transition(outcome.operationId, "confirmed");
      await options.journal.pruneConfirmed([outcome.operationId]);
      return outcome;
      }));
  }

  async function commitReviewedDeletion(
    input: VaultSyncV2PendingDeletion,
    assertReviewContextCurrent?: () => void,
  ): Promise<PushOperationOutcome> {
    return withVaultSyncV2FileOperationLock(options.identity, input.fileId, () => {
      // This callback may have waited behind active same-file work. Recheck
      // only after acquiring the lock, before reading or creating durable work.
      assertReviewContextCurrent?.();
      return commitReviewedDeletionLocked(input, assertReviewContextCurrent);
    });
  }

  async function commitReviewedDeletionLocked(
    input: VaultSyncV2PendingDeletion,
    assertReviewContextCurrent?: () => void,
  ): Promise<PushOperationOutcome> {
    const baseline = await options.baseline.get(input.fileId);
    if (!baseline || baseline.isDeleted || baseline.path !== input.path
      || baseline.fileVersionId !== input.expectedVersionId || baseline.plaintextHash !== input.plaintextHash
      || baseline.byteSize !== input.byteSize) {
      throw fail("delete_review_stale", "云端基线在删除确认前发生变化；请重新同步并检查");
    }
    if (fileAt(input.path)) throw fail("delete_review_local_file_returned", "本机路径已重新出现；保留文件并重新同步后再决定");
    const current = await options.journal.load();
    const existingForFile = current?.operations.filter((operation) => operation.fileId === input.fileId) ?? [];
    const existingDeleteOperations = existingForFile.filter((operation) => operation.request.operation.type === "delete");
    if (existingDeleteOperations.length > 1) {
      throw fail("delete_review_operation_stale", "此文件有多条删除待办；请重新同步并检查");
    }
    const existing = existingDeleteOperations[0];
    if (existing && existing.request.expectedVersionId !== input.expectedVersionId) {
      throw fail("delete_review_operation_stale", "本机已有的删除待办绑定了不同云端版本；请先处理冲突");
    }
    let operation = existing;
    if (existing?.state === "conflict") return { status: "conflict", operationId: existing.operationId };
    if (existing?.state === "needs_rebase") return { status: "needs_rebase", operationId: existing.operationId };
    if (!operation) {
      assertReviewContextCurrent?.();
      const window = await options.remote.createOperationWindow();
      if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
        throw fail("operation_window_expired", "远端写入窗口不可用");
      }
      assertReviewContextCurrent?.();
      const operationId = globalThis.crypto.randomUUID();
      const request: VaultSyncV2Request = {
        protocolVersion: 2, protocolEpoch: options.identity.protocolEpoch,
        operationWindowId: window.windowId, operationId, fileId: input.fileId,
        expectedVersionId: input.expectedVersionId, operation: { type: "delete" },
      };
      operation = await options.journal.enqueue({
        operationId, fileId: input.fileId,
        operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
        localContentHash: input.plaintextHash, localByteSize: input.byteSize, localGeneration: 0, request,
      });
    }
    const outcome = operation.request.operation.type === "delete"
      ? await withVaultPathWriteLocks([input.path], () => processDeleteOperation(operation!, input.path, true,
        assertReviewContextCurrent))
      : await processOperation(operation, input.path, undefined, undefined, true, true, true);
    if (outcome.status !== "committed" || !outcome.baseline) return outcome;
    await options.baseline.setMany([outcome.baseline]);
    await options.journal.transition(outcome.operationId, "confirmed");
    await options.journal.pruneConfirmed([outcome.operationId]);
    const superseded = await options.journal.discardSupersededUpdatesByReviewedDelete(input.fileId, input.expectedVersionId);
    const reservationIds = [...new Set(superseded.flatMap((operation) => {
      const content = (operation.request.operation as any).content;
      return typeof content?.reservationId === "string" ? [content.reservationId] : [];
    }))];
    if (reservationIds.length) await options.transport.cancelReservations?.(reservationIds)?.catch(() => {});
    return superseded.length ? { ...outcome, supersededOperationCount: superseded.length } : outcome;
  }

  async function rebaseDeleteConflict(input: { operationId: string; expectedVersionId: string }): Promise<PushOperationOutcome> {
    const snapshot = await options.journal.load();
    const prior = snapshot?.operations.find((entry) => entry.operationId === input.operationId && entry.state === "conflict");
    if (!prior || prior.request.operation.type !== "delete") {
      throw fail("outbox_delete_conflict_not_rebasable", "只有已由用户确认的 delete 冲突可以重新确认");
    }
    const baseline = await options.baseline.get(prior.fileId);
    if (!baseline || baseline.isDeleted || !baseline.plaintextHash) {
      throw fail("outbox_delete_conflict_baseline_missing", "delete 冲突缺少有效的云端基线");
    }
    if (fileAt(baseline.path)) {
      throw fail("outbox_delete_conflict_local_file_returned", "本机文件已重新出现；不会提交删除，请先重新同步");
    }
    const page = await options.remote.getFileVersions({ fileId: prior.fileId, limit: 1 });
    const head = page.items.find((entry) => entry.isCurrent);
    if (!head || head.isDeleted || head.path !== baseline.path
      || head.versionId !== input.expectedVersionId || head.versionId === prior.request.expectedVersionId
      || !baseline.path.toLowerCase().endsWith(".md") || head.contentStatus !== "object_referenced"
      || !head.contentObjectId || head.byteSize > 2 * 1024 * 1024) {
      throw fail("outbox_delete_conflict_head_changed", "云端当前版本与本次确认不一致；请刷新并重新检查");
    }
    if (fileAt(baseline.path)) {
      throw fail("outbox_delete_conflict_local_file_returned", "本机文件在确认期间重新出现；不会提交删除");
    }
    const window = await options.remote.createOperationWindow();
    if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
      throw fail("operation_window_expired", "远端写入窗口不可用");
    }
    const operationId = globalThis.crypto.randomUUID();
    const request: VaultSyncV2Request = {
      ...prior.request,
      operationWindowId: window.windowId,
      operationId,
      expectedVersionId: head.versionId,
      operation: { type: "delete" },
    };
    const replacement = await options.journal.replaceConflictOperation(prior.operationId, {
      operationId, fileId: prior.fileId,
      operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
      localContentHash: prior.localContentHash, localByteSize: prior.localByteSize,
      localGeneration: prior.localGeneration, request,
    });
    const outcome = await processOperation(replacement, baseline.path);
    if (outcome.status !== "committed" || !outcome.baseline) return outcome;
    await options.baseline.setMany([outcome.baseline]);
    await options.journal.transition(outcome.operationId, "confirmed");
    await options.journal.pruneConfirmed([outcome.operationId]);
    return outcome;
  }

  async function rebaseRenameConflict(input: { operationId: string; expectedVersionId: string }): Promise<PushOperationOutcome> {
    const snapshot = await options.journal.load();
    const prior = snapshot?.operations.find((entry) => entry.operationId === input.operationId && entry.state === "conflict");
    if (!prior || prior.request.operation.type !== "rename") {
      throw fail("outbox_rename_conflict_invalid", "只有冲突中的 rename 操作可以重新确认");
    }
    const previous = await options.baseline.get(prior.fileId);
    if (!previous || previous.isDeleted || !previous.plaintextHash) {
      throw fail("outbox_rename_baseline_missing", "改名冲突缺少已验证的云端正文基线");
    }
    const desiredPath = (prior.request.operation as any).path as string;
    if (!fileAt(desiredPath)) throw fail("outbox_rename_local_missing", "本机改名后的文件已不存在；云端改名仍保留在冲突队列");
    const latestPage = await options.remote.getFileVersions({ fileId: prior.fileId, limit: 1 });
    const head: any = latestPage.items.find((entry) => entry.isCurrent);
    if (!head || head.isDeleted || head.versionId !== input.expectedVersionId
      || head.versionId === prior.request.expectedVersionId || !head.contentObjectId
      || head.contentStatus !== "object_referenced" || head.byteSize > options.maxInFlightBytes) {
      throw fail("outbox_rename_remote_changed", "云端 head 不可安全重基；请重新同步并检查冲突");
    }
    if (!options.transport.downloadVersion) throw fail("outbox_rename_content_unavailable", "当前设备无法验证云端改名内容");
    const downloaded = await options.transport.downloadVersion({
      fileId: prior.fileId, versionId: head.versionId, expectedObjectId: head.contentObjectId,
    });
    const latestBytes = downloaded.plaintext;
    if (await sha256Hex(latestBytes) !== previous.plaintextHash || latestBytes.byteLength !== previous.byteSize) {
      throw fail("outbox_rename_content_changed", "云端改名冲突同时包含正文变化；请先处理正文冲突，未重提改名");
    }
    const window = await options.remote.createOperationWindow();
    if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
      throw fail("operation_window_expired", "远端写入窗口不可用");
    }
    const operationId = globalThis.crypto.randomUUID();
    const request: VaultSyncV2Request = {
      ...prior.request, operationWindowId: window.windowId, operationId,
      expectedVersionId: head.versionId,
      operation: { type: "rename", basePath: head.path, path: desiredPath },
    };
    const replacement = await options.journal.replaceConflictOperation(prior.operationId, {
      operationId, fileId: prior.fileId,
      operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
      localContentHash: prior.localContentHash, localByteSize: prior.localByteSize,
      localGeneration: prior.localGeneration, request,
    });
    const remoteBaseline: VaultSyncV2BaselineEntry = {
      fileId: prior.fileId, fileVersionId: head.versionId, cursor: head.changeCursor,
      path: head.path, plaintextHash: previous.plaintextHash, byteSize: previous.byteSize, isDeleted: false,
    };
    const outcome = await processRenameOperation(replacement, remoteBaseline);
    if (outcome.status !== "committed" || !outcome.baseline) return outcome;
    await options.baseline.setMany([outcome.baseline]);
    await options.baseContent?.put(previous.plaintextHash, latestBytes).catch(() => ({ stored: false as const }));
    await options.journal.transition(replacement.operationId, "confirmed");
    await options.journal.pruneConfirmed([replacement.operationId]);
    await options.pathIntents?.removeForFile(prior.fileId);
    return outcome;
  }

  async function cancelDeleteConflict(input: { operationId: string }): Promise<PushOperationOutcome> {
    const snapshot = await options.journal.load();
    const prior = snapshot?.operations.find((entry) => entry.operationId === input.operationId && entry.state === "conflict");
    if (!prior || prior.request.operation.type !== "delete") {
      throw fail("outbox_delete_conflict_not_cancellable", "只有冲突中的 delete 操作可以撤销");
    }
    const baseline = await options.baseline.get(prior.fileId);
    if (!baseline || baseline.isDeleted || !fileAt(baseline.path)) {
      throw fail("outbox_delete_conflict_local_file_missing", "本机文件尚未重新出现；云端删除意图仍保留");
    }
    await options.journal.resolveDeleteConflict(prior.operationId);
    return { status: "skipped", operationId: prior.operationId };
  }

  async function repathCreateConflict(input: { operationId: string }): Promise<PushOperationOutcome> {
    let snapshot = await options.journal.load();
    const found = snapshot?.operations.find((entry) => entry.operationId === input.operationId && entry.state === "conflict");
    if (!found || found.request.operation.type !== "create" || typeof found.request.operation.path !== "string") {
      throw fail("outbox_create_conflict_not_repathable", "只有未关联到远端 inbox 的 create 冲突可以换路径重提");
    }
    let prior: VaultSyncOutboxOperation = found;
    const sourcePath = found.request.operation.path as string;
    let resolution = prior.createResolution;
    if (!resolution) {
      const sourceFile = fileAt(sourcePath);
      const sourceBytes = await currentBytes(sourcePath);
      const sourceMtime = Number(sourceFile?.stat?.mtime);
      if (!sourceFile || !sourceBytes || sourceBytes.byteLength !== prior.localByteSize
        || await sha256Hex(sourceBytes) !== prior.localContentHash
        || !Number.isSafeInteger(Math.floor(sourceMtime)) || Math.floor(sourceMtime) !== prior.localGeneration) {
        throw fail("outbox_create_conflict_local_changed", "本机文件已变化或不再匹配冲突记录；先重新同步并检查文件");
      }
      const targetPath = uniqueVaultConflictCopyPath(sourcePath, String(prior.localGeneration),
        (path) => !!app.vault.getAbstractFileByPath(path));
      resolution = {
        kind: "repath_create",
        sourcePath,
        targetPath,
        sourceContentHash: prior.localContentHash,
        byteSize: prior.localByteSize,
        localGeneration: prior.localGeneration,
      };
      prior = await options.journal.beginCreateConflictResolution(prior.operationId, resolution);
      resolution = prior.createResolution;
    }
    if (!resolution) throw fail("outbox_create_resolution_invalid", "本机 create 换路径意图未能持久化");

    if (resolution.sourcePath !== sourcePath) {
      throw fail("outbox_create_resolution_invalid", "换路径意图与原 create 路径不一致");
    }
    const sourceNow = fileAt(resolution.sourcePath);
    const targetAny = app.vault.getAbstractFileByPath(resolution.targetPath);
    if (sourceNow && !targetAny) {
      await withVaultPathWriteLocks([resolution.sourcePath, resolution.targetPath], async () => {
        if (isVaultPathOpenInMarkdownEditor(app, resolution!.sourcePath)) {
          throw fail("outbox_create_conflict_editor_busy", "本机笔记仍在编辑器中打开；关闭后可继续保留并重提");
        }
        const latestFile = fileAt(resolution!.sourcePath);
        const latestBytes = await currentBytes(resolution!.sourcePath);
        const latestMtime = Number(latestFile?.stat?.mtime);
        if (!latestFile || app.vault.getAbstractFileByPath(resolution!.targetPath) || !latestBytes
          || latestBytes.byteLength !== resolution!.byteSize
          || await sha256Hex(latestBytes) !== resolution!.sourceContentHash
          || !Number.isSafeInteger(Math.floor(latestMtime)) || Math.floor(latestMtime) !== resolution!.localGeneration) {
          throw fail("outbox_create_conflict_local_changed", "换路径期间本机文件发生变化或目标路径被占用；原文件保持不变");
        }
        await app.vault.rename(latestFile, resolution!.targetPath);
      });
    } else if (sourceNow && targetAny) {
      throw fail("outbox_create_conflict_path_collision", "换路径目标在恢复期间被占用；不会根据相同字节推断文件身份");
    }

    const preserved = await currentBytes(resolution.targetPath);
    if (!preserved || preserved.byteLength !== resolution.byteSize
      || await sha256Hex(preserved) !== resolution.sourceContentHash || fileAt(resolution.sourcePath)) {
      throw fail("outbox_create_conflict_copy_unverified", "本机副本尚未通过回读校验；原 outbox 冲突仍保留");
    }
    const upload = await prepareOwned(preserved);
    if (!preparedUploadMatchesLocal(upload, prior.localContentHash)) {
      await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      throw fail("outbox_create_conflict_upload_mismatch", "重新准备的内容与已保留本机文件不一致");
    }
    let durableReplacement = false;
    try {
      const latestPreserved = await currentBytes(resolution.targetPath);
      if (!latestPreserved || latestPreserved.byteLength !== prior.localByteSize
        || await sha256Hex(latestPreserved) !== prior.localContentHash) {
        throw fail("outbox_create_conflict_local_changed", "保留副本在准备上传期间发生变化；冲突操作仍保留");
      }
      const window = await options.remote.createOperationWindow();
      if (window.protocolEpoch !== options.identity.protocolEpoch || Date.parse(window.expiresAt) <= now().getTime()) {
        throw fail("operation_window_expired", "远端写入窗口不可用");
      }
      const operationId = globalThis.crypto.randomUUID();
      const request: VaultSyncV2Request = {
        ...prior.request,
        operationWindowId: window.windowId,
        operationId,
        expectedVersionId: null,
        operation: {
          type: "create",
          path: resolution.targetPath,
          content: {
            reservationId: upload.content.reservationId,
            objectId: upload.content.objectId,
            keyVersion: upload.content.keyVersion,
            byteSize: upload.content.byteSize,
            ciphertextHash: upload.content.ciphertextHash,
          },
        },
      };
      const replacement = await options.journal.replaceConflictOperation(prior.operationId, {
        operationId,
        fileId: prior.fileId,
        operationDigest: await sha256Hex(new TextEncoder().encode(stableJson(request))),
        localContentHash: prior.localContentHash,
        localByteSize: prior.localByteSize,
        localGeneration: prior.localGeneration,
        request,
      });
      durableReplacement = true;
      const oldReservationId = (prior.request.operation as any).content?.reservationId;
      if (oldReservationId && oldReservationId !== upload.content.reservationId) {
        await options.transport.cancelReservations?.([oldReservationId])?.catch(() => {});
      }
      const outcome = await processOperation(replacement, resolution.targetPath, upload);
      if (outcome.status !== "committed" || !outcome.baseline) return outcome;
      await options.baseline.setMany([outcome.baseline]);
      if (options.baseContent && resolution.targetPath.toLowerCase().endsWith(".md")) {
        await options.baseContent.put(prior.localContentHash, preserved).catch(() => ({ stored: false as const }));
      }
      await options.journal.transition(outcome.operationId, "confirmed");
      await options.journal.pruneConfirmed([outcome.operationId]);
      return outcome;
    } catch (error) {
      if (!durableReplacement) await options.transport.cancelReservations?.([upload.content.reservationId])?.catch(() => {});
      throw error;
    }
  }

  return { runOnce, restoreVersion, rebaseConflict, rebaseDeleteConflict, rebaseRenameConflict, cancelDeleteConflict,
    canKeepLocalForRemoteUpdate, keepLocalForRemoteUpdate,
    commitReviewedDeletion, repathCreateConflict };
}
