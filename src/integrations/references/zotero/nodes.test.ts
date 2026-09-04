import { describe, expect, it } from "vitest";

import { pruneTrashedCollections, type RawCollection } from "./nodes";

const c = (key: string, parent: string | null, deleted = false): RawCollection => ({
  key,
  name: key,
  parent,
  deleted,
});

describe("pruneTrashedCollections", () => {
  it("keeps live collections", () => {
    const raw = [c("A", null), c("B", "A"), c("C", null)];
    expect(pruneTrashedCollections(raw).map((x) => x.key).sort()).toEqual(["A", "B", "C"]);
  });

  it("drops a trashed collection and all its descendants", () => {
    const raw = [c("A", null, true), c("B", "A"), c("C", "B"), c("D", null)];
    expect(pruneTrashedCollections(raw).map((x) => x.key)).toEqual(["D"]);
  });

  it("drops descendants of a trashed subtree even when only the top is flagged", () => {
    const raw = [c("A", null), c("B", "A", true), c("C", "B"), c("E", "A")];
    expect(pruneTrashedCollections(raw).map((x) => x.key).sort()).toEqual(["A", "E"]);
  });

  it("is cycle-safe (no infinite recursion)", () => {
    const raw = [c("A", "B"), c("B", "A")];
    expect(pruneTrashedCollections(raw).map((x) => x.key).sort()).toEqual(["A", "B"]);
  });
});
