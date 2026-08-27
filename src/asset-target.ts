import { sha256Hex } from "./shared/hash.ts";

interface AssetStat {
  type: string;
}

export interface AssetTargetAdapter {
  stat(path: string): Promise<AssetStat | null>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

function addHashSuffix(path: string, hash: string, attempt: number) {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  const suffix = attempt === 0 ? hash.slice(0, 8) : `${hash.slice(0, 8)}-${attempt + 1}`;
  return `${directory}${stem}-${suffix}${extension}`;
}

/** Reuse identical attachments and avoid overwriting a different existing file. */
export async function resolveAssetTarget(
  adapter: AssetTargetAdapter,
  desiredPath: string,
  body: Uint8Array,
) {
  const incomingHash = await sha256Hex(body);
  let candidate = desiredPath;
  for (let attempt = 0; attempt <= 10; attempt += 1) {
    const stat = await adapter.stat(candidate);
    if (!stat) return { targetPath: candidate, writeLocal: true };
    if (stat.type === "file") {
      const existing = new Uint8Array(await adapter.readBinary(candidate));
      if (existing.byteLength === body.byteLength && await sha256Hex(existing) === incomingHash) {
        return { targetPath: candidate, writeLocal: false };
      }
    }
    candidate = addHashSuffix(desiredPath, incomingHash, attempt);
  }
  throw new Error(`附件目标冲突次数过多：${desiredPath}`);
}
