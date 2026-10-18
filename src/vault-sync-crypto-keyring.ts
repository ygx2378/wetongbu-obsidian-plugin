import {
  createVaultSyncCrypto,
  createVaultSyncCryptoKeyring,
  type VaultSyncCrypto,
  type VaultSyncCryptoKeyring,
} from "./shared/vault-sync-crypto.ts";

const SALT_HEX = /^[a-f0-9]{32}$/i;
const SECRET_ID = /^[a-zA-Z0-9._:-]{1,200}$/;
const MAX_KEY_VERSIONS = 32;

export interface VaultSyncCryptoKeyDescriptor {
  keyVersion: number;
  saltHex: string;
  secretId: string;
}

export interface VaultSyncCryptoSecretStorage {
  getSecret(secretId: string): string | null | undefined | Promise<string | null | undefined>;
}

export interface RemoteVaultSyncKeyVersion {
  key_version: number;
  salt_hex: string;
  status: "active" | "retained" | "retired";
}

export interface LoadedVaultSyncCryptoKeyring {
  active: VaultSyncCrypto;
  keyring: VaultSyncCryptoKeyring;
  availableKeyVersions: number[];
  missingHistoricalKeyVersions: number[];
}

export function assertVaultSyncEncryptionVersionCompatible(input: {
  remoteVersion: number;
  localVersion: number;
  remoteSaltHex?: string | null;
  localSaltHex?: string | null;
  localCredentialConfigured: boolean;
}): void {
  if (!Number.isSafeInteger(input.remoteVersion) || input.remoteVersion < 1
    || !Number.isSafeInteger(input.localVersion) || input.localVersion < 1) {
    throw fail("encryption_key_version_invalid", "云端或本机 Vault 加密密钥版本无效");
  }
  if (!input.remoteSaltHex || !SALT_HEX.test(input.remoteSaltHex)) {
    throw fail("encryption_key_material_mismatch", "云端 Vault 没有返回有效加密盐值；已暂停同步以保护数据");
  }
  if (input.remoteVersion !== input.localVersion) {
    throw fail("encryption_key_version_required", `云端 Vault 使用密钥版本 ${input.remoteVersion}，本机配置为版本 ${input.localVersion}；请先完成此设备的密钥迁移/解锁`);
  }
  if (input.localCredentialConfigured
    && (!input.localSaltHex || !SALT_HEX.test(input.localSaltHex)
      || input.remoteSaltHex.toLowerCase() !== input.localSaltHex.toLowerCase())) {
      throw fail("encryption_key_material_mismatch", "云端 Vault 加密盐值与本机密钥信息不一致；已暂停同步以保护数据");
  }
}

