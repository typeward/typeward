import { describe, expect, it } from "vitest";
import { assertAllowedUrl, PLATFORMS } from "./fetch-tectonic.mjs";

describe("fetch-tectonic supply chain guards", () => {
  it("accepts the pinned release host and GitHub's asset CDN", () => {
    expect(() =>
      assertAllowedUrl(
        "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@0.15.0/x.zip",
      ),
    ).not.toThrow();
    expect(() =>
      assertAllowedUrl("https://objects.githubusercontent.com/some/blob"),
    ).not.toThrow();
    expect(() =>
      assertAllowedUrl("https://release-assets.githubusercontent.com/some/blob"),
    ).not.toThrow();
  });

  it("rejects a redirect to any other host", () => {
    expect(() => assertAllowedUrl("https://evil.example/tectonic.zip")).toThrow(/unexpected host/);
    expect(() => assertAllowedUrl("https://github.com.evil.example/x")).toThrow(/unexpected host/);
  });

  it("rejects non-https schemes", () => {
    expect(() => assertAllowedUrl("http://github.com/x")).toThrow(/non-https/);
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow(/non-https/);
    expect(() => assertAllowedUrl("not a url")).toThrow(/malformed/);
  });

  it("pins a sha-256 for every platform's archive and extracted binary", () => {
    const entries = Object.entries(PLATFORMS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, spec] of entries) {
      expect(spec.archiveSha256, `${key} archive digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.exeSha256, `${key} binary digest`).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
