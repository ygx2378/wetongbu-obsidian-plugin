import type { App } from "obsidian";
import { sha256Hex } from "./shared/hash.ts";
import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";

function fail(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

const writeTails = new Map<string, Promise<void>>();

/** Serialize plugin-owned writes to one Vault path while allowing other paths to progress. */
export async function withVaultPathWriteLock<T>(path: string, write: () => Promise<T>): Promise<T> {
  const normalized = normalizeVaultPath(path) ?? path;
  const key = portableVaultPathKey(normalized) ?? normalized;
  const previous = writeTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  writeTails.set(key, current);
  await previous.catch(() => {});
  try {
    return await write();
  } finally {
    release();
    if (writeTails.get(key) === current) writeTails.delete(key);
  }
}

/** Acquire multiple path locks in portable-path order to avoid rename deadlocks. */
export async function withVaultPathWriteLocks<T>(paths: string[], write: () => Promise<T>): Promise<T> {
  const ordered = [...new Map(paths.map((path) => {
    const normalized = normalizeVaultPath(path) ?? path;
    return [portableVaultPathKey(normalized) ?? normalized, normalized] as const;
  })).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, path]) => path);
  const acquire = (index: number): Promise<T> => index >= ordered.length
    ? write()
    : withVaultPathWriteLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}

export type VaultPathGenerationReader = (path: string) => number;

export interface VaultTextReplacementGuard {
  /** Generation captured when expectedOriginal was read, before async preparation. */
  expectedGeneration?: number;
  getPathGeneration?: VaultPathGenerationReader;
  /** Renew external apply ownership immediately before the replacement boundary. */
  beforeReplace?: () => Promise<void>;
}

/** Detect intervening filesystem events even when the bytes later return to the same hash. */
export function assertVaultPathGeneration(
  path: string,
  expectedGeneration: number | undefined,
  readGeneration: VaultPathGenerationReader | undefined,
  code = "vault_write_generation_changed",
): void {
  if (expectedGeneration === undefined || !readGeneration) return;
  if (readGeneration(path) !== expectedGeneration) {
    throw fail(code, "文件在同步准备期间发生过本地变更，已暂缓自动写入");
  }
}

/** Refuse a delayed note replacement while the note is editable or changed. */
export function isVaultPathOpenInMarkdownEditor(app: App, path: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const expectedKey = normalizedPath ? portableVaultPathKey(normalizedPath) : null;
  if (!expectedKey) return false;
  const workspace: any = (app as any).workspace;
  const leaves = [
    ...(typeof workspace?.getLeavesOfType === "function" ? workspace.getLeavesOfType("markdown") ?? [] : []),
    ...(workspace?.activeLeaf ? [workspace.activeLeaf] : []),
  ];
  return leaves.some((leaf: any) => {
    const view = leaf?.view;
    if (view?.getViewType?.() !== "markdown") return false;
    // Reading Preview has no editable CodeMirror buffer to protect. Keep the
    // conservative behavior for source mode and for hosts without getMode().
    if (typeof view.getMode === "function" && view.getMode() === "preview") return false;
    const openPath = normalizeVaultPath(view.file?.path ?? "");
    return !!openPath && portableVaultPathKey(openPath) === expectedKey;
  });
}

/** Keep all conflict actions that write the original path out of the UI while a Markdown editor owns it. */
export function getConflictActionAvailability(app: App, path: string, otherwiseEligible: boolean): {
  canApplyRemote: boolean;
  canSubmitLocal: boolean;
  canEditMerge: boolean;
  blockedByActiveEditor: boolean;
} {
  const blockedByActiveEditor = isVaultPathOpenInMarkdownEditor(app, path);
  const canWriteOriginalPath = otherwiseEligible && !blockedByActiveEditor;
  return {
    canApplyRemote: canWriteOriginalPath,
    canSubmitLocal: canWriteOriginalPath,
    canEditMerge: canWriteOriginalPath,
    blockedByActiveEditor,
  };
}

