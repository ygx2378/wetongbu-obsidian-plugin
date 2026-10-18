// Preserve the unbound v1 manifest before v2 bootstrap. Its schema has no API,
// target, or epoch identity, so the v2 engine deliberately never imports it as
// an authoritative baseline; the authenticated server snapshot supplies that.
import type { App, DataAdapter } from "obsidian";
import { sha256Hex } from "./shared/hash.ts";
import { isValidPrevSyncState } from "./vault-sync-local.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";

const SOURCE = ".wetongbu/vault-sync-state.json";
const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VaultSyncV2LegacyArchiveResult {
  status: "absent" | "archived";
  sourceStateValid: boolean;
  sourceDeviceMatches: boolean;
  archivePath?: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",")}}`;
}

function validateIdentity(identity: VaultSyncV2Identity): void {
  let url: URL;
  try { url = new URL(identity.apiBaseUrl); } catch { throw new Error("v2 legacy archive API identity is invalid"); }
  if (!(["https:", "http:"].includes(url.protocol)) || !UUID.test(identity.targetId)
    || !UUID.test(identity.deviceId) || !Number.isSafeInteger(identity.protocolEpoch) || identity.protocolEpoch < 1) {
    throw new Error("v2 legacy archive identity is invalid");
  }
}

/** Copy the old state byte-for-byte; never reinterpret unbound v1 state as v2 IDs. */
export async function archiveLegacyPrevSyncStateForV2(
  app: App,
  identity: VaultSyncV2Identity,
): Promise<VaultSyncV2LegacyArchiveResult> {
  validateIdentity(identity);
  const adapter: DataAdapter = app.vault.adapter;
  if (!(await adapter.exists(SOURCE))) return { status: "absent", sourceStateValid: false, sourceDeviceMatches: false };
  const raw = await adapter.read(SOURCE);
  const sourceHash = await sha256Hex(new TextEncoder().encode(raw));
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* preserve damaged source as evidence */ }
  const sourceStateValid = isValidPrevSyncState(parsed);
  const sourceDeviceMatches = sourceStateValid && (parsed as { deviceId: string }).deviceId === identity.deviceId;
  const archivePath = `${DIR}/legacy-v1-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}-${sourceHash}.json`;
  if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
  if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
  if (await adapter.exists(archivePath)) {
    if (await adapter.read(archivePath) !== raw) throw new Error("Vault v1 状态归档与当前状态摘要冲突");
  } else {
    await adapter.write(archivePath, raw);
    if (await adapter.read(archivePath) !== raw) throw new Error("Vault v1 状态归档回读校验失败");
  }
  const receipt = {
    version: 1,
    identity: { ...identity, apiBaseUrl: new URL(identity.apiBaseUrl).toString().replace(/\/+$/, "") },
    sourceHash,
    sourceStateValid,
    sourceDeviceMatches,
    reusableAsV2Baseline: false,
    reason: "legacy_state_has_no_api_target_epoch_binding_or_server_file_ids",
    archivePath,
  };
  const receiptPath = `${DIR}/legacy-v1-receipt-${identity.targetId}-${identity.deviceId}-e${identity.protocolEpoch}.json`;
  const serialized = stableJson(receipt) + "\n";
  if (await adapter.exists(receiptPath)) {
    try {
      const existing = JSON.parse(await adapter.read(receiptPath));
      if (existing?.sourceHash === sourceHash && existing?.archivePath === archivePath
        && stableJson(existing?.identity) === stableJson(receipt.identity)
        && await adapter.read(archivePath) === raw) {
        return { status: "archived", sourceStateValid, sourceDeviceMatches, archivePath };
      }
    } catch { /* rewrite a damaged migration receipt below */ }
  }
  await adapter.write(receiptPath, serialized);
  if (await adapter.read(receiptPath) !== serialized) throw new Error("Vault v1 状态迁移回执回读校验失败");
  return { status: "archived", sourceStateValid, sourceDeviceMatches, archivePath };
}
