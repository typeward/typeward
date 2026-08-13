import { describe, expect, it } from "vitest";
import { findDanglingRefs, findDuplicateLabels } from "./ref-diagnostics";
import type { IndexEntry } from "~/ipc";

const labels = new Set(["sec:intro", "eq:euler", "fig:plot"]);

/** Keys flagged as dangling, for terse assertions. */
function dangling(doc: string): string[] {
  return findDanglingRefs(doc, labels).map((d) => d.key);
}

describe("findDanglingRefs", () => {
  it("flags a reference to an unknown label and leaves known ones alone", () => {
    expect(dangling("see \\ref{sec:intro} and \\ref{sec:missing}")).toEqual([
      "sec:missing",
    ]);
  });

  it("checks every ref-family command", () => {
    expect(dangling("\\eqref{eq:euler}")).toEqual([]);
    expect(dangling("\\cref{fig:nope}")).toEqual(["fig:nope"]);
    expect(dangling("\\autoref{sec:intro} \\pageref{p:x}")).toEqual(["p:x"]);
  });

  it("reports each unknown key in a comma-separated list", () => {
    expect(dangling("\\cref{sec:intro,fig:plot,eq:gone}")).toEqual(["eq:gone"]);
    expect(dangling("\\cref{a,b}")).toEqual(["a", "b"]);
  });

  it("points at the precise range of the offending key", () => {
    const doc = "x \\ref{sec:missing} y";
    const [d] = findDanglingRefs(doc, labels);
    expect(doc.slice(d.from, d.to)).toBe("sec:missing");
  });

  it("ignores references inside a comment", () => {
    expect(dangling("% \\ref{sec:missing}\n\\ref{sec:intro}")).toEqual([]);
    // An escaped percent is not a comment.
    expect(dangling("50\\% off \\ref{sec:missing}")).toEqual(["sec:missing"]);
  });

  it("does not flag a half-typed reference with no closing brace", () => {
    expect(dangling("\\ref{sec:mis")).toEqual([]);
  });

  it("does not flag \\label definitions themselves", () => {
    expect(dangling("\\label{brand:new}\ntext")).toEqual([]);
  });
});

describe("findDuplicateLabels", () => {
  const ACTIVE = "chapters/ch010.tex";
  const idx = (rows: Array<[string, string]>): IndexEntry[] =>
    rows.map(([key, file]) => ({ key, file, line: 1, context: "" }));

  const dupes = (doc: string, index: IndexEntry[]): string[] =>
    findDuplicateLabels(doc, ACTIVE, index).map((d) => d.key);

  it("flags a label repeated within the same file", () => {
    expect(dupes("\\label{a}\n\\label{a}\n\\label{b}", [])).toEqual(["a", "a"]);
  });

  it("flags a label also defined in another file", () => {
    // `intro` is defined in this buffer and in ch001 -> duplicate.
    const index = idx([
      ["intro", "chapters/ch001.tex"],
      ["local", "chapters/ch010.tex"],
    ]);
    expect(dupes("\\label{intro}\n\\label{local}", index)).toEqual(["intro"]);
  });

  it("does not flag a label unique to this file (its own index entry aside)", () => {
    // The index carries this file's own saved `local` entry; that is the same
    // label being scanned, not a duplicate.
    const index = idx([["local", "chapters/ch010.tex"]]);
    expect(dupes("\\label{local}", index)).toEqual([]);
  });

  it("ignores a commented-out label", () => {
    expect(dupes("% \\label{a}\n\\label{a}", [])).toEqual([]);
  });
});
