function moveKey(oldPath: string, newPath: string): string {
  return `${oldPath}\u0000${newPath}`;
}

/** Correlates a remote apply's FileManager rename event so it is not persisted as a local path intent. */
export function createVaultSyncRemoteRenameEventGuard() {
  const pending = new Map<string, Set<object>>();

  function add(file: object, key: string): void {
    let files = pending.get(key);
    if (!files) pending.set(key, files = new Set());
    files.add(file);
  }

  function remove(file: object, key: string): void {
    const files = pending.get(key);
    files?.delete(file);
    if (files?.size === 0) pending.delete(key);
  }

  return {
    async rename<TFile extends { path: string }>(
      file: TFile,
      newPath: string,
      renameFile: (file: TFile, newPath: string) => Promise<void>,
    ): Promise<void> {
      const oldPath = file.path;
      const key = moveKey(oldPath, newPath);
      add(file, key);
      try {
        await renameFile(file, newPath);
      } finally {
        // A successful physical move can emit the Vault event after the API
        // promise settles; keep its identity token until that exact event arrives.
        if (file.path === oldPath) remove(file, key);
      }
    },

    consume(file: { path: string }, oldPath: string): boolean {
      const key = moveKey(oldPath, file.path);
      const files = pending.get(key);
      if (!files?.has(file)) return false;
      remove(file, key);
      return true;
    },
  };
}
