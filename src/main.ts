import {
  addIcon,
  FuzzySuggestModal,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
  type App,
} from "obsidian";
import { buildVaultPaths } from "./shared/vault-layout.mjs";
import { normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { validateWebclipManifest, verifyWebclipPackageFiles } from "./shared/feishu-package.mjs";
import { createEncryptedVaultStorage, createFreeS3Storage, createProHostedStorage, deriveS3Config, type VaultSyncStorage } from "./vault-sync-storage";
import { VaultSyncRemoteClient, type VaultSyncClientOptions } from "./vault-sync-remote";
import type { VaultSyncV2DeviceProgress, VaultSyncV2FileVersion, VaultSyncV2FileVersionsPage } from "./vault-sync-v2-remote";
import {
  createPrevSyncStore,
  runV2PushAfterCompleteLocalScan,
  scanLocalFiles,
  shouldSyncPath,
  VAULT_SYNC_PERIODIC_AUDIT_BATCH_SIZE,
} from "./vault-sync-local";
import { createVaultSyncIndex, type VaultSyncLocalIndex } from "./vault-sync-index";
import { captureHandoffFilesForExistingTask, captureHandoffFilesHaveCommittedSuccessors, captureHandoffStatusSummary, createCaptureHandoffStore, type CaptureHandoffStore } from "./capture-handoff";
import { selectCompletionNote, updateCompletionNoteMetadata } from "./completion-note";
import { assertCompletionTaskIdentity, normalizeCompletionSourceUrl } from "./completion-task-validation";
import { resolveAssetTarget } from "./asset-target";
import { applyMediaContinuationAsset, commitMediaContinuationNoteAndEvidence, localClipImageLayoutAssets, processLocalClipImages, replaceMarkdownDestination } from "./media-continuation";
import { completeLocalClipTaskWithRetry } from "./local-clip-completion";
import { unzipWebclipArchive } from "./webclip-zip";
import { createVaultSyncOrchestrator, type SyncResult } from "./vault-sync";
import { createVaultSyncBootstrapNoticeGate } from "./vault-sync-bootstrap-notice";
import { findDuplicateLocalFiles, type DeletionAction, type DeletionResolution } from "./vault-sync-deletion";
import {
  createPendingV2DeletionReviewHandler,
  describeDeletionReviewDirection,
  formatMissingLocalDeletionConflict,
  formatLocalDeletionReminder,
  DeletionReviewConfirmationLane,
  DeletionReviewModalLifetime,
  formatPendingDeletionReviewNotice,
  localDeletionReminderSuppressionKey,
  nextDeletionReviewNotice,
  PendingDeletionReviewOpener,
  shouldCloseDeletionReviewModal,
  shouldDismissDeletionReviewOnError,
  shouldNotifyEmptyDeletionReview,
  shouldShowDeletionReviewNotice,
  type DeletionReviewNoticeEntry,
} from "./vault-sync-deletion-notice";
import { createVaultSyncRetryScheduler, getVaultSyncFailureNotice, isRetryableVaultSyncError, isVaultSyncActiveEditorBusyError, shouldScheduleVaultSyncFailureRetry } from "./vault-sync-retry";
import { createDebouncedVaultSyncScheduler, createPausableIntervalScheduler } from "./vault-sync-scheduler";
import { createVaultSyncEmptyNoteGrace, excludeDeferredEmptyNotes } from "./vault-sync-empty-note-grace";
import { createVaultSyncLifecycleHandlers, deferVaultSyncAutomaticRunForRetry } from "./vault-sync-lifecycle";
import {
  assertVaultPathGeneration,
  assertSafeTextReplacement,
  cleanupTextReplacementArtifacts,
  removeBinaryAssetIfUnchanged,
  withVaultPathWriteLock,
  withVaultPathWriteLocks,
  writeBinaryAssetSafely,
  writeTextAtomically,
  recoverInterruptedTextReplacementsAfterLayoutReady,
  getConflictActionAvailability,
  isVaultPathOpenInMarkdownEditor,
} from "./vault-sync-write-safety";
import { sha256Hex } from "./shared/hash";
import { assertVaultEncryptionCredentialChangeSafe, createVaultSyncCrypto, type VaultSyncCrypto, type VaultSyncCryptoKeyring } from "./shared/vault-sync-crypto";
import { addVaultSyncCryptoKeyDescriptor, assertVaultSyncEncryptionVersionCompatible, loadVaultSyncCryptoKeyring, normalizeVaultSyncCryptoKeyDescriptors, validateVaultSyncRemoteKeyVersionCatalog, type VaultSyncCryptoKeyDescriptor } from "./vault-sync-crypto-keyring";
import { createVaultSyncOutboxStore, loadLatestVaultSyncOutboxSnapshot, type VaultSyncInboxEntry, type VaultSyncOutboxOperation, type VaultSyncOutboxSnapshot, type VaultSyncV2Identity } from "./vault-sync-outbox";
import { summarizeVaultSyncNeedsRebase } from "./vault-sync-needs-rebase";
import { createVaultSyncV2BaselineStore, loadLatestVaultSyncV2Baseline } from "./vault-sync-v2-baseline";
import { createVaultSyncV2BaseContentStore } from "./vault-sync-v2-base-content";
import { archiveLegacyPrevSyncStateForV2 } from "./vault-sync-v2-legacy-migration";
import { createVaultSyncV2SnapshotStageStore } from "./vault-sync-v2-snapshot-store";
import { canPushIndependentFilesAfterBlockedPull, classifyVaultSyncV2PullResult, createVaultSyncV2PullEngine } from "./vault-sync-v2-pull";
import { createVaultSyncV2PushEngine, type VaultSyncV2PendingDeletion } from "./vault-sync-v2-push";
import { createVaultSyncV2ApplyEngine } from "./vault-sync-v2-apply";
import { createVaultSyncRemoteRenameEventGuard } from "./vault-sync-remote-rename-event-guard";
import { createVaultSyncRemoteDeleteEventGuard } from "./vault-sync-remote-delete-event-guard";
import { createV2HostedObjectTransport, VAULT_SYNC_DOWNLOAD_RANGE_BYTES } from "./vault-sync-v2-storage";
import { createVaultSyncV2DownloadStageStore } from "./vault-sync-v2-download-stage";
import { downloadVaultSyncV2ToVerifiedStage } from "./vault-sync-v2-plaintext-stage";
import { createVaultSyncV2EventsClient } from "./vault-sync-v2-events";
import {
  canPreviewHistoryVersion,
  canRestoreHistoryVersion,
  formatVaultSyncHistoryError,
  HISTORY_PREVIEW_MAX_BYTES,
  HISTORY_RESTORE_MAX_BYTES,
  historyRestoreTargetPath,
  isVaultSyncContentWithinPlaintextLimit,
  isVaultSyncPlaintextSizeCompatible,
  VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES,
} from "./vault-sync-history";
import { createVaultSyncObjectWorkGate } from "./vault-sync-object-work-gate";
import { assertVaultSyncScopeConfigured, saveVaultSyncScopeAfterRemoteConfirmation, type VaultSyncScope } from "./vault-sync-scope-update";
import { restoreConflictEditorTextFormat, submitManualConflictMerge } from "./vault-sync-conflict-merge";
import { resolveConflictAndScheduleFollowUp } from "./vault-sync-conflict-actions";
import {
  classifyRemoteRenameTargetIdentity,
  describeRemoteRenameConflictHint,
  type RemoteRenameTargetIdentity,
} from "./vault-sync-conflict-hint";
import { createVaultSyncKeyRotationStore, type VaultSyncKeyRotationIdentity } from "./vault-sync-key-rotation";
import { runVaultSyncKeyRotation } from "./vault-sync-key-rotation-runner";
import {
  createVaultSyncDiagnostics,
  type VaultSyncDiagnosticOutcome,
  type VaultSyncDiagnosticProtocol,
  type VaultSyncDiagnosticStage,
  type VaultSyncDiagnosticWorkSummary,
  type VaultSyncMultipartTransferDiagnostic,
} from "./vault-sync-diagnostics";
import { createVaultSyncPathIntentStore, resolveVaultSyncPathMoveIdentities } from "./vault-sync-path-intents";
import { registerVaultSyncPathEvents } from "./vault-sync-path-events";
import { createVaultSyncCompositionGuard } from "./vault-sync-composition-guard";
import { createVaultSyncOrderedQueue } from "./vault-sync-ordered-queue";
import { canAutomaticallyPropagateDeletes, type VaultSyncDeleteMode } from "./vault-sync-deletion-policy";
import { loadVaultSyncInterval, normalizeVaultSyncInterval, VAULT_SYNC_INTERVAL_OPTIONS } from "./vault-sync-preferences";
import { createVaultSyncScopeStateStore } from "./vault-sync-scope-state";
import { formatPendingDeletionDeviceProgress, formatVaultSyncDeviceCursors } from "./vault-sync-device-progress";
import { fetchV2DeviceProgressWhenActive, resolveVaultSyncProtocol } from "./vault-sync-device-progress-refresh";
import { createVaultSyncInitializationLeaseKeeper } from "./vault-sync-initialization-lease";
import {
  dismissConflictActionForActiveEditorBusy,
  registerVaultSyncEditorRetryEvents,
  shouldSchedulePendingVaultSyncRetry,
} from "./vault-sync-editor-retry";
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

function createVaultSyncRemoteClient(options: Omit<VaultSyncClientOptions, "requestTransport">) {
  return new VaultSyncRemoteClient({
    ...options,
    requestTransport: (request: any) => requestUrl(request),
  });
}

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
  vaultSyncMergeMode: VaultSyncMergeMode;
  vaultSyncDeleteMode: VaultSyncDeleteMode;
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
  vaultEncryptionKeyVersion: number;
  vaultEncryptionKeyring: VaultSyncCryptoKeyDescriptor[];
  vaultEncryptionRotationOperationId: string;
  vaultEncryptionRotationId: string;
  vaultEncryptionRotationSecretId: string;
  vaultEncryptionRotationSourceVersion: number;
  vaultEncryptionRotationSourceSaltHex: string;
  vaultEncryptionRotationTargetVersion: number;
  vaultEncryptionRotationTargetSaltHex: string;
  /** Pending account device authorization survives mobile backgrounding. */
  pendingDeviceCode: string;
  pendingDeviceVerificationUri: string;
}

type StorageProvider = "cloudflare_r2" | "aws_s3" | "aliyun_oss" | "tencent_cos";
type ImageDeliveryMode = "local" | "hosted_link";
type VaultFirstSyncDirection = "ask" | "auto" | "remote" | "local";
type VaultSyncMergeMode = "automatic" | "manual";

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
  vaultSyncRetryAfterNotBeforeMs?: number;
  vaultSyncRetryTargetKey?: string;
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
const VAULT_SAFETY_RATIO_OPTIONS = [0.3, 0.5, 0.7, 0.9, 1] as const;
// Retry-After is device scheduling state; keep it out of plugin data.json, which may sync between devices.
const VAULT_SYNC_RETRY_AFTER_LOCAL_STORAGE_KEY = "wetongbu-vault-sync-retry-after-v1";
const LOCAL_CLIP_IMAGE_QUEUE_KEY = "wetongbu-local-clip-image-queue-v1";
const LOCAL_CLIP_IMAGE_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

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

