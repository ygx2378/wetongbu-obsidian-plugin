import type { App } from "obsidian";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";

const HANDOFF_DIR = ".wetongbu/capture-handoffs";
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CaptureHandoffFile {
  path: string;
  contentHash: string;
  byteSize: number;
}

export interface CaptureHandoff {
  version: 1;
  taskId: string;
  notePath: string;
  files: CaptureHandoffFile[];
  requiresVaultSync: boolean;
  createdAt: string;
}

export interface CaptureHandoffRemoteFile {
  contentHash: string | null;
  byteSize: number;
  revision?: number;
  isDeleted?: boolean;
}

/** Rebuild the full local dependency set when a capture task is replayed after a restart. */
export async function captureHandoffFilesForExistingTask(
  notePath: string,
  attachmentPaths: string[],
  readCurrent: (path: string) => Promise<Uint8Array | null>,
): Promise<CaptureHandoffFile[]> {
  const paths = [notePath, ...attachmentPaths];
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!isSafeVaultPath(path) || normalizeVaultPath(path) !== path) {
      throw Object.assign(new Error("剪藏交接路径无效；服务器任务保持未确认"), { code: "capture_handoff_path_invalid" });
    }
    if (seen.has(path)) continue;
    seen.add(path);
    uniquePaths.push(path);
  }
  if (!uniquePaths.length || uniquePaths[0] !== notePath) {
    throw Object.assign(new Error("剪藏交接缺少本地笔记路径；服务器任务保持未确认"), { code: "capture_handoff_note_missing" });
  }

  const files: CaptureHandoffFile[] = [];
  for (const path of uniquePaths) {
    const current = await readCurrent(path);
    if (!(current instanceof Uint8Array)) {
      throw Object.assign(new Error("剪藏本地文件尚未恢复；服务器任务保持未确认"), {
        code: "capture_handoff_file_missing",
      });
    }
    files.push({ path, contentHash: await sha256Hex(current), byteSize: current.byteLength });
  }
  return files;
}

export function captureHandoffStatusSummary(
  handoffs: CaptureHandoff[],
  syncEnabled: boolean,
  intervalMinutes: number | null,
): string {
  const pending = handoffs.filter((handoff) => handoff.requiresVaultSync);
  if (pending.length === 0) return "没有等待云端确认的剪藏内容。";
  if (!syncEnabled) {
    return `${pending.length} 条剪藏等待 Vault 同步确认；内容已保存在本机，当前多端同步已暂停。`;
  }
  if (intervalMinutes === null) {
    return `${pending.length} 条剪藏等待云端确认；内容已保存在本机，点击“立即同步”继续。`;
  }
  return `${pending.length} 条剪藏等待云端确认；内容已保存在本机，将随自动同步继续处理。`;
}

/**
 * A capture handoff is satisfied when every current file at its path has a
 * committed remote version. This also accepts a user-edited successor; the
 * original capture hash remains evidence, not a permanent upload prerequisite.
 */
export async function captureHandoffFilesHaveCommittedSuccessors(
  handoff: CaptureHandoff,
  remoteFiles: Record<string, CaptureHandoffRemoteFile>,
  readCurrent: (path: string) => Promise<{ contentHash: string; byteSize: number } | null>,
  resolveCurrentPath?: (record: CaptureHandoffFile, handoff: CaptureHandoff) => Promise<string | null>,
): Promise<boolean> {
  if (!handoff.notePath || !handoff.files.length || !handoff.files.some((file) => file.path === handoff.notePath)) return false;
  for (const record of handoff.files) {
    const path = resolveCurrentPath ? await resolveCurrentPath(record, handoff) : record.path;
    if (!path) return false;
    const remote = remoteFiles[path];
    if (!remote || remote.isDeleted === true || !Number.isFinite(remote.revision) || Number(remote.revision) <= 0) return false;
    const current = await readCurrent(path);
    if (!current || remote.contentHash !== current.contentHash || remote.byteSize !== current.byteSize) return false;
  }
  return true;
}

function handoffPath(taskId: string) {
  if (!TASK_ID.test(taskId)) throw new Error("invalid capture task id");
  return `${HANDOFF_DIR}/${taskId}.json`;
}