export async function assertSafeTextReplacement(
  app: App,
  path: string,
  expectedText: string,
  guard: VaultTextReplacementGuard = {},
): Promise<void> {
  assertVaultPathGeneration(path, guard.expectedGeneration, guard.getPathGeneration);
  if (isVaultPathOpenInMarkdownEditor(app, path)) {
    throw Object.assign(fail("vault_write_active_editor_busy", "该笔记仍在编辑器中打开，已暂缓自动更新"), { path });
  }
  const current = app.vault.getAbstractFileByPath(path);
  if (!current) throw fail("vault_write_note_missing", "自动更新期间笔记已移动或删除，已暂缓写入");
  const currentText = await app.vault.adapter.read(path);
  if (currentText !== expectedText) {
    throw fail("vault_write_note_changed", "自动更新期间笔记内容已变化，已保留当前内容并暂缓写入");
  }
  // The adapter read above yields to the host. Recheck editor ownership after
  // it so callers that write immediately on return (including completion
  // updates with rollback scratch files) do not use a stale editor decision.
  if (isVaultPathOpenInMarkdownEditor(app, path)) {
    throw Object.assign(fail("vault_write_active_editor_busy", "该笔记仍在编辑器中打开，已暂缓自动更新"), { path });
  }
  if (!app.vault.getAbstractFileByPath(path)) {
    throw fail("vault_write_note_missing", "自动更新期间笔记已移动或删除，已暂缓写入");
  }
  assertVaultPathGeneration(path, guard.expectedGeneration, guard.getPathGeneration);
}

/** Replace a note only while its on-disk contents still match the inspected version. */
export async function writeTextAtomically(
  app: App,
  path: string,
  content: string,
  expectedOriginal: string,
  guard: VaultTextReplacementGuard = {},
) {
  return withVaultPathWriteLock(path, async () => {
    assertVaultPathGeneration(path, guard.expectedGeneration, guard.getPathGeneration);
    const transactionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temporary = `${path}.wetongbu-update-${transactionId}.tmp`;
    const backup = `${path}.wetongbu-update-${transactionId}.bak`;
    const adapter = app.vault.adapter as any;
    await adapter.write(temporary, content);
    if ((await adapter.read(temporary)) !== content) {
      await adapter.remove(temporary).catch(() => {});
      throw new Error("文章临时文件写入校验失败");
    }
    const original = await adapter.read(path);
    await adapter.write(backup, original);
    let replacementStarted = false;
    let safeToCleanup = false;
    try {
      await assertSafeTextReplacement(app, path, expectedOriginal, guard);
      if (original !== expectedOriginal) {
        throw Object.assign(new Error("文章内容已变化，自动更新已暂缓"), { code: "vault_write_note_changed" });
      }
      // Destination checks can yield to Obsidian UI events. Recheck editor
      // ownership and disk contents after that await so a note opened during
      // preparation is not replaced from a stale safety decision.
      const destinationExists = typeof adapter.rename === "function" && typeof adapter.exists === "function"
        ? await adapter.exists(path)
        : true;
      await assertSafeTextReplacement(app, path, expectedOriginal, guard);
      if (original !== expectedOriginal) {
        throw Object.assign(new Error("文章内容已变化，自动更新已暂缓"), { code: "vault_write_note_changed" });
      }
      if (guard.beforeReplace) {
        await guard.beforeReplace();
        await assertSafeTextReplacement(app, path, expectedOriginal, guard);
        if (original !== expectedOriginal) {
          throw Object.assign(new Error("文章内容已变化，自动更新已暂缓"), { code: "vault_write_note_changed" });
        }
      }
      replacementStarted = true;
      // DataAdapter.rename intentionally rejects an existing destination on
      // Obsidian's local adapter. Use the verified overwrite path whenever the
      // note is still present; only use rename if a concurrent operation removed
      // the destination between the backup and replacement steps.
      if (typeof adapter.rename === "function" && !destinationExists) {
        await adapter.rename(temporary, path);
      } else {
        // Verify the overwrite. The backup above preserves the original during
        // this non-atomic replacement window; the failure path below classifies
        // the target before deciding whether the scratch files are safe to drop.
        await adapter.write(path, content);
        if ((await adapter.read(path)) !== content) throw new Error("文章更新替换校验失败");
      }
      if ((await adapter.read(path)) !== content) throw new Error("文章更新校验失败");
      safeToCleanup = true;
    } catch (error) {
      if (!replacementStarted) {
        safeToCleanup = true;
      } else {
        // A failed write/readback does not prove that the target is still ours
        // to roll back: an editor or external process may have saved after the
        // remote replacement began. Classify the on-disk bytes first and never
        // overwrite a state that matches neither side of this transaction.
        let current: string | undefined;
        let targetRead = false;
        try {
          current = await adapter.read(path);
          targetRead = true;
        } catch {
          // An unreadable or missing target is ambiguous. Leave both recovery
          // artifacts in place so startup recovery can fail closed.
        }
        if (targetRead && current === content) {
          // The adapter reported an error after the intended bytes reached the
          // target. Treat the replacement as committed so callers can advance
          // their durable sync state without rewriting the note.
          safeToCleanup = true;
          return;
        }
        if (targetRead && current === original) {
          // The replacement did not alter the target; retain the original
          // failure while removing scratch files that are no longer needed.
          safeToCleanup = true;
        } else {
          throw Object.assign(
            fail("vault_write_recovery_ambiguous", "笔记更新结果无法确认；已保留本机内容和恢复文件，暂停此路径自动覆盖"),
            { path, cause: error },
          );
        }
      }
      throw error;
    } finally {
      if (safeToCleanup) await cleanupTextReplacementArtifacts(adapter, [backup, temporary]);
    }
  });
}

