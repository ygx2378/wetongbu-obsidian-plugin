// Durable, content-free local path move intents. These preserve file identity
// across restarts until the corresponding v2 rename is committed or reviewed.
import type { App, DataAdapter } from "obsidian";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";

const DIR = ".wetongbu/sync-v2";
const MAX_PATH_INTENTS = 10_000;
const MAX_DIRECTORY_MOVE_GROUPS_PER_INTENT = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const writeQueues = new WeakMap<object, Map<string, Promise<void>>>();

export interface VaultSyncPathIntentIdentity {
  apiBaseUrl: string;
  targetId: string;
  installationId: string;
}

export interface VaultSyncPathMoveIntent {
  intentId: string;
  fromPath: string;
  toPath: string;
  fileId: string | null;
  state: "pending" | "conflict";
  directoryMoveGroupIds?: string[];
}

export interface VaultSyncPathMoveInput {
  fromPath: string;
  toPath: string;
  fileId?: string | null;
}

export interface VaultSyncPathIntentSummary {
  pendingCount: number;
  conflictCount: number;
  directoryMoveGroupCount: number;
  directoryMoveTotalCount: number;
  directoryMoveSettledCount: number;
  directoryMoveRemainingCount: number;
  directoryMoveConflictCount: number;
}

export interface VaultSyncPathIntentStore {
  load(): Promise<VaultSyncPathMoveIntent[]>;
  summary(): Promise<VaultSyncPathIntentSummary>;
  record(fromPath: string, toPath: string): Promise<VaultSyncPathMoveIntent | null>;
  recordMany(moves: VaultSyncPathMoveInput[], directoryMoveGroupId?: string): Promise<VaultSyncPathMoveIntent[]>;
  bindFile(intentId: string, fileId: string): Promise<void>;
  markConflict(intentId: string): Promise<void>;
  remove(intentId: string): Promise<void>;
  removeForFile(fileId: string): Promise<void>;
}

function withIdentityWriteLock<T>(adapter: DataAdapter, key: string, work: () => Promise<T>): Promise<T> {
  let queues = writeQueues.get(adapter as object);
  if (!queues) { queues = new Map(); writeQueues.set(adapter as object, queues); }
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  return (async () => {
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (queues?.get(key) === current) queues.delete(key);
    }
  })();
}

interface LegacySnapshot {
  version: 1;
  generation: string;
  identity: VaultSyncPathIntentIdentity;
  entries: VaultSyncPathMoveIntent[];
  digest: string;
}

interface DirectoryMoveGroup {
  groupId: string;
  totalCount: number;
  settledCount: number;
  remainingIntentIds: string[];
}

