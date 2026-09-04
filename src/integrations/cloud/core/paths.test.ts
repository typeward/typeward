import { describe, expect, it } from "vitest";

import {
  cachePathForRemoteRel,
  cursorPathForCacheRoot,
  legacyProviderStateDir,
  normalizeRemoteRelPath,
  providerStateSegment,
} from "./paths";

describe("providerStateSegment", () => {
  it("escapes the characters Windows rejects in a path component", () => {
    // The WebDAV provider id: the colon is what made every cloud project fail
    // to open on Windows with os error 123.
    expect(providerStateSegment("webdav:me@example.com@dav.example.com")).toBe(
      "webdav%3Ame@example.com@dav.example.com",
    );
    expect(cursorPathForCacheRoot("C:\\cache\\proj", "webdav:me@h")).toBe(
      "C:\\cache\\proj\\.typeward\\integrations\\webdav%3Ame@h\\cursor",
    );
  });

  it("leaves an id that is already a legal segment alone", () => {
    expect(providerStateSegment("webdav")).toBe("webdav");
    expect(legacyProviderStateDir("/cache/proj", "webdav")).toBe(
      "/cache/proj/.typeward/integrations/webdav",
    );
  });

  it("is reversible, so two accounts cannot share one state directory", () => {
    // Escaping `%` in the same pass is what keeps these apart: a substitution
    // that only rewrote `:` would map both ids onto `a%3Ab`.
    expect(providerStateSegment("a:b")).not.toBe(providerStateSegment("a%3Ab"));
    expect(providerStateSegment("a%3Ab")).toBe("a%253Ab");
  });

  it("escapes a trailing dot or space, which Win32 silently strips", () => {
    expect(providerStateSegment("webdav:me.")).toBe("webdav%3Ame%2E");
    expect(providerStateSegment("webdav:me ")).toBe("webdav%3Ame%20");
  });
});

describe("normalizeRemoteRelPath", () => {
  it("normalizes safe remote paths", () => {
    expect(normalizeRemoteRelPath("sections\\intro.tex")).toBe("sections/intro.tex");
    expect(cachePathForRemoteRel("/cache/project", "figures/plot.png")).toBe(
      "/cache/project/figures/plot.png",
    );
  });

  it("rejects paths that escape the project cache", () => {
    expect(() => normalizeRemoteRelPath("../secret.tex")).toThrow(/Unsafe remote path/);
    expect(() => normalizeRemoteRelPath("/tmp/secret.tex")).toThrow(/Unsafe remote path/);
    expect(() => normalizeRemoteRelPath("C:/tmp/secret.tex")).toThrow(/Unsafe remote path/);
  });

  it("rejects Typeward internal state", () => {
    expect(() => normalizeRemoteRelPath(".typeward/integrations/webdav/cursor.json")).toThrow(
      /internal state/,
    );
  });

  it("rejects Typeward internal state case-insensitively and at any depth", () => {
    expect(() => normalizeRemoteRelPath(".Typeward/snapshots/main.tex.snap")).toThrow(
      /internal state/,
    );
    expect(() => normalizeRemoteRelPath(".TYPEWARD/integrations/webdav/cursor.json")).toThrow(
      /internal state/,
    );
    expect(() => normalizeRemoteRelPath("nested/.TypeWard/cursor")).toThrow(/internal state/);
  });
});
