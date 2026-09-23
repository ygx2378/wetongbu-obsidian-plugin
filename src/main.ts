import {
  addIcon,
  Modal,
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
import { validateWebclipManifest, verifyWebclipPackageFiles } from "./shared/feishu-package.mjs";
import { createEncryptedVaultStorage, createFreeS3Storage, createProHostedStorage, deriveS3Config, type VaultSyncStorage } from "./vault-sync-storage";
import { VaultSyncRemoteClient } from "./vault-sync-remote";
import { createPrevSyncStore } from "./vault-sync-local";
import { createCaptureHandoffStore, type CaptureHandoffStore } from "./capture-handoff";
import { selectCompletionNote, updateCompletionNoteMetadata } from "./completion-note";
import { assertCompletionTaskIdentity, normalizeCompletionSourceUrl } from "./completion-task-validation";
import { resolveAssetTarget } from "./asset-target";
import { replaceMarkdownDestination } from "./media-continuation";
import { completeLocalClipTaskWithRetry } from "./local-clip-completion";
import { unzipWebclipArchive } from "./webclip-zip";
import { createVaultSyncOrchestrator, type SyncResult } from "./vault-sync";
import { findDuplicateLocalFiles, type DeletionAction, type DeletionResolution } from "./vault-sync-deletion";
import { createVaultSyncRetryScheduler, isRetryableVaultSyncError } from "./vault-sync-retry";
import { sha256Hex } from "./shared/hash";
import { createVaultSyncCrypto } from "./shared/vault-sync-crypto";
import {
  articleCandidate,
  articleAssetFingerprintFromBodies,
  articleAssetFingerprintFromVault,
  ensureLocalClipFrontmatter,
  ensureGeneratedMarkers,
  isLegacyArticleCandidate,
  mergeArticleMarkdown,
  normalizeArticleBodyForCompare,
  normalizeArticleSourceUrl,
  splitMarkdownFrontmatter,
  stripGeneratedMarkers,
  type ArticleCandidate,
} from "./article-dedupe.ts";
import {
  assertBucketName,
  assertR2Endpoint,
  assertSha256,
  assertStoragePrefix,
  DEFAULT_API_BASE_URL,
  createAuthorizationUrl,
  isTrustedApiUrl,
  isTrustedAuthorizationUrl,
  isTrustedStorageUrl,
  normalizeApiBaseUrl,
  resolvePersistedApiBaseUrl,
  shouldResetEnvironmentCredentials,
} from "./shared/security";

interface WeTongbuSettings {
  apiBaseUrl: string;
  userId: string;
  syncTargetId: string;
  syncTargetName: string;
  authSecretSuffix: string;
  accountPlanType: "free" | "pro";
  storageProvider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeySecretId: string;
  secretKeySecretId: string;
  storageCredentialVersion: string;
  storageGeneration: number;
  /** Last activated provider/location. Form fields may contain a pending switch. */
  activeStorageProvider: StorageProvider;
  activeStorageEndpoint: string;
  activeStorageRegion: string;
  activeStorageBucket: string;
  activeStoragePrefix: string;
  pendingStorageSwitchJobId: string;
  pendingStorageProvider: StorageProvider | "";
  pendingStorageEndpoint: string;
  pendingStorageRegion: string;
  pendingStorageBucket: string;
  pendingStoragePrefix: string;
  pendingStorageAccessKeySecretId: string;
  pendingStorageSecretKeySecretId: string;
  storageManagerDeviceName: string;
  storageManagerIsCurrentDevice: boolean;
  storageCredentialsUpdatedAt: string;
  rootFolder: string;
  processedTaskIds: string[];
  processedSourceUrls: string[];
  imageDeliveryMode: ImageDeliveryMode;
  articleSyncIntervalSeconds: number;
  vaultSyncEnabled: boolean;
  /** Deprecated compatibility field; automatic enablement is disabled. */
  vaultSyncAutoEnablePending: boolean;
  /** Vault automatic sync interval in minutes; null means disabled. */
  vaultSyncIntervalMinutes: number | null;
  vaultSyncScope: VaultSyncScope;
  vaultSafetyEnabled: boolean;
  vaultSafetyRatio: number;
  /** 首次双侧都有内容时的同步方向；ask 表示先让用户选择。 */
  vaultFirstSyncDirection: VaultFirstSyncDirection;
  /** SecretStorage key for the vault device token (一次一密)。 */
  vaultDeviceTokenSecretId: string;
  /** Stable per-installation identity; never use a platform name as identity. */
  vaultInstallationId: string;
  /** Stable identity for this local Vault, retained across plugin reinstalls. */
  vaultIdentityId: string;
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
type VaultFirstSyncDirection = "ask" | "auto" | "remote" | "local";

function currentDeviceName() {
  if (Platform.isIosApp) return "iOS";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isWin) return "Windows";
  if (Platform.isLinux) return "Linux";
  if (Platform.isMacOS) return "macOS";
  return "Obsidian";
}

function currentDeviceClass(): "desktop" | "mobile" {
  return Platform.isIosApp || Platform.isAndroidApp ? "mobile" : "desktop";
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

const ARTICLE_SYNC_INTERVAL_OPTIONS = [15, 30, 60, 300] as const;
const VAULT_SYNC_INTERVAL_OPTIONS = [1, 5, 10, 20, 30] as const;
const VAULT_SAFETY_RATIO_OPTIONS = [0.3, 0.5, 0.7, 0.9, 1] as const;

const WETONGBU_RIBBON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <rect x="10" y="10" width="108" height="108" rx="30" stroke-width="10"/>
    <path d="M64 57 43 94 28 42" stroke-width="12"/>
    <path d="M64 57 85 94 100 42" stroke-width="12"/>
  </g>
  <path d="M19 25 42 31 25 47Z" fill="currentColor"/>
  <path d="M109 25 86 31 103 47Z" fill="currentColor"/>
</svg>`;

function normalizeArticleSyncInterval(value: unknown) {
  const numeric = Number(value);
  return ARTICLE_SYNC_INTERVAL_OPTIONS.includes(numeric as typeof ARTICLE_SYNC_INTERVAL_OPTIONS[number])
    ? numeric
    : 30;
}

function normalizeVaultSyncInterval(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === "unlimited") return null;
  const numeric = Number(value);
  return VAULT_SYNC_INTERVAL_OPTIONS.includes(numeric as typeof VAULT_SYNC_INTERVAL_OPTIONS[number])
    ? numeric
    : null;
}

function normalizeVaultSafetyRatio(value: unknown) {
  const numeric = Number(value);
  return VAULT_SAFETY_RATIO_OPTIONS.includes(numeric as typeof VAULT_SAFETY_RATIO_OPTIONS[number])
    ? numeric
    : 0.5;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

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

const DEFAULT_SETTINGS: WeTongbuSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  userId: "",
  syncTargetId: "",
  syncTargetName: "",
  authSecretSuffix: "",
  accountPlanType: "free",
  storageProvider: "cloudflare_r2",
  endpoint: "",
  region: "auto",
  bucket: "",
  prefix: "WeTongbu",
  accessKeySecretId: "",
  secretKeySecretId: "",
  storageCredentialVersion: "",
  storageGeneration: 1,
  activeStorageProvider: "cloudflare_r2",
  activeStorageEndpoint: "",
  activeStorageRegion: "auto",
  activeStorageBucket: "",
  activeStoragePrefix: "WeTongbu",
  pendingStorageSwitchJobId: "",
  pendingStorageProvider: "",
  pendingStorageEndpoint: "",
  pendingStorageRegion: "",
  pendingStorageBucket: "",
  pendingStoragePrefix: "",
  pendingStorageAccessKeySecretId: "",
  pendingStorageSecretKeySecretId: "",
  storageManagerDeviceName: "",
  storageManagerIsCurrentDevice: false,
  storageCredentialsUpdatedAt: "",
  rootFolder: "微同步",
  processedTaskIds: [],
  processedSourceUrls: [],
  imageDeliveryMode: "local",
  articleSyncIntervalSeconds: 30,
  vaultSyncEnabled: false,
  vaultSyncAutoEnablePending: false,
  vaultSyncIntervalMinutes: null,
  vaultSyncScope: "whole_vault",
  vaultSafetyEnabled: true,
  vaultSafetyRatio: 0.5,
  vaultFirstSyncDirection: "auto",
  vaultDeviceTokenSecretId: "",
  vaultInstallationId: "",
  vaultIdentityId: "",
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

function generatedImageReference(value: string) {
  const filename = value.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return /^WTB-\d{8}-\d{6}-[a-z0-9]{8}-\d{3}(?:\.[a-z0-9]+)?$/i.test(filename);
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
  accountStatus = "当前账号：未登录；登录后可使用多端同步";
  accountLoggedIn = false;
  accountPlanType: "free" | "pro" = "free";
  // User-managed object storage is retired. Keep the persisted compatibility
  // fields for non-destructive upgrades, but never use them to enable sync.
  accountLegacyFreeStorageCompat = false;
  accountCanVaultSync = false;
  canHostImages = false;
  hostedMediaQuotaBytes = 0;
  hostedMediaUsedBytes = 0;
  lastSafeErrorCode = "";
  private vaultSyncing = false;
  private vaultDeviceTokenCache = "";
  private accountPollTimer: number | null = null;
  private articleSyncTimer: number | null = null;
  private vaultSyncTimer: number | null = null;
  private articleSyncSchedulerStarted = false;
  private vaultSyncRetry: ReturnType<typeof createVaultSyncRetryScheduler> | null = null;
  private vaultSafetyOverrideFingerprint = "";
  private pendingDeletionReview: SyncResult | null = null;
  private storageSwitching = false;
  private captureHandoffs!: CaptureHandoffStore;
  private localClipImageQueue: Promise<void> = Promise.resolve();
  private settingTab: WeTongbuSettingTab | null = null;
  captureReceiverStatus: { device_name: string | null; is_current_device: boolean } | null = null;
  vaultEncryptionInput = "";
  private pluginTokenMissingNoticeShown = false;

  async onload() {
    this.captureHandoffs = createCaptureHandoffStore(this.app);
    const rawSaved = await this.loadData();
    const saved = (rawSaved ?? {}) as PersistedSettings;
    const {
      noteFolder: _legacyNoteFolder,
      attachmentFolder: _legacyAttachmentFolder,
      ...currentSettings
    } = saved;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, currentSettings);
    this.accountPlanType = this.settings.accountPlanType === "pro" ? "pro" : "free";
    // Versions before provider-switch migrations did not keep an immutable
    // active location. Backfill it once from the last saved form values.
    if (!Object.prototype.hasOwnProperty.call(currentSettings, "activeStorageProvider")
      && this.settings.storageCredentialVersion) {
      this.settings.activeStorageProvider = this.settings.storageProvider;
      this.settings.activeStorageEndpoint = this.settings.endpoint;
      this.settings.activeStorageRegion = this.settings.region;
      this.settings.activeStorageBucket = this.settings.bucket;
      this.settings.activeStoragePrefix = this.settings.prefix;
    }
    // Vault sync is always an explicit user choice. Older builds persisted a
    // pending auto-enable flag; clear it during upgrade so login/setup can
    // never turn the switch on implicitly.
    this.settings.vaultSyncAutoEnablePending = false;
    this.settings.articleSyncIntervalSeconds = normalizeArticleSyncInterval(this.settings.articleSyncIntervalSeconds);
    this.settings.vaultSyncIntervalMinutes = normalizeVaultSyncInterval(this.settings.vaultSyncIntervalMinutes);
    this.settings.vaultSafetyRatio = normalizeVaultSafetyRatio(this.settings.vaultSafetyRatio);
    // The API base is not a user-facing setting. Normalize old/manual data so
    // plugin credentials can never be sent to an arbitrary endpoint. When a
    // production build replaces a staging test build, also migrate the hidden
    // persisted staging value to production; Obsidian keeps data.json and
    // SecretStorage across plugin upgrades. Tokens and target IDs are scoped to
    // an API environment, so carrying them across environments would produce
    // an immediate 401 on the first login request.
    const persistedApiBaseUrl = normalizeApiBaseUrl(this.settings.apiBaseUrl);
    const resolvedApiBaseUrl = resolvePersistedApiBaseUrl(persistedApiBaseUrl);
    if (shouldResetEnvironmentCredentials(persistedApiBaseUrl)) {
      await this.resetEnvironmentScopedCredentials();
    }
    this.settings.apiBaseUrl = resolvedApiBaseUrl;
    if (!this.settings.vaultInstallationId) {
      this.settings.vaultInstallationId = crypto.randomUUID();
    }
    await this.ensureVaultIdentityId();
    await this.saveSettings();
    this.registerObsidianProtocolHandler("wetongbu-import", (params) => {
      void this.handleLocalClipImport(params as Record<string, unknown>);
    });
    this.vaultSyncRetry = createVaultSyncRetryScheduler({
      run: () => this.settings.vaultSyncIntervalMinutes === null
        ? Promise.resolve()
        : this.runVaultSync(true),
    });
    void this.refreshAccountStatus();
    void this.refreshCaptureReceiverStatus();
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
    this.settingTab = new WeTongbuSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    addIcon("wetongbu-sync", WETONGBU_RIBBON_ICON);
    this.addRibbonIcon("wetongbu-sync", "微同步：立即同步", () => {
      void this.manualSync();
    });
    this.addCommand({
      id: "sync-now",
      name: "微同步：立即同步",
      callback: () => void this.manualSync(),
    });
    this.addCommand({
      id: "vault-sync-now",
      name: "微同步：仅同步 Vault 文件（高级）",
      callback: () => void this.runVaultSync(false),
    });
    this.app.workspace.onLayoutReady(() => {
      this.articleSyncSchedulerStarted = true;
      void this.ensureWorkspace();
      void this.syncNow(true).then(() => this.recoverCaptureHandoffs());
      this.restartArticleSyncTimer();
      this.restartVaultSyncTimer();
    });
  }

  /**
   * Keep the Vault identity in the Vault itself so deleting/reinstalling the
   * plugin does not make the same local Vault look like a new one. The file
   * contains only a random UUID; no path or note content is sent to the API.
   */
  private async ensureVaultIdentityId() {
    const identityPath = ".wetongbu/vault-identity";
    const adapter = this.app.vault.adapter;
    let identity = "";
    if (await adapter.exists(identityPath)) {
      identity = (await adapter.read(identityPath)).trim();
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity)) {
      identity = this.settings.vaultIdentityId || crypto.randomUUID();
      if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
      await adapter.write(identityPath, identity);
    }
    this.settings.vaultIdentityId = identity;
  }

  onunload() {
    if (this.accountPollTimer !== null) window.clearInterval(this.accountPollTimer);
    this.accountPollTimer = null;
    if (this.articleSyncTimer !== null) window.clearInterval(this.articleSyncTimer);
    this.articleSyncTimer = null;
    if (this.vaultSyncTimer !== null) window.clearInterval(this.vaultSyncTimer);
    this.vaultSyncTimer = null;
    this.vaultSyncRetry?.clear();
    this.vaultSyncRetry = null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Receive a lightweight browser clip through obsidian://.  The claim token
   * is scoped to one temporary task and never becomes a plugin credential.
   * The note is written immediately; local image downloads happen afterwards
   * as part of this same handler and failures leave the original URL intact.
   */
  private async handleLocalClipImport(params: Record<string, unknown>) {
    const taskId = typeof params.taskId === "string" ? params.taskId : typeof params.task_id === "string" ? params.task_id : "";
    const claimToken = typeof params.token === "string" ? params.token : typeof params.claim_token === "string" ? params.claim_token : "";
    const requestedTargetId = typeof params.target === "string" ? params.target.trim() : "";
    const requestedVault = typeof params.vault === "string" ? params.vault.trim() : "";
    if (!taskId || !claimToken) {
      new Notice("微同步剪藏链接缺少任务凭证", 8000);
      return;
    }
    if (requestedTargetId && requestedTargetId !== this.settings.syncTargetId) {
      new Notice("剪藏任务属于另一个 Vault，当前 Vault 未写入。", 10000);
      return;
    }
    if (requestedTargetId && !this.settings.syncTargetId) {
      new Notice("当前 Vault 尚未连接账号，无法接收定向剪藏。", 10000);
      return;
    }
    if (requestedVault && requestedVault !== this.app.vault.getName()) {
      new Notice(`剪藏目标是 Vault“${requestedVault}”，当前打开的是“${this.app.vault.getName()}”，未写入当前 Vault。`, 10000);
      return;
    }
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    let articleWritten = false;
    try {
      const response = await requestUrl({
        url: `${base}/api/clip-tasks/${encodeURIComponent(taskId)}/claim`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ token: claimToken, ...(this.settings.syncTargetId ? { target_id: this.settings.syncTargetId } : {}) }),
        throw: false,
      });
      if (response.status !== 200) throw new Error(response.json?.error ?? "剪藏任务领取失败");
      const payload = response.json as {
        taskId: string;
        targetId?: string | null;
        title: string;
        sourceUrl: string;
        markdown: string;
        imageMode: "original" | "local" | "hosted";
        imageUrls?: Array<{ url: string; alt?: string }>;
      };
      if (payload.targetId && payload.targetId !== this.settings.syncTargetId) {
        new Notice("剪藏任务属于另一个 Vault，当前 Vault 未写入。", 10000);
        return;
      }
      const capturedAt = new Date().toISOString();
      // Lightweight local clips arrive without a ZIP manifest. Persist the
      // source metadata needed for dedupe, but keep implementation markers out
      // of the user-visible note.
      let markdown = ensureLocalClipFrontmatter(payload.markdown, {
        title: payload.title,
        sourceUrl: payload.sourceUrl,
        capturedAt,
        taskId: payload.taskId,
      });
      const imageUrls = payload.imageMode === "local" && Array.isArray(payload.imageUrls)
        ? payload.imageUrls.slice(0, 200)
        : [];
      // Write and open the note before touching remote images.  Image URLs are
      // intentionally kept in the first render so a slow/expired image cannot
      // delay the primary clipping experience.
      const written = await this.writeTask({
        manifest: {
          taskId: payload.taskId,
          title: payload.title,
          sourceUrl: payload.sourceUrl,
          capturedAt,
          operation: "create_new",
        },
        markdown,
        assets: [],
      }, {}, { preserveGeneratedMarkers: false });
      articleWritten = true;
      if (imageUrls.length) {
        new Notice(`文章已打开；${imageUrls.length} 张图片正在后台保存`, 6000);
        this.scheduleLocalClipImageProcessing({
          manifest: {
            taskId: payload.taskId,
            title: payload.title,
            sourceUrl: payload.sourceUrl,
            capturedAt,
          },
          markdown,
          assets: [],
        }, imageUrls, written.notePath);
      }
      let completionError: unknown;
      try {
        await completeLocalClipTaskWithRetry({
          complete: async () => {
            const response = await requestUrl({
              url: `${base}/api/clip-tasks/${encodeURIComponent(taskId)}/complete`,
              method: "POST",
              contentType: "application/json",
              body: JSON.stringify({ token: claimToken }),
              throw: false,
            });
            return { status: response.status, error: response.json?.error };
          },
        });
      } catch (error) {
        completionError = error;
        console.warn("WeTongbu local clip completion acknowledgement failed after retries", error);
      }
      if (completionError) {
        new Notice(imageUrls.length
          ? "文章已写入；图片已开始本地处理，但服务端暂未确认正文状态。"
          : "文章已写入；服务端未确认正文状态，云端图片续传可能无法启动。", 10000);
      } else if (!imageUrls.length) {
        new Notice(`已打开剪藏文章：${written.notePath}`, 6000);
      }
    } catch (error) {
      new Notice(articleWritten
        ? `文章已写入；剪藏后续处理失败：${error instanceof Error ? error.message : String(error)}`
        : `微同步剪藏失败：${error instanceof Error ? error.message : String(error)}`, 10000);
      console.error("WeTongbu local clip import failed", error);
    }
  }

  /**
   * Download local clip images after the note is visible.  Downloads within a
   * task run in parallel, while note/asset writes are serialized across tasks
   * to avoid two URI handoffs racing on the same source article.
   */
  private scheduleLocalClipImageProcessing(
    task: any,
    imageUrls: Array<{ url?: string; alt?: string }>,
    notePath: string,
  ) {
    const run = this.localClipImageQueue.then(async () => {
      const results = await Promise.all(imageUrls.map(async (image, index) => {
        if (!image?.url) return { index, asset: null, failed: false };
        try {
          const downloaded = await requestUrl({ url: image.url, method: "GET", throw: false });
          if (downloaded.status < 200 || downloaded.status >= 300 || !downloaded.arrayBuffer.byteLength) {
            throw new Error(`HTTP ${downloaded.status}`);
          }
          return {
            index,
            failed: false,
            asset: {
              relativePath: image.url,
              body: new Uint8Array(downloaded.arrayBuffer),
              kind: "image" as const,
              contentType: downloaded.headers["content-type"] ?? "image/*",
              clipIndex: index,
            },
          };
        } catch (error) {
          return {
            index,
            asset: null,
            failed: true,
            error: error instanceof Error ? error.message : "网络错误",
          };
        }
      }));
      const assets = results.flatMap((result) => result.asset ? [result.asset] : []);
      const failedImages = results.filter((result) => result.failed).length;
      const failureReason = results.find((result) => result.failed)?.error;
      if (!assets.length) {
        if (failedImages) new Notice(`文章已打开；${failedImages} 张图片下载失败${failureReason ? `（${failureReason}）` : ""}，已保留原文地址`, 10000);
        return;
      }
      try {
        await this.persistLocalClipImages(task, assets, notePath);
        if (failedImages) {
          new Notice(`图片已保存 ${assets.length} 张；${failedImages} 张下载失败${failureReason ? `（${failureReason}）` : ""}，已保留原文地址`, 10000);
        } else {
          new Notice(`文章图片已保存 ${assets.length} 张`, 6000);
        }
      } catch (error) {
        new Notice(`文章已打开；图片保存失败：${error instanceof Error ? error.message : String(error)}`, 10000);
        console.error("WeTongbu local clip image processing failed", error);
      }
    });
    this.localClipImageQueue = run.catch((error) => {
      console.error("WeTongbu local clip image queue failed", error);
    });
  }

  /**
   * Save downloaded images and rewrite only their references in the already
   * visible note.  Avoiding a second full article merge preserves edits the
   * user may make while the images are downloading.
   */
  private async persistLocalClipImages(task: any, assets: any[], notePath: string) {
    const note = this.app.vault.getAbstractFileByPath(notePath);
    if (!(note instanceof TFile)) throw new Error("剪藏文章已不存在，无法更新图片");
    const noteFolder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
    const layout = buildVaultPaths({
      rootFolder: normalizePath(this.settings.rootFolder),
      title: task.manifest.title,
      capturedAt: task.manifest.capturedAt,
      taskId: task.manifest.taskId,
      assets,
    });
    const attachmentFolder = normalizePath(layout.attachmentFolder);
    const plans: Array<{ asset: any; targetPath: string; writeLocal: boolean; relativePath: string }> = [];
    for (const [index, asset] of assets.entries()) {
      const desiredPath = normalizePath(`${attachmentFolder}/${layout.assetNames[index]}`);
      const resolved = await resolveAssetTarget(this.app.vault.adapter, desiredPath, new Uint8Array(asset.body));
      plans.push({
        asset,
        targetPath: resolved.targetPath,
        writeLocal: resolved.writeLocal,
        relativePath: relativeVaultPath(noteFolder, resolved.targetPath),
      });
    }
    if (plans.some((plan) => plan.writeLocal)) await ensureFolder(this, attachmentFolder);
    const created: string[] = [];
    try {
      for (const plan of plans) {
        if (!plan.writeLocal) continue;
        created.push(plan.targetPath);
        await this.app.vault.adapter.writeBinary(plan.targetPath, toArrayBuffer(new Uint8Array(plan.asset.body)));
        const persisted = await this.app.vault.adapter.stat(plan.targetPath);
        if (!persisted || persisted.type !== "file" || persisted.size !== plan.asset.body.length) {
          throw new Error(`附件写入校验失败：${plan.targetPath}`);
        }
      }
      const original = await this.app.vault.cachedRead(note);
      let updated = original;
      const sourceReferencesReplaced = new Set<number>();
      for (const [planIndex, plan] of plans.entries()) {
        const imageIndex = Number.isInteger(plan.asset.clipIndex) ? plan.asset.clipIndex : planIndex;
        const before = updated;
        updated = updated
          .split(`<${plan.asset.relativePath}>`).join(plan.relativePath)
          .split(plan.asset.relativePath).join(plan.relativePath);
        if (updated !== before) sourceReferencesReplaced.add(imageIndex);
      }
      // A note created by an older test plugin may already have replaced the
      // source URL with an extensionless generated WTB path.  The article
      // dedupe path intentionally reuses that note, so migrate only those
      // recognizable generated image references when the source URL is no
      // longer present.  User-authored local paths are left untouched.
      const imageReferencePattern = /!\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
      const legacyBySequence = new Map<number, string>();
      for (const match of updated.matchAll(imageReferencePattern)) {
        const raw = match[1] ?? "";
        const reference = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
        if (!generatedImageReference(reference)) continue;
        const sequence = /-(\d{3})(?:\.[a-z0-9]+)?$/i.exec(reference.replace(/\\/g, "/").split("/").at(-1) ?? "");
        if (sequence) legacyBySequence.set(Number(sequence[1]) - 1, reference);
      }
      for (const [planIndex, plan] of plans.entries()) {
        const imageIndex = Number.isInteger(plan.asset.clipIndex) ? plan.asset.clipIndex : planIndex;
        if (sourceReferencesReplaced.has(imageIndex)) continue;
        const legacy = legacyBySequence.get(imageIndex);
        if (!legacy) continue;
        updated = updated.split(`<${legacy}>`).join(plan.relativePath).split(legacy).join(plan.relativePath);
      }
      if (updated !== original) await writeTextAtomically(this.app, notePath, updated);
    } catch (error) {
      for (const path of created) {
        if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path).catch(() => {});
      }
      throw error;
    }
  }

  private restartArticleSyncTimer() {
    if (this.articleSyncTimer !== null) window.clearInterval(this.articleSyncTimer);
    this.articleSyncTimer = null;
    if (!this.articleSyncSchedulerStarted) return;
    this.articleSyncTimer = window.setInterval(
      () => { void this.syncNow(true); },
      this.settings.articleSyncIntervalSeconds * 1000,
    );
  }

  async setArticleSyncInterval(seconds: number) {
    this.settings.articleSyncIntervalSeconds = normalizeArticleSyncInterval(seconds);
    await this.saveSettings();
    this.restartArticleSyncTimer();
  }

  private restartVaultSyncTimer() {
    if (this.vaultSyncTimer !== null) window.clearInterval(this.vaultSyncTimer);
    this.vaultSyncTimer = null;
    const minutes = this.settings.vaultSyncIntervalMinutes;
    if (!this.articleSyncSchedulerStarted || !this.settings.vaultSyncEnabled || minutes === null) return;
    this.vaultSyncTimer = window.setInterval(
      () => { void this.runVaultSync(true); },
      minutes * 60 * 1000,
    );
  }

  async setVaultSyncInterval(minutes: number | null) {
    this.settings.vaultSyncIntervalMinutes = normalizeVaultSyncInterval(minutes);
    await this.saveSettings();
    this.restartVaultSyncTimer();
  }

  private hasConfiguredUserStorage() {
    return Boolean(
      this.settings.accessKeySecretId
      && this.settings.secretKeySecretId
      && this.settings.bucket
      && this.settings.region
      && (this.settings.storageProvider !== "cloudflare_r2" || this.settings.endpoint),
    );
  }

  private pluginTokenSecretId() {
    return `wetongbu-plugin-${this.settings.authSecretSuffix}`;
  }

  private async resetEnvironmentScopedCredentials() {
    if (this.settings.authSecretSuffix) {
      this.app.secretStorage.setSecret(this.pluginTokenSecretId(), "");
    }
    if (this.settings.vaultDeviceTokenSecretId) {
      this.app.secretStorage.setSecret(this.settings.vaultDeviceTokenSecretId, "");
    }
    this.settings.userId = "";
    this.settings.syncTargetId = "";
    this.settings.syncTargetName = "";
    this.settings.authSecretSuffix = "";
    this.settings.accountPlanType = "free";
    this.settings.vaultDeviceTokenSecretId = "";
    this.settings.vaultDeviceId = "";
    this.settings.vaultSyncEnabled = false;
    this.settings.pendingDeviceCode = "";
    this.settings.pendingDeviceVerificationUri = "";
    this.vaultDeviceTokenCache = "";
    this.accountLoggedIn = false;
    this.accountPlanType = "free";
    this.accountCanVaultSync = false;
    this.accountLegacyFreeStorageCompat = false;
    this.accountStatus = "当前账号：未登录；登录后可使用多端同步";
    await this.saveSettings();
  }

  async logoutAccount(): Promise<{ remoteRevoked: boolean }> {
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    let remoteRevoked = !token || !this.settings.syncTargetId;
    if (token && this.settings.syncTargetId) {
      const response = await requestUrl({
        url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/device/revoke`,
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        contentType: "application/json",
        body: "{}",
        throw: false,
      });
      if (response.status !== 200 && response.status !== 401) {
        throw new Error(response.json?.error ?? "退出账号失败");
      }
      remoteRevoked = true;
    }
    await this.resetEnvironmentScopedCredentials();
    this.recoveryToken = "";
    this.pairingCode = "";
    this.pairingExpiresAt = "";
    this.vaultPairingCode = "";
    this.vaultPairingExpiresAt = "";
    this.captureReceiverStatus = null;
    this.vaultSyncRetry?.clear();
    this.restartVaultSyncTimer();
    return { remoteRevoked };
  }

  hasPluginToken() {
    return Boolean(this.app.secretStorage.getSecret(this.pluginTokenSecretId()));
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
        device_class: currentDeviceClass(),
        vault_identity: this.settings.vaultIdentityId,
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
    this.captureReceiverStatus = null;
    void this.refreshCaptureReceiverStatus().catch(() => undefined);
  }

  async recoverFreeVault(recoveryToken: string) {
    if (this.settings.syncTargetId && this.hasPluginToken()) throw new Error("当前 Vault 已连接，无需恢复");
    const response = await requestUrl({
      url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/recover`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        recovery_token: recoveryToken.trim(),
        device_name: currentDeviceName(),
        device_class: currentDeviceClass(),
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
    this.pluginTokenMissingNoticeShown = false;

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
      this.settings.storageCredentialVersion = storage.credential_version ?? storage.id ?? "";
      this.settings.storageManagerDeviceName = storage.manager_device_name ?? "";
      this.settings.storageManagerIsCurrentDevice = Boolean(storage.manager_is_current_device);
      this.settings.storageCredentialsUpdatedAt = storage.storage_credentials_updated_at ?? storage.last_verified_at ?? "";
      this.storageStatus = `已恢复 · ${providerLabel(storage.provider)} · ${storage.bucket}`;
    }
    await this.saveSettings();
    this.captureReceiverStatus = null;
    void this.refreshCaptureReceiverStatus().catch(() => undefined);
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
      this.settings.vaultSyncEnabled = false;
      this.settings.vaultDeviceTokenSecretId = "";
      this.settings.vaultDeviceId = "";
      this.vaultDeviceTokenCache = "";
      await createPrevSyncStore(this.app).clear();
    }
    await this.saveSettings();
    if (changed) {
      this.captureReceiverStatus = null;
      void this.refreshCaptureReceiverStatus().catch(() => undefined);
    }
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
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    // A fresh plugin installation in a different local Obsidian Vault must
    // claim that Vault as a distinct account target. Joining another device to
    // an existing Vault is handled by the dedicated Vault pairing flow.
    // The authorization page can still explicitly create a new Vault, but a
    // fresh install should default to reusing the existing Vault identity or
    // choosing an existing same-name target instead of forcing a duplicate.
    let createsNewVault = false;
    let response = token && this.settings.syncTargetId
      ? await requestUrl({
        url: `${base}/api/device-authorizations`,
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        contentType: "application/json",
        body: JSON.stringify({ vault_identity: this.settings.vaultIdentityId }),
        throw: false,
      })
      : !token && this.settings.syncTargetId
        ? await requestUrl({
          url: `${base}/api/device-authorizations/reconnect`,
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({
            target_id: this.settings.syncTargetId,
            device_name: currentDeviceName(),
            device_class: currentDeviceClass(),
            vault_identity: this.settings.vaultIdentityId,
          }),
          throw: false,
        })
        : await (async () => {
          const registeredToken = await this.ensureCurrentVaultRegistered();
          return requestUrl({
            url: `${base}/api/device-authorizations`,
            method: "POST",
            headers: { Authorization: `Bearer ${registeredToken}` },
            contentType: "application/json",
            body: JSON.stringify({ vault_identity: this.settings.vaultIdentityId }),
            throw: false,
          });
        })();
    // A 0.11.14 upgrade may already have rewritten apiBaseUrl to production
    // while leaving a staging token behind. Re-register once when production
    // rejects that token, so users do not have to delete the plugin manually.
    if (response.status === 401 && token && this.settings.syncTargetId) {
      await this.resetEnvironmentScopedCredentials();
      createsNewVault = false;
      const registeredToken = await this.ensureCurrentVaultRegistered();
      response = await requestUrl({
        url: `${base}/api/device-authorizations`,
        method: "POST",
        headers: { Authorization: `Bearer ${registeredToken}` },
        contentType: "application/json",
        body: JSON.stringify({ vault_identity: this.settings.vaultIdentityId }),
        throw: false,
      });
    }
    if (response.status !== 201) throw new Error(response.json?.error ?? "登录授权申请失败");
    const authorization = response.json;
    if (!isTrustedAuthorizationUrl(authorization.verification_uri)) {
      throw new Error("登录授权地址不受信任");
    }
    const verificationUrl = createAuthorizationUrl(
      authorization.verification_uri,
      authorization.user_code,
      this.settings.apiBaseUrl,
      createsNewVault,
    );
    if (typeof authorization.target_id === "string" && authorization.target_id) {
      verificationUrl.searchParams.set("target_id", authorization.target_id);
    }
    if (typeof authorization.preferred_target_id === "string" && authorization.preferred_target_id) {
      verificationUrl.searchParams.set("preferred_target_id", authorization.preferred_target_id);
    }
    if (typeof authorization.target_name === "string" && authorization.target_name) {
      verificationUrl.searchParams.set("vault_name", authorization.target_name);
    }
    const verificationUrlString = verificationUrl.toString();
    this.settings.pendingDeviceCode = authorization.device_code;
    this.settings.pendingDeviceVerificationUri = verificationUrlString;
    // Persist the polling state before handing control to the browser. On
    // mobile and some desktop window managers opening the external page can
    // suspend or reload Obsidian immediately; saving afterwards loses the
    // only device code and makes a successful browser approval look stuck.
    await this.saveSettings();
    window.open(verificationUrlString, "_blank");
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
      this.settingTab?.refreshFromPlugin();
      if (!this.accountLoggedIn) throw new Error("账号状态读取失败，请重新登录");
      new Notice(`登录成功：${this.accountStatus.replace(/^当前账号：/, "")}`, 8000);
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
      this.accountPlanType = this.settings.accountPlanType = "free";
      this.accountLegacyFreeStorageCompat = false;
      this.accountCanVaultSync = false;
      this.canHostImages = false;
      this.accountStatus = "当前账号：未登录；登录后可使用多端同步";
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
        this.accountPlanType = this.settings.accountPlanType = "free";
        this.accountLegacyFreeStorageCompat = false;
        this.accountCanVaultSync = false;
        this.canHostImages = false;
        this.accountStatus = "当前账号：未登录；登录后可使用多端同步";
        return;
      }
      const account = response.json?.account ?? {};
      this.accountLoggedIn = Boolean(account.email);
      const capabilities = account.capabilities && typeof account.capabilities === "object"
        ? account.capabilities
        : null;
      const plusActive = account.capabilities?.plusActive === true
        || (account.effectivePlan === "plus" && account.subscriptionStatus !== "expired");
      this.accountLegacyFreeStorageCompat = capabilities
        ? capabilities.legacyFreeStorageCompat === true
        : false;
      this.accountCanVaultSync = this.accountLoggedIn
        && (capabilities ? capabilities.canVaultSync === true : plusActive);
      this.accountPlanType = plusActive ? "pro" : "free";
      this.settings.accountPlanType = this.accountPlanType;
      this.accountStatus = this.accountLoggedIn
        ? `当前账号：${account.email}，${plusActive ? "Plus" : "免费账号"}`
        : "当前账号：未登录；登录后可使用多端同步";
      await this.refreshImageDeliveryPreference(token);
      await this.saveSettings();
    } catch {
      this.accountStatus = this.accountLoggedIn ? this.accountStatus : "当前账号：未登录；登录后可使用多端同步";
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
    if (enabled && (!this.accountLoggedIn || !this.accountCanVaultSync)) {
      throw new Error(this.accountLoggedIn
        ? "当前账号暂未开放 Vault 多端同步，请开通对应权益"
        : "请先登录账号后再开启 Vault 多端同步");
    }
    let pluginToken = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (enabled && !this.settings.syncTargetId) {
      await this.registerCurrentVault();
      pluginToken = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    }
    if (!this.settings.syncTargetId || !pluginToken) {
      if (!enabled) {
        this.settings.vaultSyncEnabled = false;
        this.settings.vaultSyncAutoEnablePending = false;
        await this.saveSettings();
        this.restartVaultSyncTimer();
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
    this.settings.vaultSyncAutoEnablePending = false;
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
    this.restartVaultSyncTimer();
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

  openPromotionCenter() {
    window.open("https://app.wetongbu.com/account/gift-cards", "_blank");
  }

  async configureUserStorage(accessKeyInput: string, secretKeyInput: string): Promise<"verified" | "migration_pending"> {
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
        device_class: currentDeviceClass(),
        access_key_id: accessKeyId,
        secret_access_key: secretAccessKey,
      }),
      throw: false,
    });
    if (response.status !== 200 && response.status !== 202) throw new Error(response.json?.error ?? "对象存储测试失败");
    const resolved = response.json?.storage;
    if (response.status === 202 && resolved?.resolution === "migration_pending") {
      const pendingAccessKeySecretId = `wetongbu-pending-access-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const pendingSecretKeySecretId = `wetongbu-pending-secret-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await this.app.secretStorage.setSecret(pendingAccessKeySecretId, accessKeyId);
      await this.app.secretStorage.setSecret(pendingSecretKeySecretId, secretAccessKey);
      this.settings.pendingStorageSwitchJobId = resolved.switch_job_id;
      this.settings.pendingStorageProvider = this.settings.storageProvider;
      this.settings.pendingStorageEndpoint = this.settings.endpoint;
      this.settings.pendingStorageRegion = this.settings.region;
      this.settings.pendingStorageBucket = this.settings.bucket;
      this.settings.pendingStoragePrefix = this.settings.prefix;
      this.settings.pendingStorageAccessKeySecretId = pendingAccessKeySecretId;
      this.settings.pendingStorageSecretKeySecretId = pendingSecretKeySecretId;
      await this.saveSettings();
      this.storageStatus = "对象存储已验证，正在迁移 Vault 内容；迁移完成前不会切换活动存储";
      await this.runStorageSwitch(false);
      return "migration_pending";
    }
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
    this.settings.storageCredentialVersion = resolved?.credential_version ?? resolved?.id ?? "";
    this.settings.storageGeneration = Number(resolved?.storage_generation ?? this.settings.storageGeneration ?? 1);
    this.settings.activeStorageProvider = this.settings.storageProvider;
    this.settings.activeStorageEndpoint = this.settings.endpoint;
    this.settings.activeStorageRegion = this.settings.region;
    this.settings.activeStorageBucket = this.settings.bucket;
    this.settings.activeStoragePrefix = this.settings.prefix;
    this.settings.storageManagerDeviceName = resolved?.manager_device_name ?? "";
    this.settings.storageManagerIsCurrentDevice = Boolean(resolved?.manager_is_current_device);
    this.settings.storageCredentialsUpdatedAt = resolved?.storage_credentials_updated_at ?? resolved?.last_verified_at ?? "";
    await this.saveSettings();
    this.storageStatus = resolved?.resolution === "adopted"
      ? `已找到远程 Vault · ${resolved.target_name ?? this.settings.syncTargetName}`
      : `连接正常 · ${providerLabel(resolved?.provider ?? this.settings.storageProvider)} · ${resolved?.bucket ?? this.settings.bucket}`;
    return "verified";
  }

  /** Copy the content-addressed Vault blocks before activating a new Free
   * provider. Browser tasks keep using their snapshotted old config until the
   * server-side completion call atomically changes the active config. */
  async runStorageSwitch(quiet = false) {
    if (this.storageSwitching || !this.settings.pendingStorageSwitchJobId) return;
    this.storageSwitching = true;
    const jobId = this.settings.pendingStorageSwitchJobId;
    let completionAttempted = false;
    try {
      const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
      if (!pluginToken) throw new Error("Vault 连接已失效，请重新连接后重试对象存储切换");
      const activeProvider = this.settings.activeStorageProvider || this.settings.storageProvider;
      const activeEndpoint = this.settings.activeStorageEndpoint || this.settings.endpoint;
      const activeRegion = this.settings.activeStorageRegion || this.settings.region;
      const activeBucket = this.settings.activeStorageBucket || this.settings.bucket;
      const activePrefix = this.settings.activeStoragePrefix || this.settings.prefix;
      const activeAccess = await this.app.secretStorage.getSecret(this.settings.accessKeySecretId || "wetongbu-storage-access-key-id");
      const activeSecret = await this.app.secretStorage.getSecret(this.settings.secretKeySecretId || "wetongbu-storage-secret-access-key");
      const pendingAccess = await this.app.secretStorage.getSecret(this.settings.pendingStorageAccessKeySecretId);
      const pendingSecret = await this.app.secretStorage.getSecret(this.settings.pendingStorageSecretKeySecretId);
      if (!activeAccess || !activeSecret || !pendingAccess || !pendingSecret) {
        throw new Error("对象存储切换凭证不完整，请重新在电脑上测试并保存");
      }
      const createStorage = (provider: StorageProvider, endpoint: string, region: string, bucket: string, prefix: string, accessKeyId: string, secretAccessKey: string) => {
        const s3cfg = deriveS3Config(provider, endpoint, region, bucket, prefix);
        let storage: VaultSyncStorage = createFreeS3Storage({
          endpoint: s3cfg.endpoint, region: s3cfg.region, bucket, prefix,
          accessKeyId, secretAccessKey, forcePathStyle: s3cfg.forcePathStyle,
          targetId: this.settings.syncTargetId, verifyHash: !this.settings.vaultEncryptionEnabled,
        });
        return storage;
      };
      let sourceStorage = createStorage(activeProvider, activeEndpoint, activeRegion, activeBucket, activePrefix, activeAccess, activeSecret);
      let targetStorage = createStorage(
        this.settings.pendingStorageProvider as StorageProvider,
        this.settings.pendingStorageEndpoint,
        this.settings.pendingStorageRegion,
        this.settings.pendingStorageBucket,
        this.settings.pendingStoragePrefix,
        pendingAccess,
        pendingSecret,
      );
      if (this.settings.vaultEncryptionEnabled) {
        const passphrase = this.settings.vaultEncryptionSecretId
          ? await this.app.secretStorage.getSecret(this.settings.vaultEncryptionSecretId)
          : "";
        if (!passphrase) throw new Error("缺少 Vault 加密密码，无法迁移加密内容");
        const vaultCrypto = await createVaultSyncCrypto(passphrase, this.settings.vaultEncryptionSaltHex);
        sourceStorage = createEncryptedVaultStorage(sourceStorage, vaultCrypto);
        targetStorage = createEncryptedVaultStorage(targetStorage, vaultCrypto);
      }

      let copied = 0;
      const hashes = new Set<string>();
      const verifiedHashes = new Set<string>();
      let switchRemote: VaultSyncRemoteClient | undefined;
      if (this.settings.vaultSyncEnabled) {
        let deviceToken = this.vaultDeviceTokenCache
          || (this.settings.vaultDeviceTokenSecretId
            ? (await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId) ?? "")
            : "");
        const registerRemote = new VaultSyncRemoteClient({
          apiBaseUrl: this.settings.apiBaseUrl,
          targetId: this.settings.syncTargetId,
          pluginToken,
          deviceToken,
        });
        if (!deviceToken) {
          const reg = await registerRemote.registerDevice(currentDeviceName(), this.settings.vaultInstallationId);
          deviceToken = reg.token;
          const secretId = `wetongbu-vault-device-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
          await this.app.secretStorage.setSecret(secretId, deviceToken);
          this.settings.vaultDeviceTokenSecretId = secretId;
          this.settings.vaultDeviceId = reg.deviceId;
          this.vaultDeviceTokenCache = deviceToken;
          await this.saveSettings();
        }
        const remote = new VaultSyncRemoteClient({
          apiBaseUrl: this.settings.apiBaseUrl,
          targetId: this.settings.syncTargetId,
          pluginToken,
          deviceToken,
        });
        let switchStatus: Awaited<ReturnType<VaultSyncRemoteClient["getStorageSwitchStatus"]>> | null = null;
        try {
          switchStatus = await remote.getStorageSwitchStatus(jobId);
        } catch {
          // Older servers did not expose itemized migration status. The
          // manifest fallback is safe because commits are blocked while the
          // storage switch is in progress.
        }
        if (switchStatus?.storage?.items) {
          for (const item of switchStatus.storage.items) {
            if (item.status === "verified") verifiedHashes.add(item.contentHash);
            if (item.status !== "verified") hashes.add(item.contentHash);
          }
          copied = verifiedHashes.size;
        } else {
          let cursor = 0;
          for (;;) {
            const page = await remote.getManifest(cursor);
            for (const item of page.items) if (!item.isDeleted && item.contentHash) hashes.add(item.contentHash);
            const next = Number(page.nextCursor ?? page.maxRevision ?? cursor);
            if (!page.hasMore || next <= cursor) break;
            cursor = next;
          }
        }
        switchRemote = remote;
      }
      for (const hash of hashes) {
        const body = await sourceStorage.get(hash);
        await targetStorage.put(hash, body);
        // Read-back verifies the candidate credentials, endpoint and object
        // bytes before the server promotes the pending configuration.
        await targetStorage.get(hash);
        copied += 1;
        if (switchRemote) await switchRemote.markStorageSwitchProgress(jobId, hash);
      }
      completionAttempted = true;
      const complete = await requestUrl({
        url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/storage/switch/complete`,
        method: "POST",
        headers: { Authorization: `Bearer ${pluginToken}` },
        contentType: "application/json",
        body: JSON.stringify({ switch_job_id: jobId, copied_objects: copied, total_objects: hashes.size }),
        throw: false,
      });
      if (complete.status !== 200) throw new Error(complete.json?.error ?? "对象存储切换提交失败");
      this.settings.activeStorageProvider = this.settings.pendingStorageProvider as StorageProvider;
      this.settings.activeStorageEndpoint = this.settings.pendingStorageEndpoint;
      this.settings.activeStorageRegion = this.settings.pendingStorageRegion;
      this.settings.activeStorageBucket = this.settings.pendingStorageBucket;
      this.settings.activeStoragePrefix = this.settings.pendingStoragePrefix;
      this.settings.storageProvider = this.settings.activeStorageProvider;
      this.settings.endpoint = this.settings.activeStorageEndpoint;
      this.settings.region = this.settings.activeStorageRegion;
      this.settings.bucket = this.settings.activeStorageBucket;
      this.settings.prefix = this.settings.activeStoragePrefix;
      this.settings.accessKeySecretId = this.settings.pendingStorageAccessKeySecretId;
      this.settings.secretKeySecretId = this.settings.pendingStorageSecretKeySecretId;
      this.settings.storageCredentialVersion = complete.json?.storage?.storageConfigId ?? this.settings.storageCredentialVersion;
      this.settings.storageGeneration = Number(complete.json?.storage?.storageGeneration ?? this.settings.storageGeneration ?? 1);
      this.settings.pendingStorageSwitchJobId = "";
      this.settings.pendingStorageProvider = "";
      this.settings.pendingStorageEndpoint = "";
      this.settings.pendingStorageRegion = "";
      this.settings.pendingStorageBucket = "";
      this.settings.pendingStoragePrefix = "";
      this.settings.pendingStorageAccessKeySecretId = "";
      this.settings.pendingStorageSecretKeySecretId = "";
      await this.saveSettings();
      this.storageStatus = `对象存储切换完成 · 已迁移 ${copied} 个内容块`;
      if (!quiet) new Notice(this.storageStatus, 10000);
    } catch (error) {
      let pluginToken = "";
      let failureRecorded = false;
      try { pluginToken = (await this.app.secretStorage.getSecret(this.pluginTokenSecretId())) ?? ""; } catch { /* report below */ }
      if (pluginToken && !completionAttempted) {
        const failureResponse = await requestUrl({
          url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/storage/switch/fail`,
          method: "POST",
          headers: { Authorization: `Bearer ${pluginToken}` },
          contentType: "application/json",
          body: JSON.stringify({
            switch_job_id: jobId,
            error_code: "migration_failed",
            error_message: error instanceof Error ? error.message.slice(0, 160) : "对象存储迁移失败",
          }),
          throw: false,
        }).catch(() => null);
        failureRecorded = failureResponse?.status === 200;
      }
      this.storageStatus = `对象存储切换失败：${error instanceof Error ? error.message : String(error)}`;
      if (failureRecorded) {
        // The server marks this candidate invalid. Keep the form values visible
        // for correction, but do not retry a failed job on every plugin start.
        this.settings.pendingStorageSwitchJobId = "";
        this.settings.pendingStorageProvider = "";
        this.settings.pendingStorageEndpoint = "";
        this.settings.pendingStorageRegion = "";
        this.settings.pendingStorageBucket = "";
        this.settings.pendingStoragePrefix = "";
        this.settings.pendingStorageAccessKeySecretId = "";
        this.settings.pendingStorageSecretKeySecretId = "";
        await this.saveSettings();
      } else {
        this.storageStatus += "；未能记录失败状态，请保持此 Vault 连接后重试";
      }
      if (!quiet) new Notice(this.storageStatus, 12000);
    } finally {
      this.storageSwitching = false;
    }
  }

  /**
   * Vault 多端同步入口。由用户手动操作或已配置的自动同步间隔触发。
   * quiet=true 时静默；false 时弹 Notice。
   * 前置条件：vaultSyncEnabled + 已注册（syncTargetId）+ 已登录且有云端同步权益。
   */
  async runVaultSync(quiet = false, deletionResolution?: DeletionResolution) {
    if (!this.settings.vaultSyncEnabled) return;
    if (!this.settings.syncTargetId) return;
    // Refresh server-side entitlement before a background run so expiry and
    // future free-sync rollouts are reflected without restarting Obsidian.
    await this.refreshAccountStatus();
    if (!this.accountLoggedIn) {
      if (!quiet) new Notice("请先登录账号后再使用 Vault 多端同步", 10000);
      return;
    }
    if (!this.accountCanVaultSync) {
      this.settings.vaultSyncEnabled = false;
      this.settings.vaultSyncAutoEnablePending = false;
      await this.saveSettings();
      this.vaultSyncRetry?.clear();
      this.restartVaultSyncTimer();
      if (!quiet) new Notice("当前账号暂未开放 Vault 多端同步，已暂停", 10000);
      return;
    }
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
      if (status.can_sync === false || status.storage_type !== "hosted_s3") {
        throw new Error("当前账号的云端同步存储未就绪，请刷新账号状态后重试");
      }
      if (status.storage_switch_state && status.storage_switch_state !== "active") {
        this.storageStatus = "云端同步存储正在切换，Vault 同步已暂停，请稍后重试";
        this.vaultSyncRetry?.clear();
        if (!quiet) new Notice(this.storageStatus, 10000);
        return;
      }
      if (status.encryption?.enabled && status.encryption.salt_hex) {
        this.settings.vaultEncryptionEnabled = true;
        this.settings.vaultEncryptionSaltHex = status.encryption.salt_hex;
        await this.saveSettings();
      }

      // All account tiers use platform-hosted presigned URLs. A future free
      // rollout only changes the server capability response; no user bucket
      // or long-lived object-storage credential is needed in the plugin.
      let storage: VaultSyncStorage = createProHostedStorage({
        prepareUpload: async (hash, byteSize) => {
          const r = await remote.prepareUpload(hash, byteSize);
          return { uploadUrl: r.upload_url ?? null, uploadId: r.upload_id ?? null, deduped: !!r.deduped };
        },
        prepareDownload: async (hash) => {
          const r = await remote.prepareDownload(hash);
          return { downloadUrl: r.download_url ?? null };
        },
        verifyHash: !this.settings.vaultEncryptionEnabled,
      });

      if (this.settings.vaultEncryptionEnabled) {
        const passphrase = this.settings.vaultEncryptionSecretId
          ? await this.app.secretStorage.getSecret(this.settings.vaultEncryptionSecretId)
          : "";
        if (!passphrase) throw new Error("缺少 Vault 加密密码，请在当前设备输入并启用端到端加密");
        const vaultCrypto = await createVaultSyncCrypto(passphrase, this.settings.vaultEncryptionSaltHex);
        storage = createEncryptedVaultStorage(storage, vaultCrypto);
      }

      const store = createPrevSyncStore(this.app);
      const safetyOverrideFingerprint = this.vaultSafetyOverrideFingerprint;
      const orchestrator = createVaultSyncOrchestrator({
        app: this.app,
        storage,
        remote,
        store,
        deviceId: this.settings.vaultDeviceId || this.settings.vaultInstallationId,
        rootFolder: this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined,
        bootstrapDirection: this.settings.vaultFirstSyncDirection === "ask" || this.settings.vaultFirstSyncDirection === "auto"
          ? undefined
          : this.settings.vaultFirstSyncDirection,
        bootstrapMode: this.settings.vaultFirstSyncDirection === "auto" ? "auto" : "manual",
        isStorageManagerDevice: this.settings.storageManagerIsCurrentDevice,
        notify: quiet ? undefined : (msg) => new Notice(msg, 10000),
        safetyEnabled: this.settings.vaultSafetyEnabled,
        safetyRatio: this.settings.vaultSafetyRatio,
        safetyOverrideFingerprint,
        deletionResolution,
      });
      const result = await orchestrator.runOnce();
      if (safetyOverrideFingerprint) this.vaultSafetyOverrideFingerprint = "";
      if (result.safetyBlocked) {
        this.lastSafeErrorCode = "vault_sync_safety_blocked";
        this.vaultSyncRetry?.clear();
        if (!quiet) this.openVaultSafetyModal(result);
        return;
      }
      if (result.deletionReviewRequired) {
        this.lastSafeErrorCode = "vault_sync_deletion_review";
        this.pendingDeletionReview = result;
        this.vaultSyncRetry?.clear();
        if (!quiet) this.openVaultDeletionReviewModal(result);
        return;
      }
      if (!result.failed) this.pendingDeletionReview = null;
      if (result.aborted) {
        this.vaultSyncRetry?.clear();
      } else if (this.settings.vaultSyncIntervalMinutes !== null
        && result.failed > 0
        && result.failureMessages?.some(isRetryableVaultSyncError)) {
        this.vaultSyncRetry?.scheduleRetry();
      } else if (result.failed === 0) {
        this.vaultSyncRetry?.clear();
      }
      await this.reconcileCaptureHandoffs();
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
      this.vaultSafetyOverrideFingerprint = "";
      const message = error instanceof Error ? error.message : String(error);
      this.lastSafeErrorCode = "vault_sync_failed";
      if (this.settings.vaultSyncIntervalMinutes !== null && isRetryableVaultSyncError(error)) {
        this.vaultSyncRetry?.scheduleRetry();
      }
      if (!quiet) new Notice(`Vault 同步失败：${message}`, 10000);
      console.error("WeTongbu vault sync failed", error);
    } finally {
      this.vaultSyncing = false;
    }
  }

  async syncNow(quiet = false): Promise<number> {
    if (this.syncing) {
      if (!quiet) new Notice("微同步正在运行");
      return 0;
    }
    this.syncing = true;
    try {
      const synced = await this.syncApiTasks(quiet);
      if (synced > 0) new Notice(`微同步：已同步 ${synced} 篇内容`);
      if (!quiet && synced === 0 && this.captureReceiverStatus?.is_current_device !== false) {
        new Notice("微同步：没有待同步文章");
      }
      return synced;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastSafeErrorCode = "sync_failed";
      if (error instanceof Error && (error as Error & { code?: string }).code === "plugin_token_missing") {
        if (!this.pluginTokenMissingNoticeShown) {
          this.pluginTokenMissingNoticeShown = true;
          new Notice(message, 15000);
        }
      } else if (!quiet) {
        new Notice(`微同步失败：${message}`, 10000);
      }
      console.error("WeTongbu sync failed");
      return 0;
    } finally {
      this.syncing = false;
    }
  }

  async setVaultSafety(enabled: boolean, ratio = this.settings.vaultSafetyRatio) {
    this.settings.vaultSafetyEnabled = enabled;
    this.settings.vaultSafetyRatio = normalizeVaultSafetyRatio(ratio);
    await this.saveSettings();
  }

  private openVaultSafetyModal(result: SyncResult) {
    new VaultSafetyModal(this.app, this, result).open();
  }

  get pendingDeletionCount() {
    return this.pendingDeletionReview?.pendingDeletions?.length ?? 0;
  }

  private openVaultDeletionReviewModal(result: SyncResult) {
    new VaultDeletionReviewModal(this.app, this, result).open();
  }

  async openPendingDeletionReview() {
    if (!this.pendingDeletionReview?.deletionPlanFingerprint) {
      await this.runVaultSync(false);
      return;
    }
    this.openVaultDeletionReviewModal(this.pendingDeletionReview);
  }

  async resolveVaultDeletions(
    fingerprint: string,
    decisions: Record<string, DeletionAction>,
  ) {
    if (!fingerprint) return;
    await this.runVaultSync(false, { fingerprint, decisions });
  }

  async openVaultConflictReview() {
    const state = await createPrevSyncStore(this.app).load();
    new VaultConflictReviewModal(this.app, this, state?.conflicts ?? {}).open();
  }

  async resolveVaultConflict(path: string) {
    const store = createPrevSyncStore(this.app);
    const state = await store.load();
    if (!state?.conflicts?.[path]) return;
    state.conflicts[path] = { ...state.conflicts[path], status: "resolved" };
    await store.save(state);
  }

  async allowVaultSafetyOnce(fingerprint: string) {
    if (!fingerprint) return;
    this.vaultSafetyOverrideFingerprint = fingerprint;
    await this.runVaultSync(false);
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

  private async refreshCaptureReceiverStatus() {
    if (this.accountPlanType === "pro" || (this.accountLoggedIn && !this.accountLegacyFreeStorageCompat)) {
      this.captureReceiverStatus = null;
      return;
    }
    const token = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!token || !this.settings.syncTargetId) return;
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    const response = await requestUrl({
      url: `${base}/api/sync-targets/${this.settings.syncTargetId}/capture-receiver`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    if (response.status === 200) this.captureReceiverStatus = response.json?.receiver ?? null;
  }

  async setCurrentDeviceAsCaptureReceiver() {
    if (this.accountPlanType === "pro") throw new Error("Plus 托管版不需要设置剪藏接收设备");
    if (this.accountLoggedIn && !this.accountLegacyFreeStorageCompat) {
      throw new Error("当前免费账号仅支持本地剪藏，不需要设置云端接收设备");
    }
    const token = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!token || !this.settings.syncTargetId) throw new Error("请先连接 Obsidian Vault");
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    const response = await requestUrl({
      url: `${base}/api/sync-targets/${this.settings.syncTargetId}/capture-receiver`,
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "设置剪藏接收设备失败");
    this.captureReceiverStatus = response.json?.receiver ?? { device_name: currentDeviceName(), is_current_device: true };
    await this.saveSettings();
  }

  private async syncApiTasks(quiet = false) {
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!this.settings.syncTargetId) return 0;
    if (!token) {
      throw Object.assign(
        new Error("Obsidian 插件凭证已丢失，请在设置中使用之前保存的恢复码重新连接当前 Vault"),
        { code: "plugin_token_missing" },
      );
    }
    this.pluginTokenMissingNoticeShown = false;
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    const listed = await requestUrl({
      url: `${base}/api/sync-targets/${this.settings.syncTargetId}/tasks/claim`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Wetongbu-Task-Download-Proxy": "1",
      },
      contentType: "application/json",
      body: "{}",
      throw: false,
    });
    if (listed.status === 401) throw new Error("Vault 连接已失效，请重新连接");
    if (listed.status !== 200) throw new Error(listed.json?.error ?? "任务列表获取失败");
    if (listed.json?.capture_receiver) this.captureReceiverStatus = listed.json.capture_receiver;
    if (!quiet && !(listed.json?.tasks ?? []).length && listed.json?.capture_receiver?.is_current_device === false) {
      const receiver = listed.json.capture_receiver.device_name || "另一台电脑";
      new Notice(`当前由 ${receiver} 接收剪藏，请在该电脑打开 Obsidian 完成剪藏同步`, 10000);
    }
    let synced = 0;
    for (const item of listed.json.tasks ?? []) {
      let completedOnServer = false;
      try {
        const existingHandoff = await this.captureHandoffs.get(item.task_id);
        if (existingHandoff && await this.captureHandoffFilesMatch(existingHandoff)) {
          await this.completeHostedTask(base, token, item.task_id);
          completedOnServer = true;
          if (!existingHandoff.requiresVaultSync) await this.captureHandoffs.remove(item.task_id);
          synced += 1;
          continue;
        }
        // processedTaskIds is only a local history. It is not proof that this
        // Vault still contains the written file, so never acknowledge a task
        // solely because its id was persisted in settings. The handoff check
        // above is the only fast path that has local file evidence.
        const expectedDownloadPath = `/api/sync-targets/${this.settings.syncTargetId}/tasks/${item.task_id}/download`;
        const proxyDownloadUrl = item.download_path === expectedDownloadPath
          ? `${base}${expectedDownloadPath}`
          : null;
        const downloadUrl = proxyDownloadUrl ?? item.download_url;
        if (!isTrustedStorageUrl(
          downloadUrl,
          this.settings.activeStorageEndpoint || this.settings.endpoint,
          base,
        )) {
          throw new Error("任务下载地址不受信任");
        }
        const downloaded = await requestUrl({
          url: downloadUrl,
          method: "GET",
          ...(proxyDownloadUrl ? { headers: { Authorization: `Bearer ${token}` } } : {}),
          throw: false,
        });
        if (downloaded.status !== 200) throw new Error(`任务下载失败（${downloaded.status}）`);
        const zipBytes = new Uint8Array(downloaded.arrayBuffer);
        const packageHash = await sha256Hex(zipBytes);
        if (packageHash !== item.content_hash) throw new Error("ZIP 校验失败：任务包哈希不一致");
        if (zipBytes.length !== item.file_size) throw new Error("ZIP 校验失败：任务包大小不一致");
        const task = await this.unpackWebclipTask(zipBytes);
        assertCompletionTaskIdentity(item, task.manifest, {
          userId: this.settings.userId,
          targetId: this.settings.syncTargetId,
        });
        const continuationNote = task.manifest.mediaContinuationClipTaskId
          ? await this.findClipContinuationNote(task.manifest.mediaContinuationClipTaskId)
          : null;
        // The browser waits for the lightweight clip to complete before
        // creating this task. If the user removed or duplicated that note in
        // the meantime, fail safely instead of creating a second article.
        if (task.manifest.mediaContinuationClipTaskId && !continuationNote) {
          throw new Error("找不到对应的原剪藏文章；为避免生成重复文章，已停止图片回填");
        }
        const imageLinks = item.image_delivery_mode === "hosted_link"
          ? await this.publishHostedImages(base, token, item.task_id)
          : {};
        const written = task.manifest.mediaContinuationClipTaskId
          ? await this.applyHostedMediaContinuation(task, imageLinks, continuationNote!)
          : task.manifest.operation === "complete_capture"
            ? await this.completeCaptureTask(task)
            : await this.writeTask(task, imageLinks);
        await this.captureHandoffs.save({
          version: 1,
          taskId: item.task_id,
          notePath: written.notePath,
          files: written.files,
          requiresVaultSync: this.settings.vaultSyncEnabled,
          createdAt: new Date().toISOString(),
        });
        this.settings.processedTaskIds.push(item.task_id);
        this.settings.processedTaskIds = this.settings.processedTaskIds.slice(-1000);
        await this.saveSettings();
        await this.completeHostedTask(base, token, item.task_id);
        completedOnServer = true;
        if (!this.settings.vaultSyncEnabled) await this.captureHandoffs.remove(item.task_id);
        synced += 1;
      } catch (error) {
        if (!completedOnServer) await this.failHostedTask(base, token, item.task_id, error);
        throw error;
      }
    }
    return synced;
  }

  private async findClipContinuationNote(taskId: string) {
    const root = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
    const matches: Array<ArticleCandidate & { file: TFile }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (root && file.path !== root && !file.path.startsWith(`${root}/`)) continue;
      const content = await this.app.vault.cachedRead(file);
      const candidate = articleCandidate(file.path, content);
      if (candidate.taskId === taskId) matches.push({ ...candidate, file });
    }
    if (matches.length > 1) throw new Error("图片续传任务对应多个剪藏文章；为避免改错文章，已停止回填");
    return matches[0] ?? null;
  }

  private async applyHostedMediaContinuation(
    task: any,
    imageLinks: Record<string, string>,
    candidate: ArticleCandidate & { file: TFile },
  ) {
    const clipTaskId = String(task.manifest.mediaContinuationClipTaskId);
    const capturedAt = String(candidate.frontmatter.captured_at ?? task.manifest.capturedAt ?? new Date().toISOString());
    const layout = buildVaultPaths({
      rootFolder: normalizePath(this.settings.rootFolder),
      title: String(candidate.frontmatter.title ?? task.manifest.title),
      capturedAt,
      taskId: clipTaskId,
      assets: task.assets,
    });
    const notePath = candidate.path;
    const noteFolder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
    const attachmentFolder = normalizePath(layout.attachmentFolder);
    const createdPaths: string[] = [];
    const localFiles: Array<{ path: string; body: Uint8Array }> = [];
    const replacements: Array<{ from: string; to: string; imageOnly: boolean }> = [];
    try {
      for (const [index, asset] of task.assets.entries()) {
        const reference = typeof asset.clipReference === "string" ? asset.clipReference : "";
        if (!reference) throw new Error(`图片续传清单缺少原引用：${asset.relativePath}`);
        const hostedLink = asset.kind === "image" ? imageLinks[asset.relativePath] : undefined;
        if (hostedLink) {
          replacements.push({ from: reference, to: hostedLink, imageOnly: true });
          continue;
        }
        const desiredPath = normalizePath(`${attachmentFolder}/${layout.assetNames[index]}`);
        const resolved = await resolveAssetTarget(this.app.vault.adapter, desiredPath, new Uint8Array(asset.body));
        if (resolved.writeLocal) {
          await ensureFolder(this, attachmentFolder);
          createdPaths.push(resolved.targetPath);
          await this.app.vault.adapter.writeBinary(resolved.targetPath, toArrayBuffer(new Uint8Array(asset.body)));
          const persisted = await this.app.vault.adapter.stat(resolved.targetPath);
          if (!persisted || persisted.type !== "file" || persisted.size !== asset.body.length) {
            throw new Error(`附件写入校验失败：${resolved.targetPath}`);
          }
        }
        localFiles.push({ path: resolved.targetPath, body: new Uint8Array(asset.body) });
        replacements.push({ from: reference, to: relativeVaultPath(noteFolder, resolved.targetPath), imageOnly: false });
      }

      const original = await this.app.vault.cachedRead(candidate.file);
      let updated = original;
      for (const replacement of replacements) {
        updated = replaceMarkdownDestination(updated, replacement.from, replacement.to, replacement.imageOnly);
      }
      if (updated !== original) await writeTextAtomically(this.app, notePath, updated);
      const persisted = await this.app.vault.adapter.read(notePath);
      const encoded = new TextEncoder().encode(persisted);
      const files = [{ path: notePath, contentHash: await sha256Hex(encoded), byteSize: encoded.byteLength }];
      for (const file of localFiles) {
        files.push({ path: file.path, contentHash: await sha256Hex(file.body), byteSize: file.body.byteLength });
      }
      return { notePath, files };
    } catch (error) {
      for (const path of createdPaths) {
        if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path).catch(() => {});
      }
      throw error;
    }
  }

  private async captureHandoffFilesMatch(handoff: { notePath: string; files: Array<{ path: string; contentHash: string; byteSize: number }> }) {
    if (!handoff.notePath || handoff.files.length === 0 || !handoff.files.some((record) => record.path === handoff.notePath)) return false;
    for (const record of handoff.files) {
      const file = this.app.vault.getAbstractFileByPath(record.path);
      if (!(file instanceof TFile)) return false;
      const body = new Uint8Array(await this.app.vault.readBinary(file));
      if (body.byteLength !== record.byteSize || await sha256Hex(body) !== record.contentHash) return false;
    }
    return true;
  }

  private async reconcileCaptureHandoffs() {
    const handoffs = await this.captureHandoffs.list();
    if (!handoffs.length) return;
    const store = createPrevSyncStore(this.app);
    const prev = await store.load();
    for (const handoff of handoffs) {
      if (!handoff.requiresVaultSync) {
        await this.captureHandoffs.remove(handoff.taskId);
        continue;
      }
      if (!prev) continue;
      const committed = handoff.files.every((record) => {
        const remote = prev.files[record.path];
        return remote && remote.contentHash === record.contentHash && remote.isDeleted !== true && Number(remote.revision) > 0;
      });
      if (committed) await this.captureHandoffs.remove(handoff.taskId);
    }
  }

  private async recoverCaptureHandoffs() {
    try {
      const handoffs = await this.captureHandoffs.list();
      if (!handoffs.length) return;
      await this.reconcileCaptureHandoffs();
    } catch (error) {
      console.warn("WeTongbu capture handoff recovery failed", error);
    }
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

  private async failHostedTask(base: string, token: string, taskId: string, error: unknown) {
    try {
      const response = await requestUrl({
        url: `${base}/api/sync-targets/${this.settings.syncTargetId}/tasks/${taskId}/fail`,
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        contentType: "application/json",
        body: JSON.stringify({
          error_code: "client_download_failed",
          error_message: error instanceof Error ? error.message : String(error),
        }),
        throw: false,
      });
      if (response.status !== 200) console.warn("WeTongbu task failure report failed", response.status);
    } catch (reportError) {
      console.warn("WeTongbu task failure report unavailable", reportError);
    }
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
    const entries = unzipWebclipArchive(zipBytes);
    const entryNames = [...entries.keys()];
    const manifestEntry = entries.get("manifest.json");
    if (!manifestEntry) throw new Error("manifest.json 缺失");
    const manifest = validateWebclipManifest(JSON.parse(new TextDecoder().decode(manifestEntry)));
    const files = new Map<string, Uint8Array>();
    for (const record of manifest.files) {
      const entry = entries.get(record.path);
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
        operation: manifest.operation ?? "create_new",
        captureId: manifest.capture_id ?? null,
        userId: manifest.user_id ?? null,
        targetId: manifest.target_id ?? null,
        mediaContinuationClipTaskId: manifest.media_continuation?.clip_task_id ?? null,
      },
        markdown: new TextDecoder().decode(files.get(manifest.entry_file)!),
      assets: manifest.files
        .filter((file: any) => file.path.startsWith("assets/"))
        .map((file: any) => ({
          relativePath: file.path,
          body: files.get(file.path)!,
          kind: file.kind,
          contentType: file.content_type,
          clipReference: file.clip_reference,
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

  private async completeCaptureTask(task: any) {
    const captureId = task.manifest.captureId;
    if (typeof captureId !== "string" || !captureId) throw new Error("补全任务缺少 capture_id");
    const capturePattern = new RegExp(`^wetongbu_capture_id:\\s*["']?${captureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["']?)\\s*$`, "im");
    const allMarkdownFiles = this.app.vault.getMarkdownFiles();
    const rootFolder = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
    const inboxPrefix = `${rootFolder}/00_收件箱/`;
    const exactMarkerFiles = allMarkdownFiles.filter((file) =>
      String(this.app.metadataCache.getFileCache(file)?.frontmatter?.wetongbu_capture_id ?? "") === captureId,
    );
    const inboxFiles = allMarkdownFiles.filter((file) => file.path.startsWith(inboxPrefix));
    const legacyUrlFiles = inboxFiles.filter((file) => {
      const url = this.app.metadataCache.getFileCache(file)?.frontmatter?.url;
      if (typeof url !== "string" || !url.trim()) return false;
      try {
        return normalizeCompletionSourceUrl(url) === normalizeCompletionSourceUrl(task.manifest.sourceUrl);
      } catch {
        return false;
      }
    });
    const prioritizedFiles = exactMarkerFiles.length
      ? exactMarkerFiles
      : legacyUrlFiles.length
        ? legacyUrlFiles
        : inboxFiles.length
          ? inboxFiles
          : allMarkdownFiles;
    const readCandidates = async (files: TFile[]) => {
      const result: Array<{ file: TFile; content: string }> = [];
      for (const file of files) result.push({ file, content: await this.app.vault.cachedRead(file) });
      return result;
    };
    let candidates = await readCandidates(prioritizedFiles);
    let selected = selectCompletionNote(
      candidates.map(({ file, content }) => ({ path: file.path, content })),
      captureId,
      task.manifest.sourceUrl,
    );
    if (!selected && prioritizedFiles.length !== allMarkdownFiles.length) {
      candidates = await readCandidates(allMarkdownFiles);
      selected = selectCompletionNote(
        candidates.map(({ file, content }) => ({ path: file.path, content })),
        captureId,
        task.manifest.sourceUrl,
      );
    }
    const note = selected ? candidates.find(({ file }) => file.path === selected.path)?.file : undefined;
    if (!selected || !note) {
      const fallback = await this.writeTask(task, {});
      new Notice(candidates.filter(({ content }) => capturePattern.test(content)).length === 0
        ? "原笔记已找不到，已新建完整笔记"
        : "原笔记标识不唯一，已新建完整笔记，未覆盖原文件", 8000);
      return fallback;
    }
    const original = selected.content;
    const start = "<!-- wetongbu:generated:start -->";
    const end = "<!-- wetongbu:generated:end -->";
    const incomingBody = task.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n?/, "").trim();
    if (!original.includes(start) || !original.includes(end)) {
      const fallback = await this.writeTask(task, {});
      new Notice("原笔记没有可安全更新的微同步区块，已新建完整笔记", 8000);
      return fallback;
    }
    const layout = buildVaultPaths({
      rootFolder: normalizePath(this.settings.rootFolder),
      title: task.manifest.title,
      capturedAt: task.manifest.capturedAt,
      taskId: task.manifest.taskId,
      assets: task.assets,
    });
    const noteFolder = normalizePath(note.parent?.path || layout.noteFolder);
    const attachmentFolder = normalizePath(layout.attachmentFolder);
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    let body = incomingBody.replace(/\r?\n/g, newline);
    const localAssets: Array<{ asset: any; targetPath: string; writeLocal: boolean }> = [];
    for (const [index, asset] of task.assets.entries()) {
      const filename = layout.assetNames[index];
      const desiredPath = normalizePath(`${attachmentFolder}/${filename}`);
      const resolved = await resolveAssetTarget(this.app.vault.adapter, desiredPath, new Uint8Array(asset.body));
      const targetPath = resolved.targetPath;
      const relativePath = relativeVaultPath(noteFolder, targetPath);
      body = body.split(`<${asset.relativePath}>`).join(relativePath).split(asset.relativePath).join(relativePath);
      localAssets.push({ asset, targetPath, writeLocal: resolved.writeLocal });
    }
    if (localAssets.some(({ writeLocal }) => writeLocal)) await ensureFolder(this, attachmentFolder);
    const createdAssets: string[] = [];
    try {
      for (const { asset, targetPath, writeLocal } of localAssets) {
        if (!writeLocal) continue;
        createdAssets.push(targetPath);
        await this.app.vault.adapter.writeBinary(targetPath, toArrayBuffer(asset.body));
        const stat = await this.app.vault.adapter.stat(targetPath);
        if (!stat || stat.type !== "file" || stat.size !== asset.body.length) throw new Error(`附件写入校验失败：${targetPath}`);
      }
      const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const withMetadata = updateCompletionNoteMetadata(original, {
        captureId,
        title: task.manifest.title,
        sourceUrl: task.manifest.sourceUrl,
      });
      const updated = withMetadata.replace(
        new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`),
        `${start}${newline}${body}${newline}${end}`,
      );
      const transactionId = `${task.manifest.taskId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const temporary = `${note.path}.wetongbu-complete-${transactionId}.tmp`;
      await this.app.vault.adapter.write(temporary, updated);
      if ((await this.app.vault.adapter.read(temporary)) !== updated) throw new Error("原笔记写入校验失败");
      const backup = `${note.path}.wetongbu-complete-${transactionId}.bak`;
      await this.app.vault.adapter.write(backup, original);
      if ((await this.app.vault.adapter.read(backup)) !== original) throw new Error("原笔记备份校验失败");
      try {
        await this.app.vault.adapter.write(note.path, updated);
        const persisted = await this.app.vault.adapter.read(note.path);
        if (persisted !== updated) throw new Error("原笔记更新校验失败");
      } catch (error) {
        await this.app.vault.adapter.write(note.path, original).catch(() => {});
        throw error;
      } finally {
        if (await this.app.vault.adapter.exists(temporary)) await this.app.vault.adapter.remove(temporary).catch(() => {});
        if (await this.app.vault.adapter.exists(backup)) await this.app.vault.adapter.remove(backup).catch(() => {});
      }
      let finalPath = note.path;
      const desiredPath = normalizePath(`${noteFolder}/${layout.noteFilename}`);
      if (desiredPath !== note.path && !(await this.app.vault.adapter.exists(desiredPath))) {
        await this.app.fileManager.renameFile(note, desiredPath);
        finalPath = desiredPath;
      }
      const persisted = await this.app.vault.adapter.read(finalPath);
      const encoded = new TextEncoder().encode(persisted);
      const files = [{ path: finalPath, contentHash: await sha256Hex(encoded), byteSize: encoded.byteLength }];
      for (const { asset, targetPath } of localAssets) {
        files.push({ path: targetPath, contentHash: await sha256Hex(new Uint8Array(asset.body)), byteSize: asset.body.length });
      }
      return { notePath: finalPath, files };
    } catch (error) {
      for (const targetPath of createdAssets) {
        if (await this.app.vault.adapter.exists(targetPath)) await this.app.vault.adapter.remove(targetPath).catch(() => {});
      }
      throw error;
    }
  }

  private async writeTask(
    task: any,
    imageLinks: Record<string, string> = {},
    options: { preserveGeneratedMarkers?: boolean; allowLegacyPathMatch?: boolean } = {},
  ) {
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

    // ZIP captures carry a managed body marker so later captures can preserve
    // user-written notes around the generated block. Lightweight local clips
    // use frontmatter/tags for identity and intentionally hide those markers.
    const preserveGeneratedMarkers = options.preserveGeneratedMarkers !== false;
    let markdown = preserveGeneratedMarkers ? ensureGeneratedMarkers(task.markdown) : stripGeneratedMarkers(task.markdown);
    const assetPlans: Array<{ asset: any; filename: string; targetPath: string; writeLocal: boolean }> = [];
    for (const [index, asset] of task.assets.entries()) {
      const filename = layout.assetNames[index];
      const remoteLink = asset.kind === "image" ? imageLinks[asset.relativePath] : undefined;
      if (remoteLink) {
        markdown = markdown.split(`<${asset.relativePath}>`).join(`<${remoteLink}>`);
        markdown = markdown.split(asset.relativePath).join(remoteLink);
        assetPlans.push({ asset, filename, targetPath: "", writeLocal: false });
        continue;
      }
      const desiredPath = normalizePath(`${taskAttachmentFolder}/${filename}`);
      const resolved = await resolveAssetTarget(this.app.vault.adapter, desiredPath, new Uint8Array(asset.body));
      const targetPath = resolved.targetPath;
      const relativePath = relativeVaultPath(noteFolder, targetPath);
      markdown = markdown.split(`<${asset.relativePath}>`).join(relativePath);
      markdown = markdown.split(asset.relativePath).join(relativePath);
      assetPlans.push({ asset, filename, targetPath, writeLocal: resolved.writeLocal });
    }
    markdown = markdown.replace(/^[\t ]+(?=(?:!\[|\[!\[))/gm, "");

    const taskId = typeof task.manifest.taskId === "string" ? task.manifest.taskId : "";
    const isCreateNewZip = task.manifest.operation === "create_new" && options.allowLegacyPathMatch !== true;
    const taskIdentityCandidates: Array<ArticleCandidate & { file: TFile }> = [];
    if (taskId) {
      for (const file of this.app.vault.getMarkdownFiles()) {
        const root = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
        if (root && file.path !== root && !file.path.startsWith(`${root}/`)) continue;
        const content = await this.app.vault.cachedRead(file);
        const candidate = articleCandidate(file.path, content);
        if (candidate.taskId === taskId) taskIdentityCandidates.push({ ...candidate, file });
      }
    }
    if (taskIdentityCandidates.length > 1) throw new Error("同一任务已有多个本地版本，请先在 Vault 中处理重复文章");
    if (taskIdentityCandidates.length === 1) {
      const existing = taskIdentityCandidates[0];
      const encoded = new TextEncoder().encode(existing.content);
      try { await this.app.workspace.getLeaf(false).openFile(existing.file); } catch { /* best effort */ }
      return {
        notePath: existing.path,
        files: [{ path: existing.path, contentHash: await sha256Hex(encoded), byteSize: encoded.byteLength }],
      };
    }

    const sourceKey = normalizeArticleSourceUrl(task.manifest.sourceUrl);
    const candidates: Array<ArticleCandidate & { file: TFile }> = [];
    if (!isCreateNewZip && sourceKey) {
      const root = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (root && file.path !== root && !file.path.startsWith(`${root}/`)) continue;
        const content = await this.app.vault.cachedRead(file);
        const candidate = articleCandidate(file.path, content);
        if (candidate.sourceKey === sourceKey) candidates.push({ ...candidate, file });
      }
    }
    // Older lightweight clips have generated markers but no source_url. When
    // re-clipping the same day, migrate that exact WTB path in place instead
    // of creating a second note. Restricting this fallback to the calculated
    // path prevents same-title notes from unrelated sources being merged.
    if (options.allowLegacyPathMatch && candidates.length === 0) {
      const expectedPath = normalizePath(`${layout.noteFolder}/${layout.noteFilename}`);
      const legacyFile = this.app.vault.getAbstractFileByPath(expectedPath);
      if (legacyFile instanceof TFile) {
        const content = await this.app.vault.cachedRead(legacyFile);
        const candidate = articleCandidate(legacyFile.path, content);
        if (isLegacyArticleCandidate(candidate, expectedPath)) candidates.push({ ...candidate, file: legacyFile });
      }
    }
    const incomingBody = normalizeArticleBodyForCompare(splitMarkdownFrontmatter(markdown).body);
    // Body normalization intentionally ignores generated filenames, but that
    // alone is not enough: the same article can carry a changed image under a
    // new generated name. Include the actual bytes of generated local assets
    // in the no-op decision so an updated attachment is not silently lost.
    const localIncomingAssets = task.assets.filter((asset: any) => !(asset.kind === "image" && imageLinks[asset.relativePath]));
    const incomingAssetFingerprint = await articleAssetFingerprintFromBodies(localIncomingAssets.map((asset: any) => new Uint8Array(asset.body)));
    if (candidates.length > 1) {
      throw new Error("同一来源已有多个本地版本，请先在 Vault 中处理重复文章；本次未新建副本");
    }
    let exactCandidate: (ArticleCandidate & { file: TFile }) | undefined;
    if (candidates.length === 1 && normalizeArticleBodyForCompare(candidates[0].body) === incomingBody) {
      const candidateAssetFingerprint = await articleAssetFingerprintFromVault(
        this.app.vault.adapter,
        candidates[0].path,
        candidates[0].body,
      );
      if (candidateAssetFingerprint === incomingAssetFingerprint) exactCandidate = candidates[0];
    }
    const existing = exactCandidate ?? candidates[0];
    // An exact body is a successful no-op. If only the title/metadata changed,
    // merge those fields into the authoritative note instead of making -2.
    const metadataChanged = Boolean(existing && (
      String(existing.frontmatter.title ?? "") !== String(task.manifest.title ?? "")
      || String(existing.frontmatter.captured_at ?? "") !== String(task.manifest.capturedAt ?? "")
    ));
    if (existing && exactCandidate && !metadataChanged) {
      const persisted = existing.content;
      const encoded = new TextEncoder().encode(persisted);
      try { await this.app.workspace.getLeaf(false).openFile(existing.file); } catch { /* best effort */ }
      return {
        notePath: existing.path,
        files: [{ path: existing.path, contentHash: await sha256Hex(encoded), byteSize: encoded.byteLength }],
      };
    }

    const localAssetPlans = assetPlans.filter((plan: { writeLocal: boolean }) => plan.writeLocal);
    let createdNote: TFile | null = null;
    let noteCreatedByThisAttempt = false;
    const assetsCreatedByThisAttempt: string[] = [];
    let persistedMarkdown = "";
    try {
      if (localAssetPlans.length) await ensureFolder(this, taskAttachmentFolder);
      for (const { asset, filename, targetPath } of localAssetPlans) {
        assetsCreatedByThisAttempt.push(targetPath);
        await this.app.vault.adapter.writeBinary(targetPath, toArrayBuffer(asset.body));
        const writtenAsset = await this.app.vault.adapter.stat(targetPath);
        if (!writtenAsset || writtenAsset.type !== "file" || writtenAsset.size !== asset.body.length) {
          throw new Error(`附件写入校验失败：${filename}`);
        }
      }

      if (existing) {
        if (!existing.managed) throw new Error("同一来源已有非微同步笔记，未覆盖也未新建；请先确认后重试");
        const existingFolder = normalizePath(existing.file.parent?.path ?? "");
        for (const plan of assetPlans) {
          if (!plan.targetPath) continue;
          const from = relativeVaultPath(noteFolder, plan.targetPath);
          const to = relativeVaultPath(existingFolder, plan.targetPath);
          markdown = markdown.split(`<${from}>`).join(`<${to}>`).split(from).join(to);
        }
        const merged = mergeArticleMarkdown(existing, markdown, { preserveGeneratedMarkers });
        await writeTextAtomically(this.app, existing.path, merged);
        createdNote = existing.file;
        persistedMarkdown = merged;
      } else {
        const notePath = await uniqueNotePath(this, noteFolder, layout.noteFilename);
        createdNote = await this.app.vault.create(notePath, markdown);
        noteCreatedByThisAttempt = true;
        persistedMarkdown = await this.app.vault.adapter.read(createdNote.path);
      }
      if (persistedMarkdown !== markdown) {
        if (!existing) throw new Error("本地 Markdown 写入校验失败");
      }
    } catch (error) {
      if (createdNote && noteCreatedByThisAttempt) await this.app.fileManager.trashFile(createdNote);
      for (const targetPath of assetsCreatedByThisAttempt) {
        const asset = this.app.vault.getAbstractFileByPath(targetPath);
        if (asset instanceof TFile) await this.app.fileManager.trashFile(asset);
      }
      throw error;
    }

    let finalPath = createdNote.path;
    if (existing) {
      const desiredPath = normalizePath(`${noteFolder}/${layout.noteFilename}`);
      if (desiredPath !== existing.path && !(await this.app.vault.adapter.exists(desiredPath))) {
        await this.app.fileManager.renameFile(createdNote, desiredPath);
        finalPath = desiredPath;
        createdNote = this.app.vault.getAbstractFileByPath(desiredPath) as TFile;
      }
    }
    try {
      await this.app.workspace.getLeaf(false).openFile(createdNote);
    } catch (error) {
      console.warn("WeTongbu note saved but could not be opened");
    }
    const writtenFiles = [{
      path: finalPath,
      contentHash: await sha256Hex(new TextEncoder().encode(persistedMarkdown)),
      byteSize: new TextEncoder().encode(persistedMarkdown).byteLength,
    }];
    for (const { asset, targetPath } of localAssetPlans) {
      writtenFiles.push({
        path: targetPath,
        contentHash: await sha256Hex(new Uint8Array(asset.body)),
        byteSize: asset.body.length,
      });
    }
    return { notePath: finalPath, files: writtenFiles };
  }
}

async function writeTextAtomically(app: App, path: string, content: string) {
  const temporary = `${path}.wetongbu-update-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  const backup = `${path}.wetongbu-update-${Date.now()}-${Math.random().toString(16).slice(2)}.bak`;
  const adapter = app.vault.adapter as any;
  await adapter.write(temporary, content);
  if ((await adapter.read(temporary)) !== content) {
    await adapter.remove(temporary).catch(() => {});
    throw new Error("文章临时文件写入校验失败");
  }
  const original = await adapter.read(path);
  await adapter.write(backup, original);
  try {
    // DataAdapter.rename intentionally rejects an existing destination on
    // Obsidian's local adapter. Use the verified overwrite path whenever the
    // note is still present; only use rename if a concurrent operation removed
    // the destination between the backup and replacement steps.
    if (typeof adapter.rename === "function" && !(await adapter.exists(path))) {
      await adapter.rename(temporary, path);
    } else {
      // Verify the overwrite and restore the original on a torn/corrupted
      // write. The backup above still gives us a recovery copy during this
      // non-atomic replacement window.
      await adapter.write(path, content);
      if ((await adapter.read(path)) !== content) throw new Error("文章更新替换校验失败");
      await adapter.remove(temporary).catch(() => {});
    }
    if ((await adapter.read(path)) !== content) throw new Error("文章更新校验失败");
  } catch (error) {
    await adapter.write(path, original).catch(() => {});
    throw error;
  } finally {
    if (await adapter.exists(temporary)) await adapter.remove(temporary).catch(() => {});
    if (await adapter.exists(backup)) await adapter.remove(backup).catch(() => {});
  }
}

class VaultConflictReviewModal extends Modal {
  constructor(
    app: App,
    private plugin: WeTongbuPlugin,
    private conflicts: Record<string, {
      originalPath: string;
      createdAt: string;
      localHash: string | null;
      remoteHash: string | null;
      status: "pending" | "resolved";
    }>,
  ) { super(app); }

  onOpen() {
    this.titleEl.setText("冲突副本记录");
    const { contentEl } = this;
    contentEl.empty();
    const entries = Object.entries(this.conflicts);
    if (!entries.length) {
      contentEl.createEl("p", { text: "当前没有记录的同步冲突。" });
      return;
    }
    contentEl.createEl("p", { text: "同内容重试不会进入这里。下面只列出内容确实不同、需要人工确认的本地冲突副本。" });
    for (const [path, record] of entries.sort(([a], [b]) => a.localeCompare(b, "zh-Hans-CN"))) {
      const setting = new Setting(contentEl)
        .setName(path)
        .setDesc(`原路径：${record.originalPath}；创建于 ${new Date(record.createdAt).toLocaleString()}`);
      if (record.status === "pending") {
        setting.addButton((button) => button
          .setButtonText("标记已处理")
          .onClick(async () => {
            await this.plugin.resolveVaultConflict(path);
            record.status = "resolved";
            button.setDisabled(true).setButtonText("已处理");
          }));
      } else {
        setting.addButton((button) => button.setButtonText("已处理").setDisabled(true));
      }
    }
  }
}

class AccountLogoutConfirmModal extends Modal {
  constructor(
    app: App,
    private onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("确认退出账号？");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "退出后，本机将断开当前微同步账号和 Vault 同步。当前 Vault 中已有的笔记、图片和附件不会删除。",
    });
    contentEl.createEl("p", {
      text: "之后可以随时重新登录，或换用其他账号。",
    });
    const status = contentEl.createEl("p", { cls: "setting-item-description", attr: { role: "status" } });
    let confirming = false;
    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("取消")
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText("确认退出")
        .setWarning()
        .onClick(() => {
          if (confirming) return;
          confirming = true;
          button.setDisabled(true).setButtonText("正在退出…");
          void this.onConfirm().then(
            () => this.close(),
            (error) => {
              confirming = false;
              button.setDisabled(false).setButtonText("确认退出");
              status.setText(`退出账号失败：${error instanceof Error ? error.message : String(error)}`);
            },
          );
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VaultDeletionReviewModal extends Modal {
  private readonly decisions: Record<string, DeletionAction> = {};

  constructor(
    app: App,
    private plugin: WeTongbuPlugin,
    private result: SyncResult,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("确认文件删除或恢复");
    const { contentEl } = this;
    contentEl.empty();
    const pending = this.result.pendingDeletions ?? [];
    contentEl.createEl("p", {
      text: "为避免误删，下面的跨设备删除不会自动执行。请逐项选择：确认删除、恢复文件，或暂不处理。",
    });
    // The deleted path is absent from the local index by definition. Reading
    // only the current Markdown paths lets the review explain whether a
    // same-name note remains elsewhere in this Vault, without touching file
    // contents or changing the deletion decision.
    const localMarkdownPaths = this.app.vault.getMarkdownFiles().map((file) => file.path);
    for (const item of pending) {
      this.decisions[item.path] = "keep";
      const isLocalDeletion = item.direction === "local_to_remote";
      const reason = isLocalDeletion
        ? "检测到本机文件已删除，其他设备/云端仍有此文件。"
        : "检测到其他设备已删除此文件，本机仍保留。";
      const duplicatePaths = findDuplicateLocalFiles(item.path, localMarkdownPaths);
      const description = document.createDocumentFragment();
      const reasonEl = document.createElement("div");
      reasonEl.textContent = reason;
      description.appendChild(reasonEl);
      const duplicateEl = document.createElement("div");
      duplicateEl.className = "wetongbu-duplicate-check";
      if (duplicatePaths.length > 0) {
        duplicateEl.textContent = `本地同名/同标题检查：发现 ${duplicatePaths.length} 个可能重复文件，请确认是否因重复而删除。`;
        const list = document.createElement("ul");
        for (const path of duplicatePaths) {
          const entry = document.createElement("li");
          entry.textContent = path;
          list.appendChild(entry);
        }
        duplicateEl.appendChild(list);
      } else {
        duplicateEl.textContent = "本地同名/同标题检查：未发现其他匹配文件。";
      }
      description.appendChild(duplicateEl);
      const setting = new Setting(contentEl)
        .setName(item.path)
        .setDesc(description)
        .addDropdown((dropdown) => {
          dropdown
            .addOption("keep", "暂不处理（保留现状）")
            .addOption("delete", isLocalDeletion ? "确认同步删除到其他设备" : "确认在本机删除")
            .addOption("restore", isLocalDeletion ? "从云端恢复到本机" : "保留本机文件并恢复到云端")
            .setValue("keep")
            .onChange((value) => {
              this.decisions[item.path] = value as DeletionAction;
            });
        });
      setting.settingEl.addClass("wetongbu-deletion-review-item");
    }

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("暂不处理")
        .setCta()
        .onClick(() => {
          this.close();
          new Notice("已保留待处理删除，下次手动同步时可继续处理", 6000);
        }))
      .addButton((button) => button
        .setButtonText("执行所选操作")
        .onClick(() => {
          this.close();
          void this.plugin.resolveVaultDeletions(
            this.result.deletionPlanFingerprint ?? "",
            this.decisions,
          ).catch((error) => {
            new Notice(`删除处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
          });
        }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VaultSafetyModal extends Modal {
  constructor(
    app: App,
    private plugin: WeTongbuPlugin,
    private result: SyncResult,
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("发现大量文件变化，已暂停同步");
    const { contentEl } = this;
    contentEl.empty();
    const changed = this.result.safetyChangeCount ?? 0;
    const total = this.result.safetyTotalCount ?? 0;
    const actualRatio = total > 0 ? changed / total : 0;
    const threshold = this.result.safetyRatio ?? this.plugin.settings.vaultSafetyRatio;
    contentEl.createEl("p", {
      text: `本次涉及 ${changed} / ${total} 个文件（${formatPercent(actualRatio)}），超过当前 ${formatPercent(threshold)} 保护比例。`,
    });
    const labels: Record<string, string> = {
      local_created: "本地新增",
      local_modified: "本地修改",
      remote_created: "远端新增",
      remote_modified: "远端修改",
      local_deleted_propagate: "远端将删除",
      remote_deleted_propagate: "本地将删除",
      conflict: "冲突副本",
    };
    const details = Object.entries(this.result.safetyCounts ?? {})
      .filter(([key, count]) => key !== "equal" && count > 0)
      .map(([key, count]) => `${labels[key] ?? key} ${count}`)
      .join(" · ");
    if (details) contentEl.createEl("p", { text: details });
    contentEl.createEl("p", {
      text: "可以取消本次同步、只放行这一次，或调整后续保护比例。",
    });

    let selected = this.plugin.settings.vaultSafetyEnabled
      ? String(this.plugin.settings.vaultSafetyRatio)
      : "off";
    new Setting(contentEl)
      .setName("保护比例")
      .setDesc("仅影响当前设备；首次同步方向确认仍会单独生效")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("0.3", "30%")
          .addOption("0.5", "50%（默认）")
          .addOption("0.7", "70%")
          .addOption("0.9", "90%")
          .addOption("1", "100%")
          .addOption("off", "关闭保护（有风险）")
          .setValue(selected)
          .onChange((value) => { selected = value; });
      });

    new Setting(contentEl)
      .addButton((button) => button
        .setButtonText("取消本次同步")
        .setCta()
        .onClick(() => this.close()))
      .addButton((button) => button
        .setButtonText("仅允许这一次")
        .onClick(() => {
          const fingerprint = this.result.safetyPlanFingerprint ?? "";
          this.close();
          void this.plugin.allowVaultSafetyOnce(fingerprint).catch((error) => {
            new Notice(`继续同步失败：${error instanceof Error ? error.message : String(error)}`, 10000);
          });
        }))
      .addButton((button) => button
        .setButtonText("保存保护设置")
        .onClick(async () => {
          try {
            await this.plugin.setVaultSafety(selected !== "off", selected === "off" ? 0.5 : Number(selected));
            this.close();
            new Notice("大批量变更保护设置已保存，请再次点击立即同步", 6000);
          } catch (error) {
            new Notice(`保护设置保存失败：${error instanceof Error ? error.message : String(error)}`, 10000);
          }
        }));
  }

  onClose() {
    this.contentEl.empty();
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

  private displayPreservingScroll() {
    const scrollEl = this.containerEl.closest(".vertical-tab-content") as HTMLElement | null;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const scrollLeft = scrollEl?.scrollLeft ?? 0;
    this.display();
    if (scrollEl) {
      window.requestAnimationFrame(() => {
        scrollEl.scrollTop = scrollTop;
        scrollEl.scrollLeft = scrollLeft;
      });
    }
  }

  refreshFromPlugin() {
    this.displayPreservingScroll();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.classList.add("wetongbu-setting-tab");
    containerEl.classList.toggle("wetongbu-mobile-settings", Platform.isMobile);
    const scrollEl = containerEl.closest(".vertical-tab-content") as HTMLElement | null;
    scrollEl?.classList.toggle("wetongbu-mobile-settings", Platform.isMobile);
    scrollEl?.classList.add("wetongbu-setting-scroll");
    containerEl.empty();
    this.accessKeyInput ??= this.plugin.settings.accessKeySecretId
      ? this.app.secretStorage.getSecret(this.plugin.settings.accessKeySecretId) ?? ""
      : "";
    this.secretKeyInput ??= this.plugin.settings.secretKeySecretId
      ? this.app.secretStorage.getSecret(this.plugin.settings.secretKeySecretId) ?? ""
      : "";
    // User-managed object-storage configuration is retired for all new
    // accounts. Persisted legacy fields remain hidden for non-destructive
    // upgrades and are never used to construct a sync client.
    const canUseSelfHostedStorage = false;

    new Setting(containerEl)
      .setName("账号与登录")
      .setDesc(this.plugin.accountStatus)
      .addButton((button) =>
        button.setButtonText(this.plugin.accountLoggedIn ? "退出账号" : "登录账号")
          .onClick(async () => {
            const wasLoggedIn = this.plugin.accountLoggedIn;
            if (wasLoggedIn) {
              new AccountLogoutConfirmModal(this.app, async () => {
                await this.plugin.logoutAccount();
                this.display();
                new Notice("已退出当前账号");
              }).open();
              return;
            }
            try {
              button.setDisabled(true);
              await this.plugin.startAccountLogin();
              this.display();
              new Notice(this.plugin.accountLoggedIn
                ? "登录成功；需要时可在账号中心主动开启 Plus 试用"
                : "已打开授权页面，完成授权后插件会自动登录");
            } catch (error) {
              new Notice(`${wasLoggedIn ? "退出账号失败" : "登录失败"}：${error instanceof Error ? error.message : String(error)}`, 10000);
            } finally {
              button.setDisabled(false);
            }
          }),
      );

    const promotionLink = containerEl.createDiv({ cls: "wetongbu-promotion-link" }).createEl("a", {
      text: "免费月卡活动",
      href: "https://app.wetongbu.com/account/gift-cards",
    });
    promotionLink.addEventListener("click", (event) => {
      event.preventDefault();
      this.plugin.openPromotionCenter();
    });

    if ((this.plugin.accountPlanType === "pro" && this.plugin.canHostImages)
      || (this.plugin.accountLoggedIn && this.plugin.settings.imageDeliveryMode === "hosted_link")
      || this.plugin.settings.imageDeliveryMode === "hosted_link") {
      new Setting(containerEl)
        .setName("图片保存位置")
        .setDesc(this.plugin.canHostImages
          ? this.plugin.settings.imageDeliveryMode === "hosted_link"
            ? `图片会保存到微同步云端，以图片链接形式插入到笔记中。已使用：${formatBytes(this.plugin.hostedMediaUsedBytes)} / ${formatBytes(this.plugin.hostedMediaQuotaBytes)}。`
            : "图片会下载到 Obsidian 本地 vault 中。"
          : "云端图片目前处于只读宽限期：不能创建新的云端图片。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("local", "保存到本地")
            .addOption("hosted_link", "保存到微同步云端")
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
        );
    } else {
      new Setting(containerEl)
        .setName("图片保存位置")
        .setDesc(this.plugin.accountLoggedIn
          ? "当前套餐使用本地下载。开通有效 Plus 后，可选择将图片保存在微同步云端，并在笔记中插入稳定链接。"
          : "图片会下载到 Obsidian 本地。登录并开通 Plus 后，可选择云端图片链接。");
    }

    if (canUseSelfHostedStorage) {
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
        .setDesc(this.plugin.storageStatus || "测试会写入、读取并删除一个临时文件；只有测试成功且与主设备密钥一致时才会保存")
        .addButton((button) =>
          button.setButtonText("测试并保存").onClick(async () => {
            try {
              const result = await this.plugin.configureUserStorage(
                this.accessKeyInput ?? "",
                this.secretKeyInput ?? "",
              );
              this.display();
              new Notice(result === "migration_pending"
                ? "对象存储测试成功，正在迁移 Vault 内容；完成前继续使用原存储"
                : "对象存储测试成功，配置已保存", 8000);
            } catch (error) {
              this.display();
              new Notice(`对象存储测试失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          }),
        );

      if (this.plugin.settings.storageProvider !== "cloudflare_r2"
        || this.plugin.settings.bucket
        || this.plugin.settings.storageCredentialVersion) {
        const manager = this.plugin.settings.storageManagerDeviceName || "尚未确定（请先在电脑上测试并保存）";
        const state = this.plugin.settings.storageCredentialVersion
          ? (this.plugin.settings.storageManagerIsCurrentDevice ? "本机是存储管理设备" : "本机已记录当前密钥版本")
          : "本机尚未确认当前密钥版本";
        new Setting(containerEl)
          .setName("多端密钥状态")
          .setDesc(`存储管理设备：${manager}；${state}。如果其他设备更新了密钥，请先在电脑上测试并保存，再在本机填写相同密钥。`);
      }
    } else {
      new Setting(containerEl)
        .setName("同步与图片")
        .setDesc(this.plugin.accountLoggedIn
          ? "登录账号后由微同步统一托管多端同步；图片仍可按上方设置保存到本地或云端。"
          : "未登录时支持本地剪藏，图片保存到当前 Obsidian Vault；登录账号后可使用云端同步。无需其他设置。");
    }

    if (canUseSelfHostedStorage) {
      new Setting(containerEl)
        .setName("连接 Chrome 扩展")
        .setDesc(
          this.plugin.pairingCode
            ? `绑定码 ${this.plugin.pairingCode}，有效至 ${new Date(this.plugin.pairingExpiresAt).toLocaleTimeString()}`
            : "登录账号后，在浏览器完成设备授权并选择保存到哪个 Vault；不再需要配置对象存储或访问密钥",
        )
        .addButton((button) =>
          button.setButtonText("生成 6 位绑定码").onClick(async () => {
            try {
              await this.plugin.createBrowserPairingCode();
              this.display();
            } catch (error) {
              new Notice(`生成绑定码失败：${error instanceof Error ? error.message : String(error)}`);
            }
          }),
        );
    }

    if (canUseSelfHostedStorage) {
      const receiverName = this.plugin.captureReceiverStatus?.device_name;
      const canSetCaptureReceiver = !Platform.isIosApp && !Platform.isAndroidApp;
      new Setting(containerEl)
        .setName("剪藏接收设备（Free）")
        .setDesc(this.plugin.captureReceiverStatus?.is_current_device
          ? `本机（${receiverName || "当前电脑"}）会先接收飞书、网页和微信剪藏，再同步到其他设备。`
          : receiverName
            ? `当前由 ${receiverName} 接收剪藏；手机和其他设备通过 Vault 同步获得内容。`
            : "默认由第一台电脑接收剪藏；手机和其他设备通过 Vault 同步获得内容。")
        .addButton((button) => button
          .setButtonText("设为本机接收")
          .setDisabled(!canSetCaptureReceiver)
          .onClick(async () => {
            try {
              button.setDisabled(true);
              await this.plugin.setCurrentDeviceAsCaptureReceiver();
              new Notice("已将本机设为 Free 剪藏接收设备", 6000);
              this.display();
            } catch (error) {
              new Notice(`设置 Free 剪藏接收设备失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            } finally {
              button.setDisabled(false);
            }
          }));
    }

    this.textSetting("微同步目录", "文章、附件和 AI 说明文件的根目录", "rootFolder");

    if (this.plugin.pendingDeletionCount > 0) {
      new Setting(containerEl)
        .setName("待确认的删除")
        .setDesc(`有 ${this.plugin.pendingDeletionCount} 个文件等待你确认删除或恢复；微同步不会自动执行。`)
        .addButton((button) => button
          .setButtonText("查看并处理")
          .onClick(() => { void this.plugin.openPendingDeletionReview(); }));
    }

    new Setting(containerEl)
      .setName("冲突副本记录")
      .setDesc("同内容重试不会产生副本；确有差异的冲突会保留本地版本，并可在这里标记为已处理。")
      .addButton((button) => button
        .setButtonText("查看冲突记录")
        .onClick(() => { void this.plugin.openVaultConflictReview(); }));

    new Setting(containerEl)
      .setName("自动获取剪藏笔记")
      .setDesc(`插件启动时立即检查，之后每 ${this.plugin.settings.articleSyncIntervalSeconds} 秒检查一次飞书、网页和微信任务`)
      .addDropdown((dropdown) => {
        for (const seconds of ARTICLE_SYNC_INTERVAL_OPTIONS) {
          dropdown.addOption(String(seconds), seconds === 60 ? "1 分钟" : seconds === 300 ? "5 分钟" : `${seconds} 秒${seconds === 30 ? "（默认）" : ""}`);
        }
        dropdown
          .setValue(String(this.plugin.settings.articleSyncIntervalSeconds))
          .onChange(async (value) => {
            await this.plugin.setArticleSyncInterval(Number(value));
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("立即同步")
      .setDesc(this.plugin.settings.vaultSyncEnabled
        ? "获取新的剪藏笔记，并同步当前 Vault 的新增、修改和删除"
        : "检查飞书、网页和微信剪藏任务；开启多端同步后也会同步 Vault 文件")
      .addButton((button) =>
        button.setButtonText("立即同步").onClick(() => this.plugin.manualSync()),
      );

    const canVaultSync = this.plugin.accountCanVaultSync;
    const vaultSyncSetting = new Setting(containerEl)
      .setName("多端同步")
      .setDesc(canVaultSync
        ? "在多台设备间双向同步整个 Vault，无需其他设置。开启后仍需点击“立即同步”，或配置自动同步间隔；同文件在两台设备都修改时会生成冲突副本，不会静默覆盖。"
        : (this.plugin.accountLoggedIn
          ? "当前账号暂未开放 Vault 多端同步；同步权益由账号套餐配置。"
          : "登录账号后可连接云端 Vault，并在多台设备间同步。无需其他设置。"))
      .addToggle((toggle) =>
        toggle
          .setValue(canVaultSync && this.plugin.settings.vaultSyncEnabled)
          .setDisabled(!canVaultSync)
          .onChange(async (value) => {
            try {
              toggle.setDisabled(true);
              await this.plugin.setVaultSyncEnabled(value);
              if (value) {
                new Notice("Vault 多端同步已开启：请点击“立即同步”，或配置自动同步间隔", 7000);
              } else {
                new Notice("Vault 多端同步已暂停");
              }
              this.displayPreservingScroll();
            } catch (error) {
              new Notice(`Vault 同步设置失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              toggle.setValue(this.plugin.settings.vaultSyncEnabled);
            } finally {
              toggle.setDisabled(!this.plugin.accountCanVaultSync);
            }
          }),
      );
    vaultSyncSetting.settingEl.addClass("wetongbu-vault-sync-setting");

    if (this.plugin.accountCanVaultSync) {
      const currentInterval = this.plugin.settings.vaultSyncIntervalMinutes;
      new Setting(containerEl)
        .setName("自动同步 Vault")
        .setDesc(this.plugin.settings.vaultSyncEnabled
          ? (currentInterval === null ? "当前为无限：不会自动同步，请在上方点击“立即同步”。" : `每 ${currentInterval} 分钟自动同步一次；仍可随时点击“立即同步”。`)
          : "先开启多端同步；设置为“无限”可关闭自动同步。")
        .addDropdown((dropdown) => {
          dropdown
            .addOption("1", "1 分钟")
            .addOption("5", "5 分钟")
            .addOption("10", "10 分钟")
            .addOption("20", "20 分钟")
            .addOption("30", "30 分钟")
            .addOption("unlimited", "无限（关闭自动同步）")
            .setValue(currentInterval === null ? "unlimited" : String(currentInterval))
            .setDisabled(!this.plugin.settings.vaultSyncEnabled)
            .onChange(async (value) => {
              await this.plugin.setVaultSyncInterval(value === "unlimited" ? null : Number(value));
              this.displayPreservingScroll();
            });
          return dropdown;
        });
    }

    if (this.plugin.settings.vaultSyncEnabled && this.plugin.accountCanVaultSync) {
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
        .setDesc("仅在此设备第一次同步时生效。推荐自动判断：电脑先建立空云端基线，新设备与云端非破坏性合并；已有同步基线后不再使用。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("auto", "自动判断（推荐）")
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
        .setName("大批量变更保护")
        .setDesc(this.plugin.settings.vaultSafetyEnabled
          ? `一次同步涉及超过 ${formatPercent(this.plugin.settings.vaultSafetyRatio)} 的文件时暂停，避免异常状态导致大量文件被修改或删除。`
          : "已关闭：大批量文件变化会直接执行，请确认你了解可能的批量修改和删除风险。")
        .addToggle((toggle) => toggle
          .setValue(this.plugin.settings.vaultSafetyEnabled)
          .onChange(async (value) => {
            if (!value && !window.confirm("关闭后，大量修改和删除可能直接同步到其他设备。确定关闭保护吗？")) {
              toggle.setValue(true);
              return;
            }
            await this.plugin.setVaultSafety(value);
            this.display();
          }))
        .addDropdown((dropdown) => dropdown
          .addOption("0.3", "30%")
          .addOption("0.5", "50%（默认）")
          .addOption("0.7", "70%")
          .addOption("0.9", "90%")
          .addOption("1", "100%")
          .setValue(String(this.plugin.settings.vaultSafetyRatio))
          .setDisabled(!this.plugin.settings.vaultSafetyEnabled)
          .onChange(async (value) => {
            await this.plugin.setVaultSafety(true, Number(value));
            this.display();
          }));

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

    const hasPluginToken = this.plugin.hasPluginToken();
    if (this.plugin.accountPlanType === "pro" && !this.plugin.accountLoggedIn) {
      new Setting(containerEl)
        .setName("账号恢复")
        .setDesc("Plus 用户请点击上方“登录账号”，登录后会自动恢复当前账号和 Vault。");
    }
    if (canUseSelfHostedStorage) {
      const needsRecoveryInput = !this.plugin.settings.syncTargetId || !hasPluginToken;
      const recoverySetting = new Setting(containerEl)
        .setName("恢复当前 Vault")
        .setDesc(needsRecoveryInput
          ? "自助版用户可使用之前保存的恢复码恢复当前 Vault，不会删除本地文章。"
          : "当前 Vault 已连接；更换设备时请使用下方保存的恢复码恢复。");
      if (needsRecoveryInput) {
        recoverySetting
          .addText((text) => {
            text.inputEl.type = "password";
            text
              .setPlaceholder("请输入恢复码")
              .setValue(this.recoveryTokenInput)
              .onChange((value) => { this.recoveryTokenInput = value; });
          })
          .addButton((button) => button
            .setButtonText(hasPluginToken ? "恢复 Free Vault" : "使用 Free 恢复码")
            .onClick(async () => {
              try {
                await this.plugin.recoverFreeVault(this.recoveryTokenInput);
                this.recoveryTokenInput = "";
                this.display();
                new Notice("Free Vault 已恢复，请保存新的恢复码");
              } catch (error) {
                new Notice(`恢复失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              }
            }));
      }

      const recoveryTokenSetting = new Setting(containerEl)
        .setName("更换设备与恢复（重要）")
        .setDesc(
          this.plugin.recoveryToken
            ? `请保存到安全位置，用于更换设备或重装插件：${this.plugin.recoveryToken}`
            : "连接当前 Vault 后可在这里生成恢复码；重新生成后旧恢复码立即失效",
        );
      if (this.plugin.recoveryToken) {
        recoveryTokenSetting.addButton((button) => button
          .setButtonText("复制恢复码")
          .onClick(async () => {
            try {
              if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制");
              await navigator.clipboard.writeText(this.plugin.recoveryToken);
              new Notice("恢复码已复制，请保存到安全位置");
            } catch (error) {
              new Notice(`复制恢复码失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          }));
      }
      if (this.plugin.settings.syncTargetId && hasPluginToken) {
        recoveryTokenSetting.addButton((button) => button
          .setButtonText(this.plugin.recoveryToken ? "重新生成恢复码" : "生成恢复码")
          .onClick(async () => {
            try {
              await this.plugin.rotateRecoveryToken();
              this.display();
              new Notice("已生成新的恢复码，旧恢复码已失效");
            } catch (error) {
              new Notice(`恢复码生成失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            }
          }));
      }
    }

    new Setting(containerEl)
      .setName("插件版本")
      .setDesc(`当前已加载：${this.plugin.manifest.version}`);

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
