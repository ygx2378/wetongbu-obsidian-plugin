import crypto from "node:crypto";
import path from "node:path";

export const WEBCLIP_PACKAGE_VERSION = 1;
export const FEISHU_PACKAGE_VERSION = WEBCLIP_PACKAGE_VERSION;

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}

export function isSafePackagePath(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\")) {
    return false;
  }
  if (value.startsWith("/") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && !normalized.startsWith("../") && normalized !== "..";
}

export function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

export function validateWebclipManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be an object");
  }
  if (manifest.version !== WEBCLIP_PACKAGE_VERSION) {
    throw new Error("unsupported Webclip package version");
  }
  if (!["feishu", "web"].includes(manifest.source)) {
    throw new Error("source must be feishu or web");
  }

  const taskId = requireString(manifest.task_id, "task_id");
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("invalid task_id");
  requireString(manifest.user_id, "user_id");
  requireString(manifest.target_id, "target_id");
  requireString(manifest.title, "title");
  const sourceUrl = new URL(requireString(manifest.source_url, "source_url"));
  if (sourceUrl.protocol !== "https:") throw new Error("source_url must use HTTPS");
  if (manifest.sync_mode !== "create_new") {
    throw new Error("sync_mode must be create_new");
  }
  if (manifest.asset_mode !== "local") throw new Error("asset_mode must be local");
  if (Number.isNaN(Date.parse(requireString(manifest.created_at, "created_at")))) {
    throw new Error("invalid created_at");
  }
  if (manifest.source === "web") {
    for (const field of ["site_name", "author"]) {
      if (manifest[field] !== undefined && (typeof manifest[field] !== "string" || !manifest[field].trim())) {
        throw new Error(`invalid ${field}`);
      }
    }
    if (manifest.published_at !== undefined) {
      if (typeof manifest.published_at !== "string" || Number.isNaN(Date.parse(manifest.published_at))) {
        throw new Error("invalid published_at");
      }
    }
  }

  const entryFile = requireString(manifest.entry_file, "entry_file");
  if (entryFile !== "document.md") throw new Error("entry_file must be document.md");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("files must not be empty");
  }

  const seenPaths = new Set();
  let assetCount = 0;
  let attachmentCount = 0;
  for (const file of manifest.files) {
    if (!file || typeof file !== "object") throw new Error("invalid file entry");
    const filePath = requireString(file.path, "file.path");
    if (!isSafePackagePath(filePath)) throw new Error(`unsafe file path: ${filePath}`);
    if (seenPaths.has(filePath)) throw new Error(`duplicate file path: ${filePath}`);
    seenPaths.add(filePath);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`invalid file size: ${filePath}`);
    }
    if (!SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`invalid file SHA-256: ${filePath}`);
    }
    requireString(file.content_type, `content_type: ${filePath}`);
    if (filePath.startsWith("assets/")) {
      assetCount += 1;
      if (file.kind === "attachment") attachmentCount += 1;
      else if (file.kind !== "image") throw new Error(`invalid asset kind: ${filePath}`);
    } else if (filePath !== entryFile) {
      throw new Error(`unsupported package file: ${filePath}`);
    }
  }

  if (!seenPaths.has(entryFile)) throw new Error("entry file is missing");
  if (manifest.asset_count !== assetCount) throw new Error("asset_count mismatch");
  if (manifest.attachment_count !== attachmentCount) {
    throw new Error("attachment_count mismatch");
  }
  return manifest;
}

export function verifyFeishuPackageFiles(manifest, files) {
  validateWebclipManifest(manifest);
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = new Set(files.keys());
  if (actualPaths.size !== expectedPaths.size) throw new Error("package file count mismatch");

  for (const expected of manifest.files) {
    const body = files.get(expected.path);
    if (!body) throw new Error(`package file is missing: ${expected.path}`);
    if (body.length !== expected.bytes) throw new Error(`file size mismatch: ${expected.path}`);
    if (sha256(body) !== expected.sha256) throw new Error(`file SHA-256 mismatch: ${expected.path}`);
  }
}

export const validateFeishuManifest = validateWebclipManifest;
export const verifyWebclipPackageFiles = verifyFeishuPackageFiles;
