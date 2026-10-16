export type VaultSyncScope = "whole_vault" | "root_folder";

export interface VaultSyncScopeSettings {
  vaultSyncScope: VaultSyncScope;
}

/** Persist the local choice only after the server has accepted the shared policy. */
export async function saveVaultSyncScopeAfterRemoteConfirmation(
  settings: VaultSyncScopeSettings,
  scope: VaultSyncScope,
  confirmRemote: () => Promise<void>,
  saveSettings: () => Promise<void>,
): Promise<void> {
  const previousScope = settings.vaultSyncScope;
  try {
    await confirmRemote();
    settings.vaultSyncScope = scope;
    await saveSettings();
  } catch (error) {
    settings.vaultSyncScope = previousScope;
    throw error;
  }
}
