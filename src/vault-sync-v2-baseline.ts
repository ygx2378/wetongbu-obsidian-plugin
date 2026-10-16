// Durable metadata-only baseline used to distinguish a safe remote replacement
// from a local edit. Note bodies and object bytes never enter this store.
import type { App, DataAdapter } from "obsidian";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";
import { withVaultSyncV2StateWriteLock } from "./vault-sync-v2-locks.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const CURSOR = /^(0|[1-9][0-9]*)$/;

interface BaselineState {
  /** Highest generation allocated, including a torn latest write if present. */
  generation: bigint;
  /** Newest generation whose digest was verified. */
  validGeneration: bigint;
  entries: Map<string, VaultSyncV2BaselineEntry>;
}

const baselineStateByAdapter = new WeakMap<object, Map<string, BaselineState>>();

export interface VaultSyncV2BaselineEntry {
  fileId: string;
  fileVersionId: string;
  cursor: string;
  path: string;
  plaintextHash: string | null;
  byteSize: number;
  isDeleted: boolean;
}

export interface VaultSyncV2BaselineStore {
  load(): Promise<VaultSyncV2BaselineEntry[]>;
  get(fileId: string): Promise<VaultSyncV2BaselineEntry | null>;
  setMany(entries: VaultSyncV2BaselineEntry[]): Promise<void>;
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
  const url = new URL(input.apiBaseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Vault baseline API URL is invalid");
  url.search = "";
  url.hash = "";
  if (!UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) throw new Error("Vault baseline identity is invalid");
  return {
    apiBaseUrl: url.toString().replace(/\/+$/, ""), targetId: input.targetId.toLowerCase(),
    deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch,
  };
}

function validEntry(value: unknown): value is VaultSyncV2BaselineEntry {
  return isRecord(value) && UUID.test(String(value.fileId)) && UUID.test(String(value.fileVersionId))
    && typeof value.cursor === "string" && CURSOR.test(value.cursor)
    && typeof value.path === "string" && normalizeVaultPath(value.path) === value.path
    && (value.plaintextHash === null || (typeof value.plaintextHash === "string" && SHA256.test(value.plaintextHash)))
    && Number.isSafeInteger(value.byteSize) && Number(value.byteSize) >= 0
    && typeof value.isDeleted === "boolean"
    && (value.isDeleted ? value.plaintextHash === null : typeof value.plaintextHash === "string");
}

/** Read the newest verified device baseline without assuming its current protocol epoch. */
export async function loadLatestVaultSyncV2Baseline(
  app: App,
  raw: Omit<VaultSyncV2Identity, "protocolEpoch">,
): Promise<VaultSyncV2BaselineEntry[]> {
  const adapter = app.vault.adapter as DataAdapter;
  const api = new URL(raw.apiBaseUrl);
  if (api.protocol !== "https:" && api.protocol !== "http:") throw new Error("Vault baseline API URL is invalid");
  api.search = "";
  api.hash = "";
  const apiBaseUrl = api.toString().replace(/\/+$/, "");
  if (!UUID.test(raw.targetId) || !UUID.test(raw.deviceId)) throw new Error("Vault baseline identity is invalid");
  const targetId = raw.targetId.toLowerCase();
  const deviceId = raw.deviceId.toLowerCase();
  const prefix = `${DIR}/baseline-${targetId}-${deviceId}-e`;
  const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
  const candidates = listed.files.flatMap((path) => {
    if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
    const match = /^([1-9][0-9]*)-(\d{20})$/.exec(path.slice(prefix.length, -5));
    return match ? [{ path, epoch: BigInt(match[1]), generation: BigInt(match[2]) }] : [];
  }).sort((a, b) => a.epoch > b.epoch ? -1 : a.epoch < b.epoch ? 1
    : a.generation > b.generation ? -1 : a.generation < b.generation ? 1 : 0);
  for (const candidate of candidates) {
    if (candidate.epoch > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const identity = normalizedIdentity({ apiBaseUrl, targetId, deviceId, protocolEpoch: Number(candidate.epoch) });
    try {
      const parsed: unknown = JSON.parse(await adapter.read(candidate.path));
      if (!isRecord(parsed) || parsed.version !== 1 || parsed.generation !== candidate.generation.toString()
        || !isRecord(parsed.identity) || stableJson(parsed.identity) !== stableJson(identity)
        || !Array.isArray(parsed.entries) || !parsed.entries.every(validEntry)
        || typeof parsed.digest !== "string" || !SHA256.test(parsed.digest)) continue;
      const { digest, ...body } = parsed;
      if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) continue;
      const entries = parsed.entries as VaultSyncV2BaselineEntry[];
      if (new Set(entries.map((entry) => entry.fileId)).size !== entries.length) continue;
      return entries.map((entry) => ({ ...entry }));
    } catch { /* ignore torn or unreadable generations and try the prior verified snapshot */ }
  }
  return [];
}

export function createVaultSyncV2BaselineStore(app: App, rawIdentity: VaultSyncV2Identity): VaultSyncV2BaselineStore {
  const identity = normalizedIdentity(rawIdentity);
  const adapter: DataAdapter = app.vault.adapter;
  const prefix = `${DIR}/baseline-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-`;
  const cacheKey = [identity.apiBaseUrl, identity.targetId, identity.deviceId, String(identity.protocolEpoch)].join("\u0000");
  let adapterCache = baselineStateByAdapter.get(adapter as object);
  if (!adapterCache) {
    adapterCache = new Map();
    baselineStateByAdapter.set(adapter as object, adapterCache);
  }

  async function readLatestFromDisk(): Promise<BaselineState> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const paths = listed.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(prefix.length, -5);
      return /^\d{20}$/.test(raw) ? [{ path, generation: BigInt(raw) }] : [];
    }).sort((a, b) => a.generation > b.generation ? -1 : a.generation < b.generation ? 1 : 0);
    const maxGeneration = paths[0]?.generation ?? 0n;
    for (const candidate of paths) {
      try {
        const parsed: unknown = JSON.parse(await adapter.read(candidate.path));
        if (!isRecord(parsed) || parsed.version !== 1 || parsed.generation !== candidate.generation.toString()
          || !isRecord(parsed.identity) || stableJson(parsed.identity) !== stableJson(identity)
          || !Array.isArray(parsed.entries) || !parsed.entries.every(validEntry)
          || typeof parsed.digest !== "string" || !SHA256.test(parsed.digest)) continue;
        const { digest, ...body } = parsed;
        if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) continue;
        const next = new Map<string, VaultSyncV2BaselineEntry>();
        let duplicate = false;
        for (const entry of parsed.entries as VaultSyncV2BaselineEntry[]) {
          if (next.has(entry.fileId)) { duplicate = true; break; }
          next.set(entry.fileId, entry);
        }
        if (duplicate) continue;
        return { generation: maxGeneration, validGeneration: candidate.generation, entries: next };
      } catch { /* a torn generation falls back to the previous verified file */ }
    }
    return { generation: maxGeneration, validGeneration: 0n, entries: new Map() };
  }

  async function currentStateLocked(): Promise<BaselineState> {
    const cached = adapterCache!.get(cacheKey);
    if (cached) return cached;
    const loaded = await readLatestFromDisk();
    adapterCache!.set(cacheKey, loaded);
    return loaded;
  }

  async function readState(): Promise<BaselineState> {
    const cached = adapterCache!.get(cacheKey);
    if (cached) return cached;
    return withVaultSyncV2StateWriteLock(identity, currentStateLocked);
  }

  async function pruneOlderGenerations(keep: Set<bigint>): Promise<void> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const obsolete = listed.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(prefix.length, -5);
      if (!/^\d{20}$/.test(raw)) return [];
      const generation = BigInt(raw);
      return keep.has(generation) ? [] : [path];
    });
    await Promise.all(obsolete.map((path) => adapter.remove(path).catch(() => {})));
  }

  async function persist(entries: Map<string, VaultSyncV2BaselineEntry>, generation: bigint,
    previousValidGeneration: bigint): Promise<void> {
    const body = {
      version: 1 as const, generation: generation.toString(), identity,
      entries: [...entries.values()].sort((a, b) => a.fileId.localeCompare(b.fileId)),
    };
    const snapshot = { ...body, digest: await sha256Hex(new TextEncoder().encode(stableJson(body))) };
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = prefix + generation.toString().padStart(20, "0") + ".json";
    const serialized = stableJson(snapshot) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw Object.assign(new Error("v2 基线写入回读失败"), { code: "baseline_write_unverified" });
    // Keep the newly written snapshot and the newest previously verified one
    // for crash recovery. Older immutable generations add no recovery value,
    // and scanning each one on every apply makes large inbox catch-up grow
    // quadratically.
    const keep = new Set<bigint>([generation]);
    if (previousValidGeneration > 0n) keep.add(previousValidGeneration);
    await pruneOlderGenerations(keep);
  }

  return {
    load: async () => [...(await readState()).entries.values()].map((entry) => ({ ...entry })),
    get: async (fileId) => {
      const entry = (await readState()).entries.get(fileId);
      return entry ? { ...entry } : null;
    },
    setMany(newEntries) {
      return withVaultSyncV2StateWriteLock(identity, async () => {
        if (!Array.isArray(newEntries) || !newEntries.every(validEntry)) {
          throw Object.assign(new Error("v2 基线条目无效"), { code: "baseline_entry_invalid" });
        }
        const current = await currentStateLocked();
        const entries = new Map(current.entries);
        for (const entry of newEntries) entries.set(entry.fileId, { ...entry });
        const generation = current.generation + 1n;
        await persist(entries, generation, current.validGeneration);
        adapterCache!.set(cacheKey, { generation, validGeneration: generation, entries });
      });
    },
  };
}