const vaultSyncObjectWorkGate = createVaultSyncObjectWorkGate();

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
  vaultSyncIntervalMinutes: 1,
  vaultSyncScope: "whole_vault",
  vaultSyncMergeMode: "automatic",
  vaultSyncDeleteMode: "review",
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
  vaultEncryptionKeyVersion: 1,
  vaultEncryptionKeyring: [],
  vaultEncryptionRotationOperationId: "",
  vaultEncryptionRotationId: "",
  vaultEncryptionRotationSecretId: "",
  vaultEncryptionRotationSourceVersion: 0,
  vaultEncryptionRotationSourceSaltHex: "",
  vaultEncryptionRotationTargetVersion: 0,
  vaultEncryptionRotationTargetSaltHex: "",
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
  private accountStatusRefreshGeneration = 0;
  vaultEncryptionRotationAvailable = false;
  vaultEncryptionRotationStatus = "";
  private vaultEncryptionRotationCapabilitiesFetchedAt = 0;
  private vaultEncryptionRotationCapabilitiesRequest: Promise<boolean> | null = null;
  vaultEncryptionRotationRunning = false;
  // User-managed object storage is retired. Keep the persisted compatibility
  // fields for non-destructive upgrades, but never use them to enable sync.
  accountLegacyFreeStorageCompat = false;
  accountCanVaultSync = false;
  canHostImages = false;
  hostedMediaQuotaBytes = 0;
  hostedMediaUsedBytes = 0;
  lastSafeErrorCode = "";
  private vaultSyncing = false;
  private vaultSyncScopeChanging = false;
  private vaultDeviceTokenCache = "";
  private accountPollTimer: number | null = null;
  private articleSyncTimer: number | null = null;
  private vaultSyncTimer: ReturnType<typeof createPausableIntervalScheduler> | null = null;
  private articleSyncSchedulerStarted = false;
  private vaultSyncRetry: ReturnType<typeof createVaultSyncRetryScheduler> | null = null;
  private vaultSyncEventScheduler: ReturnType<typeof createDebouncedVaultSyncScheduler> | null = null;
  private vaultSyncEmptyNoteGrace: ReturnType<typeof createVaultSyncEmptyNoteGrace> | null = null;
  private vaultSyncLifecycleActive = false;
  private vaultSyncLifecycleGeneration = 0;
  private vaultSyncWriteRecoveryReady = false;
  private vaultSyncWriteRecoveryBlocked = false;
  private vaultSyncWriteRecoveryBlockedPaths: string[] = [];
  private vaultSyncV2Events: ReturnType<typeof createVaultSyncV2EventsClient> | null = null;
  private vaultSyncEventPending = false;
  private readonly vaultSyncEditorDeferredPaths = new Set<string>();
  private vaultSyncProtocolUpgradeTargetKey = "";
  private readonly vaultSyncBootstrapNoticeGate = createVaultSyncBootstrapNoticeGate();
  readonly vaultSyncDiagnostics = createVaultSyncDiagnostics();
  private vaultSafetyOverrideFingerprint = "";
  private pendingDeletionReview: SyncResult | null = null;
  private pendingV2DeletionReview: VaultSyncV2PendingDeletion[] = [];
  private pendingV2DeletionHandler: ((item: VaultSyncV2PendingDeletion) => Promise<VaultSyncV2PendingDeletion[]>) | null = null;
  private readonly deletionReviewConfirmationLane = new DeletionReviewConfirmationLane();
  private pendingDeletionReviewNoticeKey = "";
  private pendingDeletionReviewNoticeSuppressedKey = "";
  private pendingDeletionReviewNotice: Notice | null = null;
  private readonly pendingDeletionReviewOpener = new PendingDeletionReviewOpener();
  private localDeletionReminderNotice: Notice | null = null;
  private readonly localDeletionReminderPaths = new Set<string>();
  private pendingDeletionStatusBarItem: HTMLElement | null = null;
  private readonly remoteDeleteEventGuard = createVaultSyncRemoteDeleteEventGuard();
  private pendingV2DeletionReviewModalOpen = false;
  private pendingV2DeletionReviewModal: VaultSyncV2DeletionReviewModal | null = null;
  private vaultSyncPathIntentFailure = false;
  private vaultSyncPathIntentWrites = 0;
  private readonly vaultSyncPathIntentQueue = createVaultSyncOrderedQueue();
  private readonly vaultSyncRemoteRenameEventGuard = createVaultSyncRemoteRenameEventGuard();
  private vaultSyncCompositionGuard: ReturnType<typeof createVaultSyncCompositionGuard> | null = null;
  private storageSwitching = false;
  private captureHandoffs!: CaptureHandoffStore;
  private vaultSyncIndex!: VaultSyncLocalIndex;
  private localClipImageQueue: Promise<void> = Promise.resolve();
  private settingTab: WeTongbuSettingTab | null = null;
  captureReceiverStatus: { device_name: string | null; is_current_device: boolean } | null = null;
  vaultEncryptionInput = "";
  vaultEncryptionRotationInput = "";
  vaultSyncDeviceProgress: VaultSyncV2DeviceProgress | null = null;
  vaultSyncDeviceProgressFetchedAt = "";
  private pluginTokenMissingNoticeShown = false;

  async onload() {
    this.vaultSyncLifecycleGeneration += 1;
    this.vaultSyncLifecycleActive = true;
    this.captureHandoffs = createCaptureHandoffStore(this.app);
    this.vaultSyncIndex = await createVaultSyncIndex(this.app);
    this.vaultSyncEventScheduler = createDebouncedVaultSyncScheduler(async ({ queueWaitMs, activeQueueWaitMs }) => {
      if (!this.settings.vaultSyncEnabled || this.settings.vaultSyncIntervalMinutes === null) return;
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        this.vaultSyncEventPending = true;
        return;
      }
      if (this.vaultSyncing) {
        this.vaultSyncEventPending = true;
        return;
      }
      if (deferVaultSyncAutomaticRunForRetry(this.vaultSyncRetry)) {
        this.vaultSyncEventPending = true;
        return;
      }
      this.vaultSyncEventPending = false;
      await this.runVaultSync(true, undefined, { queueWaitMs, activeQueueWaitMs });
    });
    if (typeof navigator !== "undefined" && !navigator.onLine) this.vaultSyncEventScheduler.pause();
    if (typeof document !== "undefined" && document.hidden) this.vaultSyncEventScheduler.pause();
    const rawSaved = await this.loadData();
    const saved = (rawSaved ?? {}) as PersistedSettings;
    const {
      noteFolder: _legacyNoteFolder,
      attachmentFolder: _legacyAttachmentFolder,
      vaultSyncRetryAfterNotBeforeMs: _legacySyncedRetryDeadline,
      vaultSyncRetryTargetKey: _legacySyncedRetryTargetKey,
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
    this.settings.vaultSyncIntervalMinutes = loadVaultSyncInterval(currentSettings);
    this.settings.vaultSyncMergeMode = this.settings.vaultSyncMergeMode === "manual" ? "manual" : "automatic";
    this.settings.vaultSyncDeleteMode = this.settings.vaultSyncDeleteMode === "automatic" ? "automatic" : "review";
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
    const retryAfterState = this.app.loadLocalStorage(VAULT_SYNC_RETRY_AFTER_LOCAL_STORAGE_KEY) as {
      deadlineMs?: unknown;
      targetKey?: unknown;
    } | null;
    const savedRetryDeadline = Number(retryAfterState?.deadlineMs);
    const savedRetryTargetKey = typeof retryAfterState?.targetKey === "string"
      ? retryAfterState.targetKey : "";
    let initialRetryAfterNotBeforeMs = 0;
    if (!this.settings.vaultSyncEnabled || this.settings.vaultSyncIntervalMinutes === null
      || !Number.isSafeInteger(savedRetryDeadline) || savedRetryDeadline <= Date.now()
      || savedRetryTargetKey !== this.currentVaultSyncProtocolTargetKey()) {
      this.app.saveLocalStorage(VAULT_SYNC_RETRY_AFTER_LOCAL_STORAGE_KEY, null);
    } else {
      initialRetryAfterNotBeforeMs = savedRetryDeadline;
    }
    if (!this.settings.vaultInstallationId) {
      this.settings.vaultInstallationId = crypto.randomUUID();
    }
    await this.ensureVaultIdentityId();
    await this.saveSettings();
    const emptyNoteGraceStorageKey = `wetongbu-vault-sync-empty-note-grace:${this.settings.vaultIdentityId}`;
    this.vaultSyncEmptyNoteGrace = createVaultSyncEmptyNoteGrace({
      onReady: (path) => this.onVaultSyncPathChange(path),
      onPendingChange: (pending) => this.app.saveLocalStorage(emptyNoteGraceStorageKey, pending),
    });
    this.vaultSyncEmptyNoteGrace.restore(this.app.loadLocalStorage(emptyNoteGraceStorageKey));
    for (const event of registerVaultSyncPathEvents(this.app.vault, {
      onPathChange: (path, deleted, kind, file) => this.onVaultSyncPathChange(path, deleted, true, kind, file),
      onDelete: (path) => {
        if (this.remoteDeleteEventGuard.shouldNotifyLocalDelete(path)) this.notifyLocalVaultNoteDeleted(path);
      },
      onRename: (file, oldPath) => {
        this.vaultSyncCompositionGuard?.refresh();
        void this.onVaultSyncRename(file, oldPath);
      },
    })) this.registerEvent(event);
    this.vaultSyncCompositionGuard = createVaultSyncCompositionGuard(
      this.app,
      () => this.requestAutomaticVaultSync(),
    );
    this.register(() => {
      this.vaultSyncCompositionGuard?.dispose();
      this.vaultSyncCompositionGuard = null;
    });
    const compositionWorkspace: any = this.app.workspace;
    for (const eventName of ["layout-change", "active-leaf-change", "file-open"]) {
      this.registerEvent(compositionWorkspace.on(eventName, () => this.vaultSyncCompositionGuard?.refresh()));
    }
    for (const event of registerVaultSyncEditorRetryEvents(
      this.app,
      () => [...this.vaultSyncEditorDeferredPaths],
      () => this.requestAutomaticVaultSync(),
    )) this.registerEvent(event);
    this.registerObsidianProtocolHandler("wetongbu-import", (params) => {
      void this.handleLocalClipImport(params as Record<string, unknown>);
    });
    this.registerObsidianProtocolHandler("wetongbu-media-import", (params) => {
      void this.handleClipMediaImport(params as Record<string, unknown>);
    });
    this.app.workspace.onLayoutReady(() => { void this.resumePendingLocalClipImageJobs(); });
    this.vaultSyncRetry = createVaultSyncRetryScheduler({
      run: () => this.settings.vaultSyncIntervalMinutes === null
        ? Promise.resolve()
        : this.runVaultSync(true),
      initialRetryAfterNotBeforeMs,
      onRetryAfterNotBeforeChange: (deadlineMs) => {
        this.app.saveLocalStorage(VAULT_SYNC_RETRY_AFTER_LOCAL_STORAGE_KEY, deadlineMs === null ? null : {
          deadlineMs,
          targetKey: this.currentVaultSyncProtocolTargetKey(),
        });
      },
    });
    void this.refreshAccountStatus();
    void this.refreshCaptureReceiverStatus();
    void this.resumeAccountLogin().catch(() => undefined);
    const vaultSyncLifecycle = createVaultSyncLifecycleHandlers({
      isOnline: () => typeof navigator === "undefined" || navigator.onLine,
      isHidden: () => typeof document !== "undefined" && document.hidden,
      setEventOnline: (online) => this.vaultSyncV2Events?.setOnline(online),
      setEventForeground: (foreground) => this.vaultSyncV2Events?.setForeground(foreground),
      eventScheduler: {
        pause: () => this.vaultSyncEventScheduler?.pause(),
        resume: () => this.vaultSyncEventScheduler?.resume(),
      },
      retryScheduler: {
        clear: () => this.vaultSyncRetry?.clear(),
        pause: () => this.vaultSyncRetry?.pause(),
        resume: () => this.vaultSyncRetry?.resume(),
        wake: () => this.vaultSyncRetry?.wake(),
        hasPendingRetry: () => this.vaultSyncRetry?.hasPendingRetry() ?? false,
      },
      intervalScheduler: { pause: () => this.vaultSyncTimer?.pause() },
      restartIntervalScheduler: () => this.restartVaultSyncTimer(),
      resumeAccountLogin: () => { void this.resumeAccountLogin().catch(() => undefined); },
      requestAutomaticSync: () => this.requestAutomaticVaultSync(),
    });
    this.registerDomEvent(window, "focus", vaultSyncLifecycle.focus);
    this.registerDomEvent(window, "online", vaultSyncLifecycle.online);
    this.registerDomEvent(window, "offline", vaultSyncLifecycle.offline);
    this.registerDomEvent(document, "visibilitychange", vaultSyncLifecycle.visibilityChange);
    this.settingTab = new WeTongbuSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    const pendingDeletionStatusBarItem = this.addStatusBarItem();
    pendingDeletionStatusBarItem.addClass("mod-clickable");
    pendingDeletionStatusBarItem.setAttribute("role", "button");
    pendingDeletionStatusBarItem.setAttribute("tabindex", "0");
    pendingDeletionStatusBarItem.addEventListener("click", () => { void this.openPendingDeletionReview(); });
    pendingDeletionStatusBarItem.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.openPendingDeletionReview();
      }
    });
    this.pendingDeletionStatusBarItem = pendingDeletionStatusBarItem;
    this.refreshPendingDeletionStatusBarItem();
    this.addCommand({
      id: "vault-sync-review-deletions",
      name: "微同步：处理待确认删除",
      callback: () => { void this.openPendingDeletionReview(); },
    });
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
    this.addCommand({
      id: "vault-sync-history",
      name: "微同步：查看当前文件的云端历史版本",
      callback: () => void this.openVaultHistory(),
    });
    this.addCommand({
      id: "vault-sync-deleted-history",
      name: "微同步：恢复已删除文件的历史版本",
      callback: () => void this.openDeletedVaultHistory(),
    });
    this.addCommand({
      id: "vault-sync-conflicts",
      name: "微同步：处理待解决同步冲突",
      callback: () => void this.openVaultSyncConflictCenter(),
    });
    void recoverInterruptedTextReplacementsAfterLayoutReady(this.app).then(
      (textRecovery) => this.startAfterVaultWriteRecovery(textRecovery),
      () => this.startAfterVaultWriteRecovery({
        cleanedPaths: [],
        unresolved: [{ path: "无法读取本地 Vault 文件索引", artifacts: [] }],
      }),
    );
  }

  private startAfterVaultWriteRecovery(
    textRecovery: Awaited<ReturnType<typeof recoverInterruptedTextReplacementsAfterLayoutReady>>,
  ) {
    if (textRecovery.unresolved.length) {
      this.vaultSyncWriteRecoveryBlocked = true;
      this.vaultSyncWriteRecoveryBlockedPaths = textRecovery.unresolved.map((entry) => entry.path);
      const paths = this.vaultSyncWriteRecoveryBlockedPaths.slice(0, 3).join("、");
      new Notice(`检测到 ${textRecovery.unresolved.length} 个笔记写入中断现场，Vault 同步已暂停以保留文件。请检查目标及同目录 .wetongbu-update/.wetongbu-complete 临时文件后重载；${paths}`, 15000);
    }
    this.vaultSyncWriteRecoveryReady = true;
    this.articleSyncSchedulerStarted = true;
    void this.ensureWorkspace();
    void this.syncNow(true).then(() => this.recoverCaptureHandoffs());
    this.restartArticleSyncTimer();
    this.restartVaultSyncTimer();
    this.requestAutomaticVaultSync();
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
    this.vaultSyncLifecycleGeneration += 1;
    this.vaultSyncLifecycleActive = false;
    const deletionReviewModal = this.pendingV2DeletionReviewModal;
    this.pendingV2DeletionReviewModal = null;
    this.pendingV2DeletionReviewModalOpen = false;
    deletionReviewModal?.close();
    this.hidePendingDeletionReviewNotice();
    this.hideLocalDeletionReminderNotice();
    if (this.accountPollTimer !== null) window.clearInterval(this.accountPollTimer);
    this.accountPollTimer = null;
    if (this.articleSyncTimer !== null) window.clearInterval(this.articleSyncTimer);
    this.articleSyncTimer = null;
    this.vaultSyncTimer?.stop();
    this.vaultSyncTimer = null;
    // Cancel the OS timer, but keep the persisted server deadline so a plugin
    // reload cannot immediately bypass an active Retry-After response.
    this.vaultSyncRetry?.pause();
    this.vaultSyncRetry = null;
    this.vaultSyncEventScheduler?.stop();
    this.vaultSyncEventScheduler = null;
    this.vaultSyncEmptyNoteGrace?.stop();
    this.vaultSyncEmptyNoteGrace = null;
    this.stopVaultSyncV2Events();
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
   * Claim an optional media task for a note that the browser already created
   * with Obsidian's core `new` URI. This handler never writes article text.
   */
  private async handleClipMediaImport(params: Record<string, unknown>) {
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const claimToken = typeof params.token === "string" ? params.token : "";
    const captureId = typeof params.captureId === "string" ? params.captureId : "";
    const mode = params.mode === "hosted" ? "hosted" : "local";
    const requestedTargetId = typeof params.target === "string" ? params.target.trim() : "";
    const requestedVault = typeof params.vault === "string" ? params.vault.trim() : "";
    const requestedNotePath = typeof params.file === "string" ? params.file.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(taskId) || !claimToken || !/^[0-9a-f-]{36}$/i.test(captureId)) {
      new Notice("图片补全链接缺少任务凭证", 8000);
      return;
    }
    if (requestedTargetId && requestedTargetId !== this.settings.syncTargetId) {
      new Notice("图片任务属于另一个 Vault，当前 Vault 未处理。", 10000);
      return;
    }
    if (requestedTargetId && !this.settings.syncTargetId) {
      new Notice("当前 Vault 尚未连接账号，无法处理定向图片任务。", 10000);
      return;
    }
    if (requestedVault && requestedVault !== this.app.vault.getName()) {
      new Notice(`图片任务目标是 Vault“${requestedVault}”，当前打开的是“${this.app.vault.getName()}”，未处理。`, 10000);
      return;
    }
    if (requestedNotePath && (requestedNotePath.split(/[\\/]/).some((part) => part === "..")
      || normalizePath(requestedNotePath).startsWith(".obsidian/"))) {
      new Notice("图片任务笔记路径无效，未修改 Vault。", 8000);
      return;
    }
    const base = this.settings.apiBaseUrl.replace(/\/$/, "");
    try {
      const response = await requestUrl({
        url: `${base}/api/clip-tasks/${encodeURIComponent(taskId)}/claim`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ token: claimToken, ...(requestedTargetId ? { target_id: requestedTargetId } : {}) }),
        throw: false,
      });
      if (response.status !== 200) throw new Error(response.json?.error ?? "图片任务领取失败");
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
        throw new Error("图片任务属于另一个 Vault，当前 Vault 未处理");
      }
      const deadline = Date.now() + 20_000;
      let note: any = null;
      while (Date.now() < deadline && !note) {
        note = await this.findClipContinuationNote(captureId, requestedNotePath || undefined);
        if (!note) await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
      if (!note) throw new Error("已先保存正文，但暂时找不到对应文章；原图链接仍保留，请稍后重试图片补全");

      const imageUrls = mode === "local" && payload.imageMode === "local" && Array.isArray(payload.imageUrls)
        ? payload.imageUrls.slice(0, 200)
        : [];
      if (imageUrls.length) {
        this.scheduleLocalClipImageProcessing({
          manifest: {
            taskId: payload.taskId,
            captureId,
            title: payload.title,
            sourceUrl: payload.sourceUrl,
            capturedAt: String(note.frontmatter.captured_at ?? new Date().toISOString()),
          },
          markdown: payload.markdown,
          assets: [],
        }, imageUrls, note.file.path);
      }
      await completeLocalClipTaskWithRetry({
        complete: async () => {
          const result = await requestUrl({
            url: `${base}/api/clip-tasks/${encodeURIComponent(taskId)}/complete`,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify({ token: claimToken }),
            throw: false,
          });
          return { status: result.status, error: result.json?.error };
        },
      });
      if (imageUrls.length) new Notice(`正文已保存；${imageUrls.length} 张图片已开始后台补全`, 6000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`正文已保存；图片没有阻塞正文。图片补全未完成：${message}`, 10000);
      console.warn("WeTongbu clip media import failed after article handoff", error);
    }
  }

  /**
   * Download local clip images after the note is visible.  Tasks and images
   * are serialized so a batch never retains many full-size response bodies.
   */
  private localClipImageJobsStorageKey() {
    return `${LOCAL_CLIP_IMAGE_QUEUE_KEY}:${encodeURIComponent(this.app.vault.getName())}`;
  }

  private readPendingLocalClipImageJobs(): any[] {
    const stored = this.app.loadLocalStorage(this.localClipImageJobsStorageKey());
    if (!Array.isArray(stored)) return [];
    return stored.filter((job) => job && typeof job === "object"
      && typeof job.id === "string"
      && typeof job.createdAt === "number"
      && typeof job.notePath === "string"
      && Array.isArray(job.imageUrls)
      && job.task?.manifest && typeof job.task.manifest.taskId === "string");
  }

  private removePendingLocalClipImageJob(taskId: string) {
    const jobs = this.readPendingLocalClipImageJobs().filter((job) => job.id !== taskId);
    this.app.saveLocalStorage(this.localClipImageJobsStorageKey(), jobs);
  }

  private async resumePendingLocalClipImageJobs() {
    const now = Date.now();
    const jobs = this.readPendingLocalClipImageJobs();
    const resumable: any[] = [];
    for (const job of jobs) {
      if (now - job.createdAt > LOCAL_CLIP_IMAGE_QUEUE_TTL_MS) continue;
      const note = this.app.vault.getAbstractFileByPath(job.notePath);
      if (!(note instanceof TFile)) continue;
      const candidate = articleCandidate(note.path, await this.app.vault.cachedRead(note));
      const expectedCaptureId = typeof job.task.manifest.captureId === "string"
        ? job.task.manifest.captureId
        : job.task.manifest.taskId;
      if (candidate.taskId !== expectedCaptureId) continue;
      resumable.push(job);
    }
    this.app.saveLocalStorage(this.localClipImageJobsStorageKey(), resumable);
    for (const job of resumable) {
      this.scheduleLocalClipImageProcessing(job.task, job.imageUrls, job.notePath, true);
    }
  }

  private scheduleLocalClipImageProcessing(
    task: any,
    imageUrls: Array<{ url?: string; alt?: string }>,
    notePath: string,
    alreadyPersisted = false,
  ) {
    const taskId = String(task?.manifest?.taskId ?? "");
    if (!taskId || !imageUrls.length) return;
    if (!alreadyPersisted) {
      const jobs = this.readPendingLocalClipImageJobs();
      this.app.saveLocalStorage(this.localClipImageJobsStorageKey(), [
        ...jobs.filter((job) => job.id !== taskId),
        {
          id: taskId,
          createdAt: Date.now(),
          notePath,
          task: { manifest: task.manifest },
          imageUrls,
        },
      ]);
    }
    const run = this.localClipImageQueue.then(async () => {
      const sourceImagePaths = imageUrls.map((image) => image?.url ?? "");
      const result = await processLocalClipImages({
        images: imageUrls,
        download: async (url) => {
          const downloaded = await requestUrl({ url, method: "GET", throw: false });
          if (downloaded.status < 200 || downloaded.status >= 300) {
            throw new Error(`HTTP ${downloaded.status}`);
          }
          return {
            body: new Uint8Array(downloaded.arrayBuffer),
            contentType: downloaded.headers["content-type"] ?? "image/*",
          };
        },
        createAsset: ({ url, body, contentType, index }) => ({
          relativePath: url,
          body,
          kind: "image" as const,
          contentType: contentType ?? "image/*",
          clipIndex: index,
        }),
        persist: async (asset) => this.persistLocalClipImages({
          ...task,
          localClipImageSourcePaths: sourceImagePaths,
        }, [asset], notePath),
      });
      if (!result.saved) {
        if (result.failed) new Notice(`文章已打开；${result.failed} 张图片下载失败${result.firstFailure ? `（${result.firstFailure}）` : ""}，已保留原文地址`, 10000);
        if (!result.failed) this.removePendingLocalClipImageJob(taskId);
        return;
      }
      if (result.failed) {
        new Notice(`图片已保存 ${result.saved} 张；${result.failed} 张下载或落盘失败${result.firstFailure ? `（${result.firstFailure}）` : ""}，原链接已保留；下次打开 Obsidian 时会重试`, 10000);
      } else {
        new Notice(`文章图片已保存 ${result.saved} 张`, 6000);
        this.removePendingLocalClipImageJob(taskId);
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
    const original = await this.app.vault.cachedRead(note);
    const expectedCaptureId = typeof task?.manifest?.captureId === "string"
      ? task.manifest.captureId
      : String(task?.manifest?.taskId ?? "");
    if (expectedCaptureId && articleCandidate(notePath, original).taskId !== expectedCaptureId) {
      throw new Error("目标笔记的剪藏标识已变化，已停止图片回填");
    }
    const expectedGeneration = this.vaultSyncIndex.getGeneration(notePath);
    const noteFolder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
    const sourcePaths = Array.isArray(task.localClipImageSourcePaths)
      ? task.localClipImageSourcePaths as string[]
      : assets.map((asset) => asset.relativePath);
    const layout = buildVaultPaths({
      rootFolder: normalizePath(this.settings.rootFolder),
      title: task.manifest.title,
      capturedAt: task.manifest.capturedAt,
      taskId: task.manifest.taskId,
      assets: localClipImageLayoutAssets(sourcePaths, assets),
    });
    const attachmentFolder = normalizePath(layout.attachmentFolder);
    const plans: Array<{ asset: any; targetPath: string; writeLocal: boolean; relativePath: string }> = [];
    for (const [index, asset] of assets.entries()) {
      const clipIndex = Number.isInteger(asset.clipIndex) && asset.clipIndex >= 0 && asset.clipIndex < layout.assetNames.length
        ? asset.clipIndex
        : index;
      const desiredPath = normalizePath(`${attachmentFolder}/${layout.assetNames[clipIndex] ?? layout.assetNames[index]}`);
      const resolved = await resolveAssetTarget(this.app.vault.adapter, desiredPath, new Uint8Array(asset.body));
      plans.push({
        asset,
        targetPath: resolved.targetPath,
        writeLocal: resolved.writeLocal,
        relativePath: relativeVaultPath(noteFolder, resolved.targetPath),
      });
    }
    if (plans.some((plan) => plan.writeLocal)) await ensureFolder(this, attachmentFolder);
    const created: Array<{ path: string; body: Uint8Array; mtime: number | null }> = [];
    try {
      for (const plan of plans) {
        if (!plan.writeLocal) continue;
        const body = new Uint8Array(plan.asset.body);
        const write = await writeBinaryAssetSafely(this.app, plan.targetPath, body);
        if (write.created) created.push({ path: plan.targetPath, body, mtime: write.mtime });
        const persisted = await this.app.vault.adapter.stat(plan.targetPath);
        if (!persisted || persisted.type !== "file" || persisted.size !== plan.asset.body.length) {
          throw new Error(`附件写入校验失败：${plan.targetPath}`);
        }
      }
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
      if (updated !== original) await writeTextAtomically(this.app, notePath, updated, original, {
        expectedGeneration,
        getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
      });
    } catch (error) {
      for (const file of created) {
        await removeBinaryAssetIfUnchanged(this.app, file.path, file.body, file.mtime).catch(() => false);
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
    this.vaultSyncTimer?.stop();
    this.vaultSyncTimer = null;
    const minutes = this.settings.vaultSyncIntervalMinutes;
    if (!this.settings.vaultSyncEnabled || minutes === null) {
      this.stopVaultSyncV2Events();
      return;
    }
    if (!this.articleSyncSchedulerStarted) return;
    if ((typeof document !== "undefined" && document.hidden)
      || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    this.vaultSyncTimer = createPausableIntervalScheduler(
      () => {
        if (deferVaultSyncAutomaticRunForRetry(this.vaultSyncRetry)) return;
        return this.runVaultSync(true, undefined, { auditBatchSize: VAULT_SYNC_PERIODIC_AUDIT_BATCH_SIZE });
      },
      minutes * 60 * 1000,
    );
    this.vaultSyncTimer.resume();
  }

  private currentVaultSyncProtocolTargetKey() {
    return `${normalizeApiBaseUrl(this.settings.apiBaseUrl)}\n${this.settings.syncTargetId}`;
  }

  private onVaultSyncPathChange(
    path: string,
    deleted = false,
    schedule = true,
    kind?: "create" | "modify" | "delete",
    file?: any,
  ) {
    if (deleted) {
      this.vaultSyncEmptyNoteGrace?.cancel(path);
      this.vaultSyncIndex.remove(path);
    } else {
      this.vaultSyncIndex.invalidate(path);
      if (this.vaultSyncEmptyNoteGrace?.has(path)) {
        if (Number(file?.stat?.size) === 0) return;
        this.vaultSyncEmptyNoteGrace.cancel(path);
      }
    }
    const rootFolder = this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined;
    if (!schedule || !shouldSyncPath(path, rootFolder)) return;
    if (!deleted && kind === "create"
      && String(file?.path ?? "").toLowerCase().endsWith(".md") && Number(file?.stat?.size) === 0) {
      if (this.vaultSyncEmptyNoteGrace?.has(path) || this.vaultSyncEmptyNoteGrace?.defer(path)) return;
    }
    this.requestAutomaticVaultSync();
  }

  private notifyLocalVaultNoteDeleted(path: string) {
    const normalized = normalizeVaultPath(path);
    const rootFolder = this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined;
    if (!this.settings.vaultSyncEnabled || !normalized?.toLowerCase().endsWith(".md")
      || !shouldSyncPath(normalized, rootFolder)) return;
    this.localDeletionReminderPaths.add(normalized);
    // A pending-review notice may have been emitted by an earlier sync pass
    // before this Vault delete event arrived. Replace it so the same queue
    // never leaves two visible actions that open the same confirmation modal.
    this.hidePendingDeletionReviewNotice();
    this.localDeletionReminderNotice?.hide();
    const message = document.createDocumentFragment();
    const paths = [...this.localDeletionReminderPaths];
    message.createEl("div", {
      text: formatLocalDeletionReminder(paths, this.settings.vaultSyncDeleteMode),
    });
    message.createEl("div", {
      text: "若关闭提醒，可在命令面板搜索“微同步：处理待确认删除”重新检查并处理。",
    });
    const actions = message.createEl("div", { cls: "wetongbu-deletion-notice-actions" });
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "0.5em";
    const action = actions.createEl("button", { text: "立即同步检查" });
    action.addClass("mod-cta");
    const dismiss = actions.createEl("button", { text: "关闭提醒" });
    // Keep the action visible until a sync determines whether a remote copy
    // needs review. A short toast is easy to miss, which leaves cloud copies
    // behind without making the required confirmation discoverable.
    const notice = new Notice(message, 0);
    this.localDeletionReminderNotice = notice;
    action.addEventListener("click", () => {
      notice.hide();
      if (this.localDeletionReminderNotice === notice) this.localDeletionReminderNotice = null;
      void this.openPendingDeletionReview();
    });
    dismiss.addEventListener("click", () => {
      if (this.localDeletionReminderNotice === notice) this.hideLocalDeletionReminderNotice();
      else notice.hide();
    });
  }

  private hideLocalDeletionReminderNotice() {
    this.localDeletionReminderNotice?.hide();
    this.localDeletionReminderNotice = null;
    this.localDeletionReminderPaths.clear();
  }

  private async trashRemoteVaultFile(file: any) {
    const path = String(file?.path ?? "");
    await this.remoteDeleteEventGuard.trash(path, () => this.app.fileManager.trashFile(file));
  }

  private async trashRemoteVaultPath(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file) await this.trashRemoteVaultFile(file);
  }

  private isVaultSyncCaseRenameStagePath(path: string): boolean {
    return /^\.wetongbu\/sync-v2\/case-rename-\d+-[0-9a-f-]{36}-\d{1,19}\.stage$/i
      .test(normalizeVaultPath(path) ?? "");
  }

  private renameRemoteVaultFileAndUpdateLinks(file: any, newPath: string): Promise<void> {
    return this.vaultSyncRemoteRenameEventGuard.rename(file, newPath,
      (source, target) => this.app.fileManager.renameFile(source, target));
  }

  private async onVaultSyncRename(file: any, oldPath: string) {
    const newPath = String(file?.path ?? "");
    this.vaultSyncEmptyNoteGrace?.cancel(oldPath);
    this.vaultSyncEmptyNoteGrace?.cancel(newPath);
    const rootFolder = this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined;
    const rootFolderScope = this.settings.vaultSyncScope === "root_folder";
    const oldInScope = shouldSyncPath(oldPath, rootFolder);
    const newInScope = shouldSyncPath(newPath, rootFolder);
    this.onVaultSyncPathChange(oldPath, true, false);
    this.onVaultSyncPathChange(newPath, false, false);
    if (this.vaultSyncRemoteRenameEventGuard.consume(file, oldPath)) return;
    if (this.isVaultSyncCaseRenameStagePath(oldPath) || this.isVaultSyncCaseRenameStagePath(newPath)) return;
    const isFolder = Array.isArray(file?.children);
    const leavesSelectedFolder = rootFolderScope && oldInScope && !newInScope;
    const isTrackedRename = (file instanceof TFile || isFolder) && this.settings.syncTargetId
      && oldInScope && (newInScope || leavesSelectedFolder);
    if (isFolder && isTrackedRename) {
      const oldPrefix = `${oldPath.replace(/\/+$/, "")}/`;
      const newPrefix = `${newPath.replace(/\/+$/, "")}/`;
      const pending: Array<{ fromPath: string; toPath: string }> = [];
      let exitedScopeFiles = 0;
      const visit = (node: any) => {
        if (Array.isArray(node?.children)) {
          for (const child of node.children) visit(child);
        } else if (node instanceof TFile) {
          const currentPath = String(node.path ?? "");
          if (!currentPath.startsWith(newPrefix)) return;
          const fromPath = oldPrefix + currentPath.slice(newPrefix.length);
          this.onVaultSyncPathChange(fromPath, true, false);
          this.onVaultSyncPathChange(currentPath, false, false);
          const fromInScope = shouldSyncPath(fromPath, rootFolder);
          const toInScope = shouldSyncPath(currentPath, rootFolder);
          if (fromInScope && !toInScope) exitedScopeFiles += 1;
          if (fromInScope && (toInScope || (rootFolderScope && normalizeVaultPath(currentPath)))) {
            pending.push({ fromPath, toPath: currentPath });
          }
        }
      };
      visit(file);
      this.vaultSyncPathIntentWrites += 1;
      try {
        if (pending.length) {
          const apiBaseUrl = normalizeApiBaseUrl(this.settings.apiBaseUrl);
          const targetId = this.settings.syncTargetId;
          const installationId = this.settings.vaultInstallationId;
          const deviceId = this.settings.vaultDeviceId || installationId;
          const pathIntentStore = createVaultSyncPathIntentStore(this.app, { apiBaseUrl, targetId, installationId });
          const moves = await this.vaultSyncPathIntentQueue.run(async () => {
            const [tracked, existingMoves] = await Promise.all([
              loadLatestVaultSyncV2Baseline(this.app, { apiBaseUrl, targetId, deviceId }),
              pathIntentStore.load(),
            ]);
            const fileIdByPath = resolveVaultSyncPathMoveIdentities(tracked, existingMoves);
            const resolvedMoves = pending.flatMap((entry) => {
              const fileId = fileIdByPath.get(entry.fromPath);
              return fileId ? [{ ...entry, fileId }] : [];
            });
            await pathIntentStore.recordMany(resolvedMoves, globalThis.crypto.randomUUID());
            return resolvedMoves;
          });
          if (moves.length >= 20 && !(leavesSelectedFolder && exitedScopeFiles > 0)) {
            new Notice(`${moves.length} 项目录路径变更已加入可恢复队列；可在多端同步设置查看处理进度。`, 9000);
          }
          if (leavesSelectedFolder && exitedScopeFiles > 0) {
            const deferredCount = moves.length;
            new Notice(
              `目录移出“${this.settings.rootFolder}”同步范围；云端文件不会因此自动删除。${deferredCount} 个已同步文件的改名待办会在范围扩大后继续；进度可在多端同步设置查看。`,
              12000,
            );
          }
        }
      } catch (error) {
        this.vaultSyncPathIntentFailure = true;
        new Notice(`目录改名待办未能安全写入本地；Vault 同步已暂停以防文件被误判（${error instanceof Error ? error.message : String(error)}）`, 12000);
      } finally {
        this.vaultSyncPathIntentWrites -= 1;
        if (this.vaultSyncPathIntentWrites === 0 && !this.vaultSyncPathIntentFailure) this.requestAutomaticVaultSync();
      }
      return;
    }
    if (file instanceof TFile && isTrackedRename) {
      if (!normalizeVaultPath(newPath)) {
        if (leavesSelectedFolder) {
          new Notice(`文件移入 Obsidian 内部忽略目录；云端旧路径将按当前删除策略处理，请在删除审核中确认。`, 12000);
          this.requestAutomaticVaultSync();
          return;
        }
      } else {
        const apiBaseUrl = normalizeApiBaseUrl(this.settings.apiBaseUrl);
        const targetId = this.settings.syncTargetId;
        const installationId = this.settings.vaultInstallationId;
        this.vaultSyncPathIntentWrites += 1;
        try {
          await this.vaultSyncPathIntentQueue.run(() => createVaultSyncPathIntentStore(this.app, {
            apiBaseUrl, targetId, installationId,
          }).record(oldPath, newPath));
        } catch (error) {
          this.vaultSyncPathIntentFailure = true;
          new Notice(`改名待办未能安全写入本地；Vault 同步已暂停以防改名被误判为新建/删除（${error instanceof Error ? error.message : String(error)}）`, 12000);
        } finally {
          this.vaultSyncPathIntentWrites -= 1;
          if (this.vaultSyncPathIntentWrites === 0 && !this.vaultSyncPathIntentFailure) this.requestAutomaticVaultSync();
        }
        if (leavesSelectedFolder) {
          new Notice(`文件移出“${this.settings.rootFolder}”同步范围；云端文件会保留，改名待办将在范围扩大后继续。`, 10000);
        }
        return;
      }
    }
    if (shouldSyncPath(oldPath, rootFolder) || shouldSyncPath(newPath, rootFolder)) this.requestAutomaticVaultSync();
  }

  private requestAutomaticVaultSync() {
    if (!this.settings.vaultSyncEnabled || this.settings.vaultSyncIntervalMinutes === null) return;
    this.vaultSyncEventPending = true;
    if (!this.vaultSyncWriteRecoveryReady) return;
    if ((typeof navigator !== "undefined" && !navigator.onLine)
      || (typeof document !== "undefined" && document.hidden)) {
      this.vaultSyncEventScheduler?.pause();
      this.vaultSyncRetry?.pause();
      this.vaultSyncTimer?.pause();
      return;
    }
    if (deferVaultSyncAutomaticRunForRetry(this.vaultSyncRetry)) return;
    this.vaultSyncEventScheduler?.notify();
  }

  private startVaultSyncV2Events(
    remote: VaultSyncRemoteClient,
    identity: VaultSyncV2Identity,
    sessionGeneration: string,
    knownCursor: string,
  ) {
    this.stopVaultSyncV2Events();
    const client = createVaultSyncV2EventsClient({
      apiBaseUrl: identity.apiBaseUrl,
      targetId: identity.targetId,
      protocolEpoch: identity.protocolEpoch,
      sessionGeneration,
      knownCursor,
      remote,
      onWake: () => this.requestAutomaticVaultSync(),
      onStatus: (status) => this.vaultSyncDiagnostics.setConnectionStatus(status),
      onIssue: (issue) => this.vaultSyncDiagnostics.setLastEventIssue(issue),
      onReconnect: () => this.vaultSyncDiagnostics.recordSuccessfulReconnect(),
    });
    this.vaultSyncV2Events = client;
    client.setOnline(typeof navigator === "undefined" || navigator.onLine);
    client.setForeground(typeof document === "undefined" || !document.hidden);
    client.start();
  }

  private stopVaultSyncV2Events() {
    const current = this.vaultSyncV2Events as ReturnType<typeof createVaultSyncV2EventsClient> | null;
    if (current) current.stop();
    this.vaultSyncV2Events = null;
  }

  async setVaultSyncInterval(minutes: number | null) {
    this.settings.vaultSyncIntervalMinutes = normalizeVaultSyncInterval(minutes);
    await this.saveSettings();
    this.restartVaultSyncTimer();
    this.requestAutomaticVaultSync();
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

  private currentVaultEncryptionDescriptor(): VaultSyncCryptoKeyDescriptor | null {
    if (!this.settings.vaultEncryptionEnabled || !this.settings.vaultEncryptionSecretId || !this.settings.vaultEncryptionSaltHex) return null;
    return {
      keyVersion: Number.isSafeInteger(this.settings.vaultEncryptionKeyVersion) && this.settings.vaultEncryptionKeyVersion >= 1
        ? this.settings.vaultEncryptionKeyVersion : 1,
      saltHex: this.settings.vaultEncryptionSaltHex,
      secretId: this.settings.vaultEncryptionSecretId,
    };
  }

  private vaultEncryptionKeyDescriptors(): VaultSyncCryptoKeyDescriptor[] {
    return normalizeVaultSyncCryptoKeyDescriptors(
      this.settings.vaultEncryptionKeyring,
      this.currentVaultEncryptionDescriptor(),
    );
  }

  private async loadVaultSyncCryptoContext() {
    if (!this.settings.vaultEncryptionEnabled) return null;
    const activeKeyVersion = Number.isSafeInteger(this.settings.vaultEncryptionKeyVersion)
      && this.settings.vaultEncryptionKeyVersion >= 1 ? this.settings.vaultEncryptionKeyVersion : 1;
    const descriptors = this.vaultEncryptionKeyDescriptors();
    if (JSON.stringify(this.settings.vaultEncryptionKeyring ?? []) !== JSON.stringify(descriptors)) {
      this.settings.vaultEncryptionKeyring = descriptors;
      await this.saveSettings();
    }
    return loadVaultSyncCryptoKeyring({
      activeKeyVersion,
      descriptors,
      secretStorage: this.app.secretStorage,
    });
  }

  private rememberVaultEncryptionKey(descriptor: VaultSyncCryptoKeyDescriptor) {
    this.settings.vaultEncryptionKeyring = addVaultSyncCryptoKeyDescriptor(
      this.settings.vaultEncryptionKeyring,
      descriptor,
    );
  }

  private async resetEnvironmentScopedCredentials() {
    this.accountStatusRefreshGeneration += 1;
    if (this.settings.authSecretSuffix) {
      this.app.secretStorage.setSecret(this.pluginTokenSecretId(), "");
    }
    if (this.settings.vaultDeviceTokenSecretId) {
      this.app.secretStorage.setSecret(this.settings.vaultDeviceTokenSecretId, "");
    }
    if (this.settings.vaultEncryptionRotationSecretId
      && this.settings.vaultEncryptionRotationSecretId !== this.settings.vaultEncryptionSecretId) {
      this.app.secretStorage.setSecret(this.settings.vaultEncryptionRotationSecretId, "");
    }
    this.settings.userId = "";
    this.settings.syncTargetId = "";
    this.settings.syncTargetName = "";
    this.settings.authSecretSuffix = "";
    this.settings.accountPlanType = "free";
    this.settings.vaultDeviceTokenSecretId = "";
    this.settings.vaultDeviceId = "";
    this.settings.vaultEncryptionRotationOperationId = "";
    this.settings.vaultEncryptionRotationId = "";
    this.settings.vaultEncryptionRotationSecretId = "";
    this.settings.vaultEncryptionRotationSourceVersion = 0;
    this.settings.vaultEncryptionRotationSourceSaltHex = "";
    this.settings.vaultEncryptionRotationTargetVersion = 0;
    this.settings.vaultEncryptionRotationTargetSaltHex = "";
    this.vaultEncryptionRotationAvailable = false;
    this.vaultEncryptionRotationStatus = "";
    this.settings.vaultSyncEnabled = false;
    this.settings.pendingDeviceCode = "";
    this.settings.pendingDeviceVerificationUri = "";
    this.vaultDeviceTokenCache = "";
    this.accountLoggedIn = false;
    this.accountPlanType = "free";
    this.accountCanVaultSync = false;
    this.accountLegacyFreeStorageCompat = false;
    this.pendingV2DeletionReview = [];
    this.pendingV2DeletionHandler = null;
    this.pendingDeletionReviewNoticeKey = "";
    this.pendingDeletionReviewNoticeSuppressedKey = "";
    this.hidePendingDeletionReviewNotice();
    this.accountStatus = "当前账号：未登录；登录后可使用多端同步";
    await this.saveSettings();
  }

  async logoutAccount(): Promise<{ remoteRevoked: boolean }> {
    const token = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
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
      // A Retry-After response belongs to the old API/target pair. Clear the
      // in-memory timer and its persisted deadline before another target can
      // reuse this plugin instance.
      this.vaultSyncRetry?.clear();
      this.settings.vaultSyncEnabled = false;
      this.pendingV2DeletionReview = [];
      this.pendingV2DeletionHandler = null;
      this.pendingDeletionReviewNoticeKey = "";
      this.pendingDeletionReviewNoticeSuppressedKey = "";
      this.hidePendingDeletionReviewNotice();
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
    const refreshGeneration = ++this.accountStatusRefreshGeneration;
    const previousViewState = JSON.stringify([
      this.accountStatus,
      this.accountLoggedIn,
      this.accountCanVaultSync,
      this.accountPlanType,
      this.canHostImages,
    ]);
    const token = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    try {
      if (!this.settings.syncTargetId || !token) {
        this.accountLoggedIn = false;
        this.accountPlanType = this.settings.accountPlanType = "free";
        this.accountLegacyFreeStorageCompat = false;
        this.accountCanVaultSync = false;
        this.canHostImages = false;
        this.accountStatus = "当前账号：未登录；登录后可使用多端同步";
        return;
      }
      const response = await requestUrl({
        url: `${this.settings.apiBaseUrl.replace(/\/$/, "")}/api/plugin/account`,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (refreshGeneration !== this.accountStatusRefreshGeneration) return;
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
      if (refreshGeneration !== this.accountStatusRefreshGeneration) return;
      await this.saveSettings();
    } catch {
      if (refreshGeneration === this.accountStatusRefreshGeneration) {
        this.accountStatus = this.accountLoggedIn ? this.accountStatus : "当前账号：未登录；登录后可使用多端同步";
      }
    } finally {
      const currentViewState = JSON.stringify([
        this.accountStatus,
        this.accountLoggedIn,
        this.accountCanVaultSync,
        this.accountPlanType,
        this.canHostImages,
      ]);
      if (refreshGeneration === this.accountStatusRefreshGeneration && previousViewState !== currentViewState) {
        this.settingTab?.refreshFromPlugin();
      }
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
    if (enabled) assertVaultSyncScopeConfigured(this.settings.vaultSyncScope, this.settings.rootFolder);
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
    const remote = createVaultSyncRemoteClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      targetId: this.settings.syncTargetId,
      pluginToken,
    });
    const current = await remote.getStatus();
    const remoteEncryption = current.encryption;
    if (enabled && remoteEncryption?.enabled && !remoteEncryption.salt_hex) {
      throw Object.assign(new Error("云端 Vault 已启用加密，但没有返回有效盐值；已暂停同步以保护数据"), {
        code: "encryption_key_material_mismatch",
      });
    }
    if (enabled && remoteEncryption?.enabled && remoteEncryption.salt_hex) {
      assertVaultSyncEncryptionVersionCompatible({
        remoteVersion: Number(remoteEncryption.version ?? 1),
        localVersion: Number(this.settings.vaultEncryptionKeyVersion ?? 1),
        remoteSaltHex: remoteEncryption.salt_hex,
        localSaltHex: this.settings.vaultEncryptionSaltHex,
        localCredentialConfigured: this.settings.vaultEncryptionEnabled && Boolean(this.settings.vaultEncryptionSecretId),
      });
      validateVaultSyncRemoteKeyVersionCatalog({
        catalog: remoteEncryption.key_versions,
        activeVersion: Number(remoteEncryption.version ?? 1),
        activeSaltHex: remoteEncryption.salt_hex,
        localDescriptors: this.vaultEncryptionKeyDescriptors(),
      });
      this.settings.vaultEncryptionEnabled = true;
      this.settings.vaultEncryptionSaltHex = remoteEncryption.salt_hex;
      this.settings.vaultEncryptionKeyVersion = Number(remoteEncryption.version ?? 1);
    }
    const result = await remote.enable(
      enabled,
      this.settings.vaultSyncScope,
      this.settings.vaultEncryptionEnabled
        ? { enabled: true, saltHex: this.settings.vaultEncryptionSaltHex, version: this.settings.vaultEncryptionKeyVersion || 1 }
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
    this.requestAutomaticVaultSync();
  }

  async setVaultSyncScope(scope: VaultSyncScope) {
    if (scope !== "whole_vault" && scope !== "root_folder") throw new Error("Vault 同步范围无效");
    if (scope === this.settings.vaultSyncScope) return;
    if (this.vaultSyncing || this.vaultSyncScopeChanging) {
      throw new Error("当前 Vault 同步正在运行；完成后再更改同步范围");
    }
    assertVaultSyncScopeConfigured(scope, this.settings.rootFolder);

    this.vaultSyncScopeChanging = true;
    const previousScope = this.settings.vaultSyncScope;
    try {
      await saveVaultSyncScopeAfterRemoteConfirmation(
        this.settings,
        scope,
        async () => {
          if (!this.settings.vaultSyncEnabled) return;
          const pluginToken = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
          if (!this.settings.syncTargetId || !pluginToken) throw new Error("请先连接当前 Vault 后再更改云端同步范围");
          const remote = createVaultSyncRemoteClient({
            apiBaseUrl: this.settings.apiBaseUrl,
            targetId: this.settings.syncTargetId,
            pluginToken,
          });
          const current = await remote.getStatus();
          if (!current.enabled) throw new Error("云端 Vault 同步已关闭；请先重新连接后再更改范围");
          const result = await remote.enable(true, scope);
          if (!result.enabled || result.scope !== scope) throw new Error("云端没有确认新的 Vault 同步范围");
        },
        () => this.saveSettings(),
      );
    } finally {
      this.vaultSyncScopeChanging = false;
    }

    this.stopVaultSyncV2Events();
    if (previousScope === "whole_vault" && scope === "root_folder") {
      new Notice("同步范围已缩小；范围外云端文件会保留，不会被当作删除同步", 10000);
    } else if (previousScope === "root_folder" && scope === "whole_vault") {
      new Notice("同步范围已扩大；下一轮快照会纳入整个 Vault", 8000);
    }
    if (this.settings.vaultSyncEnabled) void this.runVaultSync(false);
  }

  async enableVaultEncryption(passphrase: string) {
    if (passphrase.length < 8) throw new Error("Vault 加密密码至少需要 8 个字符");
    const secretId = this.settings.vaultEncryptionSecretId || `wetongbu-vault-encryption-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const token = this.settings.syncTargetId
      ? this.app.secretStorage.getSecret(this.pluginTokenSecretId())
      : null;
    if (token && this.settings.syncTargetId) {
      const remote = createVaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken: token,
      });
      const current = await remote.getStatus();
      if (current.encryption?.enabled) {
        if (Number(current.encryption.version ?? 1) !== 1) {
          throw Object.assign(new Error("云端 Vault 已进入新的加密密钥版本；此客户端尚未完成可恢复的轮换迁移，不能在此设备解锁"), {
            code: "encryption_key_version_required",
          });
        }
        if (!current.encryption.salt_hex) throw new Error("云端 Vault 缺少加密盐值，无法安全解锁");
        assertVaultSyncEncryptionVersionCompatible({
          remoteVersion: Number(current.encryption.version ?? 1),
          localVersion: Number(this.settings.vaultEncryptionKeyVersion ?? 1),
          remoteSaltHex: current.encryption.salt_hex,
          localSaltHex: this.settings.vaultEncryptionSaltHex,
          localCredentialConfigured: this.settings.vaultEncryptionEnabled && Boolean(this.settings.vaultEncryptionSecretId),
        });
        validateVaultSyncRemoteKeyVersionCatalog({
          catalog: current.encryption.key_versions,
          activeVersion: Number(current.encryption.version ?? 1),
          activeSaltHex: current.encryption.salt_hex,
          localDescriptors: this.vaultEncryptionKeyDescriptors(),
        });
        const existingPassphrase = this.settings.vaultEncryptionSecretId
          ? await this.app.secretStorage.getSecret(this.settings.vaultEncryptionSecretId) : "";
        assertVaultEncryptionCredentialChangeSafe({
          currentVaultEncrypted: this.settings.vaultEncryptionEnabled,
          storedPassphrase: existingPassphrase ?? "", submittedPassphrase: passphrase,
        });
        const derived = await createVaultSyncCrypto(passphrase, current.encryption.salt_hex, current.encryption.version);
        await this.app.secretStorage.setSecret(secretId, passphrase);
        this.settings.vaultEncryptionEnabled = true;
        this.settings.vaultEncryptionSecretId = secretId;
        this.settings.vaultEncryptionSaltHex = derived.saltHex;
        this.settings.vaultEncryptionKeyVersion = Number(current.encryption.version ?? 1);
        this.rememberVaultEncryptionKey({
          keyVersion: this.settings.vaultEncryptionKeyVersion,
          saltHex: derived.saltHex,
          secretId,
        });
        this.vaultEncryptionInput = "";
        await this.saveSettings();
        return;
      }

      const derived = await createVaultSyncCrypto(passphrase, this.settings.vaultEncryptionSaltHex || undefined, 1);
      const result = await remote.enable(this.settings.vaultSyncEnabled, this.settings.vaultSyncScope, {
        enabled: true, saltHex: derived.saltHex, version: 1,
      });
      if (!result.encryption?.enabled || result.encryption.version !== 1
        || result.encryption.saltHex?.toLowerCase() !== derived.saltHex.toLowerCase()) {
        throw new Error("服务端没有确认当前 Vault 加密参数；本设备密码未更换");
      }
      await this.app.secretStorage.setSecret(secretId, passphrase);
      this.settings.vaultEncryptionEnabled = true;
      this.settings.vaultEncryptionSecretId = secretId;
      this.settings.vaultEncryptionSaltHex = derived.saltHex;
      this.settings.vaultEncryptionKeyVersion = 1;
      this.rememberVaultEncryptionKey({ keyVersion: 1, saltHex: derived.saltHex, secretId });
      this.vaultEncryptionInput = "";
      await this.saveSettings();
      return;
    }

    if (this.settings.vaultEncryptionEnabled) {
      const existingPassphrase = this.settings.vaultEncryptionSecretId
        ? await this.app.secretStorage.getSecret(this.settings.vaultEncryptionSecretId) : "";
      assertVaultEncryptionCredentialChangeSafe({
        currentVaultEncrypted: true, storedPassphrase: existingPassphrase ?? "", submittedPassphrase: passphrase,
      });
    }
    const derived = await createVaultSyncCrypto(passphrase, this.settings.vaultEncryptionSaltHex || undefined, 1);
    await this.app.secretStorage.setSecret(secretId, passphrase);
    this.settings.vaultEncryptionEnabled = true;
    this.settings.vaultEncryptionSecretId = secretId;
    this.settings.vaultEncryptionSaltHex = derived.saltHex;
    this.settings.vaultEncryptionKeyVersion = 1;
    this.rememberVaultEncryptionKey({ keyVersion: 1, saltHex: derived.saltHex, secretId });
    this.vaultEncryptionInput = "";
    await this.saveSettings();
  }

  async disableVaultEncryption() {
    this.settings.vaultEncryptionEnabled = false;
    await this.saveSettings();
  }

  private hasPendingVaultEncryptionRotation() {
    return Boolean(this.settings.vaultEncryptionRotationOperationId
      || this.settings.vaultEncryptionRotationId
      || this.settings.vaultEncryptionRotationSecretId);
  }

  private clearVaultEncryptionRotationIntent() {
    this.settings.vaultEncryptionRotationOperationId = "";
    this.settings.vaultEncryptionRotationId = "";
    this.settings.vaultEncryptionRotationSecretId = "";
    this.settings.vaultEncryptionRotationSourceVersion = 0;
    this.settings.vaultEncryptionRotationSourceSaltHex = "";
    this.settings.vaultEncryptionRotationTargetVersion = 0;
    this.settings.vaultEncryptionRotationTargetSaltHex = "";
  }

  async refreshVaultEncryptionRotationAvailability(force = false): Promise<boolean> {
    if (!this.settings.vaultEncryptionEnabled || !this.settings.vaultSyncEnabled
      || !this.settings.syncTargetId || !this.settings.vaultDeviceId
      || !this.accountLoggedIn) {
      this.vaultEncryptionRotationAvailable = false;
      return false;
    }
    const now = Date.now();
    if (!force && now - this.vaultEncryptionRotationCapabilitiesFetchedAt < 30_000) {
      return this.vaultEncryptionRotationAvailable;
    }
    if (this.vaultEncryptionRotationCapabilitiesRequest) return this.vaultEncryptionRotationCapabilitiesRequest;
    const request = (async () => {
      const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
      if (!pluginToken) return false;
      const remote = createVaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken,
      });
      const capabilities = await remote.getCapabilities();
      return capabilities.supportedFeatures.includes("encryption_key_rotation");
    })();
    this.vaultEncryptionRotationCapabilitiesRequest = request;
    try {
      const previous = this.vaultEncryptionRotationAvailable;
      this.vaultEncryptionRotationAvailable = await request;
      this.vaultEncryptionRotationCapabilitiesFetchedAt = Date.now();
      if (previous !== this.vaultEncryptionRotationAvailable) this.settingTab?.refreshFromPlugin();
      return this.vaultEncryptionRotationAvailable;
    } catch {
      this.vaultEncryptionRotationAvailable = false;
      this.vaultEncryptionRotationCapabilitiesFetchedAt = Date.now();
      return false;
    } finally {
      if (this.vaultEncryptionRotationCapabilitiesRequest === request) {
        this.vaultEncryptionRotationCapabilitiesRequest = null;
      }
    }
  }

  async rotateVaultEncryptionKey(passphrase: string): Promise<{ completed: boolean; remainingSourceObjects: string }> {
    if (this.vaultEncryptionRotationRunning) throw new Error("Vault 密钥迁移正在运行");
    if (this.vaultSyncing) throw new Error("请等待当前 Vault 同步完成，再开始密钥迁移");
    if (!this.settings.vaultSyncEnabled || !this.settings.vaultEncryptionEnabled) {
      throw new Error("请先开启 Vault 同步和端到端加密");
    }
    const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    const deviceToken = this.vaultDeviceTokenCache || (this.settings.vaultDeviceTokenSecretId
      ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId) : "");
    if (!pluginToken || !deviceToken || !this.settings.syncTargetId || !this.settings.vaultDeviceId) {
      throw new Error("请先完成账号登录并在此设备同步当前 Vault");
    }
    const remote = createVaultSyncRemoteClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      targetId: this.settings.syncTargetId,
      pluginToken,
      deviceToken,
    });
    const capabilities = await remote.getCapabilities();
    const pending = this.hasPendingVaultEncryptionRotation();
    if (!pending && !capabilities.supportedFeatures.includes("encryption_key_rotation")) {
      throw new Error("服务端尚未为此 Vault 开放密钥迁移");
    }
    const status = await remote.getStatus();
    const activeVersion = Number(this.settings.vaultEncryptionKeyVersion || 1);
    let sourceVersion = pending ? this.settings.vaultEncryptionRotationSourceVersion : activeVersion;
    let sourceSaltHex = (pending ? this.settings.vaultEncryptionRotationSourceSaltHex : this.settings.vaultEncryptionSaltHex).toLowerCase();
    let targetVersion = this.settings.vaultEncryptionRotationTargetVersion;
    let targetSaltHex = this.settings.vaultEncryptionRotationTargetSaltHex.toLowerCase();
    const serverVersion = Number(status.encryption?.version ?? 0);
    const serverSaltHex = status.encryption?.salt_hex?.toLowerCase();
    const serverStillUsesSource = serverVersion === sourceVersion && serverSaltHex === sourceSaltHex;
    const serverAlreadyActivatedTarget = pending && serverVersion === targetVersion && serverSaltHex === targetSaltHex;
    if (!status.encryption?.enabled || (!serverStillUsesSource && !serverAlreadyActivatedTarget)) {
      throw new Error("云端当前加密版本与本机不一致；请先刷新 Vault 状态并解锁当前密钥");
    }

    if (!pending) {
      const newPassphrase = passphrase.trim();
      if (newPassphrase.length < 8) throw new Error("新密码至少需要 8 个字符");
      const newTargetVersion = activeVersion + 1;
      const targetCrypto = await createVaultSyncCrypto(newPassphrase, undefined, newTargetVersion);
      const targetSecretId = `wetongbu-vault-rotation-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      this.settings.vaultEncryptionRotationOperationId = crypto.randomUUID();
      this.settings.vaultEncryptionRotationId = "";
      this.settings.vaultEncryptionRotationSecretId = targetSecretId;
      this.settings.vaultEncryptionRotationSourceVersion = activeVersion;
      this.settings.vaultEncryptionRotationSourceSaltHex = this.settings.vaultEncryptionSaltHex.toLowerCase();
      this.settings.vaultEncryptionRotationTargetVersion = newTargetVersion;
      this.settings.vaultEncryptionRotationTargetSaltHex = targetCrypto.saltHex;
      sourceVersion = activeVersion;
      sourceSaltHex = this.settings.vaultEncryptionSaltHex.toLowerCase();
      targetVersion = newTargetVersion;
      targetSaltHex = targetCrypto.saltHex.toLowerCase();
      this.app.secretStorage.setSecret(targetSecretId, newPassphrase);
      await this.saveSettings();
      this.vaultEncryptionRotationInput = "";
    }

    const targetSecretId = this.settings.vaultEncryptionRotationSecretId;
    const targetPassphrase = targetSecretId ? await this.app.secretStorage.getSecret(targetSecretId) : "";
    if (!this.settings.vaultEncryptionRotationOperationId || !targetSecretId || !targetPassphrase
      || !sourceVersion || !sourceSaltHex || targetVersion !== sourceVersion + 1 || !targetSaltHex) {
      throw new Error("本机没有完整的密钥迁移凭据；保留现有数据并重新输入迁移密码");
    }
    const sourceKeyring = await loadVaultSyncCryptoKeyring({
      activeKeyVersion: sourceVersion,
      descriptors: this.vaultEncryptionKeyDescriptors(),
      secretStorage: this.app.secretStorage,
    });
    if (sourceKeyring.active.saltHex.toLowerCase() !== sourceSaltHex) {
      throw new Error("当前 Vault 密钥与已保存的迁移源版本不一致");
    }
    const targetCrypto = await createVaultSyncCrypto(targetPassphrase, targetSaltHex, targetVersion);
    if (targetCrypto.saltHex.toLowerCase() !== targetSaltHex) throw new Error("新密钥材料与本机迁移记录不一致");

    let rotation;
    if (this.settings.vaultEncryptionRotationId) {
      rotation = await remote.getEncryptionKeyRotation(this.settings.vaultEncryptionRotationId);
    } else {
      rotation = await remote.startEncryptionKeyRotation({
        operationId: this.settings.vaultEncryptionRotationOperationId,
        sourceKeyVersion: sourceVersion,
        sourceSaltHex,
        targetKeyVersion: targetVersion,
        targetSaltHex,
      });
      this.settings.vaultEncryptionRotationId = rotation.rotationId;
      await this.saveSettings();
    }
    if (rotation.operationId.toLowerCase() !== this.settings.vaultEncryptionRotationOperationId.toLowerCase()
      || rotation.sourceKeyVersion !== sourceVersion || rotation.sourceSaltHex.toLowerCase() !== sourceSaltHex
      || rotation.targetKeyVersion !== targetVersion || rotation.targetSaltHex.toLowerCase() !== targetSaltHex) {
      throw new Error("服务端密钥迁移任务与本机保存的凭据不一致；已暂停以保护 Vault");
    }
    const identity: VaultSyncKeyRotationIdentity = {
      apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl),
      targetId: this.settings.syncTargetId,
      deviceId: this.settings.vaultDeviceId,
      protocolEpoch: capabilities.protocolEpoch,
      encryptionDomainId: rotation.encryptionDomainId,
    };
    const store = createVaultSyncKeyRotationStore(this.app, identity);
    this.vaultEncryptionRotationRunning = true;
    this.vaultSyncing = true;
    this.vaultEncryptionRotationStatus = `正在迁移 ${rotation.completedObjects} / ${rotation.totalObjects} 个对象…`;
    try {
      const result = await runVaultSyncKeyRotation({
        remote,
        requestObject: async (input) => {
          const response = await requestUrl({
            url: input.url, method: input.method, body: input.body, throw: false,
          });
          return { status: response.status, headers: response.headers, arrayBuffer: response.arrayBuffer };
        },
        store,
        rotation,
        sourceKeyring: sourceKeyring.keyring,
        targetCrypto,
        onProgress: (progress) => {
          this.vaultEncryptionRotationStatus = `已迁移 ${progress.completedObjects} / ${progress.totalObjects} 个对象；处理字节 ${progress.completedSourceBytes} / ${progress.totalSourceBytes}`;
          this.settingTab?.refreshFromPlugin();
        },
        onActivated: async (activated) => {
          this.rememberVaultEncryptionKey({
            keyVersion: activated.targetKeyVersion,
            saltHex: activated.targetSaltHex,
            secretId: targetSecretId,
          });
          this.settings.vaultEncryptionEnabled = true;
          this.settings.vaultEncryptionKeyVersion = activated.targetKeyVersion;
          this.settings.vaultEncryptionSaltHex = activated.targetSaltHex;
          this.settings.vaultEncryptionSecretId = targetSecretId;
          await this.saveSettings();
        },
      });
      if (result.completed) {
        this.clearVaultEncryptionRotationIntent();
        this.vaultEncryptionRotationStatus = "密钥迁移完成；所有旧对象已安全清理";
        await this.saveSettings();
      } else {
        this.vaultEncryptionRotationStatus = `新密钥已启用；等待下载 lease 到期后清理 ${result.remainingSourceObjects} 个旧对象，稍后可继续`;
      }
      return { completed: result.completed, remainingSourceObjects: result.remainingSourceObjects };
    } finally {
      this.vaultEncryptionRotationRunning = false;
      this.vaultSyncing = false;
      this.settingTab?.refreshFromPlugin();
      this.requestAutomaticVaultSync();
    }
  }

  async abortVaultEncryptionKeyRotation() {
    if (!this.settings.vaultEncryptionRotationId) throw new Error("当前没有可中止的服务端密钥迁移");
    if (this.vaultEncryptionRotationRunning || this.vaultSyncing) throw new Error("当前 Vault 操作正在运行，请稍后再试");
    const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    const deviceToken = this.vaultDeviceTokenCache || (this.settings.vaultDeviceTokenSecretId
      ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId) : "");
    if (!pluginToken || !deviceToken || !this.settings.syncTargetId || !this.settings.vaultDeviceId) {
      throw new Error("请先登录并在发起迁移的设备上恢复当前 Vault");
    }
    const remote = createVaultSyncRemoteClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      targetId: this.settings.syncTargetId,
      pluginToken,
      deviceToken,
    });
    const current = await remote.getEncryptionKeyRotation(this.settings.vaultEncryptionRotationId);
    if (["activation_unknown", "activated", "complete"].includes(current.status)) {
      throw new Error("服务端密钥已激活或正在确认激活结果，不能回退；请继续迁移完成旧对象清理");
    }
    await remote.abortEncryptionKeyRotation(current.rotationId);
    const capabilities = await remote.getCapabilities();
    const identity: VaultSyncKeyRotationIdentity = {
      apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl),
      targetId: this.settings.syncTargetId,
      deviceId: this.settings.vaultDeviceId,
      protocolEpoch: capabilities.protocolEpoch,
      encryptionDomainId: current.encryptionDomainId,
    };
    const checkpointStore = createVaultSyncKeyRotationStore(this.app, identity);
    if (await checkpointStore.load()) await checkpointStore.markAborted({ rotationId: current.rotationId });
    const pendingSecretId = this.settings.vaultEncryptionRotationSecretId;
    if (pendingSecretId && pendingSecretId !== this.settings.vaultEncryptionSecretId) {
      this.app.secretStorage.setSecret(pendingSecretId, "");
    }
    this.clearVaultEncryptionRotationIntent();
    this.vaultEncryptionRotationStatus = "密钥迁移已中止，旧密钥和旧对象保持可用";
    await this.saveSettings();
    this.settingTab?.refreshFromPlugin();
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
        }, requestUrl);
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
        const registerRemote = createVaultSyncRemoteClient({
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
        const remote = createVaultSyncRemoteClient({
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
  async runVaultSync(
    quiet = false,
    deletionResolution?: DeletionResolution,
    diagnosticsContext?: { queueWaitMs?: number; activeQueueWaitMs?: number; auditBatchSize?: number },
  ) {
    if (!this.vaultSyncLifecycleActive) return;
    if (!this.vaultSyncWriteRecoveryReady) {
      this.vaultSyncEventPending = true;
      if (!quiet) new Notice("Vault 正在检查本地写入恢复，请稍后再同步", 8000);
      return;
    }
    if (this.vaultSyncWriteRecoveryBlocked) {
      if (!quiet) {
        const paths = this.vaultSyncWriteRecoveryBlockedPaths.slice(0, 3).join("、");
        new Notice(`笔记写入中断现场尚未处理，Vault 同步仍暂停；请先检查 ${paths} 并重载 Obsidian`, 12000);
      }
      return;
    }
    const lifecycleGeneration = this.vaultSyncLifecycleGeneration;
    const queuedBehindOtherWork = vaultSyncObjectWorkGate.active || vaultSyncObjectWorkGate.queuedCount > 0;
    if (queuedBehindOtherWork && !quiet) {
      new Notice("已有 Vault 操作正在运行；本次同步检查已排队，当前操作结束后会继续", 8000);
    }
    await vaultSyncObjectWorkGate.runQueued(() => {
      if (!this.vaultSyncLifecycleActive || lifecycleGeneration !== this.vaultSyncLifecycleGeneration) {
        return Promise.resolve();
      }
      return this.runVaultSyncUnderObjectWorkGate(quiet, deletionResolution, diagnosticsContext);
    });
    if (!this.vaultSyncLifecycleActive || lifecycleGeneration !== this.vaultSyncLifecycleGeneration) return;
    if (shouldSchedulePendingVaultSyncRetry(
      this.app,
      this.vaultSyncEventPending,
      [...this.vaultSyncEditorDeferredPaths],
    ) && this.settings.vaultSyncEnabled && this.settings.syncTargetId
      && this.accountLoggedIn && this.accountCanVaultSync && !this.vaultSyncScopeChanging
      && this.vaultSyncPathIntentWrites === 0 && !this.vaultSyncPathIntentFailure
      && !(typeof document !== "undefined" && document.hidden)
      && !(typeof navigator !== "undefined" && !navigator.onLine)) {
      this.requestAutomaticVaultSync();
    }
  }

  private async runVaultSyncUnderObjectWorkGate(
    quiet = false,
    deletionResolution?: DeletionResolution,
    diagnosticsContext?: { queueWaitMs?: number; activeQueueWaitMs?: number; auditBatchSize?: number },
  ) {
    if (!this.settings.vaultSyncEnabled) return;
    if (!this.settings.syncTargetId) return;
    if (this.vaultSyncScopeChanging) {
      this.vaultSyncEventPending = true;
      return;
    }
    if (quiet && typeof document !== "undefined" && document.hidden) {
      this.vaultSyncEventPending = true;
      this.vaultSyncEventScheduler?.pause();
      this.vaultSyncRetry?.pause();
      return;
    }
    if (quiet && typeof navigator !== "undefined" && !navigator.onLine) {
      this.vaultSyncEventPending = true;
      this.vaultSyncEventScheduler?.pause();
      this.vaultSyncRetry?.pause();
      return;
    }
    if (this.vaultSyncPathIntentWrites > 0) {
      if (!quiet) new Notice("本机文件改名正在安全登记；请稍后重试同步", 8000);
      return;
    }
    if (this.vaultSyncPathIntentFailure) {
      if (!quiet) new Notice("本地改名待办没有安全保存；请先重载 Obsidian 后检查 Vault 再同步", 12000);
      return;
    }
    if (this.vaultSyncProtocolUpgradeTargetKey === this.currentVaultSyncProtocolTargetKey()) {
      if (!quiet) new Notice("此 Vault 需要更新 Obsidian 插件后才能继续同步", 12000);
      return;
    }
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
    this.vaultSyncEventPending = false;
    this.vaultSyncEditorDeferredPaths.clear();
    this.vaultSyncing = true;
    const diagnosticClock = () => globalThis.performance?.now?.() ?? Date.now();
    const diagnosticStartedAt = diagnosticClock();
    let diagnosticProtocol: VaultSyncDiagnosticProtocol = "v1";
    let diagnosticOutcome: VaultSyncDiagnosticOutcome = "paused";
    let diagnosticFailureCode: string | undefined;
    let diagnosticStage: VaultSyncDiagnosticStage = "device_auth";
    let diagnosticPullMs: number | undefined;
    let diagnosticPushMs: number | undefined;
    let diagnosticQueueWaitMs = diagnosticsContext?.queueWaitMs;
    let diagnosticActiveQueueWaitMs = diagnosticsContext?.activeQueueWaitMs;
    let diagnosticV2Journal: ReturnType<typeof createVaultSyncOutboxStore> | null = null;
    let diagnosticWork: VaultSyncDiagnosticWorkSummary | undefined;
    let diagnosticMultipartTransfer: VaultSyncMultipartTransferDiagnostic | undefined;
    let initializationLeaseKeeper: ReturnType<typeof createVaultSyncInitializationLeaseKeeper> | null = null;
    this.stopVaultSyncV2Events();
    try {
      diagnosticStage = "device_auth";
      const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
      if (!pluginToken) throw new Error("Vault 连接已失效，请重新连接");

      // 设备 token：首次启用时注册，之后从 SecretStorage 读。
      let deviceToken = this.vaultDeviceTokenCache
        || (this.settings.vaultDeviceTokenSecretId
          ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId)
          : "");
      if (!deviceToken) {
        const remote = createVaultSyncRemoteClient({
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
      const remote = createVaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken,
        deviceToken,
        onAppliedLatencyMs: (durationMs) => this.vaultSyncDiagnostics.recordAppliedLatency(durationMs),
      });
      diagnosticStage = "remote_status";
      const status = await remote.getStatus();
      if (status.can_sync === false || status.storage_type !== "hosted_s3") {
        throw new Error("当前账号的云端同步存储未就绪，请刷新账号状态后重试");
      }
      if (status.encryption?.enabled && !status.encryption.salt_hex) {
        throw Object.assign(new Error("云端 Vault 已启用加密，但没有返回有效盐值；已暂停同步以保护数据"), {
          code: "encryption_key_material_mismatch",
        });
      }
      if (status.storage_switch_state && status.storage_switch_state !== "active") {
        diagnosticFailureCode = "storage_switch_in_progress";
        this.storageStatus = "云端同步存储正在切换，Vault 同步已暂停，请稍后重试";
        this.vaultSyncRetry?.clear();
        if (!quiet) new Notice(this.storageStatus, 10000);
        return;
      }
      if (status.encryption?.enabled && status.encryption.salt_hex) {
        diagnosticStage = "encryption_setup";
        assertVaultSyncEncryptionVersionCompatible({
          remoteVersion: Number(status.encryption.version ?? 1),
          localVersion: Number(this.settings.vaultEncryptionKeyVersion ?? 1),
          remoteSaltHex: status.encryption.salt_hex,
          localSaltHex: this.settings.vaultEncryptionSaltHex,
          localCredentialConfigured: this.settings.vaultEncryptionEnabled && Boolean(this.settings.vaultEncryptionSecretId),
        });
        validateVaultSyncRemoteKeyVersionCatalog({
          catalog: status.encryption.key_versions,
          activeVersion: Number(status.encryption.version ?? 1),
          activeSaltHex: status.encryption.salt_hex,
          localDescriptors: this.vaultEncryptionKeyDescriptors(),
        });
        this.settings.vaultEncryptionEnabled = true;
        this.settings.vaultEncryptionSaltHex = status.encryption.salt_hex;
        this.settings.vaultEncryptionKeyVersion = Number(status.encryption.version ?? 1);
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
      }, requestUrl);

      let vaultCrypto: VaultSyncCrypto | undefined;
      let vaultCryptoKeyring: VaultSyncCryptoKeyring | undefined;
      diagnosticStage = "encryption_setup";
      if (this.settings.vaultEncryptionEnabled) {
        const context = await this.loadVaultSyncCryptoContext();
        if (!context) throw new Error("Vault 加密密钥尚未加载");
        vaultCrypto = context.active;
        vaultCryptoKeyring = context.keyring;
        storage = createEncryptedVaultStorage(storage, vaultCrypto);
      }

      let capabilities: Awaited<ReturnType<VaultSyncRemoteClient["getCapabilities"]>> | null = null;
      try {
        diagnosticStage = "capability_read";
        capabilities = await remote.getCapabilities();
      } catch (error: any) {
        // Keep older API deployments usable until their capability route is upgraded.
        // All non-404 failures still stop the run instead of silently changing protocol.
        if (error?.status !== 404) throw error;
      }
      diagnosticProtocol = resolveVaultSyncProtocol(capabilities);
      diagnosticStage = "local_prepare";
      let configuredScope: VaultSyncScope = this.settings.vaultSyncScope === "root_folder" ? "root_folder" : "whole_vault";
      if (diagnosticProtocol === "v2" && capabilities?.scopePolicy
        && capabilities.scopePolicy.scope !== configuredScope) {
        // Scope mode is target-wide. Another device may have changed it; follow
        // the server policy locally, then force a snapshot below before writing.
        const remoteScope = capabilities.scopePolicy.scope;
        if (remoteScope !== "whole_vault" && remoteScope !== "root_folder") {
          throw Object.assign(new Error("服务端返回未知的 Vault 同步范围；已暂停以避免误应用文件"), {
            code: "vault_sync_v2_scope_invalid",
          });
        }
        configuredScope = remoteScope;
        this.settings.vaultSyncScope = configuredScope;
        await this.saveSettings();
        this.stopVaultSyncV2Events();
        if (!quiet) new Notice("Vault 同步范围已在另一台设备更新；本机已跟随云端策略并将重建快照", 10000);
      }
      if (diagnosticProtocol === "v2" && capabilities) {
        this.pendingDeletionReview = null;
        const deviceId = this.settings.vaultDeviceId || this.settings.vaultInstallationId;
        const identity: VaultSyncV2Identity = {
          apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl),
          targetId: this.settings.syncTargetId,
          deviceId,
          protocolEpoch: capabilities.protocolEpoch,
        };
        const rootFolder = configuredScope === "root_folder" ? normalizeVaultPath(this.settings.rootFolder) ?? "" : "";
        if (configuredScope === "root_folder" && !rootFolder) {
          throw Object.assign(new Error("微同步目录无效或为空；已暂停同步，避免把整个 Vault 当作范围"), {
            code: "vault_sync_scope_root_invalid",
          });
        }
        const scopeSelection = {
          scope: configuredScope,
          rootFolder,
          scopeVersion: capabilities.scopePolicy.version,
        } as const;
        const scopeState = createVaultSyncScopeStateStore(this.app, identity);
        const savedScope = await scopeState.load();
        let forceScopeSnapshot = !savedScope
          || savedScope.scope !== scopeSelection.scope
          || savedScope.rootFolder !== scopeSelection.rootFolder
          || savedScope.scopeVersion !== scopeSelection.scopeVersion;
        const bootstrapCollisionCopies: string[] = [];
        let initializationLeaseId: string | null = null;
        if (capabilities.canWrite && capabilities.supportedFeatures.includes("initialization_lease")) {
          const initialization = await remote.claimV2Initialization(capabilities.protocolEpoch);
          if (initialization.scope !== scopeSelection.scope || initialization.scopeVersion !== scopeSelection.scopeVersion) {
            throw Object.assign(new Error("Vault 同步范围在初始化期间发生变化；已暂停同步并要求重新读取能力"), {
              code: "initialization_scope_changed",
            });
          }
          if (initialization.status === "waiting") {
            diagnosticOutcome = "incomplete";
            diagnosticFailureCode = "vault_sync_initialization_waiting";
            this.lastSafeErrorCode = diagnosticFailureCode;
            this.vaultSyncRetry?.scheduleRetry();
            if (!quiet) new Notice(`另一台设备正在建立 Vault 初始基线；本机文件已保留，将在稍后继续（租约至 ${new Date(initialization.leaseExpiresAt).toLocaleTimeString()}）`, 12000);
            return;
          }
          if (initialization.status === "owner") {
            initializationLeaseId = initialization.leaseId;
            initializationLeaseKeeper = createVaultSyncInitializationLeaseKeeper({
              protocolEpoch: capabilities.protocolEpoch,
              scope: scopeSelection.scope,
              scopeVersion: scopeSelection.scopeVersion,
              leaseId: initialization.leaseId,
              leaseExpiresAt: initialization.leaseExpiresAt,
              claimInitialization: (protocolEpoch) => remote.claimV2Initialization(protocolEpoch),
            });
            forceScopeSnapshot = forceScopeSnapshot || initialization.requiresSnapshot;
          }
        }
        await archiveLegacyPrevSyncStateForV2(this.app, identity);
        const journal = createVaultSyncOutboxStore(this.app, identity);
        diagnosticV2Journal = journal;
        diagnosticWork = {};
        const pathIntents = createVaultSyncPathIntentStore(this.app, {
          apiBaseUrl: identity.apiBaseUrl, targetId: identity.targetId, installationId: this.settings.vaultInstallationId,
        });
        const baseline = createVaultSyncV2BaselineStore(this.app, identity);
        const baseContent = createVaultSyncV2BaseContentStore(this.app, identity, vaultCryptoKeyring ?? vaultCrypto);
        const staging = createVaultSyncV2SnapshotStageStore(this.app, identity);
        const objectTransport = createV2HostedObjectTransport(remote, async (input) => {
          const response = await requestUrl({
            url: input.url,
            method: input.method,
            headers: input.headers,
            body: input.body,
            throw: false,
          });
          return { status: response.status, headers: response.headers, arrayBuffer: response.arrayBuffer };
        }, vaultCryptoKeyring ?? vaultCrypto, {
          downloadStage: createVaultSyncV2DownloadStageStore(this.app, identity),
          onMultipartTransfer: (value) => { diagnosticMultipartTransfer = value; },
        });
        const pluginApp = this.app;
        const pushEngine = capabilities.canWrite ? createVaultSyncV2PushEngine({
          app: this.app, identity, remote, journal, baseline, pathIntents, transport: objectTransport,
          baseContent, autoMergeEnabled: this.settings.vaultSyncMergeMode === "automatic",
          allowEncryptedSize: this.settings.vaultEncryptionEnabled,
          getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
          isPathComposing: (path) => this.vaultSyncCompositionGuard?.isComposing(path) ?? false,
          isNewEmptyMarkdownDeferred: (path) => this.vaultSyncEmptyNoteGrace?.has(path) ?? false,
          deferNewEmptyMarkdown: (path) => { this.vaultSyncEmptyNoteGrace?.defer(path); },
          onAutoMergePhase: (phase) => this.vaultSyncDiagnostics.recordPushCasAutoMergePhase(phase),
          rootFolder,
          maxConcurrent: 1,
          assertInitializationLease: initializationLeaseKeeper
            ? () => initializationLeaseKeeper!.assertValid()
            : undefined,
          getForegroundPath: () => {
            if (typeof document === "undefined" || document.visibilityState !== "visible") return null;
            const activePath = this.app.workspace.getActiveFile()?.path ?? "";
            return activePath.toLowerCase().endsWith(".md") ? activePath : null;
          },
          // requestUrl buffers whole objects. Keep one transfer under a bounded
          // memory budget until multipart/streaming upload is implemented.
          maxInFlightBytes: 96 * 1024 * 1024,
        }) : null;
        const pull = createVaultSyncV2PullEngine({
          remote, journal, staging,
          snapshotApplyLeaseEnabled: capabilities.supportedFeatures.includes("snapshot_apply_lease"),
          apply: {
          app: pluginApp, identity, baseline, baseContent, pathIntents, rootFolder,
          allowEncryptedSize: this.settings.vaultEncryptionEnabled,
          autoMergeEnabled: this.settings.vaultSyncMergeMode === "automatic",
          preserveUntrackedSnapshotCollisions: !savedScope,
          onBootstrapCollisionPreserved: (_sourcePath, copyPath) => bootstrapCollisionCopies.push(copyPath),
          rebaseNetZeroConflict: pushEngine
            ? async (input) => (await pushEngine.rebaseConflict(input)).status === "committed"
            : undefined,
          deleteMode: this.settings.vaultSyncDeleteMode,
          deleteSafetyEnabled: this.settings.vaultSafetyEnabled,
          deleteSafetyRatio: this.settings.vaultSafetyRatio,
          trashLocalFile: (file) => this.trashRemoteVaultFile(file),
          getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
          renameFileAndUpdateLinks: (file, path) => this.renameRemoteVaultFileAndUpdateLinks(file, path),
            async downloadToStage(item) {
              const content = item.content;
              if (!content || content.kind !== "object" || content.byteSize < VAULT_SYNC_DOWNLOAD_RANGE_BYTES
                || !(vaultCryptoKeyring || vaultCrypto)
                || typeof (pluginApp.vault.adapter as any).appendBinary !== "function") return null;
              return downloadVaultSyncV2ToVerifiedStage(pluginApp, identity, {
                objectId: content.objectId,
                ciphertextHash: content.ciphertextHash,
                maxPlaintextBytes: VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES,
              }, (writePlaintextChunk) => objectTransport.downloadChunkedToSink(
                content, undefined, writePlaintextChunk,
              ));
            },
            async download(item) {
              const content = item.content;
              if (!content) throw Object.assign(new Error("远端版本缺少内容对象"), { code: "content_object_unavailable" });
              if (content.kind === "legacy") {
                if (!content.contentHash) throw Object.assign(new Error("旧版对象缺少内容摘要"), { code: "content_object_unavailable" });
                return storage.get(content.contentHash);
              }
              const downloaded = await objectTransport.download({ reservationId: "", ...content });
              return downloaded.plaintext;
            },
          },
        });
        diagnosticStage = "pull";
        const pullStartedAt = diagnosticClock();
        let pullHasUnresolvedConflict = false;
        let unresolvedPullConflictCount = 0;
        let pullDeferredPaths: string[] = [];
        const pullResult = await pull.runOnce({ forceSnapshot: forceScopeSnapshot });
        diagnosticPullMs = diagnosticClock() - pullStartedAt;
        const pullDisposition = classifyVaultSyncV2PullResult(pullResult);
        if (pullDisposition === "resolve_conflict") {
          const deferredPaths = (pullResult.deferredPaths ?? []).map(normalizeVaultPath)
            .filter((path): path is string => typeof path === "string");
          const unresolvedConflictCount = Math.max(0, pullResult.blocked - deferredPaths.length);
          const canPushIndependentFiles = canPushIndependentFilesAfterBlockedPull(pullResult, forceScopeSnapshot);
          if (deferredPaths.length) {
            for (const path of deferredPaths) this.vaultSyncEditorDeferredPaths.add(path);
            this.vaultSyncEventPending = true;
          }
          diagnosticOutcome = "incomplete";
          diagnosticFailureCode = unresolvedConflictCount === 0 && deferredPaths.length
            ? "vault_sync_v2_editor_deferred" : "vault_sync_v2_conflict";
          this.stopVaultSyncV2Events();
          this.lastSafeErrorCode = diagnosticFailureCode;
          this.vaultSyncRetry?.clear();
          if (!canPushIndependentFiles && !quiet) {
            if (deferredPaths.length && unresolvedConflictCount === 0) {
              const resume = this.settings.vaultSyncIntervalMinutes !== null
                ? "关闭笔记后会自动继续"
                : "关闭笔记后再次运行同步即可继续";
              new Notice(`云端删除已确认；接收端笔记仍在编辑器中，已安全暂缓。${resume}，无需再次确认删除。`, 12000);
            } else {
              const blockedCount = unresolvedConflictCount > 0 ? `${unresolvedConflictCount} 项` : "部分";
              const deferredHint = deferredPaths.length ? "；打开中的笔记关闭后会自动重试对应删除" : "";
              new Notice(`${blockedCount}远端变更暂不能安全应用；双方内容均已保留。${deferredHint} 请运行“微同步：处理待解决同步冲突”查看并处理其他冲突。`, 12000);
            }
          }
          if (!canPushIndependentFiles) return;
          pullHasUnresolvedConflict = true;
          unresolvedPullConflictCount = unresolvedConflictCount;
          pullDeferredPaths = deferredPaths;
        }
        if (pullDisposition === "continue_snapshot") {
          diagnosticOutcome = "incomplete";
          diagnosticFailureCode = `vault_sync_v2_${pullResult.status}`;
          this.stopVaultSyncV2Events();
          this.lastSafeErrorCode = `vault_sync_v2_${pullResult.status}`;
          if (this.settings.vaultSyncIntervalMinutes !== null) this.vaultSyncRetry?.scheduleRetry();
          if (!quiet) {
            const continuation = this.settings.vaultSyncIntervalMinutes !== null ? "后台会自动继续" : "再次启动同步即可继续";
            new Notice(pullResult.status === "snapshot_building"
              ? `Vault 正在准备同步快照；${continuation}`
              : `Vault 快照较大，进度已保存并分批处理；${continuation}`, 10000);
            if (bootstrapCollisionCopies.length) {
              new Notice(`首次加入已保留 ${bootstrapCollisionCopies.length} 份同路径本机文件副本：${bootstrapCollisionCopies.slice(0, 3).join("、")}`, 12000);
            }
          }
          return;
        }
        await initializationLeaseKeeper?.assertValid();
        const sessionGeneration = pullResult.snapshotState?.sessionGeneration;
        if (sessionGeneration && this.settings.vaultSyncIntervalMinutes !== null) {
          this.startVaultSyncV2Events(remote, identity, sessionGeneration, pullResult.snapshotState?.receivedCursor ?? "0");
        } else {
          this.stopVaultSyncV2Events();
        }
        await scopeState.save(scopeSelection);

        let pushResult: Awaited<ReturnType<ReturnType<typeof createVaultSyncV2PushEngine>["runOnce"]>> | null = null;
        if (capabilities.canWrite) {
          diagnosticStage = "push";
          const scan = await scanLocalFiles(this.app, rootFolder, undefined, this.vaultSyncIndex, {
            maxFileBytes: VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES,
            auditBatchSize: diagnosticsContext?.auditBatchSize,
          });
          diagnosticWork = {
            ...diagnosticWork,
            scanEntryCount: scan.index.size,
            scanIssueCount: scan.unreadablePaths.length + scan.oversizedPaths.length
              + scan.invalidPaths.length + scan.pathCollisions.length,
          };
          const [baselineEntries, journalSnapshot, pathMoveIntents] = await Promise.all([
            baseline.load(), journal.load(), pathIntents.load(),
          ]);
          const knownV2Paths = [
            ...baselineEntries.map((entry) => entry.path),
            ...(journalSnapshot?.operations.flatMap((entry) => [
              entry.request.operation.path,
              entry.request.operation.basePath,
            ].filter((path): path is string => typeof path === "string")) ?? []),
            ...(journalSnapshot?.inbox.flatMap((entry) => [entry.item.path, entry.item.previousPath]
              .filter((path): path is string => typeof path === "string")) ?? []),
            ...pathMoveIntents.flatMap((entry) => [entry.fromPath, entry.toPath]),
          ];
          const pushScan = {
            ...scan,
            index: excludeDeferredEmptyNotes(
              scan.index,
              this.vaultSyncEmptyNoteGrace?.paths() ?? [],
              knownV2Paths,
            ),
          };
          if (!pushEngine) throw new Error("Vault Sync push engine is unavailable");
          let pushStartedAt = 0;
          pushResult = await runV2PushAfterCompleteLocalScan(pushScan, async (index) => {
            pushStartedAt = diagnosticClock();
            return pushEngine.runOnce(index);
          });
          diagnosticWork = {
            ...diagnosticWork,
            pushCommittedCount: pushResult.uploaded,
            pushRenamedCount: pushResult.renamed,
            pushDeletedCount: pushResult.deleted,
            pushConflictCount: pushResult.conflicts,
            pushFailedCount: pushResult.failed,
            pushNeedsRebaseCount: pushResult.needsRebase,
            pushSkippedForBudgetCount: pushResult.skippedForBudget,
            pendingDeletionReviewCount: pushResult.deletionsPendingReview,
          };
          await initializationLeaseKeeper?.assertValid();
          if (canAutomaticallyPropagateDeletes({
            mode: this.settings.vaultSyncDeleteMode,
            safetyEnabled: this.settings.vaultSafetyEnabled,
            safetyRatio: this.settings.vaultSafetyRatio,
            pendingDeleteCount: pushResult.pendingDeletions.length,
            trackedLiveFileCount: (await baseline.load()).filter((entry) => !entry.isDeleted
              && shouldSyncPath(entry.path, rootFolder)).length,
          })) {
            const pendingAfterAutomatic: VaultSyncV2PendingDeletion[] = [];
            for (const deletion of pushResult.pendingDeletions) {
              try {
                const outcome = await pushEngine.commitReviewedDeletion(deletion);
                if (outcome.status === "committed") pushResult.deleted += 1;
                else if (outcome.status === "conflict") pushResult.conflicts += 1;
                else if (outcome.status === "needs_rebase") pushResult.needsRebase += 1;
                else {
                  pendingAfterAutomatic.push(deletion);
                  pushResult.failed += 1;
                  if (pushResult.failureCodes.length < 5) pushResult.failureCodes.push(outcome.failureCode ?? outcome.status);
                }
              } catch (error) {
                pendingAfterAutomatic.push(deletion);
                pushResult.failed += 1;
                if (pushResult.failureCodes.length < 5) {
                  pushResult.failureCodes.push(String((error as any)?.code ?? "delete_auto_commit_failed"));
                }
              }
            }
            pushResult.pendingDeletions = pendingAfterAutomatic;
            pushResult.deletionsPendingReview = pendingAfterAutomatic.length;
          }
          diagnosticWork = {
            ...diagnosticWork,
            pushCommittedCount: pushResult.uploaded,
            pushRenamedCount: pushResult.renamed,
            pushDeletedCount: pushResult.deleted,
            pushConflictCount: pushResult.conflicts,
            pushFailedCount: pushResult.failed,
            pushNeedsRebaseCount: pushResult.needsRebase,
            pushSkippedForBudgetCount: pushResult.skippedForBudget,
            pendingDeletionReviewCount: pushResult.deletionsPendingReview,
          };
          diagnosticPushMs = diagnosticClock() - pushStartedAt;
          this.pendingV2DeletionReview = pushResult.pendingDeletions;
          this.notifyPendingDeletionReview(
            pushResult.pendingDeletions,
            shouldShowDeletionReviewNotice("v2", quiet),
          );
          const reviewContext = {
            targetKey: `${identity.apiBaseUrl}\n${identity.targetId}`,
            scope: scopeSelection.scope,
            rootFolder: scopeSelection.rootFolder,
          };
          this.pendingV2DeletionHandler = createPendingV2DeletionReviewHandler({
            targetId: identity.targetId,
            expectedContext: reviewContext,
            lane: this.deletionReviewConfirmationLane,
            getCurrentContext: () => {
              const currentScope = this.settings.vaultSyncScope === "root_folder"
                ? "root_folder" : "whole_vault";
              return {
                targetKey: this.currentVaultSyncProtocolTargetKey(),
                scope: currentScope,
                rootFolder: currentScope === "root_folder"
                  ? normalizeVaultPath(this.settings.rootFolder) ?? "" : "",
                vaultSyncEnabled: this.settings.vaultSyncEnabled,
                accountLoggedIn: this.accountLoggedIn,
                lifecycleActive: this.vaultSyncLifecycleActive,
              };
            },
            getPendingItems: () => this.pendingV2DeletionReview,
            setPendingItems: (items) => { this.pendingV2DeletionReview = items; },
            commit: async (item, assertReviewContextCurrent) => {
              const outcome = await pushEngine.commitReviewedDeletion(item, assertReviewContextCurrent);
              return {
                status: outcome.status,
                failureCode: outcome.failureCode,
                supersededOperationCount: outcome.supersededOperationCount,
                changeCursor: outcome.status === "committed" ? outcome.baseline?.cursor : undefined,
              };
            },
            showNotice: (message, timeoutMs) => { new Notice(message, timeoutMs); },
            runSync: () => this.runVaultSync(true),
            notifyPendingItems: (items) => this.notifyPendingDeletionReview(items, true),
          });
        } else {
          this.pendingV2DeletionReview = [];
          this.pendingV2DeletionHandler = null;
          this.notifyPendingDeletionReview([], quiet);
        }

        diagnosticStage = "finalize";
        const baselineEntries = await baseline.load();
        const remoteFiles: Record<string, { contentHash: string | null; byteSize: number; revision: number; isDeleted: boolean }> = {};
        for (const entry of baselineEntries) {
          remoteFiles[entry.path] = {
            contentHash: entry.plaintextHash,
            byteSize: entry.byteSize,
            revision: Number(entry.cursor),
            isDeleted: entry.isDeleted,
          };
        }
        await this.reconcileCaptureHandoffsWithRemoteFiles(remoteFiles);

        if (!capabilities.canWrite) {
          diagnosticOutcome = "read_only";
          diagnosticFailureCode = "vault_sync_v2_read_only";
          this.lastSafeErrorCode = "vault_sync_v2_read_only";
          this.vaultSyncRetry?.clear();
          if (!quiet) new Notice(`Vault 只读同步完成：已应用 ${pullResult.applied} 项远端变化；此设备当前没有云端写权限`, 10000);
          return;
        }
        const pushIncomplete = !!pushResult && (pushResult.failed > 0 || pushResult.conflicts > 0
          || pushResult.needsRebase > 0 || pushResult.skippedForBudget > 0 || pushResult.deletionsPendingReview > 0);
        const incomplete = pullHasUnresolvedConflict || pushIncomplete;
        if (incomplete) {
          diagnosticOutcome = "incomplete";
          if (pushIncomplete) {
            diagnosticFailureCode = "vault_sync_v2_incomplete";
            this.lastSafeErrorCode = "vault_sync_v2_incomplete";
          }
          if ((pushResult?.failed ?? 0) > 0 && this.settings.vaultSyncIntervalMinutes !== null) {
            this.vaultSyncRetry?.scheduleRetry(pushResult?.retryAfterMs === undefined
              ? undefined : { retryAfterMs: pushResult.retryAfterMs });
          }
          else if (!pullHasUnresolvedConflict) this.vaultSyncRetry?.clear();
          if (!quiet) {
            const parts = [`拉取 ${pullResult.applied} 项`];
            if (pushResult) {
              parts.push(`上传 ${pushResult.uploaded} 项`, `推送冲突 ${pushResult.conflicts}`,
                `需重新对齐 ${pushResult.needsRebase}`, `失败 ${pushResult.failed}`);
              if (pushResult.renamed) parts.push(`改名 ${pushResult.renamed}`);
              if (pushResult.deleted) parts.push(`已删除 ${pushResult.deleted}`);
              if (pushResult.deletionsPendingReview) parts.push(`删除待审核 ${pushResult.deletionsPendingReview}`);
              if (pushResult.skippedForBudget) parts.push(`大文件暂缓 ${pushResult.skippedForBudget}`);
            }
            if (unresolvedPullConflictCount) parts.push(`待处理远端变更 ${unresolvedPullConflictCount} 项`);
            if (pullDeferredPaths.length) parts.push(`打开中的笔记暂缓 ${pullDeferredPaths.length} 项`);
            const reason = pushResult?.failureCodes[0];
            const preserved = bootstrapCollisionCopies.length
              ? `；首次加入已保留 ${bootstrapCollisionCopies.length} 份本机文件副本：${bootstrapCollisionCopies.slice(0, 3).join("、")}` : "";
            const conflictHint = pullHasUnresolvedConflict
              ? "；有冲突的文件已暂缓，其他无冲突笔记仍继续同步，请处理待解决同步冲突"
              : "";
            new Notice(`Vault 同步部分完成：${parts.join(" · ")}${reason ? `（${reason}）` : ""}${preserved}${conflictHint}`, 12000);
            if (pushResult?.pendingDeletions.length && this.pendingV2DeletionHandler) {
              this.openVaultV2DeletionReviewModal(pushResult.pendingDeletions, this.pendingV2DeletionHandler);
            }
          }
          return;
        }
        if (initializationLeaseId) {
          await initializationLeaseKeeper?.assertValid();
          const initialized = await remote.completeV2Initialization({
            protocolEpoch: capabilities.protocolEpoch,
            leaseId: initializationLeaseId,
          });
          if (initialized.status !== "ready" || initialized.scopeVersion !== scopeSelection.scopeVersion) {
            throw Object.assign(new Error("Vault 初始基线完成回执与当前同步范围不一致"), {
              code: "vault_sync_initialization_receipt_mismatch",
            });
          }
          initializationLeaseKeeper?.markCompleted();
        }
        diagnosticOutcome = "complete";
        this.lastSafeErrorCode = "";
        this.vaultSyncRetry?.clear();
        if (!quiet) {
          const preserved = bootstrapCollisionCopies.length
            ? `；首次加入保留本机同路径文件 ${bootstrapCollisionCopies.length} 份` : "";
          new Notice(`Vault 同步完成：拉取 ${pullResult.applied} 项，上传 ${pushResult?.uploaded ?? 0} 项，改名 ${pushResult?.renamed ?? 0} 项，删除 ${pushResult?.deleted ?? 0} 项${preserved}`, 8000);
        }
        return;
      }
      this.stopVaultSyncV2Events();
      this.pendingV2DeletionReview = [];
      this.pendingV2DeletionHandler = null;

      const store = createPrevSyncStore(this.app);
      const safetyOverrideFingerprint = this.vaultSafetyOverrideFingerprint;
      const orchestrator = createVaultSyncOrchestrator({
        app: this.app,
        storage,
        remote,
        store,
        localHashCache: this.vaultSyncIndex,
        auditBatchSize: diagnosticsContext?.auditBatchSize,
        deferredEmptyNotePaths: this.vaultSyncEmptyNoteGrace?.paths() ?? [],
        getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
        trashLocalFile: (path) => this.trashRemoteVaultPath(path),
        deviceId: this.settings.vaultDeviceId || this.settings.vaultInstallationId,
        rootFolder: this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined,
        bootstrapDirection: this.settings.vaultFirstSyncDirection === "ask" || this.settings.vaultFirstSyncDirection === "auto"
          ? undefined
          : this.settings.vaultFirstSyncDirection,
        bootstrapMode: this.settings.vaultFirstSyncDirection === "auto" ? "auto" : "manual",
        isStorageManagerDevice: this.settings.storageManagerIsCurrentDevice,
        canEstablishEmptyCloudBaselineAutomatically: status.storage_type === "hosted_s3"
          && currentDeviceClass() === "desktop",
        notify: quiet ? undefined : (msg) => new Notice(msg, 10000),
        notifyBootstrapDecisionRequired: (msg) => {
          if (this.vaultSyncBootstrapNoticeGate.shouldShow(this.currentVaultSyncProtocolTargetKey(), quiet)) {
            new Notice(msg, 15000);
          }
        },
        safetyEnabled: this.settings.vaultSafetyEnabled,
        safetyRatio: this.settings.vaultSafetyRatio,
        safetyOverrideFingerprint,
        deletionResolution,
      });
      diagnosticStage = "legacy_sync";
      const result = await orchestrator.runOnce();
      diagnosticWork = {
        ...(diagnosticWork ?? {}),
        v1UploadedCount: result.uploaded,
        v1DownloadedCount: result.downloaded,
        v1DeletedLocalCount: result.deletedLocal,
        v1DeletedRemoteCount: result.deletedRemote,
        v1ConflictCount: result.conflicts,
        v1FailedCount: result.failed,
        v1Aborted: result.aborted === true,
        v1NeedsBootstrapDecision: result.needsBootstrapDecision === true,
        v1SafetyBlocked: result.safetyBlocked === true,
        v1DeletionReviewRequired: result.deletionReviewRequired === true,
      };
      if (result.aborted || result.failed > 0 || result.conflicts > 0 || result.safetyBlocked || result.deletionReviewRequired) {
        diagnosticOutcome = "incomplete";
        diagnosticFailureCode = result.failureCodes?.[0]
          ?? (result.safetyBlocked ? "vault_sync_safety_blocked"
            : result.deletionReviewRequired ? "vault_sync_deletion_review"
              : result.needsBootstrapDecision ? "vault_sync_bootstrap_decision_required"
                : result.aborted ? "vault_sync_v1_aborted"
                  : result.conflicts > 0 ? "vault_sync_v1_conflict"
                    : result.failed > 0 ? "vault_sync_v1_file_failed" : "vault_sync_v1_incomplete");
      } else {
        diagnosticOutcome = "complete";
      }
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
        this.notifyPendingDeletionReview(
          result.pendingDeletions ?? [],
          shouldShowDeletionReviewNotice("v1", quiet),
        );
        this.vaultSyncRetry?.clear();
        if (!quiet) this.openVaultDeletionReviewModal(result);
        return;
      }
      if (!result.failed) this.pendingDeletionReview = null;
      this.notifyPendingDeletionReview([], quiet);
      if (result.aborted) {
        this.vaultSyncRetry?.clear();
      } else if (this.settings.vaultSyncIntervalMinutes !== null
        && result.failed > 0
        && (result.hasRetryableFailure || result.failureMessages?.some(isRetryableVaultSyncError))) {
        this.vaultSyncRetry?.scheduleRetry(result.retryAfterMs === undefined
          ? undefined : { retryAfterMs: result.retryAfterMs });
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
      const editorBusy = isVaultSyncActiveEditorBusyError(error);
      const writeRecoveryAmbiguous = String((error as any)?.code ?? "") === "vault_write_recovery_ambiguous";
      diagnosticOutcome = editorBusy ? "incomplete" : "failed";
      diagnosticFailureCode = String((error as any)?.code ?? "vault_sync_failed");
      this.vaultSafetyOverrideFingerprint = "";
      const message = error instanceof Error ? error.message : String(error);
      const upgradeNotice = getVaultSyncFailureNotice(error);
      this.lastSafeErrorCode = writeRecoveryAmbiguous ? diagnosticFailureCode
        : upgradeNotice ? "protocol_upgrade_required"
        : editorBusy ? diagnosticFailureCode : "vault_sync_failed";
      if (writeRecoveryAmbiguous) {
        this.vaultSyncWriteRecoveryBlocked = true;
        const path = normalizeVaultPath((error as any)?.path ?? "");
        if (path && !this.vaultSyncWriteRecoveryBlockedPaths.includes(path)) {
          this.vaultSyncWriteRecoveryBlockedPaths.push(path);
        }
        this.vaultSyncRetry?.clear();
        this.stopVaultSyncV2Events();
      }
      if (editorBusy) {
        const deferredPath = normalizeVaultPath((error as any)?.path ?? "");
        if (deferredPath) this.vaultSyncEditorDeferredPaths.add(deferredPath);
        this.vaultSyncEventPending = true;
        this.vaultSyncRetry?.clear();
      }
      if (upgradeNotice) {
        this.vaultSyncProtocolUpgradeTargetKey = this.currentVaultSyncProtocolTargetKey();
        this.vaultSyncRetry?.clear();
        this.stopVaultSyncV2Events();
      } else if (shouldScheduleVaultSyncFailureRetry(error, this.settings.vaultSyncIntervalMinutes !== null)) {
        this.vaultSyncRetry?.scheduleRetry(error);
      }
      if (!quiet) new Notice(upgradeNotice ?? (writeRecoveryAmbiguous
        ? `笔记写入结果无法确认，已保留本机内容和恢复文件并暂停 Vault 同步；请检查 ${(error as any)?.path ?? "目标笔记"} 及同目录 .wetongbu-update 临时文件后重载 Obsidian`
        : editorBusy
        ? (this.settings.vaultSyncIntervalMinutes === null
          ? "该笔记仍在编辑器中打开，远端更新已安全暂缓；关闭该笔记后点击“立即同步”继续，本机内容已保留"
          : "该笔记仍在编辑器中打开，远端更新已安全暂缓；关闭该笔记后将自动继续，本机内容已保留")
        : `Vault 同步失败：${message}`), 12000);
      if (!editorBusy) console.error("WeTongbu vault sync failed", error);
    } finally {
      initializationLeaseKeeper?.stop();
      const diagnosticDurationMs = diagnosticClock() - diagnosticStartedAt;
      if (diagnosticV2Journal && diagnosticWork) {
        try {
          const snapshot = await diagnosticV2Journal.load();
          const operations = snapshot?.operations ?? [];
          const inbox = snapshot?.inbox ?? [];
          const outboxCount = (state: VaultSyncOutboxOperation["state"]) => operations.filter((item) => item.state === state).length;
          diagnosticWork = {
            ...diagnosticWork,
            outboxReadable: true,
            outboxSnapshotPresent: snapshot !== null,
            ...(snapshot ? {
              outboxQueuedCount: outboxCount("queued"),
              outboxPreparingCount: outboxCount("preparing"),
              outboxUploadedCount: outboxCount("uploaded"),
              outboxCommittingCount: outboxCount("committing"),
              outboxConfirmedCount: outboxCount("confirmed"),
              outboxConflictCount: outboxCount("conflict"),
              outboxNeedsRebaseCount: outboxCount("needs_rebase"),
              inboxReceivedCount: inbox.filter((item) => item.state === "received").length,
              inboxNeedsResolutionCount: inbox.filter((item) => item.state === "needs_resolution").length,
            } : {}),
          };
        } catch {
          diagnosticWork = { ...diagnosticWork, outboxReadable: false, outboxSnapshotPresent: false };
        }
      }
      this.vaultSyncDiagnostics.record({
        durationMs: diagnosticDurationMs,
        outcome: diagnosticOutcome,
        protocol: diagnosticProtocol,
        pullMs: diagnosticPullMs,
        pushMs: diagnosticPushMs,
        queueWaitMs: diagnosticQueueWaitMs,
        activeQueueWaitMs: diagnosticActiveQueueWaitMs,
        failureCode: diagnosticFailureCode,
        stage: diagnosticStage,
        multipartTransfer: diagnosticMultipartTransfer,
        work: diagnosticWork,
      });
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

  async setVaultSyncMergeMode(mode: VaultSyncMergeMode) {
    this.settings.vaultSyncMergeMode = mode === "manual" ? "manual" : "automatic";
    await this.saveSettings();
  }

  async setVaultSyncDeleteMode(mode: VaultSyncDeleteMode) {
    this.settings.vaultSyncDeleteMode = mode === "automatic" ? "automatic" : "review";
    await this.saveSettings();
  }

  private openVaultSafetyModal(result: SyncResult) {
    new VaultSafetyModal(this.app, this, result).open();
  }

  get pendingDeletionCount() {
    return (this.pendingDeletionReview?.pendingDeletions?.length ?? 0) + this.pendingV2DeletionReview.length;
  }

  private refreshPendingDeletionStatusBarItem() {
    const item = this.pendingDeletionStatusBarItem;
    if (!item) return;
    const count = this.pendingDeletionCount;
    item.style.display = count > 0 ? "" : "none";
    item.textContent = `待确认删除 ${count}`;
    item.setAttribute("aria-label", `有 ${count} 项待确认删除；点击查看并处理`);
    item.title = "云端删除尚未提交。点击逐项确认或恢复。";
  }

  private notifyPendingDeletionReview(entries: readonly DeletionReviewNoticeEntry[], shouldNotify: boolean) {
    this.refreshPendingDeletionStatusBarItem();
    const localReminderSuppressionKey = localDeletionReminderSuppressionKey(
      entries,
      this.localDeletionReminderPaths,
    );
    if (localReminderSuppressionKey) {
      this.pendingDeletionReviewNoticeSuppressedKey = localReminderSuppressionKey;
    }
    const keepLocalDeletionAction = !!localReminderSuppressionKey && this.pendingDeletionCount > 0
      && (this.localDeletionReminderNotice?.noticeEl.isConnected ?? false);
    if (keepLocalDeletionAction) this.localDeletionReminderPaths.clear();
    else this.hideLocalDeletionReminderNotice();
    const noticeVisible = this.pendingDeletionReviewNotice?.noticeEl.isConnected ?? false;
    const transition = nextDeletionReviewNotice(
      this.pendingDeletionReviewNoticeKey,
      entries,
      shouldNotify,
      noticeVisible,
      this.pendingDeletionReviewOpener.isOpening || keepLocalDeletionAction,
      this.pendingDeletionReviewNoticeSuppressedKey,
    );
    this.pendingDeletionReviewNoticeKey = transition.key;
    if (entries.length === 0 || transition.key !== this.pendingDeletionReviewNoticeSuppressedKey) {
      this.pendingDeletionReviewNoticeSuppressedKey = "";
    }
    if (entries.length === 0) this.hidePendingDeletionReviewNotice();
    if (transition.shouldNotify && !this.pendingV2DeletionReviewModalOpen) {
      this.showPendingDeletionReviewNotice(transition.count, transition.key);
    }
  }

  private showPendingDeletionReviewNotice(count: number, key: string) {
    this.hidePendingDeletionReviewNotice();
    const message = document.createDocumentFragment();
    message.createEl("div", {
      text: formatPendingDeletionReviewNotice(count),
    });
    message.createEl("div", {
      text: "提醒关闭后，可在命令面板搜索“微同步：处理待确认删除”重新打开。",
    });
    const actions = message.createEl("div", { cls: "wetongbu-deletion-notice-actions" });
    actions.style.display = "flex";
    actions.style.flexWrap = "wrap";
    actions.style.gap = "0.5em";
    const action = actions.createEl("button", { text: "查看并处理删除" });
    action.addClass("mod-cta");
    const dismiss = actions.createEl("button", { text: "关闭提醒" });
    const notice = new Notice(message, 0);
    this.pendingDeletionReviewNotice = notice;
    action.addEventListener("click", () => {
      this.hidePendingDeletionReviewNotice();
      void this.openPendingDeletionReview();
    });
    dismiss.addEventListener("click", () => {
      this.pendingDeletionReviewNoticeSuppressedKey = key;
      this.hidePendingDeletionReviewNotice();
    });
  }

  private hidePendingDeletionReviewNotice() {
    this.pendingDeletionReviewNotice?.hide();
    this.pendingDeletionReviewNotice = null;
  }

  private openVaultDeletionReviewModal(result: SyncResult) {
    new VaultDeletionReviewModal(this.app, this, result).open();
  }

  async openPendingDeletionReview() {
    // An explicit user action always re-enables the review, even if the last
    // confirmation failed and its unchanged queue was temporarily suppressed.
    this.pendingDeletionReviewNoticeSuppressedKey = "";
    this.hidePendingDeletionReviewNotice();
    if (this.pendingDeletionReviewOpener.isOpening) return;
    if (this.pendingV2DeletionReview.length && this.pendingV2DeletionHandler) {
      this.openVaultV2DeletionReviewModal(this.pendingV2DeletionReview, this.pendingV2DeletionHandler);
      return;
    }
    if (!this.pendingDeletionReview?.deletionPlanFingerprint) {
      let openedV2Review = false;
      const previousRun = this.vaultSyncDiagnostics.snapshot().latest;
      await this.pendingDeletionReviewOpener.open(
        () => this.runVaultSync(false),
        () => this.pendingV2DeletionHandler ? this.pendingV2DeletionReview : [],
        (items) => {
          const handler = this.pendingV2DeletionHandler;
          if (handler) {
            openedV2Review = true;
            this.openVaultV2DeletionReviewModal([...items], handler);
          }
        },
      );
      const latestRun = this.vaultSyncDiagnostics.snapshot().latest;
      if (!openedV2Review && shouldNotifyEmptyDeletionReview(
        previousRun,
        latestRun,
        this.pendingDeletionCount,
      )) {
        new Notice("同步检查完成：没有待确认的云端删除。", 6000);
      }
      return;
    }
    this.openVaultDeletionReviewModal(this.pendingDeletionReview);
  }

  private openVaultV2DeletionReviewModal(
    items: VaultSyncV2PendingDeletion[],
    confirm: (item: VaultSyncV2PendingDeletion) => Promise<VaultSyncV2PendingDeletion[]>,
  ) {
    if (this.pendingV2DeletionReviewModalOpen) return;
    this.hidePendingDeletionReviewNotice();
    this.pendingV2DeletionReviewModalOpen = true;
    let modal: VaultSyncV2DeletionReviewModal;
    modal = new VaultSyncV2DeletionReviewModal(this.app, items, confirm, () => {
      if (this.pendingV2DeletionReviewModal === modal) this.pendingV2DeletionReviewModal = null;
      this.pendingV2DeletionReviewModalOpen = false;
      if (!this.vaultSyncLifecycleActive) return;
      if (this.pendingV2DeletionReview.length > 0) {
        this.pendingDeletionReviewNoticeSuppressedKey = nextDeletionReviewNotice(
          "",
          this.pendingV2DeletionReview.map((item) => ({
            path: item.path,
            fileId: item.fileId,
            expectedVersionId: item.expectedVersionId,
          })),
          false,
        ).key;
      } else if (this.pendingV2DeletionReview.length === 0) {
        this.pendingDeletionReviewNoticeSuppressedKey = "";
      }
      this.refreshPendingDeletionStatusBarItem();
      // The user has just seen this exact queue in the review modal. Keep the
      // status-bar entry available, but do not replace the dismissed local
      // deletion reminder with a second notice that opens the same modal.
      this.hidePendingDeletionReviewNotice();
      void this.runVaultSync(true);
    });
    this.pendingV2DeletionReviewModal = modal;
    modal.open();
  }

  async resolveVaultDeletions(
    fingerprint: string,
    decisions: Record<string, DeletionAction>,
  ) {
    if (!fingerprint) return;
    await this.runVaultSync(false, { fingerprint, decisions });
  }

  async openVaultConflictReview() {
    try {
      const state = await createPrevSyncStore(this.app).load();
      new VaultConflictReviewModal(this.app, this, state?.conflicts ?? {}).open();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`无法读取本地 Vault 同步状态，冲突记录未打开：${message}`, 12000);
      console.error("WeTongbu conflict review could not load the local sync state", error);
    }
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
    if (!this.vaultSyncWriteRecoveryReady) {
      new Notice("Vault 正在检查本地写入恢复，请稍后再同步", 8000);
      return;
    }
    const articleSyncQuiet = this.settings.vaultSyncEnabled;
    await this.syncNow(articleSyncQuiet);
    if (this.settings.vaultSyncEnabled) {
      await this.runVaultSync(false);
    }
  }

  async refreshVaultSyncDeviceProgress() {
    const pluginToken = this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    if (!pluginToken || !this.settings.syncTargetId) throw new Error("请先连接当前 Vault");
    const remote = createVaultSyncRemoteClient({
      apiBaseUrl: this.settings.apiBaseUrl,
      targetId: this.settings.syncTargetId,
      pluginToken,
    });
    this.vaultSyncDeviceProgress = await fetchV2DeviceProgressWhenActive(remote);
    this.vaultSyncDeviceProgressFetchedAt = new Date().toISOString();
  }

  async openDeletedVaultHistory() {
    const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    const deviceToken = this.vaultDeviceTokenCache || (this.settings.vaultDeviceTokenSecretId
      ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId) : "");
    if (!pluginToken || !deviceToken || !this.settings.syncTargetId || !this.settings.vaultDeviceId) {
      new Notice("请先连接并同步此 Vault，再恢复已删除文件");
      return;
    }
    try {
      const remote = createVaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken,
        deviceToken,
      });
      const capabilities = await remote.getCapabilities();
      if (!capabilities.canRead || !capabilities.baselineReady || !capabilities.historyPolicy?.enabled) {
        throw new Error("当前账号或 Vault 尚未开放历史版本读取");
      }
      const identity: VaultSyncV2Identity = {
        apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl),
        targetId: this.settings.syncTargetId,
        deviceId: this.settings.vaultDeviceId,
        protocolEpoch: capabilities.protocolEpoch,
      };
      const deleted = (await createVaultSyncV2BaselineStore(this.app, identity).load())
        .filter((entry) => entry.isDeleted)
        .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
      if (!deleted.length) {
        new Notice("当前设备没有已验证的云端删除检查点");
        return;
      }
      new VaultSyncV2DeletedHistoryModal(this.app, deleted.map((entry) => ({ fileId: entry.fileId, path: entry.path })), (entry) => {
        void this.openVaultHistory(entry.path, true, entry.fileId);
      }).open();
    } catch (error) {
      new Notice(`无法读取已删除文件历史：${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  async openVaultHistory(pathOverride?: string, includeDeletedHead = false, fileIdOverride?: string) {
    const file = pathOverride ? null : this.app.workspace.getActiveFile();
    const filePath = pathOverride ?? file?.path;
    if (!filePath) {
      new Notice("请先打开要查看历史版本的文件");
      return;
    }
    const pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId());
    const deviceToken = this.vaultDeviceTokenCache || (this.settings.vaultDeviceTokenSecretId
      ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId) : "");
    if (!pluginToken || !deviceToken || !this.settings.syncTargetId || !this.settings.vaultDeviceId) {
      new Notice("请先连接并同步此 Vault，再查看云端历史版本");
      return;
    }
    try {
      const remote = createVaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId: this.settings.syncTargetId,
        pluginToken,
        deviceToken,
      });
      const capabilities = await remote.getCapabilities();
      if (!capabilities.canRead || !capabilities.baselineReady || !capabilities.historyPolicy?.enabled) {
        throw new Error("当前账号或 Vault 尚未开放历史版本读取");
      }
      const identity: VaultSyncV2Identity = {
        apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl),
        targetId: this.settings.syncTargetId,
        deviceId: this.settings.vaultDeviceId,
        protocolEpoch: capabilities.protocolEpoch,
      };
      const baseline = await createVaultSyncV2BaselineStore(this.app, identity).load();
      const entry = baseline.find((item) => (fileIdOverride ? item.fileId === fileIdOverride : item.path === filePath)
        && (includeDeletedHead || !item.isDeleted));
      if (!entry) throw new Error("当前文件还没有已确认的云端版本；先完成一次同步后再查看历史");
      const firstPage = await remote.getFileVersions({ fileId: entry.fileId, limit: 50 });
      let vaultCrypto: VaultSyncCrypto | undefined;
      let vaultCryptoKeyring: VaultSyncCryptoKeyring | undefined;
      if (this.settings.vaultEncryptionEnabled) {
        const context = await this.loadVaultSyncCryptoContext();
        if (!context) throw new Error("此设备缺少 Vault 加密密码，无法预览历史内容");
        vaultCrypto = context.active;
        vaultCryptoKeyring = context.keyring;
      }
      const objectTransport = createV2HostedObjectTransport(remote, async (input) => {
        const response = await requestUrl({ url: input.url, method: input.method, headers: input.headers, body: input.body, throw: false });
        return { status: response.status, headers: response.headers, arrayBuffer: response.arrayBuffer };
      }, vaultCryptoKeyring ?? vaultCrypto, { downloadStage: createVaultSyncV2DownloadStageStore(this.app, identity) });
      const historyPush = capabilities.canWrite && capabilities.v2WriteAvailable
        ? createVaultSyncV2PushEngine({
          app: this.app,
          identity,
          remote,
          journal: createVaultSyncOutboxStore(this.app, identity),
          baseline: createVaultSyncV2BaselineStore(this.app, identity),
          pathIntents: createVaultSyncPathIntentStore(this.app, {
            apiBaseUrl: identity.apiBaseUrl, targetId: identity.targetId, installationId: this.settings.vaultInstallationId,
          }),
          baseContent: createVaultSyncV2BaseContentStore(this.app, identity, vaultCryptoKeyring ?? vaultCrypto),
          transport: objectTransport,
          allowEncryptedSize: this.settings.vaultEncryptionEnabled,
          getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
          isPathComposing: (path) => this.vaultSyncCompositionGuard?.isComposing(path) ?? false,
          onAutoMergePhase: (phase) => this.vaultSyncDiagnostics.recordPushCasAutoMergePhase(phase),
          rootFolder: this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined,
          maxConcurrent: 1,
          maxInFlightBytes: 96 * 1024 * 1024,
        })
        : null;
      const readPage = (beforeVersionNumber: string) => remote.getFileVersions({
        fileId: entry.fileId, beforeVersionNumber, limit: 50,
      });
      const readVersionBytes = async (
        version: VaultSyncV2FileVersion,
        maxBytes = HISTORY_PREVIEW_MAX_BYTES,
      ) => {
        if (version.contentStatus !== "object_referenced" || !version.contentObjectId) {
          throw new Error("该检查点没有经过验证的可读内容");
        }
        if (!Number.isSafeInteger(version.byteSize) || version.byteSize < 0 || version.byteSize > maxBytes) {
          throw new Error(`该历史内容超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB 读取上限`);
        }
        const downloaded = await objectTransport.downloadVersion({
          fileId: entry.fileId,
          versionId: version.versionId,
          expectedObjectId: version.contentObjectId,
        });
        return downloaded.plaintext;
      };
      const modal = new VaultSyncV2HistoryModal(
        this.app,
        filePath,
        firstPage,
        readPage,
        async (version) => new TextDecoder().decode(await readVersionBytes(version)),
        historyPush ? async (version) => {
          // Reconcile first while the normal sync gate is available. The
          // bounded object read/write then owns the shared gate exclusively.
          await this.runVaultSync(true);
          const gated = await vaultSyncObjectWorkGate.run(async () => {
            const freshCapabilities = await remote.getCapabilities();
            if (!freshCapabilities.canWrite || !freshCapabilities.v2WriteAvailable
              || freshCapabilities.protocolEpoch !== identity.protocolEpoch) {
              throw new Error("当前账号或 Vault 暂未开放云端历史恢复写入");
            }
            const current = await createVaultSyncV2BaselineStore(this.app, identity).get(entry.fileId);
            const latestPage = await remote.getFileVersions({ fileId: entry.fileId, limit: 1 });
            const remoteHead = latestPage.items.find((item) => item.isCurrent);
            if (!current || !remoteHead || current.fileVersionId !== remoteHead.versionId) {
              throw new Error("云端文件刚刚发生变化；已暂停恢复，请重新打开历史并同步后重试");
            }
            const bytes = await readVersionBytes(version, HISTORY_RESTORE_MAX_BYTES);
            const occupied = (candidate: string) => !!this.app.vault.getAbstractFileByPath(candidate)
              || this.app.vault.getFiles().some((item) => normalizePath(item.path).toLocaleLowerCase() === candidate.toLocaleLowerCase());
            const targetPath = historyRestoreTargetPath(version.path, version.versionNumber, entry.isDeleted, occupied);
            await ensureFolder(this, targetPath.split("/").slice(0, -1).join("/"));
            await writeBinaryAssetSafely(this.app, targetPath, bytes);
            let outcome: Awaited<ReturnType<typeof historyPush.restoreVersion>>;
            try {
              outcome = await historyPush.restoreVersion({
                fileId: entry.fileId,
                sourceVersionId: version.versionId,
                path: targetPath,
                bytes,
              });
            } catch (error) {
              new Notice(`云端恢复未提交；历史副本已保留在本地：${targetPath}（${error instanceof Error ? error.message : String(error)}）`, 12000);
              return false;
            }
            if (outcome.status !== "committed") {
              const reason = outcome.status === "conflict" ? "云端版本已变化，恢复副本已保留在本地待处理"
                : outcome.status === "needs_rebase" ? "恢复副本已保留在本地，云端需要重新对齐"
                  : `恢复副本已保留在本地（${outcome.failureCode ?? outcome.status}）`;
              new Notice(`${reason}：${targetPath}`, 10000);
              return false;
            }
            new Notice(`已提交云端恢复版本：${targetPath}。没有覆盖已有文件。`, 12000);
            return true;
          });
          if (!gated.started) {
            new Notice("另一个大型文件恢复、冲突处理或同步任务正在运行，请稍后重试", 8000);
          }
          await this.runVaultSync(true);
        } : undefined,
        entry.isDeleted,
      );
      modal.open();
    } catch (error) {
      new Notice(`无法打开云端历史：${formatVaultSyncHistoryError(error)}`, 10000);
    }
  }

  async openVaultSyncConflictCenter() {
    const targetId = this.settings.syncTargetId;
    const deviceId = this.settings.vaultDeviceId;
    if (!targetId || !deviceId) {
      new Notice("当前 Vault 尚未连接同步设备，无法定位本机冲突记录");
      return;
    }
    const showCachedConflicts = async () => {
      let cached: VaultSyncOutboxSnapshot | null = null;
      try {
        cached = await loadLatestVaultSyncOutboxSnapshot(this.app, {
          apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl), targetId, deviceId,
        });
      } catch { /* offline conflict browsing must never mutate or block on cache errors */ }
      const pending = cached?.inbox.some((entry) => entry.state === "needs_resolution") ?? false;
      const outbound = cached?.operations.some((operation) => operation.state === "conflict") ?? false;
      if (cached && (pending || outbound)) {
        new VaultSyncV2OfflineConflictSnapshotModal(this.app, cached).open();
        return;
      }
      new Notice("无法连接云端冲突中心；本机没有已校验的待处理冲突快照。请恢复连接后重试。", 10000);
    };
    let pluginToken = "";
    let deviceToken = "";
    let cloudStateVerified = false;
    try {
      pluginToken = await this.app.secretStorage.getSecret(this.pluginTokenSecretId()) ?? "";
      deviceToken = this.vaultDeviceTokenCache || (this.settings.vaultDeviceTokenSecretId
        ? await this.app.secretStorage.getSecret(this.settings.vaultDeviceTokenSecretId) ?? "" : "");
      if (!pluginToken || !deviceToken) {
        await showCachedConflicts();
        return;
      }
      const remote = createVaultSyncRemoteClient({
        apiBaseUrl: this.settings.apiBaseUrl,
        targetId,
        pluginToken,
        deviceToken,
      });
      const capabilities = await remote.getCapabilities();
      if (!capabilities.canRead || !capabilities.baselineReady) {
        throw new Error("当前设备尚未取得已验证的 Vault 读取基线");
      }
      cloudStateVerified = true;
      const identity: VaultSyncV2Identity = {
        apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl),
        targetId,
        deviceId,
        protocolEpoch: capabilities.protocolEpoch,
      };
      const journal = createVaultSyncOutboxStore(this.app, identity);
      const pathIntents = createVaultSyncPathIntentStore(this.app, {
        apiBaseUrl: identity.apiBaseUrl, targetId: identity.targetId, installationId: this.settings.vaultInstallationId,
      });
      const baseline = createVaultSyncV2BaselineStore(this.app, identity);
      const state = await journal.load();
      const pending = state?.inbox.filter((entry) => entry.state === "needs_resolution") ?? [];
      const outboundConflicts = state?.operations.filter((operation) => operation.state === "conflict") ?? [];
      if (!pending.length && !outboundConflicts.length) {
        new Notice("当前没有待处理的 v2 同步冲突");
        return;
      }

      let vaultCrypto: VaultSyncCrypto | undefined;
      let vaultCryptoKeyring: VaultSyncCryptoKeyring | undefined;
      if (this.settings.vaultEncryptionEnabled) {
        const context = await this.loadVaultSyncCryptoContext();
        if (!context) throw new Error("此设备缺少 Vault 加密密码，无法读取冲突版本");
        vaultCrypto = context.active;
        vaultCryptoKeyring = context.keyring;
      }
      const objectTransport = createV2HostedObjectTransport(remote, async (input) => {
        const response = await requestUrl({ url: input.url, method: input.method, headers: input.headers, body: input.body, throw: false });
        return { status: response.status, headers: response.headers, arrayBuffer: response.arrayBuffer };
      }, vaultCryptoKeyring ?? vaultCrypto, { downloadStage: createVaultSyncV2DownloadStageStore(this.app, identity) });
      const baseContent = createVaultSyncV2BaseContentStore(this.app, identity, vaultCryptoKeyring ?? vaultCrypto);
      const historyPush = capabilities.canWrite && capabilities.v2WriteAvailable
        ? createVaultSyncV2PushEngine({
          app: this.app,
          identity,
          remote,
          journal,
          baseline,
          pathIntents,
          baseContent,
          transport: objectTransport,
          allowEncryptedSize: this.settings.vaultEncryptionEnabled,
          getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
          isPathComposing: (path) => this.vaultSyncCompositionGuard?.isComposing(path) ?? false,
          onAutoMergePhase: (phase) => this.vaultSyncDiagnostics.recordPushCasAutoMergePhase(phase),
          rootFolder: this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined,
          maxConcurrent: 1,
          maxInFlightBytes: 96 * 1024 * 1024,
        })
        : null;
      const apply = createVaultSyncV2ApplyEngine({
        app: this.app,
        identity,
        baseline,
        journal,
        pathIntents,
        baseContent,
        renameFileAndUpdateLinks: (file, path) => this.renameRemoteVaultFileAndUpdateLinks(file, path),
        autoMergeEnabled: this.settings.vaultSyncMergeMode === "automatic",
        allowEncryptedSize: this.settings.vaultEncryptionEnabled,
        objectWorkGate: vaultSyncObjectWorkGate,
        rootFolder: this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined,
        async download(item) {
          const content = item.content;
          if (!content || content.kind !== "object") {
            throw Object.assign(new Error("此冲突版本不是可验证的 v2 对象；本地文件保持不变"), { code: "v2_conflict_remote_unavailable" });
          }
          return (await objectTransport.downloadVersion({
            fileId: item.fileId,
            versionId: item.fileVersionId,
            expectedObjectId: content.objectId,
          })).plaintext;
        },
      });
      const canResolveSamePathUpdate = async (entry: VaultSyncInboxEntry) => {
        const item = entry.item;
        if (item.eventType !== "update" || item.isDeleted || !item.content || item.content.kind !== "object"
          || !isVaultSyncContentWithinPlaintextLimit(item.byteSize, item.content, HISTORY_PREVIEW_MAX_BYTES,
            this.settings.vaultEncryptionEnabled)) return false;
        const previous = await baseline.get(item.fileId);
        const localFile = this.app.vault.getAbstractFileByPath(item.path);
        return !!previous && !previous.isDeleted && previous.path === item.path && !!localFile
          && Number.isSafeInteger(Number((localFile as any).stat?.size))
          && Number((localFile as any).stat.size) <= 2 * 1024 * 1024;
      };
      const previewGenerationByCursor = new Map<string, number>();
      const preview = async (entry: VaultSyncInboxEntry) => {
        const item = entry.item;
        if (item.isDeleted || !item.content || item.content.kind !== "object"
          || !item.path.toLowerCase().endsWith(".md")
          || !isVaultSyncContentWithinPlaintextLimit(item.byteSize, item.content, HISTORY_PREVIEW_MAX_BYTES,
            this.settings.vaultEncryptionEnabled)) {
          throw new Error("此冲突不支持 Markdown 三方预览");
        }
        const localFile = this.app.vault.getAbstractFileByPath(item.path);
        if (!localFile || !("extension" in localFile)) throw new Error("本地冲突文件已不存在");
        const localGeneration = this.vaultSyncIndex.getGeneration(item.path);
        previewGenerationByCursor.set(entry.cursor, localGeneration);
        const declaredLocalSize = Number((localFile as any).stat?.size);
        if (!Number.isSafeInteger(declaredLocalSize) || declaredLocalSize > 2 * 1024 * 1024) {
          throw new Error("本机冲突正文超过 2 MiB 预览上限；本地文件保持不变");
        }
        const localBytes = new Uint8Array(await this.app.vault.readBinary(localFile as any));
        assertVaultPathGeneration(item.path, localGeneration,
          (path) => this.vaultSyncIndex.getGeneration(path), "v2_conflict_local_changed");
        if (localBytes.byteLength > 2 * 1024 * 1024) {
          throw new Error("本机冲突正文超过 2 MiB 预览上限；本地文件保持不变");
        }
        const remoteBytes = (await objectTransport.downloadVersion({
          fileId: item.fileId,
          versionId: item.fileVersionId,
          expectedObjectId: item.content.objectId,
        })).plaintext;
        if (!isVaultSyncPlaintextSizeCompatible({
          itemByteSize: item.byteSize, content: item.content, plaintextByteSize: remoteBytes.byteLength,
          maxPlaintextBytes: HISTORY_PREVIEW_MAX_BYTES,
          allowEncryptedSize: this.settings.vaultEncryptionEnabled,
        })) throw new Error("云端正文尺寸与冲突变更记录不一致；本地文件保持不变");
        const previous = await baseline.get(item.fileId);
        const baseBytes = previous?.plaintextHash ? await baseContent.get(previous.plaintextHash) : null;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const remoteChoice = getConflictActionAvailability(
          this.app, item.path, await canResolveSamePathUpdate(entry),
        );
        return {
          path: item.path,
          base: baseBytes ? decoder.decode(baseBytes) : "（共同基线缺失）",
          local: decoder.decode(localBytes),
          remote: decoder.decode(remoteBytes),
          canChooseRemote: remoteChoice.canApplyRemote,
          canSubmitLocal: remoteChoice.canSubmitLocal,
          canEditMerge: remoteChoice.canEditMerge,
          remoteChoiceBlockedByActiveEditor: remoteChoice.blockedByActiveEditor,
          localHash: await sha256Hex(localBytes),
        };
      };
      const previewOutboundRebase = async (operation: VaultSyncOutboxOperation) => {
        const operationType = operation.request.operation.type;
        if (operation.state !== "conflict" || (operationType !== "update" && operationType !== "delete" && operationType !== "rename")) {
          throw new Error("该 outbox 操作类型暂不支持重新确认");
        }
        const previous = await baseline.get(operation.fileId);
        if (!previous || previous.isDeleted) throw new Error("本机缺少有效的云端基线");
        if (operationType === "rename") {
          if (!previous.plaintextHash) throw new Error("改名冲突缺少已验证的共同正文基线");
          const desiredPath = (operation.request.operation as any).path as string;
          const localFile = this.app.vault.getAbstractFileByPath(desiredPath);
          if (!localFile || !("extension" in localFile)) throw new Error("本机改名后的文件已不存在");
          const declaredLocalSize = Number((localFile as any).stat?.size);
          if (!Number.isSafeInteger(declaredLocalSize) || declaredLocalSize > 2 * 1024 * 1024) {
            throw new Error("改名冲突当前只支持预览 2 MiB 内 Markdown；本机文件保持不变");
          }
          const localBytes = new Uint8Array(await this.app.vault.readBinary(localFile as any));
          if (!desiredPath.toLowerCase().endsWith(".md") || localBytes.byteLength > 2 * 1024 * 1024) {
            throw new Error("改名冲突当前只支持预览 2 MiB 内 Markdown；本机文件保持不变");
          }
          const latestPage = await remote.getFileVersions({ fileId: operation.fileId, limit: 1 });
          const head = latestPage.items.find((item) => item.isCurrent);
          if (!head || head.isDeleted || head.versionId === operation.request.expectedVersionId
            || head.contentStatus !== "object_referenced" || !head.contentObjectId || head.byteSize > 2 * 1024 * 1024) {
            throw new Error("云端当前改名版本不可预览；请先同步并重新检查冲突");
          }
          const remoteBytes = (await objectTransport.downloadVersion({
            fileId: operation.fileId, versionId: head.versionId, expectedObjectId: head.contentObjectId,
          })).plaintext;
          if (remoteBytes.byteLength > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES
            || await sha256Hex(remoteBytes) !== previous.plaintextHash) {
            throw new Error("云端改名同时包含正文变化；请先处理正文冲突，本机文件保持不变");
          }
          const baseBytes = await baseContent.get(previous.plaintextHash);
          const decoder = new TextDecoder("utf-8", { fatal: true });
          return {
            expectedVersionId: head.versionId,
            preview: {
              path: `${desiredPath}（云端当前：${head.path}）`,
              base: baseBytes ? decoder.decode(baseBytes) : "（共同基线缺失）",
              local: decoder.decode(localBytes),
              remote: decoder.decode(remoteBytes),
              canChooseRemote: false,
            } satisfies VaultSyncV2ConflictPreview,
          };
        }
        if (!previous.path.toLowerCase().endsWith(".md")) {
          throw new Error("仅支持预览 Markdown 冲突；outbox 冲突仍保留");
        }
        let localText: string;
        if (operationType === "delete") {
          if (this.app.vault.getAbstractFileByPath(previous.path)) {
            throw new Error("本机文件已重新出现；不会重新确认删除，请先重新同步");
          }
          localText = formatMissingLocalDeletionConflict();
        } else {
          const localFile = this.app.vault.getAbstractFileByPath(previous.path);
          if (!localFile || !("extension" in localFile)) throw new Error("本机冲突文件已不存在");
          const declaredLocalSize = Number((localFile as any).stat?.size);
          if (!Number.isSafeInteger(declaredLocalSize) || declaredLocalSize > 2 * 1024 * 1024) {
            throw new Error("本机内容已变化或超过 2 MiB 预览上限；outbox 冲突仍保留");
          }
          const localBytes = new Uint8Array(await this.app.vault.readBinary(localFile as any));
          if (localBytes.byteLength > 2 * 1024 * 1024 || localBytes.byteLength !== operation.localByteSize
            || await sha256Hex(localBytes) !== operation.localContentHash) {
            throw new Error("本机内容已变化或超过 2 MiB 预览上限；outbox 冲突仍保留");
          }
          localText = new TextDecoder("utf-8", { fatal: true }).decode(localBytes);
        }
        const latestPage = await remote.getFileVersions({ fileId: operation.fileId, limit: 1 });
        const head = latestPage.items.find((item) => item.isCurrent);
        if (!head || head.isDeleted || head.path !== previous.path || head.versionId === operation.request.expectedVersionId
          || head.contentStatus !== "object_referenced" || !head.contentObjectId || head.byteSize > 2 * 1024 * 1024) {
          throw new Error("云端当前 head 不可预览或与原路径不符；请先同步并检查冲突");
        }
        const remoteBytes = (await objectTransport.downloadVersion({
          fileId: operation.fileId,
          versionId: head.versionId,
          expectedObjectId: head.contentObjectId,
        })).plaintext;
        if (remoteBytes.byteLength > VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES) throw new Error("云端正文超过本机历史预览上限");
        const baseBytes = previous.plaintextHash ? await baseContent.get(previous.plaintextHash) : null;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        return {
          expectedVersionId: head.versionId,
          preview: {
            path: previous.path,
            base: baseBytes ? decoder.decode(baseBytes) : "（共同基线缺失）",
            local: localText,
            remote: decoder.decode(remoteBytes),
            canChooseRemote: false,
          } satisfies VaultSyncV2ConflictPreview,
        };
      };
      const largeOrBinaryUpdateConflictCursors = new Set<string>();
      const keepLocalRemoteUpdateCursors = new Set<string>();
      const renameConflictCursors = new Set<string>();
      const createConflictCursors = new Set<string>();
      const deleteConflictCursors = new Set<string>();
      const occupiedRemoteRenameEntries = pending.filter((entry) => entry.item.eventType === "rename"
        && !!entry.item.previousPath && entry.item.previousPath !== entry.item.path
        && !!this.app.vault.getAbstractFileByPath(entry.item.path));
      const renameTargetIdentityByCursor = new Map<string, RemoteRenameTargetIdentity>();
      if (occupiedRemoteRenameEntries.length) {
        let baselineEntries: Awaited<ReturnType<typeof baseline.load>> = [];
        try { baselineEntries = await baseline.load(); } catch { /* preserve an unknown identity when evidence cannot be read */ }
        for (const entry of occupiedRemoteRenameEntries) {
          renameTargetIdentityByCursor.set(entry.cursor,
            classifyRemoteRenameTargetIdentity(entry.item, baselineEntries));
        }
      }
      for (const entry of pending) {
        const previewableMarkdown = entry.item.path.toLowerCase().endsWith(".md")
          && !!entry.item.content && isVaultSyncContentWithinPlaintextLimit(
            entry.item.byteSize, entry.item.content, HISTORY_PREVIEW_MAX_BYTES, this.settings.vaultEncryptionEnabled,
          ) && await canResolveSamePathUpdate(entry);
        if (entry.item.eventType === "update" && await apply.canResolveRemoteUpdate(entry) && !previewableMarkdown) {
          largeOrBinaryUpdateConflictCursors.add(entry.cursor);
        }
        if (historyPush && await historyPush.canKeepLocalForRemoteUpdate(entry)) {
          keepLocalRemoteUpdateCursors.add(entry.cursor);
        }
        if (await apply.canResolveRemoteRename(entry)) renameConflictCursors.add(entry.cursor);
        if (await apply.canResolveRemoteCreate(entry)) createConflictCursors.add(entry.cursor);
        if (await apply.canResolveRemoteDelete(entry)) deleteConflictCursors.add(entry.cursor);
      }
      const modal = new VaultSyncV2ConflictCenterModal(
        this.app,
        pending,
        outboundConflicts,
        largeOrBinaryUpdateConflictCursors,
        keepLocalRemoteUpdateCursors,
        renameConflictCursors,
        createConflictCursors,
        deleteConflictCursors,
        preview,
        previewOutboundRebase,
        historyPush ? async (operation) => {
          const outcome = await historyPush.repathCreateConflict({ operationId: operation.operationId });
          if (outcome.status === "committed") new Notice("本机文件已保留到新路径并重新同步；原云端路径保持不变");
          else if (outcome.status === "conflict") new Notice("换路径后的新建仍遇到云端竞争；本机副本和 outbox 操作均已保留，请刷新冲突中心", 10000);
          else new Notice(`换路径重提尚未完成；本机副本和 outbox 操作仍保留（${outcome.failureCode ?? outcome.status}）`, 10000);
          await this.runVaultSync(true);
        } : undefined,
        historyPush ? async (operation, expectedVersionId) => {
          const outcome = operation.request.operation.type === "delete"
            ? await historyPush.rebaseDeleteConflict({ operationId: operation.operationId, expectedVersionId })
            : operation.request.operation.type === "rename"
              ? await historyPush.rebaseRenameConflict({ operationId: operation.operationId, expectedVersionId })
              : await historyPush.rebaseConflict({ operationId: operation.operationId, expectedVersionId });
          if (outcome.status === "committed") new Notice(operation.request.operation.type === "delete"
            ? "已删除刚才预览的云端版本"
            : operation.request.operation.type === "rename"
              ? "本机改名已基于预览中的云端版本重新提交"
              : "本机内容已基于预览中的云端版本重新提交");
          else if (outcome.status === "conflict") new Notice("预览期间云端又有新版本；本机操作仍保留，请刷新后重新比较", 10000);
          else new Notice(`重基尚未提交；outbox 操作仍保留（${outcome.failureCode ?? outcome.status}）`, 10000);
          await this.runVaultSync(true);
        } : undefined,
        historyPush ? async (operation) => {
          await historyPush.cancelDeleteConflict({ operationId: operation.operationId });
          new Notice("已保留本机文件并撤销待删除操作；下一轮同步会重新比较本机和云端版本");
          await this.runVaultSync(true);
        } : undefined,
        historyPush ? async (entry, expectedLocalHash, mergeDraft) => {
          const submitLocalVersion = async (localHash: string | undefined, isMerge: boolean) => {
            const gated = await vaultSyncObjectWorkGate.run(() => historyPush.keepLocalForRemoteUpdate(entry.cursor, localHash));
            if (!gated.started) throw new Error("另一个同步或大对象操作正在运行，请完成后再处理此冲突");
            const outcome = gated.value;
            if (outcome.status !== "committed") {
              throw new Error(outcome.status === "conflict"
                ? "云端版本刚刚又发生变化；本机文件和重提待办仍保留，请刷新后再处理"
                : `本机版本尚未提交；冲突和重提待办仍保留（${outcome.failureCode ?? outcome.status}）`);
            }
            new Notice(isMerge
              ? "合并正文已提交为云端新版本；冲突前的云端版本保留在历史记录"
              : "已将本机预览原样提交为云端新版本；这不是合并，冲突前的云端版本保留在历史记录", 12000);
            await this.runVaultSync(true).catch((error) => {
              new Notice(`版本已提交；后续同步尚未完成（${error instanceof Error ? error.message : String(error)}）`, 10000);
            });
          };
          if (mergeDraft) {
            await submitManualConflictMerge({
              expectedPreviewText: mergeDraft.expectedPreviewText,
              mergedText: mergeDraft.text,
              maxBytes: HISTORY_PREVIEW_MAX_BYTES,
              writeText: async (mergedText, expectedPreviewText) => {
                await writeTextAtomically(this.app, entry.item.path, mergedText, expectedPreviewText, {
                  expectedGeneration: previewGenerationByCursor.get(entry.cursor),
                  getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
                });
                this.vaultSyncIndex.invalidate(entry.item.path);
              },
              submit: (mergedHash) => submitLocalVersion(mergedHash, true),
            });
            return;
          }
          await submitLocalVersion(expectedLocalHash, false);
        } : undefined,
        async (entry) => {
          const result = await resolveConflictAndScheduleFollowUp(
            () => apply.resolveInboxWithRemote(entry.cursor),
            () => this.runVaultSync(false),
            (error) => new Notice(
              `冲突已处理；后续同步未完成（${error instanceof Error ? error.message : String(error)}）`,
              10000,
            ),
          );
          if (entry.item.eventType === "rename" && result.preservedLocalPath) {
            new Notice(`已在 ${entry.item.path} 应用云端改名；本机内容保留在 ${result.preservedLocalPath}，将作为独立文件继续同步`, 12000);
          } else if (entry.item.eventType === "delete" && result.preservedLocalPath) {
            new Notice(`已确认云端删除；已改名的本机文件保留在 ${result.preservedLocalPath}，将作为独立文件继续同步`, 12000);
          } else if (entry.item.eventType === "delete" && result.conflictCopyPath) {
            new Notice(`已确认云端删除；本机文件保存在 ${result.conflictCopyPath}，将作为独立文件继续同步`, 12000);
          } else if (result.conflictCopyPath) {
            new Notice(`已采用云端内容；本机冲突副本保存在 ${result.conflictCopyPath}`, 12000);
          } else {
            new Notice("本地和远端内容已相同，冲突回执已推进");
          }
        },
        async () => {
          await this.runVaultSync(true);
          await this.openVaultSyncConflictCenter();
        },
        this.settings.vaultEncryptionEnabled,
        identity.deviceId,
        renameTargetIdentityByCursor,
      );
      modal.open();
    } catch (error) {
      if (!cloudStateVerified) await showCachedConflicts();
      else new Notice(`无法打开同步冲突中心：${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  async openVaultSyncNeedsRebaseReview() {
    const targetId = this.settings.syncTargetId;
    const deviceId = this.settings.vaultDeviceId;
    if (!targetId || !deviceId) {
      new Notice("当前 Vault 尚未连接同步设备，无法读取本机需重基记录");
      return;
    }
    try {
      const snapshot = await loadLatestVaultSyncOutboxSnapshot(this.app, {
        apiBaseUrl: normalizeApiBaseUrl(this.settings.apiBaseUrl), targetId, deviceId,
      });
      if (!snapshot) {
        new Notice("本机没有可校验的同步 outbox 快照");
        return;
      }
      const baselineEntries = await createVaultSyncV2BaselineStore(this.app, snapshot.identity).load().catch(() => []);
      const items = summarizeVaultSyncNeedsRebase(snapshot, baselineEntries);
      if (!items.length) {
        new Notice("本机 outbox 没有需重基的操作");
        return;
      }
      new VaultSyncNeedsRebaseModal(this.app, items).open();
    } catch (error) {
      new Notice(`无法读取本机需重基记录：${error instanceof Error ? error.message : String(error)}`, 10000);
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
        this.settingTab?.refreshCaptureHandoffStatus();
        const syncRoot = this.settings.vaultSyncScope === "root_folder" ? this.settings.rootFolder : undefined;
        if (written.files.some((file: { path: string }) => shouldSyncPath(file.path, syncRoot))) {
          this.requestAutomaticVaultSync();
        }
        this.settings.processedTaskIds.push(item.task_id);
        this.settings.processedTaskIds = this.settings.processedTaskIds.slice(-1000);
        await this.saveSettings();
        await this.completeHostedTask(base, token, item.task_id);
        completedOnServer = true;
        if (!this.settings.vaultSyncEnabled) {
          await this.captureHandoffs.remove(item.task_id);
          this.settingTab?.refreshCaptureHandoffStatus();
        }
        synced += 1;
      } catch (error) {
        if (!completedOnServer) await this.failHostedTask(base, token, item.task_id, error);
        throw error;
      }
    }
    return synced;
  }

  private async findClipContinuationNote(taskId: string, requestedNotePath?: string) {
    if (requestedNotePath) {
      const normalizedPath = normalizePath(requestedNotePath);
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!(file instanceof TFile)) return null;
      const generation = this.vaultSyncIndex.getGeneration(file.path);
      const candidate = articleCandidate(file.path, await this.app.vault.cachedRead(file));
      return candidate.taskId === taskId ? { ...candidate, file, generation } : null;
    }
    const root = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
    const matches: Array<ArticleCandidate & { file: TFile; generation: number }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (root && file.path !== root && !file.path.startsWith(`${root}/`)) continue;
      const generation = this.vaultSyncIndex.getGeneration(file.path);
      const content = await this.app.vault.cachedRead(file);
      const candidate = articleCandidate(file.path, content);
      if (candidate.taskId === taskId) matches.push({ ...candidate, file, generation });
    }
    if (matches.length > 1) throw new Error("图片续传任务对应多个剪藏文章；为避免改错文章，已停止回填");
    return matches[0] ?? null;
  }

  private async applyHostedMediaContinuation(
    task: any,
    imageLinks: Record<string, string>,
    candidate: ArticleCandidate & { file: TFile; generation: number },
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
    const createdPaths: Array<{ path: string; body: Uint8Array; mtime: number | null }> = [];
    const localFiles: Array<{ path: string; body: Uint8Array }> = [];
    try {
      const original = await this.app.vault.cachedRead(candidate.file);
      let updated = original;
      for (const [index, asset] of task.assets.entries()) {
        const reference = typeof asset.clipReference === "string" ? asset.clipReference : "";
        if (!reference) throw new Error(`图片续传清单缺少原引用：${asset.relativePath}`);
        const hostedLink = asset.kind === "image" ? imageLinks[asset.relativePath] : undefined;
        const imageOnly = Boolean(hostedLink);
        if (hostedLink) {
          const result = await applyMediaContinuationAsset({
            markdown: updated,
            from: reference,
            to: hostedLink,
            imageOnly,
          });
          if (!result.included) continue;
          updated = result.markdown;
          continue;
        }
        const desiredPath = normalizePath(`${attachmentFolder}/${layout.assetNames[index]}`);
        const resolved = await resolveAssetTarget(this.app.vault.adapter, desiredPath, new Uint8Array(asset.body));
        const replacement = relativeVaultPath(noteFolder, resolved.targetPath);
        const result = await applyMediaContinuationAsset({
          markdown: updated,
          from: reference,
          to: replacement,
          ensureDependency: async () => {
            if (resolved.writeLocal) {
              await ensureFolder(this, attachmentFolder);
              const body = new Uint8Array(asset.body);
              const write = await writeBinaryAssetSafely(this.app, resolved.targetPath, body);
              if (write.created) createdPaths.push({ path: resolved.targetPath, body, mtime: write.mtime });
              const persisted = await this.app.vault.adapter.stat(resolved.targetPath);
              if (!persisted || persisted.type !== "file" || persisted.size !== asset.body.length) {
                throw new Error(`附件写入校验失败：${resolved.targetPath}`);
              }
            }
            localFiles.push({ path: resolved.targetPath, body: new Uint8Array(asset.body) });
          },
        });
        if (!result.included) continue;
        updated = result.markdown;
      }
      return await commitMediaContinuationNoteAndEvidence({
        notePath,
        original,
        updated,
        assets: localFiles,
        writeNote: (content, expectedOriginal) => writeTextAtomically(this.app, notePath, content, expectedOriginal, {
          expectedGeneration: candidate.generation,
          getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
        }),
      });
    } catch (error) {
      for (const file of createdPaths) {
        await removeBinaryAssetIfUnchanged(this.app, file.path, file.body, file.mtime).catch(() => false);
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

  async getCaptureHandoffStatusSummary(): Promise<string> {
    const handoffs = await this.captureHandoffs.list();
    return captureHandoffStatusSummary(
      handoffs,
      this.settings.vaultSyncEnabled,
      this.settings.vaultSyncIntervalMinutes,
    );
  }

  private async reconcileCaptureHandoffs() {
    const handoffs = await this.captureHandoffs.list();
    if (!handoffs.length) return;
    const store = createPrevSyncStore(this.app);
    const prev = await store.load();
    if (prev) await this.reconcileCaptureHandoffsWithRemoteFiles(prev.files);
  }

  private async reconcileCaptureHandoffsWithRemoteFiles(
    remoteFiles: Record<string, { contentHash: string | null; byteSize: number; revision?: number; isDeleted?: boolean }>,
  ) {
    const handoffs = await this.captureHandoffs.list();
    if (!handoffs.length) return;
    let changed = false;
    for (const handoff of handoffs) {
      if (!handoff.requiresVaultSync) {
        await this.captureHandoffs.remove(handoff.taskId);
        changed = true;
        continue;
      }
      const committed = await captureHandoffFilesHaveCommittedSuccessors(handoff, remoteFiles, async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        const body = new Uint8Array(await this.app.vault.readBinary(file));
        return { contentHash: await sha256Hex(body), byteSize: body.byteLength };
      }, async (record, currentHandoff) => {
        const existing = this.app.vault.getAbstractFileByPath(record.path);
        if (existing instanceof TFile) return record.path;
        if (record.path !== currentHandoff.notePath) return null;
        const movedNotes = this.app.vault.getMarkdownFiles().filter((file) =>
          this.app.metadataCache.getFileCache(file)?.frontmatter?.wetongbu_task_id === currentHandoff.taskId);
        return movedNotes.length === 1 ? movedNotes[0].path : null;
      });
      if (committed) {
        await this.captureHandoffs.remove(handoff.taskId);
        changed = true;
      }
    }
    if (changed) this.settingTab?.refreshCaptureHandoffStatus();
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
        await withVaultPathWriteLock(target, async () => {
          if (this.app.vault.getAbstractFileByPath(target)) return;
          await this.app.vault.create(target, content);
        });
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
      const result: Array<{ file: TFile; content: string; generation: number }> = [];
      for (const file of files) {
        const generation = this.vaultSyncIndex.getGeneration(file.path);
        result.push({ file, content: await this.app.vault.cachedRead(file), generation });
      }
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
    const selectedCandidate = selected ? candidates.find(({ file }) => file.path === selected.path) : undefined;
    const note = selectedCandidate?.file;
    if (!selected || !selectedCandidate || !note) {
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
    const createdAssets: Array<{ path: string; body: Uint8Array; mtime: number | null }> = [];
    try {
      for (const { asset, targetPath, writeLocal } of localAssets) {
        if (!writeLocal) continue;
        const bodyBytes = new Uint8Array(asset.body);
        const write = await writeBinaryAssetSafely(this.app, targetPath, bodyBytes);
        if (write.created) createdAssets.push({ path: targetPath, body: bodyBytes, mtime: write.mtime });
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
      await withVaultPathWriteLock(note.path, async () => {
        let replacementStarted = false;
        let replacementCommitted = false;
        let rollbackVerified = false;
        try {
          await assertSafeTextReplacement(this.app, note.path, original, {
            expectedGeneration: selectedCandidate.generation,
            getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
          });
          replacementStarted = true;
          await this.app.vault.adapter.write(note.path, updated);
          const persisted = await this.app.vault.adapter.read(note.path);
          if (persisted !== updated) throw new Error("原笔记更新校验失败");
          replacementCommitted = true;
        } catch (error) {
          if (!replacementStarted) {
            rollbackVerified = true;
          } else {
            try {
              await this.app.vault.adapter.write(note.path, original);
              rollbackVerified = (await this.app.vault.adapter.read(note.path)) === original;
            } catch {
              rollbackVerified = false;
            }
          }
          throw error;
        } finally {
          if (replacementCommitted || rollbackVerified) {
            await cleanupTextReplacementArtifacts(this.app.vault.adapter as any, [backup, temporary]);
          }
        }
      });
      let finalPath = note.path;
      const desiredPath = normalizePath(`${noteFolder}/${layout.noteFilename}`);
      if (desiredPath !== note.path) {
        await withVaultPathWriteLocks([note.path, desiredPath], async () => {
          if (await this.app.vault.adapter.exists(desiredPath)) return;
          const current = this.app.vault.getAbstractFileByPath(note.path);
          if (!(current instanceof TFile)) throw new Error("原笔记在改名期间已移动或删除");
          await this.app.fileManager.renameFile(current, desiredPath);
          finalPath = desiredPath;
        });
      }
      const persisted = await this.app.vault.adapter.read(finalPath);
      const encoded = new TextEncoder().encode(persisted);
      const files = [{ path: finalPath, contentHash: await sha256Hex(encoded), byteSize: encoded.byteLength }];
      for (const { asset, targetPath } of localAssets) {
        files.push({ path: targetPath, contentHash: await sha256Hex(new Uint8Array(asset.body)), byteSize: asset.body.length });
      }
      return { notePath: finalPath, files };
    } catch (error) {
      for (const file of createdAssets) {
        await removeBinaryAssetIfUnchanged(this.app, file.path, file.body, file.mtime).catch(() => false);
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
    const taskIdentityCandidates: Array<ArticleCandidate & { file: TFile; generation: number }> = [];
    if (taskId) {
      for (const file of this.app.vault.getMarkdownFiles()) {
        const root = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
        if (root && file.path !== root && !file.path.startsWith(`${root}/`)) continue;
        const generation = this.vaultSyncIndex.getGeneration(file.path);
        const content = await this.app.vault.cachedRead(file);
        const candidate = articleCandidate(file.path, content);
        if (candidate.taskId === taskId) taskIdentityCandidates.push({ ...candidate, file, generation });
      }
    }
    if (taskIdentityCandidates.length > 1) throw new Error("同一任务已有多个本地版本，请先在 Vault 中处理重复文章");
    if (taskIdentityCandidates.length === 1) {
      const existing = taskIdentityCandidates[0];
      const files = await captureHandoffFilesForExistingTask(
        existing.path,
        assetPlans.flatMap((plan) => plan.targetPath ? [plan.targetPath] : []),
        async (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) return null;
          return new Uint8Array(await this.app.vault.readBinary(file));
        },
      );
      try { await this.app.workspace.getLeaf(false).openFile(existing.file); } catch { /* best effort */ }
      return {
        notePath: existing.path,
        files,
      };
    }

    const sourceKey = normalizeArticleSourceUrl(task.manifest.sourceUrl);
    const candidates: Array<ArticleCandidate & { file: TFile; generation: number }> = [];
    if (!isCreateNewZip && sourceKey) {
      const root = normalizePath(this.settings.rootFolder).replace(/\/$/, "");
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (root && file.path !== root && !file.path.startsWith(`${root}/`)) continue;
        const generation = this.vaultSyncIndex.getGeneration(file.path);
        const content = await this.app.vault.cachedRead(file);
        const candidate = articleCandidate(file.path, content);
        if (candidate.sourceKey === sourceKey) candidates.push({ ...candidate, file, generation });
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
        const generation = this.vaultSyncIndex.getGeneration(legacyFile.path);
        const content = await this.app.vault.cachedRead(legacyFile);
        const candidate = articleCandidate(legacyFile.path, content);
        if (isLegacyArticleCandidate(candidate, expectedPath)) candidates.push({ ...candidate, file: legacyFile, generation });
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
    let exactCandidate: (ArticleCandidate & { file: TFile; generation: number }) | undefined;
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
    const assetsCreatedByThisAttempt: Array<{ path: string; body: Uint8Array; mtime: number | null }> = [];
    let persistedMarkdown = "";
    try {
      if (localAssetPlans.length) await ensureFolder(this, taskAttachmentFolder);
      for (const { asset, filename, targetPath } of localAssetPlans) {
        const body = new Uint8Array(asset.body);
        const write = await writeBinaryAssetSafely(this.app, targetPath, body);
        if (write.created) assetsCreatedByThisAttempt.push({ path: targetPath, body, mtime: write.mtime });
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
        await writeTextAtomically(this.app, existing.path, merged, existing.content, {
          expectedGeneration: existing.generation,
          getPathGeneration: (path) => this.vaultSyncIndex.getGeneration(path),
        });
        createdNote = existing.file;
        persistedMarkdown = merged;
      } else {
        const notePath = await uniqueNotePath(this, noteFolder, layout.noteFilename);
        createdNote = await withVaultPathWriteLock(notePath, async () => {
          if (this.app.vault.getAbstractFileByPath(notePath)) {
            throw Object.assign(new Error("目标笔记在创建期间已被占用，已保留现有文件"), { code: "vault_write_path_collision" });
          }
          return await this.app.vault.create(notePath, markdown);
        });
        noteCreatedByThisAttempt = true;
        persistedMarkdown = await this.app.vault.adapter.read(createdNote.path);
      }
      if (persistedMarkdown !== markdown) {
        if (!existing) throw new Error("本地 Markdown 写入校验失败");
      }
    } catch (error) {
      if (createdNote && noteCreatedByThisAttempt) {
        await withVaultPathWriteLock(createdNote.path, async () => {
          const current = this.app.vault.getAbstractFileByPath(createdNote!.path);
          if (!(current instanceof TFile)) return;
          const currentBody = await this.app.vault.adapter.read(createdNote!.path).catch(() => null);
          if (currentBody === markdown) await this.app.fileManager.trashFile(current);
        });
      }
      for (const file of assetsCreatedByThisAttempt) {
        await removeBinaryAssetIfUnchanged(this.app, file.path, file.body, file.mtime).catch(() => false);
      }
      throw error;
    }

    let finalPath = createdNote.path;
    if (existing) {
      const desiredPath = normalizePath(`${noteFolder}/${layout.noteFilename}`);
      if (desiredPath !== existing.path) {
        await withVaultPathWriteLocks([existing.path, desiredPath], async () => {
          if (await this.app.vault.adapter.exists(desiredPath)) return;
          const current = this.app.vault.getAbstractFileByPath(existing.path);
          if (!(current instanceof TFile)) throw new Error("原笔记在改名期间已移动或删除");
          await this.app.fileManager.renameFile(current, desiredPath);
          finalPath = desiredPath;
          createdNote = this.app.vault.getAbstractFileByPath(desiredPath) as TFile;
        });
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
            try {
              await this.plugin.resolveVaultConflict(path);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new Notice(`无法保存冲突处理状态：${message}`, 12000);
              return;
            }
            record.status = "resolved";
            button.setDisabled(true).setButtonText("已处理");
          }));
      } else {
        setting.addButton((button) => button.setButtonText("已处理").setDisabled(true));
      }
    }
  }
}

interface VaultSyncV2ConflictPreview {
  path: string;
  base: string;
  local: string;
  remote: string;
  canChooseRemote: boolean;
  canSubmitLocal?: boolean;
  canEditMerge?: boolean;
  remoteChoiceBlockedByActiveEditor?: boolean;
  localHash?: string;
}

class VaultSyncNeedsRebaseModal extends Modal {
  constructor(app: App, private items: ReturnType<typeof summarizeVaultSyncNeedsRebase>) { super(app); }

  onOpen() {
    this.titleEl.setText(`本机需重基记录（${this.items.length}）`);
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "这些是本机保留的旧 outbox 请求，已停止自动重试，只供核对；不会阻塞其他独立笔记同步，也不是远端 inbox 冲突。此窗口只读，不会重放或清理记录。路径来自旧请求或最近的本机基线，可能不是当前路径。",
    });
    for (const item of this.items) {
      new Setting(this.contentEl)
        .setName(item.location)
        .setDesc(`${item.action} · 原因：${item.reason} · 操作 ${item.operationId.slice(0, 8)}… · 文件 ${item.fileId.slice(0, 8)}…`);
    }
  }

  onClose() { this.contentEl.empty(); }
}

class VaultSyncV2OfflineConflictSnapshotModal extends Modal {
  constructor(app: App, private snapshot: VaultSyncOutboxSnapshot) { super(app); }

  onOpen() {
    this.titleEl.setText("Vault 同步冲突中心（本机快照）");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "当前无法确认云端最新状态。以下内容来自本机已校验快照，仅供查看，可能不是云端最新状态；连接恢复后请重新同步并刷新冲突中心，再处理任何项目。",
      cls: "wetongbu-sync-offline-warning",
    });
    this.contentEl.createEl("p", {
      text: `本机快照 · 协议 epoch ${this.snapshot.identity.protocolEpoch} · 已接收游标 ${this.snapshot.receivedCursor} · 已应用游标 ${this.snapshot.appliedCursor}`,
    });

    const pending = this.snapshot.inbox.filter((entry) => entry.state === "needs_resolution");
    const outbound = this.snapshot.operations.filter((operation) => operation.state === "conflict");
    if (!pending.length && !outbound.length) {
      this.contentEl.createEl("p", { text: "最近一次有效本机快照中没有待处理冲突；这不能代表云端当前也没有冲突。" });
      return;
    }
    if (outbound.length) {
      this.contentEl.createEl("h3", { text: `本机提交冲突（${outbound.length}）` });
      for (const operation of outbound) {
        const operationType = String(operation.request.operation.type ?? "unknown");
        new Setting(this.contentEl)
          .setName(`本机提交 ${operation.operationId.slice(0, 8)}…`)
          .setDesc(`${operationType} · file ${operation.fileId.slice(0, 8)}… · 本机内容 ${operation.localContentHash.slice(0, 12)}…`);
      }
    }
    if (pending.length) {
      this.contentEl.createEl("h3", { text: `待处理的远端变更（${pending.length}）` });
      const eventLabel: Record<string, string> = {
        create: "远端新增", update: "远端修改", delete: "远端删除", restore: "远端恢复", rename: "远端改名",
      };
      for (const entry of pending) {
        new Setting(this.contentEl)
          .setName(entry.item.path)
          .setDesc(`${eventLabel[entry.item.eventType] ?? entry.item.eventType} · 变更 ${entry.cursor} · 来源设备 ${entry.item.createdByDeviceId.slice(0, 8)}…`);
      }
    }
  }

  onClose() { this.contentEl.empty(); }
}

