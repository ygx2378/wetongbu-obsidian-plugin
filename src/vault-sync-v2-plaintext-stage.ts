import type { App, DataAdapter } from "obsidian";
import { sha256Hex } from "./shared/hash.ts";
import { Sha256Accumulator } from "./shared/sha256-stream.ts";
import { VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES } from "./vault-sync-history.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const STAGE_SUFFIX = /^([0-9a-f-]{36})-([a-f0-9]{64})-(\d+)-([a-f0-9]{16})\.tmp$/i;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const activePlaintextStages = new Set<string>();

export interface VaultSyncV2PlaintextStageRequest {
  objectId: string;
  ciphertextHash: string;
  /** Exact length when known; otherwise maxPlaintextBytes bounds authenticated streaming. */
  plaintextBytes?: number;
  maxPlaintextBytes?: number;
}

export interface VaultSyncV2PlaintextStageWriter {
  path: string;
  writeChunk(bytes: Uint8Array): Promise<void>;
  finish(expectedPlaintextHash?: string, expectedPlaintextBytes?: number): Promise<{ path: string; byteSize: number; plaintextHash: string }>;
  clear(): Promise<void>;
}

export interface VaultSyncV2ChunkedDownloadResult {
  plaintextBytes: number;
  plaintextHash: string;
}

export interface VaultSyncV2VerifiedPlaintextStage {
  path: string;
  objectId: string;
  ciphertextHash: string;
  byteSize: number;
  plaintextHash: string;
  clear(): Promise<void>;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function apiHostKey(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
}

export async function createVaultSyncV2PlaintextStageWriter(
  app: App,
  rawIdentity: VaultSyncV2Identity,
  request: VaultSyncV2PlaintextStageRequest,
  options: { now?: () => number; maxAgeMs?: number; memoryFallbackMaxBytes?: number } = {},
): Promise<VaultSyncV2PlaintextStageWriter> {
  const adapter = app.vault.adapter as DataAdapter & { appendBinary?: (path: string, data: ArrayBuffer) => Promise<void> };
  const maxPlaintextBytes = request.maxPlaintextBytes ?? request.plaintextBytes;
  let apiBaseUrl: string;
  try {
    const api = new URL(rawIdentity.apiBaseUrl);
    if (api.protocol !== "https:" && api.protocol !== "http:") throw new Error("scheme");
    api.search = "";
    api.hash = "";
    apiBaseUrl = api.toString().replace(/\/+$/, "");
  } catch {
    throw fail("plaintext_stage_identity_invalid", "同步服务地址无效");
  }
  if (!UUID.test(rawIdentity.targetId) || !UUID.test(rawIdentity.deviceId)
    || !Number.isSafeInteger(rawIdentity.protocolEpoch) || rawIdentity.protocolEpoch < 1
    || !UUID.test(request.objectId) || !SHA256.test(request.ciphertextHash)
    || (request.plaintextBytes !== undefined && (!Number.isSafeInteger(request.plaintextBytes)
      || request.plaintextBytes < 0 || request.plaintextBytes > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES))
    || !Number.isSafeInteger(maxPlaintextBytes) || (maxPlaintextBytes as number) < 0
    || (maxPlaintextBytes as number) > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES
    || (request.plaintextBytes !== undefined && request.plaintextBytes > (maxPlaintextBytes as number))) {
    throw fail("plaintext_stage_request_invalid", "分块明文暂存参数无效");
  }
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const memoryFallbackMaxBytes = options.memoryFallbackMaxBytes ?? VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1
    || !Number.isSafeInteger(memoryFallbackMaxBytes) || memoryFallbackMaxBytes < 0) {
    throw fail("plaintext_stage_options_invalid", "分块明文暂存预算无效");
  }
  if (typeof adapter.appendBinary !== "function" && (maxPlaintextBytes as number) > memoryFallbackMaxBytes) {
    throw fail("plaintext_stage_append_unsupported", "当前 Obsidian 适配器不支持分块明文落盘，文件保持不变");
  }

