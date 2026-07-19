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
import {
  BlockCardWidget,
  ChipWidget,
  GhostWidget,
  GlyphWidget,
  MarkerWidget,
  PreambleWidget,
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
};

const HEADING_MARK = ["", "cm-vis-h1", "cm-vis-h2", "cm-vis-h3"];

class Builder {
  decos: Range<Decoration>[] = [];
  atomics: Range<AtomicMarker>[] = [];
  /** lineStart → class names, applied at the end as line decorations. */
  lineClasses = new Map<number, Set<string>>();

  constructor(
    readonly text: Text,
    readonly cfg: DecorationConfig,
  ) {}

  slice(s: Span): string {
    return this.text.sliceString(s.from, s.to);
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

    // Single-line range → one inline replace.
    if (to <= firstLine.to) {
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

function walkInlines(b: Builder, inlines: InlineNode[]): void {
  for (const node of inlines) {
    switch (node.kind) {
      case "style": {
        b.hideRange(node.hide[0].from, node.hide[0].to);
        b.hideRange(node.hide[1].from, node.hide[1].to);
        b.pair("style", node.from, node.to, node.hide[0], node.hide[1], node.content);
        if (node.content.to > node.content.from) {
          b.mark(node.content.from, node.content.to, STYLE_CLASS[node.style]);
        } else {
          b.widgetAt(node.content.from, new GhostWidget(node.style));
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
          new ChipWidget(
            clip(`\\${node.name}`, 24),
            "cm-vis-cmd-chip",
            clip(src, 200),
            false,
          ),
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
        b.hideRange(
          node.from,
          node.to,
          new ChipWidget(clip(src, 40), "cm-vis-verb-chip", src, false),
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
  const b = new Builder(text, cfg);
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
