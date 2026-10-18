// Vault 多端同步：服务端 API 客户端。
// 封装 requestUrl 调用 /api/sync-targets/:id/vault/* 路由。
// 用 vault device token（registerDevice 返回的一次性 token）认证。

import { normalizeVaultPath, portableVaultPathKey } from "./shared/vault-sync-protocol.mjs";
import type { FileEntity } from "./vault-sync-diff";
import { VaultSyncV2RemoteClient } from "./vault-sync-v2-remote.ts";
import type { VaultSyncCapabilities, VaultSyncOperationResult, VaultSyncOperationWindow, VaultSyncV2Ack, VaultSyncV2ChangePage, VaultSyncV2DeviceProgress, VaultSyncV2DeviceSession, VaultSyncV2EncryptionRotation, VaultSyncV2EncryptionRotationObjectPage, VaultSyncV2EncryptionRotationReservation, VaultSyncV2FileVersionsPage, VaultSyncV2Initialization, VaultSyncV2ObjectDownload, VaultSyncV2ObjectReservation, VaultSyncV2SnapshotApplyLease, VaultSyncV2SnapshotPage, VaultSyncV2SnapshotSummary } from "./vault-sync-v2-remote.ts";
import type { VaultSyncV2Request } from "./vault-sync-outbox.ts";
import { getVaultSyncRetryAfterFromResponse } from "./vault-sync-retry.ts";
export type { VaultSyncCapabilities, VaultSyncOperationResult, VaultSyncOperationWindow, VaultSyncV2Ack, VaultSyncV2ChangePage, VaultSyncV2DeviceProgress, VaultSyncV2DeviceSession, VaultSyncV2EncryptionRotation, VaultSyncV2EncryptionRotationObjectPage, VaultSyncV2EncryptionRotationReservation, VaultSyncV2FileVersionsPage, VaultSyncV2Initialization, VaultSyncV2ObjectDownload, VaultSyncV2ObjectReservation, VaultSyncV2SnapshotApplyLease, VaultSyncV2SnapshotPage, VaultSyncV2SnapshotSummary } from "./vault-sync-v2-remote.ts";

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
  /** 服务端发现当前 head 已是同一内容，安全地把重试视为成功。 */
  alreadyApplied?: boolean;
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
  managed_storage_only?: boolean;
  can_sync?: boolean;
  sync_storage_type?: string | null;
  quota_bytes: number;
  used_bytes: number;
  storage_credential_version?: string | null;
  storage_generation?: number | null;
  storage_switch_state?: "active" | "migrating" | string | null;
  storage_manager_device_name?: string | null;
  storage_credentials_updated_at?: string | null;
  storage_manager_is_current_device?: boolean;
  can_write: boolean;
  can_read: boolean;
  encryption?: {
    enabled: boolean;
    salt_hex: string | null;
    version: number;
    key_versions?: Array<{
      key_version: number;
      salt_hex: string;
      status: "active" | "retained" | "retired";
    }>;
  };
}

export interface VaultSyncClientOptions {
  apiBaseUrl: string;
  targetId: string;
  /** plugin token（用于 status / settings / registerDevice） */
  pluginToken: string;
  /** device token（用于 manifest / commit / download；首次启用前为空） */
  deviceToken?: string;
  /** Host-provided transport; host API modules are not dynamically resolvable. */
  requestTransport: (request: any) => Promise<any>;
  /** Keeps server-measured application latency in the current Obsidian process only. */
  onAppliedLatencyMs?: (durationMs: number) => void;
}

export class VaultSyncRemoteClient {
  private base: string;
  private targetId: string;
  private pluginToken: string;
  private deviceToken: string;
  private requestTransport: (request: any) => Promise<any>;
  private onAppliedLatencyMs?: (durationMs: number) => void;
  private v2: VaultSyncV2RemoteClient;

  constructor(opts: VaultSyncClientOptions) {
    this.base = opts.apiBaseUrl.replace(/\/$/, "");
    this.targetId = opts.targetId;
    this.pluginToken = opts.pluginToken;
    this.deviceToken = opts.deviceToken ?? "";
    if (typeof opts.requestTransport !== "function") {
      throw new Error("VaultSyncRemoteClient requires a host request transport");
    }
    this.requestTransport = opts.requestTransport;
    this.onAppliedLatencyMs = opts.onAppliedLatencyMs;
    this.v2 = new VaultSyncV2RemoteClient(this.targetId, (path, init) => this.request(path, init));
  }

  setDeviceToken(token: string) {
    this.deviceToken = token;
  }

