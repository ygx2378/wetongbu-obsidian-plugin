export function sanitizeFilename(value) {
  const sanitized = value
    .replace(/[\\/:*?"<>|\r\n]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return (sanitized || "未命名文章").slice(0, 100);
}

export function captureDateParts(capturedAt) {
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid capturedAt date");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return parts;
}

export function buildVaultPaths({ rootFolder, title, capturedAt, taskId, assets }) {
  const { year, month, day, hour, minute, second } = captureDateParts(capturedAt);
  const noteFolder = `${rootFolder}/00_收件箱/${year}/${month}`;
  const attachmentFolder = `${rootFolder}/90_附件/${year}/${month}/${day}`;
  const noteFilename = `${sanitizeFilename(title)}_${year}-${month}-${day}_WTB.md`;
  const shortTaskId = taskId.replace(/-/g, "").slice(0, 8);
  const assetNames = assets.map((asset, index) => {
    const extension = assetExtension(asset);
    const sequence = String(index + 1).padStart(3, "0");
    return `WTB-${year}${month}${day}-${hour}${minute}${second}-${shortTaskId}-${sequence}${extension}`;
  });
  return { noteFolder, attachmentFolder, noteFilename, assetNames };
}

const CONTENT_TYPE_EXTENSIONS = {
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tif",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function extensionFromPath(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let path = value.trim();
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    // Fall back to the raw path when a source URL is malformed.
  }
  path = path.split(/[?#]/, 1)[0];
  try { path = decodeURIComponent(path); } catch { /* keep the encoded path */ }
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const match = /\.([a-z0-9]{1,8})$/i.exec(basename);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function extensionFromContentType(value) {
  if (typeof value !== "string") return "";
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[mediaType] ?? "";
}

/**
 * Keep a reliable source suffix, otherwise use the response content type.
 * CDN URLs often put the format in a query parameter and have no suffix.
 */
function assetExtension(asset) {
  return extensionFromPath(asset?.relativePath) || extensionFromContentType(asset?.contentType);
}