class VaultSyncV2ConflictCenterModal extends Modal {
  private resolvedRemoteDeleteCursors = new Set<string>();
  private remoteDeleteProgressEl: HTMLParagraphElement | null = null;

  constructor(
    app: App,
    private entries: VaultSyncInboxEntry[],
    private outboundConflicts: VaultSyncOutboxOperation[],
    private largeOrBinaryUpdateConflictCursors: Set<string>,
    private keepLocalRemoteUpdateCursors: Set<string>,
    private renameConflictCursors: Set<string>,
    private createConflictCursors: Set<string>,
    private deleteConflictCursors: Set<string>,
    private preview: (entry: VaultSyncInboxEntry) => Promise<VaultSyncV2ConflictPreview>,
    private previewOutboundRebase: (operation: VaultSyncOutboxOperation) => Promise<{
      preview: VaultSyncV2ConflictPreview;
      expectedVersionId: string;
    }>,
    private repathOutboundCreate: ((operation: VaultSyncOutboxOperation) => Promise<void>) | undefined,
    private rebaseOutbound: ((operation: VaultSyncOutboxOperation, expectedVersionId: string) => Promise<void>) | undefined,
    private cancelOutboundDelete: ((operation: VaultSyncOutboxOperation) => Promise<void>) | undefined,
    private keepLocalAndPush: ((entry: VaultSyncInboxEntry, expectedLocalHash?: string,
      mergeDraft?: { expectedPreviewText: string; text: string }) => Promise<void>) | undefined,
    private resolve: (entry: VaultSyncInboxEntry) => Promise<void>,
    private refresh: () => Promise<void>,
    private allowEncryptedSize: boolean,
    private currentDeviceId: string,
    private renameTargetIdentityByCursor: ReadonlyMap<string, RemoteRenameTargetIdentity>,
  ) { super(app); }

