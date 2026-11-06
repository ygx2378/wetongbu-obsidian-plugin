// Durable, ciphertext-only staging for experimental marker-3 uploads.
// Plaintext never enters this store. Incomplete stages are discarded and
// encoded again; completed stages can be reused after a transport restart.
import type { App, DataAdapter } from "obsidian";
import { sha256Hex } from "./shared/hash.ts";
import { Sha256Accumulator } from "./shared/sha256-stream.ts";
import { vaultSyncChunkedCiphertextByteSize } from "./shared/vault-sync-chunked-crypto.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";
import { VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES } from "./vault-sync-history.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SALT = /^[a-f0-9]{32}$/i;
const MAX_CHUNK_BYTES = 1024 * 1024 + 16;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const VAULT_SYNC_UPLOAD_STAGE_MAX_BYTES = 96 * 1024 * 1024;

export interface VaultSyncV2UploadStageRequest {
  plaintextHash: string;
  plaintextBytes: number;
  keyVersion: number;
  keySaltHex: string;
}

export interface VaultSyncV2UploadStageObject {
  ciphertextHash: string;
  ciphertextBytes: number;
  readRange(offset: number, length: number): Promise<Uint8Array>;
  clear(): Promise<void>;
}

export interface VaultSyncV2UploadStageStore {
  prepare(
    request: VaultSyncV2UploadStageRequest,
    encrypt: (writeCiphertextChunk: (bytes: Uint8Array) => Promise<void>) => Promise<{
      plaintextHash: string;
      plaintextBytes: number;
      ciphertextBytes: number;
    }>,
  ): Promise<VaultSyncV2UploadStageObject>;
}

