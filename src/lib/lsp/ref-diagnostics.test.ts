import { describe, expect, it } from "vitest";
import { findDanglingRefs } from "./ref-diagnostics";

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
