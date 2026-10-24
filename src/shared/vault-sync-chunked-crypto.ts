import { Sha256Accumulator } from "./sha256-stream.ts";

const FORMAT_VERSION = 3;
const CHUNK_BYTES = 1024 * 1024;
const HEADER_BYTES = 1 + 4 + 8 + 12;
const GCM_TAG_BYTES = 16;
const MAX_CHUNKS = 0xffff_ffff;

export interface VaultSyncChunkedObjectResult {
  formatVersion: 3;
  plaintextBytes: number;
  plaintextHash: string;
  ciphertextBytes: number;
  chunkBytes: number;
  chunkCount: number;
}

export type VaultSyncChunkSink = (bytes: Uint8Array) => Promise<void> | void;
export type VaultSyncCiphertextSource = Uint8Array | AsyncIterable<Uint8Array>;
export type VaultSyncPlaintextSource = AsyncIterable<Uint8Array>;

function nonceForChunk(base: Uint8Array, index: number): Uint8Array {
  const nonce = base.slice();
  let carry = index;
  for (let offset = nonce.length - 1; offset >= 0 && carry > 0; offset -= 1) {
    const sum = nonce[offset] + (carry % 256);
    nonce[offset] = sum & 0xff;
    carry = Math.floor(carry / 256) + Math.floor(sum / 256);
  }
  if (carry > 0) throw new Error("Vault 分块加密随机数空间不足");
  return nonce;
}

function chunkAad(header: Uint8Array, index: number): Uint8Array {
  const aad = new Uint8Array(header.byteLength + 4);
  aad.set(header);
  new DataView(aad.buffer).setUint32(header.byteLength, index, false);
  return aad;
}

function integrityError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "integrity_mismatch" });
}

function encodeHeader(plaintextBytes: number, nonceBase: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0 || nonceBase.byteLength !== 12) {
    throw new Error("Vault 分块加密参数无效");
  }
  const header = new Uint8Array(HEADER_BYTES);
  header[0] = FORMAT_VERSION;
  const view = new DataView(header.buffer);
  view.setUint32(1, CHUNK_BYTES, false);
  let length = BigInt(plaintextBytes);
  for (let offset = 12; offset >= 5; offset -= 1) {
    header[offset] = Number(length & 0xffn);
    length >>= 8n;
  }
  if (length !== 0n) throw new Error("Vault 分块对象尺寸超出支持范围");
  header.set(nonceBase, 13);
  return header;
}

function parseHeader(header: Uint8Array): { plaintextBytes: number; nonceBase: Uint8Array } {
  if (header.byteLength !== HEADER_BYTES) {
    throw new Error("Vault 分块加密对象头无效");
  }
  if (header[0] !== FORMAT_VERSION) {
    throw Object.assign(new Error("Vault 对象使用其他加密格式"), { code: "chunked_format_unsupported" });
  }
  if (new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(1, false) !== CHUNK_BYTES) {
    throw new Error("Vault 分块加密对象头无效");
  }
  let length = 0n;
  for (let offset = 5; offset <= 12; offset += 1) length = (length << 8n) | BigInt(header[offset]);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Vault 分块对象尺寸无效");
  return { plaintextBytes: Number(length), nonceBase: header.slice(13, 25) };
}

function chunkCountFor(plaintextBytes: number): number {
  const count = Math.max(1, Math.ceil(plaintextBytes / CHUNK_BYTES));
  if (!Number.isSafeInteger(count) || count > MAX_CHUNKS) throw new Error("Vault 分块对象数量超出支持范围");
  return count;
}

function ciphertextBytesFor(plaintextBytes: number, chunkCount: number): number {
  const length = HEADER_BYTES + plaintextBytes + chunkCount * GCM_TAG_BYTES;
  if (!Number.isSafeInteger(length)) throw new Error("Vault 分块密文尺寸超出支持范围");
  return length;
}

