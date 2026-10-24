// Durable, metadata-only snapshot page staging. A page is written and verified
// before the immutable checkpoint advances. If a crash leaves an unreferenced
// partial page, the same immutable page can be fetched and written again safely.
import type { App, DataAdapter } from "obsidian";
import { isValidVaultSyncInt8Decimal, normalizeVaultPath } from "./shared/vault-sync-protocol.mjs";
import { sha256Hex } from "./shared/hash.ts";
import type { VaultSyncV2SnapshotItem, VaultSyncV2SnapshotPage, VaultSyncV2SnapshotSummary } from "./vault-sync-v2-remote.ts";
import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";

const DIR = ".wetongbu/sync-v2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type VaultSyncV2SnapshotStageStatus = "collecting" | "ready" | "applying" | "applied" | "acknowledged";

export interface VaultSyncV2SnapshotStagedPage {
  startItem: string;
  nextItem: string;
  items: VaultSyncV2SnapshotItem[];
  hasMore: boolean;
  digest: string;
}

export interface VaultSyncV2SnapshotStagePageRef {
  startItem: string;
  nextItem: string;
  path: string;
  digest: string;
}

export interface VaultSyncV2SnapshotStageState {
  generation: string;
  identity: VaultSyncV2Identity;
  summary: VaultSyncV2SnapshotSummary;
  nextItem: string;
  pages: VaultSyncV2SnapshotStagePageRef[];
  status: VaultSyncV2SnapshotStageStatus;
}

export interface VaultSyncV2SnapshotStageStore {
  load(): Promise<VaultSyncV2SnapshotStageState | null>;
  getOrCreateSnapshotRequestId(): Promise<string>;
  rotateSnapshotRequestId(): Promise<string>;
  begin(summary: VaultSyncV2SnapshotSummary): Promise<VaultSyncV2SnapshotStageState>;
  updateSummary(summary: VaultSyncV2SnapshotSummary): Promise<VaultSyncV2SnapshotStageState>;
  persistPage(afterItem: string, page: VaultSyncV2SnapshotPage): Promise<VaultSyncV2SnapshotStageState>;
  markApplying(): Promise<VaultSyncV2SnapshotStageState>;
  markApplied(): Promise<VaultSyncV2SnapshotStageState>;
  markAcknowledged(): Promise<VaultSyncV2SnapshotStageState>;
  readItems(): AsyncGenerator<VaultSyncV2SnapshotItem>;
  discardExpired(now?: Date, serverConfirmedExpired?: boolean): Promise<boolean>;
  clear(): Promise<void>;
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
  return `{${Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableJson(record[key])).join(",")}}`;
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function normalizedIdentity(input: VaultSyncV2Identity): VaultSyncV2Identity {
  let apiBaseUrl: string;
  try {
    const url = new URL(input.apiBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    url.search = "";
    url.hash = "";
    apiBaseUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw fail("snapshot_identity_invalid", "同步服务地址无效");
  }
  if (!UUID.test(input.targetId) || !UUID.test(input.deviceId)
    || !Number.isSafeInteger(input.protocolEpoch) || input.protocolEpoch < 1) {
    throw fail("snapshot_identity_invalid", "同步 target、设备或协议版本无效");
  }
  return { apiBaseUrl, targetId: input.targetId.toLowerCase(), deviceId: input.deviceId.toLowerCase(), protocolEpoch: input.protocolEpoch };
}

function validSummary(value: unknown, epoch: number): value is VaultSyncV2SnapshotSummary {
  return exactKeys(value, ["snapshotId", "protocolEpoch", "snapshotCursor", "scope", "scopeVersion", "status", "itemCount", "expiresAt", "completedAt"])
    && typeof value.snapshotId === "string" && UUID.test(value.snapshotId)
    && value.protocolEpoch === epoch
    && typeof value.snapshotCursor === "string" && isValidVaultSyncInt8Decimal(value.snapshotCursor)
    && typeof value.scope === "string" && ["whole_vault", "root_folder"].includes(value.scope)
    && Number.isSafeInteger(value.scopeVersion) && Number(value.scopeVersion) >= 1
    && ["building", "ready"].includes(String(value.status))
    && typeof value.itemCount === "string" && isValidVaultSyncInt8Decimal(value.itemCount)
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    && (value.completedAt === null || (typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt))));
}

