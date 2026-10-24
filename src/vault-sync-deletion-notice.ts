import { isValidVaultSyncInt8Decimal } from "./shared/vault-sync-protocol.mjs";

export interface DeletionReviewNoticeEntry {
  path: string;
  direction?: string;
  fileId?: string;
  expectedVersionId?: string;
  previousRevision?: number;
  remoteRevision?: number;
}

/** Describe the sync-state difference without attributing it to an explicit user action. */
export function describeDeletionReviewDirection(direction: string | undefined): string {
  if (direction === "local_to_remote") return "本机当前未找到此文件，云端和其他设备仍保留。";
  if (direction === "remote_to_local") return "本机仍保留此文件，云端和其他设备当前没有。";
  return "本机与云端的文件状态不同，需逐项确认。";
}

/** Describe a missing local path in a delete-conflict preview without implying who removed it. */
export function formatMissingLocalDeletionConflict(): string {
  return "（本机当前找不到此文件；请检查云端当前版本后再决定是否确认删除）";
}

/** Keep the reminder accurate for both local and remote deletion-review entries. */
export function formatPendingDeletionReviewNotice(count: number): string {
  const safeCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
  return `有 ${safeCount} 项跨设备删除待确认。逐项处理后，才会执行删除或恢复。`;
}

/** Describe the local path state without implying a person deleted the note. */
export function formatLocalDeletionReminder(paths: readonly string[], mode: "automatic" | "review"): string {
  const safePaths = paths.filter((value) => typeof value === "string" && value.trim());
  const shownPaths = safePaths.slice(0, 3).join("、");
  const omitted = safePaths.length > 3 ? " 等" : "";
  const pathSummary = safePaths.length === 1
    ? `本机当前找不到此笔记路径：${shownPaths}。`
    : `本机当前找不到 ${safePaths.length} 个笔记路径：${shownPaths}${omitted}。`;
  const nextStep = mode === "review"
    ? "同步检查后，若云端仍有版本，会逐项显示供你确认；确认前不会提交云端删除。"
    : "微同步会按自动删除策略检查；如触发批量保护，会要求人工确认。";
  return `${pathSummary}${nextStep}`;
}

export interface DeletionReviewNoticeTransition {
  key: string;
  shouldNotify: boolean;
  count: number;
}

export interface PendingDeletionReviewContext {
  targetKey: string;
  scope: "whole_vault" | "root_folder";
  rootFolder: string;
  vaultSyncEnabled: boolean;
  accountLoggedIn: boolean;
  lifecycleActive: boolean;
}

function isPendingDeletionReviewContextCurrent(
  expected: Pick<PendingDeletionReviewContext, "targetKey" | "scope" | "rootFolder">,
  current: PendingDeletionReviewContext,
): boolean {
  return current.lifecycleActive && current.vaultSyncEnabled && current.accountLoggedIn
    && current.targetKey === expected.targetKey
    && current.scope === expected.scope
    && current.rootFolder === expected.rootFolder;
}

/** Prevent an already-open confirmation from acting on a changed sync identity. */
export function assertPendingDeletionReviewContextCurrent(
  expected: Pick<PendingDeletionReviewContext, "targetKey" | "scope" | "rootFolder">,
  current: PendingDeletionReviewContext,
): void {
  if (!isPendingDeletionReviewContextCurrent(expected, current)) {
    throw Object.assign(new Error("账号、同步目标或同步范围已变化；请重新检查待确认删除"), {
      code: "delete_review_stale",
    });
  }
}

/** Check the review identity at the same boundary that starts the cloud delete. */
export function commitPendingDeletionReviewIfCurrent<T>(
  expected: Pick<PendingDeletionReviewContext, "targetKey" | "scope" | "rootFolder">,
  current: PendingDeletionReviewContext,
  commit: () => T,
): T {
  assertPendingDeletionReviewContextCurrent(expected, current);
  return commit();
}