  private dismissForActiveEditorBusy(error: unknown): boolean {
    return dismissConflictActionForActiveEditorBusy(error, {
      notify: (message, durationMs) => { new Notice(message, durationMs); },
      close: () => this.close(),
    });
  }

  onOpen() {
    this.titleEl.setText("Vault 同步冲突中心");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "远端冲突会保留在本地 inbox，直到明确查看或处理。普通更新在采用远端前会另存本机副本；改名冲突可以在检查云端最新版本后重新确认本机路径。" });
    if (this.deleteConflictCursors.size) {
      this.remoteDeleteProgressEl = this.contentEl.createEl("p", {
        text: `有 ${this.deleteConflictCursors.size} 项发送端已确认的远端删除因本机内容需要保护而待处理。这里无需再次授权删除；逐项处理会先把本机文件保存为冲突副本，再应用已确认的删除。成功项留在本窗口标记为已处理，方便继续核对其他条目。`,
      });
    }
    if (this.outboundConflicts.length) {
      this.contentEl.createEl("p", { text: `本机有 ${this.outboundConflicts.length} 项提交遇到云端 CAS 冲突，原操作仍保存在 outbox。update 冲突可对比三方内容并重基；delete 冲突可检查后重新确认；rename 冲突会先验证云端正文未变，再保留本机改名。` });
      for (const operation of this.outboundConflicts) {
        const operationType = String(operation.request.operation.type ?? "unknown");
        const setting = new Setting(this.contentEl)
          .setName(`本机提交 ${operation.operationId.slice(0, 8)}…`)
          .setDesc(`${operationType} · file ${operation.fileId.slice(0, 8)}… · 本机正文 ${operation.localContentHash.slice(0, 12)}…`);
        const hasRelatedRemoteChange = this.entries.some((entry) => entry.item.fileId === operation.fileId
          || (operation.request.operation.type === "create" && operation.request.operation.path === entry.item.path));
        if (!hasRelatedRemoteChange) {
          setting.setDesc(`${operationType} · file ${operation.fileId.slice(0, 8)}… · 本机正文 ${operation.localContentHash.slice(0, 12)}… · 等待对应云端变更`);
        }
        if (this.rebaseOutbound && (operationType === "update" || operationType === "delete" || operationType === "rename")) {
          const buttonLabel = operationType === "delete" ? "查看云端版本并重新确认删除"
            : operationType === "rename" ? "检查云端版本并重新确认改名" : "对比并重基";
          setting.addButton((button) => button.setButtonText(buttonLabel).onClick(async () => {
            button.setDisabled(true).setButtonText("读取冲突内容…");
            try {
              const result = await this.previewOutboundRebase(operation);
              new VaultSyncV2ConflictDetailModal(this.app, result.preview, undefined, {
                label: operationType === "delete" ? "确认删除当前云端版本"
                  : operationType === "rename" ? "保留本机路径并重提改名" : "以云端版本为基准重新提交本机内容",
                description: operationType === "delete"
                  ? "这会删除刚才预览的云端当前版本。提交前会再次核对 head，并确认本机路径仍为空；任何变化都会保留待办。"
                  : operationType === "rename"
                    ? "仅在云端正文与已验证基线一致时，按最新云端路径和版本重新提交改名；若正文也变化则保留冲突待办。"
                    : "将保留本机正文，并以刚才预览的云端版本作为 CAS 基线。提交前会再次核对云端 head 和本机内容；期间有新修改时会保留待办。",
                run: async () => {
                  await this.rebaseOutbound!(operation, result.expectedVersionId);
                  this.close();
                },
              }, undefined, undefined, () => this.close()).open();
            } catch (error) {
              if (this.dismissForActiveEditorBusy(error)) return;
              new Notice(`读取本机冲突预览失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            } finally {
              button.setDisabled(false).setButtonText(buttonLabel);
            }
          }));
        }
        if (this.cancelOutboundDelete && operationType === "delete") {
          setting.addButton((button) => button.setButtonText("本机文件已恢复，撤销删除意图").onClick(async () => {
            button.setDisabled(true).setButtonText("处理中…");
            try {
              await this.cancelOutboundDelete!(operation);
              this.close();
            } catch (error) {
              if (this.dismissForActiveEditorBusy(error)) return;
              new Notice(`撤销删除失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              button.setDisabled(false).setButtonText("本机文件已恢复，撤销删除意图");
            }
          }));
        }
        if (this.repathOutboundCreate && operationType === "create" && !hasRelatedRemoteChange) {
          setting.addButton((button) => button.setButtonText("保留本机文件并换路径重提").onClick(async () => {
            button.setDisabled(true).setButtonText("正在保留并重提…");
            try {
              await this.repathOutboundCreate!(operation);
              this.close();
            } catch (error) {
              if (this.dismissForActiveEditorBusy(error)) return;
              new Notice(`本机 create 冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              button.setDisabled(false).setButtonText("保留本机文件并换路径重提");
            }
          }));
        }
      }
      const refresh = this.contentEl.createEl("button", { text: "同步并查找对应云端变更" });
      refresh.addEventListener("click", () => {
        if (refresh.disabled) return;
        refresh.disabled = true;
        refresh.setText("同步中…");
        this.close();
        void this.refresh().catch((error) => {
          new Notice(`同步最新冲突状态失败：${error instanceof Error ? error.message : String(error)}`, 10000);
        });
      });
    }
    if (!this.entries.length) {
      this.contentEl.createEl("p", { text: "当前没有待处理的远端变更；上方显示的本机提交冲突仍保留在 outbox。" });
      return;
    }
    for (const entry of this.entries) {
      const item = entry.item;
      const eventLabel: Record<string, string> = {
        create: "远端新增", update: "远端修改", delete: "远端删除", restore: "远端恢复", rename: "远端改名",
      };
      const setting = new Setting(this.contentEl)
        .setName(item.path)
        .setDesc(`${eventLabel[item.eventType] ?? item.eventType} · 变更 ${entry.cursor} · 来源设备 ${item.createdByDeviceId.slice(0, 8)}…${this.outboundConflicts.some((operation) => operation.fileId === item.fileId
          || (operation.request.operation.type === "create" && operation.request.operation.path === item.path)) ? " · 对应本机 CAS 提交冲突" : ""}`);
      if (item.eventType !== "rename" && !item.isDeleted && item.content?.kind === "object" && item.path.toLowerCase().endsWith(".md")
        && isVaultSyncContentWithinPlaintextLimit(item.byteSize, item.content, HISTORY_PREVIEW_MAX_BYTES,
          this.allowEncryptedSize)) {
        setting.addButton((button) => button.setButtonText("查看三方内容").onClick(async () => {
          button.setDisabled(true).setButtonText("读取中…");
          try {
            const preview = await this.preview(entry);
            const keepLocal = this.keepLocalAndPush && this.keepLocalRemoteUpdateCursors.has(entry.cursor)
              && preview.canSubmitLocal !== false && !preview.remoteChoiceBlockedByActiveEditor
              ? {
                description: "只将下方本机预览原样提交为云端新版本，不会把云端正文合进来；冲突云端版本会留在历史中。要合并两边内容，请使用下方“编辑合并正文”。",
                run: () => this.keepLocalAndPush!(entry, preview.localHash),
              }
              : undefined;
            const mergeAndPush = this.keepLocalAndPush && this.keepLocalRemoteUpdateCursors.has(entry.cursor)
              && preview.canEditMerge !== false && !preview.remoteChoiceBlockedByActiveEditor
              ? {
                description: "编辑完整正文并确认同时保留双方需要的内容。提交会先按本机预览原文安全写入，再基于本次冲突版本提交；若云端提交未确认，合并稿仍保留在本机。",
                initialContent: preview.local,
                run: (text: string) => this.keepLocalAndPush!(entry, undefined, {
                  expectedPreviewText: preview.local,
                  text,
                }),
              }
              : undefined;
            new VaultSyncV2ConflictDetailModal(this.app, preview, async () => {
              await this.resolve(entry);
              this.close();
            }, undefined, keepLocal, mergeAndPush, () => this.close()).open();
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`读取冲突版本失败：${error instanceof Error ? error.message : String(error)}`, 10000);
          } finally {
            button.setDisabled(false).setButtonText("查看三方内容");
          }
        }));
      } else if (this.keepLocalRemoteUpdateCursors.has(entry.cursor)
        || this.largeOrBinaryUpdateConflictCursors.has(entry.cursor)) {
        const remoteTooLarge = !item.content || !isVaultSyncContentWithinPlaintextLimit(
          item.byteSize, item.content, VAULT_SYNC_SINGLE_OBJECT_MAX_BYTES, this.allowEncryptedSize,
        );
        setting.setDesc(`${eventLabel[item.eventType] ?? item.eventType} · 变更 ${entry.cursor} · 来源设备 ${item.createdByDeviceId.slice(0, 8)}… · ${remoteTooLarge
          ? "云端对象超过 24 MiB，本机不会下载覆盖"
          : "该对象为二进制内容或超过 2 MiB 预览范围"}；按本机当前内容重提，或在支持范围内保留本机副本后采用云端版本。`);
        if (this.keepLocalRemoteUpdateCursors.has(entry.cursor)) {
          setting.addButton((button) => button.setButtonText("保留本机内容并提交为新版本").onClick(async () => {
            button.setDisabled(true).setButtonText("处理中…");
            try {
              if (!this.keepLocalAndPush) throw new Error("当前设备没有可用的云端写入权限");
              await this.keepLocalAndPush(entry);
              this.close();
            } catch (error) {
              if (this.dismissForActiveEditorBusy(error)) return;
              new Notice(`本机版本重提未完成：${error instanceof Error ? error.message : String(error)}`, 10000);
              button.setDisabled(false).setButtonText("保留本机内容并提交为新版本");
            }
          }));
        }
        if (this.largeOrBinaryUpdateConflictCursors.has(entry.cursor)) {
          setting.addButton((button) => button.setButtonText("保留本机副本并采用云端").onClick(async () => {
            button.setDisabled(true).setButtonText("处理中…");
            try {
              await this.resolve(entry);
              this.close();
            } catch (error) {
              if (this.dismissForActiveEditorBusy(error)) return;
              new Notice(`冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              button.setDisabled(false).setButtonText("保留本机副本并采用云端");
            }
          }));
        }
      } else {
        const renameDescription = item.eventType === "rename" && item.previousPath ? ` · ${item.previousPath} → ${item.path}` : "";
        const renameTarget = item.eventType === "rename" && item.previousPath
          ? this.app.vault.getAbstractFileByPath(item.path)
          : null;
        const renameHint = describeRemoteRenameConflictHint(item,
          !!renameTarget && renameTarget.path !== item.previousPath,
          item.createdByDeviceId.toLowerCase() === this.currentDeviceId.toLowerCase(),
          this.renameTargetIdentityByCursor.get(entry.cursor) ?? "unknown");
        setting.setDesc(`${eventLabel[item.eventType] ?? item.eventType} · 变更 ${entry.cursor} · 来源设备 ${item.createdByDeviceId.slice(0, 8)}… · ${renameHint ?? "该类型暂不支持三方预览或自动处理"}${renameDescription}`);
      }
      if (this.renameConflictCursors.has(entry.cursor)) {
        setting.addButton((button) => button.setButtonText("保留本机文件并采用云端改名").onClick(async () => {
          button.setDisabled(true).setButtonText("处理中…");
          try {
            await this.resolve(entry);
            this.close();
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`改名冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            button.setDisabled(false).setButtonText("保留本机文件并采用云端改名");
          }
        }));
      }
      if (this.createConflictCursors.has(entry.cursor)) {
        setting.addButton((button) => button.setButtonText("保留本机副本并采用云端新增").onClick(async () => {
          button.setDisabled(true).setButtonText("处理中…");
          try {
            await this.resolve(entry);
            this.close();
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`新增文件冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            button.setDisabled(false).setButtonText("保留本机副本并采用云端新增");
          }
        }));
      }
      if (this.deleteConflictCursors.has(entry.cursor)) {
        setting.addButton((button) => button.setButtonText("保留本机副本并应用已确认删除").onClick(async () => {
          button.setDisabled(true).setButtonText("处理中…");
          try {
            await this.resolve(entry);
            this.resolvedRemoteDeleteCursors.add(entry.cursor);
            button.setButtonText("已处理");
            setting.setDesc(`远端删除 · 变更 ${entry.cursor} · 已处理；本机副本已保留，发送端已确认的删除已应用。`);
            this.remoteDeleteProgressEl?.setText(
              `已处理 ${this.resolvedRemoteDeleteCursors.size}/${this.deleteConflictCursors.size} 项可安全处理的远端删除；其他条目仍保留在本窗口。`,
            );
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`删除冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            button.setDisabled(false).setButtonText("保留本机副本并应用已确认删除");
          }
        }));
      }
    }
    if (this.entries.length && !this.outboundConflicts.length) {
      const refresh = this.contentEl.createEl("button", { text: "同步并刷新冲突状态" });
      refresh.addEventListener("click", () => {
        if (refresh.disabled) return;
        refresh.disabled = true;
        refresh.setText("同步中…");
        this.close();
        void this.refresh().catch((error) => {
          new Notice(`同步最新冲突状态失败：${error instanceof Error ? error.message : String(error)}`, 10000);
        });
      });
    }
  }
}

class VaultSyncV2ConflictDetailModal extends Modal {
  constructor(
    app: App,
    private preview: VaultSyncV2ConflictPreview,
    private resolve?: () => Promise<void>,
    private rebase?: { label: string; description: string; run: () => Promise<void> },
    private keepLocal?: { description: string; run: () => Promise<void> },
    private mergeAndPush?: { description: string; initialContent: string; run: (text: string) => Promise<void> },
    private onEditorBusy?: () => void,
  ) { super(app); }

  private dismissForActiveEditorBusy(error: unknown): boolean {
    return dismissConflictActionForActiveEditorBusy(error, {
      notify: (message, durationMs) => { new Notice(message, durationMs); },
      close: () => this.close(),
      afterClose: () => this.onEditorBusy?.(),
    });
  }

  onOpen() {
    this.titleEl.setText("同步冲突 · 三方内容");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `${this.preview.path} · 内容均在本机解密` });
    for (const [label, text] of [["共同基线", this.preview.base], ["本机内容", this.preview.local], ["云端内容", this.preview.remote]]) {
      const section = this.contentEl.createEl("details", { attr: { open: true } });
      section.createEl("summary", { text: label });
      section.createEl("pre", { text }).setCssStyles({
        maxHeight: "24vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      });
    }
    if (this.preview.remoteChoiceBlockedByActiveEditor) {
      this.contentEl.createEl("p", { text: "目标笔记仍在编辑器中打开，当前暂停改写原路径和提交本机版本。请关闭这篇笔记，重新打开冲突中心并核对最新三方内容后再处理。" });
    }
    if (this.preview.canChooseRemote && this.resolve) {
      new Setting(this.contentEl)
        .setName("保留双方")
        .setDesc("原路径将采用云端正文；本机正文和其中的本机链接会另存为同目录冲突副本，处理成功后会显示副本路径。云端 ACK 仅在本地写入和基线保存成功后推进。")
        .addButton((button) => button.setButtonText("保留本地副本并采用云端").setCta().onClick(async () => {
          button.setDisabled(true).setButtonText("处理中…");
          try {
            await this.resolve!();
            this.close();
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`冲突处理失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            button.setDisabled(false).setButtonText("保留本地副本并采用云端");
          }
        }));
    }
    if (this.rebase) {
      new Setting(this.contentEl)
        .setName("保留本机并重新提交")
        .setDesc(this.rebase.description)
        .addButton((button) => button.setButtonText(this.rebase!.label).setCta().onClick(async () => {
          button.setDisabled(true).setButtonText("正在重新提交…");
          try {
            await this.rebase!.run();
            this.close();
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`冲突重基失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            button.setDisabled(false).setButtonText(this.rebase!.label);
          }
        }));
    }
    if (this.keepLocal) {
      new Setting(this.contentEl)
        .setName("只提交本机预览")
        .setDesc(this.keepLocal.description)
        .addButton((button) => button.setButtonText("仅提交本机预览到云端").setCta().onClick(async () => {
          button.setDisabled(true).setButtonText("正在提交…");
          try {
            await this.keepLocal!.run();
            this.close();
          } catch (error) {
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`本机版本重提未完成：${error instanceof Error ? error.message : String(error)}`, 10000);
            button.setDisabled(false).setButtonText("仅提交本机预览到云端");
          }
        }));
    }
    if (this.mergeAndPush) {
      new Setting(this.contentEl)
        .setName("编辑合并正文")
        .setDesc(this.mergeAndPush.description);
      const editor = this.contentEl.createEl("textarea");
      editor.value = this.mergeAndPush.initialContent.startsWith("\uFEFF")
        ? this.mergeAndPush.initialContent.slice(1)
        : this.mergeAndPush.initialContent;
      editor.rows = 12;
      editor.spellcheck = false;
      editor.setCssStyles({
        display: "block", width: "100%", minHeight: "12em", resize: "vertical",
        fontFamily: "var(--font-monospace)", whiteSpace: "pre", overflow: "auto",
      });
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText("提交这份合并正文").setCta().onClick(async () => {
          button.setDisabled(true).setButtonText("正在保存并提交…");
          editor.disabled = true;
          try {
            await this.mergeAndPush!.run(restoreConflictEditorTextFormat(editor.value, this.mergeAndPush!.initialContent));
            this.close();
          } catch (error) {
            const draftSaved = Boolean((error as any)?.localDraftSaved);
            if (this.dismissForActiveEditorBusy(error)) return;
            new Notice(`合并正文提交未完成：${error instanceof Error ? error.message : String(error)}`, 12000);
            if (draftSaved) {
              button.setButtonText("本机合并稿已保存，请刷新预览");
            } else {
              button.setDisabled(false).setButtonText("提交这份合并正文");
              editor.disabled = false;
            }
          }
        }));
    }
  }
}

class VaultSyncV2DeletedHistoryModal extends Modal {
  constructor(
    app: App,
    private entries: Array<{ fileId: string; path: string }>,
    private select: (entry: { fileId: string; path: string }) => void,
  ) { super(app); }

  onOpen() {
    this.titleEl.setText("已删除文件历史");
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "选择一个有已验证云端删除检查点的文件。恢复会从历史正文创建新路径，原路径不会被覆盖。",
    });
    for (const entry of this.entries) {
      new Setting(this.contentEl)
        .setName(entry.path)
        .setDesc(`云端当前 head 为删除检查点 · file ${entry.fileId.slice(0, 8)}…`)
        .addButton((button) => button.setButtonText("查看历史").onClick(() => {
          this.close();
          this.select(entry);
        }));
    }
  }
}

class VaultSyncV2HistoryModal extends Modal {
  private items: VaultSyncV2FileVersion[];
  private hasMore: boolean;
  private nextCursor: string | null;
  private loading = false;

  constructor(
    app: App,
    private filePath: string,
    page: VaultSyncV2FileVersionsPage,
    private readPage: (beforeVersionNumber: string) => Promise<VaultSyncV2FileVersionsPage>,
    private preview: (version: VaultSyncV2FileVersion) => Promise<string>,
    private restore?: (version: VaultSyncV2FileVersion) => Promise<void>,
    private deletedHead = false,
  ) {
    super(app);
    this.items = [...page.items];
    this.hasMore = page.hasMore;
    this.nextCursor = page.nextBeforeVersionNumber;
  }

  onOpen() { this.render(); }

  private render() {
    this.titleEl.setText("云端历史版本");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.restore
      ? this.deletedHead
        ? `${this.filePath} · 已删除文件恢复优先使用原路径；路径被占用时生成新路径，不覆盖本地文件`
        : `${this.filePath} · 恢复会生成新路径和新版本，并保留当前本地文件`
      : `${this.filePath} · 历史记录只读预览；当前账号或服务端尚未开放恢复写入` });
    if (!this.items.length) {
      this.contentEl.createEl("p", { text: "当前文件没有可显示的历史检查点。" });
      return;
    }
    for (const version of this.items) {
      const date = new Date(version.createdAt).toLocaleString();
      const state = version.isDeleted ? "删除检查点"
        : version.contentStatus === "object_referenced" && version.byteSize > HISTORY_RESTORE_MAX_BYTES ? "超过 24 MiB 恢复上限"
          : version.contentStatus === "object_referenced" && !version.path.toLowerCase().endsWith(".md") ? "附件可恢复"
            : version.contentStatus === "object_referenced" && version.byteSize > HISTORY_PREVIEW_MAX_BYTES ? "可恢复，不提供预览"
              : version.contentStatus === "object_referenced" ? "可预览并恢复"
          : version.contentStatus === "pruned" ? "正文已按留存策略清理"
          : version.contentStatus === "legacy_unverified" ? "旧版正文未验证"
            : "正文暂不可用";
      const setting = new Setting(this.contentEl)
        .setName(`版本 ${version.versionNumber}${version.isCurrent ? " · 当前版本" : ""}`)
        .setDesc(`${date} · ${version.path} · ${state} · ${version.byteSize} bytes`);
      if (!version.isDeleted && version.contentStatus === "object_referenced" && version.contentObjectId) {
        if (canPreviewHistoryVersion(version)) {
          setting.addButton((button) => button.setButtonText("预览").onClick(async () => {
            button.setDisabled(true).setButtonText("读取中…");
            try {
              const content = await this.preview(version);
              new VaultSyncV2HistoryPreviewModal(this.app, version, content).open();
            } catch (error) {
              new Notice(`历史预览失败：${formatVaultSyncHistoryError(error)}`, 8000);
            } finally {
              button.setDisabled(false).setButtonText("预览");
            }
          }));
        }
        if (this.restore && canRestoreHistoryVersion(version)) {
          const restoreLabel = this.deletedHead ? "恢复版本" : "恢复为新路径";
          setting.addButton((button) => button.setButtonText(restoreLabel).onClick(async () => {
            button.setDisabled(true).setButtonText("恢复中…");
            try {
              await this.restore!(version);
            } catch (error) {
              new Notice(`历史恢复失败：${formatVaultSyncHistoryError(error)}`, 10000);
            } finally {
              button.setDisabled(false).setButtonText(restoreLabel);
            }
          }));
        }
      }
    }
    if (this.hasMore && this.nextCursor) {
      const button = this.contentEl.createEl("button", { text: this.loading ? "读取中…" : "更早版本" });
      button.disabled = this.loading;
      button.addEventListener("click", () => { void this.loadMore(button); });
    }
  }

  private async loadMore(button: HTMLButtonElement) {
    if (this.loading || !this.nextCursor) return;
    this.loading = true;
    button.disabled = true;
    button.setText("读取中…");
    try {
      const page = await this.readPage(this.nextCursor);
      const known = new Set(this.items.map((item) => item.versionId));
      this.items.push(...page.items.filter((item) => !known.has(item.versionId)));
      this.hasMore = page.hasMore;
      this.nextCursor = page.nextBeforeVersionNumber;
    } catch (error) {
      new Notice(`读取更早版本失败：${formatVaultSyncHistoryError(error)}`, 8000);
    } finally {
      this.loading = false;
      this.render();
    }
  }
}

class VaultSyncV2HistoryPreviewModal extends Modal {
  constructor(app: App, private version: VaultSyncV2FileVersion, private content: string) { super(app); }

  onOpen() {
    this.titleEl.setText(`历史预览 · 版本 ${this.version.versionNumber}`);
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: `${this.version.path} · ${new Date(this.version.createdAt).toLocaleString()} · 只读预览`,
    });
    this.contentEl.createEl("pre", { text: this.content }).setCssStyles({
      maxHeight: "65vh", overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
    });
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

class VaultSyncV2DeletionReviewModal extends Modal {
  private confirming = false;
  private handledCount = 0;
  private readonly lifetime = new DeletionReviewModalLifetime();

  constructor(
    app: App,
    private items: VaultSyncV2PendingDeletion[],
    private confirm: (item: VaultSyncV2PendingDeletion) => Promise<VaultSyncV2PendingDeletion[]>,
    private onDismiss: () => void,
  ) { super(app); }

  onOpen() {
    this.titleEl.setText("确认同步删除");
    this.renderPendingItems();
  }

  private renderPendingItems() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "这些文件在本机已不存在，但云端仍有当前版本。微同步不会自动删除云端文件；逐项确认后才会提交 tombstone。若云端版本在确认前变化，操作会进入冲突中心，不会覆盖新版本。",
    });
    contentEl.createEl("p", {
      text: this.handledCount > 0
        ? `已处理 ${this.handledCount} 项，剩余 ${this.items.length} 项。完成前，此窗口会保持打开。`
        : `共 ${this.items.length} 项待确认；逐项处理时会留在此窗口。`,
      cls: "setting-item-description",
      attr: { role: "status" },
    });
    const confirmButtons: HTMLButtonElement[] = [];
    for (const item of this.items) {
      new Setting(contentEl)
        .setName(item.path)
        .setDesc(`云端版本 ${item.expectedVersionId.slice(0, 8)}… · ${item.byteSize} bytes${item.pendingOperationCount
          ? ` · 另有 ${item.pendingOperationCount} 条未完成的本机提交；确认后若云端删除成功，这些提交会一并取消。若云端版本已变化，提交会进入冲突处理。`
          : ""}`)
        .addButton((button) => {
          confirmButtons.push(button.buttonEl);
          button.setButtonText("确认删除云端版本").setWarning().onClick(async () => {
            if (this.confirming) return;
            this.confirming = true;
            for (const confirmButton of confirmButtons) confirmButton.disabled = true;
            button.setButtonText("提交中…");
            await this.lifetime.settle(async () => {
              const previousCount = this.items.length;
              const nextItems = await this.confirm(item);
              return { previousCount, nextItems };
            }, ({ previousCount, nextItems }) => {
              this.items = nextItems;
              this.handledCount += Math.max(0, previousCount - this.items.length);
              this.confirming = false;
              if (shouldCloseDeletionReviewModal(this.items)) this.close();
              else this.renderPendingItems();
            }, (error) => {
              this.confirming = false;
              for (const confirmButton of confirmButtons) confirmButton.disabled = false;
              button.setButtonText("确认删除云端版本");
              new Notice(`删除确认失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              if (shouldDismissDeletionReviewOnError(error)) this.close();
            });
          });
        });
    }
    new Setting(contentEl).addButton((button) => button
      .setButtonText("暂不处理")
      .onClick(() => this.close()));
  }

  onClose() {
    this.lifetime.close();
    this.contentEl.empty();
    this.onDismiss();
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
      const reason = describeDeletionReviewDirection(item.direction);
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

class VaultFolderPickerModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private folders: TFolder[],
    private onChoosePath: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder("搜索 Vault 文件夹");
    this.emptyStateText = "当前 Vault 没有可选择的文件夹";
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoosePath(folder.path);
  }
}

