import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";

export type VaultSyncScope = "whole_vault" | "root_folder";

/** Reject a root-folder policy before enabling or changing the shared target. */
export function assertVaultSyncScopeConfigured(scope: VaultSyncScope, rootFolder: string): void {
  if (scope === "root_folder" && !normalizeVaultPath(rootFolder)) {
    throw Object.assign(
      new Error("微同步目录无效或为空；请先设置有效目录，避免把整个 Vault 当作微同步范围"),
      { code: "vault_sync_scope_root_invalid" },
    );
  }
}

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
