/** Cross-platform SHA-256 helper. Obsidian mobile does not provide node:crypto. */
export async function sha256Hex(body: Uint8Array): Promise<string> {
  // TypeScript 6 models Uint8Array<ArrayBufferLike> more strictly than the
  // Web Crypto overload. Copy into an ArrayBuffer-backed view at the edge.
  const input = body.slice();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
