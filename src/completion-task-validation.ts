const TRACKING_QUERY_KEYS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "ref_src"]);

export function normalizeCompletionSourceUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (TRACKING_QUERY_KEYS.has(lower) || lower.startsWith("utm_")) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

export interface ServerCompletionTaskIdentity {
  task_id: string;
  title: string;
  source_url: string;
  operation?: string | null;
  capture_id?: string | null;
}

export interface PackageCompletionTaskIdentity {
  taskId: string;
  title: string;
  sourceUrl: string;
  operation?: string | null;
  captureId?: string | null;
  userId?: string | null;
  targetId?: string | null;
}

export function assertCompletionTaskIdentity(
  serverTask: ServerCompletionTaskIdentity,
  packageTask: PackageCompletionTaskIdentity,
  expectedScope: { userId: string; targetId: string },
) {
  if (packageTask.taskId !== serverTask.task_id) throw new Error("manifest task_id 与服务器任务不一致");
  if (packageTask.userId !== expectedScope.userId || packageTask.targetId !== expectedScope.targetId) {
    throw new Error("任务包身份与当前 Vault 不一致");
  }
  if (packageTask.title !== serverTask.title) throw new Error("任务包标题与服务器任务不一致");
  if (normalizeCompletionSourceUrl(packageTask.sourceUrl) !== normalizeCompletionSourceUrl(serverTask.source_url)) {
    throw new Error("任务包原文链接与服务器任务不一致");
  }
  const serverOperation = serverTask.operation ?? "create_new";
  const packageOperation = packageTask.operation ?? "create_new";
  if (packageOperation !== serverOperation) throw new Error("任务包操作类型与服务器任务不一致");
  if (packageOperation === "complete_capture" && packageTask.captureId !== (serverTask.capture_id ?? null)) {
    throw new Error("任务包 capture_id 与服务器任务不一致");
  }
  if (packageOperation !== "complete_capture" && packageTask.captureId) {
    throw new Error("新建任务不应携带 capture_id");
  }
}