function validItem(value: unknown): value is VaultSyncV2SnapshotItem {
  if (!exactKeys(value, ["item", "fileId", "fileVersionId", "changeCursor", "path", "isDeleted", "byteSize", "mtimeMs", "createdByDeviceId", "content"])
    || typeof value.item !== "string" || !isValidVaultSyncInt8Decimal(value.item, { allowZero: false })
    || typeof value.fileId !== "string" || !UUID.test(value.fileId)
    || typeof value.fileVersionId !== "string" || !UUID.test(value.fileVersionId)
    || typeof value.changeCursor !== "string" || !isValidVaultSyncInt8Decimal(value.changeCursor, { allowZero: false })
    || typeof value.path !== "string" || normalizeVaultPath(value.path) !== value.path
    || typeof value.isDeleted !== "boolean"
    || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0
    || !Number.isSafeInteger(value.mtimeMs) || Number(value.mtimeMs) < 0
    || (value.createdByDeviceId !== null && (typeof value.createdByDeviceId !== "string" || !UUID.test(value.createdByDeviceId)))) return false;
  if (value.isDeleted) return value.content === null;
  if (exactKeys(value.content, ["kind", "objectId", "encryptionDomainId", "keyVersion", "ciphertextHash", "byteSize"])) {
    return value.content.kind === "object" && typeof value.content.objectId === "string" && UUID.test(value.content.objectId)
      && typeof value.content.encryptionDomainId === "string" && UUID.test(value.content.encryptionDomainId)
      && Number.isSafeInteger(value.content.keyVersion) && Number(value.content.keyVersion) >= 1
      && typeof value.content.ciphertextHash === "string" && SHA256.test(value.content.ciphertextHash)
      && Number.isSafeInteger(value.content.byteSize) && Number(value.content.byteSize) >= 0;
  }
  return exactKeys(value.content, ["kind", "contentHash", "byteSize"])
    && value.content.kind === "legacy"
    && (value.content.contentHash === null || (typeof value.content.contentHash === "string" && SHA256.test(value.content.contentHash)))
    && Number.isSafeInteger(value.content.byteSize) && Number(value.content.byteSize) >= 0;
}

function statePrefix(identity: VaultSyncV2Identity): string {
  return DIR + "/snapshot-state-" + identity.targetId + "-" + identity.deviceId + "-e" + identity.protocolEpoch + "-";
}

function requestPrefix(identity: VaultSyncV2Identity): string {
  return DIR + "/snapshot-request-" + identity.targetId + "-" + identity.deviceId + "-e" + identity.protocolEpoch + "-";
}

function validateFixedSummary(current: VaultSyncV2SnapshotSummary, next: VaultSyncV2SnapshotSummary): void {
  if (current.snapshotId !== next.snapshotId || current.protocolEpoch !== next.protocolEpoch
    || current.snapshotCursor !== next.snapshotCursor || current.scope !== next.scope
    || current.scopeVersion !== next.scopeVersion) {
    throw fail("snapshot_stage_identity_changed", "固定快照身份、游标或 scope 发生变化");
  }
}

