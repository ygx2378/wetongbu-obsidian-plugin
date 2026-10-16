// Content-free, identity-bound checkpoints for client-side Vault key rotation.
// Plaintext, passphrases, upload URLs, and object bytes never enter this store.
import type { App, DataAdapter } from "obsidian";
import { isValidVaultSyncInt8Decimal } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const SALT = /^[a-f0-9]{32}$/i;
const writeQueues = new WeakMap<object, Map<string, Promise<void>>>();

export interface VaultSyncKeyRotationIdentity {
  apiBaseUrl: string;
  targetId: string;
  deviceId: string;
  protocolEpoch: number;
  encryptionDomainId: string;
}

export type VaultSyncKeyRotationPhase =
  | "rewriting"
  | "verifying"
  | "activation_pending"
  | "activation_unknown"
  | "activated"
  | "complete"
  | "aborted";

export type VaultSyncKeyRotationObjectPhase =
  | "queued"
  | "source_verified"
  | "transformed"
  | "prepared"
  | "uploaded"
  | "provider_verified";

export interface VaultSyncKeyRotationObjectCheckpoint {
  ordinal: string;
  sourceObjectId: string;
  sourceVersionId: string;
  sourceCiphertextHash: string;
  sourceByteSize: number;
  operationId: string;
  phase: VaultSyncKeyRotationObjectPhase;
  targetCiphertextHash: string | null;
  targetByteSize: number | null;
  reservationId: string | null;
  targetObjectId: string | null;
}

export interface VaultSyncKeyRotationCheckpoint {
  schemaVersion: 1;
  generation: string;
  identity: VaultSyncKeyRotationIdentity;
  rotationId: string;
  sourceKeyVersion: number;
  targetKeyVersion: number;
  sourceSaltHex: string;
  targetSaltHex: string;
  inventorySnapshotId: string;
  inventoryHighWatermark: string;
  totalObjects: string;
  totalSourceBytes: string;
  completedObjects: string;
  completedSourceBytes: string;
  phase: VaultSyncKeyRotationPhase;
  currentObject: VaultSyncKeyRotationObjectCheckpoint | null;
  lastCompletedOperationId: string | null;
  activationOperationId: string | null;
  activationReceiptId: string | null;
  digest: string;
}

export interface VaultSyncKeyRotationStore {
  load(): Promise<VaultSyncKeyRotationCheckpoint | null>;
  begin(input: {
    rotationId: string;
    sourceKeyVersion: number;
    targetKeyVersion: number;
    sourceSaltHex: string;
    targetSaltHex: string;
    inventorySnapshotId: string;
    inventoryHighWatermark: string;
    totalObjects: string;
    totalSourceBytes: string;
  }): Promise<VaultSyncKeyRotationCheckpoint>;
  beginObject(input: {
    ordinal: string;
    sourceObjectId: string;
    sourceVersionId: string;
    sourceCiphertextHash: string;
    sourceByteSize: number;
    operationId: string;
  }): Promise<VaultSyncKeyRotationCheckpoint>;
  markSourceVerified(): Promise<VaultSyncKeyRotationCheckpoint>;
  markTransformed(input: { ciphertextHash: string; byteSize: number }): Promise<VaultSyncKeyRotationCheckpoint>;
  markPrepared(input: { reservationId: string; targetObjectId: string }): Promise<VaultSyncKeyRotationCheckpoint>;
  markUploaded(): Promise<VaultSyncKeyRotationCheckpoint>;
  markProviderVerified(input: { ciphertextHash: string; byteSize: number }): Promise<VaultSyncKeyRotationCheckpoint>;
  finishObject(input: { operationId: string }): Promise<VaultSyncKeyRotationCheckpoint>;
  markInventoryVerified(): Promise<VaultSyncKeyRotationCheckpoint>;
  armActivation(input?: { operationId?: string }): Promise<VaultSyncKeyRotationCheckpoint>;
  markActivationUnknown(): Promise<VaultSyncKeyRotationCheckpoint>;
  confirmActivation(input: { rotationId: string; activationOperationId: string; activationReceiptId: string; allReferencesSwitched: true; activeKeyVersion: number; activeSaltHex: string }): Promise<VaultSyncKeyRotationCheckpoint>;
  reconcileActivation(input: {
    rotationId: string; activationOperationId: string; activationReceiptId: string;
    activeKeyVersion: number; activeSaltHex: string; completedObjects: string; completedSourceBytes: string;
  }): Promise<VaultSyncKeyRotationCheckpoint>;
  markComplete(input: { rotationId: string; activeKeyVersion: number; activeSaltHex: string; remainingSourceReferences: string }): Promise<VaultSyncKeyRotationCheckpoint>;
  markAborted(input: { rotationId: string }): Promise<VaultSyncKeyRotationCheckpoint>;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function normalizedIdentity(input: VaultSyncKeyRotationIdentity): VaultSyncKeyRotationIdentity {
  let url: URL;
  try { url = new URL(input.apiBaseUrl); } catch { throw fail("key_rotation_identity_invalid", "密钥迁移 API 地址无效"); }
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || !UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1
    || !UUID.test(input.encryptionDomainId)) {
    throw fail("key_rotation_identity_invalid", "密钥迁移 target、设备、协议或加密域身份无效");
  }
  url.search = "";
  url.hash = "";
  return {
    apiBaseUrl: url.toString().replace(/\/+$/, ""),
    targetId: input.targetId.toLowerCase(),
    deviceId: input.deviceId.toLowerCase(),
    protocolEpoch: input.protocolEpoch,
    encryptionDomainId: input.encryptionDomainId.toLowerCase(),
  };
}

