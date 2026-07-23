// Vault 多端同步：存储抽象 + Free/Pro 两个实现。
//
// 存储统一按内容 hash 寻址（内容寻址存储 CAS）：
//   - Free：插件直连用户 R2/S3/OSS/COS，key = {prefix}/vault/{targetId}/{hash}
//   - Pro：经服务端预签名 URL，key = vault/users/{userId}/{hash}（服务端管）
//
// 内容寻址天然去重：同内容只存一份，多设备共享。删除时由 GC 清理孤儿对象
// （首版不实现 GC，留作后续；先靠 hash 复用避免重复存储）。
//
// Free 用手写 AWS Signature V4（避免把 @aws-sdk/client-s3 的 5MB 打进插件 bundle）。
// Pro 用预签名 URL，插件只做 HTTP PUT/GET，不持有平台凭证。

import { requestUrl } from "obsidian";
import { sha256Hex } from "./shared/hash";
import type { VaultSyncCrypto } from "./shared/vault-sync-crypto";
import { buildFreeS3BaseUrl, deriveS3Config } from "./vault-sync-storage-config";
export { deriveS3Config } from "./vault-sync-storage-config";

export interface VaultSyncStorage {
  /** 写入内容（按 hash 寻址）。上传 Pro 需先 prepare。 */
  put(hash: string, body: Uint8Array, plaintextByteSize?: number): Promise<void>;
  /** 读取内容（按 hash 寻址）。 */
  get(hash: string): Promise<Uint8Array>;
  /** 删除（按 hash）。幂等。 */
  delete(hash: string): Promise<void>;
  /** 连通性探针。 */
  probe?(): Promise<void>;
}

// ---- Free：直连用户 S3，手写 SigV4 ----

export interface FreeStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  targetId: string;
  /** False only when the body is an encrypted envelope keyed by plaintext hash. */
  verifyHash?: boolean;
}

