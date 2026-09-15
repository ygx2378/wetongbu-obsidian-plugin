/**
 * Article identity and merge helpers used by the Obsidian delivery path.
 *
 * A task id identifies a delivery attempt, not an article.  These helpers use
 * the canonical source URL as the article identity and keep formatting noise
 * (BOM/line endings/generated asset names) out of duplicate comparisons.
 */

import { normalizeCompletionSourceUrl } from "./completion-task-validation.ts";
import { sha256Hex } from "./shared/hash.ts";

export const GENERATED_START = "<!-- wetongbu:generated:start -->";
export const GENERATED_END = "<!-- wetongbu:generated:end -->";

export interface ArticleFrontmatter {
  title?: string;
  sourceUrl?: string;
  syncMode?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface ArticleCandidate {
  path: string;
  content: string;
  frontmatter: ArticleFrontmatter;
  body: string;
  sourceKey: string | null;
  managed: boolean;
}

export function normalizeArticleSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return normalizeCompletionSourceUrl(value.trim());
  } catch {
    return value.trim();
  }
}

export function normalizeMarkdownForCompare(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

/** Ignore task-specific attachment names when comparing an article body. */
export function normalizeArticleBodyForCompare(value: string): string {
  return normalizeMarkdownForCompare(value)
    .replace(/^[ \t]*<!--\s*wetongbu:generated:(?:start|end)\s*-->[ \t]*\r?\n?/gim, "")
    .replace(/WTB-\d{8}-\d{6}-[a-z0-9]{8}-\d{3}(?=\.[a-z0-9]+)?/gi, "WTB-ASSET")
    .replace(/assets\/image-\d{3}(?:\.[a-z0-9]+)?/gi, "assets/image-ASSET")
    .trimEnd();
}

/** Extract only the generated local attachment references used for article dedupe. */
export function generatedAssetReferences(value: string): string[] {
  const references: string[] = [];
  const imageLink = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
  for (const match of value.matchAll(imageLink)) {
    const target = (match[1] ?? match[2] ?? "").trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
    const filename = target.split(/[\\/]/).at(-1) ?? "";
    if (/^WTB-[a-z0-9_-]+\.[a-z0-9]+$/i.test(filename)
      || /^image-\d{3}\.[a-z0-9]+$/i.test(filename)) {
      references.push(target);
    }
  }
  return references;
}

export async function articleAssetFingerprintFromBodies(bodies: Uint8Array[]): Promise<string> {
  const hashes = await Promise.all(bodies.map((body) => sha256Hex(body)));
  return `${bodies.length}:${hashes.join("|")}`;
}

function resolveVaultRelativePath(folder: string, target: string): string {
  const decoded = (() => {
    try { return decodeURIComponent(target); } catch { return target; }
  })().replace(/\\/g, "/");
  const parts = (decoded.startsWith("/") ? decoded.slice(1) : `${folder}/${decoded}`).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

export async function articleAssetFingerprintFromVault(
  adapter: { readBinary(path: string): Promise<ArrayBuffer> },
  notePath: string,
  body: string,
): Promise<string> {
  const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const hashes: string[] = [];
  for (const reference of generatedAssetReferences(body)) {
    const targetPath = resolveVaultRelativePath(folder, reference);
    try {
      hashes.push(await sha256Hex(new Uint8Array(await adapter.readBinary(targetPath))));
    } catch {
      hashes.push(`missing:${targetPath}`);
    }
  }
  return `${hashes.length}:${hashes.join("|")}`;
}

export function splitMarkdownFrontmatter(markdown: string): { frontmatter: string; body: string; newline: "\n" | "\r\n" } {
  const newline: "\n" | "\r\n" = markdown.includes("\r\n") ? "\r\n" : "\n";
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { frontmatter: "", body: markdown, newline };
  return { frontmatter: match[1], body: markdown.slice(match[0].length), newline };
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try { return JSON.parse(trimmed.startsWith("'") ? JSON.stringify(trimmed.slice(1, -1)) : trimmed); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function parseArticleFrontmatter(markdown: string): ArticleFrontmatter {
  const { frontmatter } = splitMarkdownFrontmatter(markdown);
  if (!frontmatter) return {};
  const result: ArticleFrontmatter = {};
  const lines = frontmatter.split(/\r?\n/);
  let currentList: string | null = null;
  for (const line of lines) {
    const listItem = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (listItem && currentList) {
      const list = Array.isArray(result[currentList]) ? result[currentList] as unknown[] : [];
      list.push(String(parseScalar(listItem[1])));
      result[currentList] = list;
      continue;
    }
    const field = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (!rawValue) {
      currentList = key;
      result[key] = [];
    } else {
      currentList = null;
      result[key] = parseScalar(rawValue);
    }
  }
  result.title = typeof result.title === "string" ? result.title : undefined;
  result.sourceUrl = typeof result.source_url === "string"
    ? result.source_url
    : typeof result.url === "string" ? result.url : undefined;
  result.syncMode = typeof result.sync_mode === "string" ? result.sync_mode : undefined;
  result.tags = Array.isArray(result.tags) ? result.tags.map(String) : undefined;
  return result;
}

export function articleCandidate(path: string, content: string): ArticleCandidate {
  const frontmatter = parseArticleFrontmatter(content);
  const { body } = splitMarkdownFrontmatter(content);
  const sourceKey = normalizeArticleSourceUrl(frontmatter.sourceUrl);
  const managed = Boolean(
    content.includes(GENERATED_START) && content.includes(GENERATED_END)
    || frontmatter.syncMode === "create_new"
    || frontmatter.syncMode === "complete_capture"
    || frontmatter.tags?.some((tag) => tag === "微同步" || tag === "网页剪藏" || tag === "微信剪藏" || tag === "飞书同步"),
  );
  return { path, content, frontmatter, body, sourceKey, managed };
}

/**
 * Identify a legacy generated note that predates source_url frontmatter.
 * Matching is deliberately restricted to the exact WTB path selected by the
 * current clip so a same-title note from another source is never merged.
 */
export function isLegacyArticleCandidate(candidate: ArticleCandidate, expectedPath: string): boolean {
  return candidate.path === expectedPath && candidate.managed && !candidate.sourceKey;
}

export function incomingArticleBody(markdown: string): string {
  const { body } = splitMarkdownFrontmatter(markdown);
  return body.trim();
}

export function ensureGeneratedMarkers(markdown: string): string {
  const { frontmatter, body, newline } = splitMarkdownFrontmatter(markdown);
  const normalizedBody = body.trim();
  const managedBody = normalizedBody.includes(GENERATED_START) && normalizedBody.includes(GENERATED_END)
    ? normalizedBody
    : `${GENERATED_START}${newline}${normalizedBody}${newline}${GENERATED_END}`;
  return frontmatter ? `---${newline}${frontmatter}${newline}---${newline}${newline}${managedBody}${newline}` : `${managedBody}${newline}`;
}

function markerlessBody(markdown: string) {
  return markdown
    .replace(/^[\t ]*<!--\s*wetongbu:generated:(?:start|end)\s*-->[\t ]*\r?\n?/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withoutDuplicateTitle(markdown: string, title: string) {
  const { frontmatter, body, newline } = splitMarkdownFrontmatter(markdown);
  const lines = body.trim().split(/\r?\n/);
  const first = lines[0]?.trim() || "";
  if (first.startsWith("# ") && first.slice(2).trim() === String(title || "").trim()) {
    lines.shift();
    if (!lines[0]?.trim()) lines.shift();
  }
  const cleanedBody = lines.join(newline).trim();
  return frontmatter
    ? `---${newline}${frontmatter}${newline}---${newline}${newline}${cleanedBody}${newline}`
    : `${cleanedBody}${newline}`;
}

/** Remove internal generated markers before a note is shown to the user. */
export function stripGeneratedMarkers(markdown: string): string {
  const { frontmatter, body, newline } = splitMarkdownFrontmatter(markdown);
  const cleanedBody = markerlessBody(body);
  return frontmatter
    ? `---${newline}${frontmatter}${newline}---${newline}${newline}${cleanedBody}${newline}`
    : `${cleanedBody}${newline}`;
}

/**
 * Add the metadata needed by the article dedupe path to a lightweight local
 * clip. Local clips deliberately do not expose generated marker comments.
 */
export function ensureLocalClipFrontmatter(markdown: string, input: {
  title: string;
  sourceUrl: string;
  capturedAt: string;
}) {
  const cleaned = withoutDuplicateTitle(stripGeneratedMarkers(markdown), input.title);
  const parts = splitMarkdownFrontmatter(cleaned);
  if (parts.frontmatter.trim()) return cleaned;
  const title = JSON.stringify(String(input.title || "未命名文档"));
  const sourceUrl = JSON.stringify(String(input.sourceUrl || ""));
  const capturedAt = JSON.stringify(String(input.capturedAt || new Date().toISOString()));
  return [
    "---",
    `title: ${title}`,
    `source_url: ${sourceUrl}`,
    `captured_at: ${capturedAt}`,
    'capture_level: "full"',
    'platform: "generic_web"',
    "tags:",
    '  - "网页剪藏"',
    '  - "微同步"',
    "---",
    "",
    parts.body.trim(),
    "",
  ].join(parts.newline);
}

function updateLightweightFrontmatter(frontmatter: string, metadata: ArticleFrontmatter, newline: "\n" | "\r\n") {
  const lines = frontmatter ? frontmatter.split(/\r?\n/) : [];
  const scalarFields: Array<[string, unknown]> = [
    ["title", metadata.title],
    ["source_url", metadata.sourceUrl],
    ["captured_at", metadata.captured_at],
    ["capture_level", metadata.capture_level],
    ["platform", metadata.platform],
  ];
  for (const [key, value] of scalarFields) {
    if (value === undefined) continue;
    const field = new RegExp(`^${key}\\s*:`);
    const index = lines.findIndex((line) => field.test(line));
    const replacement = `${key}: ${JSON.stringify(String(value))}`;
    if (index >= 0) lines[index] = replacement;
    else lines.push(replacement);
  }
  if (Array.isArray(metadata.tags)) {
    const tagLines = ["tags:", ...metadata.tags.map((tag) => `  - ${JSON.stringify(String(tag))}`)];
    const index = lines.findIndex((line) => /^tags\s*:\s*$/.test(line));
    if (index < 0) {
      lines.push(...tagLines);
    } else {
      let end = index + 1;
      while (end < lines.length && /^\s*-\s+/.test(lines[end])) end += 1;
      lines.splice(index, end - index, ...tagLines);
    }
  }
  return lines.join(newline);
}

export function mergeArticleMarkdown(
  existing: ArticleCandidate,
  incomingMarkdown: string,
  options: { preserveGeneratedMarkers?: boolean } = {},
): string {
  const preserveGeneratedMarkers = options.preserveGeneratedMarkers !== false;
  const incoming = preserveGeneratedMarkers ? ensureGeneratedMarkers(incomingMarkdown) : stripGeneratedMarkers(incomingMarkdown);
  const incomingParts = splitMarkdownFrontmatter(incoming);
  const existingParts = splitMarkdownFrontmatter(existing.content);
  const newline = existingParts.newline;
  const incomingBody = incomingParts.body.trim().replace(/\r?\n/g, newline);
  let body = incomingBody;
  if (existingParts.body.includes(GENERATED_START) && existingParts.body.includes(GENERATED_END)) {
    const start = existingParts.body.indexOf(GENERATED_START);
    const end = existingParts.body.indexOf(GENERATED_END, start + GENERATED_START.length);
    if (start >= 0 && end >= 0) {
      const before = existingParts.body.slice(0, start);
      const after = existingParts.body.slice(end + GENERATED_END.length);
      body = preserveGeneratedMarkers ? `${before}${incomingBody}${after}` : markerlessBody(`${before}${incomingBody}${after}`);
    }
  } else if (!preserveGeneratedMarkers) {
    body = markerlessBody(existingParts.body).trim() === incomingBody ? markerlessBody(existingParts.body) : incomingBody;
  } else {
    body = incomingBody;
  }

  const incomingMeta = parseArticleFrontmatter(incomingMarkdown);
  let frontmatter = existingParts.frontmatter;
  for (const [key, value] of [["title", incomingMeta.title], ["source_url", incomingMeta.sourceUrl], ["captured_at", incomingMeta.captured_at]] as const) {
    if (value === undefined) continue;
    const escaped = JSON.stringify(String(value));
    const field = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:.*$`, "m");
    if (field.test(frontmatter)) frontmatter = frontmatter.replace(field, `${key}: ${escaped}`);
    else frontmatter += `${frontmatter ? newline : ""}${key}: ${escaped}`;
  }
  if (!preserveGeneratedMarkers) frontmatter = updateLightweightFrontmatter(frontmatter, incomingMeta, newline);
  return frontmatter ? `---${newline}${frontmatter}${newline}---${newline}${newline}${body.trim()}${newline}` : `${body.trim()}${newline}`;
}
