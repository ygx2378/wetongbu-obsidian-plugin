import { sha256Hex } from "./shared/hash.ts";

/** Replace only Markdown destinations that still equal the captured reference. */
export function replaceMarkdownDestination(markdown: string, from: string, to: string, imageOnly = false) {
  const pattern = /(!?\[[^\]\n]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
  return markdown.replace(pattern, (match, prefix: string, rawDestination: string, suffix: string) => {
    if (imageOnly && !prefix.startsWith("!")) return match;
    const destination = rawDestination.startsWith("<") && rawDestination.endsWith(">")
      ? rawDestination.slice(1, -1)
      : rawDestination;
    if (destination !== from) return match;
    const replacement = /\s/.test(to) ? `<${to}>` : to;
    return `${prefix}${replacement}${suffix}`;
  });
}

/** Distinguish a pending captured link, an already-applied link, and a user replacement. */
export function mediaContinuationDestinationState(
  markdown: string,
  from: string,
  to: string,
  imageOnly = false,
): "source" | "destination" | "missing" {
  const hasDestination = (expected: string) => {
    const pattern = /(!?\[[^\]\n]*\]\()(<[^>\n]*>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
    for (const match of markdown.matchAll(pattern)) {
      if (imageOnly && !match[1].startsWith("!")) continue;
      const raw = match[2];
      const destination = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
      if (destination === expected) return true;
    }
    return false;
  };

  if (hasDestination(from)) return "source";
  if (hasDestination(to)) return "destination";
  return "missing";
}

export async function applyMediaContinuationAsset(options: {
  markdown: string;
  from: string;
  to: string;
  imageOnly?: boolean;
  ensureDependency?: () => Promise<void>;
}) {
  const state = mediaContinuationDestinationState(options.markdown, options.from, options.to, options.imageOnly);
  if (state === "missing") return { state, markdown: options.markdown, included: false } as const;
  await options.ensureDependency?.();
  return {
    state,
    markdown: state === "source"
      ? replaceMarkdownDestination(options.markdown, options.from, options.to, options.imageOnly)
      : options.markdown,
    included: true,
  } as const;
}

export const LOCAL_CLIP_IMAGE_MAX_BYTES = 24 * 1024 * 1024;

export function localClipImageLayoutAssets(
  sourcePaths: string[],
  currentAssets: Array<{ clipIndex?: number; relativePath: string; contentType?: string }>,
) {
  const assetsByIndex = new Map<number, { contentType?: string }>();
  for (const [position, asset] of currentAssets.entries()) {
    const index = Number.isInteger(asset.clipIndex) ? Number(asset.clipIndex) : position;
    assetsByIndex.set(index, asset);
  }
  return sourcePaths.map((relativePath, index) => ({
    relativePath,
    contentType: assetsByIndex.get(index)?.contentType,
  }));
}

/** Compute durable handoff evidence before the note starts referencing new assets. */
export async function mediaContinuationFileEvidence(
  notePath: string,
  noteContent: string,
  assets: Array<{ path: string; body: Uint8Array }>,
) {
  const noteBytes = new TextEncoder().encode(noteContent);
  const files = [{ path: notePath, contentHash: await sha256Hex(noteBytes), byteSize: noteBytes.byteLength }];
  for (const asset of assets) {
    files.push({ path: asset.path, contentHash: await sha256Hex(asset.body), byteSize: asset.body.byteLength });
  }
  return files;
}

export async function commitMediaContinuationNoteAndEvidence(options: {
  notePath: string;
  original: string;
  updated: string;
  assets: Array<{ path: string; body: Uint8Array }>;
  writeNote(content: string, expectedOriginal: string): Promise<unknown>;
}) {
  const files = await mediaContinuationFileEvidence(options.notePath, options.updated, options.assets);
  if (options.updated !== options.original) await options.writeNote(options.updated, options.original);
  return { notePath: options.notePath, files };
}

/** Download, validate, and persist one captured image at a time. */
export async function processLocalClipImages<TAsset>(options: {
  images: Array<{ url?: string; alt?: string }>;
  download(url: string): Promise<{ body: Uint8Array; contentType?: string }>;
  persist(asset: TAsset, index: number): Promise<void>;
  createAsset(input: { url: string; alt?: string; body: Uint8Array; contentType?: string; index: number }): TAsset;
  maxImageBytes?: number;
}) {
  const maxImageBytes = options.maxImageBytes ?? LOCAL_CLIP_IMAGE_MAX_BYTES;
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1) throw new Error("图片大小限制无效");

  let saved = 0;
  let failed = 0;
  let firstFailure: string | undefined;
  for (const [index, image] of options.images.entries()) {
    if (typeof image?.url !== "string" || !image.url) continue;
    try {
      const downloaded = await options.download(image.url);
      if (!downloaded.body.byteLength) throw new Error("图片响应为空");
      if (downloaded.body.byteLength > maxImageBytes) {
        throw Object.assign(new Error(`图片超过 ${Math.floor(maxImageBytes / (1024 * 1024))} MiB 限制`), {
          code: "local_clip_image_too_large",
        });
      }
      const asset = options.createAsset({
        url: image.url,
        alt: image.alt,
        body: downloaded.body,
        contentType: downloaded.contentType,
        index,
      });
      await options.persist(asset, index);
      saved += 1;
    } catch (error) {
      failed += 1;
      firstFailure ??= error instanceof Error ? error.message : "网络错误";
    }
  }
  return { saved, failed, firstFailure };
}
