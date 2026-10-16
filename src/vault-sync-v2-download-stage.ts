// Durable, ciphertext-only range staging. A part is checkpointed only after
// its exact size and local digest have been read back from the Vault adapter.
import type { App, DataAdapter } from "obsidian";
import { sha256Hex } from "./shared/hash.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^\d{20}$/;
const GENERATION_VALUE = /^(0|[1-9][0-9]*)$/;
export const VAULT_SYNC_DOWNLOAD_STAGE_MAX_BYTES = 96 * 1024 * 1024;
const MAX_STAGED_BYTES = VAULT_SYNC_DOWNLOAD_STAGE_MAX_BYTES;
const MAX_STAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface VaultSyncV2DownloadStageRequest {
  objectId: string;
  ciphertextHash: string;
  byteSize: number;
  partSize: number;
}

export interface VaultSyncV2DownloadStageStore {
  readPart(request: VaultSyncV2DownloadStageRequest, partNumber: number): Promise<Uint8Array | null>;
  writePart(request: VaultSyncV2DownloadStageRequest, partNumber: number, bytes: Uint8Array): Promise<void>;
  clear(request: VaultSyncV2DownloadStageRequest): Promise<void>;
}

interface PartRef {
  partNumber: number;
  byteSize: number;
  sha256: string;
}

