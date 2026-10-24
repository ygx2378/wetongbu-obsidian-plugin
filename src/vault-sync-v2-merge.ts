import { sha256Hex } from "./shared/hash.ts";
import { diff3Merge } from "node-diff3";

export type MarkdownMergeResult =
  | { status: "merged"; bytes: Uint8Array; plaintextHash: string }
  | { status: "conflict"; reason: "overlapping_edits" | "too_complex" | "invalid_text" };

type Edit = { start: number; end: number; replacement: string[] };
type Op = { type: "equal" | "insert" | "delete"; value: string };

const MAX_LINES = 20_000;
const MAX_EDIT_DISTANCE = 512;
// node-diff3 uses an LCS matcher whose cost grows with repeated equal lines.
// Bound its matching work before calling it; repetitive notes use our bounded
// Myers path below instead of allowing duplicate lines to amplify CPU/memory.
const MAX_DIFF3_MATCH_PAIRS = 50_000;

type MatureDiff3Attempt =
  | { status: "skipped" }
  | { status: "conflict" }
  | { status: "merged"; lines: string[] };

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function canRunMatureDiff3(base: string[], local: string[], remote: string[]): boolean {
  let totalPairs = 0;
  for (const changed of [local, remote]) {
    const counts = new Map<string, number>();
    for (const line of changed) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of base) {
      totalPairs += counts.get(line) ?? 0;
      if (totalPairs > MAX_DIFF3_MATCH_PAIRS) return false;
    }
  }
  return true;
}

function runMatureDiff3(base: string[], local: string[], remote: string[]): MatureDiff3Attempt {
  if (!canRunMatureDiff3(base, local, remote)) return { status: "skipped" };
  const regions = diff3Merge(local, base, remote, { excludeFalseConflicts: true });
  const merged: string[] = [];
  for (const region of regions) {
    if (region.conflict) return { status: "conflict" };
    if (region.ok) merged.push(...region.ok);
  }
  return { status: "merged", lines: merged };
}

function lineEdits(base: string[], changed: string[]): Edit[] | null {
  const n = base.length;
  const m = changed.length;
  if (n > MAX_LINES || m > MAX_LINES) return null;
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);
  let distance = -1;

  for (let d = 0; d <= Math.min(n + m, MAX_EDIT_DISTANCE); d += 1) {
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      const left = frontier.get(k - 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(k + 1) ?? Number.NEGATIVE_INFINITY;
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      if (!Number.isFinite(x)) x = 0;
      let y = x - k;
      while (x < n && y < m && base[x] === changed[y]) { x += 1; y += 1; }
      frontier.set(k, x);
      if (x >= n && y >= m) { distance = d; break; }
    }
    if (distance >= 0) break;
  }
  if (distance < 0) return null;

  const reversed: Op[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d > 0; d -= 1) {
    const previous = trace[d]!;
    const k = x - y;
    const left = previous.get(k - 1) ?? Number.NEGATIVE_INFINITY;
    const right = previous.get(k + 1) ?? Number.NEGATIVE_INFINITY;
    const previousK = k === -d || (k !== d && left < right) ? k + 1 : k - 1;
    const previousX = previous.get(previousK) ?? 0;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push({ type: "equal", value: base[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push({ type: "insert", value: changed[y - 1]! });
      y -= 1;
    } else {
      reversed.push({ type: "delete", value: base[x - 1]! });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ type: "equal", value: base[x - 1]! });
    x -= 1;
    y -= 1;
  }
  while (x > 0) { reversed.push({ type: "delete", value: base[--x]! }); }
  while (y > 0) { reversed.push({ type: "insert", value: changed[--y]! }); }
  const operations = reversed.reverse();

  const edits: Edit[] = [];
  let baseIndex = 0;
  let active: Edit | null = null;
  for (const operation of operations) {
    if (operation.type === "equal") {
      if (active) { edits.push(active); active = null; }
      baseIndex += 1;
      continue;
    }
    if (!active) active = { start: baseIndex, end: baseIndex, replacement: [] };
    if (operation.type === "delete") {
      active.end += 1;
      baseIndex += 1;
    } else {
      active.replacement.push(operation.value);
    }
  }
  if (active) edits.push(active);
  return edits;
}

function overlaps(a: Edit, b: Edit): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start;
  if (aInsert) return a.start >= b.start && a.start < b.end;
  if (bInsert) return b.start >= a.start && b.start < a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

type BoundedLineMergeResult =
  | { status: "merged"; lines: string[] }
  | { status: "conflict"; reason: "overlapping_edits" | "too_complex" };

function hasMovedLine(base: string[], edits: Edit[]): boolean {
  const removed = new Set<string>();
  const inserted = new Set<string>();
  for (const edit of edits) {
    for (const line of base.slice(edit.start, edit.end)) removed.add(line);
    for (const line of edit.replacement) inserted.add(line);
  }
  return [...removed].some((line) => inserted.has(line));
}

