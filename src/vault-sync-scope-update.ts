import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";

export type VaultSyncScope = "whole_vault" | "root_folder";

export interface VaultSyncSettingsAcknowledgement {
  enabled: boolean;
  scope: string;
}

/** Do not persist a local sync toggle unless the server confirms the exact requested state. */
export function assertVaultSyncSettingsAcknowledged(
  result: VaultSyncSettingsAcknowledgement,
  requestedEnabled: boolean,
  requestedScope: VaultSyncScope,
): VaultSyncScope {
  if (result.enabled !== requestedEnabled || result.scope !== requestedScope) {
    throw Object.assign(
      new Error("云端没有确认 Vault 同步开关和范围；本机设置未更改，请刷新状态后重试"),
      { code: "vault_sync_settings_not_confirmed" },
    );
  }
  return requestedScope;
}

/** Reject a root-folder policy before enabling or changing the shared target. */
export function assertVaultSyncScopeConfigured(scope: VaultSyncScope, rootFolder: string): void {
  if (scope === "root_folder" && !normalizeVaultPath(rootFolder)) {
    throw Object.assign(
      new Error("微同步目录无效或为空；请先设置有效目录，避免把整个 Vault 当作微同步范围"),
      { code: "vault_sync_scope_root_invalid" },
    );
  }
}

/** Keep the selected scope readable when native mobile dropdowns collapse long labels. */
export function describeVaultSyncScope(scope: VaultSyncScope, rootFolder: string): string {
  if (scope === "whole_vault") return "整个 Vault";
  const normalizedRoot = normalizeVaultPath(rootFolder);
  return normalizedRoot ? `仅 ${normalizedRoot} 目录` : "仅（目录未配置）";
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
