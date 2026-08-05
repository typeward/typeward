import { afterEach, describe, expect, it } from "vitest";
import { history } from "@codemirror/commands";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { visualExtension } from "./cm6";
import { parseVisualDoc, type InlineNode, type VisualDoc } from "./parse";

afterEach(() => {
  document.body.innerHTML = "";
});

const ARTICLE = [
  "\\documentclass{article}",
  "\\title{Round Trip}",
  "\\author{A. Author}",
  "\\begin{document}",
  "\\maketitle",
  "",
  "\\chapter{Zero}",
  "",
  "\\section{Alpha}",
  "One \\textbf{bold \\emph{deep}} two $x+y$ three \\cite{k}.",
  "",
  "A note\\footnote{Aside text.} and \\href{https://example.com}{a link}.",
  "",
  "\\begin{frame}{Slide}",
  "Slide body.",
  "\\end{frame}",
  "",
  "\\begin{itemize}",
  "\\item First thing",
  "\\item Second {\\em thing}",
  "\\end{itemize}",
  "",
  "\\begin{align}",
  "a &= b",
  "\\end{align}",
  "",
  "Tail paragraph with \\% escape and \\ref{fig}.",
  "\\end{document}",
  "",
].join("\n");

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countBraceChips(doc: VisualDoc): number {
  let count = 0;
  const walkInlines = (inlines: InlineNode[]): void => {
    for (const n of inlines) {
      if (n.kind === "brace") count++;
      if (n.kind === "style" || n.kind === "group") walkInlines(n.children);
    }
  };
  const walkBlocks = (blocks: VisualDoc["blocks"]): void => {
    for (const b of blocks) {
      if (b.kind === "paragraph" || b.kind === "heading") walkInlines(b.inlines);
      if (b.kind === "environment" && b.children) walkBlocks(b.children);
    }
  };
  walkBlocks(doc.blocks);
  return count;
}

describe("visual roundtrip", () => {
  it("freeze: enable → move around → disable leaves the bytes identical", () => {
    const compartment = new Compartment();
    const view = new EditorView({
      doc: ARTICLE,
      extensions: [history(), compartment.of(visualExtension())],
      parent: document.body,
    });
    for (const anchor of [0, 40, ARTICLE.indexOf("bold"), ARTICLE.length - 1]) {
      view.dispatch({ selection: { anchor } });
    }
    view.dispatch({ effects: compartment.reconfigure([]) });
    expect(view.state.doc.toString()).toBe(ARTICLE);
    view.destroy();
  });

  it("fuzz: user-event edits of plain text never mint new unmatched braces", () => {
    const random = rng(42);
    const view = new EditorView({
      doc: ARTICLE,
      extensions: [history(), visualExtension()],
      parent: document.body,
    });
    const WORDS = ["lorem ", "x", " ipsum", "Q"];

    let baselineChips = countBraceChips(parseVisualDoc(ARTICLE, { now: () => 0 })!);

    for (let step = 0; step < 300; step++) {
      const len = view.state.doc.length;
      const roll = random();
      if (roll < 0.5 && len > 2) {
        // Random small user deletion (selection delete).
        const from = Math.floor(random() * (len - 1));
        const to = Math.min(len, from + 1 + Math.floor(random() * 10));
        view.dispatch({
          changes: { from, to },
          userEvent: "delete.selection",
        });
      } else {
        // Random plain-text insertion (typing) — braces/backslashes only
        // enter via the input escape map, so raw specials stay out here.
        const at = Math.floor(random() * (len + 1));
        view.dispatch({
          changes: { from: at, insert: WORDS[Math.floor(random() * WORDS.length)] },
          userEvent: "input.type",
        });
      }

      const doc = parseVisualDoc(view.state.doc.toString(), { now: () => 0 });
      expect(doc, `step ${step}: parse must survive`).not.toBeNull();
      const chips = countBraceChips(doc!);
      expect(
        chips,
        `step ${step}: plain edits must not unbalance wrappers\n` +
          JSON.stringify(view.state.doc.toString()),
      ).toBeLessThanOrEqual(baselineChips);
      baselineChips = chips;
    }
    view.destroy();
  });
});