export function createVaultSyncV2SnapshotStageStore(app: App, rawIdentity: VaultSyncV2Identity): VaultSyncV2SnapshotStageStore {
  const identity = normalizedIdentity(rawIdentity);
  const adapter: DataAdapter = app.vault.adapter;
  const prefix = statePrefix(identity);
  const creationRequestPrefix = requestPrefix(identity);
  let serial: Promise<unknown> = Promise.resolve();

  async function digest(value: unknown): Promise<string> {
    return sha256Hex(new TextEncoder().encode(stableJson(value)));
  }

  function validState(value: unknown): value is VaultSyncV2SnapshotStageState & { digest: string } {
    if (!exactKeys(value, ["generation", "identity", "summary", "nextItem", "pages", "status", "digest"])) return false;
    if (typeof value.generation !== "string" || !CURSOR.test(value.generation)
      || !isRecord(value.identity) || stableJson(value.identity) !== stableJson(identity)
      || !validSummary(value.summary, identity.protocolEpoch)
      || typeof value.nextItem !== "string" || !isValidVaultSyncInt8Decimal(value.nextItem)
      || !Array.isArray(value.pages)
      || !["collecting", "ready", "applying", "applied", "acknowledged"].includes(String(value.status))
      || typeof value.digest !== "string" || !SHA256.test(value.digest)) return false;
    let next = 0n;
    for (const page of value.pages) {
      if (!exactKeys(page, ["startItem", "nextItem", "path", "digest"])
        || typeof page.startItem !== "string" || !isValidVaultSyncInt8Decimal(page.startItem)
        || typeof page.nextItem !== "string" || !isValidVaultSyncInt8Decimal(page.nextItem)
        || typeof page.path !== "string" || !page.path.startsWith(DIR + "/snapshot-page-")
        || typeof page.digest !== "string" || !SHA256.test(page.digest)
        || BigInt(page.startItem) !== next || BigInt(page.nextItem) < next) return false;
      next = BigInt(page.nextItem);
    }
    if (next.toString() !== value.nextItem) return false;
    if (["ready", "applying", "applied", "acknowledged"].includes(String(value.status))
      && (value.summary.status !== "ready" || value.nextItem !== value.summary.itemCount)) return false;
    return true;
  }

  async function scan(): Promise<{ state: VaultSyncV2SnapshotStageState | null; maxGeneration: bigint; validPaths: string[] }> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const candidates = listed.files.flatMap((path) => {
      if (!path.startsWith(prefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(prefix.length, -5);
      if (!/^\d{20}$/.test(raw)) return [];
      return [{ path, generation: BigInt(raw) }];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let state: VaultSyncV2SnapshotStageState | null = null;
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      maxGeneration = candidate.generation > maxGeneration ? candidate.generation : maxGeneration;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
      if (!validState(parsed)) {
        if (isRecord(parsed) && isRecord(parsed.identity)
          && parsed.identity.targetId === identity.targetId && parsed.identity.deviceId === identity.deviceId
          && parsed.identity.protocolEpoch === identity.protocolEpoch && typeof parsed.identity.apiBaseUrl === "string") {
          throw fail("snapshot_identity_mismatch", "本地快照属于其他 API 环境；拒绝跨环境续传");
        }
        continue;
      }
      const { digest: savedDigest, ...withoutDigest } = parsed;
      if (await digest(withoutDigest) !== savedDigest || parsed.generation !== candidate.generation.toString()) continue;
      state = parsed;
      validPaths.push(candidate.path);
    }
    return { state, maxGeneration, validPaths };
  }

  async function persist(state: Omit<VaultSyncV2SnapshotStageState, "generation">): Promise<VaultSyncV2SnapshotStageState> {
    const current = await scan();
    const generation = (current.maxGeneration + 1n).toString();
    const base = { ...state, generation };
    const snapshot = { ...base, digest: await digest(base) };
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = prefix + generation.padStart(20, "0") + ".json";
    const serialized = stableJson(snapshot) + "\n";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("snapshot_stage_write_unverified", "快照 checkpoint 回读校验失败");
    const check = await scan();
    if (!check.state || check.state.generation !== generation) throw fail("snapshot_stage_write_unverified", "快照 checkpoint 摘要校验失败");
    for (const oldPath of check.validPaths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
    return check.state;
  }

  async function writePage(snapshotId: string, startItem: string, body: Omit<VaultSyncV2SnapshotStagedPage, "digest" | "startItem">): Promise<VaultSyncV2SnapshotStagePageRef> {
    const base = { ...body, startItem };
    const pageDigest = await digest(base);
    const path = DIR + "/snapshot-page-" + identity.targetId + "-" + snapshotId + "-" + startItem.padStart(20, "0") + ".json";
    const serialized = stableJson({ ...base, digest: pageDigest }) + "\n";
    if (await adapter.exists(path)) {
      let existing: string | null = null;
      try { existing = await adapter.read(path); } catch { /* an unreferenced torn page is safe to replace */ }
      if (existing === serialized) return { startItem, nextItem: body.nextItem, path, digest: pageDigest };
      // persistPage calls writePage only when no valid checkpoint references
      // this snapshot/item path. Referenced pages are validated through readPage
      // before this point, so replacing an orphan cannot erase committed data.
    }
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("snapshot_stage_write_unverified", "快照页回读校验失败");
    return { startItem, nextItem: body.nextItem, path, digest: pageDigest };
  }

  async function readPage(ref: VaultSyncV2SnapshotStagePageRef, snapshotId: string): Promise<VaultSyncV2SnapshotStagedPage> {
    let parsed: unknown;
    try { parsed = JSON.parse(await adapter.read(ref.path)); } catch {
      throw fail("snapshot_stage_page_corrupt", "本地快照页缺失或损坏，需要重新获取");
    }
    if (!exactKeys(parsed, ["startItem", "nextItem", "items", "hasMore", "digest"])
      || typeof parsed.startItem !== "string" || parsed.startItem !== ref.startItem
      || typeof parsed.nextItem !== "string" || parsed.nextItem !== ref.nextItem
      || typeof parsed.hasMore !== "boolean" || !Array.isArray(parsed.items)
      || !parsed.items.every(validItem) || typeof parsed.digest !== "string" || parsed.digest !== ref.digest) {
      throw fail("snapshot_stage_page_corrupt", "本地快照页结构无效");
    }
    const { digest: savedDigest, ...withoutDigest } = parsed;
    if (await digest(withoutDigest) !== savedDigest) throw fail("snapshot_stage_page_corrupt", "本地快照页摘要不匹配");
    let expected = BigInt(ref.startItem) + 1n;
    for (const item of parsed.items as VaultSyncV2SnapshotItem[]) {
      if (BigInt(item.item) !== expected) throw fail("snapshot_stage_page_corrupt", "本地快照页项目游标不连续");
      expected += 1n;
    }
    if (parsed.items.length && parsed.items.at(-1)?.item !== parsed.nextItem) {
      throw fail("snapshot_stage_page_corrupt", "本地快照页末尾游标不匹配");
    }
    if (!parsed.items.length && parsed.startItem !== parsed.nextItem) throw fail("snapshot_stage_page_corrupt", "空快照页游标不匹配");
    return parsed as unknown as VaultSyncV2SnapshotStagedPage;
  }

  async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = serial;
    let release!: () => void;
    serial = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => {});
    try { return await work(); } finally { release(); }
  }

  async function scanCreationRequest(): Promise<{ requestId: string | null; maxGeneration: bigint; paths: string[] }> {
    const listed = await adapter.list(DIR).catch(() => ({ files: [], folders: [] }));
    const candidates = listed.files.flatMap((path) => {
      if (!path.startsWith(creationRequestPrefix) || !path.endsWith(".json")) return [];
      const raw = path.slice(creationRequestPrefix.length, -5);
      if (!/^\d{20}$/.test(raw)) return [];
      return [{ path, generation: BigInt(raw) }];
    }).sort((a, b) => a.generation < b.generation ? -1 : a.generation > b.generation ? 1 : 0);
    let requestId: string | null = null;
    let maxGeneration = 0n;
    const validPaths: string[] = [];
    for (const candidate of candidates) {
      maxGeneration = candidate.generation > maxGeneration ? candidate.generation : maxGeneration;
      let parsed: unknown;
      try { parsed = JSON.parse(await adapter.read(candidate.path)); } catch { continue; }
      if (!exactKeys(parsed, ["generation", "identity", "snapshotRequestId", "digest"])
        || parsed.generation !== candidate.generation.toString()
        || !isRecord(parsed.identity) || stableJson(parsed.identity) !== stableJson(identity)
        || typeof parsed.snapshotRequestId !== "string" || !UUID.test(parsed.snapshotRequestId)
        || typeof parsed.digest !== "string" || !SHA256.test(parsed.digest)) continue;
      const { digest: savedDigest, ...withoutDigest } = parsed;
      if (await digest(withoutDigest) !== savedDigest) continue;
      requestId = parsed.snapshotRequestId;
      validPaths.push(candidate.path);
    }
    return { requestId, maxGeneration, paths: validPaths };
  }

  async function persistCreationRequestId(requestId: string): Promise<string> {
    if (!UUID.test(requestId)) throw fail("snapshot_request_id_invalid", "快照请求标识无效");
    const current = await scanCreationRequest();
    const generation = (current.maxGeneration + 1n).toString();
    const base = { generation, identity, snapshotRequestId: requestId };
    const serialized = stableJson({ ...base, digest: await digest(base) }) + "\n";
    if (!(await adapter.exists(".wetongbu"))) await adapter.mkdir(".wetongbu");
    if (!(await adapter.exists(DIR))) await adapter.mkdir(DIR);
    const path = creationRequestPrefix + generation.padStart(20, "0") + ".json";
    await adapter.write(path, serialized);
    if (await adapter.read(path) !== serialized) throw fail("snapshot_request_id_write_unverified", "快照请求标识回读校验失败");
    const verified = await scanCreationRequest();
    if (verified.requestId !== requestId || !verified.paths.includes(path)) {
      throw fail("snapshot_request_id_write_unverified", "快照请求标识摘要校验失败");
    }
    for (const oldPath of verified.paths.slice(0, -2)) await adapter.remove(oldPath).catch(() => {});
    return requestId;
  }

  return {
    async load() { return (await scan()).state; },
    getOrCreateSnapshotRequestId() {
      return runExclusive(async () => {
        const current = await scanCreationRequest();
        if (current.requestId) return current.requestId;
        return persistCreationRequestId(crypto.randomUUID());
      });
    },
    rotateSnapshotRequestId() {
      return runExclusive(async () => persistCreationRequestId(crypto.randomUUID()));
    },
      begin(summary) {
      return runExclusive(async () => {
        if (!validSummary(summary, identity.protocolEpoch)) throw fail("snapshot_stage_summary_invalid", "服务端快照摘要无效");
        const current = await scan();
        if (current.state && current.state.status !== "acknowledged") {
          validateFixedSummary(current.state.summary, summary);
          return persist({ identity, summary, nextItem: current.state.nextItem, pages: current.state.pages, status: current.state.status });
        }
        const next = await persist({ identity, summary, nextItem: "0", pages: [], status: "collecting" });
        for (const page of current.state?.pages ?? []) await adapter.remove(page.path).catch(() => {});
        return next;
      });
    },
    updateSummary(summary) {
      return runExclusive(async () => {
        const current = await scan();
        if (!current.state) throw fail("snapshot_stage_missing", "本地没有正在接收的快照");
        if (!validSummary(summary, identity.protocolEpoch)) throw fail("snapshot_stage_summary_invalid", "服务端快照摘要无效");
        validateFixedSummary(current.state.summary, summary);
        if (current.state.status !== "collecting" && current.state.status !== "ready") return current.state;
        return persist({ identity, summary, nextItem: current.state.nextItem, pages: current.state.pages, status: current.state.status });
      });
    },
    persistPage(afterItem, page) {
      return runExclusive(async () => {
        const current = await scan();
        if (!current.state) throw fail("snapshot_stage_missing", "本地没有正在接收的快照");
        if (!isValidVaultSyncInt8Decimal(afterItem) || !page || page.protocolEpoch !== identity.protocolEpoch
          || page.status !== "ready" || page.snapshotId !== current.state.summary.snapshotId
          || page.snapshotCursor !== current.state.summary.snapshotCursor
          || page.scope !== current.state.summary.scope || page.scopeVersion !== current.state.summary.scopeVersion
          || !isValidVaultSyncInt8Decimal(page.itemCount) || !isValidVaultSyncInt8Decimal(page.nextItem)
          || !isValidVaultSyncInt8Decimal(page.minReplayCursor)
          || !Array.isArray(page.items) || typeof page.hasMore !== "boolean"
          || !Number.isFinite(Date.parse(page.expiresAt))) {
          throw fail("snapshot_stage_page_invalid", "服务端快照页不符合当前固定快照");
        }
        const start = BigInt(afterItem);
        const end = BigInt(page.nextItem);
        const known = current.state.pages.find((entry) => entry.startItem === afterItem);
        if (known) {
          const staged = await readPage(known, page.snapshotId);
          const same = stableJson({ startItem: afterItem, nextItem: page.nextItem, items: page.items, hasMore: page.hasMore })
            === stableJson({ startItem: staged.startItem, nextItem: staged.nextItem, items: staged.items, hasMore: staged.hasMore });
          if (!same) throw fail("snapshot_stage_page_mismatch", "重复快照页与已持久化内容不一致");
          return current.state;
        }
        if (current.state.status !== "collecting" || start !== BigInt(current.state.nextItem)
          || BigInt(page.itemCount) < end || end < start
          || page.hasMore !== (end < BigInt(page.itemCount))) {
          throw fail("snapshot_stage_cursor_invalid", "快照页没有从已持久化位置连续推进");
        }
        let expected = start + 1n;
        for (const item of page.items) {
          if (!validItem(item) || BigInt(item.item) !== expected) throw fail("snapshot_stage_item_invalid", "快照项无效或游标不连续");
          expected += 1n;
        }
        const actualEnd = page.items.length ? BigInt(page.items.at(-1)!.item) : start;
        if (actualEnd !== end || (!page.items.length && page.hasMore)) {
          throw fail("snapshot_stage_page_boundary_invalid", "快照项与页游标边界不一致");
        }
        if (!page.hasMore && end !== BigInt(page.itemCount)) throw fail("snapshot_stage_page_boundary_invalid", "完整快照页必须到达项目总数");
        const pageRef = await writePage(page.snapshotId, afterItem, {
          nextItem: page.nextItem, items: page.items, hasMore: page.hasMore,
        });
        const status = page.hasMore ? "collecting" : "ready";
        return persist({
          identity,
          summary: {
            snapshotId: page.snapshotId, protocolEpoch: page.protocolEpoch,
            snapshotCursor: page.snapshotCursor, scope: page.scope, scopeVersion: page.scopeVersion,
            status: "ready", itemCount: page.itemCount, expiresAt: page.expiresAt, completedAt: page.completedAt,
          },
          nextItem: page.nextItem, pages: [...current.state.pages, pageRef], status,
        });
      });
    },
    markApplying() {
      return runExclusive(async () => {
        const state = (await scan()).state;
        if (!state || state.status !== "ready") throw fail("snapshot_stage_not_ready", "快照页尚未完整落盘");
        return persist({ identity, summary: state.summary, nextItem: state.nextItem, pages: state.pages, status: "applying" });
      });
    },
    markApplied() {
      return runExclusive(async () => {
        const state = (await scan()).state;
        if (!state || state.status !== "applying") throw fail("snapshot_stage_apply_state_invalid", "快照尚未进入应用状态");
        return persist({ identity, summary: state.summary, nextItem: state.nextItem, pages: state.pages, status: "applied" });
      });
    },
    markAcknowledged() {
      return runExclusive(async () => {
        const state = (await scan()).state;
        if (!state || state.status !== "applied") throw fail("snapshot_stage_ack_state_invalid", "本地快照尚未完整应用");
        return persist({ identity, summary: state.summary, nextItem: state.nextItem, pages: state.pages, status: "acknowledged" });
      });
    },
    async *readItems() {
      const state = (await scan()).state;
      if (!state || !["ready", "applying", "applied", "acknowledged"].includes(state.status)) {
        throw fail("snapshot_stage_not_ready", "快照页尚未完整落盘");
      }
      for (const ref of state.pages) {
        const page = await readPage(ref, state.summary.snapshotId);
        for (const item of page.items) yield item;
      }
    },
    discardExpired(now = new Date(), serverConfirmedExpired = false) {
      return runExclusive(async () => {
        const current = await scan();
        if (!current.state || (!serverConfirmedExpired && Date.parse(current.state.summary.expiresAt) > now.getTime())) return false;
        for (const page of current.state.pages) await adapter.remove(page.path).catch(() => {});
        for (const path of current.validPaths) await adapter.remove(path).catch(() => {});
        await persistCreationRequestId(crypto.randomUUID());
        return true;
      });
    },
    clear() {
      return runExclusive(async () => {
        const state = await scan();
        if (state.state && state.state.status !== "acknowledged") throw fail("snapshot_stage_clear_unsafe", "只有服务端确认后的快照 staging 才能清理");
        const request = await scanCreationRequest();
        for (const path of request.paths) await adapter.remove(path);
        for (const page of state.state?.pages ?? []) await adapter.remove(page.path).catch(() => {});
        for (const path of state.validPaths) await adapter.remove(path).catch(() => {});
      });
    },
  };
}
