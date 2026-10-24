import type { FileEntity } from "./vault-sync-diff.ts";
import type { LocalIndex } from "./vault-sync-local.ts";
import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";

export const VAULT_SYNC_EMPTY_NOTE_GRACE_MS = 30_000;

type VaultSyncTimerHandle = ReturnType<typeof globalThis.setTimeout> | number;

export interface VaultSyncEmptyNoteGraceTimers {
  setTimeout(callback: () => void, delayMs: number): VaultSyncTimerHandle;
  clearTimeout(handle: VaultSyncTimerHandle): void;
}

/** Delay syncing a brand-new blank note while Obsidian may still assign its final path. */
export function createVaultSyncEmptyNoteGrace(options: {
  onReady: (path: string) => void;
  onPendingChange?: (pending: Record<string, number>) => void;
  delayMs?: number;
  timers?: VaultSyncEmptyNoteGraceTimers;
  now?: () => number;
}) {
  const timers = options.timers ?? globalThis;
  const delayMs = options.delayMs ?? VAULT_SYNC_EMPTY_NOTE_GRACE_MS;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new TypeError("delayMs must be a non-negative safe integer");
  const pending = new Map<string, { expiresAt: number; handle: VaultSyncTimerHandle }>();

  function snapshot(): Record<string, number> {
    return Object.fromEntries([...pending].map(([path, entry]) => [path, entry.expiresAt]));
  }

  function publish() { options.onPendingChange?.(snapshot()); }

  function schedule(path: string, expiresAt: number) {
    const handle = timers.setTimeout(() => {
      if (!pending.has(path)) return;
      pending.delete(path);
      publish();
      options.onReady(path);
    }, Math.max(0, expiresAt - now()));
    pending.set(path, { expiresAt, handle });
  }

  function cancel(path: string): boolean {
    const entry = pending.get(path);
    if (!entry) return false;
    timers.clearTimeout(entry.handle);
    pending.delete(path);
    publish();
    return true;
  }

  return {
    defer(path: string, waitMs = delayMs): boolean {
      if (!path || pending.has(path)) return false;
      if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new TypeError("waitMs must be a non-negative safe integer");
      schedule(path, now() + waitMs);
      publish();
      return true;
    },
    cancel,
    has(path: string): boolean { return pending.has(path); },
    paths(): string[] { return [...pending.keys()]; },
    snapshot,
    restore(saved: unknown): void {
      if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return;
      for (const [path, rawExpiresAt] of Object.entries(saved)) {
        const expiresAt = Number(rawExpiresAt);
        if (normalizeVaultPath(path) !== path || !path.toLowerCase().endsWith(".md")
          || !Number.isSafeInteger(expiresAt)) continue;
        if (expiresAt <= now()) options.onReady(path);
        else if (!pending.has(path)) schedule(path, expiresAt);
      }
      publish();
    },
    stop(): void {
      for (const entry of pending.values()) timers.clearTimeout(entry.handle);
      pending.clear();
    },
  };
}

/** Keep only new, pending, zero-byte notes out of this sync pass. Tracked paths always remain visible. */
export function excludeDeferredEmptyNotes(
  localIndex: LocalIndex,
  pendingPaths: Iterable<string>,
  knownPaths: Iterable<string>,
): LocalIndex {
  const pendingKeys = new Set([...pendingPaths].map((path) => portableVaultPathKey(path)).filter(Boolean));
  if (!pendingKeys.size) return localIndex;
  const knownKeys = new Set([...knownPaths].map((path) => portableVaultPathKey(path)).filter(Boolean));
  const filtered = new Map<string, FileEntity>();
  for (const [path, entity] of localIndex) {
    const key = portableVaultPathKey(path);
    if (entity.byteSize === 0 && key && pendingKeys.has(key) && !knownKeys.has(key)) continue;
    filtered.set(path, entity);
  }
  return filtered;
}
