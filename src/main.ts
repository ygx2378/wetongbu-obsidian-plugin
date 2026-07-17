import path from "node:path";
import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import JSZip from "jszip";
import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
  type App,
} from "obsidian";
import {
  deleteReadyTask,
  downloadReadyTask,
  listReadyManifestKeys,
} from "./shared/inbox.mjs";
import { buildVaultPaths } from "./shared/vault-layout.mjs";
import {
  isSafePackagePath,
  validateWebclipManifest,
  verifyWebclipPackageFiles,
} from "./shared/feishu-package.mjs";

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
}

type StorageProvider = "cloudflare_r2" | "aws_s3" | "aliyun_oss" | "tencent_cos";
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

const DEFAULT_SETTINGS: WeTongbuSettings = {
  apiBaseUrl: "https://api.wetongbu.com",
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

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

export default class WeTongbuPlugin extends Plugin {
  settings: WeTongbuSettings = DEFAULT_SETTINGS;
  private syncing = false;
  pairingCode = "";
  pairingExpiresAt = "";
  recoveryToken = "";
  storageStatus = "";
  accountStatus = "未登录";

  async onload() {
    const saved = ((await this.loadData()) ?? {}) as PersistedSettings;
    const {
      noteFolder: _legacyNoteFolder,
      attachmentFolder: _legacyAttachmentFolder,
      ...currentSettings
    } = saved;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, currentSettings);
    await this.saveSettings();
    this.addSettingTab(new WeTongbuSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "微同步：手动同步", () => {
      void this.syncNow();
    });
    this.addCommand({
      id: "sync-now",
      name: "手动同步",
      callback: () => void this.syncNow(),
    });
    this.addCommand({
      id: "migrate-legacy-r2-inbox",
      name: "迁移旧版 R2 待同步任务",
      callback: () => void this.migrateLegacyR2Inbox(),
    });
    this.app.workspace.onLayoutReady(() => {
      void this.ensureWorkspace();
      void this.syncNow(true);
      this.registerInterval(
        window.setInterval(() => void this.syncNow(true), 30_000),
      );
    });
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
        deviceName: navigator.platform || "Obsidian Desktop",
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
        device_name: navigator.platform || "Obsidian Desktop",
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
    const verificationUrl = `${authorization.verification_uri}?user_code=${encodeURIComponent(authorization.user_code)}`;
    window.open(verificationUrl, "_blank");
    this.accountStatus = `请在浏览器确认 ${authorization.user_code}`;
    for (;;) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const polled = await requestUrl({
        url: `${base}/api/device-authorizations/token`,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ device_code: authorization.device_code }),
        throw: false,
      });
      if (polled.status !== 200) throw new Error(polled.json?.error ?? "登录授权已失效");
      if (polled.json.status === "pending") continue;
      if (!polled.json.plugin_token) throw new Error("登录授权响应无效");
      this.app.secretStorage.setSecret(this.pluginTokenSecretId(), polled.json.plugin_token);
      this.accountStatus = "已登录，可使用 Pro 试用";
      return;
    }
  }

  async configureUserStorage(accessKeyInput: string, secretKeyInput: string) {
    const accessKeyId = accessKeyInput.trim();
    const secretAccessKey = secretKeyInput;
    if (!accessKeyId || !secretAccessKey) throw new Error("请先输入 Access Key 和 Secret Key");
    if (!this.settings.bucket) throw new Error("请先填写 Bucket");
    if (!this.settings.region) throw new Error("请先填写 Region");
    if (this.settings.storageProvider === "cloudflare_r2" && !this.settings.endpoint) {
      throw new Error("请先填写 R2 Endpoint");
    }
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
        access_key_id: accessKeyId,
        secret_access_key: secretAccessKey,
      }),
      throw: false,
    });
    if (response.status !== 200) throw new Error(response.json?.error ?? "对象存储测试失败");
    this.settings.accessKeySecretId = accessKeySecretId;
    this.settings.secretKeySecretId = secretKeySecretId;
    this.app.secretStorage.setSecret(accessKeySecretId, accessKeyId);
    this.app.secretStorage.setSecret(secretKeySecretId, secretAccessKey);
    await this.saveSettings();
    this.storageStatus = `连接正常 · ${providerLabel(response.json.storage.provider ?? this.settings.storageProvider)} · ${response.json.storage.bucket}`;
  }

  private createClient() {
    const accessKeyId = this.app.secretStorage.getSecret(
      this.settings.accessKeySecretId,
    );
    const secretAccessKey = this.app.secretStorage.getSecret(
      this.settings.secretKeySecretId,
    );
    if (!this.settings.endpoint || !this.settings.bucket) {
      throw new Error("请先填写 R2 Endpoint 和 Bucket");
    }
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("请先输入 Access Key 和 Secret Key，然后点击“测试并保存”");
    }
    return new S3Client({
      endpoint: this.settings.endpoint,
      region: this.settings.region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
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
      if (!quiet) new Notice(`微同步失败：${message}`, 10000);
      console.error("WeTongbu sync failed", { message: message.slice(0, 240) });
    } finally {
      this.syncing = false;
    }
  }

  private async migrateLegacyR2Inbox() {
    if (this.syncing) {
      new Notice("微同步正在运行");
      return;
    }
    if (this.settings.storageProvider !== "cloudflare_r2") {
      new Notice("旧版任务迁移只适用于 Cloudflare R2");
      return;
    }
    this.syncing = true;
    let client: S3Client | null = null;
    try {
      client = this.createClient();
      const manifestKeys = await listReadyManifestKeys(
        client,
        this.settings.bucket,
        this.settings.prefix,
      );
      if (manifestKeys.length === 0) {
        new Notice("微同步：没有需要迁移的旧版任务");
        return;
      }

      let synced = 0;
      for (const manifestKey of manifestKeys) {
        const task = await downloadReadyTask(
          client,
          this.settings.bucket,
          manifestKey,
        );
        const taskSeen = this.settings.processedTaskIds.includes(task.manifest.taskId);
        const urlSeen = task.manifest.sourceUrl
          && this.settings.processedSourceUrls.includes(task.manifest.sourceUrl);
        if (!taskSeen && !urlSeen) {
          await this.writeTask(task);
          this.settings.processedTaskIds.push(task.manifest.taskId);
          this.settings.processedTaskIds = this.settings.processedTaskIds.slice(-1000);
          if (task.manifest.sourceUrl) {
            this.settings.processedSourceUrls.push(task.manifest.sourceUrl);
            this.settings.processedSourceUrls = this.settings.processedSourceUrls.slice(-1000);
          }
          await this.saveSettings();
        }
        await deleteReadyTask(client, this.settings.bucket, task);
        synced += 1;
      }
      new Notice(`微同步：已迁移 ${synced} 篇旧版任务`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`旧版任务迁移失败：${message}`, 10000);
      console.error("WeTongbu legacy migration failed", { message: message.slice(0, 240) });
    } finally {
      client?.destroy();
      this.syncing = false;
    }
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
      const zipBytes = Buffer.from(downloaded.arrayBuffer);
      const packageHash = createHash("sha256").update(zipBytes).digest("hex");
      if (packageHash !== item.content_hash) throw new Error("ZIP 校验失败：任务包哈希不一致");
      if (zipBytes.length !== item.file_size) throw new Error("ZIP 校验失败：任务包大小不一致");
      const task = await this.unpackWebclipTask(zipBytes);
      if (task.manifest.taskId !== item.task_id) throw new Error("manifest task_id 与服务器任务不一致");
      await this.writeTask(task);
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

  private async unpackWebclipTask(zipBytes: Buffer) {
    const zip = await JSZip.loadAsync(zipBytes);
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.some((entry) => !isSafePackagePath(entry.name))) throw new Error("ZIP 包含不安全路径");
    const manifestEntry = zip.file("manifest.json");
    if (!manifestEntry) throw new Error("manifest.json 缺失");
    const manifest = validateWebclipManifest(JSON.parse(await manifestEntry.async("string")));
    const files = new Map<string, Buffer>();
    for (const record of manifest.files) {
      const entry = zip.file(record.path);
      if (!entry) throw new Error(`任务文件缺失：${record.path}`);
      files.set(record.path, Buffer.from(await entry.async("uint8array")));
    }
    verifyWebclipPackageFiles(manifest, files);
    const allowed = new Set(["manifest.json", ...manifest.files.map((file: any) => file.path)]);
    if (entries.some((entry) => !allowed.has(entry.name))) throw new Error("ZIP 包含未声明文件");
    return {
      manifest: {
        taskId: manifest.task_id,
        title: manifest.title,
        sourceUrl: manifest.source_url,
        capturedAt: manifest.created_at,
      },
      markdown: files.get(manifest.entry_file)!.toString("utf8"),
      assets: manifest.files
        .filter((file: any) => file.path.startsWith("assets/"))
        .map((file: any) => ({ relativePath: file.path, body: files.get(file.path)! })),
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

  private async writeTask(task: any) {
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
    await ensureFolder(this, taskAttachmentFolder);

    let markdown = task.markdown;
    const assetPlans = task.assets.map((asset: any, index: number) => {
      const filename = layout.assetNames[index];
      const targetPath = normalizePath(`${taskAttachmentFolder}/${filename}`);
      const relativePath = path.posix.relative(noteFolder, targetPath);
      markdown = markdown.split(`<${asset.relativePath}>`).join(relativePath);
      markdown = markdown.split(asset.relativePath).join(relativePath);
      return { asset, filename, targetPath };
    });
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
      for (const { asset, filename, targetPath } of assetPlans) {
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
      if (createdNote && noteCreatedByThisAttempt) await this.app.vault.delete(createdNote);
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
          button.setButtonText("恢复连接").onClick(async () => {
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
      .setDesc(this.plugin.accountStatus === "未登录"
        ? "Free 不登录也能使用；登录后可试用微同步托管存储"
        : this.plugin.accountStatus)
      .addButton((button) =>
        button.setButtonText(this.plugin.accountStatus === "未登录" ? "登录并使用 Pro" : "重新登录")
          .onClick(async () => {
            try {
              button.setDisabled(true);
              await this.plugin.startAccountLogin();
              this.display();
              new Notice("登录成功，可开始使用 Pro 试用");
            } catch (error) {
              new Notice(`登录失败：${error instanceof Error ? error.message : String(error)}`, 10000);
            } finally {
              button.setDisabled(false);
            }
          }),
      );

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
      if (this.plugin.recoveryToken) {
        recoverySetting.addButton((button) =>
          button.setButtonText("复制恢复码").onClick(async () => {
            await navigator.clipboard.writeText(this.plugin.recoveryToken);
            new Notice("恢复码已复制");
          }),
        );
      }
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
      .setName("连接浏览器扩展")
      .setDesc(
        this.plugin.pairingCode
          ? `绑定码 ${this.plugin.pairingCode}，有效至 ${new Date(this.plugin.pairingExpiresAt).toLocaleTimeString()}`
          : "对象存储测试通过后，生成 6 位一次性绑定码连接浏览器",
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
      .setName("自动同步")
      .setDesc("插件启动时检查，并每 30 秒检查一次待同步任务");

    new Setting(containerEl)
      .setName("手动同步")
      .setDesc("立即检查待同步任务")
      .addButton((button) =>
        button.setButtonText("立即同步").onClick(() => this.plugin.syncNow()),
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