/** Validates the server's non-secret version catalog and binds its active row to status fields. */
export function validateVaultSyncRemoteKeyVersionCatalog(input: {
  catalog: unknown;
  activeVersion: number;
  activeSaltHex: string;
  localDescriptors?: unknown;
}): RemoteVaultSyncKeyVersion[] | null {
  if (input.catalog === undefined) return null; // Compatible with older API deployments.
  if (!Array.isArray(input.catalog) || input.catalog.length < 1 || input.catalog.length > MAX_KEY_VERSIONS) {
    throw fail("encryption_key_catalog_invalid", "云端 Vault 加密密钥目录无效");
  }
  const seen = new Set<number>();
  const seenSalts = new Set<string>();
  const entries: RemoteVaultSyncKeyVersion[] = [];
  for (const value of input.catalog) {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).length !== 3) {
      throw fail("encryption_key_catalog_invalid", "云端 Vault 加密密钥目录项无效");
    }
    const entry = value as RemoteVaultSyncKeyVersion;
    if (!Number.isSafeInteger(entry.key_version) || entry.key_version < 1
      || seen.has(entry.key_version) || typeof entry.salt_hex !== "string" || !SALT_HEX.test(entry.salt_hex)
      || !["active", "retained", "retired"].includes(entry.status)) {
      throw fail("encryption_key_catalog_invalid", "云端 Vault 加密密钥目录项无效");
    }
    const normalizedSalt = entry.salt_hex.toLowerCase();
    if (seenSalts.has(normalizedSalt)) {
      throw fail("encryption_key_catalog_invalid", "云端 Vault 不同密钥版本不能复用同一 salt");
    }
    seen.add(entry.key_version);
    seenSalts.add(normalizedSalt);
    entries.push({ ...entry, salt_hex: normalizedSalt });
  }
  const active = entries.filter((entry) => entry.status === "active");
  if (active.length !== 1 || active[0].key_version !== input.activeVersion
    || active[0].salt_hex !== input.activeSaltHex.toLowerCase()
    || entries.some((entry) => entry.key_version > input.activeVersion)) {
    throw fail("encryption_key_catalog_invalid", "云端活动密钥目录与当前 Vault 加密参数不一致");
  }
  const localDescriptors = normalizeVaultSyncCryptoKeyDescriptors(input.localDescriptors);
  for (const descriptor of localDescriptors) {
    const remote = entries.find((entry) => entry.key_version === descriptor.keyVersion);
    if (remote && remote.salt_hex !== descriptor.saltHex) {
      throw fail("encryption_key_material_mismatch", `本机保存的 Vault 密钥版本 ${descriptor.keyVersion} 与云端盐值目录不一致；已暂停同步以保护历史数据`);
    }
  }
  return entries.sort((a, b) => a.key_version - b.key_version);
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function validDescriptor(value: unknown): value is VaultSyncCryptoKeyDescriptor {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 3
    && Number.isSafeInteger((value as VaultSyncCryptoKeyDescriptor).keyVersion)
    && (value as VaultSyncCryptoKeyDescriptor).keyVersion >= 1
    && typeof (value as VaultSyncCryptoKeyDescriptor).saltHex === "string"
    && SALT_HEX.test((value as VaultSyncCryptoKeyDescriptor).saltHex)
    && typeof (value as VaultSyncCryptoKeyDescriptor).secretId === "string"
    && SECRET_ID.test((value as VaultSyncCryptoKeyDescriptor).secretId);
}

/**
 * Normalizes non-secret key metadata persisted in plugin settings. Historical
 * passphrases remain exclusively in Obsidian SecretStorage.
 */
export function normalizeVaultSyncCryptoKeyDescriptors(
  values: unknown,
  legacyCurrent?: VaultSyncCryptoKeyDescriptor | null,
): VaultSyncCryptoKeyDescriptor[] {
  if (values !== undefined && values !== null && !Array.isArray(values)) {
    throw fail("encryption_keyring_invalid", "Vault 加密密钥目录格式无效");
  }
  const input = Array.isArray(values) ? values : [];
  if (input.length > MAX_KEY_VERSIONS || !input.every(validDescriptor)) {
    throw fail("encryption_keyring_invalid", "Vault 加密密钥目录包含无效版本或超出数量上限");
  }
  const byVersion = new Map<number, VaultSyncCryptoKeyDescriptor>();
  const salts = new Set<string>();
  for (const value of input as VaultSyncCryptoKeyDescriptor[]) {
    if (byVersion.has(value.keyVersion)) {
      throw fail("encryption_keyring_invalid", "Vault 加密密钥目录包含重复版本");
    }
    const saltHex = value.saltHex.toLowerCase();
    if (salts.has(saltHex)) {
      throw fail("encryption_keyring_invalid", "Vault 不同密钥版本不能复用同一 salt");
    }
    salts.add(saltHex);
    byVersion.set(value.keyVersion, { ...value, saltHex });
  }
  if (legacyCurrent) {
    if (!validDescriptor(legacyCurrent)) {
      throw fail("encryption_keyring_invalid", "当前 Vault 加密密钥信息无效");
    }
    const normalized = { ...legacyCurrent, saltHex: legacyCurrent.saltHex.toLowerCase() };
    const existing = byVersion.get(normalized.keyVersion);
    if (existing && (existing.secretId !== normalized.secretId || existing.saltHex !== normalized.saltHex)) {
      throw fail("encryption_keyring_conflict", "当前密钥与已保存的同版本密钥信息不一致");
    }
    if (!existing && salts.has(normalized.saltHex)) {
      throw fail("encryption_keyring_invalid", "Vault 不同密钥版本不能复用同一 salt");
    }
    byVersion.set(normalized.keyVersion, normalized);
  }
  if (byVersion.size > MAX_KEY_VERSIONS) {
    throw fail("encryption_keyring_invalid", "Vault 加密密钥版本过多");
  }
  return [...byVersion.values()].sort((a, b) => a.keyVersion - b.keyVersion);
}

