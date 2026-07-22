// Vault 多端同步协议：插件与服务端共享的类型、常量与纯函数。
// 本文件在主仓库 src/ 与 apps/obsidian-plugin/src/shared/ 镜像保持一致
// （由 scripts/sync-obsidian-marketplace.mjs 同步，与 vault-layout.mjs 同约定）。
//
// 设计依据 docs/vault-sync-design.md，算法参考 Remotely Save V3 三方比较。

export const VAULT_SYNC_PROTOCOL_VERSION = 1;

// 单次 manifest 拉取与批量校验的硬上限，防止滥用与超大响应。
export const MANIFEST_PAGE_LIMIT = 2000;
export const MANIFEST_BATCH_LIMIT = 500;

// 文件路径规范：相对 vault 根的 POSIX 风格，禁止绝对路径、回溯、配置目录。
export const VAULT_SYNC_SKIP_PREFIXES = [".obsidian/", ".wetongbu/", ".trash/"];

export const VAULT_SYNC_SCOPE_WHOLE = "whole_vault";
export const VAULT_SYNC_SCOPE_ROOT = "root_folder";

// SHA-256 十六进制（小写），与 hosted_media_objects / feishu-package 一致。
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const VAULT_FILE_BLOCK_STATUS = Object.freeze({
  ACTIVE: "active",
  DELETING: "deleting",
  DELETED: "deleted",
});

/**
 * 规范化 vault 内相对路径：去前导 / 、折叠 ./.. 、转 POSIX 分隔。
 * 返回 null 表示路径非法（越界或命中跳过前缀）。
 */
export function normalizeVaultPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 1024) return null;
  let p = rawPath.replace(/\\/g, "/");
  if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith("/")) p = p.slice(0, -1);
  if (p.length === 0) return null;
  // 拒绝回溯段与控制字符。
  const parts = p.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
    if (/[\x00-\x1f]/.test(part)) return null;
  }
  // 命中跳过前缀（.obsidian/ 等）则不同步。
  for (const skip of VAULT_SYNC_SKIP_PREFIXES) {
    if (p === skip.slice(0, -1) || p.startsWith(skip)) return null;
  }
  return p;
}

/**
 * 三方比较的决策结果。对应 src/vault-sync-diff.ts 的判定，
 * 服务端在 manifest 协调时也用同一套语义校验上报。
 */
export const VAULT_SYNC_DECISION = Object.freeze({
  EQUAL: "equal",                                   // 三方一致，无需动作
  LOCAL_CREATED: "local_created",                   // 本地新增，需上传
  LOCAL_MODIFIED: "local_modified",                 // 本地修改，需上传
  REMOTE_CREATED: "remote_created",                 // 远端新增，需下载
  REMOTE_MODIFIED: "remote_modified",               // 远端修改，需下载
  LOCAL_DELETED_PROPAGATE: "local_deleted_propagate", // 本地删除且远端未变，远端置 tombstone
  REMOTE_DELETED_PROPAGATE: "remote_deleted_propagate", // 远端删除且本地未变，本地 trash
  CONFLICT: "conflict",                             // 双方都改，留冲突副本
});

/**
 * 校验 mtime/size 字段。mtime 允许 0（部分平台无法获取时回退），
 * 但负数非法；size 允许 0（空文件）。
 */
export function isValidFileMeta({ mtimeMs, size }) {
  return Number.isInteger(mtimeMs) && mtimeMs >= 0
    && Number.isInteger(size) && size >= 0;
}
