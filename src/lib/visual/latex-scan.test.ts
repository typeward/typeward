import { describe, expect, it } from "vitest";
import {
  findPreambleEnd,
  scanLatex,
  type EnvLineNode,
  type HeadingNode,
  type InlineStyleNode,
  type ItemNode,
  type MathNode,
  type PillNode,
  type VisualNode,
} from "./latex-scan";

const nodesOf = (text: string): VisualNode[] => {
  const res = scanLatex(text);
  expect(res.aborted).toBe(false);
  return res.nodes;
};

const byType = <T extends VisualNode["type"]>(
  nodes: VisualNode[],
  type: T,
): Extract<VisualNode, { type: T }>[] =>
  nodes.filter((n): n is Extract<VisualNode, { type: T }> => n.type === type);

const slice = (text: string, r: { from: number; to: number }): string =>
  text.slice(r.from, r.to);

describe("scanLatex: nominal article", () => {
  const doc = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{Intro}",
    "Some \\textbf{bold} text.",
    "\\begin{itemize}",
    "  \\item First",
    "  \\item Second",
    "\\end{itemize}",
    "Cite \\cite{a,b}.",
    "% a note",
    "\\end{document}",
    "",
  ].join("\n");

  it("finds the heading with hidden wrappers and styled title", () => {
    const [h] = byType(nodesOf(doc), "heading") as HeadingNode[];
    expect(h).toBeDefined();
    expect(h.level).toBe(1);
    expect(slice(doc, h.content)).toBe("Intro");
    expect(slice(doc, h.hide[0])).toBe("\\section{");
    expect(slice(doc, h.hide[1])).toBe("}");
    expect(slice(doc, { from: h.from, to: h.to })).toBe("\\section{Intro}");
  });

  it("finds the bold span", () => {
    const [s] = byType(nodesOf(doc), "inlineStyle") as InlineStyleNode[];
    expect(s.style).toBe("bold");
    expect(slice(doc, s.content)).toBe("bold");
  });

  it("emits list items as bullets with dimmed begin/end lines", () => {
    const nodes = nodesOf(doc);
    const items = byType(nodes, "item") as ItemNode[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.ordinal).toBeNull();
      expect(item.depth).toBe(1);
      expect(item.label).toBeNull();
    }
    const envLines = byType(nodes, "envLine") as EnvLineNode[];
    const itemize = envLines.filter((e) => e.env === "itemize");
    expect(itemize.map((e) => e.role).sort()).toEqual(["begin", "end"]);
  });

  it("pills the multi-key cite as one node", () => {
    const [pill] = byType(nodesOf(doc), "pill") as PillNode[];
    expect(pill.command).toBe("cite");
    expect(slice(doc, pill.content)).toBe("a,b");
  });

  it("dims the comment to end of line", () => {
    const [c] = byType(nodesOf(doc), "comment");
    expect(slice(doc, { from: c.from, to: c.to })).toBe("% a note");
  });
});

describe("scanLatex: inline styles", () => {
  it("handles 5-deep nesting", () => {
    const doc = "\\textbf{a \\textit{b \\emph{c \\textbf{d \\textit{e}}}}}";
    const styles = byType(nodesOf(doc), "inlineStyle") as InlineStyleNode[];
    expect(styles).toHaveLength(5);
    expect(styles.map((s) => s.style)).toEqual([
      "bold",
      "italic",
      "italic",
      "bold",
      "italic",
    ]);
    expect(slice(doc, styles[4].content)).toBe("e");
  });

  it("leaves an unbalanced argument as source without throwing", () => {
    const doc = "before \\textbf{a";
    expect(byType(nodesOf(doc), "inlineStyle")).toHaveLength(0);
  });

  it("leaves an empty argument as source", () => {
    const doc = "\\textbf{} rest";
    expect(byType(nodesOf(doc), "inlineStyle")).toHaveLength(0);
  });

  it("underlines via \\underline and italicizes \\emph", () => {
    const doc = "\\underline{u} \\emph{e}";
    const styles = byType(nodesOf(doc), "inlineStyle") as InlineStyleNode[];
    expect(styles.map((s) => s.style)).toEqual(["underline", "italic"]);
  });
});

