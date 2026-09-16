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
    const slash = asset.relativePath.lastIndexOf("/");
    const basename = slash >= 0 ? asset.relativePath.slice(slash + 1) : asset.relativePath;
    const dot = basename.lastIndexOf(".");
    const extension = dot > 0 ? basename.slice(dot).toLowerCase() : "";
    const sequence = String(index + 1).padStart(3, "0");
    return `WTB-${year}${month}${day}-${hour}${minute}${second}-${shortTaskId}-${sequence}${extension}`;
  });
  return { noteFolder, attachmentFolder, noteFilename, assetNames };
}
