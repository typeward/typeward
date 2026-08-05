/**
 * Node model for the visual editor's LaTeX parse. Pure data — no CodeMirror
 * imports — shared by the scanner, the decoration builder, the edit guards,
 * and the visible-image iterator.
 *
 * The one law of this model is the TOTAL-COVERAGE CONTRACT: every character
 * of the source is exactly one of
 *   (a) visible content — real document text the user edits in place,
 *   (b) hidden          — a wrapper token bound to a construct (replaced,
 *                         atomic, deleted only together with its construct),
 *   (c) widget          — covered by an atomic widget (math, chips, markers).
 * There is no fourth category: nothing ever falls through as raw markup.
 * `coverage()` computes the classification and `assertTotalCoverage()` is
 * the dev-build falsifier for the contract.
 */

export interface Span {
  from: number;
  to: number;
}

/* ------------------------------------------------------------------ */
/* Inline nodes                                                        */
/* ------------------------------------------------------------------ */

/**
 * A wrapper whose argument is real prose the user keeps editing in place.
 * Beyond the visual styles this covers semantic wrappers (`\footnote`,
 * `\caption`, `\href`, `\textcolor`) — they are StyleNodes because their
 * shape is identical: hidden wrapper tokens around live content.
 */
export type StyleKind =
  | "bold"
  | "italic"
  | "underline"
  | "code"
  | "smallcaps"
  | "sans"
  | "serif"
  | "normal"
  | "sup"
  | "sub"
  | "upper"
  | "lower"
  | "footnote"
  | "caption"
  | "link"
  | "colored"
  // Metadata declarations reached in the BODY (the IEEE class puts them
  // there). In the preamble they are inside the hidden preamble block.
  | "docTitle"
  | "docAuthor"
  | "docDate"
  | "docInstitute";

export interface StyleNode {
  kind: "style";
  from: number;
  to: number;
  style: StyleKind;
  /** Wrapper token ranges to hide (`\textbf{` + `}`, or `{\em ` + `}`). */
  hide: Span[];
  /** The argument text — real, editable document text. */
  content: Span;
  children: InlineNode[];
}

/** Bare `{ … }` group — braces hidden, contents prose. */
export interface GroupNode {
  kind: "group";
  from: number;
  to: number;
  hide: Span[];
  content: Span;
  children: InlineNode[];
}

export interface InlineMathNode {
  kind: "inlineMath";
  from: number;
  to: number;
  /** The TeX between the delimiters. */
  tex: Span;
  delim: "dollar" | "paren";
}

export type PillCommand = "cite" | "ref" | "eqref" | "autoref" | "label";

export interface PillNode {
  kind: "pill";
  from: number;
  to: number;
  command: PillCommand;
  /** `[p. 3]` span including brackets, when present. */
  optArg: Span | null;
  /** Argument text between the braces. */
  arg: Span;
}

/** Unknown-but-bounded command — rendered as an atomic chip. */
export interface CommandNode {
  kind: "command";
  from: number;
  to: number;
  name: string;
  /** Full delimiter-inclusive argument spans (`[..]` and `{..}`). */
  args: Span[];
}

/** `\%`-style escape — renders as the bare glyph. */
export interface EscapeNode {
  kind: "escape";
  from: number;
  to: number;
  ch: string;
}

/** `\\` (+ optional `[len]`) — hard line break. */
export interface LineBreakNode {
  kind: "lineBreak";
  from: number;
  to: number;
}

/** Trailing `%` comment — dim, editable text, never hidden. */
export interface CommentNode {
  kind: "comment";
  from: number;
  to: number;
}

/** `\verb⟨d⟩…⟨d⟩` — atomic chip (contents are display-only until popover). */
export interface VerbNode {
  kind: "verb";
  from: number;
  to: number;
}

/**
 * A single `\n` inside a paragraph. Stays a visible line break (CM6 only
 * lets block decorations span line breaks, so it cannot be widget-hidden);
 * the node exists for the guards and the visible image. `joinTight` marks a
 * newline directly after a trailing `%` comment (TeX eats it).
 */
