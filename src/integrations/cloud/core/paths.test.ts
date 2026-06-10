import { describe, expect, it } from "vitest";

import { cachePathForRemoteRel, normalizeRemoteRelPath } from "./paths";

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
    expect(() => normalizeRemoteRelPath(".typeward/integrations/gdrive/idmap.json")).toThrow(
      /internal state/,
    );
  });

  it("rejects Typeward internal state case-insensitively and at any depth", () => {
    expect(() => normalizeRemoteRelPath(".Typeward/snapshots/main.tex.snap")).toThrow(
      /internal state/,
    );
    expect(() => normalizeRemoteRelPath(".TYPEWARD/integrations/gdrive/idmap.json")).toThrow(
      /internal state/,
    );
    expect(() => normalizeRemoteRelPath("nested/.TypeWard/cursor")).toThrow(/internal state/);
  });
});
