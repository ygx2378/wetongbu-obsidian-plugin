// Pasted/dropped images are uploaded to the account's hosted media space and
// replaced by a signed gateway link. Kept free of Obsidian imports so the flow
// can be tested without an app instance.

export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const PASTE_IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

export interface PastedImageFile {
  name: string;
  type: string;
  size: number;
}

export function isSupportedPastedImage(file: PastedImageFile) {
  return Object.prototype.hasOwnProperty.call(PASTE_IMAGE_EXTENSIONS, file.type.toLowerCase());
}

/**
 * Returns the files to upload, or an empty list when the transfer contains any
 * non-image file so Obsidian keeps handling the whole paste/drop by default.
 */
export function selectPastedImages<T extends PastedImageFile>(files: ArrayLike<T>): T[] {
  const list = Array.from(files);
  if (!list.length || !list.every(isSupportedPastedImage)) return [];
  return list;
}

export function pasteUploadPlaceholder(id: string) {
  return `![微同步上传中…](wetongbu-uploading-${id})`;
}

export function pastedImageAltText(name: string) {
  return name.replace(/\.[^.]*$/, "").replace(/[[\]\r\n]/g, " ").trim();
}

export function hostedImageMarkdown(name: string, url: string) {
  return `![${pastedImageAltText(name)}](${url})`;
}

export function localPastedImageName(file: PastedImageFile, now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${PASTE_IMAGE_EXTENSIONS[file.type.toLowerCase()] ?? "png"}`;
}

export function replacePlaceholder(content: string, placeholder: string, replacement: string) {
  const index = content.indexOf(placeholder);
  if (index < 0) return null;
  return content.slice(0, index) + replacement + content.slice(index + placeholder.length);
}

export class PasteImageTooLargeError extends Error {
  constructor() {
    super("单张图片超过 20 MB");
  }
}

export interface PasteImageUploadDeps<T extends PastedImageFile> {
  files: T[];
  createId: () => string;
  insert: (text: string) => void;
  replace: (placeholder: string, replacement: string) => Promise<void>;
  upload: (file: T) => Promise<string>;
  saveLocally: (file: T) => Promise<string>;
  notify: (message: string) => void;
}

export async function uploadPastedImages<T extends PastedImageFile>(deps: PasteImageUploadDeps<T>) {
  const items = deps.files.map((file) => ({ file, placeholder: pasteUploadPlaceholder(deps.createId()) }));
  deps.insert(items.map((item) => item.placeholder).join("\n"));
  const result = { uploaded: 0, savedLocally: 0, failed: 0 };
  let firstError = "";
  for (const { file, placeholder } of items) {
    let replacement = "";
    try {
      if (file.size > PASTE_IMAGE_MAX_BYTES) throw new PasteImageTooLargeError();
      replacement = hostedImageMarkdown(file.name, await deps.upload(file));
      result.uploaded += 1;
    } catch (error) {
      firstError ||= error instanceof Error ? error.message : String(error);
      try {
        replacement = await deps.saveLocally(file);
        result.savedLocally += 1;
      } catch {
        result.failed += 1;
      }
    }
    await deps.replace(placeholder, replacement);
  }
  if (result.savedLocally) deps.notify(`${result.savedLocally} 张图片未能上传到微同步云端，已保存到本地：${firstError}`);
  if (result.failed) deps.notify(`${result.failed} 张图片上传和本地保存均失败：${firstError}`);
  return result;
}