describe("scanLatex: headings", () => {
  it("maps levels and starred variants", () => {
    const doc = "\\section*{A}\n\\subsection{B}\n\\subsubsection{C}\n";
    const hs = byType(nodesOf(doc), "heading") as HeadingNode[];
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(slice(doc, hs[0].hide[0])).toBe("\\section*{");
  });

  it("renders an argument spanning a line break as source", () => {
    const doc = "\\section{Two\nlines}";
    expect(byType(nodesOf(doc), "heading")).toHaveLength(0);
  });

  it("renders an over-long argument as source", () => {
    const doc = `\\section{${"x".repeat(600)}}`;
    expect(byType(nodesOf(doc), "heading")).toHaveLength(0);
  });
});

describe("scanLatex: opacity", () => {
  it("ignores constructs inside verbatim", () => {
    const doc = [
      "\\begin{verbatim}",
      "\\section{fake} \\textbf{fake} % fake",
      "\\end{verbatim}",
      "",
    ].join("\n");
    const nodes = nodesOf(doc);
    expect(byType(nodes, "heading")).toHaveLength(0);
    expect(byType(nodes, "inlineStyle")).toHaveLength(0);
    expect(byType(nodes, "comment")).toHaveLength(0);
    const envLines = byType(nodes, "envLine") as EnvLineNode[];
    expect(envLines.map((e) => e.role)).toEqual(["begin", "interior", "end"]);
    expect(envLines.every((e) => e.env === "verbatim")).toBe(true);
  });

  it("ignores constructs inside a % comment", () => {
    const doc = "% \\section{fake}\n";
    const nodes = nodesOf(doc);
    expect(byType(nodes, "heading")).toHaveLength(0);
    expect(byType(nodes, "comment")).toHaveLength(1);
  });

  it("ignores \\textbf inside $…$ (math is opaque)", () => {
    const doc = "$x \\textbf{y}$ after";
    const nodes = nodesOf(doc);
    expect(byType(nodes, "inlineStyle")).toHaveLength(0);
    const [m] = byType(nodes, "math") as MathNode[];
    expect(m.display).toBe(false);
    expect(slice(doc, { from: m.from, to: m.to })).toBe("$x \\textbf{y}$");
  });

  it("does not treat escaped \\% as a comment", () => {
    const doc = "50\\% done\n";
    expect(byType(nodesOf(doc), "comment")).toHaveLength(0);
  });

  it("keeps math-env contents as source with env line roles", () => {
    const doc = [
      "\\begin{equation}",
      "  E = mc^2 \\textbf{no}",
      "\\end{equation}",
      "",
    ].join("\n");
    const nodes = nodesOf(doc);
    expect(byType(nodes, "inlineStyle")).toHaveLength(0);
    const envLines = byType(nodes, "envLine") as EnvLineNode[];
    expect(envLines.map((e) => [e.env, e.role])).toEqual([
      ["equation", "begin"],
      ["equation", "interior"],
      ["equation", "end"],
    ]);
  });

  it("recognizes display math delimiters", () => {
    const doc = "\\[a\\] and $$b$$ and \\(c\\)";
    const math = byType(nodesOf(doc), "math") as MathNode[];
    expect(math.map((m) => m.display)).toEqual([true, true, false]);
  });
});

