import { Unzip, UnzipInflate } from "fflate";
import { isSafePackagePath } from "./shared/feishu-package.mjs";
import {
  MAX_MANIFEST_BYTES,
  MAX_TASK_ENTRY_BYTES,
  MAX_TASK_PACKAGE_BYTES,
  MAX_TASK_PACKAGE_ENTRIES,
} from "./shared/security.ts";

function joinChunks(chunks: Uint8Array[], length: number) {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Extract a task ZIP without materializing unbounded decompressed data. */
export function unzipWebclipArchive(zipBytes: Uint8Array) {
  if (zipBytes.byteLength > MAX_TASK_PACKAGE_BYTES) throw new Error("ZIP 任务包超过大小限制");

  const entries = new Map<string, Uint8Array>();
  let entryCount = 0;
  let totalBytes = 0;
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > MAX_TASK_PACKAGE_ENTRIES) throw new Error("ZIP 文件数量超过限制");
    const isDirectory = file.name.endsWith("/");
    const pathToCheck = isDirectory ? file.name.slice(0, -1) : file.name;
    if (!isSafePackagePath(pathToCheck)) throw new Error("ZIP 包含不安全路径");
    const originalSize = file.originalSize;
    if (!isDirectory && originalSize !== undefined
      && (!Number.isSafeInteger(originalSize) || Number(originalSize) > MAX_TASK_ENTRY_BYTES)) {
      throw new Error(`ZIP 文件超过大小限制：${file.name}`);
    }
    if (file.name === "manifest.json" && originalSize !== undefined && Number(originalSize) > MAX_MANIFEST_BYTES) {
      throw new Error("manifest.json 超过大小限制");
    }

    const chunks: Uint8Array[] = [];
    let fileBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      if (chunk?.length) {
        fileBytes += chunk.length;
        totalBytes += chunk.length;
        if (fileBytes > MAX_TASK_ENTRY_BYTES || totalBytes > MAX_TASK_PACKAGE_BYTES) {
          throw new Error("ZIP 解压内容超过大小限制");
        }
        if (file.name === "manifest.json" && fileBytes > MAX_MANIFEST_BYTES) {
          throw new Error("manifest.json 超过大小限制");
        }
        chunks.push(chunk.slice());
      }
      if (final && !isDirectory) {
        if (originalSize !== undefined && fileBytes !== originalSize) {
          throw new Error(`ZIP 文件大小校验失败：${file.name}`);
        }
        entries.set(file.name, joinChunks(chunks, fileBytes));
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(zipBytes, true);
  return entries;
}
