import { describe, expect, it } from "vitest";

import {
  assertTotalCoverage,
  coverage,
  parseVisualDoc,
  type BlockNode,
  type InlineNode,
  type VisualDoc,
} from "./index";

/** Parse with a constant clock so the budget can never abort. */
function parse(text: string): VisualDoc {
  const doc = parseVisualDoc(text, { now: () => 0 });
  if (doc === null) throw new Error("unexpected budget abort");
  assertTotalCoverage(doc);
  return doc;
}

const kinds = (doc: VisualDoc): string[] => doc.blocks.map((b) => b.kind);

function firstBlock<K extends BlockNode["kind"]>(
  doc: VisualDoc,
  kind: K,
): Extract<BlockNode, { kind: K }> {
  const found = findBlock(doc.blocks, kind);
  if (!found) throw new Error(`no ${kind} block`);
  return found;
}

function findBlock<K extends BlockNode["kind"]>(
  blocks: BlockNode[],
  kind: K,
): Extract<BlockNode, { kind: K }> | null {
  for (const b of blocks) {
    if (b.kind === kind) return b as Extract<BlockNode, { kind: K }>;
    if (b.kind === "environment" && b.children) {
      const nested = findBlock(b.children, kind);
      if (nested) return nested;
    }
  }
  return null;
}

/** All content-classified text, concatenated. */
function contentText(text: string, doc: VisualDoc): string {
  return coverage(doc)
    .filter((s) => s.kind === "content")
    .map((s) => text.slice(s.from, s.to))
    .join("");
}

function inlineKinds(nodes: InlineNode[]): string[] {
  return nodes.map((n) => n.kind);
}