function isSafeVaultPath(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("/")) return false;
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function assertValidCaptureHandoff(value: unknown): asserts value is CaptureHandoff {
  if (!value || typeof value !== "object") throw new Error("剪藏交接记录无效");
  const record = value as Partial<CaptureHandoff>;
  if (record.version !== 1 || !TASK_ID.test(String(record.taskId ?? ""))) throw new Error("剪藏交接记录任务标识无效");
  if (!isSafeVaultPath(record.notePath)) throw new Error("剪藏交接记录笔记路径无效");
  if (!Array.isArray(record.files) || record.files.length === 0) throw new Error("剪藏交接记录缺少文件证据");
  if (typeof record.requiresVaultSync !== "boolean" || !record.createdAt || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("剪藏交接记录元数据无效");
  }
  if (!record.files.some((file) => file?.path === record.notePath)) throw new Error("剪藏交接记录缺少笔记文件证据");
  for (const file of record.files) {
    if (!isSafeVaultPath(file?.path)
      || !/^[a-f0-9]{64}$/i.test(String(file?.contentHash ?? ""))
      || !Number.isSafeInteger(file?.byteSize)
      || Number(file.byteSize) < 0) {
      throw new Error("剪藏交接记录文件证据无效");
    }
  }
}

function parse(raw: string): CaptureHandoff | null {
  try {
    const value = JSON.parse(raw);
    assertValidCaptureHandoff(value);
    return value;
  } catch {
    return null;
  }
}

export function createCaptureHandoffStore(app: App) {
  const adapter = app.vault.adapter;
  async function readValid(path: string, expectedPath: string): Promise<CaptureHandoff | null> {
    if (!(await adapter.exists(path))) return null;
    let raw: string;
    try { raw = await adapter.read(path); } catch { return null; }
    const value = parse(raw);
    return value && handoffPath(value.taskId) === expectedPath ? value : null;
  }

  async function readStored(path: string): Promise<CaptureHandoff | null> {
    return await readValid(path, path) ?? await readValid(`${path}.bak`, path);
  }

  return {
    async list(): Promise<CaptureHandoff[]> {
      if (!(await adapter.exists(HANDOFF_DIR))) return [];
      const listed = await adapter.list(HANDOFF_DIR);
      const candidates = listed.files
        .filter((path) => path.endsWith(".json") || path.endsWith(".json.bak"))
        .sort((left, right) => Number(left.endsWith(".bak")) - Number(right.endsWith(".bak")));
      const records = new Map<string, CaptureHandoff>();
      for (const file of candidates) {
        const expectedPath = file.endsWith(".bak") ? file.slice(0, -4) : file;
        const value = await readValid(file, expectedPath);
        if (value && !records.has(value.taskId)) records.set(value.taskId, value);
      }
      return [...records.values()];
    },
    async get(taskId: string): Promise<CaptureHandoff | null> {
      const path = handoffPath(taskId);
      return readStored(path);
    },
    async save(value: CaptureHandoff): Promise<void> {
      assertValidCaptureHandoff(value);
      if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
      if (!(await adapter.exists(HANDOFF_DIR))) await adapter.mkdir(HANDOFF_DIR);
      const path = handoffPath(value.taskId);
      const temporary = `${path}.tmp`;
      const backup = `${path}.bak`;
      const body = `${JSON.stringify(value, null, 2)}\n`;
      await adapter.write(temporary, body);
      if ((await adapter.read(temporary)) !== body) throw new Error("剪藏交接记录写入校验失败");

      const current = await readValid(path, path);
      const previous = await readValid(backup, path);
      if (current) {
        // A valid primary means a prior replacement committed; any backup is
        // stale. Remove it before rotating the primary so there is always one
        // recoverable copy if the next rename is interrupted.
        if (await adapter.exists(backup)) await adapter.remove(backup);
        await adapter.rename(path, backup);
      } else {
        if (await adapter.exists(path)) await adapter.remove(path);
        if (!previous && await adapter.exists(backup)) await adapter.remove(backup);
      }

      await adapter.rename(temporary, path);
      if ((await adapter.read(path)) !== body || !(await readValid(path, path))) {
        throw new Error("剪藏交接记录替换校验失败");
      }
      if (await adapter.exists(backup)) await adapter.remove(backup).catch(() => {});
    },
    async remove(taskId: string): Promise<void> {
      const path = handoffPath(taskId);
      // Remove the fallback copy first. If that fails, the primary remains
      // present and the handoff cannot disappear and later reappear from .bak.
      for (const candidate of [`${path}.bak`, `${path}.tmp`, path]) {
        if (await adapter.exists(candidate)) await adapter.remove(candidate);
      }
    },
  };
}

export type CaptureHandoffStore = ReturnType<typeof createCaptureHandoffStore>;
