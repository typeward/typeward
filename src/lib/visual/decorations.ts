/**
 * Builds the visual mode's DecorationSet + atomic ranges from a VisualDoc.
 *
 * Legality rules this module encodes (CM6):
 * - Inline replace decorations may NOT span line breaks; only block
 *   decorations may. `hideRange` therefore splits a multi-line hide into
 *   legal pieces: first-line inline (carrying any inline widget), full
 *   middle lines as block replaces (newline-inclusive), final partial line
 *   inline. A line break directly after the first piece stays visible —
 *   whitespace, never markup.
 * - Block replaces cover whole lines including their terminating newline,
 *   so hidden `\begin{itemize}` lines vanish without leaving a blank row.
 *
 * Atomic ranges mirror the nodes' hidden/widget spans (not the render
 * pieces), so caret motion skips whole constructs.
 */

import type { Range, Text } from "@codemirror/state";
import { RangeSet, RangeValue } from "@codemirror/state";
import type { DecorationSet, WidgetType } from "@codemirror/view";
import { Decoration } from "@codemirror/view";

import type {
  BlockNode,
  EnvironmentBlock,
  InlineNode,
  Span,
  VisualDoc,
} from "./parse";
import { MAX_OPT_ARG, matchBrace, scanInline, skipInlineSpace } from "./parse";
import {
  BlockCardWidget,
  ChipWidget,
  GhostWidget,
  GlyphWidget,
  MarkerWidget,
  PreambleWidget,
  TitleWidget,
} from "./widgets/chips";
import { InlineMathWidget, MathBlockWidget, mathEnvToKatex } from "./widgets/math";
import { FigureWidget, isRenderableImage, parseFigure } from "./widgets/figure";
import { TableWidget, parseTabular } from "./widgets/table";

export interface DecorationConfig {
  resolveAsset?: (relPath: string) => string | null;
}

/**
 * The role a hidden/widget span plays in its construct — the edit guards
 * use this to keep wrapper pairs balanced (deleting one half of a pair is
 * never allowed unless the whole construct goes) and to pick Backspace
 * semantics (retarget into content vs select-then-delete vs direct delete).
 */
export type AtomicRole = "open" | "close" | "solo";

export type AtomicKind =
  | "style"
  | "group"
  | "heading"
  | "environment"
  | "itemMarker"
  | "widget" // math/pill/command/verb/cards — select-then-delete
  | "glyph" // escapes/braces/line breaks — direct delete
  | "doc"; // preamble/docBegin/docEnd

export class AtomicMarker extends RangeValue {
  constructor(
    readonly role: AtomicRole,
    readonly kind: AtomicKind,
    /** Full construct span this piece belongs to. */
    readonly cFrom: number,
    readonly cTo: number,
    /** Content span for pair constructs (equal offsets when empty). */
    readonly contentFrom: number,
    readonly contentTo: number,
  ) {
    super();
  }
}

export interface BuiltDecorations {
  decorations: DecorationSet;
  atomics: RangeSet<AtomicMarker>;
}

const clip = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max - 1) + "…" : s;

const STYLE_CLASS: Record<string, string> = {
  bold: "cm-vis-b",
  italic: "cm-vis-i",
  underline: "cm-vis-u",
  code: "cm-vis-code",
  smallcaps: "cm-vis-sc",
  sans: "cm-vis-sans",
  serif: "cm-vis-serif",
  normal: "cm-vis-normal",
  sup: "cm-vis-sup",
  sub: "cm-vis-sub",
  upper: "cm-vis-upper",
  lower: "cm-vis-lower",
  footnote: "cm-vis-footnote",
  caption: "cm-vis-caption",
  link: "cm-vis-link",
  colored: "cm-vis-colored",
  docTitle: "cm-vis-field",
  docAuthor: "cm-vis-field",
  docDate: "cm-vis-field",
  docInstitute: "cm-vis-field",
};

