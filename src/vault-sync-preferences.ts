export const VAULT_SYNC_INTERVAL_OPTIONS = [1, 5, 10, 20, 30] as const;
export const DEFAULT_VAULT_SYNC_INTERVAL_MINUTES = 1;

export function normalizeVaultSyncInterval(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "unlimited") return null;
  const numeric = Number(value);
  return VAULT_SYNC_INTERVAL_OPTIONS.includes(numeric as typeof VAULT_SYNC_INTERVAL_OPTIONS[number])
    ? numeric
    : null;
}

/**
 * New installations default to automatic reconciliation. A saved `null` is an
 * explicit/manual choice and remains untouched across upgrades.
 */
export function loadVaultSyncInterval(savedSettings: unknown): number | null {
  if (typeof savedSettings !== "object" || savedSettings === null || Array.isArray(savedSettings)) {
    return DEFAULT_VAULT_SYNC_INTERVAL_MINUTES;
  }
  const saved = savedSettings as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(saved, "vaultSyncIntervalMinutes")) {
    return DEFAULT_VAULT_SYNC_INTERVAL_MINUTES;
  }
  return normalizeVaultSyncInterval(saved.vaultSyncIntervalMinutes);
}