describe("visual parse — document structure", () => {
  const doc = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Intro}
Hello world.

\subsection*{Detail}
More text.
\end{document}`;

  it("segments preamble, doc markers, headings, paragraphs", () => {
    const d = parse(doc);
    expect(kinds(d)).toEqual([
      "preamble",
      "docBegin",
      "heading",
      "paragraph",
      "blank",
      "heading",
      "paragraph",
      "docEnd",
    ]);
    expect(d.preambleEnd).toBe(doc.indexOf("\\begin{document}"));
  });

  it("captures heading levels, stars, and title content", () => {
    const d = parse(doc);
    const headings = d.blocks.filter((b) => b.kind === "heading");
    expect(headings).toHaveLength(2);
    const [h1, h2] = headings as Extract<BlockNode, { kind: "heading" }>[];
    expect(h1.level).toBe(1);
    expect(h1.starred).toBe(false);
    expect(doc.slice(h1.content.from, h1.content.to)).toBe("Intro");
    expect(h2.level).toBe(2);
    expect(h2.starred).toBe(true);
    expect(doc.slice(h2.content.from, h2.content.to)).toBe("Detail");
  });

  it("hides all markup from the content classification", () => {
    const d = parse(doc);
    const visible = contentText(doc, d);
    expect(visible).not.toMatch(/\\[a-zA-Z]/);
    expect(visible).toContain("Hello world.");
    expect(visible).toContain("Intro");
  });

  it("handles fragments without a preamble", () => {
    const d = parse("Just prose.\n\nTwo paragraphs.");
    expect(kinds(d)).toEqual(["paragraph", "blank", "paragraph"]);
    expect(d.preambleEnd).toBeNull();
  });

  it("parses the empty document", () => {
    const d = parse("");
    expect(d.blocks).toEqual([]);
  });
});

describe("visual parse — inline constructs", () => {
  it("nests styles and keeps wrapper tokens out of content", () => {
    const text = String.raw`Plain \textbf{bold \textit{both}} tail`;
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const bold = para.inlines.find((n) => n.kind === "style");
    expect(bold).toBeDefined();
    if (bold?.kind !== "style") throw new Error("unreachable");
    expect(bold.style).toBe("bold");
    expect(text.slice(bold.content.from, bold.content.to)).toBe(
      String.raw`bold \textit{both}`,
    );
    const inner = bold.children.find((n) => n.kind === "style");
    if (inner?.kind !== "style") throw new Error("no nested style");
    expect(inner.style).toBe("italic");
    expect(contentText(text, d)).toBe("Plain bold both tail");
  });

  it("styles declaration groups and hides bare group braces", () => {
    const text = String.raw`A {\em stressed} and {plain} group`;
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const [decl, bare] = para.inlines.filter(
      (n) => n.kind === "style" || n.kind === "group",
    );
    if (decl.kind !== "style") throw new Error("decl group not styled");
    expect(decl.style).toBe("italic");
    expect(text.slice(decl.content.from, decl.content.to)).toBe("stressed");
    expect(bare.kind).toBe("group");
    expect(contentText(text, d)).toBe("A stressed and plain group");
  });

  it("recognizes pills with and without optional args", () => {
    const text = String.raw`See \cite[p.~3]{knuth84} and \ref{fig:a}.`;
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const pills = para.inlines.filter((n) => n.kind === "pill");
    expect(pills).toHaveLength(2);
    const [cite, ref] = pills;
    if (cite.kind !== "pill" || ref.kind !== "pill") throw new Error("unreachable");
    expect(cite.command).toBe("cite");
    expect(cite.optArg).not.toBeNull();
    expect(text.slice(cite.arg.from, cite.arg.to)).toBe("knuth84");
    expect(ref.command).toBe("ref");
    expect(ref.optArg).toBeNull();
  });

  it("chips unknown commands with their bounded arguments", () => {
    const text = String.raw`Before \includegraphics[width=0.8\linewidth]{fig.png} after \maketitle end`;
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const chips = para.inlines.filter((n) => n.kind === "command");
    expect(chips.map((c) => (c.kind === "command" ? c.name : ""))).toEqual([
      "includegraphics",
      "maketitle",
    ]);
    const img = chips[0];
    if (img.kind !== "command") throw new Error("unreachable");
    expect(img.args).toHaveLength(2);
    expect(contentText(text, d)).toBe("Before  after  end");
  });

  it("renders escapes as glyphs and lone specials honestly", () => {
    const text = String.raw`100\% of \$5 \& one lone $ here`;
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const escapes = para.inlines.filter((n) => n.kind === "escape");
    expect(escapes.map((e) => (e.kind === "escape" ? e.ch : ""))).toEqual([
      "%",
      "$",
      "&",
      "$",
    ]);
  });

  it("handles inline math with both delimiters", () => {
    const text = String.raw`Euler: $e^{i\pi}$ and \(x+y\).`;
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const math = para.inlines.filter((n) => n.kind === "inlineMath");
    expect(math).toHaveLength(2);
    const [dollar, paren] = math;
    if (dollar.kind !== "inlineMath" || paren.kind !== "inlineMath") {
      throw new Error("unreachable");
    }
    expect(text.slice(dollar.tex.from, dollar.tex.to)).toBe(String.raw`e^{i\pi}`);
    expect(paren.delim).toBe("paren");
  });

  it("keeps \\verb atomic and comments as dim text", () => {
    const text = "Use \\verb|\\textbf{x}| here % trailing note";
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    expect(inlineKinds(para.inlines)).toContain("verb");
    expect(inlineKinds(para.inlines)).toContain("comment");
    // The comment text stays content (dim, editable, never hidden).
    expect(contentText(text, d)).toContain("% trailing note");
  });

  it("marks soft newlines and tight joins after comments", () => {
    const text = "wrapped % note\nline two";
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const soft = para.inlines.find((n) => n.kind === "softNewline");
    if (soft?.kind !== "softNewline") throw new Error("no soft newline");
    expect(soft.joinTight).toBe(true);
  });

  it("chips lone unmatched braces without poisoning the paragraph", () => {
    // The stray `}` comes first so the pair cannot balance.
    const text = "an early } then a { late one";
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const braces = para.inlines.filter((n) => n.kind === "brace");
    expect(braces).toHaveLength(2);
    if (braces[0].kind !== "brace" || braces[1].kind !== "brace") {
      throw new Error("unreachable");
    }
    expect(braces[0].side).toBe("close");
    expect(braces[1].side).toBe("open");
    expect(contentText(text, d)).toBe("an early  then a  late one");
  });

  it("emits hard line breaks", () => {
    const text = "first\\\\[2em]second";
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const br = para.inlines.find((n) => n.kind === "lineBreak");
    expect(br).toBeDefined();
    expect(text.slice(br!.from, br!.to)).toBe("\\\\[2em]");
  });
});

describe("visual parse — environments", () => {
  it("parses lists with ordinals, labels, and nesting", () => {
    const text = String.raw`\begin{enumerate}