  private async request(path: string, init: {
    method: string; token: "plugin" | "device"; body?: any; query?: Record<string, string>; headers?: Record<string, string>;
  }) {
    const url = new URL(`${this.base}${path}`);
    if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
    const token = init.token === "plugin" ? this.pluginToken : this.deviceToken;
    if (!token) throw new Error("vault sync 未授权：缺少 token");
    const resp = await this.requestTransport({
      url: url.toString(),
      method: init.method,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: init.body !== undefined ? JSON.stringify(init.body) : "",
      throw: false,
    });
    const retryAfterMs = getVaultSyncRetryAfterFromResponse(resp);
    const retryMetadata = retryAfterMs === null ? {} : { retryAfterMs };
    if (resp.status === 401) throw Object.assign(new Error("Vault 同步凭证已失效，请重新启用"), { status: resp.status });
    if (resp.status === 503) {
      const code = resp.json?.code ?? "vault_sync_disabled";
      throw Object.assign(new Error(resp.json?.error ?? "vault 同步暂未启用"), { code, status: resp.status, ...retryMetadata });
    }
    if (resp.status >= 400) {
      throw Object.assign(new Error(resp.json?.error ?? `vault sync 请求失败（${resp.status}）`), {
        code: resp.json?.code,
        status: resp.status,
        ...retryMetadata,
      });
    }
    return resp.json;
  }

  async getStatus(): Promise<VaultSyncStatus> {
    return this.request(`/api/sync-targets/${this.targetId}/vault/status`, { method: "GET", token: "plugin" });
  }

  async getCapabilities(): Promise<VaultSyncCapabilities> {
    return this.v2.getCapabilities();
  }

  async getV2DeviceProgress(): Promise<VaultSyncV2DeviceProgress> {
    return this.v2.getDeviceProgress();
  }

  async createOperationWindow(): Promise<VaultSyncOperationWindow> {
    return this.v2.createOperationWindow();
  }

  async startV2DeviceSession(): Promise<VaultSyncV2DeviceSession> {
    return this.v2.startDeviceSession();
  }

  async claimV2Initialization(protocolEpoch: number): Promise<VaultSyncV2Initialization> {
    return this.v2.claimInitialization(protocolEpoch);
  }

  async completeV2Initialization(input: { protocolEpoch: number; leaseId: string }): Promise<VaultSyncV2Initialization> {
    return this.v2.completeInitialization(input);
  }

  async createEventTicket() {
    return this.v2.createEventTicket();
  }

  async getV2Changes(input: { protocolEpoch: number; sessionGeneration: string; after: string; through?: string; limit?: number }): Promise<VaultSyncV2ChangePage> {
    return this.v2.getChanges(input);
  }

  async acknowledgeV2Changes(input: VaultSyncV2Ack): Promise<VaultSyncV2Ack> {
    const result = await this.v2.acknowledgeChanges(input);
    if (result.appliedLatencyMs !== undefined) this.onAppliedLatencyMs?.(result.appliedLatencyMs);
    return result;
  }

  async createV2Snapshot(input: { protocolEpoch: number; sessionGeneration: string; snapshotRequestId?: string }): Promise<VaultSyncV2SnapshotSummary> {
    return this.v2.createSnapshot(input);
  }

  async getV2SnapshotPage(input: { snapshotId: string; afterItem?: string; limit?: number }): Promise<VaultSyncV2SnapshotPage> {
    return this.v2.getSnapshotPage(input);
  }

  async renewV2Snapshot(snapshotId: string): Promise<{ snapshotId: string; expiresAt: string }> {
    return this.v2.renewSnapshot(snapshotId);
  }

  async acquireV2SnapshotApplyLease(snapshotId: string, input: {
    protocolEpoch: number; scopeVersion: number; sessionGeneration: string;
  }): Promise<VaultSyncV2SnapshotApplyLease> {
    return this.v2.acquireSnapshotApplyLease(snapshotId, input);
  }

  async renewV2SnapshotApplyLease(snapshotId: string, leaseId: string) {
    return this.v2.renewSnapshotApplyLease(snapshotId, leaseId);
  }

  async releaseV2SnapshotApplyLease(snapshotId: string, leaseId: string) {
    return this.v2.releaseSnapshotApplyLease(snapshotId, leaseId);
  }

  async completeV2Snapshot(snapshotId: string, input: {
    protocolEpoch: number; sessionGeneration: string; snapshotCursor: string; itemCount: number; applyLeaseId?: string;
  }): Promise<VaultSyncV2Ack> {
    return this.v2.completeSnapshot(snapshotId, input);
  }

  async commitOperation(request: VaultSyncV2Request): Promise<VaultSyncOperationResult> {
    return this.v2.commitOperation(request);
  }

  async reserveContentObject(input: { ciphertextHash: string; byteSize: number; keyVersion?: number }): Promise<VaultSyncV2ObjectReservation> {
    return this.v2.reserveContentObject(input);
  }

  async prepareContentObjects(items: Array<{ ciphertextHash: string; byteSize: number; keyVersion?: number }>) {
    return this.v2.prepareContentObjects(items);
  }