export function vaultSyncChunkedCiphertextByteSize(plaintextBytes: number): number {
  return ciphertextBytesFor(plaintextBytes, chunkCountFor(plaintextBytes));
}

class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private offset = 0;
  private finished = false;

  constructor(source: VaultSyncCiphertextSource, private readonly label = "加密对象") {
    const iterable: AsyncIterable<Uint8Array> = source instanceof Uint8Array
      ? (async function* () { yield source; })()
      : source;
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  async readExactly(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Vault 分块读取长度无效");
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.current.byteLength) {
        let next: IteratorResult<Uint8Array>;
        do {
          next = await this.iterator.next();
          if (next.done) {
            this.finished = true;
            throw new Error(`Vault 分块${this.label}被截断`);
          }
        } while (next.value.byteLength === 0);
        this.current = next.value;
        this.offset = 0;
      }
      const count = Math.min(length - written, this.current.byteLength - this.offset);
      result.set(this.current.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
    return result;
  }

  async assertEnd(): Promise<void> {
    if (this.offset < this.current.byteLength) throw new Error(`Vault 分块${this.label}含多余数据`);
    if (this.finished) return;
    while (true) {
      const next = await this.iterator.next();
      if (next.done) {
        this.finished = true;
        return;
      }
      if (next.value.byteLength > 0) throw new Error(`Vault 分块${this.label}含多余数据`);
    }
  }
}

