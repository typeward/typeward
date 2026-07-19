/**
 * Clipboard filters for visual mode.
 *
 * Copy/cut: the plain-text flavor is construct-closed LaTeX — exactly the
 * ranges a closure-rewritten deletion would remove, so what leaves the app
 * is always brace-balanced (never a bare `}` from a selection that crossed
 * a wrapper). Pasting back into source mode round-trips.
 *
 * Paste: text that smells like LaTeX inserts verbatim (the parser
 * widgetizes whatever it recognizes; the rest chips — honest either way);
 * plain prose gets its TeX specials escaped so pasted text can never
 * unbalance the document.
 */

import { EditorView } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";

import { visualField } from "./field";

/** The construct-closed sub-ranges of [from, to) (mirrors the edit guard). */
function closedPieces(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number }[] {
  const st = state.field(visualField, false);
  if (!st || st.doc === null) return [{ from, to }];
  const keep: { from: number; to: number }[] = [];
  st.built.atomics.between(from, to, (aFrom, aTo, value) => {
    if (aFrom >= to || aTo <= from) return;
    if (!(value.cFrom >= from && value.cTo <= to)) {
      keep.push({ from: Math.max(aFrom, from), to: Math.min(aTo, to) });
    }
  });
  if (keep.length === 0) return [{ from, to }];
  keep.sort((a, b) => a.from - b.from);
  const out: { from: number; to: number }[] = [];
  let cursor = from;
  for (const k of keep) {
    if (k.from > cursor) out.push({ from: cursor, to: k.from });
    cursor = Math.max(cursor, k.to);
  }
  if (cursor < to) out.push({ from: cursor, to });
  return out;
}

const LATEXY = /\\[a-zA-Z@]|\\\[|\$[^$]/;

const PASTE_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  $: "\\$",
};

export function visualClipboard(): Extension {
  return [
    EditorView.clipboardOutputFilter.of((text, state) => {
      const sel = state.selection.main;
      if (sel.empty) return text;
      const pieces = closedPieces(state, sel.from, sel.to);
      if (pieces.length === 1 && pieces[0].from === sel.from && pieces[0].to === sel.to) {
        return text;
      }
      return pieces
        .map((p) => state.doc.sliceString(p.from, p.to))
        .join("");
    }),
    EditorView.clipboardInputFilter.of((text) => {
      if (LATEXY.test(text)) return text;
      return text.replace(/[\\{}%&#_$]/g, (ch) => PASTE_ESCAPES[ch] ?? ch);
    }),
  ];
}
