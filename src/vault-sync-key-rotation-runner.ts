import { sha256Hex } from "./shared/hash.ts";
import type { VaultSyncCrypto, VaultSyncCryptoKeyring } from "./shared/vault-sync-crypto.ts";
import type { VaultSyncKeyRotationCheckpoint, VaultSyncKeyRotationStore } from "./vault-sync-key-rotation.ts";
import type {
  VaultSyncV2EncryptionRotation,
  VaultSyncV2EncryptionRotationObject,
  VaultSyncV2EncryptionRotationReservation,
  VaultSyncV2ObjectDownload,
} from "./vault-sync-v2-remote.ts";

export interface VaultSyncKeyRotationRemote {
  getEncryptionKeyRotation(rotationId: string): Promise<VaultSyncV2EncryptionRotation>;
  listEncryptionKeyRotationObjects(input: { rotationId: string; after?: string | null; limit?: number }): Promise<{
    rotationId: string; items: VaultSyncV2EncryptionRotationObject[]; hasMore: boolean; nextAfterObjectId: string | null;
  }>;
  getEncryptionRotationSourceContent(input: { rotationId: string; sourceObjectId: string }): Promise<VaultSyncV2ObjectDownload>;
  prepareEncryptionRotationObject(input: {
    rotationId: string; sourceObjectId: string; operationId: string; ciphertextHash: string; byteSize: number; keyVersion: number;
  }): Promise<VaultSyncV2EncryptionRotationReservation>;
  finalizeEncryptionRotationObject(input: { rotationId: string; sourceObjectId: string; reservationId: string }): Promise<{
    rotationId: string; sourceObjectId: string; objectId: string; status: "switched"; alreadySwitched: boolean;
  }>;
  activateEncryptionKeyRotation(input: { rotationId: string; operationId: string }): Promise<VaultSyncV2EncryptionRotation>;
  completeEncryptionKeyRotation(rotationId: string): Promise<{
    rotationId: string; status: "activated" | "complete"; remainingSourceObjects: string; completed: boolean;
  }>;
}

export interface VaultSyncKeyRotationObjectRequest {
  url: string;
  method: "GET" | "PUT";
  body?: ArrayBuffer;
  throw?: boolean;
}

export interface VaultSyncKeyRotationObjectResponse {
  status: number;
  arrayBuffer?: ArrayBuffer;
}

