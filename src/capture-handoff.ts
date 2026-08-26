import type { App } from "obsidian";

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
  return {
    async list(): Promise<CaptureHandoff[]> {
      if (!(await adapter.exists(HANDOFF_DIR))) return [];
      const listed = await adapter.list(HANDOFF_DIR);
      const records: CaptureHandoff[] = [];
      for (const file of listed.files.filter((path) => path.endsWith(".json"))) {
        const value = parse(await adapter.read(file));
        if (value) records.push(value);
      }
      return records;
    },
    async get(taskId: string): Promise<CaptureHandoff | null> {
      const path = handoffPath(taskId);
      if (!(await adapter.exists(path))) return null;
      return parse(await adapter.read(path));
    },
    async save(value: CaptureHandoff): Promise<void> {
      assertValidCaptureHandoff(value);
      if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
      if (!(await adapter.exists(HANDOFF_DIR))) await adapter.mkdir(HANDOFF_DIR);
      const path = handoffPath(value.taskId);
      const temporary = `${path}.tmp`;
      const body = `${JSON.stringify(value, null, 2)}\n`;
      await adapter.write(temporary, body);
      if ((await adapter.read(temporary)) !== body) throw new Error("剪藏交接记录写入校验失败");
      if (await adapter.exists(path)) await adapter.remove(path);
      await adapter.rename(temporary, path);
    },
    async remove(taskId: string): Promise<void> {
      const path = handoffPath(taskId);
      if (await adapter.exists(path)) await adapter.remove(path);
    },
  };
}

export type CaptureHandoffStore = ReturnType<typeof createCaptureHandoffStore>;