function validObjectCheckpoint(value: unknown, state: Pick<VaultSyncKeyRotationCheckpoint, "completedObjects">): value is VaultSyncKeyRotationObjectCheckpoint {
  if (!exactKeys(value, ["ordinal", "sourceObjectId", "sourceVersionId", "sourceCiphertextHash", "sourceByteSize", "operationId", "phase", "targetCiphertextHash", "targetByteSize", "reservationId", "targetObjectId"])) return false;
  if (typeof value.ordinal !== "string" || !isValidVaultSyncInt8Decimal(value.ordinal, { allowZero: false })
    || BigInt(value.ordinal) !== BigInt(state.completedObjects) + 1n
    || typeof value.sourceObjectId !== "string" || !UUID.test(value.sourceObjectId)
    || typeof value.sourceVersionId !== "string" || !UUID.test(value.sourceVersionId)
    || typeof value.sourceCiphertextHash !== "string" || !SHA256.test(value.sourceCiphertextHash)
    || !Number.isSafeInteger(value.sourceByteSize) || Number(value.sourceByteSize) < 0
    || typeof value.operationId !== "string" || !UUID.test(value.operationId)
    || !["queued", "source_verified", "transformed", "prepared", "uploaded", "provider_verified"].includes(String(value.phase))) return false;
  const hasTransform = ["transformed", "prepared", "uploaded", "provider_verified"].includes(String(value.phase));
  const hasReservation = ["prepared", "uploaded", "provider_verified"].includes(String(value.phase));
  const hasProviderReadback = value.phase === "provider_verified";
  if (hasTransform !== (typeof value.targetCiphertextHash === "string" && SHA256.test(value.targetCiphertextHash)
    && Number.isSafeInteger(value.targetByteSize) && Number(value.targetByteSize) >= 0)) return false;
  if (hasReservation !== (typeof value.reservationId === "string" && UUID.test(value.reservationId)
    && typeof value.targetObjectId === "string" && UUID.test(value.targetObjectId))) return false;
  if (!hasTransform && (value.targetCiphertextHash !== null || value.targetByteSize !== null)) return false;
  if (!hasReservation && (value.reservationId !== null || value.targetObjectId !== null)) return false;
  return true;
}