  const identityStagePrefix = `${DIR}/plaintext-download-${apiHostKey(apiBaseUrl)}-${rawIdentity.targetId.toLowerCase()}-${rawIdentity.deviceId.toLowerCase()}-e${rawIdentity.protocolEpoch}-`;
  const applyMarkerPrefix = `${DIR}/staged-apply-${apiHostKey(apiBaseUrl)}-${rawIdentity.targetId.toLowerCase()}-${rawIdentity.deviceId.toLowerCase()}-e${rawIdentity.protocolEpoch}-`;
  const stagePathForSuffix = (suffix: string) => `${identityStagePrefix}${suffix}`;
  const scopePrefix = `${identityStagePrefix}${request.objectId.toLowerCase()}-${request.ciphertextHash.toLowerCase()}-`;
  const randomSuffix = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
  const path = `${scopePrefix}${now()}-${randomSuffix}.tmp`;
  const hasher = new Sha256Accumulator();
  const bufferedChunks: Uint8Array[] = [];
  let writtenBytes = 0;
  let fileStarted = false;
  let finalized = false;
  let failed = false;

  async function removeStage(): Promise<void> {
    activePlaintextStages.delete(path);
    try { await adapter.remove(path); } catch { /* retry cleanup is safe */ }
  }

  async function ensureDirectory(): Promise<void> {
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
  }

  async function pruneStaleStages(): Promise<void> {
    const listing = await adapter.list(DIR).catch(() => null);
    if (!listing) return;
    const referencedStages = new Set<string>();
    for (const markerPath of listing.files) {
      if (!markerPath.startsWith(applyMarkerPrefix) || !markerPath.endsWith(".json")) continue;
      let marker: unknown;
      try {
        marker = JSON.parse(await adapter.read(markerPath));
      } catch {
        // A damaged or temporarily unreadable recovery marker must not cause
        // its plaintext stage to be pruned. Defer cleanup until it is readable.
        return;
      }
      if (typeof marker !== "object" || marker === null || !("stagePath" in marker)
        || typeof (marker as { stagePath?: unknown }).stagePath !== "string") return;
      const stagePath = (marker as { stagePath: string }).stagePath;
      if (!stagePath.startsWith(identityStagePrefix)) return;
      const suffix = stagePath.slice(identityStagePrefix.length);
      const referencedName = STAGE_SUFFIX.exec(suffix);
      if (!referencedName || !UUID.test(referencedName[1]) || stagePathForSuffix(suffix) !== stagePath) return;
      referencedStages.add(stagePath);
    }

    for (const candidate of listing.files) {
      if (!candidate.startsWith(identityStagePrefix) || !candidate.endsWith(".tmp")
        || referencedStages.has(candidate) || activePlaintextStages.has(candidate)) continue;
      const suffix = candidate.slice(identityStagePrefix.length);
      const match = STAGE_SUFFIX.exec(suffix);
      if (!match || !UUID.test(match[1])) continue;
      const timestamp = Number(match[3]);
      const observedAt = now();
      if (!Number.isSafeInteger(timestamp) || observedAt - timestamp <= maxAgeMs) continue;
      // Another Obsidian window has its own in-memory active-stage set. A stage
      // whose filename is old can still be receiving chunks in that renderer.
      // Require the adapter's actual modification time to be stale too; if the
      // filesystem cannot prove that, preserve the stage and retry cleanup later.
      const stat = await adapter.stat(candidate).catch(() => null);
      const modifiedAt = stat?.mtime;
      if (!Number.isSafeInteger(modifiedAt) || (modifiedAt as number) < 0
        || observedAt - Math.max(timestamp, modifiedAt as number) <= maxAgeMs) continue;
      await adapter.remove(candidate).catch(() => {});
    }
  }