\item First
\item[*] Starred
\item Second
\begin{itemize}
\item Inner
\end{itemize}
\end{enumerate}`;
    const d = parse(text);
    const env = firstBlock(d, "environment");
    expect(env.envKind).toBe("list");
    expect(env.children).not.toBeNull();
    const markers = env.children!.filter((b) => b.kind === "itemMarker");
    expect(markers).toHaveLength(3);
    const [first, starred, second] = markers as Extract<
      BlockNode,
      { kind: "itemMarker" }
    >[];
    expect(first.ordinal).toBe(1);
    expect(starred.ordinal).toBeNull();
    expect(text.slice(starred.label!.from, starred.label!.to)).toBe("*");
    expect(second.ordinal).toBe(2);
    const inner = findBlock(env.children!, "environment");
    expect(inner?.envKind).toBe("list");
    expect(inner?.listDepth).toBe(2);
  });

  it("treats math environments as opaque widgets", () => {
    const text = String.raw`Before

\begin{align}
a &= b \\
c &= d
\end{align}

After`;
    const d = parse(text);
    const env = firstBlock(d, "environment");
    expect(env.envKind).toBe("mathEnv");
    expect(env.children).toBeNull();
    const spans = coverage(d).filter(
      (s) => s.from >= env.body.from && s.to <= env.body.to,
    );
    expect(spans.every((s) => s.kind === "widget")).toBe(true);
  });

  it("keeps verbatim bodies as literal visible text", () => {
    const text = "\\begin{verbatim}\n\\begin{itemize} raw!\n\\end{verbatim}\nafter";
    const d = parse(text);
    const env = firstBlock(d, "environment");
    expect(env.envKind).toBe("verbatim");
    expect(env.endToken).not.toBeNull();
    expect(contentText(text, d)).toContain("\\begin{itemize} raw!");
  });

  it("marks unclosed environments and still tiles the document", () => {
    const text = "text before\n\\begin{tabular}{ll}\na & b\n";
    const d = parse(text);
    const env = firstBlock(d, "environment");
    expect(env.envKind).toBe("table");
    expect(env.endToken).toBeNull();
    expect(env.to).toBe(text.length);
  });

  it("chips a stray \\end instead of showing raw markup", () => {
    const text = "some text \\end{itemize} more";
    const d = parse(text);
    const para = firstBlock(d, "paragraph");
    const chip = para.inlines.find((n) => n.kind === "command");
    if (chip?.kind !== "command") throw new Error("no chip");
    expect(chip.name).toBe("end");
    expect(contentText(text, d)).toBe("some text  more");
  });

  it("parses display math blocks with both delimiters", () => {
    const text = "a\n\\[\nx = y\n\\]\nb\n$$z$$\nc";
    const d = parse(text);
    const maths = d.blocks.filter((b) => b.kind === "displayMath");
    expect(maths).toHaveLength(2);
    const [bracket, dollars] = maths as Extract<BlockNode, { kind: "displayMath" }>[];
    expect(bracket.delim).toBe("bracket");
    expect(text.slice(bracket.tex.from, bracket.tex.to)).toBe("\nx = y\n");
    expect(dollars.delim).toBe("dollars");
    expect(text.slice(dollars.tex.from, dollars.tex.to)).toBe("z");
  });

  it("parses prose environments transparently", () => {
    const text = "\\begin{center}\ncentered text\n\\end{center}";
    const d = parse(text);
    const env = firstBlock(d, "environment");
    expect(env.envKind).toBe("prose");
    expect(env.children).not.toBeNull();
    expect(contentText(text, d)).toContain("centered text");
  });
});

describe("visual parse — comment lines and blanks", () => {
  it("emits whole-line comments at block level", () => {
    const text = "para one\n\n% a note line\n\npara two";
    const d = parse(text);
    expect(kinds(d)).toEqual([
      "paragraph",
      "blank",
      "commentLine",
      "blank",
      "paragraph",
    ]);
  });

  it("keeps comment lines adjacent to text inside the paragraph", () => {
    const text = "line one\n% inner note\nline two";
    const d = parse(text);
    expect(kinds(d)).toEqual(["paragraph"]);
  });
});
