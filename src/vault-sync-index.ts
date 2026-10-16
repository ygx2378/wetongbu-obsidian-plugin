// Incremental local content index for the legacy sync path. Vault events mark
// individual files dirty; a small rotating audit catches missed external edits.
import type { App } from "obsidian";
import { normalizeVaultPath, portableVaultPathKey, SHA256_PATTERN } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { LocalFileHashCache, LocalHashCacheFile } from "./vault-sync-local.ts";

const INDEX_PATH = ".wetongbu/vault-sync-index-v1.json";
const AUDIT_BATCH_SIZE = 64;

interface CachedFile {
  contentHash: string;
  byteSize: number;
  mtimeMs: number;
}

interface PersistedIndex {
  version: 1;
  lastAuditPath: string;
  files: Record<string, CachedFile>;
  digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function isCachedFile(value: unknown): value is CachedFile {
  return isRecord(value)
    && typeof value.contentHash === "string" && SHA256_PATTERN.test(value.contentHash)
    && Number.isSafeInteger(value.byteSize) && Number(value.byteSize) >= 0
    && Number.isSafeInteger(value.mtimeMs) && Number(value.mtimeMs) >= 0;
}

function isPersistedIndex(value: unknown): value is PersistedIndex {
  if (!isRecord(value) || value.version !== 1 || typeof value.lastAuditPath !== "string"
    || !isRecord(value.files) || typeof value.digest !== "string" || !SHA256_PATTERN.test(value.digest)) return false;
  if (value.lastAuditPath && normalizeVaultPath(value.lastAuditPath) !== value.lastAuditPath) return false;
  for (const [path, entry] of Object.entries(value.files)) {
    if (!path || normalizeVaultPath(path) !== path || !isCachedFile(entry)) return false;
  }
  return true;
}

export interface VaultSyncLocalIndex extends LocalFileHashCache {
  invalidate(path: string): void;
  remove(path: string): void;
  getGeneration(path: string): number;
}

/** Load a verified on-disk cache. Invalid or torn cache files cause a safe cold scan. */
export async function createVaultSyncIndex(app: App): Promise<VaultSyncLocalIndex> {
  const adapter = app.vault.adapter as any;
  const entries = new Map<string, CachedFile>();
  const generations = new Map<string, number>();
  const invalidated = new Set<string>();
  let lastAuditPath = "";
  let auditPaths = new Set<string>();
  let scanGenerations = new Map<string, number>();
  let nextAuditPath = lastAuditPath;

  if (await adapter.exists(INDEX_PATH).catch(() => false)) {
    try {
      const parsed: unknown = JSON.parse(await adapter.read(INDEX_PATH));
      if (isPersistedIndex(parsed)) {
        const { digest, ...body } = parsed;
        if (await sha256Hex(new TextEncoder().encode(stableJson(body))) === digest) {
          lastAuditPath = parsed.lastAuditPath;
          for (const [path, entry] of Object.entries(parsed.files)) entries.set(path, { ...entry });
        }
      }
    } catch {
      // The index is only an optimization; any corruption falls back to hashing.
    }
  }

  function bump(path: string) {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return "";
    const key = portableVaultPathKey(normalized) ?? normalized;
    generations.set(key, (generations.get(key) ?? 0) + 1);
    invalidated.add(key);
    return normalized;
  }

  function generation(path: string): number {
    const normalized = normalizeVaultPath(path);
    if (!normalized) return 0;
    return generations.get(portableVaultPathKey(normalized) ?? normalized) ?? 0;
  }

  function serialize(): Promise<string> {
    const body = {
      version: 1 as const,
      lastAuditPath,
      files: Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    return sha256Hex(new TextEncoder().encode(stableJson(body)))
      .then((digest) => `${stableJson({ ...body, digest })}\n`);
  }

  async function persist() {
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    const temporary = `${INDEX_PATH}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const serialized = await serialize();
    try {
      await adapter.write(temporary, serialized);
      if (await adapter.read(temporary) !== serialized) throw new Error("Vault 本地索引回读校验失败");
    } catch (error) {
      await adapter.remove(temporary).catch(() => {});
      throw error;
    }
    const hadPrevious = await adapter.exists(INDEX_PATH).catch(() => false);
    const previous = hadPrevious ? await adapter.read(INDEX_PATH) : null;
    try {
      if (!hadPrevious && typeof adapter.rename === "function") {
        try {
          await adapter.rename(temporary, INDEX_PATH);
          if (await adapter.read(INDEX_PATH) === serialized) return;
        } catch {
          // Obsidian's local adapter refuses rename over an existing path. If
          // a provider completed the move before reporting an error, accept
          // only the exact verified contents below.
        }
        if (await adapter.read(INDEX_PATH).catch(() => "") === serialized) return;
      }
      await adapter.write(INDEX_PATH, serialized);
      if (await adapter.read(INDEX_PATH).catch(() => "") !== serialized) {
        throw new Error("Vault 本地索引替换校验失败");
      }
    } catch (error) {
      if (hadPrevious && previous !== null) {
        await adapter.write(INDEX_PATH, previous).catch(() => {});
      } else {
        await adapter.remove(INDEX_PATH).catch(() => {});
      }
      throw error;
    } finally {
      await adapter.remove(temporary).catch(() => {});
    }
  }

  function isCurrent(path: string) {
    const normalized = normalizeVaultPath(path);
    return !!normalized && scanGenerations.get(normalized) === generation(normalized);
  }

  return {
    prepare(files: LocalHashCacheFile[]) {
      const sorted = [...new Set(files.map((file) => normalizeVaultPath(file.path)).filter((path): path is string => !!path))].sort();
      scanGenerations = new Map(sorted.map((path) => [path, generation(path)]));
      auditPaths = new Set();
      if (sorted.length === 0) {
        nextAuditPath = "";
        return;
      }
      const firstAfter = sorted.findIndex((path) => path > lastAuditPath);
      const start = firstAfter < 0 ? 0 : firstAfter;
      const count = Math.min(AUDIT_BATCH_SIZE, Math.max(1, Math.ceil(sorted.length / 32)));
      const selected: string[] = [];
      for (let offset = 0; offset < count; offset += 1) selected.push(sorted[(start + offset) % sorted.length]);
      auditPaths = new Set(selected);
      nextAuditPath = selected.at(-1) ?? lastAuditPath;
    },
    get(path: string, byteSize: number, mtimeMs: number) {
      const normalized = normalizeVaultPath(path);
      const key = normalized ? (portableVaultPathKey(normalized) ?? normalized) : "";
      if (!normalized || auditPaths.has(normalized) || invalidated.has(key)
        || !isCurrent(normalized)) return null;
      const entry = entries.get(normalized);
      if (!entry || entry.byteSize !== byteSize || entry.mtimeMs !== mtimeMs) return null;
      return { hash: entry.contentHash };
    },
    isAuditPath(path: string) {
      const normalized = normalizeVaultPath(path);
      return !!normalized && auditPaths.has(normalized);
    },
    set(path: string, hash: string, byteSize: number, mtimeMs: number) {
      const normalized = normalizeVaultPath(path);
      if (!normalized || !SHA256_PATTERN.test(hash) || !Number.isSafeInteger(byteSize) || byteSize < 0
        || !Number.isSafeInteger(mtimeMs) || mtimeMs < 0 || !isCurrent(normalized)) return false;
      entries.set(normalized, { contentHash: hash, byteSize, mtimeMs });
      invalidated.delete(portableVaultPathKey(normalized) ?? normalized);
      return true;
    },
    isCurrent(path: string) {
      return isCurrent(path);
    },
    getGeneration(path: string) {
      return generation(path);
    },
    async finish(paths: string[], pruneMissing: boolean) {
      if (pruneMissing) {
        const present = new Set(paths.map((path) => normalizeVaultPath(path)).filter((path): path is string => !!path));
        for (const path of entries.keys()) if (!present.has(path)) entries.delete(path);
      }
      lastAuditPath = nextAuditPath;
      await persist();
    },
    invalidate(path: string) {
      const normalized = bump(path);
      if (normalized) entries.delete(normalized);
    },
    remove(path: string) {
      const normalized = bump(path);
      if (normalized) {
        entries.delete(normalized);
      }
    },
  };
}