/**
 * Metadata declarations print nothing where they stand — but hiding them
 * outright would make the title uneditable in visual mode for classes that
 * declare it in the body. They render as a labelled field row instead: the
 * value stays live text, the label says which field it is.
 */
const FIELD_LABELS: Record<string, string> = {
  docTitle: "Title",
  docAuthor: "Author",
  docDate: "Date",
  docInstitute: "Institute",
};

/**
 * Placeholder text for an emptied construct. StyleKind identifiers are an
 * internal enum, so they get spelled out — `docTitle` on the page would be
 * as wrong as raw markup.
 */
const GHOST_LABEL: Record<string, string> = {
  smallcaps: "small caps",
  sup: "superscript",
  sub: "subscript",
  upper: "uppercase",
  lower: "lowercase",
  normal: "text",
  serif: "text",
  sans: "text",
  colored: "colored text",
  docTitle: "title",
  docAuthor: "author",
  docDate: "date",
  docInstitute: "institute",
};

const HEADING_MARK = [
  "cm-vis-h0",
  "cm-vis-h1",
  "cm-vis-h2",
  "cm-vis-h3",
  "cm-vis-h4",
  "cm-vis-h5",
];

/**
 * A chip stands in for a construct we don't render; its text is a LABEL, not
 * the source. A backslash-prefixed control word on the page is exactly the
 * markup leak the no-inline-reveal policy exists to prevent — so every chip
 * either gets a human phrase here or falls back to the bare name.
 */
const COMMAND_LABELS: Record<string, string> = {
  maketitle: "Title block",
  tableofcontents: "Table of contents",
  listoffigures: "List of figures",
  listoftables: "List of tables",
  newpage: "Page break",
  clearpage: "Page break",
  cleardoublepage: "Page break",
  pagebreak: "Page break",
  linebreak: "Line break",
  newline: "Line break",
  appendix: "Appendix",
  printbibliography: "Bibliography",
  printindex: "Index",
  makeindex: "Index",
  noindent: "No indent",
  indent: "Indent",
  centering: "Centered",
  raggedright: "Ragged right",
  raggedleft: "Ragged left",
  par: "Paragraph break",
  vspace: "Space",
  hspace: "Space",
  bigskip: "Space",
  medskip: "Space",
  smallskip: "Space",
  vfill: "Fill",
  hfill: "Fill",
  today: "Today's date",
  and: "and",
  thanks: "Thanks",
  footnotemark: "Footnote mark",
  pagestyle: "Page style",
  thispagestyle: "Page style",
  setlength: "Layout setting",
  usepackage: "Package",
  hline: "Rule",
  toprule: "Rule",
  midrule: "Rule",
  bottomrule: "Rule",
};

/** Commands whose chip names the file they pull in. */
const FILE_ARG_LABELS: Record<string, string> = {
  input: "Include",
  include: "Include",
  includeonly: "Include only",
  bibliography: "Bibliography",
  addbibresource: "Bibliography",
  bibliographystyle: "Bibliography style",
  includegraphics: "Image",
  documentclass: "Document class",
};

/** Bytes of leading document scanned for `\title` / `\author` / `\date`. */
const TITLE_SCAN_BYTES = 20_000;

export interface TitleMeta {
  title: string;
  author: string;
  date: string;
}

const collapseSpace = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Flatten a prose span to the plain text it renders as — used for widget
 * labels, where markup must never appear. Built on the real scanner rather
 * than a regex: `\title{A \textbf{B}}` would otherwise truncate at the inner
 * brace, and the IEEE template's `\author{\IEEEauthorblockA{Names}}` would
 * lose the names entirely unless unknown commands' arguments are descended
 * into. Anything with no text of its own contributes a single space.
 */