export interface InterruptedTextReplacementRecoveryResult {
  cleanedPaths: string[];
  unresolved: Array<{ path: string; artifacts: string[] }>;
}

/** Wait until Obsidian has populated the Vault file index before scanning recovery artifacts. */
export async function recoverInterruptedTextReplacementsAfterLayoutReady(app: App): Promise<InterruptedTextReplacementRecoveryResult> {
  await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
  return recoverInterruptedTextReplacements(app);
}

/**
 * Reconcile text-replacement scratch files left by a stopped plugin process.
 * Only exact byte matches prove whether replacement had not started or had
 * completed. Ambiguous targets are left untouched so startup can fail closed.
 */
export async function recoverInterruptedTextReplacements(app: App): Promise<InterruptedTextReplacementRecoveryResult> {
  const adapter = app.vault.adapter as any;
  const groups = new Map<string, { temporary: string[]; backup: string[] }>();
  for (const file of app.vault.getFiles()) {
    const match = /^(.*)\.wetongbu-(?:update|complete)-[^/]+\.(tmp|bak)$/i.exec(file.path);
    if (!match) continue;
    const entry = groups.get(match[1]) ?? { temporary: [], backup: [] };
    entry[match[2].toLowerCase() === "tmp" ? "temporary" : "backup"].push(file.path);
    groups.set(match[1], entry);
  }

  const result: InterruptedTextReplacementRecoveryResult = { cleanedPaths: [], unresolved: [] };
  for (const [path, artifacts] of groups) {
    if (artifacts.temporary.length > 1 || artifacts.backup.length > 1) {
      result.unresolved.push({ path, artifacts: [...artifacts.temporary, ...artifacts.backup] });
      continue;
    }
    const temporary = artifacts.temporary[0];
    const backup = artifacts.backup[0];
    if (!temporary && !backup) continue;

    try {
      const targetExists = await adapter.exists(path);
      const current = targetExists ? await adapter.read(path) : null;
      const staged = temporary ? await adapter.read(temporary) : null;
      const original = backup ? await adapter.read(backup) : null;
      const targetMatchesOriginal = targetExists && backup && current === original;
      const targetMatchesStaged = targetExists && temporary && current === staged;

      // A temporary file without a backup means the writer had not reached
      // the replacement boundary. It can be discarded and the durable outbox
      // will retry the operation on the next sync.
      if (!backup && temporary) {
        await removeAndVerify(adapter, [temporary]);
      } else if (targetMatchesOriginal) {
        // Keep the backup until the temp is gone so a second startup can still
        // classify the interrupted cleanup as an unapplied write.
        await removeAndVerify(adapter, temporary ? [temporary, backup!] : [backup!]);
      } else if (targetMatchesStaged) {
        // Keep the staged bytes until the backup is gone so cleanup remains
        // classifiable if the process stops between these removals.
        await removeAndVerify(adapter, backup ? [backup, temporary!] : [temporary!]);
      } else {
        result.unresolved.push({ path, artifacts: [...artifacts.temporary, ...artifacts.backup] });
        continue;
      }
      result.cleanedPaths.push(path);
    } catch {
      result.unresolved.push({ path, artifacts: [...artifacts.temporary, ...artifacts.backup] });
    }
  }
  return result;
}

