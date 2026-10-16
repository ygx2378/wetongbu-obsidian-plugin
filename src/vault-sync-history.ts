import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { vaultSyncChunkedCiphertextByteSize } from "./shared/vault-sync-chunked-crypto.ts";
import { createVaultSyncObjectWorkGate } from "./vault-sync-object-work-gate.ts";

export const HISTORY_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
// The existing transfer queue budgets one in-flight object at four times its
// plaintext size against a 96 MiB ceiling. Historical restores run one at a
// time, so 24 MiB is the largest bounded restore that fits that same budget.
// Larger files also need a cross-platform local readback API before they can
// be safely recovered after a process restart.
export const VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES = 24 * 1024 * 1024;
export const HISTORY_RESTORE_MAX_BYTES = VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES;

export function vaultSyncCiphertextLimitForPlaintext(plaintextBytes: number): number {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0) return -1;
  return Math.max(plaintextBytes + 29, vaultSyncChunkedCiphertextByteSize(plaintextBytes));
}

/**
 * New server versions report the exact plaintext size. Older encrypted versions
 * stored ciphertext size in the outer byteSize field, so accept that legacy
 * equality while still bounding decrypted data and checking known plain sizes.
 */
export function isVaultSyncPlaintextSizeCompatible(input: {
  itemByteSize: number;
  content: { kind: "object" | "legacy"; byteSize: number };
  plaintextByteSize: number;
  maxPlaintextBytes?: number;
  allowEncryptedSize?: boolean;
}): boolean {
  const maxPlaintextBytes = input.maxPlaintextBytes ?? VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES;
  if (!Number.isSafeInteger(input.itemByteSize) || input.itemByteSize < 0
    || !Number.isSafeInteger(input.content.byteSize) || input.content.byteSize < 0
    || !Number.isSafeInteger(input.plaintextByteSize) || input.plaintextByteSize < 0
    || input.plaintextByteSize > maxPlaintextBytes) return false;
  if (input.content.kind === "legacy") {
    return input.itemByteSize === input.content.byteSize && input.plaintextByteSize === input.itemByteSize;
  }
  if (input.itemByteSize > input.content.byteSize || input.plaintextByteSize > input.content.byteSize) return false;
  if (input.itemByteSize < input.content.byteSize) return input.allowEncryptedSize === true
    && input.content.byteSize <= vaultSyncCiphertextLimitForPlaintext(maxPlaintextBytes)
    && input.itemByteSize <= maxPlaintextBytes && input.itemByteSize === input.plaintextByteSize;
  return input.allowEncryptedSize === true
    ? input.content.byteSize <= vaultSyncCiphertextLimitForPlaintext(maxPlaintextBytes)
      && input.plaintextByteSize <= maxPlaintextBytes
    : input.plaintextByteSize === input.itemByteSize;
}

export function isVaultSyncContentWithinPlaintextLimit(
  itemByteSize: number,
  content: { kind: "object" | "legacy"; byteSize: number },
  maxPlaintextBytes: number,
  allowEncryptedSize = false,
): boolean {
  if (!Number.isSafeInteger(itemByteSize) || itemByteSize < 0
    || !Number.isSafeInteger(content.byteSize) || content.byteSize < 0) return false;
  if (content.kind === "legacy") return itemByteSize <= maxPlaintextBytes && content.byteSize <= maxPlaintextBytes;
  if (itemByteSize > content.byteSize) return false;
  if (!allowEncryptedSize) return itemByteSize === content.byteSize && content.byteSize <= maxPlaintextBytes;
  return content.byteSize <= vaultSyncCiphertextLimitForPlaintext(maxPlaintextBytes)
    && (itemByteSize === content.byteSize || itemByteSize <= maxPlaintextBytes);
}

/** Kept as an alias for callers written before the gate covered all large objects. */
export const createHistoryRestoreGate = createVaultSyncObjectWorkGate;

type HistoryVersionAvailability = {
  isDeleted: boolean;
  isCurrent: boolean;
  path: string;
  byteSize: number;
  contentStatus: string;
  contentObjectId: string | null;
};

export function canPreviewHistoryVersion(version: HistoryVersionAvailability): boolean {
  return !version.isDeleted && version.contentStatus === "object_referenced" && version.contentObjectId !== null
    && version.path.toLowerCase().endsWith(".md") && Number.isSafeInteger(version.byteSize)
    && version.byteSize >= 0 && version.byteSize <= HISTORY_PREVIEW_MAX_BYTES;
}

