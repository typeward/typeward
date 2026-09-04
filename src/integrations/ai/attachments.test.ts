import { describe, expect, it } from "vitest";

import type { ChatMessage } from "~/integrations/types";
import {
  MAX_IMAGE_BASE64_BYTES,
  MAX_REQUEST_BASE64_BYTES,
  encodeBase64,
  formatBytes,
  sniffImageMime,
  totalAttachmentBase64Bytes,
} from "./attachments";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x2b, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

describe("sniffImageMime", () => {
  it("identifies the four accepted formats by magic bytes", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(GIF)).toBe("image/gif");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });

  it("rejects unknown payloads regardless of extension claims", () => {
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d, 0x36, 0x00]))).toBeNull(); // BMP
    expect(sniffImageMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
    // RIFF container that is not WEBP (e.g. WAV) must not pass.
    expect(
      sniffImageMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBeNull();
  });
});

describe("encodeBase64", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const decoded = atob(encodeBase64(bytes));
    expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([0, 1, 2, 250, 255]);
  });
});

describe("totalAttachmentBase64Bytes", () => {
  it("sums attachment payloads across the outbound message list", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "a", attachments: [att(10), att(20)] },
      { role: "assistant", content: "b" },
      { role: "user", content: "c", attachments: [att(5)] },
    ];
    expect(totalAttachmentBase64Bytes(messages)).toBe(35);
  });

  it("is zero for text-only conversations", () => {
    expect(totalAttachmentBase64Bytes([{ role: "user", content: "hi" }])).toBe(0);
  });
});

describe("caps", () => {
  it("keeps the per-image cap at the tightest provider limit and the request cap under Gemini's ceiling", () => {
    expect(MAX_IMAGE_BASE64_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_REQUEST_BASE64_BYTES).toBe(15 * 1024 * 1024);
    expect(MAX_REQUEST_BASE64_BYTES).toBeLessThan(20 * 1024 * 1024);
  });
});

describe("formatBytes", () => {
  it("formats human-readable sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

function att(size: number) {
  return {
    kind: "image" as const,
    mime: "image/png",
    base64: "x".repeat(size),
    bytes: size,
  };
}
