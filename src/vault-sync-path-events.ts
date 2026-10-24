import type { EventRef, Vault } from "obsidian";

export type VaultSyncPathEventHandlers = {
  onPathChange: (path: string, deleted?: boolean, kind?: "create" | "modify" | "delete", file?: any) => void;
  onDelete?: (path: string) => void;
  onRename: (file: any, oldPath: string) => void;
};

/** Subscribe to the Obsidian Vault events that can change sync paths or content. */
export function registerVaultSyncPathEvents(
  vault: Pick<Vault, "on">,
  handlers: VaultSyncPathEventHandlers,
): EventRef[] {
  return [
    vault.on("create", (file: any) => handlers.onPathChange(String(file?.path ?? ""), false, "create", file)),
    vault.on("modify", (file: any) => handlers.onPathChange(String(file?.path ?? ""), false, "modify", file)),
    vault.on("delete", (file: any) => {
      const path = String(file?.path ?? "");
      handlers.onPathChange(path, true, "delete", file);
      handlers.onDelete?.(path);
    }),
    vault.on("rename", (file: any, oldPath: string) => handlers.onRename(file, oldPath)),
  ];
}