export interface VaultSyncKeyRotationProgress {
  completedObjects: string;
  totalObjects: string;
  completedSourceBytes: string;
  totalSourceBytes: string;
  currentSourceObjectId: string | null;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sameObject(item: VaultSyncKeyRotationCheckpoint["currentObject"], remote: VaultSyncV2EncryptionRotationObject): boolean {
  return item !== null && item.sourceObjectId.toLowerCase() === remote.sourceObjectId.toLowerCase()
    && item.sourceVersionId.toLowerCase() === remote.sourceVersionId.toLowerCase()
    && item.sourceCiphertextHash === remote.sourceCiphertextHash
    && String(item.sourceByteSize) === remote.sourceByteSize;
}

function assertReservation(reservation: VaultSyncV2EncryptionRotationReservation, rotation: VaultSyncV2EncryptionRotation,
  item: VaultSyncV2EncryptionRotationObject, checkpoint: VaultSyncKeyRotationCheckpoint) {
  const current = checkpoint.currentObject;
  if (!current || reservation.rotationId.toLowerCase() !== rotation.rotationId.toLowerCase()
    || reservation.sourceObjectId.toLowerCase() !== item.sourceObjectId.toLowerCase()
    || current.operationId.toLowerCase() !== (item.replacementOperationId ?? current.operationId).toLowerCase()
    || reservation.keyVersion !== rotation.targetKeyVersion
    || reservation.ciphertextHash !== current.targetCiphertextHash
    || reservation.byteSize !== current.targetByteSize) {
    throw fail("key_rotation_reservation_mismatch", "密钥轮换 reservation 与本机 checkpoint 不一致；已暂停迁移");
  }
}

/** Resumable one-object-at-a-time client-side re-encryption and key activation. */
export async function runVaultSyncKeyRotation(input: {
  remote: VaultSyncKeyRotationRemote;
  requestObject: (request: VaultSyncKeyRotationObjectRequest) => Promise<VaultSyncKeyRotationObjectResponse>;
  store: VaultSyncKeyRotationStore;
  rotation: VaultSyncV2EncryptionRotation;
  sourceKeyring: VaultSyncCryptoKeyring;
  targetCrypto: VaultSyncCrypto;
  onActivated?: (rotation: VaultSyncV2EncryptionRotation) => Promise<void> | void;
  onProgress?: (progress: VaultSyncKeyRotationProgress) => void;
}): Promise<{ checkpoint: VaultSyncKeyRotationCheckpoint; remainingSourceObjects: string; completed: boolean }> {
  const { remote, store, rotation, sourceKeyring, targetCrypto } = input;
  if (targetCrypto.keyVersion !== rotation.targetKeyVersion
    || targetCrypto.saltHex.toLowerCase() !== rotation.targetSaltHex.toLowerCase()) {
    throw fail("key_rotation_target_key_mismatch", "新密钥版本或 salt 与服务端轮换目标不一致");
  }
  let checkpoint = await store.load();
  if (!checkpoint || checkpoint.rotationId !== rotation.rotationId) {
    if (checkpoint && checkpoint.phase !== "complete" && checkpoint.phase !== "aborted") {
      throw fail("key_rotation_in_progress", "此设备已有另一项密钥轮换 checkpoint；保留现场并暂停");
    }
    checkpoint = await store.begin({
      rotationId: rotation.rotationId, sourceKeyVersion: rotation.sourceKeyVersion,
      targetKeyVersion: rotation.targetKeyVersion, sourceSaltHex: rotation.sourceSaltHex,
      targetSaltHex: rotation.targetSaltHex, inventorySnapshotId: rotation.rotationId,
      inventoryHighWatermark: rotation.inventoryHighWatermark, totalObjects: rotation.totalObjects,
      totalSourceBytes: rotation.totalSourceBytes,
    });
  }
  if (checkpoint.rotationId !== rotation.rotationId
    || checkpoint.sourceKeyVersion !== rotation.sourceKeyVersion || checkpoint.targetKeyVersion !== rotation.targetKeyVersion
    || checkpoint.sourceSaltHex !== rotation.sourceSaltHex.toLowerCase()
    || checkpoint.targetSaltHex !== rotation.targetSaltHex.toLowerCase()
    || checkpoint.inventoryHighWatermark !== rotation.inventoryHighWatermark
    || checkpoint.totalObjects !== rotation.totalObjects || checkpoint.totalSourceBytes !== rotation.totalSourceBytes) {
    throw fail("key_rotation_checkpoint_mismatch", "本机 checkpoint 与服务端冻结清单不一致；拒绝继续迁移");
  }

  const latest = await remote.getEncryptionKeyRotation(rotation.rotationId);
  if (latest.status === "aborted") throw fail("key_rotation_aborted", "服务端已中止此密钥轮换");
  if (latest.encryptionDomainId.toLowerCase() !== checkpoint.identity.encryptionDomainId.toLowerCase()) {
    throw fail("key_rotation_identity_mismatch", "轮换清单不属于此加密对象域；拒绝续跑");
  }

  if (latest.status === "activated" || latest.status === "complete") {
    if (!latest.activationOperationId || !latest.activationReceiptId) {
      throw fail("invalid_key_rotation_activation", "服务端激活回执缺少幂等操作身份");
    }
    checkpoint = await store.reconcileActivation({
      rotationId: latest.rotationId, activationOperationId: latest.activationOperationId,
      activationReceiptId: latest.activationReceiptId, activeKeyVersion: latest.targetKeyVersion,
      activeSaltHex: latest.targetSaltHex, completedObjects: latest.totalObjects,
      completedSourceBytes: latest.totalSourceBytes,
    });
    await input.onActivated?.(latest);
    const completion = await remote.completeEncryptionKeyRotation(rotation.rotationId);
    if (completion.completed) checkpoint = await store.markComplete({
      rotationId: completion.rotationId, activeKeyVersion: latest.targetKeyVersion,
      activeSaltHex: latest.targetSaltHex, remainingSourceReferences: completion.remainingSourceObjects,
    });
    return { checkpoint, remainingSourceObjects: completion.remainingSourceObjects, completed: completion.completed };
  }
  if (latest.status === "activation_unknown") {
    if (checkpoint.phase === "activation_pending") checkpoint = await store.markActivationUnknown();
    throw fail("rotation_activation_unknown", "服务端尚未确认密钥激活结果；保留旧/新密钥并暂停同步");
  }
  const sourceCrypto = sourceKeyring.forVersion(rotation.sourceKeyVersion);
  if (!sourceCrypto || sourceCrypto.saltHex.toLowerCase() !== rotation.sourceSaltHex.toLowerCase()) {
    throw fail("key_rotation_source_key_required", "此设备缺少轮换源版本的 Vault 密钥；旧密钥内容保持不变");
  }

  if (!["activated", "complete"].includes(checkpoint.phase)) {
    const initiallyCompletedObjects = BigInt(checkpoint.completedObjects);
    const initiallyCompletedBytes = BigInt(checkpoint.completedSourceBytes);
    let after: string | null = null;
    let ordinal = 0n;
    let inventorySourceBytes = 0n;
    let completedBytesAtCheckpoint = 0n;
    let hasMore = true;
    while (hasMore) {
      const page = await remote.listEncryptionKeyRotationObjects({ rotationId: rotation.rotationId, after, limit: 100 });
      for (const item of page.items) {
        ordinal += 1n;
        inventorySourceBytes += BigInt(item.sourceByteSize);
        if (ordinal <= initiallyCompletedObjects) {
          if (item.status !== "switched") throw fail("key_rotation_checkpoint_mismatch", "服务端已确认进度中的对象不再处于 switched 状态");
          completedBytesAtCheckpoint += BigInt(item.sourceByteSize);
          continue;
        }

        let current = await store.load();
        if (current?.currentObject) {
          if (!sameObject(current.currentObject, item) || ordinal !== BigInt(current.completedObjects) + 1n) {
            throw fail("key_rotation_checkpoint_mismatch", "待续跑对象与服务端冻结清单顺序不一致");
          }
        } else {
          if (ordinal !== BigInt(current?.completedObjects ?? "0") + 1n) {
            throw fail("key_rotation_checkpoint_mismatch", "服务端轮换对象清单出现缺口；保留现场并暂停");
          }
          const operationId = item.replacementOperationId ?? globalThis.crypto.randomUUID();
          current = await store.beginObject({
            ordinal: ordinal.toString(), sourceObjectId: item.sourceObjectId,
            sourceVersionId: item.sourceVersionId, sourceCiphertextHash: item.sourceCiphertextHash,
            sourceByteSize: Number(item.sourceByteSize), operationId,
          });
        }

        const sourceLease = await remote.getEncryptionRotationSourceContent({
          rotationId: rotation.rotationId, sourceObjectId: item.sourceObjectId,
        });
        if (sourceLease.objectId.toLowerCase() !== item.sourceObjectId.toLowerCase()
          || sourceLease.encryptionDomainId.toLowerCase() !== latest.encryptionDomainId.toLowerCase()
          || sourceLease.keyVersion !== rotation.sourceKeyVersion
          || sourceLease.ciphertextHash !== item.sourceCiphertextHash
          || sourceLease.byteSize !== Number(item.sourceByteSize)) {
          throw fail("integrity_mismatch", "轮换源对象 lease 与冻结清单不一致");
        }
        const downloaded = await input.requestObject({ url: sourceLease.downloadUrl, method: "GET", throw: false });
        if (downloaded.status < 200 || downloaded.status >= 300 || !downloaded.arrayBuffer) {
          throw fail(downloaded.status >= 500 || downloaded.status === 429 ? "retryable_storage_error" : "object_download_failed", "轮换源对象暂时无法下载");
        }
        const sourceCiphertext = new Uint8Array(downloaded.arrayBuffer);
        if (sourceCiphertext.byteLength !== sourceLease.byteSize || await sha256Hex(sourceCiphertext) !== sourceLease.ciphertextHash) {
          throw fail("integrity_mismatch", "轮换源对象密文摘要或尺寸校验失败");
        }
        const { plaintext, plaintextHash } = await sourceCrypto.decryptObject(sourceCiphertext);
        const localAfterDownload = await store.load();
        if (localAfterDownload?.currentObject?.phase === "queued") await store.markSourceVerified();
        const targetBytes = await targetCrypto.encryptObject(plaintext, plaintextHash);
        const targetHash = await sha256Hex(targetBytes);
        let local = await store.load();
        if (local?.currentObject?.targetCiphertextHash === null) {
          await store.markTransformed({ ciphertextHash: targetHash, byteSize: targetBytes.byteLength });
        } else if (local?.currentObject?.targetCiphertextHash !== targetHash
          || local.currentObject.targetByteSize !== targetBytes.byteLength) {
          throw fail("key_rotation_transform_mismatch", "重试生成的目标密文与已保存 checkpoint 不一致");
        }

        let reservation = await remote.prepareEncryptionRotationObject({
          rotationId: rotation.rotationId, sourceObjectId: item.sourceObjectId,
          operationId: (await store.load())!.currentObject!.operationId,
          ciphertextHash: targetHash, byteSize: targetBytes.byteLength, keyVersion: rotation.targetKeyVersion,
        });
        local = (await store.load())!;
        assertReservation(reservation, rotation, item, local);
        await store.markPrepared({ reservationId: reservation.reservationId, targetObjectId: reservation.objectId });
        if (reservation.status === "pending") {
          const upload = async (uploadUrl: string) => input.requestObject({
            url: uploadUrl, method: "PUT", body: arrayBuffer(targetBytes), throw: false,
          });
          let response = reservation.uploadUrl ? await upload(reservation.uploadUrl) : { status: 0 };
          if (response.status === 401 || response.status === 403) {
            reservation = await remote.prepareEncryptionRotationObject({
              rotationId: rotation.rotationId, sourceObjectId: item.sourceObjectId,
              operationId: (await store.load())!.currentObject!.operationId,
              ciphertextHash: targetHash, byteSize: targetBytes.byteLength, keyVersion: rotation.targetKeyVersion,
            });
            const renewedState = (await store.load())!;
            assertReservation(reservation, rotation, item, renewedState);
            await store.markPrepared({ reservationId: reservation.reservationId, targetObjectId: reservation.objectId });
            if (reservation.status !== "pending" || !reservation.uploadUrl) response = { status: 200 };
            else response = await upload(reservation.uploadUrl);
          }
          if (response.status < 200 || response.status >= 300) {
            throw fail(response.status >= 500 || response.status === 429 ? "retryable_storage_error" : "object_upload_failed", "轮换对象上传暂未完成；本机 checkpoint 已保留");
          }
        }
        local = (await store.load())!;
        if (local.currentObject?.phase === "prepared") await store.markUploaded();
        const finalized = await remote.finalizeEncryptionRotationObject({
          rotationId: rotation.rotationId, sourceObjectId: item.sourceObjectId,
          reservationId: reservation.reservationId,
        });
        if (finalized.status !== "switched" || finalized.objectId.toLowerCase() !== reservation.objectId.toLowerCase()) {
          throw fail("integrity_mismatch", "服务端未确认轮换对象引用切换");
        }
        const serverTargetHash = item.status === "switched" ? item.replacementCiphertextHash : targetHash;
        const serverTargetSize = item.status === "switched" ? item.replacementByteSize : String(targetBytes.byteLength);
        if (serverTargetHash !== targetHash || serverTargetSize !== String(targetBytes.byteLength)) {
          throw fail("key_rotation_transform_mismatch", "服务端已切换对象与本机重新生成的目标密文不一致");
        }
        await store.markProviderVerified({ ciphertextHash: targetHash, byteSize: targetBytes.byteLength });
        checkpoint = await store.finishObject({ operationId: (await store.load())!.currentObject!.operationId });
        input.onProgress?.({
          completedObjects: checkpoint.completedObjects, totalObjects: checkpoint.totalObjects,
          completedSourceBytes: checkpoint.completedSourceBytes, totalSourceBytes: checkpoint.totalSourceBytes,
          currentSourceObjectId: null,
        });
      }
      if (page.hasMore) {
        if (!page.nextAfterObjectId || page.nextAfterObjectId === after) throw fail("invalid_key_rotation_inventory", "密钥轮换分页游标没有前进");
        after = page.nextAfterObjectId;
      } else hasMore = false;
    }
    checkpoint = (await store.load())!;
    if (checkpoint.currentObject !== null || ordinal.toString() !== rotation.totalObjects
      || inventorySourceBytes.toString() !== rotation.totalSourceBytes
      || completedBytesAtCheckpoint !== initiallyCompletedBytes
      || checkpoint.completedObjects !== rotation.totalObjects
      || checkpoint.completedSourceBytes !== rotation.totalSourceBytes) {
      throw fail("key_rotation_inventory_incomplete", "本机与服务端轮换对象计数或字节数不一致");
    }
    if (checkpoint.phase === "rewriting") checkpoint = await store.markInventoryVerified();
  }

  let serverRotation = await remote.getEncryptionKeyRotation(rotation.rotationId);
  checkpoint = (await store.load())!;
  if (serverRotation.status === "activation_unknown") {
    if (checkpoint.phase === "activation_pending") checkpoint = await store.markActivationUnknown();
    throw fail("rotation_activation_unknown", "服务端尚未确认密钥激活结果；保留旧/新密钥并暂停同步");
  }
  if (serverRotation.status === "activated" || serverRotation.status === "complete") {
    if (checkpoint.phase === "verifying") checkpoint = await store.armActivation({ operationId: serverRotation.activationOperationId ?? undefined });
    if (!serverRotation.activationOperationId || !serverRotation.activationReceiptId) {
      throw fail("invalid_key_rotation_activation", "服务端激活回执缺少幂等操作身份");
    }
    checkpoint = await store.reconcileActivation({
      rotationId: serverRotation.rotationId, activationOperationId: serverRotation.activationOperationId,
      activeKeyVersion: serverRotation.targetKeyVersion, activeSaltHex: serverRotation.targetSaltHex,
      activationReceiptId: serverRotation.activationReceiptId,
      completedObjects: serverRotation.totalObjects, completedSourceBytes: serverRotation.totalSourceBytes,
    });
  } else if (serverRotation.status === "ready_to_activate") {
    if (checkpoint.phase === "verifying") checkpoint = await store.armActivation();
    if (!["activation_pending", "activation_unknown"].includes(checkpoint.phase) || !checkpoint.activationOperationId) {
      throw fail("key_rotation_activation_not_ready", "本机尚未准备好使用稳定的密钥激活操作 ID");
    }
    try {
      serverRotation = await remote.activateEncryptionKeyRotation({
        rotationId: rotation.rotationId, operationId: checkpoint.activationOperationId,
      });
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status);
      if (!Number.isFinite(status) || status >= 500 || status === 429) await store.markActivationUnknown();
      throw error;
    }
    checkpoint = await store.confirmActivation({
      rotationId: serverRotation.rotationId,
      activationOperationId: serverRotation.activationOperationId ?? "",
      activationReceiptId: serverRotation.activationReceiptId ?? "",
      allReferencesSwitched: true, activeKeyVersion: serverRotation.targetKeyVersion,
      activeSaltHex: serverRotation.targetSaltHex,
    });
  } else {
    throw fail("key_rotation_not_ready", "服务端冻结清单尚未进入可激活状态；本机保留迁移进度");
  }

  await input.onActivated?.(serverRotation);
  const completion = await remote.completeEncryptionKeyRotation(rotation.rotationId);
  checkpoint = await store.load() ?? checkpoint;
  if (completion.completed) {
    checkpoint = await store.markComplete({
      rotationId: completion.rotationId, activeKeyVersion: serverRotation.targetKeyVersion,
      activeSaltHex: serverRotation.targetSaltHex, remainingSourceReferences: completion.remainingSourceObjects,
    });
  }
  input.onProgress?.({
    completedObjects: checkpoint.completedObjects, totalObjects: checkpoint.totalObjects,
    completedSourceBytes: checkpoint.completedSourceBytes, totalSourceBytes: checkpoint.totalSourceBytes,
    currentSourceObjectId: null,
  });
  return { checkpoint, remainingSourceObjects: completion.remainingSourceObjects, completed: completion.completed };
}
