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

function parse(raw: string): CaptureHandoff | null {
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !TASK_ID.test(value.taskId)
      || typeof value.notePath !== "string" || !Array.isArray(value.files)) return null;
    return value as CaptureHandoff;
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
