// Vault 多端同步：本地扫描 + prevSync 持久化。
// 提供 scanLocalFiles（遍历 vault、计算 hash）和 PrevSyncStore（读写状态 JSON）。
// 依赖 Obsidian Vault API，但通过接口注入便于测试。

import type { App, TFile } from "obsidian";
import { normalizeVaultPath, portableVaultPathKey, SHA256_PATTERN, VAULT_SYNC_SKIP_PREFIXES } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { FileEntity } from "./vault-sync-diff.ts";

/** 扫描结果：path → FileEntity。 */
export type LocalIndex = Map<string, FileEntity>;

export interface ScanResult {
  index: LocalIndex;
  unreadablePaths: string[];
  /** Paths that would collide on a case-insensitive/NFC filesystem. */
  pathCollisions: string[][];
  /** User files rejected by the portable path contract, not internal skips. */
  invalidPaths: string[];
}

/**
 * 判断文件是否应参与同步：跳过配置目录、wetongbu 内部目录、以 . 开头的隐藏文件。
 * rootFolder 模式下额外要求文件位于 rootFolder 下。
 */
export function shouldSyncPath(rawPath: string, rootFolder?: string): boolean {
  const normalized = normalizeVaultPath(rawPath);
  if (!normalized) return false;
  // root_folder 模式：仅同步 rootFolder 之下。
  if (rootFolder) {
    const root = rootFolder.replace(/\/+$/, "");
    if (normalized !== root && !normalized.startsWith(`${root}/`)) return false;
  }
  // Crash-recovery scratch files must never become durable Vault entries. The
  // writer removes them on success, but a process can stop between write and
  // cleanup; filtering here keeps them out of the remote manifest as well.
  const basename = normalized.split("/").at(-1) ?? "";
  if (/\.wetongbu-(?:update|complete)-[^/]+\.(?:tmp|bak)$/i.test(basename)) return false;
  return true;
}

/**
 * 扫描 vault 内所有文件，构造本地索引。
 * 对每个文件读取字节并计算 SHA-256。
 *
 * @param app Obsidian App（用于 vault.getFiles、adapter.read）
 * @param rootFolder 可选根目录限制
 * @param onProgress 可选进度回调（已扫描数）
 */
export async function scanLocalFiles(
  app: App,
  rootFolder: string | undefined,
  onProgress?: (scanned: number, total: number) => void,
): Promise<ScanResult> {
  const index: LocalIndex = new Map();
  const unreadablePaths: string[] = [];
  const pathsByPortableKey = new Map<string, { normalized: string; raw: string }>();
  const pathCollisions = new Map<string, Set<string>>();
  const files = app.vault.getFiles();
  const invalidPaths = files
    .filter((file) => !shouldSyncPath(file.path, rootFolder) && !isIntentionalSkip(file.path))
    .map((file) => file.path);
  const candidates = files.filter((f) => shouldSyncPath(f.path, rootFolder));
  const total = candidates.length;
  let scanned = 0;
  for (const file of candidates) {
    const normalized = normalizeVaultPath(file.path);
    const portableKey = portableVaultPathKey(file.path);
    if (!normalized || !portableKey) {
      scanned += 1;
      continue;
    }
    const previousPath = pathsByPortableKey.get(portableKey);
    if (previousPath && previousPath.raw !== file.path) {
      const group = pathCollisions.get(portableKey) ?? new Set<string>([previousPath.raw]);
      group.add(file.path);
      pathCollisions.set(portableKey, group);
      index.delete(previousPath.normalized);
      scanned += 1;
      continue;
    }
    pathsByPortableKey.set(portableKey, { normalized, raw: file.path });
    try {
      const body = await app.vault.readBinary(file);
      const hash = await sha256Hex(new Uint8Array(body));
      index.set(normalized, {
        path: normalized,
        contentHash: hash,
        byteSize: body.byteLength,
        mtimeMs: file.stat.mtime,
      });
    } catch {
      // 读失败不是删除：把路径交给编排器作为安全阀，下一轮重试。
      unreadablePaths.push(file.path);
    }
    scanned += 1;
    if (onProgress && scanned % 50 === 0) onProgress(scanned, total);
  }
  if (onProgress) onProgress(total, total);
  return {
    index,
    unreadablePaths,
    pathCollisions: [...pathCollisions.values()].map((paths) => [...paths].sort()),
    invalidPaths,
  };
}

