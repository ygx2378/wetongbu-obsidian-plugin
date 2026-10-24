/**
 * Optional client-side encryption for Vault sync.
 *
 * The server still sees paths, sizes and content hashes (needed for diff and
 * de-duplication), but never receives plaintext file bytes. The per-Vault
 * passphrase stays in Obsidian SecretStorage. PBKDF2 is used because Web
 * Crypto is available on Obsidian mobile without a native dependency.
 */
import { sha256Hex } from "./hash.ts";
import {
  createVaultSyncChunkedObjectCrypto,
  type VaultSyncChunkedObjectResult,
  type VaultSyncCiphertextSource,
  type VaultSyncPlaintextSource,
  type VaultSyncChunkSink,
} from "./vault-sync-chunked-crypto.ts";

const VERSION = 1;
const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

function hexToBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{32}$/i.test(value)) throw new Error("Vault 加密盐值无效");
  const bytes = new Uint8Array(SALT_BYTES);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function deriveAesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < 8) throw new Error("Vault 加密密码至少需要 8 个字符");
  const material = await globalThis.crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase) as Uint8Array<ArrayBuffer>, "PBKDF2", false, ["deriveKey"],
  );
  return globalThis.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as Uint8Array<ArrayBuffer>, iterations: ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deterministicNonce(key: CryptoKey, contentHash: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.sign(
    "HMAC",
    await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(contentHash) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode("wetongbu-vault-sync-nonce") as Uint8Array<ArrayBuffer>,
  );
  // The nonce is derived from the content hash, not from the AES key. Hashes
  // are already visible to the server for de-duplication; deterministic
  // ciphertext therefore does not expose an additional equality signal.
  void key;
  return new Uint8Array(digest).slice(0, NONCE_BYTES);
}