interface Snapshot {
  version: 2;
  generation: string;
  identity: VaultSyncPathIntentIdentity;
  entries: VaultSyncPathMoveIntent[];
  directoryMoveGroups: DirectoryMoveGroup[];
  digest: string;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function resolveVaultSyncPathMoveIdentities(
  baselineEntries: ReadonlyArray<{ fileId: string; path: string; isDeleted: boolean }>,
  pathMoves: ReadonlyArray<Pick<VaultSyncPathMoveIntent, "fromPath" | "toPath" | "fileId">>,
): Map<string, string> {
  const fileIdByPath = new Map<string, string>();
  for (const entry of baselineEntries) {
    if (entry.isDeleted) continue;
    const existing = fileIdByPath.get(entry.path);
    if (existing && existing !== entry.fileId) {
      throw fail("path_intent_ambiguous", "同步基线中同一路径关联了多个文件身份；已暂停以避免错配");
    }
    fileIdByPath.set(entry.path, entry.fileId);
  }

  for (const move of pathMoves) {
    const fromFileId = fileIdByPath.get(move.fromPath);
    if (move.fileId && fromFileId && move.fileId !== fromFileId) {
      throw fail("path_intent_file_mismatch", "本地改名待办与同步基线的文件身份不一致");
    }
    const fileId = move.fileId ?? fromFileId;
    if (!fileId) continue;
    if (fromFileId === fileId) fileIdByPath.delete(move.fromPath);
    const destinationFileId = fileIdByPath.get(move.toPath);
    if (destinationFileId && destinationFileId !== fileId) {
      throw fail("path_intent_ambiguous", "改名目标路径已关联其他同步文件身份；已暂停以避免覆盖");
    }
    fileIdByPath.set(move.toPath, fileId);
  }
  return fileIdByPath;
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

function normalizedIdentity(input: VaultSyncPathIntentIdentity): VaultSyncPathIntentIdentity {
  let url: URL;
  try { url = new URL(input.apiBaseUrl); } catch { throw fail("path_intent_identity_invalid", "本地改名队列身份无效"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || !UUID.test(input.targetId) || !UUID.test(input.installationId)) {
    throw fail("path_intent_identity_invalid", "本地改名队列身份无效");
  }
  url.search = "";
  url.hash = "";
  return { apiBaseUrl: url.toString().replace(/\/+$/, ""), targetId: input.targetId.toLowerCase(),
    installationId: input.installationId.toLowerCase() };
}

function validEntry(value: unknown): value is VaultSyncPathMoveIntent {
  return isRecord(value)
    && typeof value.intentId === "string" && UUID.test(value.intentId)
    && typeof value.fromPath === "string" && normalizeVaultPath(value.fromPath) === value.fromPath
    && typeof value.toPath === "string" && normalizeVaultPath(value.toPath) === value.toPath
    && value.fromPath !== value.toPath
    && (value.fileId === null || (typeof value.fileId === "string" && UUID.test(value.fileId)))
    && (value.state === "pending" || value.state === "conflict")
    && (value.directoryMoveGroupIds === undefined
      || (Array.isArray(value.directoryMoveGroupIds)
        && value.directoryMoveGroupIds.length <= MAX_DIRECTORY_MOVE_GROUPS_PER_INTENT
        && value.directoryMoveGroupIds.every((groupId) => typeof groupId === "string" && UUID.test(groupId))
        && new Set(value.directoryMoveGroupIds).size === value.directoryMoveGroupIds.length));
}

function validDirectoryMoveGroup(value: unknown): value is DirectoryMoveGroup {
  return isRecord(value)
    && typeof value.groupId === "string" && UUID.test(value.groupId)
    && Number.isSafeInteger(value.totalCount) && (value.totalCount as number) > 0
    && Number.isSafeInteger(value.settledCount) && (value.settledCount as number) >= 0
    && Array.isArray(value.remainingIntentIds) && value.remainingIntentIds.length <= MAX_PATH_INTENTS
    && value.remainingIntentIds.every((intentId) => typeof intentId === "string" && UUID.test(intentId))
    && new Set(value.remainingIntentIds).size === value.remainingIntentIds.length
    && (value.totalCount as number) === (value.settledCount as number) + value.remainingIntentIds.length;
}

function validSnapshot(value: unknown, identity: VaultSyncPathIntentIdentity): value is LegacySnapshot | Snapshot {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)
    || typeof value.generation !== "string" || !/^\d+$/.test(value.generation)
    || !isRecord(value.identity) || stableJson(value.identity) !== stableJson(identity)
    || !Array.isArray(value.entries) || value.entries.length > MAX_PATH_INTENTS || !value.entries.every(validEntry)
    || new Set(value.entries.map((entry: VaultSyncPathMoveIntent) => entry.intentId)).size !== value.entries.length
    || typeof value.digest !== "string" || !SHA256.test(value.digest)) return false;
  if (value.version === 1) return value.entries.every((entry: VaultSyncPathMoveIntent) => !entry.directoryMoveGroupIds?.length);
  if (!Array.isArray(value.directoryMoveGroups) || value.directoryMoveGroups.length > MAX_PATH_INTENTS
    || !value.directoryMoveGroups.every(validDirectoryMoveGroup)
    || new Set(value.directoryMoveGroups.map((group: DirectoryMoveGroup) => group.groupId)).size !== value.directoryMoveGroups.length) return false;
  const groups = new Map(value.directoryMoveGroups.map((group: DirectoryMoveGroup) => [group.groupId, group]));
  const entries = new Map(value.entries.map((entry: VaultSyncPathMoveIntent) => [entry.intentId, entry]));
  for (const entry of value.entries as VaultSyncPathMoveIntent[]) {
    for (const groupId of entry.directoryMoveGroupIds ?? []) {
      const group = groups.get(groupId);
      if (!group || !group.remainingIntentIds.includes(entry.intentId)) return false;
    }
  }
  for (const group of value.directoryMoveGroups as DirectoryMoveGroup[]) {
    for (const intentId of group.remainingIntentIds) {
      if (!entries.get(intentId)?.directoryMoveGroupIds?.includes(group.groupId)) return false;
    }
  }
  return true;
}

function makePrefix(identity: VaultSyncPathIntentIdentity): string {
  // File names remain opaque and bounded; the snapshot itself still binds the
  // full URL/target identity and is rejected if a prefix collision ever occurs.
  let hash = 2166136261;
  for (const codePoint of `${identity.apiBaseUrl}\n${identity.targetId}\n${identity.installationId}`) {
    hash = Math.imul(hash ^ codePoint.charCodeAt(0), 16777619);
  }
  return `${DIR}/path-moves-${(hash >>> 0).toString(16).padStart(8, "0")}-`;
}

export function createVaultSyncPathIntentStore(app: App, rawIdentity: VaultSyncPathIntentIdentity): VaultSyncPathIntentStore {
  const identity = normalizedIdentity(rawIdentity);
  const adapter = app.vault.adapter as DataAdapter;
  const prefix = makePrefix(identity);

  async function scan(): Promise<{
    entries: VaultSyncPathMoveIntent[];
    directoryMoveGroups: DirectoryMoveGroup[];
    maxGeneration: bigint;
    validPaths: string[];
  }> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const candidates = listed.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(prefix.length, -5);
      return /^\d{20}$/.test(raw) ? [{ path, generation: BigInt(raw) }] : [];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let entries: VaultSyncPathMoveIntent[] = [];
    let directoryMoveGroups: DirectoryMoveGroup[] = [];
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      maxGeneration = candidate.generation > maxGeneration ? candidate.generation : maxGeneration;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
      if (!validSnapshot(parsed, identity)) {
        if (isRecord(parsed) && isRecord(parsed.identity) && parsed.identity.targetId === identity.targetId
          && typeof parsed.identity.apiBaseUrl === "string") {
          throw fail("path_intent_identity_mismatch", "本地改名待办属于其他 API 环境；拒绝跨环境重放");
        }
        continue;
      }
      if (parsed.generation !== candidate.generation.toString()) continue;
      const { digest, ...body } = parsed;
      if (await sha256Hex(new TextEncoder().encode(stableJson(body))) !== digest) continue;
      entries = parsed.entries.map((entry) => ({ ...entry }));
      directoryMoveGroups = parsed.version === 2
        ? parsed.directoryMoveGroups.map((group) => ({ ...group, remainingIntentIds: [...group.remainingIntentIds] }))
        : [];
      validPaths.push(candidate.path);
    }
    return { entries, directoryMoveGroups, maxGeneration, validPaths };
  }

  async function persist(entries: VaultSyncPathMoveIntent[], directoryMoveGroups: DirectoryMoveGroup[]): Promise<void> {
    const current = await scan();
    const generation = current.maxGeneration + 1n;
    const body = { version: 2 as const, generation: generation.toString(), identity, entries, directoryMoveGroups };
    const snapshot = { ...body, digest: await sha256Hex(new TextEncoder().encode(stableJson(body))) };
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = prefix + generation.toString().padStart(20, "0") + ".json";
    const serialized = stableJson(snapshot) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("path_intent_write_unverified", "本地改名待办回读失败");
    const check = await scan();
    if (check.maxGeneration !== generation || stableJson(check.entries) !== stableJson(entries)
      || stableJson(check.directoryMoveGroups) !== stableJson(directoryMoveGroups)) {
      throw fail("path_intent_write_unverified", "本地改名待办摘要校验失败");
    }
    for (const oldPath of check.validPaths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
  }

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    return withIdentityWriteLock(adapter, prefix, work);
  }

  function settleGroupMember(groups: DirectoryMoveGroup[], intentId: string, groupIds?: string[]): void {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if ((!groupIds || groupIds.includes(group.groupId)) && group.remainingIntentIds.includes(intentId)) {
        group.remainingIntentIds = group.remainingIntentIds.filter((current) => current !== intentId);
        group.settledCount += 1;
        if (group.remainingIntentIds.length === 0) groups.splice(index, 1);
      }
    }
  }

  function setMoveGroup(
    entries: VaultSyncPathMoveIntent[],
    index: number,
    groupId?: string,
  ): VaultSyncPathMoveIntent {
    const current = entries[index];
    if (!groupId || current.directoryMoveGroupIds?.includes(groupId)) return current;
    const groupIds = current.directoryMoveGroupIds ?? [];
    if (groupIds.length >= MAX_DIRECTORY_MOVE_GROUPS_PER_INTENT) {
      throw fail("path_intent_group_capacity_exceeded", "同一文件关联的目录移动批次过多；同步已暂停以保留身份");
    }
    const updated = { ...current, directoryMoveGroupIds: [...groupIds, groupId] };
    entries[index] = updated;
    return updated;
  }

  function addMove(
    entries: VaultSyncPathMoveIntent[],
    groups: DirectoryMoveGroup[],
    input: VaultSyncPathMoveInput,
    groupId?: string,
  ): VaultSyncPathMoveIntent | null {
    const from = normalizeVaultPath(input.fromPath);
    const to = normalizeVaultPath(input.toPath);
    const fileId = input.fileId ?? null;
    if (!from || !to) throw fail("path_intent_path_invalid", "改名路径无效");
    if (fileId !== null && !UUID.test(fileId)) throw fail("path_intent_file_id_invalid", "改名文件身份无效");
    if (from === to) return null;
    const exactIndex = entries.findIndex((entry) => entry.state === "pending" && entry.fromPath === from && entry.toPath === to);
    if (exactIndex >= 0) {
      const exact = entries[exactIndex];
      if (exact.fileId && fileId && exact.fileId !== fileId) throw fail("path_intent_file_mismatch", "同一路径改名已关联到其他文件身份");
      const updated = setMoveGroup(entries, exactIndex, groupId);
      if (!updated.fileId && fileId) {
        entries[exactIndex] = { ...updated, fileId };
        return entries[exactIndex];
      }
      return updated;
    }
    const index = entries.findIndex((entry) => entry.state === "pending"
      && entry.toPath === from && (entry.fileId === fileId || entry.fileId === null || fileId === null));
    if (index >= 0) {
      const previous = entries[index];
      if (previous.fromPath === to) {
        entries.splice(index, 1);
        if (previous.directoryMoveGroupIds?.length) settleGroupMember(groups, previous.intentId, previous.directoryMoveGroupIds);
        return null;
      }
      const updated = setMoveGroup(entries, index, groupId);
      const chained = { ...updated, toPath: to, fileId: updated.fileId ?? fileId };
      entries[index] = chained;
      return chained;
    }
    const sameFile = entries.find((entry) => entry.fileId && fileId && entry.fileId === fileId && entry.state === "pending");
    if (sameFile) throw fail("path_intent_ambiguous", "同一文件存在不连续的本机改名待办；同步已暂停以保留文件身份");
    if (entries.length >= MAX_PATH_INTENTS) throw fail("path_intent_capacity_exceeded", "本地改名待办达到上限；同步已暂停以避免误建文件");
    const entry: VaultSyncPathMoveIntent = {
      intentId: globalThis.crypto.randomUUID(), fromPath: from, toPath: to, fileId, state: "pending",
      ...(groupId ? { directoryMoveGroupIds: [groupId] } : {}),
    };
    entries.push(entry);
    return entry;
  }

  return {
    async load() { return (await scan()).entries; },
    async summary() {
      const { entries, directoryMoveGroups } = await scan();
      const entriesById = new Map(entries.map((entry) => [entry.intentId, entry]));
      return {
        pendingCount: entries.filter((entry) => entry.state === "pending").length,
        conflictCount: entries.filter((entry) => entry.state === "conflict").length,
        directoryMoveGroupCount: directoryMoveGroups.length,
        directoryMoveTotalCount: directoryMoveGroups.reduce((total, group) => total + group.totalCount, 0),
        directoryMoveSettledCount: directoryMoveGroups.reduce((total, group) => total + group.settledCount, 0),
        directoryMoveRemainingCount: directoryMoveGroups.reduce((total, group) => total + group.remainingIntentIds.length, 0),
        directoryMoveConflictCount: directoryMoveGroups.reduce((total, group) => total + group.remainingIntentIds.filter(
          (intentId) => entriesById.get(intentId)?.state === "conflict",
        ).length, 0),
      };
    },
    record(fromPath, toPath) {
      return this.recordMany([{ fromPath, toPath }]).then((entries) => entries[0] ?? null);
    },
    recordMany(moves, directoryMoveGroupId) {
      if (!Array.isArray(moves) || moves.length > MAX_PATH_INTENTS) {
        return Promise.reject(fail("path_intent_capacity_exceeded", "单次目录改名待办超过安全上限；同步已暂停以保留文件"));
      }
      if (directoryMoveGroupId !== undefined && !UUID.test(directoryMoveGroupId)) {
        return Promise.reject(fail("path_intent_group_invalid", "目录改名批次标识无效"));
      }
      return exclusive(async () => {
        const current = await scan();
        const entries = current.entries;
        const directoryMoveGroups = current.directoryMoveGroups;
        if (directoryMoveGroupId && directoryMoveGroups.some((group) => group.groupId === directoryMoveGroupId)) {
          throw fail("path_intent_group_exists", "目录改名批次已存在");
        }
        const changed: VaultSyncPathMoveIntent[] = [];
        for (const move of moves) {
          const entry = addMove(entries, directoryMoveGroups, move, directoryMoveGroupId);
          if (entry) changed.push(entry);
        }
        if (directoryMoveGroupId) {
          const remainingIntentIds = [...new Set(entries
            .filter((entry) => entry.directoryMoveGroupIds?.includes(directoryMoveGroupId))
            .map((entry) => entry.intentId))];
          if (remainingIntentIds.length) {
            directoryMoveGroups.push({
              groupId: directoryMoveGroupId,
              totalCount: remainingIntentIds.length,
              settledCount: 0,
              remainingIntentIds,
            });
          }
        }
        await persist(entries, directoryMoveGroups);
        return changed;
      });
    },
    bindFile(intentId, fileId) {
      return exclusive(async () => {
        if (!UUID.test(fileId)) throw fail("path_intent_file_id_invalid", "改名文件身份无效");
        const current = await scan();
        const entries = current.entries;
        const index = entries.findIndex((entry) => entry.intentId === intentId);
        if (index < 0) throw fail("path_intent_missing", "本地改名待办不存在");
        if (entries[index].fileId && entries[index].fileId !== fileId) throw fail("path_intent_file_mismatch", "改名待办已绑定其他文件身份");
        entries[index] = { ...entries[index], fileId };
        await persist(entries, current.directoryMoveGroups);
      });
    },
    markConflict(intentId) {
      return exclusive(async () => {
        const current = await scan();
        const entries = current.entries;
        const index = entries.findIndex((entry) => entry.intentId === intentId);
        if (index < 0) return;
        entries[index] = { ...entries[index], state: "conflict" };
        await persist(entries, current.directoryMoveGroups);
      });
    },
    remove(intentId) {
      return exclusive(async () => {
        const current = await scan();
        const removed = current.entries.find((entry) => entry.intentId === intentId);
        if (removed?.directoryMoveGroupIds?.length) {
          settleGroupMember(current.directoryMoveGroups, removed.intentId, removed.directoryMoveGroupIds);
        }
        current.entries = current.entries.filter((entry) => entry.intentId !== intentId);
        await persist(current.entries, current.directoryMoveGroups);
      });
    },
    removeForFile(fileId) {
      return exclusive(async () => {
        const current = await scan();
        const removed = current.entries.filter((entry) => entry.fileId === fileId);
        for (const entry of removed) {
          if (entry.directoryMoveGroupIds?.length) {
            settleGroupMember(current.directoryMoveGroups, entry.intentId, entry.directoryMoveGroupIds);
          }
        }
        current.entries = current.entries.filter((entry) => entry.fileId !== fileId);
        await persist(current.entries, current.directoryMoveGroups);
      });
    },
  };
}
