/**
 * Folder chosen in the browser extension for a clip. The extension validates
 * it too, but the value arrives through a URI or ZIP manifest, so the plugin
 * re-checks it before it becomes part of a Vault path. Invalid values fall
 * back to the default inbox layout instead of failing the clip.
 */
const MAX_FOLDER_LENGTH = 200;
const MAX_FOLDER_DEPTH = 10;
const INVALID_SEGMENT = /[:*?"<>|\u0000-\u001f]/;

export function clipNoteFolder(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.length > MAX_FOLDER_LENGTH) return null;
  const segments = normalized.split("/").map((segment) => segment.trim());
  if (segments.length > MAX_FOLDER_DEPTH) return null;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.startsWith(".") || INVALID_SEGMENT.test(segment)) return null;
  }
  return segments.join("/");
}

/** Clip notes are looked up under the plugin root and, when set, the chosen folder. */
export function isInClipSearchScope(path: string, rootFolder: string, noteFolder?: string | null) {
  const inside = (folder: string) => !folder || path === folder || path.startsWith(`${folder}/`);
  return inside(rootFolder) || Boolean(noteFolder && inside(noteFolder));
}

/**
 * Attachments of notes under the plugin root keep the dated `90_附件` layout.
 * Notes living elsewhere (a folder chosen in the browser extension) keep their
 * attachments in an `附件` folder beside the note, so clipping into a chosen
 * folder never recreates the plugin root.
 */
export function clipAttachmentFolder(input: { rootFolder: string; noteFolder: string; layoutAttachmentFolder: string }) {
  const trim = (value: string) => value.replace(/^\/+|\/+$/g, "");
  const rootFolder = trim(input.rootFolder);
  const noteFolder = trim(input.noteFolder);
  if (!rootFolder || noteFolder === rootFolder || noteFolder.startsWith(`${rootFolder}/`)) {
    return input.layoutAttachmentFolder;
  }
  return noteFolder ? `${noteFolder}/附件` : "附件";
}
