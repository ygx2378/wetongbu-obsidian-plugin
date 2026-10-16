export interface DeletionReviewNoticeEntry {
  path: string;
  direction?: string;
  fileId?: string;
  expectedVersionId?: string;
  previousRevision?: number;
  remoteRevision?: number;
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

/** Prevent an already-open confirmation from acting on a changed sync identity. */
export function assertPendingDeletionReviewContextCurrent(
  expected: Pick<PendingDeletionReviewContext, "targetKey" | "scope" | "rootFolder">,
  current: PendingDeletionReviewContext,
): void {
  if (!current.lifecycleActive || !current.vaultSyncEnabled || !current.accountLoggedIn
    || current.targetKey !== expected.targetKey
    || current.scope !== expected.scope
    || current.rootFolder !== expected.rootFolder) {
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
export function removeCommittedDeletionReviewEntry<T extends { path: string }>(
  entries: readonly T[],
  committedPath: string,
): T[] {
  return entries.filter((entry) => entry.path !== committedPath);
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