  activePlaintextStages.add(path);
  return (async () => {
    try {
      await ensureDirectory();
      await pruneStaleStages();
    } catch (error) {
      activePlaintextStages.delete(path);
      throw error;
    }

    return {
      path,
      async writeChunk(bytes) {
        if (finalized || failed) throw fail("plaintext_stage_closed", "明文暂存已经关闭");
        if (!(bytes instanceof Uint8Array) || writtenBytes + bytes.byteLength > (maxPlaintextBytes as number)) {
          failed = true;
          await removeStage();
          throw fail("plaintext_stage_size_invalid", "明文暂存超过安全尺寸上限");
        }
        try {
          if (typeof adapter.appendBinary === "function") {
            if (!fileStarted) {
              await adapter.writeBinary(path, exactBuffer(bytes));
              fileStarted = true;
            } else if (bytes.byteLength > 0) {
              await adapter.appendBinary(path, exactBuffer(bytes));
            }
          } else {
            if (writtenBytes + bytes.byteLength > memoryFallbackMaxBytes) {
              throw fail("plaintext_stage_append_unsupported", "当前 Obsidian 适配器不支持分块明文落盘");
            }
            bufferedChunks.push(bytes.slice());
          }
          hasher.update(bytes);
          writtenBytes += bytes.byteLength;
        } catch (error) {
          failed = true;
          await removeStage();
          throw error;
        }
      },
      async finish(expectedPlaintextHash, expectedPlaintextBytes) {
        if (finalized || failed) throw fail("plaintext_stage_closed", "明文暂存已经关闭");
        const finalByteSize = expectedPlaintextBytes ?? request.plaintextBytes;
        if (!Number.isSafeInteger(finalByteSize) || (finalByteSize as number) < 0
          || (finalByteSize as number) > (maxPlaintextBytes as number) || writtenBytes !== finalByteSize
          || (request.plaintextBytes !== undefined && finalByteSize !== request.plaintextBytes)) {
          failed = true;
          await removeStage();
          throw fail("plaintext_stage_size_invalid", "明文暂存尺寸与已认证结果不一致");
        }
        const plaintextHash = hasher.digestHex();
        if (expectedPlaintextHash !== undefined
          && (!SHA256.test(expectedPlaintextHash) || plaintextHash !== expectedPlaintextHash.toLowerCase())) {
          failed = true;
          await removeStage();
          throw fail("integrity_mismatch", "明文暂存摘要与预期不一致");
        }
        try {
          if (typeof adapter.appendBinary !== "function") {
            const body = new Uint8Array(finalByteSize as number);
            let offset = 0;
            for (const chunk of bufferedChunks) {
              body.set(chunk, offset);
              offset += chunk.byteLength;
            }
            await adapter.writeBinary(path, exactBuffer(body));
          } else if (!fileStarted) {
            await adapter.writeBinary(path, new ArrayBuffer(0));
            fileStarted = true;
          }
          const stat = await adapter.stat(path);
          if (stat && stat.size !== finalByteSize) {
            throw fail("plaintext_stage_write_unverified", "明文暂存落盘尺寸校验失败");
          }
          finalized = true;
          return { path, byteSize: finalByteSize as number, plaintextHash };
        } catch (error) {
          failed = true;
          await removeStage();
          throw error;
        }
      },
      async clear() {
        finalized = true;
        bufferedChunks.length = 0;
        await removeStage();
      },
    };
  })();
}

/**
 * Authenticates a chunked download into a private stage, then reads the verified
 * bytes for the existing apply engine. Returns null only for a legacy envelope
 * detected before the decryptor emitted plaintext, allowing a safe old-reader fallback.
 */
