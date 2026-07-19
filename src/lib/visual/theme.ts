import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * The visual mode's document surface: the buffer renders as a centered page
 * card with a serif reading measure instead of a code pane. Selectors are
 * prefixed `&.cm-editor` so they outrank the component's baseTheme and the
 * metrics compartment (both use bare `&` / `.cm-content` selectors) without
 * fighting over extension order.
 *
 * Geometry the shell owns (not this theme): line numbers off, soft wrap on,
 * active-line wash off — forced at the prop level in CenterPane so the user's
 * source-mode preferences survive underneath.
 */
export const documentTheme: Extension = EditorView.theme({
  // The page surface lives on the SCROLLER, not .cm-content: CM draws the
  // selection in a negative-z-index layer between the scroller's background
  // and the content, so an opaque content background makes selection
  // highlighting invisible. Full-bleed paper + a centered measure gives the
  // same document feel with the selection layer intact.
  "&.cm-editor .cm-scroller": {
    fontFamily: "var(--font-doc)",
    background: "var(--color-doc-surface)",
    padding: "0",
  },
  "&.cm-editor .cm-content": {
    maxWidth: "44rem",
    margin: "0 auto",
    padding: "3rem 3rem 5rem",
    fontFamily: "var(--font-doc)",
    fontSize: "max(16px, 1.05em)",
    lineHeight: "1.75",
    color: "var(--color-fg-1)",
    caretColor: "var(--color-accent-1)",
  },
  "&.cm-editor .cm-line": {
    padding: "0",
  },
});

/**
 * Construct styling: headings, inline marks, chips/cards, list markers,
 * quote borders, comment dimming. Class names come from decorations.ts.
 */
