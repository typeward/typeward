/**
 * Visual editor mode — a CodeMirror 6 decoration layer over the real LaTeX
 * source (plan 63). The layer holds no document state and dispatches no
 * document changes, ever: its only writes are decoration/fold StateEffects,
 * so the document is byte-identical in both modes by construction.
 *
 * Layering (CM6 rule): ViewPlugin-provided decorations must not add block
 * widgets or hide line breaks, so the inline layer (marks, inline replaces,
 * line classes) lives in a ViewPlugin scoped to the visible ranges, and the
 * one block-structure change — the preamble fold — goes through
 * @codemirror/language's fold state field.
 *
 * This module is dynamic-imported by CodeMirror.tsx on first enable (the vim
 * pattern) so scanner + layer stay off the boot path.
 */

import {
  codeFolding,
  foldEffect,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
import type {
  EditorSelection,
  EditorState,
  Extension,
  Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  envCategory,
  findPreambleEnd,
  LOOKBACK_BYTES,
  PREAMBLE_SCAN_BYTES,
  SCAN_BUDGET_MS,
  scanLatex,
  type VisualNode,
} from "./latex-scan";

export interface VisualExtensionConfig {
  /**
   * Raised (at most once per extension instance) when the scan budget
   * aborts — the host marks the file visual-paused for the session and
   * drops the whole extension via its compartment.
   */
  onPause?: () => void;
  /** Injectable clock for the budget guard (tests). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Theme — cm-vis-* classes reading the existing --color-*/--syntax-* tokens.

const visualTheme = EditorView.theme({
  ".cm-vis-h1": { fontSize: "1.3em", fontWeight: "700", color: "var(--color-fg-1)" },
  ".cm-vis-h2": { fontSize: "1.15em", fontWeight: "700", color: "var(--color-fg-1)" },
  ".cm-vis-h3": { fontSize: "1.05em", fontWeight: "600", color: "var(--color-fg-1)" },
  ".cm-vis-bold": { fontWeight: "700" },
  ".cm-vis-italic": { fontStyle: "italic" },
  ".cm-vis-underline": { textDecoration: "underline" },
  ".cm-vis-pill": {
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-control-stroke)",
    borderRadius: "6px",
    padding: "0 5px",
    fontSize: "0.85em",
  },
  ".cm-vis-comment": { opacity: "0.55" },
  ".cm-vis-math": {
    background: "color-mix(in srgb, var(--syntax-math) 10%, transparent)",
    borderRadius: "3px",
  },
  ".cm-vis-line-math": {
    background: "color-mix(in srgb, var(--syntax-math) 7%, transparent)",
  },
  ".cm-vis-line-quote": {
    borderLeft: "2px solid var(--color-control-stroke)",
    paddingLeft: "12px",
  },
  ".cm-vis-line-verbatim": { background: "var(--color-control-fill)" },
  ".cm-vis-line-envtoken": { opacity: "0.55" },
  ".cm-vis-item-marker": { color: "var(--color-fg-2)" },
  ".cm-vis-preamble-chip": {
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-control-stroke)",
    borderRadius: "999px",
    padding: "1px 10px",
    margin: "0 2px",
    fontSize: "0.85em",
    color: "var(--color-fg-2)",
    cursor: "pointer",
  },
});

// ---------------------------------------------------------------------------
// Inline layer — viewport-scoped scan, reveal-on-cursor, budget guard.

const hideDeco = Decoration.replace({});
const markDeco = (cls: string) => Decoration.mark({ class: cls });
const headingDecos = [markDeco("cm-vis-h1"), markDeco("cm-vis-h2"), markDeco("cm-vis-h3")];
const styleDecos = {
  bold: markDeco("cm-vis-bold"),
  italic: markDeco("cm-vis-italic"),
  underline: markDeco("cm-vis-underline"),
} as const;
const pillDeco = markDeco("cm-vis-pill");
const commentDeco = markDeco("cm-vis-comment");
const mathDeco = markDeco("cm-vis-math");

class MarkerWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: MarkerWidget): boolean {
    return other.label === this.label;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-vis-item-marker";
    el.textContent = this.label;
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Touch-inclusive: any selection range counts (plan 63 §1 reveal rule). */
function touchesSelection(sel: EditorSelection, from: number, to: number): boolean {
  for (const r of sel.ranges) {
    if (r.to >= from && r.from <= to) return true;
  }
  return false;
}

function lineDecoFor(node: Extract<VisualNode, { type: "envLine" }>): {
  cls: string;
} | null {
  const cat = envCategory(node.env);
  if (cat === "math") return { cls: "cm-vis-line-math" };
  if (node.role === "interior") {
    if (cat === "quote") return { cls: "cm-vis-line-quote" };
    if (cat === "verbatim") return { cls: "cm-vis-line-verbatim" };
    return null;
  }
  // begin/end lines of list/quote/verbatim envs: dimmed, not hidden.
  return { cls: "cm-vis-line-envtoken" };
}

function buildDecorations(state: EditorState, nodes: VisualNode[]): DecorationSet {
  const sel = state.selection;
  const ranges: Range<Decoration>[] = [];
  const lineSeen = new Set<string>();

  const lineClass = (at: number, cls: string, style?: string) => {
    const line = state.doc.lineAt(at);
    const key = `${line.from}:${cls}:${style ?? ""}`;
    if (lineSeen.has(key)) return;
    lineSeen.add(key);
    ranges.push(
      Decoration.line({
        class: cls,
        ...(style ? { attributes: { style } } : {}),
      }).range(line.from),
    );
  };

  for (const node of nodes) {
    switch (node.type) {
      case "heading": {
        if (touchesSelection(sel, node.from, node.to)) break;
        for (const h of node.hide) ranges.push(hideDeco.range(h.from, h.to));
        ranges.push(headingDecos[node.level - 1].range(node.content.from, node.content.to));
        break;
      }
      case "inlineStyle": {
        if (touchesSelection(sel, node.from, node.to)) break;
        for (const h of node.hide) ranges.push(hideDeco.range(h.from, h.to));
        ranges.push(styleDecos[node.style].range(node.content.from, node.content.to));
        break;
      }
      case "pill": {
        if (touchesSelection(sel, node.from, node.to)) break;
        for (const h of node.hide) ranges.push(hideDeco.range(h.from, h.to));
        ranges.push(pillDeco.range(node.content.from, node.content.to));
        break;
      }
      case "item": {
        // Hanging indent stays even while revealed — only the marker swap
        // is selection-dependent.
        const indent = Math.min(node.depth, 6) * 1.25;
        lineClass(
          node.from,
          "cm-vis-line-item",
          `padding-left:${indent}em;text-indent:-1.25em;`,
        );
        if (touchesSelection(sel, node.from, node.to)) break;
        if (node.label) {
          // Custom label: hide the wrappers, keep the label text.
          for (const h of node.hide) ranges.push(hideDeco.range(h.from, h.to));
        } else {
          const marker = node.ordinal === null ? "• " : `${node.ordinal}. `;
          ranges.push(
            Decoration.replace({ widget: new MarkerWidget(marker) }).range(
              node.hide[0].from,
              node.hide[0].to,
            ),
          );
        }
        break;
      }
      case "envLine": {
        const d = lineDecoFor(node);
        if (d) lineClass(node.from, d.cls);
        break;
      }
      case "comment": {
        if (node.to > node.from) ranges.push(commentDeco.range(node.from, node.to));
        break;
      }
      case "math": {
        if (node.to > node.from) ranges.push(mathDeco.range(node.from, node.to));
        break;
      }
    }
  }
  return Decoration.set(ranges, true);
}

function inlineLayer(config: VisualExtensionConfig): Extension {
  const now = config.now;
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      paused = false;
      nodes: VisualNode[] = [];

      constructor(readonly view: EditorView) {
        this.scanAndBuild(view);
      }

      update(u: ViewUpdate): void {
        if (this.paused) return;
        if (u.docChanged || u.viewportChanged) {
          this.scanAndBuild(u.view);
        } else if (u.selectionSet) {
          // Reveal re-filter only — no rescan (plan 63 §3).
          this.decorations = buildDecorations(u.state, this.nodes);
        }
      }

      scanAndBuild(view: EditorView): void {
        const clock = now ?? (() => performance.now());
        const deadline = clock() + SCAN_BUDGET_MS;
        const collected: VisualNode[] = [];
        const seen = new Set<string>();
        const doc = view.state.doc;
        for (const range of view.visibleRanges) {
          const fromLine = doc.lineAt(range.from);
          const toLine = doc.lineAt(range.to);
          // Bounded lookback so enclosing env openers (list ordinals,
          // quote/verbatim interiors) are seen; openers further out simply
          // render their construct as source.
          const lookStart = doc.lineAt(
            Math.max(0, fromLine.from - LOOKBACK_BYTES),
          ).from;
          const res = scanLatex(doc.sliceString(lookStart, toLine.to), lookStart, {
            now: clock,
            deadlineMs: deadline,
          });
          if (res.aborted) {
            this.pause();
            return;
          }
          for (const node of res.nodes) {
            if (node.to < fromLine.from || node.from > toLine.to) continue;
            const key = `${node.from}:${node.to}:${node.type}`;
            if (!seen.has(key)) {
              seen.add(key);
              collected.push(node);
            }
          }
        }
        this.nodes = collected;
        this.decorations = buildDecorations(view.state, collected);
      }

      pause(): void {
        this.paused = true;
        this.nodes = [];
        this.decorations = Decoration.none;
        // Deferred: the host reacts by reconfiguring the compartment, which
        // must not happen inside the current update cycle.
        queueMicrotask(() => config.onPause?.());
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------------------------------------------------------------------------
// Preamble fold — the one block-structure change, via the fold state field.

function preambleChip(_view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-vis-preamble-chip";
  el.textContent = "Preamble";
  el.title = "Show the preamble";
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", "Expand preamble");
  el.onclick = onclick;
  return el;
}

/** The visual layer is the only fold source, so the first fold is ours. */
function currentPreambleFold(state: EditorState): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    found = { from, to };
    return false;
  });
  return found;
}

