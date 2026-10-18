import { sha256Hex } from "./shared/hash.ts";

export function restoreConflictEditorTextFormat(editedText: string, templateText: string): string {
  const hasBom = templateText.startsWith("\uFEFF");
  const body = hasBom && editedText.startsWith("\uFEFF") ? editedText.slice(1) : editedText;
  const eol = templateText.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  return `${hasBom ? "\uFEFF" : ""}${body.replace(/\r\n|\n|\r/g, eol)}`;
}

export interface SubmitManualConflictMergeInput {
  expectedPreviewText: string;
  mergedText: string;
  maxBytes: number;
  writeText(mergedText: string, expectedPreviewText: string): Promise<void>;
  submit(mergedHash: string): Promise<void>;
}

/** Save an edited three-way merge against the exact preview, then submit those bytes through the durable conflict path. */
export async function submitManualConflictMerge(input: SubmitManualConflictMergeInput): Promise<string> {
  const bytes = new TextEncoder().encode(input.mergedText);
  if (bytes.byteLength > input.maxBytes) {
    throw Object.assign(new Error(`合并正文超过 ${input.maxBytes} 字节预览与提交上限；本机和云端内容保持不变`), {
      code: "vault_sync_conflict_merge_too_large",
    });
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw Object.assign(new Error("合并正文包含无法编码的字符；本机和云端内容保持不变"), {
      code: "vault_sync_conflict_merge_invalid_text",
    });
  }
  if (decoded !== input.mergedText) {
    throw Object.assign(new Error("合并正文包含无法无损保存的字符；本机和云端内容保持不变"), {
      code: "vault_sync_conflict_merge_invalid_text",
    });
  }

  const mergedHash = await sha256Hex(bytes);
  await input.writeText(input.mergedText, input.expectedPreviewText);
  try {
    await input.submit(mergedHash);
  } catch (error) {
    throw Object.assign(new Error("合并稿已先保存到本机，但云端提交尚未确认；请关闭此窗口并重新打开冲突中心核对最新内容。"), {
      code: "vault_sync_conflict_merge_submit_pending",
      localDraftSaved: true,
      cause: error,
    });
  }
  return mergedHash;
}
