import { describe, it, expect } from "vitest";
import { unframeMetaBody } from "./ipc-frame";

// Build a frame byte-for-byte the way the Rust `frame_meta_body` does:
// [u32 LE meta-len][meta JSON][body]. Cross-checks that both sides agree on
// the wire layout (endianness, offsets) without a live IPC round trip.
function frame(metaJson: string, body: number[]): ArrayBuffer {
  const meta = new TextEncoder().encode(metaJson);
  const out = new Uint8Array(4 + meta.length + body.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, 4);
  out.set(body, 4 + meta.length);
  return out.buffer;
}

describe("unframeMetaBody", () => {
  it("round-trips metadata and body", () => {
    const buf = frame('{"status":200,"headers":{"x":"y"}}', [0, 1, 2, 255, 254]);
    const { meta, body } = unframeMetaBody<{
      status: number;
      headers: Record<string, string>;
    }>(buf);
    expect(meta.status).toBe(200);
    expect(meta.headers).toEqual({ x: "y" });
    expect(Array.from(body)).toEqual([0, 1, 2, 255, 254]);
  });

  it("handles an empty body", () => {
    const buf = frame('{"etag":null}', []);
    const { meta, body } = unframeMetaBody<{ etag: string | null }>(buf);
    expect(meta.etag).toBeNull();
    expect(body.length).toBe(0);
  });

  it("does not confuse JSON-looking body bytes with metadata", () => {
    const payload = '{"error":"this is the body"}';
    const buf = frame(
      '{"status":404}',
      Array.from(new TextEncoder().encode(payload)),
    );
    const { meta, body } = unframeMetaBody<{ status: number }>(buf);
    expect(meta.status).toBe(404);
    expect(new TextDecoder().decode(body)).toBe(payload);
  });

  it("rejects a buffer too short for the length prefix", () => {
    expect(() => unframeMetaBody(new Uint8Array([1, 2]).buffer)).toThrow();
  });

  it("rejects a metadata length that overruns the payload", () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 9999, true);
    expect(() => unframeMetaBody(bad.buffer)).toThrow();
  });
});
