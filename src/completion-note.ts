import { normalizeCompletionSourceUrl } from "./completion-task-validation.ts";

const GENERATED_START = "<!-- wetongbu:generated:start -->";
const GENERATED_END = "<!-- wetongbu:generated:end -->";

export interface CompletionNoteCandidate {
  path: string;
  content: string;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSourceUrl(value: string) {
  try {
    return normalizeCompletionSourceUrl(value);
  } catch {
    return value.trim();
  }
}

function noteSourceUrls(content: string) {
  const values: string[] = [];
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const urlField = frontmatter?.[1].match(/^url:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/im);
  if (urlField) values.push(urlField[1] ?? urlField[2] ?? urlField[3]);
  const generated = content.match(/<!-- wetongbu:generated:start -->[\s\S]*?<!-- wetongbu:generated:end -->/i)?.[0] ?? "";
  for (const match of generated.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gi)) values.push(match[1]);
  return values;
}

function hasCaptureId(content: string, captureId: string) {
  const pattern = new RegExp(`^wetongbu_capture_id:\\s*["']?${escapeRegExp(captureId)}["']?\\s*$`, "im");
  return pattern.test(content);
}

/**
 * Prefer the durable capture marker. For older placeholders created before
 * that marker was written, use the original URL only inside the generated
 * placeholder block and only when the match is unambiguous.
 */
export function selectCompletionNote(candidates: CompletionNoteCandidate[], captureId: string, sourceUrl: string) {
  const marked = candidates.filter((candidate) => hasCaptureId(candidate.content, captureId));
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) return null;

  const expectedUrl = normalizeSourceUrl(sourceUrl);
  const bySource = candidates.filter((candidate) => {
    if (!candidate.content.includes(GENERATED_START) || !candidate.content.includes(GENERATED_END)) return false;
    return noteSourceUrls(candidate.content).some((value) => normalizeSourceUrl(value) === expectedUrl);
  });
  return bySource.length === 1 ? bySource[0] : null;
}

function yamlScalar(value: string) {
  return JSON.stringify(value);
}

function upsertFrontmatterScalar(content: string, key: string, value: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!frontmatter) return content;
  const field = new RegExp(`^${escapeRegExp(key)}:\\s*`, "i");
  const replacement = `${key}: ${yamlScalar(value)}`;
  const newline = frontmatter[0].includes("\r\n") ? "\r\n" : "\n";
  const lines = frontmatter[1].split(/\r?\n/);
  const updated: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!field.test(line)) {
      updated.push(line);
      continue;
    }
    if (!replaced) {
      updated.push(replacement);
      replaced = true;
    }
  }
  if (!replaced) {
    const tagsIndex = updated.findIndex((line) => /^tags:\s*$/i.test(line));
    updated.splice(tagsIndex >= 0 ? tagsIndex : updated.length, 0, replacement);
  }
  return `---${newline}${updated.join(newline)}${newline}---${frontmatter[2]}${content.slice(frontmatter[0].length)}`;
}

export function updateCompletionNoteMetadata(content: string, input: {
  captureId: string;
  title: string;
  sourceUrl: string;
}) {
  let updated = upsertFrontmatterScalar(content, "wetongbu_capture_id", input.captureId);
  updated = upsertFrontmatterScalar(updated, "title", input.title);
  updated = upsertFrontmatterScalar(updated, "url", input.sourceUrl);
  return upsertFrontmatterScalar(updated, "capture_level", "full");
}