export function createVaultSyncChunkedObjectCrypto(key: CryptoKey) {
  const encryptObjectChunkedStream = async (
    plaintext: VaultSyncPlaintextSource,
    plaintextBytes: number,
    writeCiphertextChunk: VaultSyncChunkSink,
    knownPlaintextHash?: string,
  ): Promise<VaultSyncChunkedObjectResult> => {
    if (knownPlaintextHash !== undefined && !/^[a-f0-9]{64}$/i.test(knownPlaintextHash)) {
      throw new Error("Vault 分块明文摘要无效");
    }
    const chunkCount = chunkCountFor(plaintextBytes);
    const nonceBase = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const header = encodeHeader(plaintextBytes, nonceBase);
    const reader = new ChunkReader(plaintext, "明文");
    const hasher = new Sha256Accumulator();
    await writeCiphertextChunk(header.slice());

    let plaintextOffset = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      const plainSize = Math.min(CHUNK_BYTES, plaintextBytes - plaintextOffset);
      const chunk = await reader.readExactly(plainSize);
      hasher.update(chunk);
      const encrypted = await globalThis.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonceForChunk(nonceBase, index) as Uint8Array<ArrayBuffer>,
          additionalData: chunkAad(header, index) as Uint8Array<ArrayBuffer>,
          tagLength: 128,
        },
        key,
        chunk as Uint8Array<ArrayBuffer>,
      );
      await writeCiphertextChunk(new Uint8Array(encrypted));
      plaintextOffset += plainSize;
    }
    await reader.assertEnd();

    const plaintextHash = hasher.digestHex();
    if (knownPlaintextHash !== undefined && knownPlaintextHash.toLowerCase() !== plaintextHash) {
      throw new Error("Vault 分块加密明文摘要与内容不一致");
    }
    return {
      formatVersion: FORMAT_VERSION,
      plaintextBytes,
      plaintextHash,
      ciphertextBytes: vaultSyncChunkedCiphertextByteSize(plaintextBytes),
      chunkBytes: CHUNK_BYTES,
      chunkCount,
    };
  };

  const decryptObjectChunked = async (
    ciphertext: VaultSyncCiphertextSource,
    writePlaintextChunk: VaultSyncChunkSink,
    expectedPlaintextBytes?: number,
  ): Promise<VaultSyncChunkedObjectResult> => {
    const reader = new ChunkReader(ciphertext);
    let header: Uint8Array;
    try {
      header = await reader.readExactly(HEADER_BYTES);
    } catch {
      throw integrityError("Vault 分块加密对象头被截断");
    }
    let plaintextBytes: number;
    try {
      ({ plaintextBytes } = parseHeader(header));
    } catch (error) {
      if ((error as any)?.code === "chunked_format_unsupported") throw error;
      throw integrityError("Vault 分块加密对象头无效");
    }
    if (expectedPlaintextBytes !== undefined
      && (!Number.isSafeInteger(expectedPlaintextBytes) || expectedPlaintextBytes < 0 || plaintextBytes !== expectedPlaintextBytes)) {
      throw Object.assign(new Error("Vault 分块对象明文尺寸与预期不一致"), { code: "integrity_mismatch" });
    }
    const nonceBase = header.slice(13, 25);
    const chunkCount = chunkCountFor(plaintextBytes);
    const hasher = new Sha256Accumulator();
    let plaintextOffset = 0;

    for (let index = 0; index < chunkCount; index += 1) {
      const plainSize = Math.min(CHUNK_BYTES, plaintextBytes - plaintextOffset);
      let sealed: Uint8Array;
      try {
        sealed = await reader.readExactly(plainSize + GCM_TAG_BYTES);
      } catch {
        throw integrityError("Vault 分块密文被截断");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: nonceForChunk(nonceBase, index) as Uint8Array<ArrayBuffer>,
            additionalData: chunkAad(header, index) as Uint8Array<ArrayBuffer>,
            tagLength: 128,
          },
          key,
          sealed as Uint8Array<ArrayBuffer>,
        ));
      } catch {
        throw integrityError("Vault 分块认证失败");
      }
      if (plaintext.byteLength !== plainSize) throw new Error("Vault 分块解密尺寸不一致");
      hasher.update(plaintext);
      await writePlaintextChunk(plaintext);
      plaintextOffset += plainSize;
    }

    try {
      await reader.assertEnd();
    } catch {
      throw integrityError("Vault 分块加密对象含截断或尾随数据");
    }
    return {
      formatVersion: FORMAT_VERSION,
      plaintextBytes,
      plaintextHash: hasher.digestHex(),
      ciphertextBytes: vaultSyncChunkedCiphertextByteSize(plaintextBytes),
      chunkBytes: CHUNK_BYTES,
      chunkCount,
    };
  };

  const decryptObjectChunkedToBytes = async (ciphertext: Uint8Array): Promise<{
    plaintext: Uint8Array;
    plaintextHash: string;
  }> => {
    if (ciphertext.byteLength < HEADER_BYTES) throw new Error("Vault 分块加密对象被截断");
    const { plaintextBytes } = parseHeader(ciphertext.subarray(0, HEADER_BYTES));
    const expectedCiphertextBytes = vaultSyncChunkedCiphertextByteSize(plaintextBytes);
    if (ciphertext.byteLength !== expectedCiphertextBytes) {
      throw new Error(ciphertext.byteLength < expectedCiphertextBytes
        ? "Vault 分块加密对象被截断"
        : "Vault 分块加密对象含多余数据");
    }
    const plaintext = new Uint8Array(plaintextBytes);
    let offset = 0;
    const result = await decryptObjectChunked(ciphertext, (chunk) => {
      plaintext.set(chunk, offset);
      offset += chunk.byteLength;
    });
    return { plaintext, plaintextHash: result.plaintextHash };
  };

  return {
    async encryptObjectChunked(
      plaintext: Uint8Array,
      writeCiphertextChunk: VaultSyncChunkSink,
      knownPlaintextHash?: string,
    ): Promise<VaultSyncChunkedObjectResult> {
      async function* oneChunk() { yield plaintext; }
      return encryptObjectChunkedStream(oneChunk(), plaintext.byteLength, writeCiphertextChunk, knownPlaintextHash);
    },
    encryptObjectChunkedStream,
    decryptObjectChunked,
    decryptObjectChunkedToBytes,
  };
}