function mergeWithBoundedMyers(base: string[], local: string[], remote: string[]): BoundedLineMergeResult {
  const localEdits = lineEdits(base, local);
  const remoteEdits = lineEdits(base, remote);
  if (!localEdits || !remoteEdits) return { status: "conflict", reason: "too_complex" };
  const sameRevision = sameLines(local, remote);
  if (!sameRevision && localEdits.length > 0 && remoteEdits.length > 0
    && (hasMovedLine(base, localEdits) || hasMovedLine(base, remoteEdits))) {
    // A line reappearing after deletion can be a paragraph move. Its placement
    // is ambiguous to line-oriented diff3 when the other side also changed.
    return { status: "conflict", reason: "overlapping_edits" };
  }

  const combined: Edit[] = [...localEdits];
  for (const remoteEdit of remoteEdits) {
    const same = combined.find((edit) => edit.start === remoteEdit.start && edit.end === remoteEdit.end
      && edit.replacement.length === remoteEdit.replacement.length
      && edit.replacement.every((line, index) => line === remoteEdit.replacement[index]));
    if (same) continue;
    if (combined.some((edit) => overlaps(edit, remoteEdit))) {
      return { status: "conflict", reason: "overlapping_edits" };
    }
    combined.push(remoteEdit);
  }
  combined.sort((a, b) => a.start - b.start || a.end - b.end);
  const lines: string[] = [];
  let cursor = 0;
  for (const edit of combined) {
    if (edit.start < cursor) return { status: "conflict", reason: "overlapping_edits" };
    lines.push(...base.slice(cursor, edit.start), ...edit.replacement);
    cursor = edit.end;
  }
  lines.push(...base.slice(cursor));
  return { status: "merged", lines };
}

function lineEnding(text: string): string {
  const match = text.match(/\r\n|\n|\r/);
  return match?.[0] ?? "\n";
}

function frontmatter(text: string): string | null | undefined {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) return null;
  const lines = body.split(/\r\n|\n|\r/);
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") return lines.slice(0, index + 1).join("\n");
  }
  return undefined;
}

function normalize(text: string): { lines: string[]; bom: boolean; eol: string } {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  return { lines: body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"), bom, eol: lineEnding(body) };
}

/** Merge non-overlapping line edits against a verified shared Markdown base. */
export async function mergeMarkdown3Way(baseBytes: Uint8Array, localBytes: Uint8Array, remoteBytes: Uint8Array): Promise<MarkdownMergeResult> {
  let baseText: string;
  let localText: string;
  let remoteText: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    baseText = decoder.decode(baseBytes);
    localText = decoder.decode(localBytes);
    remoteText = decoder.decode(remoteBytes);
  } catch { return { status: "conflict", reason: "invalid_text" }; }

  const base = normalize(baseText);
  const local = normalize(localText);
  const remote = normalize(remoteText);
  if (base.lines.length > MAX_LINES || local.lines.length > MAX_LINES || remote.lines.length > MAX_LINES) {
    return { status: "conflict", reason: "too_complex" };
  }
  const baseFrontmatter = frontmatter(baseText);
  const localFrontmatter = frontmatter(localText);
  const remoteFrontmatter = frontmatter(remoteText);
  if (baseFrontmatter === undefined || localFrontmatter === undefined || remoteFrontmatter === undefined) {
    return { status: "conflict", reason: "invalid_text" };
  }
  if (localFrontmatter !== baseFrontmatter && remoteFrontmatter !== baseFrontmatter
    && localFrontmatter !== remoteFrontmatter) {
    // Do not attempt field-level YAML semantics or drop comments. Frontmatter
    // edited on both sides is resolved manually unless both sides agree.
    return { status: "conflict", reason: "overlapping_edits" };
  }
  // Keep the bounded Myers pass as the safety gate for document size and edit
  // distance, overlapping edits, and ambiguous paragraph moves. A hard conflict
  // from that pass is never overridden by a more permissive diff3 alignment.
  const bounded = mergeWithBoundedMyers(base.lines, local.lines, remote.lines);
  if (bounded.status === "conflict") return { status: "conflict", reason: bounded.reason };
  const mature = runMatureDiff3(base.lines, local.lines, remote.lines);
  if (mature.status === "merged" && !sameLines(mature.lines, bounded.lines)) {
    // Different valid-looking alignments are unsafe around repeated lines;
    // preserve both revisions for an explicit resolution instead of choosing.
    return { status: "conflict", reason: "overlapping_edits" };
  }
  const mergedLines = mature.status === "merged"
    ? mature.lines
    : bounded.lines;
  const mergedText = `${local.bom ? "\uFEFF" : ""}${mergedLines.join(local.eol || remote.eol || base.eol)}`;
  const bytes = new TextEncoder().encode(mergedText);
  return { status: "merged", bytes, plaintextHash: await sha256Hex(bytes) };
}
