export type VaultSyncDeleteMode = "automatic" | "review";

export const MAX_AUTOMATIC_DELETE_BATCH = 10;

export function canAutomaticallyPropagateDeletes(input: {
  mode: VaultSyncDeleteMode;
  safetyEnabled: boolean;
  safetyRatio: number;
  pendingDeleteCount: number;
  trackedLiveFileCount: number;
}): boolean {
  const { mode, safetyEnabled, safetyRatio, pendingDeleteCount, trackedLiveFileCount } = input;
  if (mode !== "automatic" || !Number.isSafeInteger(pendingDeleteCount) || pendingDeleteCount < 1
    || !Number.isSafeInteger(trackedLiveFileCount) || trackedLiveFileCount < 0) return false;
  if (!safetyEnabled) return true;
  if (!Number.isFinite(safetyRatio) || safetyRatio < 0 || safetyRatio > 1
    || pendingDeleteCount > MAX_AUTOMATIC_DELETE_BATCH) return false;
  return pendingDeleteCount / Math.max(trackedLiveFileCount, 1) <= safetyRatio;
}