export interface SoftNewlineNode {
  kind: "softNewline";
  from: number;
  to: number;
  joinTight: boolean;
}

/** A lone unmatched `{` or `}` — one-character warning chip. */
export interface BraceNode {
  kind: "brace";
  from: number;
  to: number;
  side: "open" | "close";
}

export type InlineNode =
  | StyleNode
  | GroupNode
  | InlineMathNode
  | PillNode
  | CommandNode
  | EscapeNode
  | LineBreakNode
  | CommentNode
  | VerbNode
  | SoftNewlineNode
  | BraceNode;

/* ------------------------------------------------------------------ */
/* Block nodes                                                         */
/* ------------------------------------------------------------------ */

export interface PreambleBlock {
  kind: "preamble";
  from: number;
  to: number;
}

/** The `\begin{document}` / `\end{document}` token line — hidden entirely. */
export interface DocMarkerBlock {
  kind: "docBegin" | "docEnd";
  from: number;
  to: number;
}

/** 0 = \part/\chapter … 3 = \subsubsection, 4 = \paragraph, 5 = \subparagraph. */
export type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface HeadingBlock {
  kind: "heading";
  from: number;
  to: number;
  level: HeadingLevel;
  starred: boolean;
  hide: Span[];
  content: Span;
  inlines: InlineNode[];
}

export interface ParagraphBlock {
  kind: "paragraph";
  from: number;
  to: number;
  inlines: InlineNode[];
}

/** `\[…\]` / `$$…$$` — atomic block widget. */
export interface DisplayMathBlock {
  kind: "displayMath";
  from: number;
  to: number;
  tex: Span;
  delim: "bracket" | "dollars";
}

export type EnvKind =
  | "list"
  | "quote"
  | "prose"
  | "mathEnv"
  | "table"
  | "figure"
  | "verbatim"
  | "unknown";

/** Env kinds whose body is parsed into child blocks (prose-transparent). */
export const TRANSPARENT_ENV_KINDS: ReadonlySet<EnvKind> = new Set([
  "list",
  "quote",
  "prose",
]);

export interface EnvironmentBlock {
  kind: "environment";
  from: number;
  to: number;
  name: string;
  envKind: EnvKind;
  /**
   * The `\begin{name}[opt]` token span, extended through the trailing
   * newline when the rest of the line is blank.
   */
  beginToken: Span;
  /** Like beginToken for `\end{name}`; null when the env is unclosed. */
  endToken: Span | null;
  /** Between the tokens. */
  body: Span;
  /** Parsed body for transparent kinds; null for opaque kinds. */
  children: BlockNode[] | null;
  /** True nesting depth of enclosing list envs (this one included). */
  listDepth: number;
}

/**
 * An `\item` (or `\item[label]`) token inside a list env's children. The
 * marker itself is widget-covered; the item's content is the sibling blocks
 * that follow until the next marker.
 */
export interface ItemMarkerBlock {
  kind: "itemMarker";
  from: number;
  to: number;
  hide: Span[];
  /** Custom label text kept visible for `\item[label]`; null otherwise. */
  label: Span | null;
  /** 1-based ordinal within an enumerate; null → bullet. */
  ordinal: number | null;
  depth: number;
}

/** A comment-only line at block level — dim, editable. */
export interface CommentLineBlock {
  kind: "commentLine";
  from: number;
  to: number;
}

/** A maximal run of blank lines — the visible paragraph gap. */
export interface BlankBlock {
  kind: "blank";
  from: number;
  to: number;
}

/**
 * Bounded budget-abort fallback ONLY (never emitted for syntax anomalies —
 * those become chips). Rendered as an honest mono "source island".
 */
export interface RawSourceBlock {
  kind: "rawSource";
  from: number;
  to: number;
  reason: string;
}

