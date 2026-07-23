import { unzipSync } from "fflate";
import {
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  type App,
} from "obsidian";
import { buildVaultPaths } from "./shared/vault-layout.mjs";
import {
  isSafePackagePath,
  validateWebclipManifest,
  verifyWebclipPackageFiles,
} from "./shared/feishu-package.mjs";
import { createEncryptedVaultStorage, createFreeS3Storage, createProHostedStorage, deriveS3Config, type VaultSyncStorage } from "./vault-sync-storage";
import { VaultSyncRemoteClient } from "./vault-sync-remote";
import { createPrevSyncStore } from "./vault-sync-local";
import { createVaultSyncOrchestrator } from "./vault-sync";
import { createVaultSyncRetryScheduler, isRetryableVaultSyncError } from "./vault-sync-retry";
import { sha256Hex } from "./shared/hash";
import { createVaultSyncCrypto } from "./shared/vault-sync-crypto";
import {
  assertBucketName,
  assertR2Endpoint,
  assertSha256,
  assertStoragePrefix,
  DEFAULT_API_BASE_URL,
  isTrustedApiUrl,
  isTrustedAuthorizationUrl,
  isTrustedStorageUrl,
  MAX_MANIFEST_BYTES,
  MAX_TASK_ENTRY_BYTES,
  MAX_TASK_PACKAGE_BYTES,
  MAX_TASK_PACKAGE_ENTRIES,
  normalizeApiBaseUrl,
} from "./shared/security";

interface WeTongbuSettings {
  apiBaseUrl: string;
  userId: string;
  syncTargetId: string;
  syncTargetName: string;
  authSecretSuffix: string;
  storageProvider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeySecretId: string;
  secretKeySecretId: string;
  rootFolder: string;
  processedTaskIds: string[];
  processedSourceUrls: string[];
  imageDeliveryMode: ImageDeliveryMode;
  vaultSyncEnabled: boolean;
  vaultSyncScope: VaultSyncScope;
  /** 首次双侧都有内容时的同步方向；ask 表示先让用户选择。 */
  vaultFirstSyncDirection: VaultFirstSyncDirection;
  /** SecretStorage key for the vault device token (一次一密)。 */
  vaultDeviceTokenSecretId: string;
  /** Stable per-installation identity; never use a platform name as identity. */
  vaultInstallationId: string;
  /** Server-side device row ID for the current installation. */
  vaultDeviceId: string;
  vaultEncryptionEnabled: boolean;
  vaultEncryptionSecretId: string;
  vaultEncryptionSaltHex: string;
  /** Pending account device authorization survives mobile backgrounding. */
  pendingDeviceCode: string;
  pendingDeviceVerificationUri: string;
}

type StorageProvider = "cloudflare_r2" | "aws_s3" | "aliyun_oss" | "tencent_cos";
type ImageDeliveryMode = "local" | "hosted_link";
type VaultSyncScope = "whole_vault" | "root_folder";
type VaultFirstSyncDirection = "ask" | "remote" | "local";

function currentDeviceName() {
  if (Platform.isIosApp) return "iOS";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  if (Platform.isMacOS) return "macOS";
  return "Obsidian";
}
type PersistedSettings = Partial<WeTongbuSettings> & {
  noteFolder?: string;
  attachmentFolder?: string;
};

const PROVIDER_DEFAULT_REGION: Record<StorageProvider, string> = {
  cloudflare_r2: "auto",
  aws_s3: "ap-southeast-1",
  aliyun_oss: "cn-hangzhou",
  tencent_cos: "ap-guangzhou",
};

const PROVIDER_LABEL: Record<StorageProvider, string> = {
  cloudflare_r2: "Cloudflare R2",
  aws_s3: "Amazon S3",
  aliyun_oss: "阿里云 OSS",
  tencent_cos: "腾讯云 COS",
};

function providerLabel(value: unknown) {
  return typeof value === "string" && value in PROVIDER_LABEL
    ? PROVIDER_LABEL[value as StorageProvider]
    : "对象存储";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

const HOSTED_MEDIA_LINK = /https:\/\/api\.wetongbu\.com\/m\/[0-9a-f]{8}-[0-9a-f-]{27}\/[a-f0-9]{64}/gi;

function imageExtension(body: Uint8Array, contentType: string) {
  const startsWith = (values: number[], offset = 0) => values.every((value, index) => body[offset + index] === value);
  const ascii = (offset: number, length: number) => new TextDecoder().decode(body.slice(offset, offset + length));
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith([0xff, 0xd8, 0xff])) return "jpg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "gif";
  if (ascii(8, 4) === "WEBP") return "webp";
  if (/image\/svg\+xml/i.test(contentType)) return "svg";
  if (/image\/avif/i.test(contentType)) return "avif";
  return "img";
}

const DEFAULT_SETTINGS: WeTongbuSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  userId: "",
  syncTargetId: "",
  syncTargetName: "",
  authSecretSuffix: "",
  storageProvider: "cloudflare_r2",
  endpoint: "",
  region: "auto",
  bucket: "",
  prefix: "WeTongbu",
  accessKeySecretId: "",
  secretKeySecretId: "",
  rootFolder: "微同步",
  processedTaskIds: [],
  processedSourceUrls: [],
  imageDeliveryMode: "local",
  vaultSyncEnabled: false,
  vaultSyncScope: "whole_vault",
  vaultFirstSyncDirection: "ask",
  vaultDeviceTokenSecretId: "",
  vaultInstallationId: "",
  vaultDeviceId: "",
  vaultEncryptionEnabled: false,
  vaultEncryptionSecretId: "",
  vaultEncryptionSaltHex: "",
  pendingDeviceCode: "",
  pendingDeviceVerificationUri: "",
};

async function ensureFolder(plugin: WeTongbuPlugin, folder: string) {
  const normalized = normalizePath(folder);
  let current = "";
  for (const part of normalized.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!plugin.app.vault.getAbstractFileByPath(current)) {
      await plugin.app.vault.createFolder(current);
    }
  }
}