function validState(value: unknown, identity: VaultSyncKeyRotationIdentity): value is VaultSyncKeyRotationCheckpoint {
  const keys = ["schemaVersion", "generation", "identity", "rotationId", "sourceKeyVersion", "targetKeyVersion", "sourceSaltHex", "targetSaltHex", "inventorySnapshotId", "inventoryHighWatermark", "totalObjects", "totalSourceBytes", "completedObjects", "completedSourceBytes", "phase", "currentObject", "lastCompletedOperationId", "activationOperationId", "activationReceiptId", "digest"];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1
    || typeof value.generation !== "string" || !/^[1-9][0-9]*$/.test(value.generation)
    || !isRecord(value.identity) || stableJson(value.identity) !== stableJson(identity)
    || typeof value.rotationId !== "string" || !UUID.test(value.rotationId)
    || !Number.isSafeInteger(value.sourceKeyVersion) || Number(value.sourceKeyVersion) < 1
    || !Number.isSafeInteger(value.targetKeyVersion) || Number(value.targetKeyVersion) !== Number(value.sourceKeyVersion) + 1
    || typeof value.sourceSaltHex !== "string" || !SALT.test(value.sourceSaltHex)
    || typeof value.targetSaltHex !== "string" || !SALT.test(value.targetSaltHex)
    || value.sourceSaltHex.toLowerCase() === value.targetSaltHex.toLowerCase()
    || typeof value.inventorySnapshotId !== "string" || !UUID.test(value.inventorySnapshotId)
    || typeof value.inventoryHighWatermark !== "string" || !isValidVaultSyncInt8Decimal(value.inventoryHighWatermark)
    || typeof value.totalObjects !== "string" || !isValidVaultSyncInt8Decimal(value.totalObjects)
    || typeof value.totalSourceBytes !== "string" || !isValidVaultSyncInt8Decimal(value.totalSourceBytes)
    || typeof value.completedObjects !== "string" || !isValidVaultSyncInt8Decimal(value.completedObjects)
    || typeof value.completedSourceBytes !== "string" || !isValidVaultSyncInt8Decimal(value.completedSourceBytes)
    || BigInt(value.completedObjects) > BigInt(value.totalObjects)
    || BigInt(value.completedSourceBytes) > BigInt(value.totalSourceBytes)
    || (value.totalObjects === "0" && value.totalSourceBytes !== "0")
    || !["rewriting", "verifying", "activation_pending", "activation_unknown", "activated", "complete", "aborted"].includes(String(value.phase))
    || (value.currentObject !== null && !validObjectCheckpoint(value.currentObject, value as unknown as Pick<VaultSyncKeyRotationCheckpoint, "completedObjects">))
    || (value.lastCompletedOperationId !== null && (typeof value.lastCompletedOperationId !== "string" || !UUID.test(value.lastCompletedOperationId)))
    || (value.activationOperationId !== null && (typeof value.activationOperationId !== "string" || !UUID.test(value.activationOperationId)))
    || (value.activationReceiptId !== null && (typeof value.activationReceiptId !== "string" || !UUID.test(value.activationReceiptId)))
    || typeof value.digest !== "string" || !SHA256.test(value.digest)) return false;
  const phase = value.phase as VaultSyncKeyRotationPhase;
  if (phase === "rewriting" && value.activationOperationId !== null) return false;
  if (["verifying", "activation_pending", "activation_unknown", "activated", "complete"].includes(phase)
    && (value.currentObject !== null || value.completedObjects !== value.totalObjects || value.completedSourceBytes !== value.totalSourceBytes)) return false;
  if (["activation_pending", "activation_unknown", "activated", "complete"].includes(phase) !== (value.activationOperationId !== null)) return false;
  if (["activated", "complete"].includes(phase) !== (value.activationReceiptId !== null)) return false;
  if (phase === "aborted" && (value.activationOperationId !== null || value.activationReceiptId !== null || value.currentObject !== null)) return false;
  return true;
}

function prefixFor(identity: VaultSyncKeyRotationIdentity): string {
  return `${DIR}/key-rotation-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-`;
}

function exclusive<T>(adapter: DataAdapter, key: string, work: () => Promise<T>): Promise<T> {
  let queues = writeQueues.get(adapter as object);
  if (!queues) { queues = new Map(); writeQueues.set(adapter as object, queues); }
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  return (async () => {
    await previous.catch(() => {});
    try { return await work(); }
    finally {
      release();
      if (queues?.get(key) === current) queues.delete(key);
    }
  })();
}

