import { sha256Hex } from "./shared/hash.ts";
import { Sha256Accumulator } from "./shared/sha256-stream.ts";
import type { VaultSyncCrypto, VaultSyncCryptoKeyring } from "./shared/vault-sync-crypto.ts";
import { getVaultSyncRetryAfterFromResponse } from "./vault-sync-retry.ts";
import { VAULT_SYNC_DOWNLOAD_STAGE_MAX_BYTES, type VaultSyncV2DownloadStageRequest, type VaultSyncV2DownloadStageStore } from "./vault-sync-v2-download-stage.ts";
import { VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES, vaultSyncCiphertextLimitForPlaintext } from "./vault-sync-history.ts";
import type { VaultSyncMultipartTransferDiagnostic } from "./vault-sync-diagnostics.ts";

export interface VaultSyncV2ContentRef {
  reservationId: string;
  objectId: string;
  encryptionDomainId: string;
  keyVersion: number;
  byteSize: number;
  ciphertextHash: string;
}

export interface VaultSyncV2ObjectRemote {
  reserveContentObject(input: { ciphertextHash: string; byteSize: number; keyVersion: number }): Promise<{
    objectId: string; reservationId: string; encryptionDomainId: string; keyVersion: number;
    byteSize: number; ciphertextHash: string; uploadUrl: string | null; uploadExpiresAt?: string; deduped: boolean;
  }>;
  finalizeContentObject(reservationId: string): Promise<{
    objectId: string; encryptionDomainId: string; keyVersion: number; byteSize: number;
    ciphertextHash: string; finalized: boolean; alreadyFinalized: boolean;
  }>;
  prepareContentObjects?(items: Array<{ ciphertextHash: string; byteSize: number; keyVersion: number }>): Promise<Array<
    | { index: number; status: "prepared"; objectId: string; reservationId: string; encryptionDomainId: string;
        keyVersion: number; byteSize: number; ciphertextHash: string; uploadUrl: string | null;
        uploadExpiresAt: string; deduped: boolean }
    | { index: number; status: "failed"; code: string }
  >>;
  cancelContentObjectReservations?(reservationIds: string[]): Promise<Array<{ reservationId: string; status: string }>>;
  beginContentObjectMultipartUpload?(reservationId: string): Promise<{
    deduped: boolean; partSize: number | null; partCount: number;
    uploadedParts: Array<{ partNumber: number; byteSize: number }>; expiresAt: string;
  }>;
  getContentObjectMultipartPartUrl?(reservationId: string, partNumber: number): Promise<{
    uploadUrl: string; expiresAt: string; partNumber: number;
  }>;
  completeContentObjectMultipartUpload?(reservationId: string): Promise<{ completed: boolean; alreadyCompleted: boolean }>;
  getContentObject(objectId: string): Promise<Omit<VaultSyncV2ContentRef, "reservationId"> & {
    downloadUrl: string; leaseId: string; leaseExpiresAt: string;
  }>;
  getFileVersionContent?(fileId: string, versionId: string): Promise<Omit<VaultSyncV2ContentRef, "reservationId"> & {
    downloadUrl: string; leaseId: string; leaseExpiresAt: string;
  }>;
}

export interface VaultSyncV2ObjectRequest {
  url: string;
  method: "GET" | "PUT";
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  throw?: boolean;
}

export type VaultSyncV2ObjectRequestResult = {
  status: number;
  headers?: Record<string, string>;
  arrayBuffer?: ArrayBuffer;
};

export const VAULT_SYNC_MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const VAULT_SYNC_DOWNLOAD_RANGE_BYTES = 8 * 1024 * 1024;
type VaultSyncV2DownloadLease = Omit<VaultSyncV2ContentRef, "reservationId"> & {
  downloadUrl: string; leaseId: string; leaseExpiresAt: string;
};

export const VAULT_SYNC_MAX_BOUNDED_ENCRYPTED_OBJECT_BYTES = vaultSyncCiphertextLimitForPlaintext(
  VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES,
);

function storageError(message: string, response: VaultSyncV2ObjectRequestResult, permanentCode: string) {
  const retryable = response.status >= 500 || response.status === 429 || response.status === 408 || response.status === 425;
  const retryAfterMs = getVaultSyncRetryAfterFromResponse(response);
  return Object.assign(new Error(message), {
    code: retryable ? "retryable_storage_error" : permanentCode,
    status: response.status,
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  });
}

export interface VaultSyncV2PreparedUpload {
  content: VaultSyncV2ContentRef;
  plaintextHash: string;
  ciphertextHash: string;
  objectBytes: Uint8Array;
  uploadUrl: string | null;
  uploadExpiresAt?: string;
  deduped: boolean;
}

export interface VaultSyncV2HostedObjectTransportOptions {
  downloadStage?: VaultSyncV2DownloadStageStore;
  downloadRangeBytes?: number;
  /** Synchronous local pause boundary checked before writes and after in-flight requests. */
  assertCanContinue?: () => void;
  /** Process-local, allowlisted stage/status observations; callback failures never affect transfer. */
  onMultipartTransfer?: (diagnostic: VaultSyncMultipartTransferDiagnostic) => void;
}