class WeTongbuSettingTab extends PluginSettingTab {
  private accessKeyInput: string | null = null;
  private secretKeyInput: string | null = null;
  private recoveryTokenInput = "";
  private vaultPairingCodeInput = "";
  private captureHandoffSetting: Setting | null = null;
  private captureHandoffRenderGeneration = 0;

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

  private async setMicroSyncFolderFromPicker(rawPath: string) {
    const path = normalizeVaultPath(rawPath);
    if (!path) {
      new Notice("所选文件夹路径无效，微同步目录未更改", 8000);
      return;
    }
    const previousPath = this.plugin.settings.rootFolder;
    if (normalizeVaultPath(previousPath) === path) {
      new Notice(`微同步目录已经是“${path}”`, 6000);
      return;
    }

    this.plugin.settings.rootFolder = path;
    try {
      await this.plugin.saveSettings();
    } catch (error) {
      this.plugin.settings.rootFolder = previousPath;
      new Notice(`保存微同步目录失败：${error instanceof Error ? error.message : String(error)}`, 10000);
      return;
    }

    new Notice(
      `微同步目录已设为“${path}”。请在其他设备也设置相同路径；此操作不会自动更改同步范围。`,
      10000,
    );
    this.displayPreservingScroll();
  }

  refreshFromPlugin() {
    this.displayPreservingScroll();
  }