export interface VaultSyncCrypto {
  /** Server object key version this key is allowed to write and decrypt. */
  keyVersion: number;
  saltHex: string;
  encrypt(contentHash: string, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(contentHash: string, ciphertext: Uint8Array): Promise<Uint8Array>;
  /** v2 envelope keeps plaintext hashes inside the client boundary. */
  /** Callers may pass a SHA-256 they just computed for these exact bytes. */
  encryptObject(plaintext: Uint8Array, knownPlaintextHash?: string): Promise<Uint8Array>;
  decryptObject(ciphertext: Uint8Array): Promise<{ plaintext: Uint8Array; plaintextHash: string }>;
}

/** Experimental v3 codec primitives. The active sync writer remains v2 until
 * format negotiation, durable temp-file output, and the reader compatibility
 * fence are integrated. */
export interface VaultSyncChunkedObjectCrypto {
  encryptObjectChunked(
    plaintext: Uint8Array,
    writeCiphertextChunk: VaultSyncChunkSink,
    knownPlaintextHash?: string,
  ): Promise<VaultSyncChunkedObjectResult>;
  encryptObjectChunkedStream(
    plaintext: VaultSyncPlaintextSource,
    plaintextBytes: number,
    writeCiphertextChunk: VaultSyncChunkSink,
    knownPlaintextHash?: string,
  ): Promise<VaultSyncChunkedObjectResult>;
  decryptObjectChunked(
    ciphertext: VaultSyncCiphertextSource,
    writePlaintextChunk: VaultSyncChunkSink,
    expectedPlaintextBytes?: number,
  ): Promise<VaultSyncChunkedObjectResult>;
  decryptObjectChunkedToBytes(ciphertext: Uint8Array): Promise<{ plaintext: Uint8Array; plaintextHash: string }>;
}

export interface VaultSyncCryptoKeyring {
  activeKeyVersion: number;
  forVersion(keyVersion: number): VaultSyncCrypto | undefined;
}

export function assertVaultEncryptionCredentialChangeSafe(input: {
  currentVaultEncrypted: boolean;
  storedPassphrase: string;
  submittedPassphrase: string;
}): void {
  if (input.currentVaultEncrypted && input.storedPassphrase && input.storedPassphrase !== input.submittedPassphrase) {
    throw new Error("不能直接替换已保存的 Vault 密码；必须先完成客户端重加密迁移");
  }
}

export function createVaultSyncCryptoKeyring(
  activeKeyVersion: number,
  keys: VaultSyncCrypto[],
): VaultSyncCryptoKeyring {
  if (!Number.isSafeInteger(activeKeyVersion) || activeKeyVersion < 1) {
    throw new Error("Vault 加密版本无效");
  }
  const byVersion = new Map<number, VaultSyncCrypto>();
  for (const key of keys) {
    if (!Number.isSafeInteger(key.keyVersion) || key.keyVersion < 1 || byVersion.has(key.keyVersion)) {
      throw new Error("Vault 加密密钥版本重复或无效");
    }
    byVersion.set(key.keyVersion, key);
  }
  if (!byVersion.has(activeKeyVersion)) throw new Error("缺少当前 Vault 加密密钥");
  return {
    activeKeyVersion,
    forVersion(keyVersion) { return byVersion.get(keyVersion); },
  };
}

export async function createVaultSyncCrypto(
  passphrase: string,
  saltHex?: string,
  keyVersion = 1,
): Promise<VaultSyncCrypto & VaultSyncChunkedObjectCrypto> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error("Vault 加密版本无效");
  const salt = saltHex ? hexToBytes(saltHex) : globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveAesKey(passphrase, salt);
  const chunkedCrypto = createVaultSyncChunkedObjectCrypto(key);
  return {
    keyVersion,
    saltHex: bytesToHex(salt),
    ...chunkedCrypto,
    async encrypt(contentHash, plaintext) {
      const nonce = await deterministicNonce(key, contentHash);
      const cipher = await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
        key,
        plaintext as Uint8Array<ArrayBuffer>,
      );
      const envelope = new Uint8Array(1 + NONCE_BYTES + cipher.byteLength);
      envelope[0] = VERSION;
      envelope.set(nonce, 1);
      envelope.set(new Uint8Array(cipher), 1 + NONCE_BYTES);
      return envelope;
    },
    async decrypt(contentHash, ciphertext) {
      if (ciphertext.length <= 1 + NONCE_BYTES || ciphertext[0] !== VERSION) throw new Error("Vault 加密文件版本不支持");
      const nonce = await deterministicNonce(key, contentHash);
      const storedNonce = ciphertext.slice(1, 1 + NONCE_BYTES);
      if (bytesToHex(storedNonce) !== bytesToHex(nonce)) throw new Error("Vault 加密文件校验失败");
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
        key,
        ciphertext.slice(1 + NONCE_BYTES) as Uint8Array<ArrayBuffer>,
      );
      const body = new Uint8Array(plain);
      if (await sha256Hex(body) !== contentHash) throw new Error("Vault 解密内容哈希不一致");
      return body;
    },
    async encryptObject(plaintext, knownPlaintextHash) {
      const plaintextHash = knownPlaintextHash ?? await sha256Hex(plaintext);
      if (!/^[a-f0-9]{64}$/i.test(plaintextHash)) throw new Error("Vault v2 明文摘要无效");
      const nonce = await deterministicNonce(key, plaintextHash);
      const cipher = await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
        key,
        plaintext as Uint8Array<ArrayBuffer>,
      );
      const envelope = new Uint8Array(1 + NONCE_BYTES + cipher.byteLength);
      envelope[0] = 2;
      envelope.set(nonce, 1);
      envelope.set(new Uint8Array(cipher), 1 + NONCE_BYTES);
      return envelope;
    },
    async decryptObject(ciphertext) {
      if (ciphertext[0] === 3) return chunkedCrypto.decryptObjectChunkedToBytes(ciphertext);
      if (ciphertext.length < 1 + NONCE_BYTES + 16 || ciphertext[0] !== 2) {
        throw new Error("Vault v2 加密对象版本无效");
      }
      const nonce = ciphertext.slice(1, 1 + NONCE_BYTES);
      const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as Uint8Array<ArrayBuffer> },
        key,
        ciphertext.subarray(1 + NONCE_BYTES) as Uint8Array<ArrayBuffer>,
      ));
      const plaintextHash = await sha256Hex(plaintext);
      const expectedNonce = await deterministicNonce(key, plaintextHash);
      if (bytesToHex(nonce) !== bytesToHex(expectedNonce)) throw new Error("Vault v2 加密对象完整性校验失败");
      return { plaintext, plaintextHash };
    },
  };
}