function plainInlineText(
  text: string,
  from: number,
  to: number,
  today: string,
): string {
  let out = "";
  const walk = (nodes: InlineNode[], cursorFrom: number, cursorTo: number): void => {
    let cursor = cursorFrom;
    for (const node of nodes) {
      if (node.from > cursor) out += text.slice(cursor, node.from);
      switch (node.kind) {
        case "style":
        case "group":
          walk(node.children, node.content.from, node.content.to);
          break;
        case "command":
          if (node.name === "today") out += today;
          else if (node.name === "and") out += " · ";
          else {
            for (const arg of node.args) {
              // Brace arguments only — `[..]` options are never prose.
              if (text.charCodeAt(arg.from) === 123 /* { */) {
                walk(scanInline(text, arg.from + 1, arg.to - 1), arg.from + 1, arg.to - 1);
              }
            }
          }
          break;
        case "escape":
          out += node.ch;
          break;
        case "comment":
          break;
        default:
          out += " ";
          break;
      }
      cursor = node.to;
    }
    if (cursor < cursorTo) out += text.slice(cursor, cursorTo);
  };
  walk(scanInline(text, from, to), from, to);
  return collapseSpace(out);
}

/**
 * Collect body-declared metadata argument spans from the parse tree, last
 * declaration winning. Verbatim environments have null children, so their
 * bodies are structurally unreachable from here.
 */
function collectFieldSpans(
  blocks: BlockNode[],
  upTo: number,
  out: Map<string, Span>,
): void {
  const walkInline = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.from >= upTo) return;
      if (node.kind === "style") {
        if (FIELD_LABELS[node.style] !== undefined && node.content.to <= upTo) {
          out.set(node.style, node.content);
        }
        walkInline(node.children);
      } else if (node.kind === "group") {
        walkInline(node.children);
      }
    }
  };
  for (const block of blocks) {
    if (block.from >= upTo) return;
    if (block.kind === "paragraph" || block.kind === "heading") {
      walkInline(block.inlines);
    } else if (block.kind === "environment" && block.children !== null) {
      collectFieldSpans(block.children, upTo, out);
    }
  }
}

/** Locate `\name{…}` in `text[0, limit)` and return its argument interior. */
function findFieldArg(text: string, name: string, limit: number): Span | null {
  const needle = `\\${name}`;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (at >= limit) return null;
    // Must be the whole control word (`\date` must not match `\dateformat`),
    // and must not be an escaped `\\name` or sit inside a `%` comment.
    const after = at + needle.length;
    if (isLetterCode(text.charCodeAt(after))) continue;
    if (text.charCodeAt(at - 1) === 92 /* \ */) continue;
    if (isCommented(text, at)) continue;
    // `\title[short]{full}` — beamer uses the short form for running heads.
    let cursor = skipInlineSpace(text, after);
    if (text.charCodeAt(cursor) === 91 /* [ */) {
      const rb = text.indexOf("]", cursor + 1);
      const eol = text.indexOf("\n", cursor);
      if (rb === -1 || rb >= limit || rb - cursor > MAX_OPT_ARG || (eol !== -1 && rb > eol)) {
        continue;
      }
      cursor = skipInlineSpace(text, rb + 1);
    }
    if (text.charCodeAt(cursor) !== 123 /* { */) continue;
    const close = matchBrace(text, cursor, MAX_FIELD_ARG, false, limit);
    if (close === -1) continue;
    return { from: cursor + 1, to: close };
  }
  return null;
}

const MAX_FIELD_ARG = 2000;