async function removeAndVerify(adapter: { remove(path: string): Promise<unknown>; exists(path: string): Promise<boolean> }, paths: string[]) {
  for (const path of paths) {
    await adapter.remove(path);
    if (await adapter.exists(path)) throw new Error("interrupted text replacement artifact remains");
  }
}

/** Best-effort cleanup must not turn a committed text replacement into a failed operation. */
export async function cleanupTextReplacementArtifacts(
  adapter: { remove(path: string): Promise<unknown> },
  paths: string[],
): Promise<void> {
  for (const path of paths) {
    try {
      await adapter.remove(path);
    } catch {
      // Stop in caller-specified order so remaining artifacts stay classifiable
      // after a process interruption; callers must not roll back a committed note.
      return;
    }
  }
}

/** Create an attachment only while its path is still free; never replace a late local file. */
export interface BinaryAssetWriteResult {
  created: boolean;
  mtime: number | null;
}

export async function writeBinaryAssetSafely(
  app: App,
  path: string,
  body: Uint8Array,
  validateBeforeCreate?: () => void | Promise<void>,
): Promise<BinaryAssetWriteResult> {
  return withVaultPathWriteLock(path, async () => {
    const adapter = app.vault.adapter as any;
    const before = await adapter.stat(path);
    const expectedHash = await sha256Hex(body);
    if (before) {
      if (before.type === "file") {
        const current = new Uint8Array(await adapter.readBinary(path));
        if (current.byteLength === body.byteLength && await sha256Hex(current) === expectedHash) {
          return { created: false, mtime: Number.isFinite(before.mtime) ? before.mtime : null };
        }
      }
      throw fail("vault_write_path_collision", "附件目标在准备期间已被占用，已保留现有文件并暂缓写入");
    }

    await validateBeforeCreate?.();
    const exactBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    try {
      // Vault.createBinary is exclusive: it rejects an existing path instead
      // of replacing a file created after the preceding stat check.
      await app.vault.createBinary(path, exactBuffer);
    } catch (error) {
      const raced = await adapter.stat(path).catch(() => null);
      if (raced?.type === "file") {
        const current = new Uint8Array(await adapter.readBinary(path));
        if (current.byteLength === body.byteLength && await sha256Hex(current) === expectedHash) {
          return { created: false, mtime: Number.isFinite(raced.mtime) ? raced.mtime : null };
        }
        throw fail("vault_write_path_collision", "附件目标在准备期间已被占用，已保留现有文件并暂缓写入");
      }
      throw error;
    }
    const after = await adapter.stat(path);
    if (!after || after.type !== "file" || after.size !== body.byteLength) {
      throw fail("vault_write_asset_verification_failed", "附件写入校验失败，已保留现场供重试");
    }
    const persisted = new Uint8Array(await adapter.readBinary(path));
    if (persisted.byteLength !== body.byteLength || await sha256Hex(persisted) !== expectedHash) {
      throw fail("vault_write_asset_verification_failed", "附件内容校验失败，已保留现场供重试");
    }
    return { created: true, mtime: Number.isFinite(after.mtime) ? after.mtime : null };
  });
}

/** Roll back only the exact bytes created by this operation. */
export async function removeBinaryAssetIfUnchanged(
  app: App,
  path: string,
  expectedBody: Uint8Array,
  expectedMtime: number | null,
): Promise<boolean> {
  return withVaultPathWriteLock(path, async () => {
    const adapter = app.vault.adapter as any;
    if (!Number.isFinite(expectedMtime)) return false;
    const currentStat = await adapter.stat(path);
    if (!currentStat || currentStat.type !== "file" || currentStat.size !== expectedBody.byteLength
      || currentStat.mtime !== expectedMtime) return false;
    const current = new Uint8Array(await adapter.readBinary(path));
    if (current.byteLength !== expectedBody.byteLength
      || await sha256Hex(current) !== await sha256Hex(expectedBody)) return false;
    await adapter.remove(path);
    return true;
  });
}