function preambleFold(): Extension {
  return [
    codeFolding({ placeholderDOM: preambleChip }),
    ViewPlugin.fromClass(
      class {
        /** Once unfolded (chip click or selection), stays so for the mount. */
        unfolded = false;
        everFolded = false;
        destroyed = false;

        constructor(readonly view: EditorView) {
          const head = view.state.doc.sliceString(0, PREAMBLE_SCAN_BYTES);
          const at = findPreambleEnd(head);
          if (at === null) return;
          const beginLine = view.state.doc.lineAt(at);
          if (beginLine.number <= 1) return;
          const to = beginLine.from - 1;
          if (to <= 0) return;
          // Fold once per mount; a selection already inside the preamble at
          // mount doesn't block it — only post-mount selection changes unfold.
          queueMicrotask(() => {
            if (this.destroyed || this.unfolded) return;
            this.view.dispatch({ effects: foldEffect.of({ from: 0, to }) });
          });
        }

        update(u: ViewUpdate): void {
          if (this.unfolded) return;
          const fold = currentPreambleFold(u.state);
          if (fold) {
            this.everFolded = true;
            if (u.selectionSet && touchesSelection(u.state.selection, fold.from, fold.to)) {
              // Goto intents (SyncTeX, search, panel jumps) land here as
              // plain selection dispatches.
              this.unfolded = true;
              queueMicrotask(() => {
                if (this.destroyed) return;
                const cur = currentPreambleFold(this.view.state);
                if (cur) this.view.dispatch({ effects: unfoldEffect.of(cur) });
              });
            }
          } else if (this.everFolded) {
            // Chip click unfolded it — don't refold this mount.
            this.unfolded = true;
          }
        }

        destroy(): void {
          this.destroyed = true;
        }
      },
    ),
  ];
}

// ---------------------------------------------------------------------------

/**
 * The complete visual-mode extension. Mounted through a compartment by
 * CodeMirror.tsx so toggling preserves undo history, cursor, scroll, and the
 * LSP session.
 */
export function visualExtension(config: VisualExtensionConfig = {}): Extension {
  return [visualTheme, preambleFold(), inlineLayer(config)];
}
