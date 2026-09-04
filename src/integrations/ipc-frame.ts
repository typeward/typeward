/**
 * Parse a raw IPC body framed as `[u32 LE meta-len][meta JSON][body bytes]` —
 * the exact layout `crate::integrations::ipc::frame_meta_body` emits.
 *
 * This lets a Tauri command return a large binary body over the raw IPC channel
 * (an `ArrayBuffer`, no ~3-4x JSON number-array bloat) while still carrying a
 * small JSON metadata header (status/headers, etag, ...). The length prefix is
 * authoritative, so a body that contains JSON-looking bytes is never mis-split.
 */
export function unframeMetaBody<M>(buf: ArrayBuffer): {
  meta: M;
  body: Uint8Array;
} {
  if (buf.byteLength < 4) {
    throw new Error("framed IPC response too short for a length prefix");
  }
  const metaLen = new DataView(buf).getUint32(0, true);
  if (4 + metaLen > buf.byteLength) {
    throw new Error("framed IPC metadata length exceeds the payload");
  }
  const meta = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buf, 4, metaLen)),
  ) as M;
  return { meta, body: new Uint8Array(buf, 4 + metaLen) };
}