const isLetterCode = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/** `\today` renders as LaTeX prints it: "August 1, 2026". */
function formatToday(): string {
  return new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function isCommented(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf("\n", at) + 1;
  for (let j = lineStart; j < at; j++) {
    const c = text.charCodeAt(j);
    if (c === 92 /* \ */) {
      j++;
      continue;
    }
    if (c === 37 /* % */) return true;
  }
  return false;
}

class Builder {
  decos: Range<Decoration>[] = [];
  atomics: Range<AtomicMarker>[] = [];
  /** lineStart → class names, applied at the end as line decorations. */
  lineClasses = new Map<number, Set<string>>();
  private meta: TitleMeta | null = null;

  constructor(
    readonly doc: VisualDoc,
    readonly text: Text,
    readonly cfg: DecorationConfig,
  ) {}

  slice(s: Span): string {
    return this.text.sliceString(s.from, s.to);
  }

  /**
   * Title/author/date for a `\maketitle` at `upTo`. Resolved here rather than
   * in the parser because the incremental splice reuses untouched nodes
   * verbatim — a field carried on the node would go stale as soon as its
   * source was edited outside the rescanned region, and `\title{}` is legal
   * in the body (the IEEE template does exactly that).
   *
   * Memoized per build: buildDecorations runs unbudgeted on every docChanged
   * transaction, so this must not be O(title blocks × scan) per keystroke.
   */
  titleMeta(upTo: number): TitleMeta {
    if (this.meta !== null) return this.meta;
    const headLimit = Math.min(upTo, TITLE_SCAN_BYTES);
    const head = this.text.sliceString(0, headLimit);
    const today = formatToday();

    // Preamble is one opaque block, so it is never scanned inline — read it
    // as raw text. The scan stops at \begin{document} so a `\title` written
    // inside a verbatim/listing body downstream can never win.
    const preambleLimit =
      this.doc.preambleEnd === null
        ? 0
        : Math.min(this.doc.preambleEnd, headLimit);
    const raw = (name: string): Span | null =>
      preambleLimit === 0 ? null : findFieldArg(head, name, preambleLimit);

    // Body declarations come from the parse tree (the IEEE class puts them
    // there) and override the preamble — in LaTeX the last one wins.
    const fromBody = new Map<string, Span>();
    collectFieldSpans(this.doc.blocks, headLimit, fromBody);

    const field = (style: string, name: string): Span | null =>
      fromBody.get(style) ?? raw(name);
    const flatten = (s: Span | null): string =>
      s === null ? "" : plainInlineText(head, s.from, s.to, today);
    const dateSpan = field("docDate", "date");
    this.meta = {
      title: flatten(field("docTitle", "title")) || "Untitled",
      author: flatten(field("docAuthor", "author")),
      // LaTeX defaults \date to today; an explicit `\date{}` means no date.
      date: dateSpan === null ? today : flatten(dateSpan),
    };
    return this.meta;
  }

  atomic(
    from: number,
    to: number,
    role: AtomicRole,
    kind: AtomicKind,
    cFrom: number,
    cTo: number,
    contentFrom = from,
    contentTo = from,
  ): void {
    if (to > from) {
      this.atomics.push(
        new AtomicMarker(role, kind, cFrom, cTo, contentFrom, contentTo).range(from, to),
      );
    }
  }

  /** Both wrapper halves of a pair construct in one call. */
  pair(
    kind: AtomicKind,
    cFrom: number,
    cTo: number,
    open: Span,
    close: Span,
    content: Span,
  ): void {
    this.atomic(open.from, open.to, "open", kind, cFrom, cTo, content.from, content.to);
    this.atomic(close.from, close.to, "close", kind, cFrom, cTo, content.from, content.to);
  }

  mark(from: number, to: number, className: string): void {
    if (to > from) {
      this.decos.push(Decoration.mark({ class: className }).range(from, to));
    }
  }

  widgetAt(pos: number, widget: WidgetType, side = 1): void {
    this.decos.push(Decoration.widget({ widget, side }).range(pos));
  }

  addLineClass(lineStart: number, className: string): void {
    let set = this.lineClasses.get(lineStart);
    if (!set) {
      set = new Set();
      this.lineClasses.set(lineStart, set);
    }
    set.add(className);
  }

  /** Apply a class to every line whose start falls in [from, to). */
  classLines(from: number, to: number, className: string): void {
    if (to <= from) return;
    let line = this.text.lineAt(from);
    for (;;) {
      this.addLineClass(line.from, className);
      if (line.to + 1 > to || line.to >= this.text.length) break;
      line = this.text.lineAt(line.to + 1);
      if (line.from >= to) break;
    }
  }

  /**
   * Hide [from, to), optionally rendering `widget` in place of the first
   * piece. Splits into CM-legal pieces (see module comment). `blockCard`
   * renders the widget as a block when the range is fully line-aligned.
   */
  hideRange(
    from: number,
    to: number,
    widget: WidgetType | null = null,
    blockCard = false,
  ): void {
    if (to <= from) {
      if (widget) this.widgetAt(from, widget);
      return;
    }
    const doc = this.text;
    const firstLine = doc.lineAt(from);
    const lastEnd = doc.lineAt(to === 0 ? 0 : to - 1);

    // Single-line range → one inline replace. Exception: a block card on the
    // final line of a file with no trailing newline is still line-aligned,
    // and rendering block DOM through an inline replace breaks CM6's
    // measurement (posAtDOM / coordsAtPos, which the popover depends on).
    const lastLineNoBreak =
      blockCard && widget !== null && from === firstLine.from && to === doc.length;
    if (to <= firstLine.to && !lastLineNoBreak) {
      this.decos.push(
        Decoration.replace(widget ? { widget } : {}).range(from, to),
      );
      return;
    }

    const atLineStart = from === firstLine.from;
    const atLineBoundary = to === lastEnd.to + 1 || to === doc.length;
    if (atLineStart && atLineBoundary) {
      // Fully line-aligned → one block replace (line rows vanish).
      this.decos.push(
        Decoration.replace(
          widget && blockCard ? { widget, block: true } : { block: true },
        ).range(from, to),
      );
      if (widget && !blockCard) this.widgetAt(from, widget);
      return;
    }

    // Mixed: first-line inline piece (carries the widget), middle full
    // lines as block pieces, trailing partial line inline.
    if (from < firstLine.to) {
      this.decos.push(
        Decoration.replace(widget ? { widget } : {}).range(
          from,
          Math.min(to, firstLine.to),
        ),
      );
    } else if (widget) {
      this.widgetAt(from, widget);
    }
    let cursor = firstLine.to + 1;
    while (cursor < to) {
      const line = doc.lineAt(cursor);
      const lineEndIncl = Math.min(line.to + 1, doc.length);
      if (lineEndIncl <= to && cursor === line.from) {
        this.decos.push(Decoration.replace({ block: true }).range(cursor, lineEndIncl));
        cursor = lineEndIncl;
        continue;
      }
      // Trailing partial line.
      if (to > cursor) {
        this.decos.push(Decoration.replace({}).range(cursor, to));
      }
      break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Inline walk                                                         */
/* ------------------------------------------------------------------ */

/**
 * The visible text of a command chip. Never the markup: a known command gets
 * a human phrase, a file-taking one names its file, and everything else gets
 * the bare control word WITHOUT the backslash. The full source stays in the
 * chip's tooltip, which is not part of the rendered page.
 */
function commandLabel(
  b: Builder,
  node: Extract<InlineNode, { kind: "command" }>,
): string {
  const known = COMMAND_LABELS[node.name];
  if (known !== undefined) return known;
  const fileLabel = FILE_ARG_LABELS[node.name];
  if (fileLabel !== undefined) {
    const braceArg = node.args.find(
      (a) => b.text.sliceString(a.from, a.from + 1) === "{",
    );
    if (braceArg) {
      const inner = b.text.sliceString(braceArg.from + 1, braceArg.to - 1).trim();
      if (inner !== "") return `${fileLabel} — ${clip(inner, 40)}`;
    }
    return fileLabel;
  }
  return clip(node.name, 24);
}

/** Marker rendered in place of a style's opening wrapper token, if any. */
function styleOpenWidget(style: string): WidgetType | null {
  if (style === "footnote") return new GlyphWidget("†");
  const field = FIELD_LABELS[style];
  return field === undefined
    ? null
    : new ChipWidget(field, "cm-vis-field-label", `\\${style.slice(3).toLowerCase()}`, false);
}

/** `\verb|foo|` → `foo`. Falls back to the source if the shape is odd. */
function verbPayload(src: string): string {
  const at = src.startsWith("\\verb*") ? 6 : 5;
  const delim = src[at];
  if (delim === undefined || src.length < at + 2) return src;
  const end = src.lastIndexOf(delim);
  return end > at ? src.slice(at + 1, end) : src;
}

function walkInlines(b: Builder, inlines: InlineNode[]): void {
  for (const node of inlines) {
    switch (node.kind) {
      case "style": {
        // The opening wrapper can carry a marker where the construct needs
        // one to be legible: a footnote dagger, a metadata field label.
        b.hideRange(node.hide[0].from, node.hide[0].to, styleOpenWidget(node.style));
        b.hideRange(node.hide[1].from, node.hide[1].to);
        b.pair("style", node.from, node.to, node.hide[0], node.hide[1], node.content);
        if (node.content.to > node.content.from) {
          b.mark(node.content.from, node.content.to, STYLE_CLASS[node.style]);
        } else {
          b.widgetAt(
            node.content.from,
            new GhostWidget(GHOST_LABEL[node.style] ?? node.style),
          );
        }
        walkInlines(b, node.children);
        break;
      }
      case "group": {
        b.hideRange(node.hide[0].from, node.hide[0].to);
        b.hideRange(node.hide[1].from, node.hide[1].to);
        b.pair("group", node.from, node.to, node.hide[0], node.hide[1], node.content);
        walkInlines(b, node.children);
        break;
      }
      case "inlineMath": {
        b.hideRange(
          node.from,
          node.to,
          new InlineMathWidget(b.slice(node.tex)),
        );
        b.atomic(node.from, node.to, "solo", "widget", node.from, node.to);
        break;
      }
      case "pill": {
        const label = clip(b.slice(node.arg), 30);
        const cls = `cm-vis-pill cm-vis-pill-${node.command}`;
        const src = b.text.sliceString(node.from, node.to);
        b.hideRange(node.from, node.to, new ChipWidget(label, cls, clip(src, 200), false));
        b.atomic(node.from, node.to, "solo", "widget", node.from, node.to);
        break;
      }
      case "command": {
        const src = b.text.sliceString(node.from, node.to);
        b.hideRange(
          node.from,
          node.to,
          new ChipWidget(commandLabel(b, node), "cm-vis-cmd-chip", clip(src, 200), false),
        );
        b.atomic(node.from, node.to, "solo", "widget", node.from, node.to);
        break;
      }
      case "escape": {
        b.hideRange(node.from, node.to, new GlyphWidget(node.ch));
        b.atomic(node.from, node.to, "solo", "glyph", node.from, node.to);
        break;
      }
      case "lineBreak": {
        b.hideRange(
          node.from,
          node.to,
          new ChipWidget("⏎", "cm-vis-break-chip", "Line break (\\\\)", false),
        );
        b.atomic(node.from, node.to, "solo", "glyph", node.from, node.to);
        break;
      }
      case "verb": {
        const src = b.text.sliceString(node.from, node.to);
        // The chip shows the verbatim PAYLOAD, not `\verb|payload|` — the
        // delimiters are markup. Mono stays: the payload really is code.
        b.hideRange(
          node.from,
          node.to,
          new ChipWidget(clip(verbPayload(src), 40), "cm-vis-verb-chip", src, false),
        );
        b.atomic(node.from, node.to, "solo", "widget", node.from, node.to);
        break;
      }
      case "comment": {
        b.mark(node.from, node.to, "cm-vis-comment");
        break;
      }
      case "brace": {
        b.hideRange(
          node.from,
          node.to,
          new ChipWidget(
            node.side === "open" ? "{" : "}",
            "cm-vis-brace-chip",
            "Unmatched brace",
            false,
          ),
        );
        b.atomic(node.from, node.to, "solo", "glyph", node.from, node.to);
        break;
      }
      case "softNewline":
        break;
      default: {
        // Without this, a new node kind renders its raw markup as live text.
        const exhaustive: never = node;
        void exhaustive;
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Block walk                                                          */
/* ------------------------------------------------------------------ */

interface WalkCtx {
  /** Hanging-indent depth for item content lines (0 = none). */
  itemDepth: number;
}

const ENV_CARD_LABEL: Record<string, string> = {
  mathEnv: "equation",
  table: "table",
  figure: "figure",
  unknown: "environment",
};

function envCard(b: Builder, block: EnvironmentBlock): void {
  const body = b.text.sliceString(block.body.from, block.body.to);
  if (block.envKind === "mathEnv") {
    const tex = mathEnvToKatex(body, block.name);
    b.hideRange(block.from, block.to, new MathBlockWidget(tex, block.name), true);
    b.atomic(block.from, block.to, "solo", "widget", block.from, block.to);
    return;
  }
  if (block.envKind === "table") {
    const parsed = parseTabular(body);
    if (parsed) {
      b.hideRange(block.from, block.to, new TableWidget(parsed, body), true);
      b.atomic(block.from, block.to, "solo", "widget", block.from, block.to);
      return;
    }
  }
  if (block.envKind === "figure") {
    const fig = parseFigure(body);
    const src =
      fig.imagePath !== null &&
      isRenderableImage(fig.imagePath) &&
      b.cfg.resolveAsset
        ? b.cfg.resolveAsset(fig.imagePath)
        : null;
    b.hideRange(block.from, block.to, new FigureWidget(fig, src, body), true);
    b.atomic(block.from, block.to, "solo", "widget", block.from, block.to);
    return;
  }
  const label =
    block.envKind === "unknown"
      ? block.name
      : (ENV_CARD_LABEL[block.envKind] ?? block.name);
  b.hideRange(
    block.from,
    block.to,
    new BlockCardWidget(block.envKind, label, "", false),
    true,
  );
  b.atomic(block.from, block.to, "solo", "widget", block.from, block.to);
}

function walkBlocks(b: Builder, blocks: BlockNode[], ctx: WalkCtx): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "preamble": {
        const src = b.text.sliceString(block.from, Math.min(block.to, block.from + 4000));
        const m = /\\documentclass(?:\[([^\]\n]*)\])?\s*\{([a-zA-Z0-9-]+)\}/.exec(src);
        const summary = m
          ? `Document settings — ${m[2]}${m[1] ? ` · ${clip(m[1], 40)}` : ""}`
          : "Document settings";
        b.hideRange(block.from, block.to, new PreambleWidget(summary, false), true);
        b.atomic(block.from, block.to, "solo", "doc", block.from, block.to);
        break;
      }
      case "titleBlock": {
        const m = b.titleMeta(block.from);
        b.hideRange(
          block.from,
          block.to,
          new TitleWidget(m.title, m.author, m.date, false),
          true,
        );
        b.atomic(block.from, block.to, "solo", "widget", block.from, block.to);
        break;
      }
      case "docBegin":
      case "docEnd": {
        b.hideRange(block.from, block.to);
        b.atomic(block.from, block.to, "solo", "doc", block.from, block.to);
        break;
      }
      case "heading": {
        b.hideRange(block.hide[0].from, block.hide[0].to);
        // The closing wrapper may extend through the trailing newline; the
        // piece splitter keeps that newline visible (line separator), while
        // the atomic range covers it so the caret exits cleanly.
        b.hideRange(block.hide[1].from, block.hide[1].to);
        b.pair("heading", block.from, block.to, block.hide[0], block.hide[1], block.content);
        if (block.content.to > block.content.from) {
          b.mark(block.content.from, block.content.to, HEADING_MARK[block.level]);
        } else {
          b.widgetAt(block.content.from, new GhostWidget("heading"));
        }
        b.addLineClass(
          b.text.lineAt(block.from).from,
          `cm-vis-line-h${block.level}`,
        );
        walkInlines(b, block.inlines);
        break;
      }
      case "paragraph": {
        if (ctx.itemDepth > 0) {
          b.classLines(
            block.from,
            block.to,
            `cm-vis-line-item cm-vis-line-item-d${Math.min(ctx.itemDepth, 4)}`,
          );
        }
        walkInlines(b, block.inlines);
        break;
      }
      case "displayMath": {
        b.hideRange(
          block.from,
          block.to,
          new MathBlockWidget(b.slice(block.tex).trim(), "equation"),
          true,
        );
        b.atomic(block.from, block.to, "solo", "widget", block.from, block.to);
        break;
      }
      case "environment": {
        if (block.children !== null) {
          b.hideRange(block.beginToken.from, block.beginToken.to);
          b.atomic(
            block.beginToken.from,
            block.beginToken.to,
            "open",
            "environment",
            block.from,
            block.to,
            block.body.from,
            block.body.to,
          );
          if (block.endToken) {
            b.hideRange(block.endToken.from, block.endToken.to);
            b.atomic(
              block.endToken.from,
              block.endToken.to,
              "close",
              "environment",
              block.from,
              block.to,
              block.body.from,
              block.body.to,
            );
          }
          if (block.envKind === "quote") {
            b.classLines(block.body.from, block.body.to, "cm-vis-line-quote");
          } else if (block.envKind === "prose" && block.name === "center") {
            b.classLines(block.body.from, block.body.to, "cm-vis-line-center");
          }
          const childCtx: WalkCtx =
            block.envKind === "list"
              ? { itemDepth: block.listDepth }
              : ctx;
          walkBlocks(b, block.children, childCtx);
        } else if (block.envKind === "verbatim") {
          b.hideRange(block.beginToken.from, block.beginToken.to);
          b.atomic(
            block.beginToken.from,
            block.beginToken.to,
            "open",
            "environment",
            block.from,
            block.to,
            block.body.from,
            block.body.to,
          );
          if (block.endToken) {
            b.hideRange(block.endToken.from, block.endToken.to);
            b.atomic(
              block.endToken.from,
              block.endToken.to,
              "close",
              "environment",
              block.from,
              block.to,
              block.body.from,
              block.body.to,
            );
          }
          b.classLines(block.body.from, block.body.to, "cm-vis-line-verbatim");
        } else {
          envCard(b, block);
        }
        break;
      }
      case "itemMarker": {
        const label = block.label
          ? b.slice(block.label)
          : block.ordinal !== null
            ? `${block.ordinal}.`
            : "•";
        b.hideRange(
          block.from,
          block.to,
          new MarkerWidget(label, block.depth),
        );
        b.atomic(block.from, block.to, "solo", "itemMarker", block.from, block.to);
        b.addLineClass(
          b.text.lineAt(block.from).from,
          `cm-vis-line-item cm-vis-line-item-d${Math.min(block.depth, 4)}`,
        );
        break;
      }
      case "commentLine": {
        b.classLines(block.from, block.to, "cm-vis-line-comment");
        b.mark(block.from, Math.min(block.to, b.text.lineAt(block.from).to), "cm-vis-comment");
        break;
      }
      case "blank":
      case "rawSource": {
        if (block.kind === "rawSource") {
          b.classLines(block.from, block.to, "cm-vis-line-raw");
        }
        break;
      }
      default: {
        const exhaustive: never = block;
        void exhaustive;
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

export function buildDecorations(
  doc: VisualDoc,
  text: Text,
  cfg: DecorationConfig = {},
): BuiltDecorations {
  const b = new Builder(doc, text, cfg);
  walkBlocks(b, doc.blocks, { itemDepth: 0 });
  for (const [lineStart, classes] of b.lineClasses) {
    b.decos.push(
      Decoration.line({ class: [...classes].join(" ") }).range(lineStart),
    );
  }
  return {
    decorations: Decoration.set(b.decos, true),
    atomics: RangeSet.of(b.atomics, true),
  };
}