export const constructTheme: Extension = EditorView.theme({
  // Headings — sans display type over the serif body.
  ".cm-vis-h1": {
    fontFamily: "var(--font-sans)",
    fontSize: "1.6em",
    fontWeight: "650",
    letterSpacing: "-0.015em",
  },
  ".cm-vis-h2": {
    fontFamily: "var(--font-sans)",
    fontSize: "1.3em",
    fontWeight: "620",
  },
  ".cm-vis-h3": {
    fontFamily: "var(--font-sans)",
    fontSize: "1.1em",
    fontWeight: "600",
  },
  ".cm-line.cm-vis-line-h1": { padding: "0.9em 0 0.3em" },
  ".cm-line.cm-vis-line-h2": { padding: "0.7em 0 0.25em" },
  ".cm-line.cm-vis-line-h3": { padding: "0.5em 0 0.2em" },

  // Inline marks.
  ".cm-vis-b": { fontWeight: "700" },
  ".cm-vis-i": { fontStyle: "italic" },
  ".cm-vis-u": { textDecoration: "underline" },
  ".cm-vis-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    background: "var(--color-control-fill)",
    borderRadius: "3px",
    padding: "0 3px",
  },

  // Chips — the honest stand-ins for atomic constructs.
  ".cm-vis-chip": {
    display: "inline-block",
    fontFamily: "var(--font-sans)",
    fontSize: "0.78em",
    lineHeight: "1.5",
    padding: "0 6px",
    borderRadius: "9999px",
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-control-stroke)",
    color: "var(--color-fg-2)",
    cursor: "pointer",
    userSelect: "none",
    verticalAlign: "baseline",
    whiteSpace: "nowrap",
  },
  ".cm-vis-chip:hover": { background: "var(--color-control-fill-hover)" },
  ".cm-vis-chip-selected": {
    outline: "2px solid var(--color-accent-1)",
    outlineOffset: "1px",
  },
  ".cm-vis-cmd-chip": { fontFamily: "var(--font-mono)" },
  ".cm-vis-verb-chip": { fontFamily: "var(--font-mono)" },
  ".cm-vis-math-chip": { color: "var(--syntax-math)" },
  ".cm-vis-pill": { color: "var(--color-fg-1)" },
  ".cm-vis-pill-label": { opacity: "0.6" },
  ".cm-vis-brace-chip": {
    color: "var(--color-error, #a84935)",
    borderColor: "var(--color-error, #a84935)",
  },
  ".cm-vis-break-chip": { opacity: "0.55", fontSize: "0.7em" },
  ".cm-vis-glyph": {},
  ".cm-vis-ghost": {
    display: "inline-block",
    fontFamily: "var(--font-sans)",
    fontSize: "0.8em",
    fontStyle: "italic",
    opacity: "0.4",
    padding: "0 2px",
    userSelect: "none",
  },

  // Block cards (math/table/figure/unknown env placeholders).
  ".cm-vis-card": {
    display: "block",
    margin: "0.5em 0",
    padding: "0.7em 1em",
    borderRadius: "6px",
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-glass-stroke)",
    cursor: "pointer",
    userSelect: "none",
  },
  ".cm-vis-card:hover": { background: "var(--color-control-fill-hover)" },
  ".cm-vis-card-selected": {
    outline: "2px solid var(--color-accent-1)",
    outlineOffset: "1px",
  },
  ".cm-vis-card-badge": {
    fontFamily: "var(--font-sans)",
    fontSize: "0.72em",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--color-fg-3)",
    marginRight: "0.8em",
  },
  ".cm-vis-card-preview": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    color: "var(--color-fg-2)",
  },

  // Math.
  ".cm-vis-math-inline": {
    cursor: "pointer",
    borderRadius: "3px",
    padding: "0 1px",
  },
  ".cm-vis-math-inline:hover": { background: "var(--color-control-fill)" },
  ".cm-vis-math-block": {
    display: "block",
    margin: "0.6em 0",
    padding: "0.4em 1em",
    borderRadius: "6px",
    cursor: "pointer",
    textAlign: "center",
  },
  ".cm-vis-math-block:hover": { background: "var(--color-control-fill)" },
  ".cm-vis-math-block .cm-vis-card-badge": {
    display: "block",
    textAlign: "left",
    marginBottom: "0.2em",
  },
  ".cm-vis-math-error": {
    color: "var(--color-error, #a84935)",
    borderColor: "var(--color-error, #a84935)",
  },

  // Tables + figures (read-only previews; popover edits the source).
  ".cm-vis-table": {
    display: "block",
    margin: "0.6em auto",
    cursor: "pointer",
    width: "fit-content",
    maxWidth: "100%",
    overflowX: "auto",
  },
  ".cm-vis-table table": {
    borderCollapse: "collapse",
    fontSize: "0.92em",
  },
  ".cm-vis-table th": {
    fontWeight: "650",
    borderBottom: "2px solid var(--color-glass-stroke)",
    padding: "0.25em 0.8em",
    textAlign: "left",
  },
  ".cm-vis-table td": {
    borderBottom: "1px solid var(--color-glass-stroke)",
    padding: "0.25em 0.8em",
  },
  ".cm-vis-table:hover": { background: "var(--color-control-fill)" },
  ".cm-vis-figure": {
    display: "block",
    margin: "0.6em auto",
    textAlign: "center",
    cursor: "pointer",
  },
  ".cm-vis-figure img": {
    maxWidth: "100%",
    borderRadius: "4px",
  },
  ".cm-vis-figure:hover": { background: "var(--color-control-fill)" },
  ".cm-vis-figure-placeholder": {
    display: "inline-block",
    padding: "1.2em 2em",
    borderRadius: "6px",
    border: "1px dashed var(--color-control-stroke)",
    color: "var(--color-fg-3)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.85em",
  },
  ".cm-vis-figcaption": {
    marginTop: "0.35em",
    fontFamily: "var(--font-sans)",
    fontSize: "0.85em",
    color: "var(--color-fg-3)",
    textAlign: "center",
  },

  // Preamble chip.
  ".cm-vis-preamble": {
    display: "flex",
    alignItems: "center",
    gap: "0.5em",
    margin: "0 0 1em",
    padding: "0.45em 0.9em",
    borderRadius: "6px",
    background: "var(--color-control-fill)",
    border: "1px dashed var(--color-control-stroke)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.82em",
    color: "var(--color-fg-3)",
    cursor: "pointer",
    userSelect: "none",
  },
  ".cm-vis-preamble:hover": { background: "var(--color-control-fill-hover)" },

  // List markers + hanging indents.
  ".cm-vis-marker": {
    display: "inline-block",
    minWidth: "1.4em",
    color: "var(--color-fg-2)",
    userSelect: "none",
  },
  ".cm-line.cm-vis-line-item-d1": { paddingLeft: "1.5em" },
  ".cm-line.cm-vis-line-item-d2": { paddingLeft: "3em" },
  ".cm-line.cm-vis-line-item-d3": { paddingLeft: "4.5em" },
  ".cm-line.cm-vis-line-item-d4": { paddingLeft: "6em" },

  // Quote / centered / verbatim / comment / raw lines.
  ".cm-line.cm-vis-line-quote": {
    borderLeft: "3px solid var(--color-glass-stroke)",
    paddingLeft: "1em",
    color: "var(--color-fg-2)",
  },
  ".cm-line.cm-vis-line-center": { textAlign: "center" },
  ".cm-line.cm-vis-line-verbatim": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.86em",
    background: "var(--color-control-fill)",
  },
  ".cm-vis-comment": {
    opacity: "0.5",
    fontStyle: "italic",
  },
  ".cm-line.cm-vis-line-comment": { opacity: "0.6" },
  ".cm-line.cm-vis-line-raw": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.86em",
    background: "var(--color-glass-inset-bg, var(--color-control-fill))",
  },
});
