// Pasted/dropped images are uploaded to the account's hosted media space and
// replaced by a signed gateway link. Kept free of Obsidian imports so the flow
// can be tested without an app instance.

export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const PASTE_IMAGE_MAX_EDGE = 2560;
export const PASTE_IMAGE_UPLOAD_TIMEOUT_MS = 60_000;

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

// Plain text rather than a link: Obsidian treats a relative image target as an
// internal embed and offers to create the missing file. With a blob: preview
// the image shows right away; the blob URL is unique, so it identifies the
// placeholder on its own.
export function pasteUploadPlaceholder(id: string, previewUrl?: string | null) {
  if (previewUrl) return `![微同步图片上传中…](${previewUrl})`;
  return `【微同步图片上传中… wetongbu-uploading-${id}】`;
}

// GIF is skipped because re-encoding through a canvas drops its animation.
export function shouldCompressPastedImage(file: PastedImageFile) {
  return file.type.toLowerCase() !== "image/gif";
}

export function scaledImageSize(width: number, height: number, maxEdge = PASTE_IMAGE_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  readonly retryable = false;

  constructor() {
    super("单张图片超过 20 MB");
  }
}

/** An upload failure that says whether trying again could help. */
export class PasteUploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

// Unclassified errors come from the transport itself (connection reset, DNS,
// TLS), which is exactly what a retry can recover from.
export function isRetryablePasteUploadError(error: unknown) {
  const retryable = (error as { retryable?: unknown } | null)?.retryable;
  return typeof retryable === "boolean" ? retryable : true;
}

export const PASTE_IMAGE_RETRY_DELAYS_MS = [2_000, 5_000];

export interface PasteImageUploadDeps<T extends PastedImageFile> {
  files: T[];
  createId: () => string;
  insert: (text: string) => void;
  replace: (placeholder: string, replacement: string) => Promise<void>;
  upload: (file: T) => Promise<string>;
  saveLocally: (file: T) => Promise<string>;
  notify: (message: string) => void;
  createPreview?: (file: T) => string | null;
  releasePreview?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}

async function uploadWithRetry<T extends PastedImageFile>(deps: PasteImageUploadDeps<T>, file: T) {
  const delays = deps.retryDelaysMs ?? PASTE_IMAGE_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await deps.upload(file);
    } catch (error) {
      if (attempt >= delays.length || !isRetryablePasteUploadError(error)) throw error;
      await sleep(delays[attempt]);
    }
  }
}

function safePreview<T extends PastedImageFile>(deps: PasteImageUploadDeps<T>, file: T) {
  try {
    return deps.createPreview?.(file) ?? null;
  } catch {
    return null;
  }
}

export async function uploadPastedImages<T extends PastedImageFile>(deps: PasteImageUploadDeps<T>) {
  const items = deps.files.map((file) => {
    const preview = safePreview(deps, file);
    return { file, preview, placeholder: pasteUploadPlaceholder(deps.createId(), preview) };
  });
  deps.insert(items.map((item) => item.placeholder).join("\n"));
  const result = { uploaded: 0, savedLocally: 0, failed: 0 };
  let firstError = "";
  for (const { file, preview, placeholder } of items) {
    let replacement = "";
    try {
      replacement = hostedImageMarkdown(file.name, await uploadWithRetry(deps, file));
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
    try {
      await deps.replace(placeholder, replacement);
    } finally {
      if (preview) deps.releasePreview?.(preview);
    }
  }
  if (result.savedLocally) deps.notify(`${result.savedLocally} 张图片未能上传到微同步云端，已保存为本地附件：${firstError}`);
  if (result.failed) deps.notify(`${result.failed} 张图片上传和本地保存均失败：${firstError}`);
  return result;
}
