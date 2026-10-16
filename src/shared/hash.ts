/** Cross-platform SHA-256 helper. Obsidian mobile does not provide node:crypto. */
export { createSha256Accumulator, Sha256Accumulator } from "./sha256-stream.ts";

export async function sha256Hex(body: Uint8Array): Promise<string> {
  // Obsidian's readBinary returns ArrayBuffer-backed bytes. Keep that view so
  // hashing a large note or attachment does not allocate another full-size
  // copy. SharedArrayBuffer-backed views still take the safe copy path because
  // Web Crypto's BufferSource contract requires an ArrayBuffer here.
  const input = body.buffer instanceof ArrayBuffer
    ? body as Uint8Array<ArrayBuffer>
    : body.slice() as Uint8Array<ArrayBuffer>;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