/** V2 object transfer hashes ciphertext and keeps the plaintext hash client-side. */
export function createV2HostedObjectTransport(
  remote: VaultSyncV2ObjectRemote,
  request: (input: VaultSyncV2ObjectRequest) => Promise<VaultSyncV2ObjectRequestResult>,
  crypto?: VaultSyncCrypto | VaultSyncCryptoKeyring,
  options: VaultSyncV2HostedObjectTransportOptions = {},
) {
  const downloadRangeBytes = options.downloadRangeBytes ?? VAULT_SYNC_DOWNLOAD_RANGE_BYTES;
  if (!Number.isSafeInteger(downloadRangeBytes) || downloadRangeBytes < 5 * 1024 * 1024) {
    throw Object.assign(new Error("对象下载分段尺寸无效"), { code: "invalid_download_range_size" });
  }
  const isKeyring = (value: VaultSyncCrypto | VaultSyncCryptoKeyring): value is VaultSyncCryptoKeyring =>
    "activeKeyVersion" in value && typeof value.forVersion === "function";
  const activeKey = crypto && isKeyring(crypto) ? crypto.forVersion(crypto.activeKeyVersion) : crypto;
  const writeKeyVersion = crypto ? (isKeyring(crypto) ? crypto.activeKeyVersion : crypto.keyVersion) : 1;
  const cryptoForVersion = (keyVersion: number): VaultSyncCrypto | undefined => {
    const selected = crypto ? (isKeyring(crypto) ? crypto.forVersion(keyVersion) : crypto.keyVersion === keyVersion ? crypto : undefined) : undefined;
    return selected?.keyVersion === keyVersion ? selected : undefined;
  };
  if (!Number.isSafeInteger(writeKeyVersion) || writeKeyVersion < 1
    || (crypto && (!activeKey || activeKey.keyVersion !== writeKeyVersion))) {
    throw Object.assign(new Error("当前 Vault 加密密钥版本不可用"), { code: "encryption_key_required" });
  }

  const reportMultipartTransfer = (stage: VaultSyncMultipartTransferDiagnostic["stage"],
    outcome: VaultSyncMultipartTransferDiagnostic["outcome"], httpStatus?: number, errorCode?: string) => {
    try {
      options.onMultipartTransfer?.({ stage, outcome,
        ...(httpStatus === undefined ? {} : { httpStatus }), ...(errorCode === undefined ? {} : { errorCode }) });
    } catch { /* diagnostics must not affect sync */ }
  };

  const assertCanContinue = () => options.assertCanContinue?.();

  const trackMultipartTransfer = async <T>(
    stage: VaultSyncMultipartTransferDiagnostic["stage"],
    action: () => Promise<T>,
  ): Promise<T> => {
    reportMultipartTransfer(stage, "started");
    try {
      const result = await action();
      reportMultipartTransfer(stage, "succeeded");
      return result;
    } catch (error) {
      const status = Number((error as { status?: unknown } | null)?.status);
      const errorCode = (error as { code?: unknown } | null)?.code;
      reportMultipartTransfer(stage, "failed", Number.isSafeInteger(status) && status >= 100 && status <= 599
        ? status : undefined, typeof errorCode === "string" ? errorCode : undefined);
      throw error;
    }
  };

  function assertLeaseMatches(
    content: Omit<VaultSyncV2ContentRef, "reservationId">,
    lease: Awaited<ReturnType<VaultSyncV2ObjectRemote["getContentObject"]>>,
  ): void {
    if (lease.objectId !== content.objectId || lease.encryptionDomainId !== content.encryptionDomainId
      || lease.keyVersion !== content.keyVersion || lease.byteSize !== content.byteSize
      || lease.ciphertextHash !== content.ciphertextHash) {
      throw Object.assign(new Error("下载对象与文件版本元数据不一致"), { code: "integrity_mismatch" });
    }
  }

  async function downloadWithRanges(
    content: Omit<VaultSyncV2ContentRef, "reservationId">,
    initialLease: Awaited<ReturnType<VaultSyncV2ObjectRemote["getContentObject"]>>,
    refreshLease: () => Promise<Awaited<ReturnType<VaultSyncV2ObjectRemote["getContentObject"]>>>,
  ): Promise<Uint8Array> {
    const partCount = Math.ceil(content.byteSize / downloadRangeBytes);
    const stageRequest: VaultSyncV2DownloadStageRequest = {
      objectId: content.objectId, ciphertextHash: content.ciphertextHash,
      byteSize: content.byteSize, partSize: downloadRangeBytes,
    };
    const output = new Uint8Array(content.byteSize);
    let activeLease = initialLease;
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const cached = await options.downloadStage!.readPart(stageRequest, partNumber);
      const start = (partNumber - 1) * downloadRangeBytes;
      const end = Math.min(start + downloadRangeBytes, content.byteSize) - 1;
      let part = cached;
      if (!part) {
        let response: VaultSyncV2ObjectRequestResult = { status: 0 };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          response = await request({
            url: activeLease.downloadUrl, method: "GET", headers: { Range: `bytes=${start}-${end}` }, throw: false,
          });
          if (response.status === 401 || response.status === 403) {
            if (attempt === 0) {
              activeLease = await refreshLease();
              assertLeaseMatches(content, activeLease);
              continue;
            }
          } else if (response.status >= 500 || response.status === 429 || response.status === 408 || response.status === 425) {
            if (attempt === 0) continue;
          }
          break;
        }
        if (response.status === 404) throw Object.assign(new Error("同步对象暂不可用"), { code: "content_object_unavailable" });
        if (response.status === 200 && response.arrayBuffer?.byteLength === content.byteSize
          && content.byteSize <= 24 * 1024 * 1024) {
          await options.downloadStage!.clear(stageRequest);
          return new Uint8Array(response.arrayBuffer);
        }
        if (response.status !== 206 || !response.arrayBuffer) {
          throw storageError("对象分段下载暂未完成", response, "object_download_failed");
        }
        const contentRange = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "content-range")?.[1];
        if (contentRange !== `bytes ${start}-${end}/${content.byteSize}` || response.arrayBuffer.byteLength !== end - start + 1) {
          throw Object.assign(new Error("对象分段响应的范围或字节数不一致"), { code: "integrity_mismatch" });
        }
        part = new Uint8Array(response.arrayBuffer);
        await options.downloadStage!.writePart(stageRequest, partNumber, part);
      }
      const expectedSize = end - start + 1;
      if (part.byteLength !== expectedSize) throw Object.assign(new Error("本地暂存的对象分段尺寸不一致"), { code: "integrity_mismatch" });
      output.set(part, start);
    }
    return output;
  }

  async function downloadWithLease(
    content: Omit<VaultSyncV2ContentRef, "reservationId">,
    lease: Awaited<ReturnType<VaultSyncV2ObjectRemote["getContentObject"]>>,
    refreshLease: () => Promise<Awaited<ReturnType<VaultSyncV2ObjectRemote["getContentObject"]>>>,
  ): Promise<{ plaintext: Uint8Array; plaintextHash: string }> {
    if (!Number.isSafeInteger(content.byteSize) || content.byteSize < 0
      || content.byteSize > VAULT_SYNC_MAX_BOUNDED_ENCRYPTED_OBJECT_BYTES) {
      throw Object.assign(new Error("同步对象超过当前 24 MiB 安全处理上限"), { code: "object_download_too_large" });
    }
    assertLeaseMatches(content, lease);
    let objectBytes: Uint8Array;
    const useRanges = Boolean(options.downloadStage) && content.byteSize >= downloadRangeBytes;
    if (useRanges) {
      objectBytes = await downloadWithRanges(content, lease, refreshLease);
    } else {
      let response: VaultSyncV2ObjectRequestResult = { status: 0 };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await request({ url: lease.downloadUrl, method: "GET", throw: false });
        if (response.status === 401 || response.status === 403) {
          if (attempt === 0) {
            lease = await refreshLease();
            assertLeaseMatches(content, lease);
            continue;
          }
        }
        break;
      }
      if (response.status === 404) throw Object.assign(new Error("同步对象暂不可用"), { code: "content_object_unavailable" });
      if (response.status < 200 || response.status >= 300 || !response.arrayBuffer) {
        throw storageError("对象下载暂未完成", response, "object_download_failed");
      }
      objectBytes = new Uint8Array(response.arrayBuffer);
    }
    if (objectBytes.byteLength !== content.byteSize || await sha256Hex(objectBytes) !== content.ciphertextHash) {
      if (useRanges) await options.downloadStage!.clear({
        objectId: content.objectId, ciphertextHash: content.ciphertextHash,
        byteSize: content.byteSize, partSize: downloadRangeBytes,
      }).catch(() => {});
      throw Object.assign(new Error("下载对象密文摘要或尺寸校验失败"), { code: "integrity_mismatch" });
    }
    if (useRanges) await options.downloadStage!.clear({
      objectId: content.objectId, ciphertextHash: content.ciphertextHash,
      byteSize: content.byteSize, partSize: downloadRangeBytes,
    });
    if (crypto) {
      const decryptionKey = cryptoForVersion(content.keyVersion);
      if (!decryptionKey) {
        throw Object.assign(new Error("此设备缺少该历史对象对应的 Vault 加密密钥"), {
          code: "encryption_key_required", keyVersion: content.keyVersion,
        });
      }
      return decryptionKey.decryptObject(objectBytes);
    }
    if (content.keyVersion !== 1) {
      throw Object.assign(new Error("此设备不支持读取该对象的 Vault 加密密钥版本"), {
        code: "encryption_key_required", keyVersion: content.keyVersion,
      });
    }
    return { plaintext: objectBytes, plaintextHash: await sha256Hex(objectBytes) };
  }

  async function downloadChunkedToSink(
    content: Omit<VaultSyncV2ContentRef, "reservationId">,
    expectedPlaintextBytes: number | undefined,
    writePlaintextChunk: (bytes: Uint8Array) => Promise<void> | void,
    leaseOverride?: { initial: VaultSyncV2DownloadLease; refresh: () => Promise<VaultSyncV2DownloadLease> },
    preferStreamingRanges = false,
  ): Promise<{ plaintextBytes: number; plaintextHash: string; ciphertextBytes: number }> {
    if (!crypto) {
      throw Object.assign(new Error("分块对象读取参数无效或缺少 Vault 加密密钥"), { code: "encryption_key_required" });
    }
    if (expectedPlaintextBytes !== undefined
      && (!Number.isSafeInteger(expectedPlaintextBytes) || expectedPlaintextBytes < 0)) {
      throw Object.assign(new Error("分块对象读取明文尺寸无效"), { code: "object_download_invalid" });
    }
    if (expectedPlaintextBytes !== undefined && expectedPlaintextBytes > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES) {
      throw Object.assign(new Error("同步对象超过当前 24 MiB 安全处理上限"), { code: "object_download_too_large" });
    }
    if (!Number.isSafeInteger(content.byteSize) || content.byteSize < 25 + 16
      || content.byteSize > VAULT_SYNC_MAX_BOUNDED_ENCRYPTED_OBJECT_BYTES) {
      throw Object.assign(new Error("同步对象超过当前 24 MiB 安全处理上限"), { code: "object_download_too_large" });
    }
    const decryptionKey = cryptoForVersion(content.keyVersion) as (VaultSyncCrypto & {
      decryptObjectChunked?: (source: Uint8Array | AsyncIterable<Uint8Array>, sink: (bytes: Uint8Array) => Promise<void> | void,
        expectedBytes?: number) => Promise<{
        plaintextBytes: number; plaintextHash: string; ciphertextBytes: number;
      }>;
    }) | undefined;
    if (!decryptionKey || typeof decryptionKey.decryptObjectChunked !== "function") {
      throw Object.assign(new Error("此设备缺少该对象的分块加密读取能力或 Vault 密钥"), {
        code: "encryption_key_required", keyVersion: content.keyVersion,
      });
    }
    let lease = leaseOverride?.initial ?? await remote.getContentObject(content.objectId);
    assertLeaseMatches(content, lease);
    const refreshLease = leaseOverride?.refresh ?? (() => remote.getContentObject(content.objectId));
    const stageRequest: VaultSyncV2DownloadStageRequest = {
      objectId: content.objectId, ciphertextHash: content.ciphertextHash,
      byteSize: content.byteSize, partSize: downloadRangeBytes,
    };
    const useDurableRanges = !preferStreamingRanges && Boolean(options.downloadStage)
      && content.byteSize >= downloadRangeBytes && content.byteSize <= VAULT_SYNC_DOWNLOAD_STAGE_MAX_BYTES;
    const useStreamingRanges = content.byteSize >= downloadRangeBytes && !useDurableRanges;
    let result: Awaited<ReturnType<NonNullable<typeof decryptionKey.decryptObjectChunked>>>;
    const decrypt = async (source: Uint8Array | AsyncIterable<Uint8Array>) => {
      try {
        return await decryptionKey.decryptObjectChunked!(source, writePlaintextChunk, expectedPlaintextBytes);
      } catch (error) {
        if (useDurableRanges && (error as any)?.code === "integrity_mismatch") {
          await options.downloadStage!.clear(stageRequest).catch(() => {});
        }
        throw error;
      }
    };

    const requestRange = async (start: number, end: number, allowWholeFallback = false): Promise<{
      part?: Uint8Array; wholeObject?: Uint8Array;
    }> => {
      let response: VaultSyncV2ObjectRequestResult = { status: 0 };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        response = await request({
          url: lease.downloadUrl, method: "GET", headers: { Range: `bytes=${start}-${end}` }, throw: false,
        });
        if (response.status === 401 || response.status === 403) {
          if (attempt === 0) {
            lease = await refreshLease();
            assertLeaseMatches(content, lease);
            continue;
          }
        } else if (response.status >= 500 || response.status === 429 || response.status === 408 || response.status === 425) {
          if (attempt === 0) continue;
        }
        break;
      }
      if (response.status === 404) {
        throw Object.assign(new Error("同步对象暂不可用"), { code: "content_object_unavailable" });
      }
      if (response.status === 200 && response.arrayBuffer?.byteLength === content.byteSize) {
        if (allowWholeFallback) return { wholeObject: new Uint8Array(response.arrayBuffer) };
        throw Object.assign(new Error("对象存储未执行 Range 请求；为避免整对象载入内存，已暂停流式下载"), {
          code: "range_download_unsupported",
        });
      }
      if (response.status !== 206 || !response.arrayBuffer) {
        throw storageError("对象分段下载暂未完成", response, "object_download_failed");
      }
      const contentRange = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "content-range")?.[1];
      if (contentRange !== `bytes ${start}-${end}/${content.byteSize}`
        || response.arrayBuffer.byteLength !== end - start + 1) {
        throw Object.assign(new Error("对象分段响应的范围或字节数不一致"), { code: "integrity_mismatch" });
      }
      return { part: new Uint8Array(response.arrayBuffer) };
    };

    if (!useDurableRanges && !useStreamingRanges) {
      const response = await request({ url: lease.downloadUrl, method: "GET", throw: false });
      if (response.status === 404) throw Object.assign(new Error("同步对象暂不可用"), { code: "content_object_unavailable" });
      if (response.status < 200 || response.status >= 300 || !response.arrayBuffer) {
        throw storageError("对象下载暂未完成", response, "object_download_failed");
      }
      const ciphertext = new Uint8Array(response.arrayBuffer);
      if (ciphertext.byteLength !== content.byteSize || await sha256Hex(ciphertext) !== content.ciphertextHash) {
        throw Object.assign(new Error("下载对象密文摘要或尺寸校验失败"), { code: "integrity_mismatch" });
      }
      result = await decrypt(ciphertext);
    } else if (useDurableRanges) {
      const partCount = Math.ceil(content.byteSize / downloadRangeBytes);
      const cipherHasher = new Sha256Accumulator();
      let wholeObject: Uint8Array | null = null;

      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const cached = await options.downloadStage!.readPart(stageRequest, partNumber);
        const start = (partNumber - 1) * downloadRangeBytes;
        const end = Math.min(start + downloadRangeBytes, content.byteSize) - 1;
        let part = cached;
        if (!part) {
          const response = await requestRange(start, end, true);
          if (response.wholeObject) {
            wholeObject = response.wholeObject;
            break;
          }
          if (!response.part) throw Object.assign(new Error("对象分段响应缺少数据"), { code: "integrity_mismatch" });
          part = response.part;
          await options.downloadStage!.writePart(stageRequest, partNumber, part);
        }
        if (part.byteLength !== end - start + 1) {
          throw Object.assign(new Error("本地暂存的对象分段尺寸不一致"), { code: "integrity_mismatch" });
        }
        // Format 2 cannot be streamed. Detect it in the first durable range so
        // the caller can fall back without downloading or hashing later ranges;
        // the legacy whole-object path will reuse this verified-size part and
        // authenticate the complete ciphertext before decrypting.
        if (partNumber === 1 && part[0] !== 3) {
          throw Object.assign(new Error("Vault 对象使用其他加密格式"), { code: "chunked_format_unsupported" });
        }
        cipherHasher.update(part);
      }

      if (wholeObject) {
        if (await sha256Hex(wholeObject) !== content.ciphertextHash) {
          await options.downloadStage!.clear(stageRequest).catch(() => {});
          throw Object.assign(new Error("下载对象密文摘要校验失败"), { code: "integrity_mismatch" });
        }
        result = await decrypt(wholeObject);
      } else {
        if (cipherHasher.digestHex() !== content.ciphertextHash) {
          await options.downloadStage!.clear(stageRequest).catch(() => {});
          throw Object.assign(new Error("下载对象密文摘要校验失败"), { code: "integrity_mismatch" });
        }
        const stagedCiphertext = async function* (): AsyncGenerator<Uint8Array> {
          for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            const part = await options.downloadStage!.readPart(stageRequest, partNumber);
            if (!part) throw Object.assign(new Error("已验证的对象分段暂存缺失"), { code: "download_stage_part_missing" });
            yield part;
          }
        };
        result = await decrypt(stagedCiphertext());
      }
      await options.downloadStage!.clear(stageRequest);
    } else {
      const partCount = Math.ceil(content.byteSize / downloadRangeBytes);
      const cipherHasher = new Sha256Accumulator();
      let ciphertextBytes = 0;
      let rangeTransportError: unknown;
      const rangedCiphertext = async function* (): AsyncGenerator<Uint8Array> {
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
          const start = (partNumber - 1) * downloadRangeBytes;
          const end = Math.min(start + downloadRangeBytes, content.byteSize) - 1;
          let range: { part?: Uint8Array; wholeObject?: Uint8Array };
          try {
            range = await requestRange(start, end);
          } catch (error) {
            rangeTransportError = error;
            throw error;
          }
          if (!range.part) throw Object.assign(new Error("流式对象分段响应缺少数据"), { code: "integrity_mismatch" });
          const part = range.part;
          if (partNumber === 1 && part[0] !== 3) {
            throw Object.assign(new Error("Vault 对象使用其他加密格式，不能按 1 MiB 明文块安全解密"), {
              code: "chunked_format_unsupported",
            });
          }
          cipherHasher.update(part);
          ciphertextBytes += part.byteLength;
          yield part;
        }
      };
      try {
        result = await decrypt(rangedCiphertext());
      } catch (error) {
        // The crypto reader deliberately maps source truncation to an integrity
        // error. Preserve a known HTTP/range failure so retry metadata survives.
        if (rangeTransportError) throw rangeTransportError;
        throw error;
      }
      if (ciphertextBytes !== content.byteSize || cipherHasher.digestHex() !== content.ciphertextHash.toLowerCase()) {
        throw Object.assign(new Error("流式下载的对象密文摘要或尺寸校验失败"), { code: "integrity_mismatch" });
      }
    }

    if (result.ciphertextBytes !== content.byteSize || result.plaintextBytes > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES
      || (expectedPlaintextBytes !== undefined && result.plaintextBytes !== expectedPlaintextBytes)) {
      throw Object.assign(new Error("分块对象明文尺寸与远端版本记录不一致"), { code: "integrity_mismatch" });
    }
    return { plaintextBytes: result.plaintextBytes, plaintextHash: result.plaintextHash, ciphertextBytes: result.ciphertextBytes };
  }

  async function prepareObject(plaintext: Uint8Array, transferOwnership: boolean): Promise<VaultSyncV2PreparedUpload> {
    const plaintextHash = await sha256Hex(plaintext);
    const objectBytes = activeKey
      ? await activeKey.encryptObject(plaintext, plaintextHash)
      : transferOwnership ? plaintext : plaintext.slice();
    const ciphertextHash = activeKey ? await sha256Hex(objectBytes) : plaintextHash;
    const reservation = await remote.reserveContentObject({
      ciphertextHash,
      byteSize: objectBytes.byteLength,
      keyVersion: writeKeyVersion,
    });
    if (reservation.ciphertextHash !== ciphertextHash || reservation.byteSize !== objectBytes.byteLength
      || reservation.keyVersion !== writeKeyVersion) {
      throw Object.assign(new Error("服务端返回的对象 reservation 与上传内容不一致"), { code: "integrity_mismatch" });
    }
    return {
      content: {
        reservationId: reservation.reservationId,
        objectId: reservation.objectId,
        encryptionDomainId: reservation.encryptionDomainId,
        keyVersion: reservation.keyVersion,
        byteSize: reservation.byteSize,
        ciphertextHash: reservation.ciphertextHash,
      },
      plaintextHash, ciphertextHash, objectBytes,
      uploadUrl: reservation.uploadUrl, uploadExpiresAt: reservation.uploadExpiresAt, deduped: reservation.deduped,
    };
  }

  async function prepareObjectsBatch(
    plaintexts: Uint8Array[],
    transferOwnership: boolean,
    onPlaintextConsumed?: (index: number) => void,
  ): Promise<Array<
    | { status: "prepared"; upload: VaultSyncV2PreparedUpload }
    | { status: "failed"; code: string }
  >> {
    if (!Array.isArray(plaintexts) || plaintexts.length === 0 || plaintexts.length > 100) {
      throw Object.assign(new Error("对象批量准备数量必须在 1 到 100 项之间"), { code: "invalid_object_batch" });
    }
    if (!remote.prepareContentObjects) {
      throw Object.assign(new Error("服务端不支持对象批量准备"), { code: "batch_prepare_unavailable" });
    }
    const encoded: Array<{ plaintextHash: string; ciphertextHash: string; objectBytes: Uint8Array }> = [];
    for (let index = 0; index < plaintexts.length; index += 1) {
      const plaintext = plaintexts[index];
      const plaintextHash = await sha256Hex(plaintext);
      const objectBytes = activeKey
        ? await activeKey.encryptObject(plaintext, plaintextHash)
        : transferOwnership ? plaintext : plaintext.slice();
      const ciphertextHash = activeKey ? await sha256Hex(objectBytes) : plaintextHash;
      encoded.push({ plaintextHash, ciphertextHash, objectBytes });
      if (transferOwnership) {
        // The encoded entry now owns the bytes needed for upload. Drop this
        // batch slot before the next item and before the remote reservation
        // request; the push caller also releases its per-file reference.
        plaintexts[index] = new Uint8Array(0);
        try { onPlaintextConsumed?.(index); } catch { /* memory relief must not affect sync */ }
      }
    }
    const reservations = await remote.prepareContentObjects(encoded.map((entry) => ({
      ciphertextHash: entry.ciphertextHash,
      byteSize: entry.objectBytes.byteLength,
      keyVersion: writeKeyVersion,
    })));
    if (!Array.isArray(reservations) || reservations.length !== encoded.length) {
      throw Object.assign(new Error("对象批量准备响应数量无效"), { code: "invalid_object_batch_response" });
    }
    return reservations.map((reservation, index) => {
      const entry = encoded[index];
      if (reservation.index !== index) return { status: "failed" as const, code: "invalid_object_batch_response" };
      if (reservation.status === "failed") return { status: "failed" as const, code: reservation.code || "object_prepare_failed" };
      if (reservation.ciphertextHash !== entry.ciphertextHash
        || reservation.byteSize !== entry.objectBytes.byteLength || reservation.keyVersion !== writeKeyVersion
        || !reservation.objectId || !reservation.reservationId || !reservation.encryptionDomainId
        || typeof reservation.deduped !== "boolean"
        || (!reservation.deduped && typeof reservation.uploadUrl !== "string")) {
        return { status: "failed" as const, code: "integrity_mismatch" };
      }
      return { status: "prepared" as const, upload: {
        content: {
          reservationId: reservation.reservationId,
          objectId: reservation.objectId,
          encryptionDomainId: reservation.encryptionDomainId,
          keyVersion: reservation.keyVersion,
          byteSize: reservation.byteSize,
          ciphertextHash: reservation.ciphertextHash,
        },
        plaintextHash: entry.plaintextHash,
        ciphertextHash: entry.ciphertextHash,
        objectBytes: entry.objectBytes,
        uploadUrl: reservation.uploadUrl,
        uploadExpiresAt: reservation.uploadExpiresAt,
        deduped: reservation.deduped,
      } };
    });
  }

  return {
    async fingerprint(plaintext: Uint8Array): Promise<{ plaintextHash: string; ciphertextHash: string }> {
      const plaintextHash = await sha256Hex(plaintext);
      let ciphertextHash = plaintextHash;
      if (activeKey) {
        const objectBytes = await activeKey.encryptObject(plaintext, plaintextHash);
        ciphertextHash = await sha256Hex(objectBytes);
      }
      return { plaintextHash, ciphertextHash };
    },

    async prepare(plaintext: Uint8Array): Promise<VaultSyncV2PreparedUpload> {
      return prepareObject(plaintext, false);
    },

    /** Consumes a caller-owned fresh read buffer to avoid a second plaintext-sized allocation. */
    async prepareOwned(plaintext: Uint8Array): Promise<VaultSyncV2PreparedUpload> {
      return prepareObject(plaintext, true);
    },

    async prepareBatch(plaintexts: Uint8Array[]): Promise<Array<
      | { status: "prepared"; upload: VaultSyncV2PreparedUpload }
      | { status: "failed"; code: string }
    >> {
      return prepareObjectsBatch(plaintexts, false);
    },

    /** Consumes fresh caller-owned read buffers without making a second plaintext copy. */
    /** Consumes fresh read buffers one at a time; callback lets callers release aliases before reservation I/O. */
    async prepareBatchOwned(plaintexts: Uint8Array[], onPlaintextConsumed?: (index: number) => void): Promise<Array<
      | { status: "prepared"; upload: VaultSyncV2PreparedUpload }
      | { status: "failed"; code: string }
    >> {
      return prepareObjectsBatch(plaintexts, true, onPlaintextConsumed);
    },

    async cancelReservations(reservationIds: string[]): Promise<void> {
      if (!reservationIds.length || !remote.cancelContentObjectReservations) return;
      await remote.cancelContentObjectReservations(reservationIds);
    },

    async transfer(prepared: VaultSyncV2PreparedUpload): Promise<void> {
      assertCanContinue();
      const { content, objectBytes } = prepared;
      if (!prepared.deduped) {
        const finalize = async () => trackMultipartTransfer("finalize", async () => {
          assertCanContinue();
          const finalized = await remote.finalizeContentObject(content.reservationId);
          if (finalized.objectId !== content.objectId || finalized.encryptionDomainId !== content.encryptionDomainId
            || finalized.keyVersion !== content.keyVersion || finalized.byteSize !== content.byteSize
            || finalized.ciphertextHash !== content.ciphertextHash || !finalized.finalized) {
            throw Object.assign(new Error("对象落盘校验结果与 reservation 不一致"), { code: "integrity_mismatch" });
          }
        });
        if (objectBytes.byteLength >= VAULT_SYNC_MULTIPART_THRESHOLD_BYTES) {
          if (!remote.beginContentObjectMultipartUpload || !remote.getContentObjectMultipartPartUrl
            || !remote.completeContentObjectMultipartUpload) {
            reportMultipartTransfer("initialize", "failed");
            throw Object.assign(new Error("服务端不支持可恢复的分段上传"), { code: "multipart_upload_unavailable" });
          }
          const session = await trackMultipartTransfer("initialize", async () => {
            const value = await remote.beginContentObjectMultipartUpload!(content.reservationId);
            if (!value.deduped && (!Number.isSafeInteger(value.partSize) || (value.partSize as number) < 5 * 1024 * 1024
              || value.partCount !== Math.max(1, Math.ceil(objectBytes.byteLength / (value.partSize as number))))) {
              throw Object.assign(new Error("服务端分段策略与对象尺寸不匹配"), { code: "invalid_multipart_upload_response" });
            }
            return value;
          });
          assertCanContinue();
          if (session.deduped) {
            await finalize();
            return;
          }
          const partSize = session.partSize as number;
          const uploadedByNumber = new Map(session.uploadedParts.map((part) => [part.partNumber, part.byteSize]));
          for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
            assertCanContinue();
            const offset = (partNumber - 1) * partSize;
            const part = objectBytes.subarray(offset, Math.min(offset + partSize, objectBytes.byteLength));
            if (uploadedByNumber.get(partNumber) === part.byteLength) continue;
            const body = part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength) as ArrayBuffer;
            let response = { status: 0 } as VaultSyncV2ObjectRequestResult;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const signed = await trackMultipartTransfer("part_url",
                () => remote.getContentObjectMultipartPartUrl!(content.reservationId, partNumber));
              assertCanContinue();
              reportMultipartTransfer("part_upload", "started");
              try {
                response = await request({ url: signed.uploadUrl, method: "PUT", body, throw: false });
              } catch (error) {
                const status = Number((error as { status?: unknown } | null)?.status);
                reportMultipartTransfer("part_upload", "failed", Number.isSafeInteger(status) && status >= 100 && status <= 599
                  ? status : undefined);
                throw error;
              }
              reportMultipartTransfer("part_upload", response.status >= 200 && response.status < 300 ? "succeeded" : "failed",
                Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599
                  ? response.status : undefined);
              assertCanContinue();
              if (response.status !== 401 && response.status !== 403) break;
            }
            if (response.status < 200 || response.status >= 300) {
              throw storageError(`对象第 ${partNumber} 段上传暂未完成`, response, "object_upload_failed");
            }
          }
          assertCanContinue();
          await trackMultipartTransfer("complete", async () => {
            const completed = await remote.completeContentObjectMultipartUpload!(content.reservationId);
            if (!completed.completed) {
              throw Object.assign(new Error("对象分段尚未完成"), { code: "multipart_parts_incomplete" });
            }
          });
          assertCanContinue();
          await finalize();
          return;
        }
        if (!prepared.uploadUrl) throw Object.assign(new Error("对象上传没有获得临时地址"), { code: "hosted_storage_unavailable" });
        const makeBody = () => objectBytes.byteOffset === 0 && objectBytes.byteLength === objectBytes.buffer.byteLength
          ? objectBytes.buffer as ArrayBuffer
          : objectBytes.buffer.slice(objectBytes.byteOffset, objectBytes.byteOffset + objectBytes.byteLength) as ArrayBuffer;
        let uploadUrl = prepared.uploadUrl;
        let response = await request({ url: uploadUrl, method: "PUT", body: makeBody(), throw: false });
        assertCanContinue();
        if (response.status === 401 || response.status === 403) {
          assertCanContinue();
          const renewed = await remote.reserveContentObject({
            ciphertextHash: content.ciphertextHash,
            byteSize: content.byteSize,
            keyVersion: content.keyVersion,
          });
          if (renewed.reservationId !== content.reservationId || renewed.objectId !== content.objectId
            || renewed.encryptionDomainId !== content.encryptionDomainId || renewed.keyVersion !== content.keyVersion
            || renewed.byteSize !== content.byteSize || renewed.ciphertextHash !== content.ciphertextHash
            || renewed.deduped || !renewed.uploadUrl) {
            throw Object.assign(new Error("上传地址刷新时 reservation 身份已变化；同步待办已保留"), {
              code: "upload_reservation_invalid",
            });
          }
          uploadUrl = renewed.uploadUrl;
          response = await request({ url: uploadUrl, method: "PUT", body: makeBody(), throw: false });
          assertCanContinue();
        }
        if (response.status < 200 || response.status >= 300) {
          throw storageError("对象上传暂未完成", response, "object_upload_failed");
        }
        assertCanContinue();
        await finalize();
      }
    },

    async upload(plaintext: Uint8Array): Promise<{ content: VaultSyncV2ContentRef; plaintextHash: string }> {
      const prepared = await this.prepare(plaintext);
      await this.transfer(prepared);
      return {
        content: prepared.content,
        plaintextHash: prepared.plaintextHash,
      };
    },

    async download(content: VaultSyncV2ContentRef): Promise<{ plaintext: Uint8Array; plaintextHash: string }> {
      const lease = await remote.getContentObject(content.objectId);
      return downloadWithLease(content, lease, () => remote.getContentObject(content.objectId));
    },

    /**
     * Marker-3 reads authenticate the full ciphertext before streaming plaintext to a private temporary sink.
     * A sink may contain partial plaintext if authentication fails mid-object; callers must only expose/commit it
     * after this method resolves successfully and its returned size/hash have been checked.
     */
    async downloadChunkedToSink(
      content: Omit<VaultSyncV2ContentRef, "reservationId">,
      expectedPlaintextBytes: number | undefined,
      writePlaintextChunk: (bytes: Uint8Array) => Promise<void> | void,
    ) {
      return downloadChunkedToSink(content, expectedPlaintextBytes, writePlaintextChunk);
    },

    async downloadVersion(input: {
      fileId: string;
      versionId: string;
      expectedObjectId?: string;
    }): Promise<{ plaintext: Uint8Array; plaintextHash: string }> {
      if (!remote.getFileVersionContent) {
        throw Object.assign(new Error("服务端尚不支持历史版本专属下载"), { code: "history_download_unavailable" });
      }
      const lease = await remote.getFileVersionContent(input.fileId, input.versionId);
      if (input.expectedObjectId && lease.objectId !== input.expectedObjectId) {
        throw Object.assign(new Error("历史版本 lease 与所选检查点不一致"), { code: "integrity_mismatch" });
      }
      const content = {
        objectId: lease.objectId, encryptionDomainId: lease.encryptionDomainId,
        keyVersion: lease.keyVersion, byteSize: lease.byteSize, ciphertextHash: lease.ciphertextHash,
      };
      return downloadWithLease(content, lease, () => remote.getFileVersionContent!(input.fileId, input.versionId));
    },
  };
}