async function uniqueNotePath(
  plugin: WeTongbuPlugin,
  folder: string,
  filename: string,
) {
  const base = filename.replace(/\.md$/i, "");
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? "" : `-${number}`;
    const candidate = normalizePath(`${folder}/${base}${suffix}.md`);
    if (!plugin.app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

/** POSIX vault paths without depending on Node's path module (mobile-safe). */
function relativeVaultPath(from: string, to: string): string {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common += 1;
  const up = fromParts.slice(common).map(() => "..");
  const down = toParts.slice(common);
  return [...up, ...down].join("/") || toParts.at(-1) || "";
}

export default class WeTongbuPlugin extends Plugin {
  settings: WeTongbuSettings = DEFAULT_SETTINGS;
  private syncing = false;
  pairingCode = "";
  pairingExpiresAt = "";
  vaultPairingCode = "";
  vaultPairingExpiresAt = "";
  recoveryToken = "";
  storageStatus = "";
  accountStatus = "未登录";
  accountLoggedIn = false;
  accountPlanType = "free";
  canHostImages = false;
  hostedMediaQuotaBytes = 0;
  hostedMediaUsedBytes = 0;
  lastSafeErrorCode = "";
  private vaultSyncing = false;
  private vaultDeviceTokenCache = "";
  private accountPollTimer: number | null = null;
  private vaultSyncRetry: ReturnType<typeof createVaultSyncRetryScheduler> | null = null;
  vaultEncryptionInput = "";

  async onload() {
    const saved = ((await this.loadData()) ?? {}) as PersistedSettings;
    const {
      noteFolder: _legacyNoteFolder,
      attachmentFolder: _legacyAttachmentFolder,
      ...currentSettings
    } = saved;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, currentSettings);
    // The API base is not a user-facing setting. Normalize old/manual data so
    // plugin credentials can never be sent to an arbitrary endpoint.
    this.settings.apiBaseUrl = normalizeApiBaseUrl(this.settings.apiBaseUrl);
    if (!this.settings.vaultInstallationId) {
      this.settings.vaultInstallationId = crypto.randomUUID();
    }
    await this.saveSettings();
    this.vaultSyncRetry = createVaultSyncRetryScheduler({
      run: () => this.runVaultSync(true),
    });
    void this.refreshAccountStatus();
    void this.resumeAccountLogin().catch(() => undefined);
    this.registerDomEvent(window, "focus", () => {
      void this.resumeAccountLogin().catch(() => undefined);
      this.vaultSyncRetry?.wake();
    });
    this.registerDomEvent(window, "online", () => { this.vaultSyncRetry?.wake(); });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (!document.hidden) {
        void this.resumeAccountLogin().catch(() => undefined);
        this.vaultSyncRetry?.wake();
      }
    });
    this.addSettingTab(new WeTongbuSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "微同步：立即同步", () => {
      void this.manualSync();
    });
    this.addCommand({
      id: "sync-now",
      name: "微同步：立即同步",
      callback: () => void this.manualSync(),
    });
    this.addCommand({
      id: "vault-sync-now",
      name: "Vault 多端同步：立即同步",
      callback: () => void this.runVaultSync(false),
    });
    this.app.workspace.onLayoutReady(() => {
      void this.ensureWorkspace();
      void this.syncNow(true);
      this.registerInterval(
        window.setInterval(() => void this.syncNow(true), 30_000),
      );
      // Vault 多端同步：60s 轮询，只在用户开启且已配置时运行。
      this.registerInterval(
        window.setInterval(() => { void this.runVaultSync(true); }, 60_000),
      );
    });
  }

  onunload() {
    if (this.accountPollTimer !== null) window.clearInterval(this.accountPollTimer);
    this.accountPollTimer = null;
    this.vaultSyncRetry?.clear();
    this.vaultSyncRetry = null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private pluginTokenSecretId() {
    return `wetongbu-plugin-${this.settings.authSecretSuffix}`;
  }

  private async registerCurrentVault() {
    if (this.settings.syncTargetId) throw new Error("当前 Vault 已注册");
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/activate`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        targetName: this.app.vault.getName(),
        deviceName: currentDeviceName(),
      }),
      throw: false,
    });
    if (response.status !== 201) throw new Error(response.json?.error ?? "Vault 注册失败");
    this.settings.authSecretSuffix = suffix;
    this.settings.userId = response.json.user_id;
    this.settings.syncTargetId = response.json.target_id;
    this.settings.syncTargetName = this.app.vault.getName();
    this.app.secretStorage.setSecret(this.pluginTokenSecretId(), response.json.plugin_token);
    this.recoveryToken = response.json.recovery_token;
    await this.saveSettings();
  }

  async recoverFreeVault(recoveryToken: string) {
    if (this.settings.syncTargetId) throw new Error("当前 Vault 已连接，无需恢复");
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/recover`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        recovery_token: recoveryToken.trim(),
        device_name: currentDeviceName(),
      }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "免费版恢复失败");
    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.settings.authSecretSuffix = suffix;
    this.settings.userId = response.json.user_id;
    this.settings.syncTargetId = response.json.target_id;
    this.settings.syncTargetName = response.json.target_name;
    this.app.secretStorage.setSecret(`wetongbu-plugin-${suffix}`, response.json.plugin_token);
    this.recoveryToken = response.json.recovery_token;

    const storageResponse = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/storage`,
      method: "GET",
      headers: { Authorization: `Bearer ${response.json.plugin_token}` },
      throw: false,
    });
    const storage = storageResponse.status === 200 ? storageResponse.json?.storage : null;
    if (storage) {
      if (typeof storage.provider === "string" && storage.provider in PROVIDER_LABEL) {
        this.settings.storageProvider = storage.provider as StorageProvider;
      }
      this.settings.endpoint = storage.endpoint ?? "";
      this.settings.region = storage.region ?? this.settings.region;
      this.settings.bucket = storage.bucket ?? "";
      this.settings.prefix = storage.prefix ?? "WeTongbu";
      this.storageStatus = `已恢复 · ${providerLabel(storage.provider)} · ${storage.bucket}`;
    }
    await this.saveSettings();
  }

  async rotateRecoveryToken() {
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!this.settings.syncTargetId || !token) throw new Error("当前 Vault 尚未连接");
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/recovery-token`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "恢复码生成失败");
    this.recoveryToken = response.json.recovery_token;
  }

  private async ensureCurrentVaultRegistered() {
    let token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (this.settings.syncTargetId && token) return token;
    if (this.settings.syncTargetId || token) {
      throw new Error("当前 Vault 连接信息不完整，请重新安装插件后恢复账号");
    }
    await this.registerCurrentVault();
    token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!token) throw new Error("Vault 注册完成，但未能保存插件凭证");
    return token;
  }

  async createBrowserPairingCode() {
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!this.settings.syncTargetId || !token) throw new Error("请先完成对象存储测试验证");
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/browser-bindings/codes`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 201) throw new Error(response.json?.error ?? "绑定码生成失败");
    this.pairingCode = response.json.code;
    this.pairingExpiresAt = response.json.expires_at;
  }

  private async adoptVaultTarget(userId: string, targetId: string, targetName: string, recoveryToken?: string) {
    const changed = this.settings.syncTargetId !== targetId;
    this.settings.userId = userId;
    this.settings.syncTargetId = targetId;
    this.settings.syncTargetName = targetName || this.settings.syncTargetName;
    if (recoveryToken) this.recoveryToken = recoveryToken;
    if (changed) {
      this.settings.vaultDeviceTokenSecretId = "";
      this.settings.vaultDeviceId = "";
      this.vaultDeviceTokenCache = "";
      await createPrevSyncStore(this.app).clear();
    }
    await this.saveSettings();
  }

  async createVaultDevicePairingCode() {
    const token = await this.ensureCurrentVaultRegistered();
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/vault-bindings/codes`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 201) throw new Error(response.json?.error ?? "多端加入码生成失败");
    this.vaultPairingCode = response.json.code;
    this.vaultPairingExpiresAt = response.json.expires_at;
  }

  async joinVaultByPairingCode(pairingCode: string) {
    const token = await this.ensureCurrentVaultRegistered();
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/vault-bindings/confirm`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: JSON.stringify({ code: pairingCode.trim() }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "加入 Vault 失败");
    await this.adoptVaultTarget(
      response.json.user_id,
      response.json.target_id,
      response.json.target_name,
      response.json.recovery_token,
    );
    await this.refreshAccountStatus();
  }

  async startAccountLogin() {
    const token = await this.ensureCurrentVaultRegistered();
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    const response = await requestUrl({
      url: `${base}/api/device-authorizations`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 201) throw new Error(response.json?.error ?? "登录授权申请失败");
    const authorization = response.json;
    if (!isTrustedAuthorizationUrl(authorization.verification_uri)) {
      throw new Error("登录授权地址不受信任");
    }
    const verification = new URL(authorization.verification_uri);
    verification.search = `?user_code=${encodeURIComponent(authorization.user_code)}`;
    const verificationUrl = verification.toString();
    window.open(verificationUrl, "_blank");
    this.settings.pendingDeviceCode = authorization.device_code;
    this.settings.pendingDeviceVerificationUri = verificationUrl;
    await this.saveSettings();
    this.accountStatus = "请在浏览器完成账号登录并确认授权";
    await this.resumeAccountLogin(base);
  }

  /** Poll once and keep polling in a lifecycle-safe interval. Mobile may
   * suspend the plugin while the browser approval page is in the foreground,
   * so the device code is persisted before polling starts. */
  private async resumeAccountLogin(base = this.settings.apiBaseUrl.replace(/\/$/, "")) {
    if (!this.settings.pendingDeviceCode) return;
    if (this.accountPollTimer === null) {
      this.accountPollTimer = window.setInterval(() => { void this.pollAccountLogin(base); }, 2000);
    }
    await this.pollAccountLogin(base);
  }

  private async pollAccountLogin(base: string) {
    const deviceCode = this.settings.pendingDeviceCode;
    if (!deviceCode) return;
    try {
      const polled = await requestUrl({
        url: `${base}/api/device-authorizations/token`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ device_code: deviceCode }),
        throw: false,
      });
      if (polled.status !== 200) throw new Error(polled.json?.error ?? "登录授权已失效");
      if (polled.json.status === "pending") return;
      if (!polled.json.plugin_token) throw new Error("登录授权响应无效");
      const previousTargetId = this.settings.syncTargetId;
      this.app.secretStorage.setSecret(this.pluginTokenSecretId(), polled.json.plugin_token);
      await this.adoptVaultTarget(
        polled.json.user_id,
        polled.json.target_id,
        polled.json.target_name ?? this.settings.syncTargetName,
      );
      if (previousTargetId !== polled.json.target_id) this.settings.vaultSyncEnabled = false;
      this.settings.pendingDeviceCode = "";
      this.settings.pendingDeviceVerificationUri = "";
      await this.saveSettings();
      if (this.accountPollTimer !== null) window.clearInterval(this.accountPollTimer);
      this.accountPollTimer = null;
      await this.refreshAccountStatus();
      if (!this.accountLoggedIn) throw new Error("账号状态读取失败，请重新登录");
    } catch (error) {
      if (this.accountPollTimer !== null) window.clearInterval(this.accountPollTimer);
      this.accountPollTimer = null;
      this.settings.pendingDeviceCode = "";
      this.settings.pendingDeviceVerificationUri = "";
      await this.saveSettings();
      this.accountStatus = `登录失败：${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  async refreshAccountStatus() {
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!this.settings.syncTargetId || !token) {
      this.accountLoggedIn = false;
      this.accountPlanType = "free";
      this.canHostImages = false;
      this.accountStatus = "未登录";
      return;
    }
    try {
      const response = await requestUrl({
        url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/account`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (response.status !== 200) {
        this.accountLoggedIn = false;
        this.accountPlanType = "free";
        this.canHostImages = false;
        this.accountStatus = "未登录（Free 可继续使用）";
        return;
      }
      const account = response.json?.account ?? {};
      this.accountLoggedIn = Boolean(account.email);
      this.accountPlanType = account.planType === "pro" ? "pro" : "free";
      this.accountStatus = this.accountLoggedIn
        ? `当前账号：${account.email} · ${account.planType === "pro" ? "Pro 托管版" : "Free 自有存储"}`
        : "未登录（Free 可继续使用）";
      await this.refreshImageDeliveryPreference(token);
    } catch {
      this.accountStatus = this.accountLoggedIn ? "已登录（账号状态暂时无法读取）" : "未登录（Free 可继续使用）";
    }
  }

  private async refreshImageDeliveryPreference(token?: string) {
    const pluginToken = token ?? this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!this.settings.syncTargetId || !pluginToken) return;
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/image-delivery`,
      method: "GET",
      headers: { Authorization: `Bearer ${pluginToken}` },
      throw: false,
    });
    if (response.status !== 200) {
      this.canHostImages = false;
      return;
    }
    const mode = response.json?.mode === "hosted_link" ? "hosted_link" : "local";
    const changed = this.settings.imageDeliveryMode !== mode;
    this.settings.imageDeliveryMode = mode;
    this.canHostImages = Boolean(response.json?.can_host_images);
    this.hostedMediaQuotaBytes = Number(response.json?.media_quota_bytes ?? 0);
    this.hostedMediaUsedBytes = Number(response.json?.media_used_bytes ?? 0);
    if (changed) await this.saveSettings();
  }

  async setImageDeliveryMode(mode: ImageDeliveryMode) {
    const token = await this.ensureCurrentVaultRegistered();
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/image-delivery`,
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: JSON.stringify({ mode }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "图片保存位置更新失败");
    this.settings.imageDeliveryMode = response.json?.mode === "hosted_link" ? "hosted_link" : "local";
    this.canHostImages = Boolean(response.json?.can_host_images);
    this.hostedMediaQuotaBytes = Number(response.json?.media_quota_bytes ?? this.hostedMediaQuotaBytes);
    this.hostedMediaUsedBytes = Number(response.json?.media_used_bytes ?? this.hostedMediaUsedBytes);
    await this.saveSettings();
  }

  async setVaultSyncEnabled(enabled: boolean) {
    let pluginToken = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (enabled && !this.settings.syncTargetId) {
      await this.registerCurrentVault();
      pluginToken = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    }
    if (!this.settings.syncTargetId || !pluginToken) {
      if (!enabled) {
        this.settings.vaultSyncEnabled = false;
        await this.saveSettings();
        return;
      }
      throw new Error("请先连接当前 Vault");
    }
    const remote = new VaultSyncRemoteClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      targetId: this.settings.syncTargetId,
      pluginToken,
    });
    const current = await remote.getStatus();
    const remoteEncryption = current.encryption;
    if (enabled && remoteEncryption?.enabled && remoteEncryption.salt_hex) {
      this.settings.vaultEncryptionEnabled = true;
      this.settings.vaultEncryptionSaltHex = remoteEncryption.salt_hex;
    }
    const result = await remote.enable(
      enabled,
      this.settings.vaultSyncScope,
      this.settings.vaultEncryptionEnabled
        ? { enabled: true, saltHex: this.settings.vaultEncryptionSaltHex, version: 1 }
        : undefined,
    );
    this.settings.vaultSyncEnabled = result.enabled;
    this.settings.vaultSyncScope = result.scope === "root_folder" ? "root_folder" : "whole_vault";
    if (result.encryption?.enabled && result.encryption.saltHex) {
      this.settings.vaultEncryptionEnabled = true;
      this.settings.vaultEncryptionSaltHex = result.encryption.saltHex;
    }
    if (!result.enabled) {
      this.vaultSyncRetry?.clear();
      this.settings.vaultDeviceTokenSecretId = "";
      this.settings.vaultDeviceId = "";
      this.vaultDeviceTokenCache = "";
    }
    await this.saveSettings();
  }

  async enableVaultEncryption(passphrase: string) {
    if (passphrase.length < 8) throw new Error("Vault 加密密码至少需要 8 个字符");
    const derived = await createVaultSyncCrypto(passphrase, this.settings.vaultEncryptionSaltHex || undefined);
    const secretId = this.settings.vaultEncryptionSecretId || `wetongbu-vault-encryption-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await this.app.secretStorage.setSecret(secretId, passphrase);
    this.settings.vaultEncryptionEnabled = true;
    this.settings.vaultEncryptionSecretId = secretId;
    this.settings.vaultEncryptionSaltHex = derived.saltHex;
    this.vaultEncryptionInput = "";
    await this.saveSettings();
    const token = this.settings.syncTargetId
      ? this.app.secretStorage.getSecret(this.pluginTokenSecretId())
      : null;
    if (token && this.settings.syncTargetId) {
      const remote = new VaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken: token,
      });
      await remote.enable(this.settings.vaultSyncEnabled, this.settings.vaultSyncScope, {
        enabled: true,
        saltHex: derived.saltHex,
        version: 1,
      });
    }
  }

  async disableVaultEncryption() {
    this.settings.vaultEncryptionEnabled = false;
    await this.saveSettings();
  }

  openAccountCenter() {
    window.open("https://app.wetongbu.com/account/", "_blank");
  }

  async migrateHostedImagesToLocal() {
    const root = normalizePath(this.settings.rootFolder);
    const assetFolder = normalizePath(`${root}/90_附件/云端图片`);
    let notes = 0;
    let images = 0;
    for (const note of this.app.vault.getMarkdownFiles()) {
      if (note.path !== root && !note.path.startsWith(`${root}/`)) continue;
      const original = await this.app.vault.cachedRead(note);
      const links = [...new Set(original.match(HOSTED_MEDIA_LINK) ?? [])];
      if (!links.length) continue;
      let markdown = original;
      for (const link of links) {
        if (!isTrustedApiUrl(link, this.settings.apiBaseUrl)) {
          throw new Error("云端图片链接不受信任");
        }
        const downloaded = await requestUrl({ url: link, method: "GET", throw: false });
        if (downloaded.status !== 200) throw new Error(`图片下载失败（${downloaded.status}）`);
        const body = new Uint8Array(downloaded.arrayBuffer);
        if (!body.length) throw new Error("图片下载为空");
        const headers = downloaded.headers ?? {};
        const contentType = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
        const filename = `${(await sha256Hex(new TextEncoder().encode(link))).slice(0, 24)}.${imageExtension(body, contentType)}`;
        const targetPath = normalizePath(`${assetFolder}/${filename}`);
        await ensureFolder(this, assetFolder);
        if (!(await this.app.vault.adapter.exists(targetPath))) {
          await this.app.vault.adapter.writeBinary(targetPath, toArrayBuffer(body));
          const written = await this.app.vault.adapter.stat(targetPath);
          if (!written || written.type !== "file" || written.size !== body.length) {
            throw new Error("本地图片写入校验失败");
          }
        }
        const localPath = relativeVaultPath(note.parent?.path ?? "", targetPath);
        markdown = markdown.split(link).join(localPath);
        images += 1;
      }
      if (markdown !== original) {
        await this.app.vault.modify(note, markdown);
        if (await this.app.vault.adapter.read(note.path) !== markdown) {
          throw new Error("本地 Markdown 写入校验失败");
        }
        notes += 1;
      }
    }
    return { notes, images };
  }

  async configureUserStorage(accessKeyInput: string, secretKeyInput: string) {
    const accessKeyId = accessKeyInput.trim();
    const secretAccessKey = secretKeyInput;
    if (!accessKeyId || !secretAccessKey) throw new Error("请先输入 Access Key 和 Secret Key");
    assertBucketName(this.settings.bucket);
    if (!this.settings.region) throw new Error("请先填写 Region");
    if (this.settings.storageProvider === "cloudflare_r2" && !this.settings.endpoint) {
      throw new Error("请先填写 R2 Endpoint");
    }
    if (this.settings.storageProvider === "cloudflare_r2") {
      this.settings.endpoint = assertR2Endpoint(this.settings.endpoint);
    }
    this.settings.prefix = assertStoragePrefix(this.settings.prefix);
    const accessKeySecretId = this.settings.accessKeySecretId || "wetongbu-storage-access-key-id";
    const secretKeySecretId = this.settings.secretKeySecretId || "wetongbu-storage-secret-access-key";
    const token = await this.ensureCurrentVaultRegistered();
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/storage`,
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: JSON.stringify({
        provider: this.settings.storageProvider,
        endpoint: this.settings.storageProvider === "cloudflare_r2"
          ? this.settings.endpoint
          : undefined,
        region: this.settings.region,
        bucket: this.settings.bucket,
        prefix: this.settings.prefix,
        remote_vault_name: this.app.vault.getName(),
        access_key_id: accessKeyId,
        secret_access_key: secretAccessKey,
      }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "对象存储测试失败");
    const resolved = response.json?.storage;
    if (resolved?.target_id && resolved.target_id !== this.settings.syncTargetId) {
      await this.adoptVaultTarget(
        resolved.user_id ?? this.settings.userId,
        resolved.target_id,
        resolved.target_name ?? this.settings.syncTargetName,
        resolved.recovery_token ?? undefined,
      );
    }
    this.settings.accessKeySecretId = accessKeySecretId;
    this.settings.secretKeySecretId = secretKeySecretId;
    this.app.secretStorage.setSecret(accessKeySecretId, accessKeyId);
    this.app.secretStorage.setSecret(secretKeySecretId, secretAccessKey);
    await this.saveSettings();
    this.storageStatus = resolved?.resolution === "adopted"
      ? `已找到远程 Vault · ${resolved.target_name ?? this.settings.syncTargetName}`
      : `连接正常 · ${providerLabel(resolved?.provider ?? this.settings.storageProvider)} · ${resolved?.bucket ?? this.settings.bucket}`;
  }

  /**
   * Vault 多端同步入口。由 60s 轮询或手动命令触发。
   * quiet=true 时静默；false 时弹 Notice。
   * 前置条件：vaultSyncEnabled + 已注册（syncTargetId）+ 有 plugin token + 有 user_s3 凭证。
   */
  async runVaultSync(quiet = false) {
    if (!this.settings.vaultSyncEnabled) return;
    if (!this.settings.syncTargetId) return;
    if (this.vaultSyncing) {
      if (!quiet) new Notice("Vault 同步正在运行");
      return;
    }
    this.vaultSyncing = true;
    try {
      const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
      if (!pluginToken) throw new Error("Vault 连接已失效，请重新连接");

      // 设备 token：首次启用时注册，之后从 SecretStorage 读。
      let deviceToken = this.vaultDeviceTokenCache
        || (this.settings.vaultDeviceTokenSecretId
          ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId)
          : "");
      if (!deviceToken) {
        const remote = new VaultSyncRemoteClient({
          apiBaseUrl: this.settings.apiBaseUrl,
          targetId: this.settings.syncTargetId,
          pluginToken,
        });
        const reg = await remote.registerDevice(currentDeviceName(), this.settings.vaultInstallationId);
        deviceToken = reg.token;
        const secretId = `wetongbu-vault-device-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
        await this.app.secretStorage.setSecret(secretId, deviceToken);
        this.settings.vaultDeviceTokenSecretId = secretId;
        this.settings.vaultDeviceId = reg.deviceId;
        this.vaultDeviceTokenCache = deviceToken;
        await this.saveSettings();
      }

      // 构造 remote 客户端（先建，Pro storage 需要它注入 prepare 回调）。
      const remote = new VaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken,
        deviceToken,
      });
      const status = await remote.getStatus();
      if (status.encryption?.enabled && status.encryption.salt_hex) {
        this.settings.vaultEncryptionEnabled = true;
        this.settings.vaultEncryptionSaltHex = status.encryption.salt_hex;
        await this.saveSettings();
      }

      // Pro 走托管存储（预签名 URL）；Free 直连用户自有 bucket（SigV4）。
      let storage: VaultSyncStorage;
      if (this.accountPlanType === "pro") {
        storage = createProHostedStorage({
          prepareUpload: async (hash, byteSize) => {
            const r = await remote.prepareUpload(hash, byteSize);
            return { uploadUrl: r.upload_url ?? null, deduped: !!r.deduped };
          },
          prepareDownload: async (hash) => {
            const r = await remote.prepareDownload(hash);
            return { downloadUrl: r.download_url ?? null };
          },
          verifyHash: !this.settings.vaultEncryptionEnabled,
        });
      } else {
        const accessKey = await this.app.secretStorage.getSecret(
          this.settings.accessKeySecretId || "wetongbu-storage-access-key-id",
        );
        const secretKey = await this.app.secretStorage.getSecret(
          this.settings.secretKeySecretId || "wetongbu-storage-secret-access-key",
        );
        if (!accessKey || !secretKey) {
          throw new Error("缺少对象存储凭证，请先在插件设置中验证并保存存储配置");
        }
        const s3cfg = deriveS3Config(
          this.settings.storageProvider, this.settings.endpoint, this.settings.region,
          this.settings.bucket, this.settings.prefix,
        );
        storage = createFreeS3Storage({
          endpoint: s3cfg.endpoint,
          region: s3cfg.region,
          bucket: this.settings.bucket,
          prefix: this.settings.prefix,
          accessKeyId: accessKey,
          secretAccessKey: secretKey,
          forcePathStyle: s3cfg.forcePathStyle,
          targetId: this.settings.syncTargetId,
          verifyHash: !this.settings.vaultEncryptionEnabled,
        });
      }

      if (this.settings.vaultEncryptionEnabled) {
        const passphrase = this.settings.vaultEncryptionSecretId
          ? await this.app.secretStorage.getSecret(this.settings.vaultEncryptionSecretId)
          : "";
        if (!passphrase) throw new Error("缺少 Vault 加密密码，请在当前设备输入并启用端到端加密");
        const vaultCrypto = await createVaultSyncCrypto(passphrase, this.settings.vaultEncryptionSaltHex);
        storage = createEncryptedVaultStorage(storage, vaultCrypto);
      }

      const store = createPrevSyncStore(this.app);
      const orchestrator = createVaultSyncOrchestrator({
        app: this.app,
        storage,
        remote,
        store,
        deviceId: this.settings.vaultDeviceId || this.settings.vaultInstallationId,
        rootFolder: this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined,
        bootstrapDirection: this.settings.vaultFirstSyncDirection === "ask"
          ? undefined
          : this.settings.vaultFirstSyncDirection,
        notify: quiet ? undefined : (msg) => new Notice(msg, 10000),
      });
      const result = await orchestrator.runOnce();
      if (result.aborted) {
        this.vaultSyncRetry?.clear();
      } else if (result.failed > 0 && result.failureMessages?.some(isRetryableVaultSyncError)) {
        this.vaultSyncRetry?.scheduleRetry();
      } else if (result.failed === 0) {
        this.vaultSyncRetry?.clear();
      }
      if (!quiet) {
        if (result.aborted) {
          new Notice("Vault 同步已中止，请检查后重试", 10000);
        } else if (result.failed > 0) {
          const reason = result.failureMessages?.[0];
          new Notice(`Vault 同步未完成：${result.failed} 个文件失败${reason ? `（${reason}）` : ""}，请重试`, 12000);
        } else {
          const total = result.uploaded + result.downloaded + result.deletedLocal + result.deletedRemote;
          if (total === 0 && result.conflicts === 0) {
            new Notice("Vault 同步完成：已是最新");
          } else {
            const parts: string[] = [];
            if (result.uploaded) parts.push(`上传 ${result.uploaded}`);
            if (result.downloaded) parts.push(`下载 ${result.downloaded}`);
            if (result.deletedLocal) parts.push(`本地删除 ${result.deletedLocal}`);
            if (result.deletedRemote) parts.push(`远端删除 ${result.deletedRemote}`);
            if (result.conflicts) parts.push(`冲突 ${result.conflicts}`);
            new Notice(`Vault 同步完成：${parts.join(" · ")}`, 8000);
            if (result.conflictPaths && result.conflictPaths.length) {
              new Notice(`已生成冲突副本：${result.conflictPaths.slice(0, 3).join(", ")}${result.conflictPaths.length > 3 ? " 等" : ""}`, 10000);
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastSafeErrorCode = "vault_sync_failed";
      if (isRetryableVaultSyncError(error)) this.vaultSyncRetry?.scheduleRetry();
      if (!quiet) new Notice(`Vault 同步失败：${message}`, 10000);
      console.error("WeTongbu vault sync failed", error);
    } finally {
      this.vaultSyncing = false;
    }
  }

  async syncNow(quiet = false) {
    if (this.syncing) {
      if (!quiet) new Notice("微同步正在运行");
      return;
    }
    this.syncing = true;
    try {
      const synced = await this.syncApiTasks();
      if (synced > 0) new Notice(`微同步：已同步 ${synced} 篇内容`);
      if (!quiet && synced === 0) new Notice("微同步：没有待同步文章");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastSafeErrorCode = "sync_failed";
      if (!quiet) new Notice(`微同步失败：${message}`, 10000);
      console.error("WeTongbu sync failed");
    } finally {
      this.syncing = false;
    }
  }

  /**
   * User-facing manual action. When Vault multi-device sync is enabled, run
   * both the article inbox and the local Vault sync without showing the
   * article-inbox "没有待同步文章" notice for an otherwise valid Vault run.
   */
  async manualSync() {
    const articleSyncQuiet = this.settings.vaultSyncEnabled;
    await this.syncNow(articleSyncQuiet);
    if (this.settings.vaultSyncEnabled) {
      await this.runVaultSync(false);
    }
  }

  openSupportReport() {
    const params = new URLSearchParams({
      source: "obsidian",
      version: this.manifest.version,
      platform: currentDeviceName(),
    });
    if (this.lastSafeErrorCode) params.set("error_code", this.lastSafeErrorCode);
    window.open(`https://wetongbu.com/support/report/?${params}`, "_blank", "noopener,noreferrer");
  }

  private async syncApiTasks() {
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!this.settings.syncTargetId || !token) return 0;
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    const listed = await requestUrl({
      url: `${base}/api/sync-targets/${this.settings.syncTargetId}/tasks`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    if (listed.status === 401) throw new Error("Vault 连接已失效，请重新连接");
    if (listed.status !== 200) throw new Error(listed.json?.error ?? "任务列表获取失败");
    let synced = 0;
    for (const item of listed.json.tasks ?? []) {
      if (this.settings.processedTaskIds.includes(item.task_id)) {
        await this.completeHostedTask(base, token, item.task_id);
        continue;
      }
      const downloaded = await requestUrl({ url: item.download_url, method: "GET", throw: false });
      if (downloaded.status !== 200) throw new Error(`任务下载失败（${downloaded.status}）`);
      const zipBytes = new Uint8Array(downloaded.arrayBuffer);
      const packageHash = await sha256Hex(zipBytes);
      if (packageHash !== item.content_hash) throw new Error("ZIP 校验失败：任务包哈希不一致");
      if (zipBytes.length !== item.file_size) throw new Error("ZIP 校验失败：任务包大小不一致");
      const task = await this.unpackWebclipTask(zipBytes);
      if (task.manifest.taskId !== item.task_id) throw new Error("manifest task_id 与服务器任务不一致");
      const imageLinks = item.image_delivery_mode === "hosted_link"
        ? await this.publishHostedImages(base, token, item.task_id)
        : {};
      await this.writeTask(task, imageLinks);
      this.settings.processedTaskIds.push(item.task_id);
      this.settings.processedTaskIds = this.settings.processedTaskIds.slice(-1000);
      await this.saveSettings();
      await this.completeHostedTask(base, token, item.task_id);
      synced += 1;
    }
    return synced;
  }

  private async completeHostedTask(base: string, token: string, taskId: string) {
    const response = await requestUrl({
      url: `${base}/api/sync-targets/${this.settings.syncTargetId}/tasks/${taskId}/complete`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "云端任务清理失败");
  }

  private async publishHostedImages(base: string, token: string, taskId: string) {
    const response = await requestUrl({
      url: `${base}/api/sync-targets/${this.settings.syncTargetId}/tasks/${taskId}/media/publish`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "云端图片保存失败");
    const links = response.json?.image_links;
    if (!links || typeof links !== "object" || Array.isArray(links)) throw new Error("云端图片链接响应无效");
    return links as Record<string, string>;
  }

  private async unpackWebclipTask(zipBytes: Uint8Array) {
    const entries = unzipSync(zipBytes);
    const entryNames = Object.keys(entries).filter((entry) => !entry.endsWith("/"));
    if (entryNames.some((entry) => !isSafePackagePath(entry))) throw new Error("ZIP 包含不安全路径");
    const manifestEntry = entries["manifest.json"];
    if (!manifestEntry) throw new Error("manifest.json 缺失");
    const manifest = validateWebclipManifest(JSON.parse(new TextDecoder().decode(manifestEntry)));
    const files = new Map<string, Uint8Array>();
    for (const record of manifest.files) {
      const entry = entries[record.path];
      if (!entry) throw new Error(`任务文件缺失：${record.path}`);
      files.set(record.path, entry);
    }
    await verifyWebclipPackageFiles(manifest, files);
    const allowed = new Set(["manifest.json", ...manifest.files.map((file: any) => file.path)]);
    if (entryNames.some((entry) => !allowed.has(entry))) throw new Error("ZIP 包含未声明文件");
    return {
      manifest: {
        taskId: manifest.task_id,
        title: manifest.title,
        sourceUrl: manifest.source_url,
        capturedAt: manifest.created_at,
      },
        markdown: new TextDecoder().decode(files.get(manifest.entry_file)!),
      assets: manifest.files
        .filter((file: any) => file.path.startsWith("assets/"))
        .map((file: any) => ({
          relativePath: file.path,
          body: files.get(file.path)!,
          kind: file.kind,
          contentType: file.content_type,
        })),
    };
  }

  private async ensureWorkspace() {
    const root = normalizePath(this.settings.rootFolder);
    await ensureFolder(this, `${root}/00_收件箱`);
    await ensureFolder(this, `${root}/10_已处理`);
    await ensureFolder(this, `${root}/90_附件`);
    const guides = [
      ["AGENTS.md", "# 微同步 AI 处理说明\n\n待完善。\n"],
      ["CLAUDE.md", "# 微同步 Claude 处理说明\n\n待完善。\n"],
    ];
    for (const [filename, content] of guides) {
      const target = normalizePath(`${root}/${filename}`);
      if (!this.app.vault.getAbstractFileByPath(target)) {
        await this.app.vault.create(target, content);
      }
    }
  }

  private async writeTask(task: any, imageLinks: Record<string, string> = {}) {
    const layout = buildVaultPaths({
      rootFolder: normalizePath(this.settings.rootFolder),
      title: task.manifest.title,
      capturedAt: task.manifest.capturedAt,
      taskId: task.manifest.taskId,
      assets: task.assets,
    });
    const noteFolder = normalizePath(layout.noteFolder);
    const taskAttachmentFolder = normalizePath(layout.attachmentFolder);
    await ensureFolder(this, noteFolder);

    let markdown = task.markdown;
    const assetPlans = task.assets.map((asset: any, index: number) => {
      const filename = layout.assetNames[index];
      const remoteLink = asset.kind === "image" ? imageLinks[asset.relativePath] : undefined;
      if (remoteLink) {
        markdown = markdown.split(`<${asset.relativePath}>`).join(`<${remoteLink}>`);
        markdown = markdown.split(asset.relativePath).join(remoteLink);
        return { asset, filename, targetPath: "", writeLocal: false };
      }
      const targetPath = normalizePath(`${taskAttachmentFolder}/${filename}`);
      const relativePath = relativeVaultPath(noteFolder, targetPath);
      markdown = markdown.split(`<${asset.relativePath}>`).join(relativePath);
      markdown = markdown.split(asset.relativePath).join(relativePath);
      return { asset, filename, targetPath, writeLocal: true };
    });
    const localAssetPlans = assetPlans.filter((plan: { writeLocal: boolean }) => plan.writeLocal);
    if (localAssetPlans.length) await ensureFolder(this, taskAttachmentFolder);
    markdown = markdown.replace(/^[\t ]+(?=(?:!\[|\[!\[))/gm, "");

    const notePath = await uniqueNotePath(
      this,
      noteFolder,
      layout.noteFilename,
    );
    let createdNote: TFile | null = null;
    let noteCreatedByThisAttempt = false;
    const assetsCreatedByThisAttempt: string[] = [];
    try {
      for (const { asset, filename, targetPath } of localAssetPlans) {
        if (!(await this.app.vault.adapter.exists(targetPath))) {
          assetsCreatedByThisAttempt.push(targetPath);
        }
        await this.app.vault.adapter.writeBinary(targetPath, toArrayBuffer(asset.body));
        const writtenAsset = await this.app.vault.adapter.stat(targetPath);
        if (!writtenAsset || writtenAsset.type !== "file" || writtenAsset.size !== asset.body.length) {
          throw new Error(`附件写入校验失败：${filename}`);
        }
      }

      const noteBase = layout.noteFilename.replace(/\.md$/i, "");
      const noteCandidates = this.app.vault.getFiles().filter((file) =>
        file.parent?.path === noteFolder
        && (file.basename === noteBase || file.basename.startsWith(`${noteBase}-`))
      );
      for (const candidate of noteCandidates) {
        if (await this.app.vault.cachedRead(candidate) === markdown) {
          createdNote = candidate;
          break;
        }
      }
      if (!createdNote) {
        createdNote = await this.app.vault.create(notePath, markdown);
        noteCreatedByThisAttempt = true;
      }
      const persistedMarkdown = await this.app.vault.adapter.read(createdNote.path);
      if (persistedMarkdown !== markdown) {
        throw new Error("本地 Markdown 写入校验失败");
      }
    } catch (error) {
      if (createdNote && noteCreatedByThisAttempt) await this.app.fileManager.trashFile(createdNote);
      for (const targetPath of assetsCreatedByThisAttempt) {
        const asset = this.app.vault.getAbstractFileByPath(targetPath);
        if (asset instanceof TFile) await this.app.fileManager.trashFile(asset);
      }
      throw error;
    }

    try {
      await this.app.workspace.getLeaf(false).openFile(createdNote);
    } catch (error) {
      console.warn("WeTongbu note saved but could not be opened");
    }
  }
}

class WeTongbuSettingTab extends PluginSettingTab {
  private accessKeyInput: string | null = null;
  private secretKeyInput: string | null = null;
  private recoveryTokenInput = "";
  private vaultPairingCodeInput = "";

  constructor(app: App, private plugin: WeTongbuPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.accessKeyInput ??= this.plugin.settings.accessKeySecretId
      ? this.app.secretStorage.getSecret(this.plugin.settings.accessKeySecretId) ?? ""
      : "";
    this.secretKeyInput ??= this.plugin.settings.secretKeySecretId
      ? this.app.secretStorage.getSecret(this.plugin.settings.secretKeySecretId) ?? ""
      : "";

    if (!this.plugin.settings.syncTargetId) {
      new Setting(containerEl)
        .setName("恢复已有免费版")
        .setDesc("更换设备或重装插件时，输入之前保存的免费版恢复码")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("请输入恢复码")
            .setValue(this.recoveryTokenInput)
            .onChange((value) => {
              this.recoveryTokenInput = value;
            });
        })
        .addButton((button) =>
          button.setButtonText("恢复免费版 Vault").onClick(async () => {
            try {
              await this.plugin.recoverFreeVault(this.recoveryTokenInput);
              this.recoveryTokenInput = "";
              this.display();
              new Notice("免费版 Vault 已恢复，请保存新的恢复码");
            } catch (error) {
              new Notice(`恢复失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          }),
        );
    }

    new Setting(containerEl)
      .setName("账号与 Pro")
      .setDesc(`${this.plugin.accountStatus}。登录 Pro 会在浏览器中完成账号登录和授权；Free 使用绑定码，不需要登录。`)
      .addButton((button) =>
        button.setButtonText(this.plugin.accountLoggedIn ? "更换账号" : "登录 Pro 账号")
          .onClick(async () => {
            try {
              button.setDisabled(true);
              await this.plugin.startAccountLogin();
              this.display();
              new Notice(this.plugin.accountLoggedIn
                ? "登录成功，可开始使用 Pro 试用"
                : "已打开授权页面，完成授权后插件会自动登录");
            } catch (error) {
              new Notice(`登录失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            } finally {
              button.setDisabled(false);
            }
          }),
      )
      .addButton((button) =>
        button.setButtonText("打开账号中心").onClick(() => this.plugin.openAccountCenter()),
      );

    new Setting(containerEl)
      .setName("电脑和手机自动同步")
      .setDesc("Free 版在每台设备填写相同的对象存储配置，并使用相同的 Vault 名称；测试并保存时会自动找到已有远程 Vault，不需要加入码。Pro 版登录后自动使用账号中的 Vault。");

    new Setting(containerEl)
      .setName("插件版本")
      .setDesc(`当前已加载：${this.plugin.manifest.version}`);

    if ((this.plugin.accountPlanType === "pro" && this.plugin.canHostImages)
      || this.plugin.settings.imageDeliveryMode === "hosted_link") {
      new Setting(containerEl)
        .setName("图片保存位置")
        .setDesc(this.plugin.canHostImages
          ? `本地下载保持默认；云端图片会写入稳定链接，不下载到本地。已使用 ${formatBytes(this.plugin.hostedMediaUsedBytes)} / ${formatBytes(this.plugin.hostedMediaQuotaBytes)}。请勿公开分享包含云端图片链接的笔记。`
          : "云端图片目前处于只读和转存宽限期：可以将已有图片下载回本地，但不能创建新的云端图片。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("local", "下载到 Obsidian 本地（默认）")
            .addOption("hosted_link", "保存在微同步云端，以链接插入笔记")
            .setValue(this.plugin.settings.imageDeliveryMode)
            .onChange(async (value) => {
              try {
                await this.plugin.setImageDeliveryMode(value as ImageDeliveryMode);
                this.display();
              } catch (error) {
                new Notice(`图片保存位置更新失败：${error instanceof Error ? error.message : String(error)}`, 10000);
                this.display();
              }
            }),
        )
        .addButton((button) =>
          button.setButtonText("将云端图片转存到本地").onClick(async () => {
            try {
              button.setDisabled(true);
              const result = await this.plugin.migrateHostedImagesToLocal();
              new Notice(`已转存 ${result.images} 张图片，更新 ${result.notes} 篇笔记`);
            } catch (error) {
              new Notice(`转存失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            } finally {
              button.setDisabled(false);
            }
          }),
        );
    } else {
      new Setting(containerEl)
        .setName("图片保存位置")
        .setDesc(this.plugin.accountLoggedIn
          ? "当前套餐使用本地下载。开通有效 Pro 后，可选择将图片保存在微同步云端，并在笔记中插入稳定链接。"
          : "图片会下载到 Obsidian 本地。登录并开通 Pro 后，可选择云端图片链接。");
    }

    new Setting(containerEl)
      .setName("存储服务")
      .setDesc("免费版使用你自己的私有对象存储；图片和附件仍保存到 Obsidian 本地")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("cloudflare_r2", "Cloudflare R2")
          .addOption("aws_s3", "Amazon S3")
          .addOption("aliyun_oss", "阿里云 OSS")
          .addOption("tencent_cos", "腾讯云 COS")
          .setValue(this.plugin.settings.storageProvider)
          .onChange(async (value) => {
            const provider = value as StorageProvider;
            this.plugin.settings.storageProvider = provider;
            this.plugin.settings.region = PROVIDER_DEFAULT_REGION[provider];
            this.plugin.storageStatus = "";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("配置提示")
      .setDesc(this.providerConfigurationGuide());

    if (this.plugin.settings.storageProvider === "cloudflare_r2") {
      this.textSetting("R2 S3 Endpoint", "从 R2 控制台复制；格式类似 https://<账户 ID>.r2.cloudflarestorage.com", "endpoint");
    }
    this.textSetting(
      "存储区域（Region）",
      this.regionDescription(),
      "region",
    );
    this.textSetting("存储桶（Bucket）", this.bucketDescription(), "bucket");
    this.textSetting("存储目录", "默认 WeTongbu，一般不需要修改", "prefix");

    new Setting(containerEl)
      .setName(this.accessKeyLabel())
      .setDesc(`输入从 ${providerLabel(this.plugin.settings.storageProvider)} 控制台获取的访问密钥 ID`)
      .addText((text) =>
        text
          .setPlaceholder("请输入访问密钥 ID")
          .setValue(this.accessKeyInput ?? "")
          .onChange((value) => {
            this.accessKeyInput = value;
            this.plugin.storageStatus = "";
          }),
      );

    new Setting(containerEl)
      .setName(this.secretKeyLabel())
      .setDesc(`输入从 ${providerLabel(this.plugin.settings.storageProvider)} 控制台获取的访问密钥；内容将安全保存`)
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("请输入访问密钥密码")
          .setValue(this.secretKeyInput ?? "")
          .onChange((value) => {
            this.secretKeyInput = value;
            this.plugin.storageStatus = "";
          });
      });

    new Setting(containerEl)
      .setName("测试验证")
      .setDesc(this.plugin.storageStatus || "保存上面的配置，并验证对象存储是否通畅；测试会写入、读取并删除一个临时文件")
      .addButton((button) =>
        button.setButtonText("测试并保存").onClick(async () => {
          try {
            await this.plugin.configureUserStorage(
              this.accessKeyInput ?? "",
              this.secretKeyInput ?? "",
            );
            this.display();
          } catch (error) {
            this.display();
            new Notice(`对象存储测试失败：${error instanceof Error ? error.message : String(error)}`, 10000);
          }
        }),
      );

    if (this.plugin.settings.syncTargetId) {
      const recoverySetting = new Setting(containerEl)
        .setName("免费版恢复")
        .setDesc(
          this.plugin.recoveryToken
            ? `请保存到安全位置，用于更换设备或重装插件：${this.plugin.recoveryToken}`
            : "生成恢复码并保存到安全位置；重新生成后旧恢复码立即失效",
        );
      recoverySetting.addButton((button) =>
        button
          .setButtonText(this.plugin.recoveryToken ? "重新生成" : "生成恢复码")
          .onClick(async () => {
            try {
              await this.plugin.rotateRecoveryToken();
              this.display();
              new Notice("已生成新的恢复码，旧恢复码已失效");
            } catch (error) {
              new Notice(`恢复码生成失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          }),
      );
    }

    new Setting(containerEl)
      .setName("不登录：绑定 Chrome")
      .setDesc(
        this.plugin.pairingCode
          ? `绑定码 ${this.plugin.pairingCode}，有效至 ${new Date(this.plugin.pairingExpiresAt).toLocaleTimeString()}`
          : "对象存储测试通过后，生成 6 位一次性绑定码，在 Chrome 扩展中完成绑定；这不需要登录账号",
      )
      .addButton((button) =>
        button.setButtonText("生成绑定码").onClick(async () => {
          try {
            await this.plugin.createBrowserPairingCode();
            this.display();
          } catch (error) {
            new Notice(`生成绑定码失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );

    this.textSetting("微同步目录", "文章、附件和 AI 说明文件的根目录", "rootFolder");

    new Setting(containerEl)
      .setName("Vault 多端同步")
      .setDesc("在多台设备间双向同步笔记内容（类 Remotely Save）。免费版直接使用你已配置的对象存储，内容不经过微同步服务器。同文件在两台设备都修改时生成冲突副本，不会静默覆盖。")
      .addToggle((toggle) =>
      toggle
          .setValue(this.plugin.settings.vaultSyncEnabled)
          .onChange(async (value) => {
            try {
              toggle.setDisabled(true);
              await this.plugin.setVaultSyncEnabled(value);
              if (value) {
                new Notice("Vault 多端同步已开启：将在后台检查并同步", 6000);
                void this.plugin.runVaultSync(false);
              } else {
                new Notice("Vault 多端同步已暂停");
              }
              this.display();
            } catch (error) {
              new Notice(`Vault 同步设置失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              toggle.setValue(this.plugin.settings.vaultSyncEnabled);
            } finally {
              toggle.setDisabled(false);
            }
          }),
      );

    if (this.plugin.settings.vaultSyncEnabled) {
      new Setting(containerEl)
        .setName("同步范围")
        .setDesc("选择要同步的范围。整个 Vault 会包含所有笔记；仅微同步目录只同步剪藏产生的内容。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("whole_vault", "整个 Vault（推荐）")
            .addOption("root_folder", `仅 ${this.plugin.settings.rootFolder} 目录`)
            .setValue(this.plugin.settings.vaultSyncScope)
            .onChange(async (value) => {
              this.plugin.settings.vaultSyncScope = value as VaultSyncScope;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("首次同步方向")
        .setDesc("仅在此设备第一次同步且本机已有文件时生效。选择从电脑下载到本机，或从本机上传到电脑；已有同步基线后不再使用。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("ask", "首次遇到时提醒我")
            .addOption("remote", "从电脑/云端下载到本机")
            .addOption("local", "从本机上传到电脑/云端")
            .setValue(this.plugin.settings.vaultFirstSyncDirection)
            .onChange(async (value) => {
              this.plugin.settings.vaultFirstSyncDirection = value as VaultFirstSyncDirection;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("立即同步")
        .setDesc("手动触发一次 Vault 多端同步")
        .addButton((button) =>
          button.setButtonText("立即同步").onClick(() => this.plugin.runVaultSync(false)),
        );

      new Setting(containerEl)
        .setName("端到端加密（可选）")
        .setDesc(this.plugin.settings.vaultEncryptionEnabled
          ? "已启用：笔记内容在本地加密后才上传。其他设备需要输入相同密码；忘记密码无法恢复云端内容。"
          : "启用后，微同步服务器和托管对象存储都不会看到笔记明文；请在每台设备输入相同密码。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("至少 8 个字符").setValue(this.plugin.vaultEncryptionInput)
            .onChange((value) => { this.plugin.vaultEncryptionInput = value; });
        })
        .addButton((button) => button
          .setButtonText(this.plugin.settings.vaultEncryptionEnabled ? "更新密码" : "启用加密")
          .onClick(async () => {
            try {
              await this.plugin.enableVaultEncryption(this.plugin.vaultEncryptionInput);
              this.display();
              new Notice("端到端加密已启用；请在其他设备输入相同密码");
            } catch (error) {
              new Notice(`加密设置失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          }))
        .addButton((button) => button
          .setButtonText("停用")
          .setDisabled(!this.plugin.settings.vaultEncryptionEnabled)
          .onClick(async () => {
            await this.plugin.disableVaultEncryption();
            this.display();
            new Notice("端到端加密已停用；已有云端文件仍保持加密，请先转存或继续使用原密码");
          }));
    }

    new Setting(containerEl)
      .setName("自动同步")
      .setDesc("插件启动时检查，并每 30 秒检查一次待同步任务");

    new Setting(containerEl)
      .setName("文章任务同步")
      .setDesc("立即检查飞书、网页和微信文章任务")
      .addButton((button) =>
        button.setButtonText("检查文章任务").onClick(() => this.plugin.syncNow()),
      );

    new Setting(containerEl)
      .setName("帮助与问题反馈")
      .setDesc(`微同步插件 ${this.plugin.manifest.version}。提交时只附带版本、操作系统和安全错误码，不会自动上传笔记、图片或密钥。`)
      .addButton((button) =>
        button.setButtonText("提交问题").onClick(() => this.plugin.openSupportReport()),
      );
  }

  private textSetting(
    name: string,
    description: string,
    key: keyof Pick<
      WeTongbuSettings,
      | "endpoint"
      | "region"
      | "bucket"
      | "prefix"
      | "rootFolder"
    >,
  ) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }

  private regionDescription() {
    switch (this.plugin.settings.storageProvider) {
      case "cloudflare_r2": return "Cloudflare R2 固定使用 auto";
      case "aws_s3": return "AWS Region，例如 ap-southeast-1";
      case "aliyun_oss": return "OSS Region，例如 cn-hangzhou；Endpoint 由微同步生成";
      case "tencent_cos": return "COS Region，例如 ap-guangzhou；Endpoint 由微同步生成";
    }
  }

  private providerConfigurationGuide() {
    switch (this.plugin.settings.storageProvider) {
      case "cloudflare_r2":
        return "创建微同步专用私有 Bucket，再创建只允许该 Bucket 读取、写入和删除对象的 API Token；无需 List Bucket 权限。";
      case "aws_s3":
        return "创建微同步专用私有 Bucket 和 IAM 访问密钥，只授权指定 Bucket/目录的 PutObject、GetObject、DeleteObject；无需 ListBucket。";
      case "aliyun_oss":
        return "创建微同步专用私有 Bucket 和 RAM 用户，只授权该 Bucket/目录的 PutObject、GetObject、DeleteObject；不要使用主账号密钥。";
      case "tencent_cos":
        return "创建微同步专用私有 Bucket 和 CAM 子用户，只授权该 Bucket/目录的 PutObject、GetObject、DeleteObject；Bucket 名必须带 APPID 后缀。";
    }
  }

  private bucketDescription() {
    if (this.plugin.settings.storageProvider === "tencent_cos") {
      return "微同步专用私有 Bucket，名称必须包含 APPID 后缀，例如 notes-1250000000";
    }
    return "专用于微同步的私有 Bucket";
  }

  private accessKeyLabel() {
    if (this.plugin.settings.storageProvider === "aliyun_oss") return "访问密钥 ID（AccessKey ID）";
    if (this.plugin.settings.storageProvider === "tencent_cos") return "访问密钥 ID（SecretId）";
    return "访问密钥 ID（Access Key ID）";
  }

  private secretKeyLabel() {
    if (this.plugin.settings.storageProvider === "aliyun_oss") return "访问密钥密码（AccessKey Secret）";
    if (this.plugin.settings.storageProvider === "tencent_cos") return "访问密钥密码（SecretKey）";
    return "访问密钥密码（Secret Access Key）";
  }
}
