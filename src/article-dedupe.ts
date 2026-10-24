/**
 * Article identity and merge helpers used by the Obsidian delivery path.
 *
 * A task id identifies one delivery attempt, while the canonical source URL
 * identifies the article for lightweight clip updates. Full create_new ZIP
 * captures are intentionally allowed to create another note for the same URL.
 */

import { normalizeCompletionSourceUrl } from "./completion-task-validation.ts";
import { sha256Hex } from "./shared/hash.ts";

export const GENERATED_START = "<!-- wetongbu:generated:start -->";
export const GENERATED_END = "<!-- wetongbu:generated:end -->";

export interface ArticleFrontmatter {
  title?: string;
  sourceUrl?: string;
  taskId?: string;
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
  taskId: string | undefined;
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

function isEscapedMarkdownCharacter(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function inlineCodeDelimiterLength(value: string, start: number): number {
  let end = start;
  while (value[end] === "\x60") end += 1;
  return end - start;
}

function findInlineCodeClosingEnd(value: string, start: number, delimiterLength: number): number {
  for (let index = start; index < value.length;) {
    if (value[index] !== "\x60" || isEscapedMarkdownCharacter(value, index)) {
      index += 1;
      continue;
    }
    const length = inlineCodeDelimiterLength(value, index);
    if (length === delimiterLength) return index + length;
    index += length;
  }
  return -1;
}

function mapMarkdownOutsideInlineCode(value: string, transform: (prose: string) => string): string {
  let result = "";
  let proseStart = 0;
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\x60" || isEscapedMarkdownCharacter(value, index)) {
      index += 1;
      continue;
    }
    const delimiterLength = inlineCodeDelimiterLength(value, index);
    const closingEnd = findInlineCodeClosingEnd(value, index + delimiterLength, delimiterLength);
    if (closingEnd < 0) {
      index += delimiterLength;
      continue;
    }
    result += transform(value.slice(proseStart, index));
    result += value.slice(index, closingEnd);
    index = closingEnd;
    proseStart = index;
  }
  return result + transform(value.slice(proseStart));
}

function mapMarkdownOutsideFencedCode(value: string, transform: (prose: string) => string): string {
  const lines = value.split("\n");
  let result = "";
  let prose = "";
  let fence: { character: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const hasNewline = index < lines.length - 1;
    const completeLine = line + (hasNewline ? "\n" : "");
    if (fence) {
      result += completeLine;
      const closing = /^(?: {0,3})(\x60+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (opening) {
      result += mapMarkdownOutsideInlineCode(prose, transform) + completeLine;
      prose = "";
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    prose += completeLine;
  }
  return result + mapMarkdownOutsideInlineCode(prose, transform);
}

function stripGeneratedMarkerPairForCompare(value: string): string {
  const lines = value.split("\n");
  let fence: { character: string; length: number } | null = null;
  let inlineCodeLength = 0;
  let startIndex = -1;
  let endIndex = -1;
  let startCount = 0;
  let endCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = /^(?: {0,3})(\x60+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }

    if (inlineCodeLength === 0) {
      const opening = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
      if (opening) {
        fence = { character: opening[1][0], length: opening[1].length };
        continue;
      }
    }

    if (inlineCodeLength === 0) {
      const marker = /^ {0,3}<!--\s*wetongbu:generated:(start|end)\s*-->[ \t]*$/i.exec(line);
      if (marker?.[1].toLowerCase() === "start") {
        startCount += 1;
        startIndex = index;
      } else if (marker?.[1].toLowerCase() === "end") {
        endCount += 1;
        endIndex = index;
      }
    }

    for (let cursor = 0; cursor < line.length;) {
      if (line[cursor] !== "\x60" || isEscapedMarkdownCharacter(line, cursor)) {
        cursor += 1;
        continue;
      }
      const length = inlineCodeDelimiterLength(line, cursor);
      if (inlineCodeLength === 0) inlineCodeLength = length;
      else if (inlineCodeLength === length) inlineCodeLength = 0;
      cursor += length;
    }
  }

  if (startCount !== 1 || endCount !== 1 || startIndex >= endIndex) return value;
  return lines.filter((_, index) => index !== startIndex && index !== endIndex).join("\n");
}

/** Ignore task-specific attachment names when comparing an article body. */
export function normalizeArticleBodyForCompare(value: string): string {
  const markdown = stripGeneratedMarkerPairForCompare(normalizeMarkdownForCompare(value)).trimEnd();
  const imageLink = /(!\[[^\]]*\]\(\s*)(?:<([^>]+)>|([^\s)]+))(\s*\))/g;
  const normalizeImageLinks = (prose: string) => prose.replace(imageLink, (match, prefix: string, angleTarget: string | undefined, plainTarget: string | undefined, suffix: string) => {
    const target = angleTarget ?? plainTarget;
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return match;
    const separator = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
    const filename = target.slice(separator + 1);
    const normalizedFilename = filename
      .replace(/^WTB-\d{8}-\d{6}-[a-z0-9]{8}-\d{3}(?=\.[a-z0-9]+$)/i, "WTB-ASSET")
      .replace(/^image-\d{3}(?=\.[a-z0-9]+$)/i, "image-ASSET");
    if (normalizedFilename === filename) return match;
    const normalizedTarget = target.slice(0, separator + 1) + normalizedFilename;
    return prefix + (angleTarget !== undefined ? "<" + normalizedTarget + ">" : normalizedTarget) + suffix;
  });
  return mapMarkdownOutsideFencedCode(markdown, (prose) => mapMarkdownOutsideInlineCode(prose, normalizeImageLinks)).trimEnd();
}

