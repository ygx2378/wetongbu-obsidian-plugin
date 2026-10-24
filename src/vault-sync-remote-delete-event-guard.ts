/** Keeps Obsidian delete events emitted by remote Trash application out of the local-delete review flow. */
export function createVaultSyncRemoteDeleteEventGuard() {
  const pending = new Map<string, number>();

  return {
    shouldNotifyLocalDelete(path: string): boolean {
      return !pending.has(path);
    },

    async trash<T>(path: string, trash: () => Promise<T>): Promise<T> {
      if (path) pending.set(path, (pending.get(path) ?? 0) + 1);
      try {
        return await trash();
      } finally {
        if (path) {
          const remaining = (pending.get(path) ?? 1) - 1;
          if (remaining > 0) pending.set(path, remaining);
          else pending.delete(path);
        }
      }
    },
  };
}