/** Serialize confirmations for one file without occupying the Vault object-work queue. */
export class DeletionReviewConfirmationLane {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, confirm: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    return previous.catch(() => {}).then(confirm).finally(() => {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    });
  }
}

/** Ignore async confirmation results after the review modal has closed. */
export class DeletionReviewModalLifetime {
  private active = true;

  close(): void {
    this.active = false;
  }

  async settle<T>(
    operation: () => Promise<T>,
    onSuccess: (value: T) => void,
    onError: (error: unknown) => void,
  ): Promise<void> {
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      if (this.active) onError(error);
      return;
    }
    if (this.active) onSuccess(value);
  }
}

export interface PendingV2DeletionReviewItem {
  path: string;
  fileId: string;
  expectedVersionId: string;
}

export interface PendingV2DeletionReviewOutcome {
  status: string;
  failureCode?: string;
  supersededOperationCount?: number;
  /** Cloud change cursor assigned to the committed tombstone. */
  changeCursor?: string;
}

export interface PendingV2DeletionReviewHandlerOptions<TItem extends PendingV2DeletionReviewItem> {
  targetId: string;
  expectedContext: Pick<PendingDeletionReviewContext, "targetKey" | "scope" | "rootFolder">;
  getCurrentContext(): PendingDeletionReviewContext;
  lane: DeletionReviewConfirmationLane;
  commit(item: TItem, assertContextCurrent: () => void): Promise<PendingV2DeletionReviewOutcome>;
  getPendingItems(): readonly TItem[];
  setPendingItems(items: TItem[]): void;
  showNotice(message: string, timeoutMs?: number): void;
  runSync(): Promise<unknown>;
  notifyPendingItems(items: readonly TItem[]): void;
}

/** The production V2 deletion-review callback, isolated for direct push-engine coverage. */
export function createPendingV2DeletionReviewHandler<TItem extends PendingV2DeletionReviewItem>(
  options: PendingV2DeletionReviewHandlerOptions<TItem>,
): (item: TItem) => Promise<TItem[]> {
  return async (item) => {
    const assertReviewContextCurrent = () => {
      assertPendingDeletionReviewContextCurrent(options.expectedContext, options.getCurrentContext());
    };
    const outcome = await options.lane.run(
      `${options.targetId}:${item.fileId}`,
      () => options.commit(item, assertReviewContextCurrent),
    );
    const currentContext = options.getCurrentContext();
    // Unload hides notices immediately, but an outstanding request can still
    // settle afterward. Do not resurrect UI or scheduling from the old plugin.
    if (!currentContext.lifecycleActive) return [...options.getPendingItems()];
    // A confirmed request may finish while the user switches targets. Its
    // push engine can persist the old target's baseline, but it must not
    // mutate or announce the new target's in-memory review queue.
    if (outcome.status === "committed"
      && !isPendingDeletionReviewContextCurrent(options.expectedContext, currentContext)) {
      return [...options.getPendingItems()];
    }
    if (outcome.status === "committed") {
      const cursorSuffix = outcome.changeCursor && isValidVaultSyncInt8Decimal(outcome.changeCursor, { allowZero: false })
        ? `；云端变更游标 ${outcome.changeCursor}`
        : "";
      const message = outcome.supersededOperationCount
        ? `已确认同步删除 ${item.path}，并取消 ${outcome.supersededOperationCount} 条已被删除取代的本机待办${cursorSuffix}。`
        : `已确认同步删除 ${item.path}${cursorSuffix}`;
      options.showNotice(message, cursorSuffix ? 8000 : undefined);
      options.setPendingItems(removeCommittedDeletionReviewEntry(options.getPendingItems(), item));
    } else if (outcome.status === "conflict") {
      options.showNotice(`云端在确认期间发生变化；删除待办已保留，请到冲突中心重新检查 ${item.path}`, 10000);
      await options.runSync();
    } else {
      options.showNotice(`删除尚未提交；待办仍保留（${outcome.failureCode ?? outcome.status}）`, 10000);
    }
    const pendingItems = [...options.getPendingItems()];
    options.notifyPendingItems(pendingItems);
    return pendingItems;
  };
}