  refreshCaptureHandoffStatus() {
    const setting = this.captureHandoffSetting;
    if (!setting) return;
    const generation = ++this.captureHandoffRenderGeneration;
    void this.plugin.getCaptureHandoffStatusSummary().then((summary) => {
      if (generation === this.captureHandoffRenderGeneration && setting === this.captureHandoffSetting) setting.setDesc(summary);
    }).catch(() => {
      if (generation === this.captureHandoffRenderGeneration && setting === this.captureHandoffSetting) {
        setting.setDesc("暂时无法读取本机剪藏同步状态；已保存的内容仍留在 Vault 中。");
      }
    });
  }

  display(): void {
    const { containerEl } = this;
    if (this.plugin.accountLoggedIn && this.plugin.settings.vaultSyncEnabled && this.plugin.settings.vaultEncryptionEnabled) {
      void this.plugin.refreshVaultEncryptionRotationAvailability();
    }
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

    const renderedAccountLoggedIn = this.plugin.accountLoggedIn;
    new Setting(containerEl)
      .setName("账号与登录")
      .setDesc(this.plugin.accountStatus)
      .addButton((button) =>
        button.setButtonText(renderedAccountLoggedIn ? "退出账号" : "登录账号")
          .onClick(async () => {
            const wasLoggedIn = this.plugin.accountLoggedIn;
            if (wasLoggedIn !== renderedAccountLoggedIn) {
              this.displayPreservingScroll();
              new Notice("账号状态刚刚更新，页面已刷新；请按最新状态重新操作", 8000);
              return;
            }
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

    this.textSetting(
      "微同步目录",
      `文章、附件和 AI 说明文件的剪藏根目录；Vault Sync 选择“仅 ${this.plugin.settings.rootFolder} 目录”时也以此路径筛选文件。这里是相对 Vault 根目录的路径，可手工填写，也可在下方搜索选择当前 Vault 已有目录。目录路径保存在本机；多端同步时，请在所有设备填写相同路径。`,
      "rootFolder",
    );

    if (this.plugin.accountCanVaultSync) {
      new Setting(containerEl)
        .setName("选择 Vault 内目录")
        .setDesc("搜索并选择当前 Vault 已有文件夹，只会填入上方“微同步目录”；不会自动更改云端同步范围或立即发起同步。")
        .addButton((button) => button
          .setButtonText("浏览目录")
          .onClick(() => {
            const folders = this.app.vault.getAllFolders()
              .filter((folder) => Boolean(normalizeVaultPath(folder.path)))
              .sort((left, right) => left.path.localeCompare(right.path));
            if (folders.length === 0) {
              new Notice("当前 Vault 尚无可选择的文件夹；请先创建文件夹，或手工填写微同步目录。", 8000);
              return;
            }
            new VaultFolderPickerModal(this.app, folders, (path) => {
              void this.setMicroSyncFolderFromPicker(path);
            }).open();
          }));
    }

    if (this.plugin.pendingDeletionCount > 0) {
      new Setting(containerEl)
        .setName(`需要处理的删除：${this.plugin.pendingDeletionCount} 项`)
        .setDesc("本机删除不会立即删除云端或其他设备上的文件；请逐项确认同步删除或恢复。提醒关闭后，可在命令面板搜索“微同步：处理待确认删除”重新打开。")
        .addButton((button) => button
          .setButtonText(`现在处理 ${this.plugin.pendingDeletionCount} 项`)
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
        ? (this.plugin.settings.vaultSyncDeleteMode === "review"
          ? "获取新的剪藏笔记，并同步当前 Vault 的新增和修改。本机删除默认先保留云端副本；同步后提醒你确认。其他设备收到已提交的云端删除会自动应用，未同步修改仍会保留并进入冲突处理。"
          : "获取新的剪藏笔记，并同步当前 Vault 的新增、修改和删除。其他设备收到已提交的云端删除会自动应用，未同步修改仍会保留并进入冲突处理。")
        : "检查飞书、网页和微信剪藏任务；开启多端同步后也会同步 Vault 文件")
      .addButton((button) =>
        button.setButtonText("立即同步").onClick(() => this.plugin.manualSync()),
      );

    this.captureHandoffSetting = new Setting(containerEl)
      .setName("剪藏同步状态")
      .setDesc("正在读取本机剪藏交接状态…");
    this.refreshCaptureHandoffStatus();

    const canVaultSync = this.plugin.accountCanVaultSync;
    const vaultSyncSetting = new Setting(containerEl)
      .setName("多端同步")
      .setDesc(canVaultSync
        ? "在多台设备间双向同步整个 Vault。新安装默认自动同步；开启后本机文件变更会自动触发，首次同步仍按安全提示处理。同文件在两台设备都修改时会生成冲突副本，不会静默覆盖。"
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
                new Notice(this.plugin.settings.vaultSyncIntervalMinutes === null
                  ? "Vault 多端同步已开启为手动模式；请点击“立即同步”，或选择自动同步间隔"
                  : "Vault 多端同步已开启：文件变更会自动触发同步，首次同步按安全提示处理", 8000);
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

    if (this.plugin.settings.syncTargetId) {
      new Setting(containerEl)
        .setName("当前同步 Vault UUID")
        .setDesc("复制当前连接的云端 Vault 标识，用于专用空测试 Vault 的基线核验。UUID 不是访问凭证；请勿使用日常 Vault 进行生产 canary，也不要分享整个插件设置文件。")
        .addButton((button) => button
          .setButtonText("复制 UUID")
          .onClick(async () => {
            try {
              await navigator.clipboard.writeText(this.plugin.settings.syncTargetId);
              new Notice("当前同步 Vault UUID 已复制到剪贴板");
            } catch {
              new Notice("复制 UUID 失败，请稍后重试；不要分享整个插件设置文件。", 10000);
            }
          }));
    }

    if (this.plugin.settings.syncTargetId && this.plugin.settings.vaultInstallationId) {
      const pathMoveProgress = new Setting(containerEl)
        .setName("文件改名/移动进度")
        .setDesc("正在读取本机待办数量…");
      const refreshPathMoveProgress = async () => {
        const summary = await createVaultSyncPathIntentStore(this.plugin.app, {
          apiBaseUrl: normalizeApiBaseUrl(this.plugin.settings.apiBaseUrl),
          targetId: this.plugin.settings.syncTargetId,
          installationId: this.plugin.settings.vaultInstallationId,
        }).summary();
        const status: string[] = [];
        if (summary.directoryMoveGroupCount > 0) {
          status.push(`目录移动 ${summary.directoryMoveGroupCount} 组：已处理 ${summary.directoryMoveSettledCount}/${summary.directoryMoveTotalCount} 项，剩余 ${summary.directoryMoveRemainingCount} 项，其中冲突 ${summary.directoryMoveConflictCount} 项`);
        }
        if (summary.pendingCount > 0 || summary.conflictCount > 0) {
          status.push(`全部路径变更队列待同步 ${summary.pendingCount} 项，冲突 ${summary.conflictCount} 项`);
        }
        const description = status.length
          ? `${status.join("；")}。${summary.conflictCount > 0 ? "冲突项请在冲突中心处理。" : ""}剩余项目逐项提交，应用重启后可继续。这里只显示数量，不显示文件路径。`
          : "没有未完成的文件改名或移动待办。这里只显示数量，不显示文件路径。";
        pathMoveProgress.setDesc(description);
      };
      pathMoveProgress.addButton((button) => button
        .setButtonText("刷新进度")
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await refreshPathMoveProgress();
          } catch {
            pathMoveProgress.setDesc("暂时无法读取本机改名/移动待办数量；同步状态不变。请稍后重试。");
          } finally {
            button.setDisabled(false);
          }
        }));
      void refreshPathMoveProgress().catch(() => {
        pathMoveProgress.setDesc("暂时无法读取本机改名/移动待办数量；同步状态不变。可稍后刷新重试。");
      });
    }

    if (this.plugin.settings.vaultSyncEnabled && canVaultSync) {
      const progress = this.plugin.vaultSyncDeviceProgress;
      const stateLabel = (state: "up_to_date" | "catching_up" | "unknown") => state === "up_to_date"
        ? "已追平"
        : state === "catching_up" ? "正在追赶" : "暂无应用回执";
      const progressExplanation = "设备‘已追平’表示已应用游标达到当前云端游标；已应用游标按连续变更计算，尚未提交到云端的本地改动（包括待确认删除）不会显示在这里。确认删除成功提示中的‘云端变更游标’可与接收设备的‘已应用游标’比较；后者达到或超过该值，才表示该设备已应用这条删除变更。“查询于”是本机完成刷新状态时记下的时间，不是传播计时；不同设备查询时间的差值不能直接作为笔记同步耗时。设备名后的 ID 前缀可与冲突详情里的来源设备对应。";
      const pendingDeletionCount = this.plugin.pendingDeletionCount;
      const pendingDeletionProgress = formatPendingDeletionDeviceProgress(pendingDeletionCount);
      const progressDescription = progress
        ? [`云端游标 ${progress.changeCursor}`,
          ...progress.devices.map((device) => `${device.deviceName}（ID ${device.deviceId.slice(0, 8)}${device.deviceId === this.plugin.settings.vaultDeviceId ? "，本机" : ""}）：${stateLabel(device.state)}（${formatVaultSyncDeviceCursors(device)}）`),
          `查询于 ${this.plugin.vaultSyncDeviceProgressFetchedAt || "刚刚"}`,
          ...(pendingDeletionProgress ? [pendingDeletionProgress] : []),
          progressExplanation].join("；")
        : `状态依据各设备已应用 ACK；旧设备或尚未完成首次快照的设备会显示为未知。${pendingDeletionProgress ? `${pendingDeletionProgress} ` : ""}${progressExplanation}`;
      new Setting(containerEl)
        .setName("设备追平状态")
        .setDesc(progressDescription)
        .addButton((button) => button
          .setButtonText("刷新设备状态")
          .onClick(async () => {
            try {
              button.setDisabled(true);
              await this.plugin.refreshVaultSyncDeviceProgress();
              this.displayPreservingScroll();
            } catch (error) {
              new Notice(`读取设备同步状态失败：${error instanceof Error ? error.message : String(error)}`, 8000);
            } finally {
              button.setDisabled(false);
            }
          }));
      if (pendingDeletionCount > 0) {
        new Setting(containerEl)
          .setName("本机待提交删除")
          .setDesc("设备追平状态不包含本机待审删除；云端尚未收到这些删除。")
          .addButton((button) => button
            .setButtonText(`处理 ${pendingDeletionCount} 项待确认删除`)
            .onClick(() => { void this.plugin.openPendingDeletionReview(); }));
      }

      const diagnostics = this.plugin.vaultSyncDiagnostics.snapshot();
      const formatSeconds = (value: number | null | undefined) => value === null || value === undefined
        ? "—"
        : `${(value / 1000).toFixed(1)} 秒`;
      const latest = diagnostics.latest;
      const eventIssueLabels: Record<string, string> = {
        ticket_unauthorized: "票据请求未授权",
        ticket_rate_limited: "票据请求限流",
        ticket_server_error: "票据服务端错误",
        ticket_http_error: "票据 HTTP 请求失败",
        ticket_response_invalid: "票据响应无效",
        ticket_session_mismatch: "设备会话不匹配",
        ticket_transport_error: "票据请求网络错误",
        websocket_unavailable: "WebSocket 不可用",
        websocket_open_timeout: "WebSocket 建连超时",
        websocket_ready_timeout: "WebSocket 认证握手超时",
      } as const;
      const eventIssueDescription = (issue: typeof diagnostics.lastEventIssue) => {
        if (!issue) return "";
        const stagedClose = issue.match(/^websocket_closed_(before_open|before_ready|after_ready)_(0|[1-4][0-9]{3})$/);
        if (stagedClose) {
          const stageLabels: Record<string, string> = {
            before_open: "连接建立前中断",
            before_ready: "认证握手完成前中断",
            after_ready: "认证连接建立后断开",
          };
          return `最近异常：WebSocket ${stageLabels[stagedClose[1]]}，关闭码 ${stagedClose[2]}。`;
        }
        if (issue.startsWith("websocket_closed_")) return `最近异常：WebSocket 关闭码 ${issue.slice("websocket_closed_".length)}。`;
        return `最近异常：${eventIssueLabels[issue]}。`;
      };
      const diagnosticStageLabels: Record<VaultSyncDiagnosticStage, string> = {
        device_auth: "设备凭据",
        remote_status: "云端状态",
        encryption_setup: "加密准备",
        capability_read: "能力读取",
        local_prepare: "本机准备",
        pull: "拉取",
        push: "推送",
        finalize: "收尾",
        legacy_sync: "旧版同步",
      };
      const multipartStageLabels: Record<VaultSyncMultipartTransferDiagnostic["stage"], string> = {
        initialize: "会话初始化",
        part_url: "分段地址",
        part_upload: "分段上传",
        complete: "分段完成",
        finalize: "对象校验",
      };
      const multipartOutcomeLabels: Record<VaultSyncMultipartTransferDiagnostic["outcome"], string> = {
        started: "已开始",
        succeeded: "成功",
        failed: "失败",
      };
      const work = latest?.work;
      const v1WorkDescription = latest?.protocol === "v1" && work?.v1UploadedCount !== undefined
        ? `V1 操作：上传 ${work.v1UploadedCount}、下载 ${work.v1DownloadedCount ?? 0}、本地删除 ${work.v1DeletedLocalCount ?? 0}、云端删除 ${work.v1DeletedRemoteCount ?? 0}、冲突 ${work.v1ConflictCount ?? 0}、失败 ${work.v1FailedCount ?? 0}${work.v1Aborted ? "、已中止" : ""}${work.v1NeedsBootstrapDecision ? "、等待首次同步方向确认" : ""}${work.v1SafetyBlocked ? "、安全保护暂停" : ""}${work.v1DeletionReviewRequired ? "、删除待审核" : ""}`
        : "";
      const localWorkDescription = work ? [
        v1WorkDescription,
        work.scanEntryCount === undefined
          ? "本机扫描未运行"
          : `本机扫描 ${work.scanEntryCount} 个文件${work.scanIssueCount ? `，扫描异常 ${work.scanIssueCount} 项` : ""}`,
        work.pushCommittedCount === undefined
          ? "推送阶段未运行"
          : `推送：已提交 ${work.pushCommittedCount}、改名 ${work.pushRenamedCount ?? 0}、删除 ${work.pushDeletedCount ?? 0}、冲突 ${work.pushConflictCount ?? 0}、失败 ${work.pushFailedCount ?? 0}、需重基 ${work.pushNeedsRebaseCount ?? 0}、预算暂缓 ${work.pushSkippedForBudgetCount ?? 0}、删除待审核 ${work.pendingDeletionReviewCount ?? 0}`,
        work.outboxReadable === false
          ? "本机 outbox 读取失败"
          : work.outboxSnapshotPresent === false
            ? "本机 outbox 没有可用快照"
            : work.outboxSnapshotPresent
              ? `本机 outbox：排队 ${work.outboxQueuedCount ?? 0}、准备 ${work.outboxPreparingCount ?? 0}、已上传 ${work.outboxUploadedCount ?? 0}、提交中 ${work.outboxCommittingCount ?? 0}、已确认未清理 ${work.outboxConfirmedCount ?? 0}、冲突 ${work.outboxConflictCount ?? 0}、需重基 ${work.outboxNeedsRebaseCount ?? 0}；inbox 未应用 ${work.inboxReceivedCount ?? 0}、待解决 ${work.inboxNeedsResolutionCount ?? 0}`
              : "本机 outbox 状态未采集",
      ].filter(Boolean).join("。 ") + "。" : "";
      const diagnosticDescription = [
        `仅本机内存保留本次 Obsidian 运行期的耗时、聚合计数和状态，不上传，重启后清空。完整同步 ${diagnostics.completedCount} 轮：总用时 P50 ${formatSeconds(diagnostics.durationP50Ms)} / P95 ${formatSeconds(diagnostics.durationP95Ms)}。`,
        "“需重基”表示已停止自动重试的旧请求，保留供核对；不会阻塞其他独立笔记同步。点击“查看需重基项”可查看操作类型、原因和路径。",
        `v2 拉取 P95 ${formatSeconds(diagnostics.pullP95Ms)}，推送阶段 P95 ${formatSeconds(diagnostics.pushP95Ms)}。`,
        `推送 CAS 自动合并：尝试 ${diagnostics.pushCasAutoMergeAttemptCount} 次、持久重提 ${diagnostics.pushCasAutoMergeRetryQueuedCount} 次、云端确认 ${diagnostics.pushCasAutoMergeRetryCommittedCount} 次。`,
        `CAS（比较并交换）统计只覆盖符合条件的 Markdown 推送冲突：尝试表示开始自动重算，持久重提表示合并结果已存入本机待办，云端确认表示云端已确认提交。三项均为 0 表示本轮没有触发这条重试路径，不代表同步失败。`,
        `云端提交→本机安全应用 P50 ${formatSeconds(diagnostics.appliedLatencyP50Ms)} / P95 ${formatSeconds(diagnostics.appliedLatencyP95Ms)}（${diagnostics.appliedLatencySampleCount} 个样本；包含提交后等待本机安全落盘的时间，打开中的笔记会使应用延后；不含本机编辑到云端提交前的等待与上传）。`,
        `自动同步总等待 P95 ${formatSeconds(diagnostics.queueWaitP95Ms)}（${diagnostics.queueWaitSampleCount} 个样本；按系统时钟从本机变更计到同步启动，可能包含后台或离线暂停，也可能受系统时钟校准影响）。未暂停调度等待 P95 ${formatSeconds(diagnostics.activeQueueWaitP95Ms)}（${diagnostics.activeQueueWaitSampleCount} 个样本；只累计调度器未暂停时间，不代表系统睡眠检测或设备间传播时延）；事件通道${({ stopped: "已停止", offline: "离线", connecting: "连接中", connected: "已连接", polling: "轮询回退" } as const)[diagnostics.connectionStatus]}；本次运行成功重连 ${diagnostics.successfulReconnectCount} 次。${eventIssueDescription(diagnostics.lastEventIssue)}`,
        latest ? `最近一轮：${latest.protocol} / ${latest.outcome} / ${formatSeconds(latest.durationMs)}${latest.stage ? ` / 阶段 ${diagnosticStageLabels[latest.stage]}` : ""}${latest.failureCode ? ` / ${latest.failureCode}` : ""}${latest.multipartTransfer ? ` / 分段传输 ${multipartStageLabels[latest.multipartTransfer.stage]} ${multipartOutcomeLabels[latest.multipartTransfer.outcome]}${latest.multipartTransfer.httpStatus ? `（HTTP ${latest.multipartTransfer.httpStatus}` : ""}${latest.multipartTransfer.errorCode ? `${latest.multipartTransfer.httpStatus ? "，" : "（"}${latest.multipartTransfer.errorCode}` : ""}${latest.multipartTransfer.httpStatus || latest.multipartTransfer.errorCode ? "）" : ""}` : ""}。` : "尚无本次运行的同步样本。",
        "分段诊断只保留本轮最后报告的客户端阶段、可见 HTTP 状态和固定安全错误码；“已开始”只表示客户端进入该步骤，不代表服务端已收到请求。",
        localWorkDescription,
      ].join(" ");
      new Setting(containerEl)
        .setName("本地同步性能统计")
        .setDesc(diagnosticDescription)
        .addButton((button) => button
          .setButtonText("刷新统计")
          .onClick(() => this.displayPreservingScroll()))
        .addButton((button) => button
          .setButtonText("查看需重基项")
          .onClick(() => { void this.plugin.openVaultSyncNeedsRebaseReview(); }))
        .addButton((button) => button
          .setButtonText("清空")
          .onClick(() => {
            this.plugin.vaultSyncDiagnostics.clear();
            this.displayPreservingScroll();
          }));
    }

    if (this.plugin.accountCanVaultSync) {
      const currentInterval = this.plugin.settings.vaultSyncIntervalMinutes;
      new Setting(containerEl)
        .setName("自动同步 Vault")
        .setDesc(this.plugin.settings.vaultSyncEnabled
          ? (currentInterval === null
            ? "当前为手动模式：文件变更不会自动上传，请点击“立即同步”。"
            : `本机文件变更后约 0.8 秒触发同步；每 ${currentInterval} 分钟另做一次对账兜底。端到端耗时取决于网络和设备，可随时点击“立即同步”。`)
          : "先开启多端同步；新安装默认自动同步（文件事件触发，1 分钟对账兜底），已有手动选择会保留。")
        .addDropdown((dropdown) => {
          dropdown
            .addOption("1", "1 分钟（默认；文件变更即时触发）")
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

    if (this.plugin.accountCanVaultSync) {
      new Setting(containerEl)
        .setName("同步范围")
        .setDesc(this.plugin.settings.vaultSyncEnabled
          ? "这是 Vault 级同步策略；更改后会立即按新范围重建快照并同步。同步以文件为单位，创建或删除空文件夹不会触发同步或云端删除确认；缩小范围时，范围外云端文件会保留且不会被当作删除。"
          : "首次启用前可先选择同步范围。同步以文件为单位，创建或删除空文件夹不会触发同步或云端删除确认。若当前 Vault 含有日常文件，请先把“微同步目录”改为仅含合成测试数据的专用目录，再选择仅同步该目录。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("whole_vault", "整个 Vault（推荐）")
            .addOption("root_folder", `仅 ${this.plugin.settings.rootFolder} 目录`)
            .setValue(this.plugin.settings.vaultSyncScope)
            .onChange(async (value) => {
              try {
                await this.plugin.setVaultSyncScope(value as VaultSyncScope);
              } catch (error) {
                new Notice(`同步范围更新失败：${error instanceof Error ? error.message : String(error)}`, 10000);
              } finally {
                this.displayPreservingScroll();
              }
            }),
        );
    }

    if (this.plugin.settings.vaultSyncEnabled && this.plugin.accountCanVaultSync) {
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
        .setName("Markdown 自动合并")
        .setDesc(this.plugin.settings.vaultSyncMergeMode === "automatic"
          ? "共同基线可验证且修改不重叠时自动合并；重叠修改仍会进入冲突处理。"
          : "严格模式：任何双端同时修改都保留双方并进入冲突处理；你仍可在冲突中心明确选择采用云端。")
        .addDropdown((dropdown) => dropdown
          .addOption("automatic", "自动合并（推荐）")
          .addOption("manual", "严格保留双方")
          .setValue(this.plugin.settings.vaultSyncMergeMode)
          .onChange(async (value) => {
            await this.plugin.setVaultSyncMergeMode(value as VaultSyncMergeMode);
            this.display();
          }));

      new Setting(containerEl)
        .setName("本机删除提交策略")
        .setDesc(this.plugin.settings.vaultSyncDeleteMode === "automatic"
          ? "此策略只控制本机删除何时提交云端：小批量自动提交，大批量仍按保护设置检查。云端删除一经提交，其他设备会自动应用；接收端仅在本机副本与同步基线一致、未打开且无待提交改名时应用，并遵循该设备 Obsidian“设置 → 文件与链接 → 已删除文件”的选项，移入 Obsidian 回收站、系统回收站或永久删除。"
          : "此策略只控制本机删除何时提交云端：先保留云端副本，提醒你逐项确认后才提交。云端删除一经确认，其他设备会自动应用；接收端仅在本机副本与同步基线一致、未打开且无待提交改名时应用，并遵循该设备 Obsidian“设置 → 文件与链接 → 已删除文件”的选项，移入 Obsidian 回收站、系统回收站或永久删除。")
        .addDropdown((dropdown) => dropdown
          .addOption("review", "逐项确认（默认）")
          .addOption("automatic", "自动同步小批量删除")
          .setValue(this.plugin.settings.vaultSyncDeleteMode)
          .onChange(async (value) => {
            await this.plugin.setVaultSyncDeleteMode(value as VaultSyncDeleteMode);
            this.display();
          }));

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
          ? "已启用：笔记内容在本地加密后才上传。此处用于保存当前密码到本机 SecretStorage；更换密码需要完成客户端重加密迁移。忘记密码无法恢复云端内容。"
          : "启用后，微同步服务器和托管对象存储都不会看到笔记明文；请在每台设备输入相同密码。")
        .addText((text) => {
          text.inputEl.type = "password";
          text.setPlaceholder("至少 8 个字符").setValue(this.plugin.vaultEncryptionInput)
            .onChange((value) => { this.plugin.vaultEncryptionInput = value; });
        })
        .addButton((button) => button
          .setButtonText(this.plugin.settings.vaultEncryptionEnabled ? "保存此设备密码" : "启用加密")
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

      const rotationPending = Boolean(this.plugin.settings.vaultEncryptionRotationOperationId
        || this.plugin.settings.vaultEncryptionRotationId || this.plugin.settings.vaultEncryptionRotationSecretId);
      if (this.plugin.vaultEncryptionRotationAvailable || rotationPending) {
        new Setting(containerEl)
          .setName("更换 Vault 加密密码")
          .setDesc(this.plugin.vaultEncryptionRotationStatus
            || (rotationPending
              ? "检测到未完成的密码迁移；请在发起迁移的设备继续，旧密码会保留到迁移完成。"
              : "迁移会逐个下载、校验并重新加密云端对象；期间多设备同步暂停，可在此设备继续或安全中止。新密码保存在本机 SecretStorage。"))
          .addText((text) => {
            text.inputEl.type = "password";
            text.setPlaceholder(rotationPending ? "续跑时留空即可" : "至少 8 个字符")
              .setValue(this.plugin.vaultEncryptionRotationInput)
              .onChange((value) => { this.plugin.vaultEncryptionRotationInput = value; });
          })
          .addButton((button) => button
            .setButtonText(this.plugin.vaultEncryptionRotationRunning
              ? "正在迁移…"
              : rotationPending ? "继续迁移" : "更换密码并迁移")
            .setDisabled(this.plugin.vaultEncryptionRotationRunning
              || (!rotationPending && !this.plugin.vaultEncryptionRotationAvailable))
            .onClick(async () => {
              try {
                button.setDisabled(true);
                const result = await this.plugin.rotateVaultEncryptionKey(this.plugin.vaultEncryptionRotationInput);
                this.displayPreservingScroll();
                new Notice(result.completed
                  ? "Vault 加密密码已更换，旧对象清理完成"
                  : `新密码已启用，${result.remainingSourceObjects} 个旧对象将在下载 lease 到期后清理；稍后继续即可`, 10000);
              } catch (error) {
                new Notice(`密钥迁移未完成：${error instanceof Error ? error.message : String(error)}`, 10000);
              } finally {
                button.setDisabled(false);
                this.displayPreservingScroll();
              }
            }))
          .addButton((button) => button
            .setButtonText("中止迁移")
            .setDisabled(!rotationPending || this.plugin.vaultEncryptionRotationRunning)
            .onClick(async () => {
              if (!window.confirm("中止会回滚尚未激活的对象引用，保留原密码和原文件。确定中止密钥迁移吗？")) return;
              try {
                button.setDisabled(true);
                await this.plugin.abortVaultEncryptionKeyRotation();
                new Notice("密钥迁移已中止；原密码和原文件仍可使用");
              } catch (error) {
                new Notice(`无法中止密钥迁移：${error instanceof Error ? error.message : String(error)}`, 10000);
              } finally {
                button.setDisabled(false);
                this.displayPreservingScroll();
              }
            }));
      }
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
