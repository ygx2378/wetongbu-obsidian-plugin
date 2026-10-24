// Remembers which remote scope revision and device-local root were reconciled
// so scope changes trigger a safe snapshot before the next write scan.
import type { App, DataAdapter } from "obsidian";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const queues = new WeakMap<object, Map<string, Promise<void>>>();

export interface VaultSyncScopeIdentity {
  apiBaseUrl: string;
  targetId: string;
  deviceId: string;
  protocolEpoch: number;
}

export interface VaultSyncScopeSelection {
  scope: "whole_vault" | "root_folder";
  rootFolder: string;
  scopeVersion: number;
}

interface ScopeSnapshot extends VaultSyncScopeSelection {
  formatVersion: 1;
  generation: string;
  identity: VaultSyncScopeIdentity;
  digest: string;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function normalizeIdentity(input: VaultSyncScopeIdentity): VaultSyncScopeIdentity {
  let url: URL;
  try { url = new URL(input.apiBaseUrl); } catch { throw fail("scope_identity_invalid", "同步范围身份无效"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !UUID.test(input.targetId)
    || !UUID.test(input.deviceId) || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) {
    throw fail("scope_identity_invalid", "同步范围身份无效");
  }
  url.search = "";
  url.hash = "";
  return { apiBaseUrl: url.toString().replace(/\/+$/, ""), targetId: input.targetId.toLowerCase(),
    deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch };
}

function normalizeSelection(input: VaultSyncScopeSelection): VaultSyncScopeSelection {
  if (!input || !["whole_vault", "root_folder"].includes(input.scope)
    || !Number.isSafeInteger(input.scopeVersion) || input.scopeVersion < 1) {
    throw fail("scope_selection_invalid", "同步范围版本无效");
  }
  const rootFolder = input.scope === "whole_vault" ? "" : normalizeVaultPath(input.rootFolder);
  if (input.scope === "root_folder" && (!rootFolder || rootFolder !== input.rootFolder)) {
    throw fail("scope_selection_invalid", "微同步根目录路径无效");
  }
  return { scope: input.scope, rootFolder: rootFolder ?? "", scopeVersion: input.scopeVersion };
}

function makePrefix(identity: VaultSyncScopeIdentity): string {
  let hash = 2166136261;
  for (const character of stableJson(identity)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `${DIR}/scope-state-${(hash >>> 0).toString(16).padStart(8, "0")}-`;
}

function withWriteLock<T>(adapter: DataAdapter, prefix: string, work: () => Promise<T>): Promise<T> {
  let keyed = queues.get(adapter as object);
  if (!keyed) { keyed = new Map(); queues.set(adapter as object, keyed); }
  const previous = keyed.get(prefix) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  keyed.set(prefix, current);
  return (async () => {
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (keyed?.get(prefix) === current) keyed.delete(prefix);
    }
  })();
}

export function createVaultSyncScopeStateStore(app: App, rawIdentity: VaultSyncScopeIdentity) {
  const identity = normalizeIdentity(rawIdentity);
  const adapter = app.vault.adapter as DataAdapter;
  const prefix = makePrefix(identity);

  async function scan(): Promise<{ state: ScopeSnapshot | null; maxGeneration: bigint; validPaths: string[] }> {
    const listing = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const files = listing.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const generation = path.slice(prefix.length, -5);
      return /^\d{20}$/.test(generation) ? [{ path, generation: BigInt(generation) }] : [];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let state: ScopeSnapshot | null = null;
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const file of files) {
      if (file.generation > maxGeneration) maxGeneration = file.generation;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(file.path)); } catch { continue; }
      if (!exactKeys(parsed, ["formatVersion", "generation", "identity", "scope", "rootFolder", "scopeVersion", "digest"])
        || parsed.formatVersion !== 1 || parsed.generation !== file.generation.toString()
        || stableJson(parsed.identity) !== stableJson(identity)
        || (parsed.scope !== "whole_vault" && parsed.scope !== "root_folder")
        || typeof parsed.rootFolder !== "string" || !Number.isSafeInteger(parsed.scopeVersion) || Number(parsed.scopeVersion) < 1
        || typeof parsed.digest !== "string" || !SHA256.test(parsed.digest)) continue;
      const { digest, ...body } = parsed as unknown as ScopeSnapshot;
      if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) continue;
      if (normalizeSelection(parsed as unknown as VaultSyncScopeSelection).rootFolder !== parsed.rootFolder) continue;
      state = parsed as unknown as ScopeSnapshot;
      validPaths.push(file.path);
    }
    return { state, maxGeneration, validPaths };
  }

  return {
    async load(): Promise<VaultSyncScopeSelection | null> {
      const current = await scan();
      if (!current.state) return null;
      const { scope, rootFolder, scopeVersion } = current.state;
      return { scope, rootFolder, scopeVersion };
    },
    save(rawSelection: VaultSyncScopeSelection): Promise<void> {
      const selection = normalizeSelection(rawSelection);
      return withWriteLock(adapter, prefix, async () => {
        const current = await scan();
        const generation = current.maxGeneration + 1n;
        const body = { formatVersion: 1 as const, generation: generation.toString(), identity, ...selection };
        const snapshot = { ...body, digest: await sha256Hex(new TextEncoder().encode(stableJson(body))) };
        if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
        if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
        const path = `${prefix}${generation.toString().padStart(20, "0")}.json`;
        const serialized = stableJson(snapshot) + "\n";
        await adapter.write(path, serialized);
        if (await adapter.read(path) !== serialized) throw fail("scope_state_write_unverified", "同步范围状态回读失败");
        const verified = await scan();
        if (verified.maxGeneration !== generation || stableJson(verified.state) !== stableJson(snapshot)) {
          throw fail("scope_state_write_unverified", "同步范围状态摘要校验失败");
        }
        for (const stalePath of verified.validPaths.slice(0, -2)) await adapter.remove(stalePath).catch(() => {});
      });
    },
  };
}
