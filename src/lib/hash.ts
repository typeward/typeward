/**
 * SHA-256 hex digest of a string or byte buffer via the Web Crypto API.
 *
 * Used to detect whether a file on disk changed underneath an open editor
 * buffer between the time it was loaded and the time it is saved — a full
 * cryptographic digest (rather than a narrow checksum) so remote/attacker-
 * controlled content can't be crafted to collide with a local edit.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  // crypto.subtle wants an ArrayBuffer-backed BufferSource; TextEncoder and
  // Tauri's readFile both return plain (non-shared) buffers, so the narrow is
  // safe.
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