interface StageState {
  version: 1;
  generation: string;
  identity: VaultSyncV2Identity;
  objectId: string;
  ciphertextHash: string;
  byteSize: number;
  partSize: number;
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

function normalizedIdentity(input: VaultSyncV2Identity): VaultSyncV2Identity {
  let apiBaseUrl: string;
  try {
    const url = new URL(input.apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    url.search = "";
    url.hash = "";
    apiBaseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw fail("download_stage_identity_invalid", "同步服务地址无效");
  }
  if (!UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) {
    throw fail("download_stage_identity_invalid", "同步 target、设备或协议版本无效");
  }
  return { apiBaseUrl, targetId: input.targetId.toLowerCase(), deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch };
}

function expectedPartBytes(request: VaultSyncV2DownloadStageRequest, partNumber: number): number {
  const count = Math.ceil(request.byteSize / request.partSize);
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) return -1;
  return Math.min(request.partSize, request.byteSize - (partNumber - 1) * request.partSize);
}

function validateRequest(request: VaultSyncV2DownloadStageRequest): void {
  if (!UUID.test(request.objectId) || !SHA256.test(request.ciphertextHash)
    || !Number.isSafeInteger(request.byteSize) || request.byteSize <= 0
    || !Number.isSafeInteger(request.partSize) || request.partSize < 5 * 1024 * 1024
    || Math.ceil(request.byteSize / request.partSize) > 10_000) {
    throw fail("download_stage_request_invalid", "同步对象分段暂存参数无效");
  }
}

function validPart(value: unknown, request: VaultSyncV2DownloadStageRequest): value is PartRef {
  if (!exactKeys(value, ["partNumber", "byteSize", "sha256"])) return false;
  const partNumber = Number(value.partNumber);
  return Number.isSafeInteger(partNumber) && expectedPartBytes(request, partNumber) === value.byteSize
    && typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

function validState(value: unknown): value is StageState {
  return exactKeys(value, ["version", "generation", "identity", "objectId", "ciphertextHash", "byteSize", "partSize", "updatedAt", "parts", "digest"])
    && value.version === 1 && typeof value.generation === "string" && GENERATION_VALUE.test(value.generation)
    && isRecord(value.identity) && typeof value.identity.apiBaseUrl === "string"
    && typeof value.identity.targetId === "string" && UUID.test(value.identity.targetId)
    && typeof value.identity.deviceId === "string" && UUID.test(value.identity.deviceId)
    && Number.isSafeInteger(value.identity.protocolEpoch) && Number(value.identity.protocolEpoch) > 0
    && typeof value.objectId === "string" && UUID.test(value.objectId)
    && typeof value.ciphertextHash === "string" && SHA256.test(value.ciphertextHash)
    && Number.isSafeInteger(value.byteSize) && Number(value.byteSize) > 0
    && Number.isSafeInteger(value.partSize) && Number(value.partSize) >= 5 * 1024 * 1024
    && Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0
    && Array.isArray(value.parts) && value.parts.every((part) => exactKeys(part, ["partNumber", "byteSize", "sha256"])
      && Number.isSafeInteger(part.partNumber) && Number(part.partNumber) >= 1
      && Number.isSafeInteger(part.byteSize) && Number(part.byteSize) > 0
      && typeof part.sha256 === "string" && SHA256.test(part.sha256))
    && new Set((value.parts as PartRef[]).map((part) => part.partNumber)).size === value.parts.length
    && typeof value.digest === "string" && SHA256.test(value.digest);
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function apiHostKey(apiBaseUrl: string): string {
  return new URL(apiBaseUrl).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
}

export function createVaultSyncV2DownloadStageStore(
  app: App,
  rawIdentity: VaultSyncV2Identity,
  options: { now?: () => number; maxStagedBytes?: number } = {},
): VaultSyncV2DownloadStageStore {
  const identity = normalizedIdentity(rawIdentity);
  const adapter: DataAdapter = app.vault.adapter;
  const now = options.now ?? Date.now;
  const maxStagedBytes = options.maxStagedBytes ?? MAX_STAGED_BYTES;
  if (!Number.isSafeInteger(maxStagedBytes) || maxStagedBytes < 24 * 1024 * 1024) {
    throw fail("download_stage_budget_invalid", "分段下载暂存预算必须至少容纳一个完整对象");
  }
  let serial: Promise<unknown> = Promise.resolve();

  function withSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = serial.then(task, task);
    serial = result.then(() => undefined, () => undefined);
    return result;
  }

  function objectKey(request: VaultSyncV2DownloadStageRequest): string {
    return `${apiHostKey(identity.apiBaseUrl)}-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-${request.objectId.toLowerCase()}-${request.ciphertextHash.toLowerCase()}`;
  }

  function statePrefix(request: VaultSyncV2DownloadStageRequest): string {
    return `${DIR}/object-download-state-${objectKey(request)}-`;
  }

  function partPrefix(request: VaultSyncV2DownloadStageRequest): string {
    return `${DIR}/object-download-part-${objectKey(request)}-`;
  }

  function partPath(request: VaultSyncV2DownloadStageRequest, partNumber: number): string {
    return `${partPrefix(request)}${String(partNumber).padStart(5, "0")}.bin`;
  }

  async function digest(value: unknown): Promise<string> {
    return sha256Hex(new TextEncoder().encode(stableJson(value)));
  }

  async function listFiles(): Promise<string[]> {
    return (await adapter.list(DIR).catch(() => ({ files: [], folders: [] }))).files;
  }

  async function removePrefix(prefix: string): Promise<void> {
    for (const path of await listFiles()) {
      if (path.startsWith(prefix)) await adapter.remove(path).catch(() => {});
    }
  }

  async function ensureDirectory(): Promise<void> {
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
  }

  async function scan(request: VaultSyncV2DownloadStageRequest): Promise<{
    state: Omit<StageState, "digest"> & { digest: string } | null;
    maxGeneration: bigint;
    validPaths: string[];
  }> {
    const prefix = statePrefix(request);
    const candidates = (await listFiles()).flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(prefix.length, -5);
      return GENERATION.test(raw) ? [{ path, generation: BigInt(raw) }] : [];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let state: Omit<StageState, "digest"> & { digest: string } | null = null;
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      maxGeneration = candidate.generation > maxGeneration ? candidate.generation : maxGeneration;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
      if (!validState(parsed) || parsed.generation !== candidate.generation.toString()
        || parsed.objectId !== request.objectId || parsed.ciphertextHash !== request.ciphertextHash.toLowerCase()
        || parsed.byteSize !== request.byteSize || parsed.partSize !== request.partSize
        || !parsed.parts.every((part) => validPart(part, request))
        || stableJson(parsed.identity) !== stableJson(identity)
        || now() - parsed.updatedAt > MAX_STAGE_AGE_MS) continue;
      const { digest: savedDigest, ...body } = parsed;
      if (await digest(body) !== savedDigest) continue;
      state = parsed;
      validPaths.push(candidate.path);
    }
    return { state, maxGeneration, validPaths };
  }

  async function persist(request: VaultSyncV2DownloadStageRequest, parts: PartRef[]): Promise<void> {
    const current = await scan(request);
    const generation = (current.maxGeneration + 1n).toString();
    const body = {
      version: 1 as const,
      generation,
      identity,
      objectId: request.objectId,
      ciphertextHash: request.ciphertextHash.toLowerCase(),
      byteSize: request.byteSize,
      partSize: request.partSize,
      updatedAt: now(),
      parts: [...parts].sort((a, b) => a.partNumber - b.partNumber),
    };
    const state = { ...body, digest: await digest(body) };
    await ensureDirectory();
    const path = statePrefix(request) + generation.padStart(20, "0") + ".json";
    const serialized = stableJson(state) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("download_stage_write_unverified", "下载分段 checkpoint 回读校验失败");
    const check = await scan(request);
    if (!check.state || check.state.generation !== generation) throw fail("download_stage_write_unverified", "下载分段 checkpoint 摘要校验失败");
    for (const oldPath of check.validPaths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
  }

  async function evictFor(request: VaultSyncV2DownloadStageRequest, additionalBytes: number): Promise<void> {
    const files = await listFiles();
    const statesByKey = new Map<string, { key: string; prefix: string; statePrefix: string; generation: bigint; updatedAt: number; bytes: number; parts: PartRef[] }>();
    for (const path of files) {
      if (!path.startsWith(`${DIR}/object-download-state-`) || !path.endsWith(".json")) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(path)); } catch { continue; }
      if (!validState(parsed)) continue;
      const { digest: savedDigest, ...body } = parsed;
      if (await digest(body) !== savedDigest) continue;
      const key = `${apiHostKey(parsed.identity.apiBaseUrl)}-${parsed.identity.targetId}-${parsed.identity.deviceId}-e${parsed.identity.protocolEpoch}-${parsed.objectId.toLowerCase()}-${parsed.ciphertextHash.toLowerCase()}`;
      const candidate = { key, prefix: `${DIR}/object-download-part-${key}-`, statePrefix: `${DIR}/object-download-state-${key}-`,
        generation: BigInt(parsed.generation), updatedAt: parsed.updatedAt,
        bytes: parsed.parts.reduce((sum, part) => sum + Number(part.byteSize), 0), parts: parsed.parts as PartRef[] };
      const current = statesByKey.get(key);
      if (!current || candidate.generation > current.generation) statesByKey.set(key, candidate);
    }
    const states = [...statesByKey.values()];
    const currentKey = objectKey(request);
    const currentBytes = states.filter((state) => state.key === currentKey).reduce((sum, state) => Math.max(sum, state.bytes), 0);
    let total = states.reduce((sum, state) => sum + state.bytes, 0);
    const expired = new Set(states.filter((state) => now() - state.updatedAt > MAX_STAGE_AGE_MS).map((state) => state.key));
    const removed = new Set(expired);
    for (const key of expired) {
      const item = states.find((state) => state.key === key);
      if (!item) continue;
      await removePrefix(item.prefix);
      await removePrefix(item.statePrefix);
      total -= item.bytes;
      removed.add(item.key);
    }
    const retainedPartPaths = new Set(states.filter((state) => !removed.has(state.key))
      .flatMap((state) => state.parts.map((part) => `${state.prefix}${String(part.partNumber).padStart(5, "0")}.bin`)));
    for (const path of files) {
      if (path.startsWith(`${DIR}/object-download-part-`) && path.endsWith(".bin") && !retainedPartPaths.has(path)) {
        await adapter.remove(path).catch(() => {});
      }
    }
    const candidates = states.filter((state) => state.key !== currentKey && !expired.has(state.key))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const item of candidates) {
      if (total + additionalBytes <= maxStagedBytes) break;
      await removePrefix(item.prefix);
      await removePrefix(item.statePrefix);
      total -= item.bytes;
    }
    if (currentBytes + additionalBytes > maxStagedBytes) {
      throw fail("download_stage_capacity", "当前对象超过本地下载暂存预算");
    }
  }

  return {
    readPart(request, partNumber) {
      validateRequest(request);
      return withSerial(async () => {
        const expectedBytes = expectedPartBytes(request, partNumber);
        if (expectedBytes < 0) throw fail("download_stage_part_invalid", "下载分段编号无效");
        const current = await scan(request);
        const partRef = current.state?.parts.find((entry) => entry.partNumber === partNumber);
        if (!partRef) return null;
        try {
          const path = partPath(request, partNumber);
          const stat = typeof adapter.stat === "function" ? await adapter.stat(path).catch(() => null) : null;
          if (stat?.type === "folder" || (stat && stat.size !== expectedBytes)) return null;
          const bytes = new Uint8Array(await adapter.readBinary(path));
          if (bytes.byteLength !== expectedBytes || await sha256Hex(bytes) !== partRef.sha256) return null;
          return bytes;
        } catch { return null; }
      });
    },

    writePart(request, partNumber, bytes) {
      validateRequest(request);
      return withSerial(async () => {
        const expectedBytes = expectedPartBytes(request, partNumber);
        if (expectedBytes < 0 || bytes.byteLength !== expectedBytes) {
          throw fail("download_stage_part_size_invalid", "下载分段尺寸无效");
        }
        const current = await scan(request);
        const previous = current.state?.parts.find((entry) => entry.partNumber === partNumber);
        await evictFor(request, previous ? Math.max(0, expectedBytes - previous.byteSize) : expectedBytes);
        await ensureDirectory();
        const path = partPath(request, partNumber);
        const partHash = await sha256Hex(bytes);
        await adapter.writeBinary(path, exactBuffer(bytes));
        const stat = typeof adapter.stat === "function" ? await adapter.stat(path).catch(() => null) : null;
        if (stat?.type === "folder" || (stat && stat.size !== expectedBytes)) {
          throw fail("download_stage_part_unverified", "下载分段本地落盘尺寸校验失败");
        }
        const verified = new Uint8Array(await adapter.readBinary(path));
        if (verified.byteLength !== expectedBytes || await sha256Hex(verified) !== partHash) {
          throw fail("download_stage_part_unverified", "下载分段本地落盘校验失败");
        }
        const parts = (current.state?.parts ?? []).filter((entry) => entry.partNumber !== partNumber);
        parts.push({ partNumber, byteSize: expectedBytes, sha256: partHash });
        await persist(request, parts);
      });
    },

    clear(request) {
      validateRequest(request);
      return withSerial(async () => {
        const key = objectKey(request);
        await removePrefix(`${DIR}/object-download-part-${key}-`);
        await removePrefix(`${DIR}/object-download-state-${key}-`);
      });
    },
  };
}