describe("scanLatex: lists", () => {
  it("keeps a custom \\item[label] label visible", () => {
    const doc = [
      "\\begin{itemize}",
      "  \\item[custom] Text",
      "\\end{itemize}",
      "",
    ].join("\n");
    const [item] = byType(nodesOf(doc), "item") as ItemNode[];
    expect(item.label).not.toBeNull();
    expect(slice(doc, item.label!)).toBe("custom");
    expect(slice(doc, item.hide[0])).toBe("\\item[");
    expect(slice(doc, item.hide[1])).toBe("]");
  });

  it("numbers 4-deep mixed lists per level", () => {
    const doc = [
      "\\begin{enumerate}",
      "  \\item A1",
      "  \\begin{itemize}",
      "    \\item B1",
      "    \\begin{enumerate}",
      "      \\item C1",
      "      \\item C2",
      "      \\begin{enumerate}",
      "        \\item D1",
      "      \\end{enumerate}",
      "      \\item C3",
      "    \\end{enumerate}",
      "  \\end{itemize}",
      "  \\item A2",
      "\\end{enumerate}",
      "",
    ].join("\n");
    const items = byType(nodesOf(doc), "item") as ItemNode[];
    expect(items.map((i) => i.ordinal)).toEqual([1, null, 1, 2, 1, 3, 2]);
    expect(items.map((i) => i.depth)).toEqual([1, 2, 3, 3, 4, 3, 1]);
  });

  it("degrades to a plain bullet when the opener is beyond the lookback", () => {
    // The layer slices the doc at the lookback cap — the scanner then sees
    // an \item with no enclosing \begin at all.
    const doc = "  \\item Later\n";
    const [item] = byType(nodesOf(doc), "item") as ItemNode[];
    expect(item.ordinal).toBeNull();
    expect(item.depth).toBe(1);
  });

  it("does not confuse \\itemsep with \\item", () => {
    const doc = "\\begin{itemize}\n\\itemsep\n\\end{itemize}\n";
    expect(byType(nodesOf(doc), "item")).toHaveLength(0);
  });
});

describe("scanLatex: pills", () => {
  it("renders optional-arg cites as source", () => {
    const doc = "\\cite[p.3]{k}";
    expect(byType(nodesOf(doc), "pill")).toHaveLength(0);
  });

  it("pills ref/eqref/autoref/label", () => {
    const doc = "\\ref{a} \\eqref{b} \\autoref{c} \\label{d}";
    const pills = byType(nodesOf(doc), "pill") as PillNode[];
    expect(pills.map((p) => p.command)).toEqual([
      "ref",
      "eqref",
      "autoref",
      "label",
    ]);
  });
});

describe("scanLatex: quote", () => {
  it("marks interior lines and dims begin/end", () => {
    const doc = ["\\begin{quote}", "  Wisdom.", "\\end{quote}", ""].join("\n");
    const envLines = byType(nodesOf(doc), "envLine") as EnvLineNode[];
    expect(envLines.map((e) => e.role)).toEqual(["begin", "interior", "end"]);
    expect(envLines.every((e) => e.env === "quote")).toBe(true);
  });
});

describe("scanLatex: budget guard", () => {
  it("aborts a pathological single-line input via the injected clock", () => {
    const doc = "y".repeat(2_000_000);
    let t = 0;
    const res = scanLatex(doc, 0, { now: () => (t += 10) });
    expect(res.aborted).toBe(true);
    expect(res.nodes).toEqual([]);
  });

  it("does not abort normal input under a sane clock", () => {
    const res = scanLatex("\\section{ok}\n".repeat(200));
    expect(res.aborted).toBe(false);
    expect(res.nodes.length).toBe(200);
  });
});

describe("scanLatex: offsets", () => {
  it("emits absolute offsets when baseOffset is set", () => {
    const doc = "\\textbf{x}";
    const base = 1234;
    const [s] = byType(
      scanLatex(doc, base).nodes,
      "inlineStyle",
    ) as InlineStyleNode[];
    expect(s.from).toBe(base);
    expect(s.to).toBe(base + doc.length);
    expect(s.content).toEqual({ from: base + 8, to: base + 9 });
  });
});

describe("findPreambleEnd", () => {
  it("locates \\begin{document}", () => {
    const doc = "\\documentclass{article}\n\\usepackage{x}\n\\begin{document}\nBody\n";
    expect(findPreambleEnd(doc)).toBe(doc.indexOf("\\begin{document}"));
  });

  it("returns null for fragment files", () => {
    expect(findPreambleEnd("\\section{Chapter}\nText\n")).toBeNull();
  });

  it("skips commented occurrences", () => {
    expect(findPreambleEnd("% \\begin{document}\nText\n")).toBeNull();
    const doc = "% \\begin{document}\n\\begin{document}\n";
    expect(findPreambleEnd(doc)).toBe(doc.indexOf("\\begin{document}", 3));
  });
});