/** V2 review queues have no automatic modal, so always surface their action notice. */
export function shouldShowDeletionReviewNotice(protocol: "v1" | "v2", quiet: boolean): boolean {
  return protocol === "v2" || quiet;
}

/** Refresh once when the queue is not loaded yet, then open any newly found review. */
export async function refreshAndOpenPendingDeletionReview<T>(
  refresh: () => Promise<void>,
  getPendingItems: () => readonly T[],
  openReview: (items: readonly T[]) => void,
): Promise<void> {
  await refresh();
  const items = getPendingItems();
  if (items.length > 0) openReview(items);
}

/** Coalesce repeated review actions while their sync-and-open refresh is in flight. */
export class PendingDeletionReviewOpener {
  private inFlight: Promise<void> | null = null;

  get isOpening(): boolean {
    return this.inFlight !== null;
  }

  open<T>(
    refresh: () => Promise<void>,
    getPendingItems: () => readonly T[],
    openReview: (items: readonly T[]) => void,
  ): Promise<void> {
    if (this.inFlight) return this.inFlight;

    let operation: Promise<void>;
    operation = Promise.resolve()
      .then(() => refreshAndOpenPendingDeletionReview(refresh, getPendingItems, openReview))
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = null;
      });
    this.inFlight = operation;
    return operation;
  }
}

/** Keep the current review open after one item is committed. */
export function removeCommittedDeletionReviewEntry<T extends { path: string; fileId: string; expectedVersionId: string }>(
  entries: readonly T[],
  committedItem: Pick<T, "path" | "fileId" | "expectedVersionId">,
): T[] {
  return entries.filter((entry) => entry.path !== committedItem.path
    || entry.fileId !== committedItem.fileId
    || entry.expectedVersionId !== committedItem.expectedVersionId);
}

/** The review modal should only close after the pending queue is empty. */
export function shouldCloseDeletionReviewModal<T>(pendingItems: readonly T[]): boolean {
  return pendingItems.length === 0;
}

/** A review item that has already moved into conflict state must leave the deletion modal. */
export function shouldDismissDeletionReviewOnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "delete_review_operation_conflict"
    || code === "delete_review_operation_stale"
    || code === "delete_review_stale";
}

/** Only announce an empty review after a new, completed sync actually checked it. */
export function shouldNotifyEmptyDeletionReview<T extends { outcome: string }>(
  previousRun: T | null,
  latestRun: T | null,
  pendingCount: number,
): boolean {
  return latestRun !== null && latestRun !== previousRun
    && latestRun.outcome === "complete" && pendingCount === 0;
}

/** Keep each pending set deduplicated while visible, and repeat after dismissal. */
export function nextDeletionReviewNotice(
  previousKey: string,
  entries: readonly DeletionReviewNoticeEntry[],
  shouldNotify: boolean,
  noticeVisible = false,
  reviewActionVisible = false,
  suppressedKey = "",
): DeletionReviewNoticeTransition {
  if (entries.length === 0) return { key: "", shouldNotify: false, count: 0 };
  const identities = entries.map((entry) => [
    entry.path,
    entry.direction ?? "",
    entry.fileId ?? "",
    entry.expectedVersionId ?? "",
    entry.previousRevision ?? null,
    entry.remoteRevision ?? null,
  ] as const).sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const key = JSON.stringify(identities);
  return {
    key,
    shouldNotify: shouldNotify && !reviewActionVisible && key !== suppressedKey
      && (key !== previousKey || !noticeVisible),
    count: entries.length,
  };
}

/** Suppress a second review toast only when the local reminder already covers the complete pending queue. */
export function localDeletionReminderSuppressionKey(
  entries: readonly DeletionReviewNoticeEntry[],
  localDeletionPaths: ReadonlySet<string>,
): string {
  if (entries.length === 0 || !entries.every((entry) => localDeletionPaths.has(entry.path))) return "";
  return nextDeletionReviewNotice("", entries, false).key;
}
