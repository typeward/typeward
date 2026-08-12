import { describe, expect, it } from "vitest";
import { resolveRefCiteTarget } from "./ref-cite-goto";
import type { IndexEntry } from "~/ipc";

const labels: IndexEntry[] = [
  { key: "sec:intro", file: "chapters/ch001.tex", line: 3, context: "Introduction" },
  { key: "eq:euler", file: "chapters/ch042.tex", line: 128, context: "Euler" },
];
const citations: IndexEntry[] = [
  { key: "knuth1984", file: "refs.bib", line: 10, context: "The TeXbook" },
  { key: "lamport1994", file: "refs.bib", line: 22, context: "LaTeX" },
];

/** Place the cursor at the `|` marker in `src` and resolve. */
function at(src: string, active = "chapters/ch010.tex") {
  const pos = src.indexOf("|");
  const doc = src.replace("|", "");
  return resolveRefCiteTarget(doc, pos, active, labels, citations);
}

describe("resolveRefCiteTarget", () => {
  it("resolves a \\ref to its label in another file", () => {
    expect(at("see \\ref{sec:in|tro} for details")).toEqual({
      relPath: "chapters/ch001.tex",
      line: 3,
      key: "sec:intro",
      kind: "ref",
    });
  });

  it("resolves \\eqref and other ref-family commands", () => {
    expect(at("\\eqref{eq:eu|ler}")?.line).toBe(128);
    expect(at("\\autoref{sec:in|tro}")?.key).toBe("sec:intro");
    expect(at("\\cref{eq:eul|er}")?.relPath).toBe("chapters/ch042.tex");
  });

  it("resolves a \\cite to its bib entry", () => {
    expect(at("\\cite{knuth19|84}")).toEqual({
      relPath: "refs.bib",
      line: 10,
      key: "knuth1984",
      kind: "cite",
    });
  });

  it("resolves the key under the cursor in a comma list", () => {
    expect(at("\\cite{knuth1984,lampo|rt1994}")?.key).toBe("lamport1994");
    expect(at("\\cite{knu|th1984,lamport1994}")?.key).toBe("knuth1984");
  });

  it("resolves \\citep and prefixed citation families with an optional arg", () => {
    expect(at("\\citep[see][]{lampo|rt1994}")?.line).toBe(22);
    expect(at("\\textcite{knu|th1984}")?.kind).toBe("cite");
  });

  it("falls back to a label defined in the active buffer", () => {
    const src = "\\label{fresh:one}\ntext \\ref{fresh:o|ne}";
    const pos = src.indexOf("|");
    const doc = src.replace("|", "");
    expect(resolveRefCiteTarget(doc, pos, "chapters/ch010.tex", labels, citations)).toEqual({
      relPath: "chapters/ch010.tex",
      line: 1,
      key: "fresh:one",
      kind: "ref",
    });
  });

  it("returns null off a reference, after the closing brace, and for unknown keys", () => {
    expect(at("plain te|xt here")).toBeNull();
    expect(at("\\ref{sec:intro}|")).toBeNull();
    expect(at("\\ref{does:not|:exist}")).toBeNull();
    expect(at("\\cite{unkno|wn}")).toBeNull();
  });

  it("does not treat a \\cite key as a \\ref (no buffer-label fallback for cites)", () => {
    const doc = "\\label{knuth1984}\n\\cite{knuth19|84x}".replace("|", "");
    // key knuth1984x is not a citation and cites never fall back to labels
    expect(resolveRefCiteTarget(doc, doc.indexOf("84x") + 2, "a.tex", labels, citations)).toBeNull();
  });
});