/** Extract only the generated local attachment references used for article dedupe. */
export function generatedAssetReferences(value: string): string[] {
  const references: string[] = [];
  const imageLink = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
  mapMarkdownOutsideFencedCode(value, (prose) => mapMarkdownOutsideInlineCode(prose, (text) => {
    for (const match of text.matchAll(imageLink)) {
      const target = (match[1] ?? match[2] ?? "").trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const filename = target.split(/[\\/]/).at(-1) ?? "";
      if (/^WTB-[a-z0-9_-]+\.[a-z0-9]+$/i.test(filename)
        || /^image-\d{3}\.[a-z0-9]+$/i.test(filename)) {
        references.push(target);
      }
    }
    return text;
  }));
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
  return articleAssetFingerprintFromResolver(notePath, body, async (path) => {
    try { return await adapter.readBinary(path); } catch { return null; }
  });
}

export async function articleAssetFingerprintFromResolver(
  notePath: string,
  body: string,
  readBinary: (path: string) => Promise<ArrayBuffer | null>,
): Promise<string> {
  const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const hashes: string[] = [];
  for (const reference of generatedAssetReferences(body)) {
    const targetPath = resolveVaultRelativePath(folder, reference);
    const asset = await readBinary(targetPath);
    if (!asset) {
      hashes.push(`missing:${targetPath}`);
    } else {
      hashes.push(await sha256Hex(new Uint8Array(asset)));
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
  const result: ArticleFrontmatter = {};
  if (!frontmatter) {
    result.taskId = /<!--\s*wetongbu:task_id:([a-zA-Z0-9_-]+)\s*-->/i.exec(markdown)?.[1];
    return result;
  }
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
  result.taskId = typeof result.wetongbu_task_id === "string"
    ? result.wetongbu_task_id
    : /<!--\s*wetongbu:task_id:([a-zA-Z0-9_-]+)\s*-->/i.exec(markdown)?.[1];
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
  return { path, content, frontmatter, body, sourceKey, taskId: frontmatter.taskId, managed };
}

function articleCandidateForConflict(path: string, markdown: string): ArticleCandidate {
  const taskMarker = /<!--\s*wetongbu:task_id:([a-zA-Z0-9_-]+)\s*-->/i.exec(markdown)?.[1];
  const content = markdown.replace(/^(?:\uFEFF)?[ \t]*<!--\s*wetongbu:task_id:[a-zA-Z0-9_-]+\s*-->[ \t]*(?:\r?\n|$)/i, "");
  const candidate = articleCandidate(path, content);
  return { ...candidate, taskId: candidate.taskId ?? taskMarker };
}

function articleConflictIdentity(candidate: ArticleCandidate): string | null {
  const captureIds = [candidate.frontmatter.wetongbu_capture_id, candidate.frontmatter.capture_id]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
  const uniqueCaptureIds = [...new Set(captureIds)];
  if (uniqueCaptureIds.length > 1) return null;
  if (uniqueCaptureIds.length === 1) return `capture:${uniqueCaptureIds[0]}`;
  return candidate.taskId?.trim() ? `task:${candidate.taskId.trim()}` : null;
}

function frontmatterForConflictCompare(markdown: string): string {
  const content = markdown.replace(/^(?:\uFEFF)?[ \t]*<!--\s*wetongbu:task_id:[a-zA-Z0-9_-]+\s*-->[ \t]*(?:\r?\n|$)/i, "");
  const { frontmatter } = splitMarkdownFrontmatter(content);
  return normalizeMarkdownForCompare(frontmatter)
    .split("\n")
    .filter((line) => !/^wetongbu_task_id\s*:/i.test(line))
    .join("\n")
    .trim();
}

/**
 * Permit conflict convergence only when both sides are the same managed
 * capture, source, generated body, and user-visible frontmatter. Attachment
 * bytes are checked separately before the caller replaces the local note.
 */
export function canConvergeManagedArticleContent(path: string, localMarkdown: string, remoteMarkdown: string): boolean {
  const local = articleCandidateForConflict(path, localMarkdown);
  const remote = articleCandidateForConflict(path, remoteMarkdown);
  const identity = articleConflictIdentity(local);
  if (!local.managed || !remote.managed || !local.sourceKey || local.sourceKey !== remote.sourceKey
    || !identity || identity !== articleConflictIdentity(remote)) return false;
  if (frontmatterForConflictCompare(localMarkdown) !== frontmatterForConflictCompare(remoteMarkdown)) return false;
  return normalizeArticleBodyForCompare(local.body) === normalizeArticleBodyForCompare(remote.body);
}

/** Missing generated assets never qualify for automatic conflict convergence. */
export function articleAssetFingerprintsMatch(local: string, remote: string): boolean {
  return local === remote && !local.includes("missing:");
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
  taskId?: string;
}) {
  const cleaned = withoutDuplicateTitle(stripGeneratedMarkers(markdown), input.title);
  const parts = splitMarkdownFrontmatter(cleaned);
  if (parts.frontmatter.trim()) {
    if (!input.taskId || /^\s*wetongbu_task_id\s*:/mi.test(parts.frontmatter)) return cleaned;
    return [
      "---",
      parts.frontmatter,
      `wetongbu_task_id: ${JSON.stringify(input.taskId)}`,
      "---",
      "",
      parts.body.trim(),
      "",
    ].join(parts.newline);
  }
  const title = JSON.stringify(String(input.title || "未命名文档"));
  const sourceUrl = JSON.stringify(String(input.sourceUrl || ""));
  const capturedAt = JSON.stringify(String(input.capturedAt || new Date().toISOString()));
  return [
    "---",
    `title: ${title}`,
    `source_url: ${sourceUrl}`,
    `captured_at: ${capturedAt}`,
    ...(input.taskId ? [`wetongbu_task_id: ${JSON.stringify(input.taskId)}`] : []),
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