/**
 * `\maketitle` alone on its line — the rendered title block.
 *
 * Deliberately carries NO metadata. Title/author/date are resolved by the
 * decoration builder from the whole document text, because the incremental
 * splice reuses untouched nodes verbatim (mapBlock's default arm) and
 * `\title{}` is legal in the body — a borrowed field would go stale the
 * moment its source was edited outside the rescanned region.
 */
export interface TitleBlock {
  kind: "titleBlock";
  from: number;
  to: number;
}

export type BlockNode =
  | PreambleBlock
  | DocMarkerBlock
  | HeadingBlock
  | ParagraphBlock
  | DisplayMathBlock
  | EnvironmentBlock
  | ItemMarkerBlock
  | CommentLineBlock
  | BlankBlock
  | RawSourceBlock
  | TitleBlock;

/* ------------------------------------------------------------------ */
/* Document                                                            */
/* ------------------------------------------------------------------ */

export interface VisualDoc {
  /** Source length the parse describes. */
  length: number;
  /** Top-level blocks, sorted, non-overlapping, tiling `[0, length)`. */
  blocks: BlockNode[];
  /** Offset of `\begin{document}`, or null for fragment files. */
  preambleEnd: number | null;
  /**
   * True when this doc is a mapped-through-changes stale tree (budget abort)
   * rather than a fresh parse; the field schedules an idle reparse.
   */
  stale: boolean;
}

/* ------------------------------------------------------------------ */
/* Lookup helpers                                                      */
/* ------------------------------------------------------------------ */

/** Binary search for the top-level block containing `pos`. */
export function blockIndexAt(doc: VisualDoc, pos: number): number {
  const blocks = doc.blocks;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (pos < b.from) hi = mid - 1;
    else if (pos >= b.to) lo = mid + 1;
    else return mid;
  }
  return blocks.length === 0 ? -1 : Math.min(lo, blocks.length - 1);
}

export function blockAt(doc: VisualDoc, pos: number): BlockNode | null {
  const idx = blockIndexAt(doc, pos);
  if (idx < 0) return null;
  const b = doc.blocks[idx];
  return pos >= b.from && pos < b.to ? b : null;
}

/* ------------------------------------------------------------------ */
/* Coverage — the total-coverage contract, computed                    */
/* ------------------------------------------------------------------ */

export type CoverKind = "content" | "hidden" | "widget";

export interface CoverSpan {
  from: number;
  to: number;
  kind: CoverKind;
}

class CoverageBuilder {
  spans: CoverSpan[] = [];
  private cursor: number;

  constructor(start: number) {
    this.cursor = start;
  }

  push(from: number, to: number, kind: CoverKind): void {
    // Clamp forward: an offset-mapped stale tree can carry distorted spans;
    // coverage must stay sorted and non-overlapping even then (the fresh
    // parse never needs the clamp — assertTotalCoverage would catch it).
    if (from < this.cursor) from = this.cursor;
    if (to <= from) return;
    this.fill(from);
    const last = this.spans[this.spans.length - 1];
    if (last && last.to === from && last.kind === kind) {
      last.to = to;
    } else {
      this.spans.push({ from, to, kind });
    }
    this.cursor = to;
  }

  /** Classify any gap up to `to` as prose content. */
  fill(to: number): void {
    if (to > this.cursor) {
      const from = this.cursor;
      const last = this.spans[this.spans.length - 1];
      if (last && last.to === from && last.kind === "content") {
        last.to = to;
      } else {
        this.spans.push({ from, to, kind: "content" });
      }
      this.cursor = to;
    }
  }

  finish(end: number): void {
    this.fill(end);
  }
}

