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
import type { Extension } from "@codemirror/state";

import { closureDeletion } from "./edit-guards";

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
      const pieces = closureDeletion(state, sel.from, sel.to);
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
