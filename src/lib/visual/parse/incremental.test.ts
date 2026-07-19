import { describe, expect, it } from "vitest";

import type { ChangeAdapter } from "./incremental";
import { mapVisualDoc } from "./incremental";
import {
  assertTotalCoverage,
  coverage,
  parseVisualDoc,
  updateDoc,
  type VisualDoc,
} from "./index";

/** Constant clock — budgets never expire, parses are deterministic. */
const OPTS = { now: () => 0 };

function parse(text: string): VisualDoc {
  const doc = parseVisualDoc(text, OPTS);
  if (doc === null) throw new Error("unexpected abort");
  return doc;
}

/** Single-replacement ChangeAdapter mirroring CM ChangeDesc semantics. */
function makeChange(from: number, to: number, insert: string): ChangeAdapter {
  const delta = insert.length - (to - from);
  return {
    mapPos(pos: number, assoc = -1): number {
      if (pos < from) return pos;
      if (pos > to) return pos + delta;
      if (pos === from && pos === to) {
        return assoc > 0 ? from + insert.length : from;
      }
      if (pos === from) return from;
      if (pos === to) return from + insert.length;
      return assoc > 0 ? from + insert.length : from;
    },
    iterChangedRanges(f) {
      f(from, to, from, from + insert.length);
    },
  };
}

/** Deterministic PRNG (mulberry32). */
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

/** Structural equality that ignores the `stale` marker. */
function expectDocsEqual(a: VisualDoc, b: VisualDoc, context: string): void {
  expect({ ...a, stale: false }, context).toEqual({ ...b, stale: false });
}

const SNIPPETS = [
  "hello world ",
  "\n\n",
  "\n",
  "\\textbf{bold}",
  "\\textbf{",
  "}",
  "{",
  "$x+y$",
  "$",
  "\\section{New}\n",
  "\\begin{itemize}\n\\item one\n\\end{itemize}\n",
  "\\begin{itemize}\n",
  "\\end{itemize}\n",
  "\\item next\n",
  "% note\n",
  "\\cite{key} ",
  "\\[\na=b\n\\]\n",
  "\\\\",
  "\\%",
  "e",
  " ",
  "\\begin{verbatim}\nraw\n\\end{verbatim}\n",
  "\\end{document}\n",
];

const BASE_DOCS = [
  // A realistic small article.
  `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\section{Intro}
Hello \\textbf{bold} world with $e^{i\\pi}$ inline math and a
wrapped line plus \\cite[p.~3]{knuth84}.

\\subsection{Lists}
\\begin{itemize}
\\item First item
\\item Second with \\emph{stress}
\\end{itemize}

\\begin{align}
a &= b \\\\
c &= d
\\end{align}

Closing % with a trailing note
paragraph.
\\end{document}
`,
  // A fragment with rough edges: unmatched braces, stray end, unclosed env.
  `Opening paragraph with a stray } brace and an { unclosed one.

\\end{itemize}

\\begin{quote}
Quoted text over
two lines.
\\end{quote}

\\begin{tabular}{ll}
a & b
`,
  // Large document — big enough that edits actually exercise the splice
  // path (small docs fall back to full reparse under the lookbehind rule).
  `\\documentclass{article}
\\begin{document}
` +
    `\\section{Part}
A paragraph with \\textbf{bold} text, some $m_a$ math, and a
wrapped second line \\cite{key}.

\\begin{itemize}
\\item Alpha
\\item Beta
\\end{itemize}

\\[
x^2 + y^2 = z^2
\\]

Closing paragraph of the part. % note

`.repeat(60) +
    `\\end{document}
`,
];

describe("incremental equivalence — updateDoc ≡ full reparse", () => {
  for (let d = 0; d < BASE_DOCS.length; d++) {
    it(`holds under 200 chained random edits (doc ${d})`, { timeout: 30_000 }, () => {
      const random = rng(1000 + d);
      let text = BASE_DOCS[d];
      let doc = parse(text);

      for (let step = 0; step < 200; step++) {
        const roll = random();
        let from: number;
        let to: number;
        let insert: string;
        if (roll < 0.5 || text.length === 0) {
          // Insert a snippet at a random offset.
          from = Math.floor(random() * (text.length + 1));
          to = from;
          insert = SNIPPETS[Math.floor(random() * SNIPPETS.length)];
        } else if (roll < 0.8) {
          // Delete a random small range.
          from = Math.floor(random() * text.length);
          to = Math.min(text.length, from + 1 + Math.floor(random() * 24));
          insert = "";
        } else {
          // Replace a range with a snippet.
          from = Math.floor(random() * text.length);
          to = Math.min(text.length, from + 1 + Math.floor(random() * 12));
          insert = SNIPPETS[Math.floor(random() * SNIPPETS.length)];
        }

        const change = makeChange(from, to, insert);
        const newText = text.slice(0, from) + insert + text.slice(to);
        const result = updateDoc(doc, change, newText, OPTS);
        expect(result.stale, `step ${step}: stale with constant clock`).toBe(false);

        const full = parse(newText);
        expectDocsEqual(
          result.doc,
          full,
          `step ${step}: edit [${from},${to}) += ${JSON.stringify(insert)}`,
        );
        assertTotalCoverage(result.doc);

        text = newText;
        doc = result.doc;
      }
    });
  }
});

describe("incremental — stale fallback", () => {
  it("maps the old tree when the budget aborts and keeps coverage sound", () => {
    // Large enough that the scanner crosses its budget-sampling stride.
    const text = BASE_DOCS[0].replace(
      "Closing % with a trailing note",
      "filler words here \\textbf{bold} $x$\n".repeat(1500),
    );
    const doc = parse(text);
    // A clock that expires immediately forces the abort path.
    let calls = 0;
    const abortNow = () => (calls++ === 0 ? 0 : 1e9);
    const insert = "\\begin{itemize}\n";
    const at = text.indexOf("Hello");
    const change = makeChange(at, at, insert);
    const newText = text.slice(0, at) + insert + text.slice(at);
    const result = updateDoc(doc, change, newText, { now: abortNow });
    expect(result.stale).toBe(true);
    expect(result.doc.length).toBe(newText.length);
    // Coverage of a distorted tree must still be sorted and tiling.
    const spans = coverage(result.doc);
    let cursor = 0;
    for (const s of spans) {
      expect(s.from).toBe(cursor);
      expect(s.to).toBeGreaterThanOrEqual(s.from);
      cursor = s.to;
    }
    expect(cursor).toBe(newText.length);
  });

  it("mapVisualDoc re-tiles distorted blocks", () => {
    const text = "para one\n\npara two\n\npara three";
    const doc = parse(text);
    // Delete across the middle paragraph entirely.
    const from = text.indexOf("para two") - 1;
    const to = text.indexOf("para three");
    const change = makeChange(from, to, "");
    const newText = text.slice(0, from) + text.slice(to);
    const mapped = mapVisualDoc(doc, change, newText.length);
    expect(mapped.stale).toBe(true);
    let cursor = 0;
    for (const b of mapped.blocks) {
      expect(b.from).toBe(cursor);
      cursor = b.to;
    }
    expect(cursor).toBe(newText.length);
  });
});
