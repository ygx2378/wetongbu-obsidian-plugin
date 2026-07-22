// Vault 多端同步：本地扫描 + prevSync 持久化。
// 提供 scanLocalFiles（遍历 vault、计算 hash）和 PrevSyncStore（读写状态 JSON）。
// 依赖 Obsidian Vault API，但通过接口注入便于测试。

import type { App, TFile } from "obsidian";
import { normalizeVaultPath, VAULT_SYNC_SKIP_PREFIXES } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { FileEntity } from "./vault-sync-diff.ts";

/** 扫描结果：path → FileEntity。 */
export type LocalIndex = Map<string, FileEntity>;

export interface ScanResult {
  index: LocalIndex;
  unreadablePaths: string[];
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
  const files = app.vault.getFiles();
  const candidates = files.filter((f) => shouldSyncPath(f.path, rootFolder));
  const total = candidates.length;
  let scanned = 0;
  for (const file of candidates) {
    try {
      const body = await app.vault.readBinary(file);
      const hash = await sha256Hex(new Uint8Array(body));
      index.set(normalizeVaultPath(file.path)!, {
        path: normalizeVaultPath(file.path)!,
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
  return { index, unreadablePaths };
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
}

/** prevSync 存储抽象：默认实现写 .wetongbu/vault-sync-state.json。 */
export interface PrevSyncStore {
  load(): Promise<PrevSyncState | null>;
  save(state: PrevSyncState): Promise<void>;
  clear(): Promise<void>;
}

const STATE_PATH = ".wetongbu/vault-sync-state.json";

export function createPrevSyncStore(app: App): PrevSyncStore {
  return {
    async load() {
      const exists = await app.vault.adapter.exists(STATE_PATH);
      if (!exists) return null;
      try {
        const raw = await app.vault.adapter.read(STATE_PATH);
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || typeof parsed.files !== "object") return null;
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
      await app.vault.adapter.write(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
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
): PrevSyncState {
  const files = prev ? { ...prev.files } : {};
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
  return {
    version: 1,
    deviceId,
    lastCursor: cursor,
    lastSyncAt: new Date().toISOString(),
    files,
  };
}

// 对外暴露 VAULT_SYNC_SKIP_PREFIXES 便于 UI 显示说明。
export { VAULT_SYNC_SKIP_PREFIXES };
