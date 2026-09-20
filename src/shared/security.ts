/** Security guards for values that cross the plugin/network boundary. */

declare const WETONGBU_API_BASE_URL: string | undefined;

export const DEFAULT_API_BASE_URL = typeof WETONGBU_API_BASE_URL === "string"
  ? WETONGBU_API_BASE_URL
  : "https://api.wetongbu.com";

const TRUSTED_API_HOSTS = new Set([
  "api.wetongbu.com",
  "staging-api.wetongbu.com",
  "test-api.wetongbu.com",
  "wx.wetongbu.com",
  new URL(DEFAULT_API_BASE_URL).hostname.toLowerCase(),
]);
const TRUSTED_AUTHORIZATION_HOSTS = new Set(["app.wetongbu.com", "staging-app.wetongbu.com", "test-app.wetongbu.com"]);
const TRUSTED_AUTHORIZATION_PATHS = new Set(["/device", "/browser-device"]);
const TRUSTED_STORAGE_SUFFIXES = [
  ".r2.cloudflarestorage.com",
  ".amazonaws.com",
  ".aliyuncs.com",
  ".myqcloud.com",
];

export const MAX_TASK_PACKAGE_BYTES = 100 * 1024 * 1024;
export const MAX_TASK_PACKAGE_ENTRIES = 2048;
export const MAX_TASK_ENTRY_BYTES = MAX_TASK_PACKAGE_BYTES;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function parseHttpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

export function normalizeApiBaseUrl(value: unknown): string {
  const url = parseHttpsUrl(value);
  if (!url || !TRUSTED_API_HOSTS.has(url.hostname.toLowerCase())
    || (url.pathname !== "/" && url.pathname !== "")) {
    return DEFAULT_API_BASE_URL;
  }
  return `https://${url.hostname.toLowerCase()}`;
}

/**
 * Resolve the persisted API base when a test build is upgraded to a production
 * build. The API base is intentionally hidden from users, so an old staging
 * value must not survive into a production or production-test package.
 */
export function resolvePersistedApiBaseUrl(value: unknown, defaultApiBaseUrl = DEFAULT_API_BASE_URL): string {
  const normalized = normalizeApiBaseUrl(value);
  const normalizedDefault = normalizeApiBaseUrl(defaultApiBaseUrl);
  const defaultHost = new URL(normalizedDefault).hostname.toLowerCase();
  const savedHost = new URL(normalized).hostname.toLowerCase();
  if (defaultHost === "api.wetongbu.com"
    && /^(?:staging-api|test-api)\.wetongbu\.com$/i.test(savedHost)) {
    return normalizedDefault;
  }
  return normalized;
}

export function shouldResetEnvironmentCredentials(value: unknown, defaultApiBaseUrl = DEFAULT_API_BASE_URL): boolean {
  const normalized = normalizeApiBaseUrl(value);
  return resolvePersistedApiBaseUrl(normalized, defaultApiBaseUrl) !== normalized;
}

export function isTrustedApiUrl(value: unknown, baseUrl = DEFAULT_API_BASE_URL): boolean {
  const url = parseHttpsUrl(value);
  if (!url) return false;
  const base = parseHttpsUrl(normalizeApiBaseUrl(baseUrl));
  return Boolean(base && url.hostname.toLowerCase() === base.hostname.toLowerCase());
}

export function isTrustedAuthorizationUrl(value: unknown): boolean {
  const url = parseHttpsUrl(value);
  if (!url || !TRUSTED_AUTHORIZATION_HOSTS.has(url.hostname.toLowerCase())) return false;
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  return TRUSTED_AUTHORIZATION_PATHS.has(pathname);
}

/** Normalize an API-provided authorization URL for the shared app surface. */
export function createAuthorizationUrl(value: unknown, userCode: string, apiBaseUrl = DEFAULT_API_BASE_URL): URL {
  const url = parseHttpsUrl(value);
  if (!url || !TRUSTED_AUTHORIZATION_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("登录授权地址不受信任");
  }
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (!TRUSTED_AUTHORIZATION_PATHS.has(pathname)) throw new Error("登录授权地址不受信任");
  url.hostname = "app.wetongbu.com";
  url.searchParams.set("api_base", normalizeApiBaseUrl(apiBaseUrl));
  url.searchParams.set("user_code", userCode);
  return url;
}

export function isTrustedStorageUrl(value: unknown, configuredEndpoint = "", apiBaseUrl = DEFAULT_API_BASE_URL): boolean {
  const url = parseHttpsUrl(value);
  if (!url) return false;
  if (isTrustedApiUrl(url.toString(), apiBaseUrl)) return true;
  const configured = parseHttpsUrl(configuredEndpoint);
  if (configured && url.origin === configured.origin) return true;
  const host = url.hostname.toLowerCase();
  return TRUSTED_STORAGE_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export function assertBucketName(value: string): string {
  const bucket = value.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("Bucket 名称不符合对象存储命名规则");
  }
  return bucket;
}

export function assertStoragePrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "");
  if (prefix.length > 512 || /[\\\x00-\x1f]/.test(prefix)
    || prefix.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("存储目录包含不安全路径");
  }
  return prefix;
}

export function assertSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("内容哈希无效");
  return value;
}

export function assertR2Endpoint(value: string): string {
  const endpoint = value.trim().replace(/\/$/, "");
  const url = parseHttpsUrl(endpoint);
  if (!url || !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/i.test(url.hostname)
    || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("R2 Endpoint 必须是 Cloudflare R2 的 HTTPS S3 Endpoint");
  }
  return `https://${url.hostname.toLowerCase()}`;
}
