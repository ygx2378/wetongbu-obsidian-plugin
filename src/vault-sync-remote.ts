// Vault 多端同步：服务端 API 客户端。
// 封装 requestUrl 调用 /api/sync-targets/:id/vault/* 路由。
// 用 vault device token（registerDevice 返回的一次性 token）认证。

import { requestUrl } from "obsidian";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import type { FileEntity } from "./vault-sync-diff";

export interface ManifestItem {
  path: string;
  contentHash: string | null;
  byteSize: number;
  mtimeMs: number;
  isDeleted: boolean;
  revision: number;
  lastWriterDeviceId: string | null;
}

export interface ManifestResponse {
  items: ManifestItem[];
  maxRevision: number;
  nextCursor?: number;
  hasMore?: boolean;
  scope: string;
}

export interface CommitResult {
  path: string;
  status: "committed" | "conflict";
  revision?: number;
  objectKey?: string | null;
  head?: {
    contentHash: string | null;
    byteSize: number;
    mtimeMs: number;
    isDeleted: boolean;
    revision: number;
    lastWriterDeviceId: string | null;
  } | null;
}

export interface VaultSyncStatus {
  enabled: boolean;
  scope: string;
  storage_type: string;
  quota_bytes: number;
  used_bytes: number;
  can_write: boolean;
  can_read: boolean;
  encryption?: {
    enabled: boolean;
    salt_hex: string | null;
    version: number;
  };
}

export interface VaultSyncClientOptions {
  apiBaseUrl: string;
  targetId: string;
  /** plugin token（用于 status / settings / registerDevice） */
  pluginToken: string;
  /** device token（用于 manifest / commit / download；首次启用前为空） */
  deviceToken?: string;
}

export class VaultSyncRemoteClient {
  private base: string;
  private targetId: string;
  private pluginToken: string;
  private deviceToken: string;

  constructor(opts: VaultSyncClientOptions) {
    this.base = opts.apiBaseUrl.replace(/\/$/, "");
    this.targetId = opts.targetId;
    this.pluginToken = opts.pluginToken;
    this.deviceToken = opts.deviceToken ?? "";
  }

  setDeviceToken(token: string) {
    this.deviceToken = token;
  }

  private async request(path: string, init: { method: string; token: "plugin" | "device"; body?: any; query?: Record<string, string> }) {
    const url = new URL(`${this.base}${path}`);
    if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
    const token = init.token === "plugin" ? this.pluginToken : this.deviceToken;
    if (!token) throw new Error("vault sync 未授权：缺少 token");
    const resp = await requestUrl({
      url: url.toString(),
      method: init.method,
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: init.body !== undefined ? JSON.stringify(init.body) : "",
      throw: false,
    });
    if (resp.status === 401) throw new Error("Vault 同步凭证已失效，请重新启用");
    if (resp.status === 503) {
      const code = resp.json?.code ?? "vault_sync_disabled";
      throw Object.assign(new Error(resp.json?.error ?? "vault 同步暂未启用"), { code });
    }
    if (resp.status >= 400) {
      throw Object.assign(new Error(resp.json?.error ?? `vault sync 请求失败（${resp.status}）`), {
        code: resp.json?.code,
      });
    }
    return resp.json;
  }

  async getStatus(): Promise<VaultSyncStatus> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/status`, { method: "GET", token: "plugin" });
  }

  async enable(enabled: boolean, scope: string, encryption?: { enabled: boolean; saltHex: string; version: number }): Promise<{ enabled: boolean; scope: string; encryption?: { enabled: boolean; saltHex: string | null; version: number } }> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/settings`, {
      method: "PUT", token: "plugin", body: {
        enabled,
        scope,
        ...(encryption ? { encryption: { enabled: encryption.enabled, salt_hex: encryption.saltHex, version: encryption.version } } : {}),
      },
    });
  }

  async registerDevice(deviceName: string, installationId: string): Promise<{ deviceId: string; installationId: string; token: string }> {
    const result = await this.request(`/api/sync-targets/${this.targetId}/vault-devices`, {
      method: "POST", token: "plugin", body: { device_name: deviceName, installation_id: installationId },
    });
    // 明文 token 只此一次返回。
    this.deviceToken = result.token;
    return result;
  }

  async getManifest(since: number): Promise<ManifestResponse> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/manifest`, {
      method: "GET", token: "device", query: { since: String(since) },
    });
  }

  async batchGet(paths: string[]): Promise<{ items: ManifestItem[] }> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/manifest/batch-get`, {
      method: "POST", token: "device", body: { paths },
    });
  }

  async commit(commits: Array<{ path: string; contentHash?: string | null; byteSize: number; mtimeMs: number; isDeleted?: boolean; expectedRevision?: number }>): Promise<{ results: CommitResult[] }> {
    // 服务端会再 normalize 一次，这里先做一遍确保 key 一致。
    const normalized = commits.map((c) => ({ ...c, path: normalizeVaultPath(c.path) ?? c.path }));
    return this.request(`/api/sync-targets/${this.targetId}/vault/files/commit`, {
      method: "POST", token: "device", body: { commits: normalized },
    });
  }

  /**
   * Pro 上传准备：返回预签名 PUT URL（10 分钟 TTL）。
   * Free 返回 { uploadUrl: null }（插件直连自有 bucket）。
   * deduped=true 表示服务端已有同 hash 块，无需上传。
   */
  async prepareUpload(contentHash: string, byteSize: number): Promise<{ storage_type: string; upload_url: string | null; deduped: boolean }> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/files/prepare`, {
      method: "POST", token: "device",
      body: { content_hash: contentHash, byte_size: byteSize },
    });
  }

  /**
   * Pro 下载：返回预签名 GET URL（10 分钟 TTL）。
   * Free 返回 { download_url: null }（插件直连自有 bucket）。
   */
  async prepareDownload(contentHash: string): Promise<{ storage_type: string; download_url: string | null; byte_size?: number }> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/files/${contentHash}`, {
      method: "GET", token: "device",
    });
  }
}

/** 把 ManifestItem[] 转成 path → FileEntity 的 Map，供 diff 用。 */
export function manifestAsMap(items: ManifestItem[]): Map<string, FileEntity> {
  const map = new Map();
  for (const item of items) {
    const n = normalizeVaultPath(item.path);
    if (!n) continue;
    map.set(n, {
      path: n,
      contentHash: item.contentHash,
      byteSize: item.byteSize,
      mtimeMs: item.mtimeMs,
      revision: item.revision,
      isDeleted: item.isDeleted,
    });
  }
  return map;
}
