/**
 * Regex heading/section parser used as the document-outline fallback when no
 * LSP `documentSymbol` is available. Pure and unit-tested. The LSP path
 * (lib/lsp/symbols.ts) is more precise; this covers the common structure.
 */

export interface OutlineItem {
  title: string;
  /** 1-based nesting depth. */
  level: number;
  /** 1-based line number. */
  line: number;
  children: OutlineItem[];
}

export type OutlineLanguage = "latex" | "typst" | "markdown";

interface Flat {
  title: string;
  level: number;
  line: number;
}

/** Nest a flat, in-order heading list into a tree by level. */
function nest(flat: Flat[]): OutlineItem[] {
  const root: OutlineItem[] = [];
  const stack: OutlineItem[] = [];
  for (const f of flat) {
    const item: OutlineItem = { ...f, children: [] };
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(item);
    else root.push(item);
    stack.push(item);
  }
  return root;
}

const LATEX_LEVELS: Record<string, number> = {
  part: 1,
  chapter: 2,
  section: 3,
  subsection: 4,
  subsubsection: 5,
  paragraph: 6,
  subparagraph: 7,
};

const LATEX_RE =
  /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;

/** Capture the content of a single-line balanced `{...}` starting at `openIdx`. */
function balancedBrace(s: string, openIdx: number): string | null {
  let depth = 0;
  let out = "";
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return out;
    }
    out += c;
  }
  return null; // multi-line title (unbalanced on this line) — skip
}

/** Drop a `%`-comment tail from a line so commented-out `\section{...}` doesn't
 *  produce a phantom outline entry. Respects the `\%` escape (the common case);
 *  verbatim-environment false-positives remain an accepted fallback limit. */
function stripLatexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "%" && (i === 0 || line[i - 1] !== "\\")) return line.slice(0, i);
  }
  return line;
}

function parseLatex(text: string): OutlineItem[] {
  const flat: Flat[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripLatexComment(lines[i]);
    const m = LATEX_RE.exec(line);
    if (!m) continue;
    const braceStart = m.index + m[0].length - 1;
    const title = balancedBrace(line, braceStart);
    if (title != null) {
      flat.push({ title: title.trim(), level: LATEX_LEVELS[m[1]], line: i + 1 });
    }
  }
  return nest(flat);
}

const TYPST_RE = /^\s*(=+)\s+(.+?)\s*$/;

function parseTypst(text: string): OutlineItem[] {
  const flat: Flat[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = TYPST_RE.exec(lines[i]);
    if (m) flat.push({ title: m[2].trim(), level: m[1].length, line: i + 1 });
  }
  return nest(flat);
}

const MD_FENCE_RE = /^\s*(```|~~~)/;
const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function parseMarkdown(text: string): OutlineItem[] {
  const flat: Flat[] = [];
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (MD_FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = MD_HEADING_RE.exec(lines[i]);
    if (m) flat.push({ title: m[2].trim(), level: m[1].length, line: i + 1 });
  }
  return nest(flat);
}

export function parseOutline(text: string, language: OutlineLanguage): OutlineItem[] {
  switch (language) {
    case "latex":
      return parseLatex(text);
    case "typst":
      return parseTypst(text);
    case "markdown":
      return parseMarkdown(text);
  }
}