export function createFreeS3Storage(config: FreeStorageConfig, request: typeof requestUrl = requestUrl): VaultSyncStorage {
  const region = config.region || "auto";
  const baseUrl = buildFreeS3BaseUrl(config);

  const objectKey = (hash: string) => {
    const cleanPrefix = config.prefix.replace(/^\/+|\/+$/g, "");
    return cleanPrefix
      ? `${cleanPrefix}/vault/${config.targetId}/${hash}`
      : `vault/${config.targetId}/${hash}`;
  };

  const buildUrl = (key: string) => `${baseUrl}/${key}`;

  async function signedRequest(method: "GET" | "PUT" | "DELETE" | "HEAD", key: string, body?: Uint8Array): Promise<{ status: number; body: Uint8Array | null }> {
    const url = buildUrl(key);
    const u = new URL(url);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body ? await sha256Hex(body) : "UNSIGNED-PAYLOAD";

    const headers: Record<string, string> = {
      host: u.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };

    const canonical = buildCanonicalRequest(method, u, headers, payloadHash);
    const stringToSign = await buildStringToSign(amzDate, dateStamp, region, canonical);
    const signingKey = await deriveSigningKey(config.secretAccessKey, dateStamp, region, "s3");
    const signature = await hmacHex(signingKey, stringToSign);
    const authHeader = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${dateStamp}/${region}/s3/aws4_request, SignedHeaders=${Object.keys(headers).sort().join(";")}, Signature=${signature}`;

    // Electron rejects an explicitly supplied Host header with
    // net::ERR_INVALID_ARGUMENT. The URL sets the same Host header on the
    // wire, so keep it in the canonical signature but do not pass it through
    // Obsidian's requestUrl headers.
    const response = await request({
      url,
      method,
      headers: {
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization: authHeader,
      },
      body: body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer : undefined,
      throw: false,
    });

    let respBody: Uint8Array | null = null;
    if (response.arrayBuffer) {
      respBody = new Uint8Array(response.arrayBuffer);
    }
    return { status: response.status, body: respBody };
  }

  return {
    async put(hash, body) {
      const resp = await signedRequest("PUT", objectKey(hash), body);
      if (resp.status >= 200 && resp.status < 300) return;
      throw new Error(`storage put 失败：HTTP ${resp.status}`);
    },
    async get(hash) {
      const resp = await signedRequest("GET", objectKey(hash));
      if (resp.status === 404) throw Object.assign(new Error(`对象不存在：${hash.slice(0, 12)}`), { code: "NotFound" });
      if (resp.status >= 200 && resp.status < 300 && resp.body) {
        const actualHash = await sha256Hex(resp.body);
        if (config.verifyHash !== false && actualHash !== hash) throw new Error("storage get 完整性校验失败");
        return resp.body;
      }
      throw new Error(`storage get 失败：HTTP ${resp.status}`);
    },
    async delete(hash) {
      // Content-addressed objects can be referenced by multiple paths. Until
      // coordinated GC exists, never delete a shared object inline.
      void hash;
    },
    async probe() {
      const resp = await signedRequest("HEAD", objectKey("probe-" + Date.now()));
      // 404 也说明凭证有效、bucket 可达（只是对象不存在）。
      if (resp.status === 404 || (resp.status >= 200 && resp.status < 300)) return;
      throw new Error(`存储验证失败：HTTP ${resp.status}（请检查 endpoint、bucket、Access Key 和 Secret Key）`);
    },
  };
}

// ---- Pro：经服务端预签名 URL（不持有平台凭证）----

export interface ProStorageConfig {
  /** 由调用方注入的 prepare/download 客户端（通常是 VaultSyncRemoteClient）。 */
  prepareUpload(hash: string, byteSize: number): Promise<{ uploadUrl: string | null; deduped: boolean }>;
  prepareDownload(hash: string): Promise<{ downloadUrl: string | null }>;
  verifyHash?: boolean;
}

export function createProHostedStorage(remote: ProStorageConfig): VaultSyncStorage {
  return {
    async put(hash, body, plaintextByteSize = body.byteLength) {
      const prep = await remote.prepareUpload(hash, plaintextByteSize);
      if (prep.deduped) return; // 服务端已有同 hash 块，无需重复上传。
      if (!prep.uploadUrl) throw new Error("Pro 上传未获得预签名 URL");
      // 直接 PUT 到预签名 URL（S3 预签名 URL 已含签名，不要再加 Authorization 头）。
      const resp = await requestUrl({
        url: prep.uploadUrl,
        method: "PUT",
        body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        throw: false,
      });
      if (resp.status >= 200 && resp.status < 300) return;
      throw new Error(`Pro 上传失败：HTTP ${resp.status}`);
    },
    async get(hash) {
      const prep = await remote.prepareDownload(hash);
      if (!prep.downloadUrl) throw new Error("Pro 下载未获得预签名 URL");
      const resp = await requestUrl({
        url: prep.downloadUrl,
        method: "GET",
        throw: false,
      });
      if (resp.status === 404) throw Object.assign(new Error(`对象不存在：${hash.slice(0, 12)}`), { code: "NotFound" });
      if (resp.status >= 200 && resp.status < 300 && resp.arrayBuffer) {
        const body = new Uint8Array(resp.arrayBuffer);
        if (remote.verifyHash !== false && await sha256Hex(body) !== hash) throw new Error("Pro 下载完整性校验失败");
        return body;
      }
      throw new Error(`Pro 下载失败：HTTP ${resp.status}`);
    },
    // Pro 的删除由服务端 GC 处理（按 block 引用计数），插件不直接删。
    async delete() { /* no-op：内容寻址，引用计数由服务端管理 */ },
  };
}

/** Wrap a storage adapter so content hashes remain plaintext hashes while
 * object bytes are encrypted locally before upload and verified after download. */
export function createEncryptedVaultStorage(base: VaultSyncStorage, crypto: VaultSyncCrypto): VaultSyncStorage {
  return {
    async put(hash, body) {
      await base.put(hash, await crypto.encrypt(hash, body), body.byteLength);
    },
    async get(hash) {
      return crypto.decrypt(hash, await base.get(hash));
    },
    async delete(hash) { await base.delete(hash); },
    async probe() { await base.probe?.(); },
  };
}

// ---- AWS Signature V4 签名辅助 ----

function buildCanonicalRequest(method: string, url: URL, headers: Record<string, string>, payloadHash: string): string {
  const canonicalUri = url.pathname || "/";
  const canonicalQuery = url.searchParams.toString()
    ? url.searchParams.toString().split("&").map((kv) => kv.replace("=", "=")).sort().join("&")
    : "";
  const sortedHeaders = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = sortedHeaders.map((k) => `${k}:${headers[k.charAt(0).toUpperCase() + k.slice(1)] ?? headers[k]}\n`).join("");
  const signedHeaders = sortedHeaders.join(";");
  return [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
}

async function buildStringToSign(amzDate: string, dateStamp: string, region: string, canonicalRequest: string): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(canonicalRequest));
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  return ["AWS4-HMAC-SHA256", amzDate, scope, hash].join("\n");
}

async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  const rawKey = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw", rawKey as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const result = await globalThis.crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(result);
}

async function hmacHex(key: Uint8Array, value: string): Promise<string> {
  return [...await hmac(key, value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<Uint8Array> {
  const kDate = await hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export async function computeHash(body: Uint8Array): Promise<string> {
  return sha256Hex(body);
}
