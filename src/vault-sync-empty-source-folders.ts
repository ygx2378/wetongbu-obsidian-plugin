import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";

interface VaultFolderLike {
  path: string;
  children?: unknown[];
}

interface VaultFolderCleanupApi {
  getAbstractFileByPath(path: string): VaultFolderLike | null;
  delete(file: VaultFolderLike): Promise<void>;
}

/** Remove only empty source-side folders below the old/new paths' common parent. */
export async function pruneEmptySourceFoldersAfterMove(
  vault: VaultFolderCleanupApi,
  sourcePath: string,
  targetPath: string,
): Promise<string[]> {
  const source = normalizeVaultPath(sourcePath);
  const target = normalizeVaultPath(targetPath);
  if (!source || !target || source !== sourcePath || target !== targetPath || source === target) return [];
  if (source.split("/").some((part) => part.startsWith("."))) return [];

  const sourceParents = source.split("/").slice(0, -1);
  const targetParents = target.split("/").slice(0, -1);
  let commonParentLength = 0;
  while (commonParentLength < sourceParents.length && commonParentLength < targetParents.length
    && sourceParents[commonParentLength] === targetParents[commonParentLength]) {
    commonParentLength += 1;
  }

  const removed: string[] = [];
  for (let length = sourceParents.length; length > commonParentLength; length -= 1) {
    const path = sourceParents.slice(0, length).join("/");
    const folder = vault.getAbstractFileByPath(path);
    if (!folder || !Array.isArray(folder.children) || folder.children.length !== 0) break;
    try {
      await vault.delete(folder);
    } catch {
      break;
    }
    if (vault.getAbstractFileByPath(path)) break;
    removed.push(path);
  }
  return removed;
}
