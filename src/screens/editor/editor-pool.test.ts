import { describe, expect, it } from "vitest";
import { prunePool, withActiveEntry, type PoolEntry } from "./editor-pool";

const e = (path: string, key = `${path}::k`): PoolEntry => ({
  key,
  path,
  relPath: path,
});

describe("withActiveEntry", () => {
  it("returns the same array reference when the key is already live", () => {
    const prev = [e("/a"), e("/b")];
    expect(withActiveEntry(prev, e("/a"), 4)).toBe(prev);
  });

  it("appends a new file in insertion order", () => {
    expect(withActiveEntry([e("/a")], e("/b"), 4).map((x) => x.path)).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("supersedes a live view for the same path when the editorKey changes", () => {
    const prev = [e("/a", "/a::nolsp"), e("/b")];
    // Same path /a, new key (LSP attached) → the old /a entry is evicted.
    const next = withActiveEntry(prev, e("/a", "/a::lsp"), 4);
    expect(next.map((x) => x.key)).toEqual(["/b::k", "/a::lsp"]);
    expect(next.filter((x) => x.path === "/a")).toHaveLength(1);
  });

  it("FIFO-evicts the oldest entry at the cap, never the active one", () => {
    const prev = [e("/a"), e("/b"), e("/c"), e("/d")];
    const next = withActiveEntry(prev, e("/e"), 4);
    expect(next.map((x) => x.path)).toEqual(["/b", "/c", "/d", "/e"]);
  });

  it("keeps the just-activated entry even when the pool is over the cap", () => {
    const prev = [e("/a"), e("/b"), e("/c"), e("/d"), e("/e")];
    const next = withActiveEntry(prev, e("/f"), 4);
    // Oldest non-active entries evicted down toward the cap; /f (active) stays.
    expect(next.some((x) => x.path === "/f")).toBe(true);
    expect(next.length).toBeLessThanOrEqual(4);
  });

  it("supersession + cap: a same-path re-key doesn't grow the pool", () => {
    const prev = [e("/a", "/a::g0"), e("/b"), e("/c"), e("/d")];
    const next = withActiveEntry(prev, e("/a", "/a::g1"), 4);
    expect(next.length).toBe(4);
    expect(next.map((x) => x.path)).toEqual(["/b", "/c", "/d", "/a"]);
  });
});

describe("prunePool", () => {
  it("drops entries whose file is closed", () => {
    expect(
      prunePool([e("/a"), e("/b")], new Set(["/b"])).map((x) => x.path),
    ).toEqual(["/b"]);
  });

  it("returns the same reference when nothing was pruned", () => {
    const prev = [e("/a"), e("/b")];
    expect(prunePool(prev, new Set(["/a", "/b"]))).toBe(prev);
  });
});