/** Turn storage and decryption failures into clear, non-destructive history UI copy. */
export function formatVaultSyncHistoryError(error: unknown): string {
  const value = error && typeof error === "object" ? error as { code?: unknown; name?: unknown; message?: unknown } : null;
  const code = typeof value?.code === "string" ? value.code : "";
  const keyVersion = Number.isSafeInteger((error as any)?.keyVersion) ? `（密钥版本 ${(error as any).keyVersion}）` : "";
  if (code === "encryption_key_required") {
    return `此设备缺少该历史版本所需的 Vault 加密密钥${keyVersion}。请在具备该密钥且已解锁的设备上重试。`;
  }
  if (value?.name === "OperationError") {
    return "历史内容无法通过 Vault 密钥解密。请核对 Vault 密码；如果密码正确，内容可能已损坏。没有覆盖原文件。";
  }
  if (code === "integrity_mismatch") {
    return "历史内容未通过完整性校验。没有覆盖原文件或推进同步回执。";
  }
  if (code === "history_content_pruned") {
    return "该历史版本正文已按留存策略清理，无法预览或恢复。当前文件保持不变。";
  }
  if (code === "history_content_legacy_unverified") {
    return "该旧历史版本没有经过完整性验证，无法安全预览或恢复。当前文件保持不变。";
  }
  if (code === "history_version_deleted" || code === "history_version_unavailable" || code === "history_content_unavailable") {
    return "该历史版本当前不可读取，可能已删除或没有可验证的内容。当前文件保持不变。";
  }
  if (code === "content_object_unavailable" || code === "history_download_unavailable") {
    return "历史对象暂不可用，或已按留存策略清理。原文件保持不变。";
  }
  if (code === "object_download_failed" || code === "retryable_storage_error") {
    return "历史对象暂未下载完成。原文件保持不变，可以稍后重试。";
  }
  if (typeof value?.message === "string" && value.message) return value.message;
  return String(error);
}

export function canRestoreHistoryVersion(version: HistoryVersionAvailability): boolean {
  return !version.isDeleted && !version.isCurrent && version.contentStatus === "object_referenced"
    && version.contentObjectId !== null && Number.isSafeInteger(version.byteSize)
    && version.byteSize >= 0 && version.byteSize <= HISTORY_RESTORE_MAX_BYTES;
}

/** Choose the original path after a deleted head when it is free, otherwise a deterministic unused path. */
export function historyRestoreTargetPath(
  sourcePath: string,
  versionNumber: string,
  deletedHead: boolean,
  isOccupied: (path: string) => boolean,
): string {
  const normalized = normalizeVaultPath(sourcePath);
  if (!normalized) throw Object.assign(new Error("历史恢复路径无效"), { code: "history_restore_path_invalid" });
  if (!/^[1-9][0-9]*$/.test(versionNumber)) {
    throw Object.assign(new Error("历史版本号无效"), { code: "history_restore_version_invalid" });
  }
  if (deletedHead && !isOccupied(normalized)) return normalized;
  return uniqueHistoryRestorePath(normalized, versionNumber, isOccupied);
}

/** Choose a deterministic, unused path for a non-destructive history restore. */
export function uniqueHistoryRestorePath(
  sourcePath: string,
  versionNumber: string,
  isOccupied: (path: string) => boolean,
): string {
  const normalized = normalizeVaultPath(sourcePath);
  if (!normalized) {
    throw Object.assign(new Error("历史恢复路径无效"), { code: "history_restore_path_invalid" });
  }
  if (!/^[1-9][0-9]*$/.test(versionNumber)) {
    throw Object.assign(new Error("历史版本号无效"), { code: "history_restore_version_invalid" });
  }
  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const filename = normalized.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const sequence = suffix === 1 ? "" : `-${suffix}`;
    const candidate = normalizeVaultPath(`${folder}${stem}.restored-v${versionNumber}${sequence}${extension}`);
    if (candidate && !isOccupied(candidate)) return candidate;
  }
  throw Object.assign(new Error("无法为恢复内容找到未占用的文件路径"), { code: "history_restore_path_unavailable" });
}

/** Allocate a side-copy path without replacing another local file. */
export function uniqueVaultConflictCopyPath(
  sourcePath: string,
  cursor: string,
  isOccupied: (path: string) => boolean,
  sourceDeviceId?: string,
): string {
  const normalized = normalizeVaultPath(sourcePath);
  if (!normalized || !/^(0|[1-9][0-9]*)$/.test(cursor)) {
    throw Object.assign(new Error("冲突副本路径或变更游标无效"), { code: "conflict_copy_path_invalid" });
  }
  if (sourceDeviceId !== undefined
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceDeviceId)) {
    throw Object.assign(new Error("冲突副本来源设备无效"), { code: "conflict_copy_path_invalid" });
  }
  const slash = normalized.lastIndexOf("/");
  const folder = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const filename = normalized.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  // A first-join collision is local to one device, so include its stable
  // identity. Two devices bootstrapping the same cloud cursor must not upload
  // their different local drafts under the same conflict-copy path.
  const deviceSuffix = sourceDeviceId ? `-${sourceDeviceId.replace(/-/g, "").toLowerCase()}` : "";
  const conflictSuffix = `.sync-conflict-local-${cursor}${deviceSuffix}`;
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const sequence = suffix === 1 ? "" : `-${suffix}`;
    const availableStemLength = 255 - conflictSuffix.length - sequence.length - extension.length;
    if (availableStemLength < 1) {
      throw Object.assign(new Error("无法为冲突内容找到符合跨平台路径限制的副本路径"), {
        code: "conflict_copy_path_unavailable",
      });
    }
    let boundedStem = "";
    for (const character of stem) {
      if (boundedStem.length + character.length > availableStemLength) break;
      boundedStem += character;
    }
    const candidate = normalizeVaultPath(`${folder}${boundedStem}${conflictSuffix}${sequence}${extension}`);
    if (candidate && !isOccupied(candidate)) return candidate;
  }
  throw Object.assign(new Error("无法为冲突内容找到未占用的副本路径"), { code: "conflict_copy_path_unavailable" });
}
