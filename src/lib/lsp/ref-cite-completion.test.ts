import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";
import { describe, expect, it, vi } from "vitest";

const labels = [
  { key: "sec:intro", file: "main.tex", line: 3, context: "Introduction" },
  { key: "eq:main", file: "ch1.tex", line: 40, context: "Chapter 1" },
  { key: "fig:plot", file: "ch2.tex", line: 12, context: "Results" },
];
const citations = [
  { key: "smith2020", file: "refs.bib", line: 1, context: "A Paper" },
  { key: "jones2019", file: "refs.bib", line: 8, context: "A Book" },
];

vi.mock("~/stores/index-store", () => ({
  indexLabels: () => labels,
  indexCitations: () => citations,
}));

const { isRefCiteContext, refCiteSource } = await import("./ref-cite-completion");

/** Build a CompletionContext with the cursor at the end of `doc`. */
function ctxAtEnd(doc: string, explicit = false): CompletionContext {
  const state = EditorState.create({ doc });
  return new CompletionContext(state, doc.length, explicit);
}

describe("isRefCiteContext", () => {
  it("detects the reference command family", () => {
    for (const s of [
      "see \\ref{",
      "\\eqref{",
      "\\cref{sec:",
      "\\Cref{",
      "\\autoref{fig:pl",
      "\\pageref{",
      "\\vref{",
      "\\ref{a,b,",
    ]) {
      expect(isRefCiteContext(s), s).toBe(true);
    }
  });

  it("detects the citation command family (including optional args)", () => {
    for (const s of [
      "\\cite{",
      "\\citep{smi",
      "\\textcite{",
      "\\footcite[see][]{",
      "\\parencite{a,",
      "\\citeauthor{",
    ]) {
      expect(isRefCiteContext(s), s).toBe(true);
    }
  });

  it("does not fire outside a ref/cite argument", () => {
    for (const s of [
      "\\section{",
      "\\label{sec:",
      "\\ref{done} and more text",
      "plain text",
      "\\reflectbox{", // a real command that starts with 'ref' but isn't \ref
    ]) {
      expect(isRefCiteContext(s), s).toBe(false);
    }
  });
});

describe("refCiteSource", () => {
  it("returns all labels inside \\ref{ (uncapped, no server)", () => {
    const res = refCiteSource(ctxAtEnd("\\ref{"));
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label).sort()).toEqual(
      ["eq:main", "fig:plot", "sec:intro"],
    );
  });

  it("returns citation keys inside \\cite{", () => {
    const res = refCiteSource(ctxAtEnd("\\cite{"));
    expect(res!.options.map((o) => o.label).sort()).toEqual(["jones2019", "smith2020"]);
  });

  it("anchors `from` at the current key segment after a comma", () => {
    const doc = "\\ref{sec:intro,eq";
    const res = refCiteSource(ctxAtEnd(doc));
    expect(res).not.toBeNull();
    // The replaceable segment starts right after the comma ("eq").
    expect(doc.slice(res!.from)).toBe("eq");
  });

  it("returns null outside a ref/cite context", () => {
    expect(refCiteSource(ctxAtEnd("\\section{"))).toBeNull();
    expect(refCiteSource(ctxAtEnd("just text "))).toBeNull();
  });
});