function coverInlines(b: CoverageBuilder, inlines: InlineNode[]): void {
  for (const node of inlines) {
    switch (node.kind) {
      case "style":
      case "group": {
        // Opening wrapper, children (gaps = prose), closing wrapper.
        b.push(node.from, node.content.from, "hidden");
        coverInlines(b, node.children);
        b.fill(node.content.to);
        b.push(node.content.to, node.to, "hidden");
        break;
      }
      case "inlineMath":
      case "pill":
      case "command":
      case "escape":
      case "lineBreak":
      case "verb":
      case "brace":
        b.push(node.from, node.to, "widget");
        break;
      case "comment":
      case "softNewline":
        // Comments are dim but real, editable text. Intra-paragraph newlines
        // stay visible line breaks: CM6 only lets BLOCK decorations span
        // line breaks, so an inline "space widget" over a newline is not
        // possible — hard-wrapped source keeps its breaks (whitespace, never
        // markup, so the no-inline-reveal policy is unaffected).
        b.push(node.from, node.to, "content");
        break;
      default: {
        // A node kind with no arm here would silently fall through to
        // `fill()` and be classified as content — i.e. its raw markup would
        // render as live text, with assertTotalCoverage still green because
        // tiling holds. Keep this guard: it turns that into a tsc error.
        const exhaustive: never = node;
        void exhaustive;
        break;
      }
    }
  }
}

function coverBlock(b: CoverageBuilder, block: BlockNode): void {
  switch (block.kind) {
    case "preamble":
    case "displayMath":
    case "titleBlock":
      b.push(block.from, block.to, "widget");
      break;
    case "docBegin":
    case "docEnd":
      b.push(block.from, block.to, "hidden");
      break;
    case "heading": {
      b.push(block.from, block.content.from, "hidden");
      coverInlines(b, block.inlines);
      b.push(block.content.to, block.to, "hidden");
      break;
    }
    case "paragraph":
      coverInlines(b, block.inlines);
      b.fill(block.to);
      break;
    case "environment": {
      b.push(block.beginToken.from, block.beginToken.to, "hidden");
      if (block.children !== null) {
        for (const child of block.children) coverBlock(b, child);
        b.fill(block.body.to);
      } else if (block.envKind === "verbatim") {
        // Verbatim body is literal text — showing it IS the faithful render.
        b.push(block.body.from, block.body.to, "content");
      } else {
        b.push(block.body.from, block.body.to, "widget");
      }
      if (block.endToken) {
        b.push(block.endToken.from, block.endToken.to, "hidden");
      }
      break;
    }
    case "itemMarker":
      b.push(block.from, block.to, "widget");
      break;
    case "commentLine":
    case "blank":
    case "rawSource":
      b.push(block.from, block.to, "content");
      break;
    default: {
      const exhaustive: never = block;
      void exhaustive;
      break;
    }
  }
}

/**
 * Classify the whole document. Sorted, non-overlapping, tiling
 * `[0, doc.length)`; adjacent same-kind spans are merged.
 */
export function coverage(doc: VisualDoc): CoverSpan[] {
  const b = new CoverageBuilder(0);
  for (const block of doc.blocks) coverBlock(b, block);
  b.finish(doc.length);
  return b.spans;
}

/**
 * Dev-build falsifier for the total-coverage contract: blocks must tile the
 * document and every classified span must be well-formed. Throws with a
 * precise message on the first violation.
 */
export function assertTotalCoverage(doc: VisualDoc): void {
  let cursor = 0;
  for (const block of doc.blocks) {
    if (block.from !== cursor) {
      throw new Error(
        `visual coverage: block gap/overlap at ${cursor}..${block.from} (${block.kind})`,
      );
    }
    if (block.to < block.from) {
      throw new Error(`visual coverage: negative block ${block.kind} at ${block.from}`);
    }
    cursor = block.to;
  }
  if (cursor !== doc.length) {
    throw new Error(
      `visual coverage: blocks end at ${cursor}, document length ${doc.length}`,
    );
  }
  const spans = coverage(doc);
  let prev = 0;
  for (const s of spans) {
    if (s.from !== prev || s.to < s.from) {
      throw new Error(
        `visual coverage: span gap/overlap at ${prev}..${s.from} (${s.kind})`,
      );
    }
    prev = s.to;
  }
  if (prev !== doc.length) {
    throw new Error(
      `visual coverage: spans end at ${prev}, document length ${doc.length}`,
    );
  }
}