interface PartRef { partNumber: number; byteSize: number; sha256: string }
interface StageState {
  version: 1;
  identity: VaultSyncV2Identity;
  plaintextHash: string;
  plaintextBytes: number;
  keyVersion: number;
  keySaltHex: string;
  ciphertextBytes: number;
  ciphertextHash: string | null;
  status: "writing" | "ready";
  updatedAt: number;
  parts: PartRef[];
  digest: string;
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
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeIdentity(input: VaultSyncV2Identity): VaultSyncV2Identity {
  let apiBaseUrl: string;
  try {
    const url = new URL(input.apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    url.search = "";
    url.hash = "";
    apiBaseUrl = url.toString().replace(/\/+$/, "");
  } catch { throw fail("upload_stage_identity_invalid", "同步服务地址无效"); }
  if (!UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) {
    throw fail("upload_stage_identity_invalid", "同步 target、设备或协议版本无效");
  }
  return { apiBaseUrl, targetId: input.targetId.toLowerCase(), deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch };
}

function validateRequest(request: VaultSyncV2UploadStageRequest): number {
  if (!SHA256.test(request.plaintextHash) || !Number.isSafeInteger(request.plaintextBytes)
    || request.plaintextBytes < 0 || request.plaintextBytes > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES
    || !Number.isSafeInteger(request.keyVersion) || request.keyVersion < 1 || !SALT.test(request.keySaltHex)) {
    throw fail("upload_stage_request_invalid", "加密上传暂存参数无效");
  }
  return vaultSyncChunkedCiphertextByteSize(request.plaintextBytes);
}

function validState(value: unknown): value is StageState {
  if (!exactKeys(value, ["version", "identity", "plaintextHash", "plaintextBytes", "keyVersion", "keySaltHex",
    "ciphertextBytes", "ciphertextHash", "status", "updatedAt", "parts", "digest"])) return false;
  return value.version === 1 && isRecord(value.identity)
    && typeof value.identity.apiBaseUrl === "string" && typeof value.identity.targetId === "string" && UUID.test(value.identity.targetId)
    && typeof value.identity.deviceId === "string" && UUID.test(value.identity.deviceId)
    && Number.isSafeInteger(value.identity.protocolEpoch) && Number(value.identity.protocolEpoch) > 0
    && typeof value.plaintextHash === "string" && SHA256.test(value.plaintextHash)
    && Number.isSafeInteger(value.plaintextBytes) && Number(value.plaintextBytes) >= 0
    && Number.isSafeInteger(value.keyVersion) && Number(value.keyVersion) >= 1
    && typeof value.keySaltHex === "string" && SALT.test(value.keySaltHex)
    && Number.isSafeInteger(value.ciphertextBytes) && Number(value.ciphertextBytes) > 0
    && (value.ciphertextHash === null || (typeof value.ciphertextHash === "string" && SHA256.test(value.ciphertextHash)))
    && (value.status === "writing" || value.status === "ready")
    && Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0
    && Array.isArray(value.parts) && value.parts.length <= 26 && value.parts.every((part) => exactKeys(part, ["partNumber", "byteSize", "sha256"])
      && Number.isSafeInteger(part.partNumber) && Number(part.partNumber) >= 0
      && Number.isSafeInteger(part.byteSize) && Number(part.byteSize) > 0 && Number(part.byteSize) <= MAX_CHUNK_BYTES
      && typeof part.sha256 === "string" && SHA256.test(part.sha256))
    && new Set((value.parts as PartRef[]).map((part) => part.partNumber)).size === value.parts.length
    && typeof value.digest === "string" && SHA256.test(value.digest);
}

export function createVaultSyncV2UploadStageStore(
  app: App,
  rawIdentity: VaultSyncV2Identity,
  options: { now?: () => number; maxStagedBytes?: number } = {},
): VaultSyncV2UploadStageStore {
  const identity = normalizeIdentity(rawIdentity);
  const adapter: DataAdapter = app.vault.adapter;
  const now = options.now ?? Date.now;
  const maxStagedBytes = options.maxStagedBytes ?? VAULT_SYNC_UPLOAD_STAGE_MAX_BYTES;
  const largestObjectBytes = vaultSyncChunkedCiphertextByteSize(VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES);
  if (!Number.isSafeInteger(maxStagedBytes) || maxStagedBytes < largestObjectBytes) {
    throw fail("upload_stage_budget_invalid", "加密上传暂存预算必须至少容纳一个完整对象");
  }
  let serial: Promise<unknown> = Promise.resolve();

  function withSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = serial.then(task, task);
    serial = result.then(() => undefined, () => undefined);
    return result;
  }
  function apiHostKey(): string { return new URL(identity.apiBaseUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_"); }
  function key(request: VaultSyncV2UploadStageRequest): string {
    return `${apiHostKey()}-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-k${request.keyVersion}-${request.keySaltHex.toLowerCase()}-${request.plaintextHash.toLowerCase()}`;
  }
  function prefix(request: VaultSyncV2UploadStageRequest): string { return `${DIR}/object-upload-${key(request)}-`; }
  function statePath(request: VaultSyncV2UploadStageRequest): string { return `${prefix(request)}state.json`; }
  function partPath(request: VaultSyncV2UploadStageRequest, partNumber: number): string {
    return `${prefix(request)}${String(partNumber).padStart(3, "0")}.bin`;
  }
  async function digest(value: unknown): Promise<string> { return sha256Hex(new TextEncoder().encode(stableJson(value))); }
  async function listFiles(): Promise<string[]> {
    if (!(await adapter.exists(DIR).catch(() => false))) return [];
    return (await adapter.list(DIR)).files;
  }
  async function removePrefix(pathPrefix: string): Promise<void> {
    for (const path of await listFiles()) if (path.startsWith(pathPrefix)) await adapter.remove(path).catch(() => {});
  }
  async function ensureDirectory(): Promise<void> {
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
  }
  async function persist(request: VaultSyncV2UploadStageRequest, state: Omit<StageState, "digest">): Promise<StageState> {
    const { digest: _previousDigest, ...body } = state as StageState;
    const saved = { ...body, digest: await digest(body) } as StageState;
    const path = statePath(request);
    const serialized = stableJson(saved) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("upload_stage_checkpoint_unverified", "上传暂存 checkpoint 回读失败");
    return saved;
  }
  async function readState(request: VaultSyncV2UploadStageRequest): Promise<StageState | null> {
    let parsed: unknown;
    try { parsed = JSON.parse(await adapter.read(statePath(request))); } catch { return null; }
    if (!validState(parsed) || stableJson(parsed.identity) !== stableJson(identity)
      || parsed.plaintextHash !== request.plaintextHash.toLowerCase() || parsed.plaintextBytes !== request.plaintextBytes
      || parsed.keyVersion !== request.keyVersion || parsed.keySaltHex.toLowerCase() !== request.keySaltHex.toLowerCase()
      || parsed.ciphertextBytes !== validateRequest(request) || now() - parsed.updatedAt > MAX_AGE_MS) return null;
    const { digest: savedDigest, ...body } = parsed;
    if (await digest(body) !== savedDigest) return null;
    const total = parsed.parts.reduce((sum, part) => sum + part.byteSize, 0);
    if (total > parsed.ciphertextBytes || (parsed.status === "ready"
      && (total !== parsed.ciphertextBytes || parsed.ciphertextHash === null))) return null;
    for (let index = 0; index < parsed.parts.length; index += 1) {
      if (parsed.parts[index].partNumber !== index) return null;
    }
    return parsed;
  }
  async function readVerifiedPart(request: VaultSyncV2UploadStageRequest, part: PartRef): Promise<Uint8Array> {
    const path = partPath(request, part.partNumber);
    const stat = typeof adapter.stat === "function" ? await adapter.stat(path).catch(() => null) : null;
    if (stat?.type === "folder" || (stat && stat.size !== part.byteSize)) {
      throw fail("upload_stage_part_corrupt", "加密上传暂存分段尺寸校验失败");
    }
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await adapter.readBinary(path)); }
    catch { throw fail("upload_stage_part_corrupt", "加密上传暂存分段缺失"); }
    if (bytes.byteLength !== part.byteSize || await sha256Hex(bytes) !== part.sha256) {
      throw fail("upload_stage_part_corrupt", "加密上传暂存分段摘要校验失败");
    }
    return bytes;
  }
  async function verifyWholeStage(request: VaultSyncV2UploadStageRequest, state: StageState): Promise<boolean> {
    const hasher = new Sha256Accumulator();
    try {
      for (const part of state.parts) hasher.update(await readVerifiedPart(request, part));
    } catch { return false; }
    return hasher.digestHex() === state.ciphertextHash;
  }
  async function makeObject(request: VaultSyncV2UploadStageRequest, state: StageState): Promise<VaultSyncV2UploadStageObject> {
    const clear = () => withSerial(() => removePrefix(prefix(request)));
    return {
      ciphertextHash: state.ciphertextHash!,
      ciphertextBytes: state.ciphertextBytes,
      clear,
      readRange(offset, length) {
        return withSerial(async () => {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1
            || offset + length > state.ciphertextBytes) throw fail("upload_stage_range_invalid", "上传暂存读取范围无效");
          const current = await readState(request);
          if (!current || current.status !== "ready" || current.ciphertextHash !== state.ciphertextHash
            || current.ciphertextBytes !== state.ciphertextBytes) throw fail("upload_stage_state_missing", "上传暂存状态已失效");
          const output = new Uint8Array(length);
          const end = offset + length;
          let written = 0;
          let partStart = 0;
          for (const part of current.parts) {
            const partEnd = partStart + part.byteSize;
            const overlapStart = Math.max(offset, partStart);
            const overlapEnd = Math.min(end, partEnd);
            if (overlapEnd > overlapStart) {
              const bytes = await readVerifiedPart(request, part);
              const sourceStart = overlapStart - partStart;
              const count = overlapEnd - overlapStart;
              output.set(bytes.subarray(sourceStart, sourceStart + count), overlapStart - offset);
              written += count;
            }
            partStart = partEnd;
          }
          if (written !== length) throw fail("upload_stage_range_incomplete", "上传暂存读取未覆盖完整分段");
          return output;
        });
      },
    };
  }
  async function pruneAndReserve(request: VaultSyncV2UploadStageRequest, additionalBytes: number): Promise<void> {
    const files = await listFiles();
    const states: Array<{ prefix: string; path: string; updatedAt: number; bytes: number }> = [];
    const referenced = new Set<string>();
    for (const path of files.filter((entry) => entry.startsWith(`${DIR}/object-upload-`) && entry.endsWith("state.json"))) {
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(path)); } catch { await adapter.remove(path).catch(() => {}); continue; }
      if (!validState(parsed)) { await adapter.remove(path).catch(() => {}); continue; }
      const { digest: savedDigest, ...body } = parsed;
      if (await digest(body) !== savedDigest || now() - Number(parsed.updatedAt) > MAX_AGE_MS) {
        const oldPrefix = path.slice(0, -"state.json".length);
        await removePrefix(oldPrefix);
        continue;
      }
      const oldPrefix = path.slice(0, -"state.json".length);
      for (const part of parsed.parts as PartRef[]) referenced.add(`${oldPrefix}${String(part.partNumber).padStart(3, "0")}.bin`);
      states.push({ prefix: oldPrefix, path, updatedAt: Number(parsed.updatedAt),
        bytes: (parsed.parts as PartRef[]).reduce((sum, part) => sum + part.byteSize, 0) });
    }
    for (const path of files) {
      if (path.startsWith(`${DIR}/object-upload-`) && path.endsWith(".bin") && !referenced.has(path)) await adapter.remove(path).catch(() => {});
    }
    const currentPrefix = prefix(request);
    const current = states.find((entry) => entry.prefix === currentPrefix);
    let total = states.reduce((sum, entry) => sum + entry.bytes, 0);
    const currentBytes = current?.bytes ?? 0;
    const candidates = states.filter((entry) => entry.prefix !== currentPrefix).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const candidate of candidates) {
      if (total + additionalBytes <= maxStagedBytes) break;
      await removePrefix(candidate.prefix);
      total -= candidate.bytes;
    }
    if (currentBytes + additionalBytes > maxStagedBytes || total + additionalBytes > maxStagedBytes) {
      throw fail("upload_stage_capacity", "本地加密上传暂存预算不足");
    }
  }

  return {
    prepare(request, encrypt) {
      const expectedCiphertextBytes = validateRequest(request);
      return withSerial(async () => {
        let state = await readState(request);
        if (state?.status === "ready" && await verifyWholeStage(request, state)) return makeObject(request, state);
        await removePrefix(prefix(request));
        await pruneAndReserve(request, expectedCiphertextBytes);
        await ensureDirectory();
        state = await persist(request, {
          version: 1, identity, plaintextHash: request.plaintextHash.toLowerCase(), plaintextBytes: request.plaintextBytes,
          keyVersion: request.keyVersion, keySaltHex: request.keySaltHex.toLowerCase(), ciphertextBytes: expectedCiphertextBytes,
          ciphertextHash: null, status: "writing", updatedAt: now(), parts: [],
        });
        const cipherHasher = new Sha256Accumulator();
        let cipherBytes = 0;
        const writeCiphertextChunk = async (bytes: Uint8Array) => {
          if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_CHUNK_BYTES
            || cipherBytes + bytes.byteLength > expectedCiphertextBytes) {
            throw fail("upload_stage_chunk_invalid", "加密上传暂存分段无效");
          }
          const partNumber = state!.parts.length;
          const path = partPath(request, partNumber);
          const partHash = await sha256Hex(bytes);
          await adapter.writeBinary(path, exactBuffer(bytes));
          const stat = typeof adapter.stat === "function" ? await adapter.stat(path).catch(() => null) : null;
          if (stat?.type === "folder" || (stat && stat.size !== bytes.byteLength)) {
            throw fail("upload_stage_write_unverified", "加密上传暂存落盘尺寸校验失败");
          }
          const verified = await readVerifiedPart(request, { partNumber, byteSize: bytes.byteLength, sha256: partHash });
          cipherHasher.update(verified);
          cipherBytes += verified.byteLength;
          const parts = [...state!.parts, { partNumber, byteSize: verified.byteLength, sha256: partHash }];
          state = await persist(request, { ...state!, parts, updatedAt: now() });
        };
        try {
          const result = await encrypt(writeCiphertextChunk);
          if (result.plaintextHash !== request.plaintextHash.toLowerCase() || result.plaintextBytes !== request.plaintextBytes
            || result.ciphertextBytes !== expectedCiphertextBytes || cipherBytes !== expectedCiphertextBytes) {
            throw fail("upload_stage_integrity_mismatch", "加密上传暂存完整性校验失败");
          }
          state = await persist(request, { ...state!, status: "ready", ciphertextHash: cipherHasher.digestHex(), updatedAt: now() });
          if (!await verifyWholeStage(request, state)) throw fail("upload_stage_integrity_mismatch", "加密上传暂存回读校验失败");
          return makeObject(request, state);
        } catch (error) {
          await removePrefix(prefix(request)).catch(() => {});
          throw error;
        }
      });
    },
  };
}
