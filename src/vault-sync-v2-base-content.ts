// Bounded, content-addressed cache for the last shared Markdown bodies.
// This store is only a merge aid: missing/corrupt/decryption-incompatible
// entries are cache misses and must never be treated as a trusted base.
import type { App, DataAdapter } from "obsidian";
import { sha256Hex } from "./shared/hash.ts";
import { VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES } from "./vault-sync-history.ts";
import type { VaultSyncCrypto, VaultSyncCryptoKeyring } from "./shared/vault-sync-crypto.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface VaultSyncV2BaseContentEntry {
  plaintextHash: string;
  byteSize: number;
  ciphertextHash: string;
  encrypted: boolean;
  /** Missing on v1 cache indexes; those entries were encrypted with version 1. */
  keyVersion?: number;
  objectPath: string;
  storedAt: number;
}

export interface VaultSyncV2BaseContentStore {
  get(plaintextHash: string): Promise<Uint8Array | null>;
  put(plaintextHash: string, bytes: Uint8Array): Promise<{ stored: boolean; reason?: "entry_too_large" | "capacity" }>;
  stats(): Promise<{ entries: number; byteSize: number; maxBytes: number }>;
}

export interface VaultSyncV2BaseContentOptions {
  maxBytes?: number;
  maxEntryBytes?: number;
  now?: () => number;
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

function normalizedIdentity(input: VaultSyncV2Identity): VaultSyncV2Identity {
  let apiBaseUrl: string;
  try {
    const url = new URL(input.apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    url.search = "";
    url.hash = "";
    apiBaseUrl = url.toString().replace(/\/+$/, "");
  } catch { throw fail("base_content_identity_invalid", "Vault 基线缓存 API 地址无效"); }
  if (!UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) {
    throw fail("base_content_identity_invalid", "Vault 基线缓存身份无效");
  }
  return { apiBaseUrl, targetId: input.targetId.toLowerCase(), deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch };
}

function validEntry(value: unknown, prefix: string, maxEntryBytes: number): value is VaultSyncV2BaseContentEntry {
  if (!isRecord(value)) return false;
  const validKeyVersion = value.encrypted === true
    ? value.keyVersion === undefined || (Number.isSafeInteger(value.keyVersion) && Number(value.keyVersion) >= 1)
    : value.keyVersion === undefined;
  return validKeyVersion
    && typeof value.plaintextHash === "string" && SHA256.test(value.plaintextHash)
    && Number.isSafeInteger(value.byteSize) && Number(value.byteSize) >= 0 && Number(value.byteSize) <= maxEntryBytes
    && typeof value.ciphertextHash === "string" && SHA256.test(value.ciphertextHash)
    && typeof value.encrypted === "boolean"
    && typeof value.objectPath === "string" && value.objectPath.startsWith(prefix)
    && Number.isSafeInteger(value.storedAt) && Number(value.storedAt) >= 0;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Keeps the newest Markdown base bodies up to a fixed local disk budget. The
 * optional Vault encryption key or keyring protects cached plaintext when E2E
 * encryption is enabled. A cache miss is always safe; callers must fall back
 * to a manual conflict when no verified common base is available.
 */
export function createVaultSyncV2BaseContentStore(
  app: App,
  rawIdentity: VaultSyncV2Identity,
  crypto?: VaultSyncCrypto | VaultSyncCryptoKeyring,
  options: VaultSyncV2BaseContentOptions = {},
): VaultSyncV2BaseContentStore {
  const identity = normalizedIdentity(rawIdentity);
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxEntryBytes = options.maxEntryBytes ?? 2 * 1024 * 1024;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 0) {
    throw fail("base_content_budget_invalid", "Vault 基线缓存容量无效");
  }
  const isKeyring = (value: VaultSyncCrypto | VaultSyncCryptoKeyring): value is VaultSyncCryptoKeyring =>
    "activeKeyVersion" in value && typeof value.forVersion === "function";
  const keyring = crypto && isKeyring(crypto) ? crypto : null;
  const activeCrypto: VaultSyncCrypto | undefined = !crypto
    ? undefined
    : keyring ? keyring.forVersion(keyring.activeKeyVersion) : crypto as VaultSyncCrypto;
  if (crypto && (!activeCrypto || !Number.isSafeInteger(activeCrypto.keyVersion) || activeCrypto.keyVersion < 1
    || (keyring && activeCrypto.keyVersion !== keyring.activeKeyVersion))) {
    throw fail("base_content_key_required", "当前 Vault 基线缓存加密密钥不可用");
  }
  const cryptoForVersion = (keyVersion: number): VaultSyncCrypto | undefined => {
    const selected: VaultSyncCrypto | undefined = keyring ? keyring.forVersion(keyVersion) : activeCrypto;
    return selected?.keyVersion === keyVersion ? selected : undefined;
  };
  const adapter: DataAdapter = app.vault.adapter;
  const objectPrefix = `${DIR}/base-object-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-`;
  const indexPrefix = `${DIR}/base-index-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-`;
  let serial: Promise<unknown> = Promise.resolve();

  async function digest(value: unknown): Promise<string> {
    return sha256Hex(new TextEncoder().encode(stableJson(value)));
  }

  async function readLatest(): Promise<{
    generation: bigint;
    entries: Map<string, VaultSyncV2BaseContentEntry>;
    validPaths: string[];
  }> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const candidates = listed.files.flatMap((path) => {
      if (!path.startsWith(indexPrefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(indexPrefix.length, -5);
      return /^\d{20}$/.test(raw) ? [{ path, generation: BigInt(raw) }] : [];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let generation = 0n;
    let entries = new Map<string, VaultSyncV2BaseContentEntry>();
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      if (candidate.generation > generation) generation = candidate.generation;
      try {
        const parsed: unknown = JSON.parse(await adapter.read(candidate.path));
        if (!isRecord(parsed) || parsed.version !== 1 || parsed.generation !== candidate.generation.toString()
          || !isRecord(parsed.identity) || stableJson(parsed.identity) !== stableJson(identity)
          || !Array.isArray(parsed.entries) || !parsed.entries.every((entry) => validEntry(entry, objectPrefix, maxEntryBytes))
          || typeof parsed.digest !== "string" || !SHA256.test(parsed.digest)) continue;
        const { digest: savedDigest, ...body } = parsed;
        if (await digest(body) !== savedDigest) continue;
        const next = new Map<string, VaultSyncV2BaseContentEntry>();
        let duplicate = false;
        for (const entry of parsed.entries as VaultSyncV2BaseContentEntry[]) {
          if (next.has(entry.plaintextHash)) { duplicate = true; break; }
          next.set(entry.plaintextHash, entry.encrypted && entry.keyVersion === undefined
            ? { ...entry, keyVersion: 1 }
            : entry);
        }
        if (duplicate) continue;
        entries = next;
        validPaths.push(candidate.path);
      } catch { /* a torn newest index falls back to the last verified one */ }
    }
    return { generation, entries, validPaths };
  }

  async function persist(entries: Map<string, VaultSyncV2BaseContentEntry>): Promise<void> {
    const current = await readLatest();
    const generation = current.generation + 1n;
    const body = { version: 1 as const, generation: generation.toString(), identity,
      entries: [...entries.values()].sort((a, b) => a.plaintextHash.localeCompare(b.plaintextHash)) };
    const snapshot = { ...body, digest: await digest(body) };
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = indexPrefix + generation.toString().padStart(20, "0") + ".json";
    const serialized = stableJson(snapshot) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("base_content_index_unverified", "Vault 基线缓存索引回读失败");
    const verified = await readLatest();
    if (verified.generation !== generation
      || stableJson([...verified.entries.values()].sort((a, b) => a.plaintextHash.localeCompare(b.plaintextHash)))
        !== stableJson([...entries.values()].sort((a, b) => a.plaintextHash.localeCompare(b.plaintextHash)))) {
      throw fail("base_content_index_unverified", "Vault 基线缓存索引摘要校验失败");
    }
    for (const oldPath of verified.validPaths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
  }

  async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = serial;
    let release!: () => void;
    serial = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await work(); } finally { release(); }
  }

  async function getOne(plaintextHash: string): Promise<Uint8Array | null> {
    if (!SHA256.test(plaintextHash)) return null;
    const { entries } = await readLatest();
    const entry = entries.get(plaintextHash);
    if (!entry) return null;
    try {
      if (entry.byteSize > maxEntryBytes) return null;
      const objectStat = typeof adapter.stat === "function"
        ? await adapter.stat(entry.objectPath).catch(() => null)
        : null;
      if (objectStat?.type === "folder" || (objectStat && Number(objectStat.size) > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES)) return null;
      const stored = new Uint8Array(await adapter.readBinary(entry.objectPath));
      if (stored.byteLength > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES || await sha256Hex(stored) !== entry.ciphertextHash) return null;
      const decryptionKey = entry.encrypted ? cryptoForVersion(entry.keyVersion ?? 1) : undefined;
      if (entry.encrypted && !decryptionKey) return null;
      const plaintext = entry.encrypted
        ? await decryptionKey!.decryptObject(stored)
        : { plaintext: stored, plaintextHash: await sha256Hex(stored) };
      if (plaintext.plaintextHash !== plaintextHash || plaintext.plaintext.byteLength !== entry.byteSize
        || await sha256Hex(plaintext.plaintext) !== plaintextHash) return null;
      return plaintext.plaintext;
    } catch { return null; }
  }

  return {
    get: getOne,
    put(plaintextHash, bytes) {
      return runExclusive(async () => {
        if (!SHA256.test(plaintextHash) || !(bytes instanceof Uint8Array)
          || await sha256Hex(bytes) !== plaintextHash) throw fail("base_content_hash_mismatch", "Vault 基线内容摘要不匹配");
        if (bytes.byteLength > maxEntryBytes) return { stored: false, reason: "entry_too_large" as const };
        const current = await readLatest();
        const existing = current.entries.get(plaintextHash);
        const existingVersion = existing?.encrypted ? existing.keyVersion ?? 1 : null;
        const activeVersion = activeCrypto?.keyVersion ?? null;
        const existingUsesActiveKey = existing && existingVersion === activeVersion;
        if (existing && existingUsesActiveKey && await getOne(plaintextHash)) return { stored: true };
        const stored = activeCrypto ? await activeCrypto.encryptObject(bytes, plaintextHash) : bytes.slice();
        const ciphertextHash = await sha256Hex(stored);
        // Do not put the plaintext hash in a filename when E2E encryption is
        // enabled; the encrypted index remains local plugin metadata.
        const objectPath = `${objectPrefix}${ciphertextHash}.bin`;
        if (await adapter.exists(objectPath)) {
          const present = new Uint8Array(await adapter.readBinary(objectPath));
          if (await sha256Hex(present) !== ciphertextHash) throw fail("base_content_object_corrupt", "Vault 基线缓存对象损坏");
        } else {
          await adapter.writeBinary(objectPath, exactBuffer(stored));
          const reread = new Uint8Array(await adapter.readBinary(objectPath));
          if (reread.byteLength !== stored.byteLength || await sha256Hex(reread) !== ciphertextHash) {
            throw fail("base_content_object_unverified", "Vault 基线缓存对象回读校验失败");
          }
        }
        const entries = current.entries;
        const nextEntry: VaultSyncV2BaseContentEntry = { plaintextHash, byteSize: bytes.byteLength, ciphertextHash,
          encrypted: !!activeCrypto, objectPath, storedAt: now() };
        if (activeCrypto) nextEntry.keyVersion = activeCrypto.keyVersion;
        entries.set(plaintextHash, nextEntry);
        let usedBytes = [...entries.values()].reduce((sum, entry) => sum + entry.byteSize, 0);
        const evicted: VaultSyncV2BaseContentEntry[] = [];
        const oldest = () => [...entries.values()].sort((a, b) => a.storedAt - b.storedAt || a.plaintextHash.localeCompare(b.plaintextHash));
        for (const candidate of oldest()) {
          if (usedBytes <= maxBytes) break;
          if (candidate.plaintextHash === plaintextHash) continue;
          entries.delete(candidate.plaintextHash);
          usedBytes -= candidate.byteSize;
          evicted.push(candidate);
        }
        if (usedBytes > maxBytes) {
          entries.delete(plaintextHash);
          await persist(entries);
          await adapter.remove(objectPath).catch(() => {});
          return { stored: false, reason: "capacity" as const };
        }
        await persist(entries);
        if (existing && existing.objectPath !== objectPath
          && ![...entries.values()].some((entry) => entry.objectPath === existing.objectPath)) {
          await adapter.remove(existing.objectPath).catch(() => {});
        }
        for (const candidate of evicted) {
          if (![...entries.values()].some((entry) => entry.objectPath === candidate.objectPath)) {
            await adapter.remove(candidate.objectPath).catch(() => {});
          }
        }
        return { stored: true };
      });
    },
    async stats() {
      const { entries } = await readLatest();
      return { entries: entries.size, byteSize: [...entries.values()].reduce((sum, entry) => sum + entry.byteSize, 0), maxBytes };
    },
  };
}
