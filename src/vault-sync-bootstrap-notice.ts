/** Show a quiet first-sync decision notice once per target during this plugin session. */
export function createVaultSyncBootstrapNoticeGate(maxTargets = 32) {
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 1 || maxTargets > 256) {
    throw new RangeError("Vault sync bootstrap notice target limit is invalid");
  }
  const seenTargets = new Set<string>();
  return {
    shouldShow(targetKey: string, quiet: boolean): boolean {
      const key = typeof targetKey === "string" ? targetKey.trim() : "";
      if (!key) return false;
      const alreadySeen = seenTargets.has(key);
      if (!alreadySeen) {
        seenTargets.add(key);
        if (seenTargets.size > maxTargets) {
          const oldest = seenTargets.values().next().value;
          if (typeof oldest === "string") seenTargets.delete(oldest);
        }
      }
      return quiet && !alreadySeen;
    },
  };
}