export function createVaultSyncKeyRotationStore(app: App, rawIdentity: VaultSyncKeyRotationIdentity): VaultSyncKeyRotationStore {
  const identity = normalizedIdentity(rawIdentity);
  const adapter: DataAdapter = app.vault.adapter;
  const prefix = prefixFor(identity);

  async function digest(value: unknown): Promise<string> {
    return sha256Hex(new TextEncoder().encode(stableJson(value)));
  }

  async function scan(): Promise<{ state: VaultSyncKeyRotationCheckpoint | null; maxGeneration: bigint; validPaths: string[] }> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const candidates = listed.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(prefix.length, -5);
      return /^\d{20}$/.test(raw) ? [{ path, generation: BigInt(raw) }] : [];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let state: VaultSyncKeyRotationCheckpoint | null = null;
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      maxGeneration = candidate.generation > maxGeneration ? candidate.generation : maxGeneration;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
      if (!validState(parsed, identity)) {
        if (isRecord(parsed) && isRecord(parsed.identity)
          && parsed.identity.targetId === identity.targetId && parsed.identity.deviceId === identity.deviceId
          && parsed.identity.protocolEpoch === identity.protocolEpoch && typeof parsed.identity.apiBaseUrl === "string") {
          throw fail("key_rotation_identity_mismatch", "本地密钥迁移 checkpoint 属于其他 API 环境或加密域；拒绝续跑");
        }
        continue;
      }
      const { digest: savedDigest, ...body } = parsed;
      if (await digest(body) !== savedDigest || parsed.generation !== candidate.generation.toString()) continue;
      state = parsed;
      validPaths.push(candidate.path);
    }
    return { state, maxGeneration, validPaths };
  }

  async function persist(next: Omit<VaultSyncKeyRotationCheckpoint, "generation" | "digest">): Promise<VaultSyncKeyRotationCheckpoint> {
    const current = await scan();
    const generation = current.maxGeneration + 1n;
    const body = { ...next, generation: generation.toString() };
    const checkpoint = { ...body, digest: await digest(body) };
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = prefix + generation.toString().padStart(20, "0") + ".json";
    const serialized = stableJson(checkpoint) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("key_rotation_checkpoint_write_unverified", "密钥迁移 checkpoint 回读失败");
    const check = await scan();
    if (!check.state || check.state.generation !== generation.toString()) {
      throw fail("key_rotation_checkpoint_write_unverified", "密钥迁移 checkpoint 摘要校验失败");
    }
    for (const oldPath of check.validPaths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
    return check.state;
  }

  function copyBase(state: VaultSyncKeyRotationCheckpoint) {
    const { generation: _generation, digest: _digest, ...base } = state;
    return base;
  }

  function currentObject(state: VaultSyncKeyRotationCheckpoint, expected: VaultSyncKeyRotationObjectPhase): VaultSyncKeyRotationObjectCheckpoint {
    if (state.phase !== "rewriting" || !state.currentObject || state.currentObject.phase !== expected) {
      throw fail("key_rotation_object_state_invalid", "密钥迁移对象不在预期 checkpoint 阶段");
    }
    return state.currentObject;
  }

  return {
    async load() { return (await scan()).state; },
    begin(input) {
      return exclusive(adapter, prefix, async () => {
        if (typeof input.sourceSaltHex !== "string" || typeof input.targetSaltHex !== "string") {
          throw fail("key_rotation_checkpoint_invalid", "密钥迁移 salt 格式无效");
        }
        const current = await scan();
        if (current.state?.rotationId === input.rotationId) {
          if (current.state.sourceKeyVersion !== input.sourceKeyVersion
            || current.state.targetKeyVersion !== input.targetKeyVersion
            || current.state.sourceSaltHex !== input.sourceSaltHex.toLowerCase()
            || current.state.targetSaltHex !== input.targetSaltHex.toLowerCase()
            || current.state.inventorySnapshotId !== input.inventorySnapshotId
            || current.state.inventoryHighWatermark !== input.inventoryHighWatermark
            || current.state.totalObjects !== input.totalObjects
            || current.state.totalSourceBytes !== input.totalSourceBytes) {
            throw fail("key_rotation_id_reused", "相同密钥迁移 ID 对应了不同清单或密钥参数");
          }
          return current.state;
        }
        if (current.state && current.state.phase !== "complete" && current.state.phase !== "aborted") {
          throw fail("key_rotation_in_progress", "此 target 已有未完成的密钥迁移 checkpoint");
        }
        const targetSaltHex = input.targetSaltHex.toLowerCase();
        const sourceSaltHex = input.sourceSaltHex.toLowerCase();
        const base = {
          schemaVersion: 1 as const, identity, rotationId: input.rotationId,
          sourceKeyVersion: input.sourceKeyVersion, targetKeyVersion: input.targetKeyVersion,
          sourceSaltHex, targetSaltHex, inventorySnapshotId: input.inventorySnapshotId,
          inventoryHighWatermark: input.inventoryHighWatermark, totalObjects: input.totalObjects,
          totalSourceBytes: input.totalSourceBytes, completedObjects: "0", completedSourceBytes: "0",
          phase: "rewriting" as const, currentObject: null, lastCompletedOperationId: null,
          activationOperationId: null, activationReceiptId: null,
        };
        if (!validState({ ...base, generation: "1", digest: "0".repeat(64) }, identity)
          || !UUID.test(input.rotationId) || !Number.isSafeInteger(input.sourceKeyVersion)
          || input.targetKeyVersion !== input.sourceKeyVersion + 1
          || !SALT.test(input.sourceSaltHex) || !SALT.test(input.targetSaltHex)
          || sourceSaltHex === targetSaltHex || !UUID.test(input.inventorySnapshotId)
          || !isValidVaultSyncInt8Decimal(input.inventoryHighWatermark)
          || !isValidVaultSyncInt8Decimal(input.totalObjects)
          || !isValidVaultSyncInt8Decimal(input.totalSourceBytes)) {
          throw fail("key_rotation_checkpoint_invalid", "密钥迁移开始信息无效或不满足版本/salt 单调性");
        }
        return persist(base);
      });
    },
    beginObject(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state || state.phase !== "rewriting"
          || input.ordinal !== (BigInt(state.completedObjects) + 1n).toString()
          || BigInt(state.completedObjects) >= BigInt(state.totalObjects)
          || !UUID.test(input.sourceObjectId) || !UUID.test(input.sourceVersionId)
          || !SHA256.test(input.sourceCiphertextHash) || !Number.isSafeInteger(input.sourceByteSize)
          || input.sourceByteSize < 0 || !UUID.test(input.operationId)) {
          throw fail("key_rotation_object_invalid", "待迁移对象信息无效、重复或顺序不连续");
        }
        const normalizedInput = { ...input, sourceCiphertextHash: input.sourceCiphertextHash.toLowerCase() };
        if (state.currentObject) {
          if (stableJson({
            ordinal: state.currentObject.ordinal, sourceObjectId: state.currentObject.sourceObjectId,
            sourceVersionId: state.currentObject.sourceVersionId, sourceCiphertextHash: state.currentObject.sourceCiphertextHash,
            sourceByteSize: state.currentObject.sourceByteSize, operationId: state.currentObject.operationId,
          }) === stableJson(normalizedInput)) return state;
          throw fail("key_rotation_object_invalid", "另一个对象已经占用当前迁移 checkpoint");
        }
        return persist({ ...copyBase(state), currentObject: {
          ...normalizedInput, phase: "queued",
          targetCiphertextHash: null, targetByteSize: null, reservationId: null, targetObjectId: null,
        } });
      });
    },
    markSourceVerified() {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state) throw fail("key_rotation_checkpoint_missing", "密钥迁移 checkpoint 不存在");
        const item = state.currentObject;
        if (state.phase === "rewriting" && item && item.phase !== "queued") return state;
        if (!item) throw fail("key_rotation_object_state_invalid", "当前没有正在迁移的对象");
        currentObject(state, "queued");
        return persist({ ...copyBase(state), currentObject: { ...item, phase: "source_verified" } });
      });
    },
    markTransformed(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state) throw fail("key_rotation_checkpoint_missing", "密钥迁移 checkpoint 不存在");
        if (typeof input.ciphertextHash !== "string" || !SHA256.test(input.ciphertextHash)
          || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0) {
          throw fail("key_rotation_transform_invalid", "新密文摘要或尺寸无效");
        }
        if (state.currentObject && ["transformed", "prepared", "uploaded", "provider_verified"].includes(state.currentObject.phase)) {
          if (state.currentObject.targetCiphertextHash === input.ciphertextHash.toLowerCase()
            && state.currentObject.targetByteSize === input.byteSize) return state;
          throw fail("key_rotation_transform_mismatch", "同一迁移对象不能替换已 checkpoint 的新密文");
        }
        const item = currentObject(state, "source_verified");
        return persist({ ...copyBase(state), currentObject: { ...item, phase: "transformed",
          targetCiphertextHash: input.ciphertextHash.toLowerCase(), targetByteSize: input.byteSize } });
      });
    },
    markPrepared(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state) throw fail("key_rotation_checkpoint_missing", "密钥迁移 checkpoint 不存在");
        if (state.currentObject?.phase === "prepared") {
          if (state.currentObject.reservationId === input.reservationId && state.currentObject.targetObjectId === input.targetObjectId) return state;
          if (!UUID.test(input.reservationId) || !UUID.test(input.targetObjectId)) {
            throw fail("key_rotation_reservation_invalid", "密钥迁移对象预留身份无效");
          }
          return persist({ ...copyBase(state), currentObject: { ...state.currentObject, ...input } });
        }
        if (state.currentObject && ["uploaded", "provider_verified"].includes(state.currentObject.phase)) {
          if (state.currentObject.reservationId === input.reservationId && state.currentObject.targetObjectId === input.targetObjectId) return state;
          throw fail("key_rotation_reservation_mismatch", "上传开始后不能替换已 checkpoint 的对象预留");
        }
        const item = currentObject(state, "transformed");
        if (!UUID.test(input.reservationId) || !UUID.test(input.targetObjectId)) {
          throw fail("key_rotation_reservation_invalid", "密钥迁移对象预留身份无效");
        }
        return persist({ ...copyBase(state), currentObject: { ...item, phase: "prepared", ...input } });
      });
    },
    markUploaded() {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state) throw fail("key_rotation_checkpoint_missing", "密钥迁移 checkpoint 不存在");
        if (state.currentObject?.phase === "uploaded" || state.currentObject?.phase === "provider_verified") return state;
        const item = currentObject(state, "prepared");
        return persist({ ...copyBase(state), currentObject: { ...item, phase: "uploaded" } });
      });
    },
    markProviderVerified(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state) throw fail("key_rotation_checkpoint_missing", "密钥迁移 checkpoint 不存在");
        if (state.currentObject?.phase === "provider_verified") {
          if (typeof input.ciphertextHash === "string" && input.ciphertextHash.toLowerCase() === state.currentObject.targetCiphertextHash
            && input.byteSize === state.currentObject.targetByteSize) return state;
          throw fail("key_rotation_provider_readback_mismatch", "重复回读与已验证的新密文不一致");
        }
        const item = currentObject(state, "uploaded");
        if (typeof input.ciphertextHash !== "string" || !SHA256.test(input.ciphertextHash)
          || !Number.isSafeInteger(input.byteSize) || input.byteSize < 0
          || input.ciphertextHash.toLowerCase() !== item.targetCiphertextHash
          || input.byteSize !== item.targetByteSize) {
          throw fail("key_rotation_provider_readback_mismatch", "对象存储回读摘要或尺寸与新密文不符");
        }
        return persist({ ...copyBase(state), currentObject: { ...item, phase: "provider_verified" } });
      });
    },
    finishObject(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state) throw fail("key_rotation_checkpoint_missing", "密钥迁移 checkpoint 不存在");
        if (state.currentObject === null && state.lastCompletedOperationId === input.operationId) return state;
        const item = currentObject(state, "provider_verified");
        if (!UUID.test(input.operationId) || item.operationId !== input.operationId) {
          throw fail("key_rotation_object_state_invalid", "完成确认与当前迁移对象的 operation ID 不一致");
        }
        const completedObjects = (BigInt(state.completedObjects) + 1n).toString();
        const completedSourceBytes = (BigInt(state.completedSourceBytes) + BigInt(item.sourceByteSize)).toString();
        if (BigInt(completedObjects) > BigInt(state.totalObjects)
          || BigInt(completedSourceBytes) > BigInt(state.totalSourceBytes)) {
          throw fail("key_rotation_inventory_overrun", "迁移进度超过冻结清单的对象数或字节数");
        }
        return persist({ ...copyBase(state), completedObjects, completedSourceBytes, currentObject: null,
          lastCompletedOperationId: item.operationId });
      });
    },
    markInventoryVerified() {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (state && ["verifying", "activation_pending", "activation_unknown", "activated", "complete"].includes(state.phase)) return state;
        if (!state || state.phase !== "rewriting" || state.currentObject !== null
          || state.completedObjects !== state.totalObjects || state.completedSourceBytes !== state.totalSourceBytes) {
          throw fail("key_rotation_inventory_incomplete", "冻结清单没有全部完成并通过对象存储回读");
        }
        return persist({ ...copyBase(state), phase: "verifying" });
      });
    },
    armActivation(input: { operationId?: string } = {}) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (state && ["activation_pending", "activation_unknown", "activated", "complete"].includes(state.phase)) return state;
        if (!state || state.phase !== "verifying") throw fail("key_rotation_activation_not_ready", "全量对象回读验证尚未完成");
        const operationId = input.operationId ?? globalThis.crypto.randomUUID();
        if (!UUID.test(operationId)) throw fail("key_rotation_activation_state_invalid", "密钥激活操作 ID 无效");
        return persist({ ...copyBase(state), phase: "activation_pending", activationOperationId: operationId.toLowerCase() });
      });
    },
    markActivationUnknown() {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (state && ["activation_unknown", "activated", "complete"].includes(state.phase)) return state;
        if (!state || state.phase !== "activation_pending") throw fail("key_rotation_activation_state_invalid", "当前没有待查询的密钥切换请求");
        return persist({ ...copyBase(state), phase: "activation_unknown" });
      });
    },
    confirmActivation(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state || !["activation_pending", "activation_unknown", "activated", "complete"].includes(state.phase)
          || input.rotationId !== state.rotationId || !UUID.test(input.activationOperationId)
          || input.activationOperationId.toLowerCase() !== state.activationOperationId
          || !UUID.test(input.activationReceiptId)
          || input.allReferencesSwitched !== true || input.activeKeyVersion !== state.targetKeyVersion
          || typeof input.activeSaltHex !== "string" || !SALT.test(input.activeSaltHex)
          || input.activeSaltHex.toLowerCase() !== state.targetSaltHex
          || (state.activationReceiptId !== null && input.activationReceiptId !== state.activationReceiptId)) {
          throw fail("key_rotation_activation_mismatch", "服务端确认与本机密钥迁移目标不一致；保持旧状态并暂停");
        }
        if (state.phase === "activated" || state.phase === "complete") return state;
        return persist({ ...copyBase(state), phase: "activated", activationReceiptId: input.activationReceiptId });
      });
    },
    reconcileActivation(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (!state || input.rotationId !== state.rotationId || !UUID.test(input.activationOperationId)
          || !UUID.test(input.activationReceiptId) || input.activeKeyVersion !== state.targetKeyVersion
          || typeof input.activeSaltHex !== "string" || !SALT.test(input.activeSaltHex)
          || input.activeSaltHex.toLowerCase() !== state.targetSaltHex
          || input.completedObjects !== state.totalObjects || input.completedSourceBytes !== state.totalSourceBytes
          || (state.activationOperationId !== null && state.activationOperationId !== input.activationOperationId)
          || (state.activationReceiptId !== null && state.activationReceiptId !== input.activationReceiptId)) {
          throw fail("key_rotation_activation_mismatch", "服务端激活回执与本机冻结清单不一致；保持旧状态并暂停");
        }
        if (state.phase === "complete") return state;
        return persist({ ...copyBase(state), completedObjects: state.totalObjects,
          completedSourceBytes: state.totalSourceBytes, currentObject: null, phase: "activated",
          activationOperationId: input.activationOperationId, activationReceiptId: input.activationReceiptId });
      });
    },
    markComplete(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (state?.phase === "complete" && input.rotationId === state.rotationId
          && input.activeKeyVersion === state.targetKeyVersion && typeof input.activeSaltHex === "string"
          && input.activeSaltHex.toLowerCase() === state.targetSaltHex && input.remainingSourceReferences === "0") return state;
        if (!state || state.phase !== "activated" || input.rotationId !== state.rotationId
          || input.activeKeyVersion !== state.targetKeyVersion
          || typeof input.activeSaltHex !== "string" || !SALT.test(input.activeSaltHex)
          || input.activeSaltHex.toLowerCase() !== state.targetSaltHex
          || input.remainingSourceReferences !== "0") {
          throw fail("key_rotation_cleanup_unverified", "服务端尚未确认活动版本正确且旧密钥引用已迁移完毕");
        }
        return persist({ ...copyBase(state), phase: "complete" });
      });
    },
    markAborted(input) {
      return exclusive(adapter, prefix, async () => {
        const state = (await scan()).state;
        if (state?.phase === "aborted" && input.rotationId === state.rotationId) return state;
        if (!state || state.rotationId !== input.rotationId || !["rewriting", "verifying"].includes(state.phase)) {
          throw fail("key_rotation_abort_mismatch", "服务端中止结果与本机密钥迁移阶段不一致；保留 checkpoint 并暂停");
        }
        return persist({ ...copyBase(state), phase: "aborted", currentObject: null });
      });
    },
  };
}