  async cancelContentObjectReservations(reservationIds: string[]) {
    return this.v2.cancelContentObjectReservations(reservationIds);
  }

  async finalizeContentObject(reservationId: string) {
    return this.v2.finalizeContentObject(reservationId);
  }

  async getContentObject(objectId: string): Promise<VaultSyncV2ObjectDownload> {
    return this.v2.getContentObject(objectId);
  }

  async getFileVersions(input: { fileId: string; beforeVersionNumber?: string; limit?: number }): Promise<VaultSyncV2FileVersionsPage> {
    return this.v2.getFileVersions(input);
  }

  async getFileVersionContent(fileId: string, versionId: string): Promise<VaultSyncV2ObjectDownload> {
    return this.v2.getFileVersionContent(fileId, versionId);
  }

  async startEncryptionKeyRotation(input: {
    operationId: string; sourceKeyVersion: number; sourceSaltHex: string;
    targetKeyVersion: number; targetSaltHex: string;
  }): Promise<VaultSyncV2EncryptionRotation> {
    return this.v2.startEncryptionKeyRotation(input);
  }

  async getEncryptionKeyRotation(rotationId: string): Promise<VaultSyncV2EncryptionRotation> {
    return this.v2.getEncryptionKeyRotation(rotationId);
  }

  async listEncryptionKeyRotationObjects(input: { rotationId: string; after?: string | null; limit?: number }): Promise<VaultSyncV2EncryptionRotationObjectPage> {
    return this.v2.listEncryptionKeyRotationObjects(input);
  }

  async getEncryptionRotationSourceContent(input: { rotationId: string; sourceObjectId: string }): Promise<VaultSyncV2ObjectDownload> {
    return this.v2.getEncryptionRotationSourceContent(input);
  }

  async prepareEncryptionRotationObject(input: {
    rotationId: string; sourceObjectId: string; operationId: string;
    ciphertextHash: string; byteSize: number; keyVersion: number;
  }): Promise<VaultSyncV2EncryptionRotationReservation> {
    return this.v2.prepareEncryptionRotationObject(input);
  }

  async finalizeEncryptionRotationObject(input: { rotationId: string; sourceObjectId: string; reservationId: string }) {
    return this.v2.finalizeEncryptionRotationObject(input);
  }

  async activateEncryptionKeyRotation(input: { rotationId: string; operationId: string }): Promise<VaultSyncV2EncryptionRotation> {
    return this.v2.activateEncryptionKeyRotation(input);
  }

  async completeEncryptionKeyRotation(rotationId: string) {
    return this.v2.completeEncryptionKeyRotation(rotationId);
  }

  async abortEncryptionKeyRotation(rotationId: string) {
    return this.v2.abortEncryptionKeyRotation(rotationId);
  }

  async getOperationReceipt(operationId: string): Promise<VaultSyncOperationResult | { operationId: string; receiptStatus: "unknown" | "expired" }> {
    return this.v2.getOperationReceipt(operationId);
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

  async commit(commits: Array<{ path: string; contentHash?: string | null; byteSize: number; storageByteSize?: number; uploadId?: string; mtimeMs: number; isDeleted?: boolean; expectedRevision?: number }>): Promise<{ results: CommitResult[] }> {
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
  async prepareUpload(contentHash: string, byteSize: number): Promise<{ storage_type: string; upload_url: string | null; upload_id?: string | null; upload_expires_at?: string | null; deduped: boolean }> {
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

  async getStorageSwitchStatus(jobId: string): Promise<{ storage: { items: Array<{ contentHash: string; status: string }>; expectedObjects: number; verifiedObjects: number } }> {
    return this.request("/api/plugin/storage/switch/status", {
      method: "GET", token: "plugin", query: { switch_job_id: jobId },
    });
  }

  async markStorageSwitchProgress(jobId: string, contentHash: string): Promise<void> {
    await this.request("/api/plugin/storage/switch/progress", {
      method: "POST", token: "plugin", body: { switch_job_id: jobId, content_hash: contentHash },
    });
  }
}

/** 把 ManifestItem[] 转成 path → FileEntity 的 Map，供 diff 用。 */
export function manifestAsMap(items: ManifestItem[]): Map<string, FileEntity> {
  const map = new Map();
  const portablePaths = new Map<string, string>();
  for (const item of items) {
    const n = normalizeVaultPath(item.path);
    if (!n) throw new Error(`远端存在非法路径：${String(item.path)}`);
    const portableKey = portableVaultPathKey(n)!;
    const previous = portablePaths.get(portableKey);
    if (previous && previous !== n) throw new Error(`远端存在跨平台路径冲突：${previous} 与 ${n}`);
    portablePaths.set(portableKey, n);
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