function isIntentionalSkip(rawPath: string): boolean {
  const path = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (VAULT_SYNC_SKIP_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix))) return true;
  const basename = path.split("/").at(-1) ?? "";
  return /\.wetongbu-(?:update|complete)-[^/]+\.(?:tmp|bak)$/i.test(basename);
}

/** prevSync JSON 结构。 */
export interface PrevSyncState {
  version: 1;
  deviceId: string;
  lastCursor: number;
  lastSyncAt: string;
  files: Record<string, {
    contentHash: string | null;
    byteSize: number;
    mtimeMs: number;
    revision?: number;
    isDeleted?: boolean;
  }>;
  /** 冲突副本索引，供恢复/审计使用；不把正文复制进状态文件。 */
  conflicts?: Record<string, {
    originalPath: string;
    createdAt: string;
    localHash: string | null;
    remoteHash: string | null;
    status: "pending" | "resolved";
  }>;
}

/** prevSync 存储抽象：默认实现写 .wetongbu/vault-sync-state.json。 */
export interface PrevSyncStore {
  load(): Promise<PrevSyncState | null>;
  save(state: PrevSyncState): Promise<void>;
  clear(): Promise<void>;
}

const STATE_PATH = ".wetongbu/vault-sync-state.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/** Reject malformed state instead of letting it manufacture deletes/uploads. */
export function isValidPrevSyncState(value: unknown): value is PrevSyncState {
  if (!isRecord(value) || value.version !== 1 || typeof value.deviceId !== "string"
    || typeof value.lastSyncAt !== "string" || !isNonNegativeInteger(value.lastCursor)
    || !isRecord(value.files)) return false;
  const portablePaths = new Set<string>();
  for (const [rawPath, rawInfo] of Object.entries(value.files)) {
    const path = normalizeVaultPath(rawPath);
    if (!path || path !== rawPath || !portableVaultPathKey(path) || portablePaths.has(portableVaultPathKey(path)!)) return false;
    portablePaths.add(portableVaultPathKey(path)!);
    if (!isRecord(rawInfo) || (rawInfo.contentHash !== null && !SHA256_PATTERN.test(String(rawInfo.contentHash)))
      || !isNonNegativeInteger(rawInfo.byteSize) || !isNonNegativeInteger(rawInfo.mtimeMs)
      || (rawInfo.revision !== undefined && !isNonNegativeInteger(rawInfo.revision))
      || (rawInfo.isDeleted !== undefined && typeof rawInfo.isDeleted !== "boolean")) return false;
  }
  if (value.conflicts !== undefined) {
    if (!isRecord(value.conflicts)) return false;
    for (const [rawPath, rawConflict] of Object.entries(value.conflicts)) {
      if (!normalizeVaultPath(rawPath) || !isRecord(rawConflict)
        || !normalizeVaultPath(rawConflict.originalPath as string)
        || typeof rawConflict.createdAt !== "string"
        || (rawConflict.localHash !== null && !SHA256_PATTERN.test(String(rawConflict.localHash)))
        || (rawConflict.remoteHash !== null && !SHA256_PATTERN.test(String(rawConflict.remoteHash)))
        || !["pending", "resolved"].includes(String(rawConflict.status))) return false;
    }
  }
  return true;
}