/** Adds metadata only; replacing credentials for an existing version is a rotation and must use a migration. */
export function addVaultSyncCryptoKeyDescriptor(
  values: unknown,
  descriptor: VaultSyncCryptoKeyDescriptor,
): VaultSyncCryptoKeyDescriptor[] {
  if (!validDescriptor(descriptor)) {
    throw fail("encryption_keyring_invalid", "Vault 加密密钥信息无效");
  }
  const normalized = normalizeVaultSyncCryptoKeyDescriptors(values);
  const existing = normalized.find((entry) => entry.keyVersion === descriptor.keyVersion);
  if (existing) {
    if (existing.secretId !== descriptor.secretId || existing.saltHex !== descriptor.saltHex.toLowerCase()) {
      throw fail("encryption_key_rotation_required", "不能覆盖已有密钥版本；请通过可恢复的客户端迁移创建新版本");
    }
    return normalized;
  }
  if (normalized.some((entry) => entry.saltHex === descriptor.saltHex.toLowerCase())) {
    throw fail("encryption_key_salt_reused", "新 Vault 密钥版本必须使用新的随机 salt，不能复用旧版本的 salt");
  }
  return normalizeVaultSyncCryptoKeyDescriptors([...normalized, {
    ...descriptor,
    saltHex: descriptor.saltHex.toLowerCase(),
  }]);
}

/** Loads all available device keys, requiring the active key and tolerating missing historical keys. */
export async function loadVaultSyncCryptoKeyring(input: {
  activeKeyVersion: number;
  descriptors: unknown;
  secretStorage: VaultSyncCryptoSecretStorage;
}): Promise<LoadedVaultSyncCryptoKeyring> {
  if (!Number.isSafeInteger(input.activeKeyVersion) || input.activeKeyVersion < 1) {
    throw fail("encryption_keyring_invalid", "当前 Vault 加密密钥版本无效");
  }
  const descriptors = normalizeVaultSyncCryptoKeyDescriptors(input.descriptors);
  const loaded: VaultSyncCrypto[] = [];
  const missing: number[] = [];
  for (const descriptor of descriptors) {
    const passphrase = await input.secretStorage.getSecret(descriptor.secretId);
    if (!passphrase) {
      missing.push(descriptor.keyVersion);
      continue;
    }
    loaded.push(await createVaultSyncCrypto(passphrase, descriptor.saltHex, descriptor.keyVersion));
  }
  const active = loaded.find((key) => key.keyVersion === input.activeKeyVersion);
  if (!active) {
    throw fail("encryption_key_required", `此设备缺少 Vault 加密密钥版本 ${input.activeKeyVersion}`);
  }
  const keyring = createVaultSyncCryptoKeyring(input.activeKeyVersion, loaded);
  return {
    active,
    keyring,
    availableKeyVersions: loaded.map((key) => key.keyVersion),
    missingHistoricalKeyVersions: missing.filter((version) => version !== input.activeKeyVersion),
  };
}
