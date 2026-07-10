/**
 * Image-attachment intake: magic-byte sniffing, caps, and renderer-side
 * normalization (canvas re-encode when oversized or of an unaccepted type).
 * Both input paths — paste and the file picker — land here before anything
 * reaches a provider. Nothing in this module touches IPC; bytes arrive as
 * DOM `File`/`Blob` objects and leave as base64 in a `ChatAttachment`.
 */

import type { ChatAttachment, ChatMessage } from "~/integrations/types";

/** Providers cap at 4 (matches the tightest UI-sane bound we enforce). */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Per-image base64 cap — the tightest provider limit (Anthropic, 5 MB). */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
/** Whole-request base64 cap — under Gemini's 20 MB inline-data ceiling. */
export const MAX_REQUEST_BASE64_BYTES = 15 * 1024 * 1024;
/** Anthropic's recommended max long edge — also cuts tokens everywhere. */
export const MAX_LONG_EDGE_PX = 1568;

export type AcceptedImageMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

/** Identify the payload by magic bytes — never trust the claimed MIME. */
export function sniffImageMime(bytes: Uint8Array): AcceptedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Sum of attachment base64 bytes across an outbound message list. */
export function totalAttachmentBase64Bytes(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const a of m.attachments ?? []) total += a.base64.length;
  }
  return total;
}

export type NormalizeImageResult =
  | { ok: true; attachment: ChatAttachment }
  | { ok: false; reason: string };

async function decodeBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    if (typeof createImageBitmap === "function") {
      return await createImageBitmap(blob);
    }
  } catch {
    /* fall through to the <img> path */
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

function bitmapSize(bmp: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return "naturalWidth" in bmp
    ? { width: bmp.naturalWidth, height: bmp.naturalHeight }
    : { width: bmp.width, height: bmp.height };
}

async function reencode(
  bmp: ImageBitmap | HTMLImageElement,
  targetMime: "image/png" | "image/jpeg",
  scale: number,
): Promise<Blob | null> {
  const { width, height } = bitmapSize(bmp);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bmp as CanvasImageSource, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), targetMime, targetMime === "image/jpeg" ? 0.9 : undefined),
  );
}

/**
 * Validate + normalize one pasted/picked image. Accepts png/jpeg/webp/gif by
 * magic bytes; anything else (or a long edge over {@link MAX_LONG_EDGE_PX})
 * is canvas-re-encoded. Oversized after re-encode → refused with a reason
 * the caller surfaces as a toast.
 */
export async function normalizeImage(
  input: Blob,
  name?: string,
): Promise<NormalizeImageResult> {
  let blob: Blob = input;
  let bytes = new Uint8Array(await blob.arrayBuffer());
  let mime = sniffImageMime(bytes);

  const bmp = await decodeBitmap(blob);
  if (!bmp) {
    return mime
      ? finish(bytes, mime, name)
      : { ok: false, reason: "Unsupported image type" };
  }
  const { width, height } = bitmapSize(bmp);
  const longEdge = Math.max(width, height);

  if (!mime || longEdge > MAX_LONG_EDGE_PX) {
    const scale = longEdge > MAX_LONG_EDGE_PX ? MAX_LONG_EDGE_PX / longEdge : 1;
    const target = mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const reencoded = await reencode(bmp, target, scale);
    if (!reencoded) return { ok: false, reason: "Couldn't process image" };
    blob = reencoded;
    bytes = new Uint8Array(await blob.arrayBuffer());
    mime = sniffImageMime(bytes);
    if (!mime) return { ok: false, reason: "Couldn't process image" };
  }

  return finish(bytes, mime, name);
}

function finish(
  bytes: Uint8Array,
  mime: AcceptedImageMime,
  name?: string,
): NormalizeImageResult {
  const base64 = encodeBase64(bytes);
  if (base64.length > MAX_IMAGE_BASE64_BYTES) {
    return {
      ok: false,
      reason: `Image is too large (${formatBytes(base64.length)} — max ${formatBytes(MAX_IMAGE_BASE64_BYTES)})`,
    };
  }
  return {
    ok: true,
    attachment: { kind: "image", mime, base64, name, bytes: bytes.length },
  };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