export function createPrevSyncStore(app: App): PrevSyncStore {
  return {
    async load() {
      const exists = await app.vault.adapter.exists(STATE_PATH);
      if (!exists) return null;
      try {
        const raw = await app.vault.adapter.read(STATE_PATH);
        const parsed = JSON.parse(raw);
        if (!isValidPrevSyncState(parsed)) return null;
        return parsed as PrevSyncState;
      } catch {
        return null;
      }
    },
    async save(state) {
      // 确保 .wetongbu/ 目录存在。
      if (!(await app.vault.adapter.exists(".wetongbu"))) {
        await app.vault.adapter.mkdir(".wetongbu");
      }
      // Obsidian may be interrupted while the adapter is writing.  Write and
      // verify a same-directory temporary file, then rename it over the state
      // file so a restart sees either the old complete JSON or the new one.
      const temporary = `${STATE_PATH}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      await app.vault.adapter.write(temporary, serialized);
      if ((await app.vault.adapter.read(temporary)) !== serialized) {
        await app.vault.adapter.remove(temporary).catch(() => {});
        throw new Error("Vault 同步状态写入校验失败");
      }
      const adapter = app.vault.adapter as any;
      if (typeof adapter.rename === "function") {
        await adapter.rename(temporary, STATE_PATH);
      } else {
        // Some older adapters lack rename. This fallback cannot be atomic, so
        // preserve the previous JSON and verify the replacement before
        // removing the temporary file; a torn write is never accepted.
        const hadPrevious = typeof adapter.exists === "function" && await adapter.exists(STATE_PATH);
        const previous = hadPrevious ? await adapter.read(STATE_PATH) : null;
        await adapter.write(STATE_PATH, serialized);
        let valid = false;
        try {
          valid = (await adapter.read(STATE_PATH)) === serialized;
        } catch { /* handled below */ }
        if (!valid) {
          if (hadPrevious) await adapter.write(STATE_PATH, previous);
          else if (typeof adapter.remove === "function") await adapter.remove(STATE_PATH).catch(() => {});
          throw new Error("Vault 同步状态替换校验失败");
        }
        if (typeof adapter.remove === "function") await adapter.remove(temporary).catch(() => {});
      }
    },
    async clear() {
      const exists = await app.vault.adapter.exists(STATE_PATH);
      if (exists) await app.vault.adapter.remove(STATE_PATH);
    },
  };
}

/** 把 PrevSyncState 转成 diff 用的 Map。 */
export function prevSyncAsMap(state: PrevSyncState | null): Map<string, FileEntity> {
  const map = new Map();
  if (!state) return map;
  for (const [p, info] of Object.entries(state.files)) {
    const normalized = normalizeVaultPath(p);
    if (!normalized) continue;
    map.set(normalized, {
      path: normalized,
      contentHash: info.contentHash,
      byteSize: info.byteSize,
      mtimeMs: info.mtimeMs,
      revision: info.revision,
      isDeleted: info.isDeleted,
    });
  }
  return map;
}

/** 为下次同步写出新的 prevSync：用当前已知的文件状态更新。 */
export function advancePrevSync(
  prev: PrevSyncState | null,
  deviceId: string,
  updates: Iterable<{ path: string; contentHash: string | null; byteSize: number; mtimeMs: number; revision?: number; isDeleted?: boolean }>,
  cursor: number,
  conflictUpdates: Iterable<{ path: string; originalPath: string; createdAt: string; localHash: string | null; remoteHash: string | null }> = [],
): PrevSyncState {
  const files = prev ? { ...prev.files } : {};
  const conflicts = { ...(prev?.conflicts ?? {}) };
  for (const u of updates) {
    const n = normalizeVaultPath(u.path);
    if (!n) continue;
    files[n] = {
      contentHash: u.contentHash,
      byteSize: u.byteSize,
      mtimeMs: u.mtimeMs,
      revision: u.revision,
      isDeleted: u.isDeleted,
    };
  }
  for (const conflict of conflictUpdates) {
    const n = normalizeVaultPath(conflict.path);
    const originalPath = normalizeVaultPath(conflict.originalPath);
    if (!n || !originalPath) continue;
    conflicts[n] = {
      originalPath,
      createdAt: conflict.createdAt,
      localHash: conflict.localHash,
      remoteHash: conflict.remoteHash,
      status: "pending",
    };
  }
  return {
    version: 1,
    deviceId,
    lastCursor: cursor,
    lastSyncAt: new Date().toISOString(),
    files,
    ...(Object.keys(conflicts).length > 0 ? { conflicts } : {}),
  };
}

// 对外暴露 VAULT_SYNC_SKIP_PREFIXES 便于 UI 显示说明。
export { VAULT_SYNC_SKIP_PREFIXES };
