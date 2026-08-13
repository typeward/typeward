import { describe, expect, it } from "vitest";

import type { ChangeAdapter, Doc } from "./incremental";
import { mapVisualDoc } from "./incremental";
import {
  assertTotalCoverage,
  coverage,
  parseVisualDoc,
  updateDoc,
  type VisualDoc,
} from "./index";

/** String-backed Doc source (production passes a CM6 Text adapter). Matches the
 *  original `newText` string semantics exactly, so this test still verifies the
 *  update logic — and now also that the region slice is never too small. */
function stringDoc(s: string): Doc {
  return {
    length: s.length,
    sliceString: (from, to) => s.slice(from, to),
    lineStartAt: (pos) => (pos <= 0 ? 0 : s.lastIndexOf("\n", pos - 1) + 1),
  };
}

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
  // Semantic constructs — the block-owning \maketitle, the prose wrappers,
  // the wider heading levels, and a body-parsed env.
  "\\maketitle\n",
  "\\maketitle",
  "\\title{T}\n",
  "\\author{A}\n",
  "\\date{}\n",
  "\\footnote{note}",
  "\\href{https://x}{y}",
  "\\textcolor{red}{c}",
  "\\chapter{C}\n",
  "\\paragraph{P}\n",
  "\\begin{frame}{F}\nslide\n\\end{frame}\n",
  "\\begin{column}{0.5\\textwidth}\nc\n\\end{column}\n",
  "\\url{http://x/~a$b}",
  "\\title[s]{T}\n",
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
  // IEEE shape: the title metadata lives in the BODY, past the preamble, so
  // edits to it are inside the splice window rather than forcing a full
  // reparse. This is the falsifier for resolving title/author/date in the
  // decoration builder instead of carrying them on the titleBlock node — a
  // borrowed field would go stale here and this comparison would go red.
  `\\documentclass{IEEEtran}
\\begin{document}
\\title{A Body Placed Title}
\\author{\\IEEEauthorblockN{Jane Roe}}
\\maketitle

` +
    `\\section{Section}
Prose with a \\footnote{note text} and a \\href{https://example.com}{link},
wrapped over two lines.

\\paragraph{Aside}
Another paragraph with \\textcolor{red}{colour} in it.

`.repeat(40) +
    `\\end{document}
`,
];

/** One random edit against `text`, returning the change + the new text. */
function randomEdit(
  text: string,
  random: () => number,
): { change: ChangeAdapter; newText: string; from: number; to: number; insert: string } {
  const roll = random();
  let from: number;
  let to: number;
  let insert: string;
  if (roll < 0.5 || text.length === 0) {
    from = Math.floor(random() * (text.length + 1));
    to = from;
    insert = SNIPPETS[Math.floor(random() * SNIPPETS.length)];
  } else if (roll < 0.8) {
    from = Math.floor(random() * text.length);
    to = Math.min(text.length, from + 1 + Math.floor(random() * 24));
    insert = "";
  } else {
    from = Math.floor(random() * text.length);
    to = Math.min(text.length, from + 1 + Math.floor(random() * 12));
    insert = SNIPPETS[Math.floor(random() * SNIPPETS.length)];
  }
  return {
    change: makeChange(from, to, insert),
    newText: text.slice(0, from) + insert + text.slice(to),
    from,
    to,
    insert,
  };
}

describe("incremental equivalence — updateDoc ≡ full reparse", () => {
  for (let d = 0; d < BASE_DOCS.length; d++) {
    it(`holds under 200 chained random edits (doc ${d})`, { timeout: 30_000 }, () => {
      const random = rng(1000 + d);
      let text = BASE_DOCS[d];
      let doc = parse(text);

      for (let step = 0; step < 200; step++) {
        const { change, newText, from, to, insert } = randomEdit(text, random);
        const result = updateDoc(doc, change, stringDoc(newText), OPTS);
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

  // Region-slice stress: the incremental path now feeds the scanner only
  // [0, anchor + margin) instead of the whole document, so a splice whose
  // scanner needed more than the slice would diverge from the full parse. Many
  // seeds over the large splice-exercising docs make that boundary get hit.
  it("region-slice equivalence over many seeds (fuzz)", { timeout: 60_000 }, () => {
    for (let seed = 0; seed < 40; seed++) {
      const random = rng(50_000 + seed);
      let text = BASE_DOCS[2 + (seed % 2)]; // docs 2 & 3 take the splice path
      let doc = parse(text);
      for (let step = 0; step < 80; step++) {
        const { change, newText } = randomEdit(text, random);
        const result = updateDoc(doc, change, stringDoc(newText), OPTS);
        if (result.stale) break; // constant clock shouldn't abort, but be safe
        expectDocsEqual(result.doc, parse(newText), `seed ${seed} step ${step}`);
        assertTotalCoverage(result.doc);
        text = newText;
        doc = result.doc;
      }
    }
  });
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
    const result = updateDoc(doc, change, stringDoc(newText), { now: abortNow });
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