async function receiveVaultSyncV2VerifiedStage(
  app: App,
  identity: VaultSyncV2Identity,
  request: VaultSyncV2PlaintextStageRequest,
  download: (writePlaintextChunk: (bytes: Uint8Array) => Promise<void>) => Promise<VaultSyncV2ChunkedDownloadResult>,
  readBackBytes: boolean,
): Promise<{ stage: VaultSyncV2PlaintextStageWriter; byteSize: number; plaintextHash: string; bytes: Uint8Array | null } | null> {
  const stage = await createVaultSyncV2PlaintextStageWriter(app, identity, request);
  let emittedBytes = 0;
  try {
    const result = await download(async (bytes) => {
      await stage.writeChunk(bytes);
      emittedBytes += bytes.byteLength;
    });
    if ((request.plaintextBytes !== undefined && result.plaintextBytes !== request.plaintextBytes)
      || result.plaintextBytes !== emittedBytes) {
      throw fail("integrity_mismatch", "分块下载明文尺寸与文件版本记录不一致");
    }
    const finalized = await stage.finish(result.plaintextHash, result.plaintextBytes);
    let bytes: Uint8Array | null = null;
    if (readBackBytes) {
      const adapter = app.vault.adapter as DataAdapter;
      const stat = typeof adapter.stat === "function" ? await adapter.stat(finalized.path).catch(() => null) : null;
      if (stat?.type === "folder" || (stat && stat.size !== finalized.byteSize)
        || finalized.byteSize > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES) {
        throw fail("integrity_mismatch", "明文暂存尺寸与下载记录不一致");
      }
      bytes = new Uint8Array(await adapter.readBinary(finalized.path));
      if (bytes.byteLength !== finalized.byteSize || bytes.byteLength > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES
        || await sha256Hex(bytes) !== finalized.plaintextHash) {
        throw fail("integrity_mismatch", "明文暂存回读摘要或尺寸校验失败");
      }
    }
    return { stage, byteSize: finalized.byteSize, plaintextHash: finalized.plaintextHash, bytes };
  } catch (error) {
    if ((error as any)?.code === "chunked_format_unsupported" && emittedBytes === 0) {
      await stage.clear().catch(() => {});
      return null;
    }
    await stage.clear().catch(() => {});
    throw error;
  }
}

/**
 * Authenticates a chunked download, writes it to a private stage and verifies
 * the adapter readback before returning the stage for safe path promotion.
 * The caller owns cleanup after this function resolves successfully.
 */
export async function downloadVaultSyncV2ToVerifiedStage(
  app: App,
  identity: VaultSyncV2Identity,
  request: VaultSyncV2PlaintextStageRequest,
  download: (writePlaintextChunk: (bytes: Uint8Array) => Promise<void>) => Promise<VaultSyncV2ChunkedDownloadResult>,
): Promise<VaultSyncV2VerifiedPlaintextStage | null> {
  const received = await receiveVaultSyncV2VerifiedStage(app, identity, request, download, false);
  if (!received) return null;
  return {
    path: received.stage.path,
    objectId: request.objectId,
    ciphertextHash: request.ciphertextHash.toLowerCase(),
    byteSize: received.byteSize,
    plaintextHash: received.plaintextHash,
    clear: () => received.stage.clear(),
  };
}

/**
 * Compatibility wrapper for consumers that still need the bounded in-memory
 * apply boundary. New-file promotion can use the verified stage directly.
 */
export async function downloadVaultSyncV2ToVerifiedBytes(
  app: App,
  identity: VaultSyncV2Identity,
  request: VaultSyncV2PlaintextStageRequest,
  download: (writePlaintextChunk: (bytes: Uint8Array) => Promise<void>) => Promise<VaultSyncV2ChunkedDownloadResult>,
): Promise<{ bytes: Uint8Array; plaintextHash: string } | null> {
  const received = await receiveVaultSyncV2VerifiedStage(app, identity, request, download, true);
  if (!received) return null;
  try {
    if (!received.bytes) throw fail("integrity_mismatch", "明文暂存没有返回经过回读校验的内容");
    return { bytes: received.bytes, plaintextHash: received.plaintextHash };
  } finally {
    await received.stage.clear().catch(() => {});
  }
}
