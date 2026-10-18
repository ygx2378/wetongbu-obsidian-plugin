import type { App } from "obsidian";
import { isVaultPathOpenInMarkdownEditor } from "./vault-sync-write-safety.ts";
import { isVaultSyncActiveEditorBusyError } from "./vault-sync-retry.ts";

const EDITOR_BUSY_CONFLICT_NOTICE = "检测到目标笔记仍在可编辑视图中，操作已暂停。请关闭该笔记，再重新打开冲突中心，刷新并核对最新三方内容。";

/** Preserve a user's explicit conflict choice for review after an open editor is closed. */
export function dismissConflictActionForActiveEditorBusy(
  error: unknown,
  options: {
    close: () => void;
    notify: (message: string, durationMs: number) => void;
    afterClose?: () => void;
  },
): boolean {
  if (!isVaultSyncActiveEditorBusyError(error)) return false;
  options.notify(EDITOR_BUSY_CONFLICT_NOTICE, 10_000);
  options.close();
  options.afterClose?.();
  return true;
}

/** Do not spin the scheduler while a deferred remote note is still editable. */
export function shouldSchedulePendingVaultSyncRetry(
  app: App,
  pending: boolean,
  deferredPaths: readonly string[],
): boolean {
  if (!pending) return false;
  return deferredPaths.length === 0
    || deferredPaths.some((path) => !isVaultPathOpenInMarkdownEditor(app, path));
}

/** Wake a deferred sync when its target becomes safe after a workspace change. */
export function registerVaultSyncEditorRetryEvents(
  app: App,
  getDeferredPaths: () => readonly string[],
  requestAutomaticSync: () => void,
) {
  const workspace: any = (app as any).workspace;
  if (typeof workspace?.on !== "function") return [];

  const retryAfterEditorLayoutChange = () => {
    const paths = getDeferredPaths();
    if (!paths.length || paths.every((path) => isVaultPathOpenInMarkdownEditor(app, path))) return;
    requestAutomaticSync();
  };

  return [
    workspace.on("active-leaf-change", retryAfterEditorLayoutChange),
    workspace.on("layout-change", retryAfterEditorLayoutChange),
  ];
}
