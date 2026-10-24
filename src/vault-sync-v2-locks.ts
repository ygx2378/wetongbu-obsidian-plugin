import type { VaultSyncV2Identity } from "./vault-sync-outbox.ts";

const stateWriteTails = new Map<string, Promise<void>>();
const fileOperationTails = new Map<string, Promise<void>>();

function identityKey(identity: VaultSyncV2Identity): string {
  const url = new URL(identity.apiBaseUrl);
  url.search = "";
  url.hash = "";
  return [url.toString().replace(/\/+$/, ""), identity.targetId.toLowerCase(),
    identity.deviceId.toLowerCase(), String(identity.protocolEpoch)].join("\u0000");
}

async function runExclusive<T>(tails: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}

/** Serialize short local snapshot read-modify-write transactions across store instances. */
export function withVaultSyncV2StateWriteLock<T>(
  identity: VaultSyncV2Identity,
  work: () => Promise<T>,
): Promise<T> {
  return runExclusive(stateWriteTails, identityKey(identity), work);
}

/** Serialize remote operations for one file while allowing other files to progress. */
export function withVaultSyncV2FileOperationLock<T>(
  identity: VaultSyncV2Identity,
  fileId: string,
  work: () => Promise<T>,
): Promise<T> {
  return runExclusive(fileOperationTails, `${identityKey(identity)}\u0000${fileId.toLowerCase()}`, work);
}

/** Run file work only when its per-file lane is idle; sync rounds must not wait behind reviewed-delete network calls. */
export async function tryWithVaultSyncV2FileOperationLock<T>(
  identity: VaultSyncV2Identity,
  fileId: string,
  work: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const key = `${identityKey(identity)}\u0000${fileId.toLowerCase()}`;
  if (fileOperationTails.has(key)) return { acquired: false };
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileOperationTails.set(key, current);
  try {
    return { acquired: true, value: await work() };
  } finally {
    release();
    if (fileOperationTails.get(key) === current) fileOperationTails.delete(key);
  }
}
