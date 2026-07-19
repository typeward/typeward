/**
 * Visible-image search for visual mode. The stock @codemirror/search panel
 * matches hidden markup (invisible highlights, selection skip-loops), so
 * visual mode rebinds Mod-F to this panel: matches are computed over the
 * VISIBLE IMAGE (image.ts) — what the user reads is what search searches.
 * Case-insensitive literal matching; hidden-region hits are simply not
 * matches (they don't exist in the image).
 */

import { showPanel, type Panel } from "@codemirror/view";
import { EditorView, keymap } from "@codemirror/view";
import {
  StateEffect,
  StateField,
  Prec,
  type Extension,
} from "@codemirror/state";

import { buildImageWindow } from "./image";
import { visualField } from "./field";

const toggleSearch = StateEffect.define<boolean>();

const searchOpen = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleSearch)) value = e.value;
    return value;
  },
  provide: (f) => showPanel.from(f, (open) => (open ? buildPanel : null)),
});

interface Match {
  from: number;
  to: number;
}

function findMatches(view: EditorView, query: string): Match[] {
  if (query === "") return [];
  const st = view.state.field(visualField, false);
  if (!st || st.doc === null) return [];
  const docText = view.state.doc.toString();
  const win = buildImageWindow(st.doc, docText, 0, docText.length);
  const haystack = win.text.toLowerCase();
  const needle = query.toLowerCase();
  const out: Match[] = [];
  let at = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, at);
    if (idx === -1 || out.length >= 999) break;
    out.push({ from: win.toDoc(idx), to: win.toDoc(idx + needle.length) });
    at = idx + Math.max(1, needle.length);
  }
  return out;
}

function buildPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-vis-search";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Find in document…";
  input.className = "cm-vis-search-input";
  input.setAttribute("main-field", "true");

  const count = document.createElement("span");
  count.className = "cm-vis-search-count";

  const mkButton = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.className = "cm-vis-search-btn";
    b.onclick = onClick;
    return b;
  };

  let matches: Match[] = [];
  let index = -1;

  const refresh = (moveTo: "first" | "keep" = "keep"): void => {
    matches = findMatches(view, input.value);
    if (matches.length === 0) {
      index = -1;
      count.textContent = input.value === "" ? "" : "0 results";
      return;
    }
    if (moveTo === "first" || index >= matches.length) {
      // Start from the match at/after the current cursor.
      const head = view.state.selection.main.head;
      index = matches.findIndex((m) => m.from >= head);
      if (index === -1) index = 0;
    }
    count.textContent = `${index + 1} of ${matches.length}`;
    const m = matches[index];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
      userEvent: "select.search",
    });
  };

  const step = (dir: 1 | -1): void => {
    if (matches.length === 0) return refresh("first");
    index = (index + dir + matches.length) % matches.length;
    count.textContent = `${index + 1} of ${matches.length}`;
    const m = matches[index];
    view.dispatch({
      selection: { anchor: m.from, head: m.to },
      scrollIntoView: true,
      userEvent: "select.search",
    });
  };

  input.oninput = () => refresh("first");
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) step(-1);
      else if (matches.length > 0 && index >= 0) step(1);
      else refresh("first");
    } else if (e.key === "Escape") {
      e.preventDefault();
      view.dispatch({ effects: toggleSearch.of(false) });
      view.focus();
    }
  };

  dom.append(
    input,
    count,
    mkButton("↑", "Previous (Shift+Enter)", () => step(-1)),
    mkButton("↓", "Next (Enter)", () => step(1)),
    mkButton("✕", "Close (Escape)", () => {
      view.dispatch({ effects: toggleSearch.of(false) });
      view.focus();
    }),
  );

  return {
    dom,
    top: true,
    mount: () => input.focus(),
  };
}

const searchTheme = EditorView.theme({
  ".cm-vis-search": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
  },
  ".cm-vis-search-input": {
    flex: "1",
    maxWidth: "20rem",
    fontSize: "12px",
    fontFamily: "var(--font-sans)",
    padding: "3px 8px",
    borderRadius: "5px",
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-control-stroke)",
    color: "var(--color-fg-1)",
    outline: "none",
  },
  ".cm-vis-search-input:focus": { borderColor: "var(--color-accent-1)" },
  ".cm-vis-search-count": {
    fontSize: "11px",
    color: "var(--color-fg-3)",
    minWidth: "5.5em",
  },
  ".cm-vis-search-btn": {
    fontSize: "12px",
    padding: "2px 7px",
    borderRadius: "4px",
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-control-stroke)",
    color: "var(--color-fg-2)",
    cursor: "pointer",
  },
  ".cm-vis-search-btn:hover": { background: "var(--color-control-fill-hover)" },
});

export function visualSearch(): Extension {
  return [
    searchOpen,
    searchTheme,
    // Outrank the stock search()'s Mod-f binding from the base setup.
    Prec.highest(
      keymap.of([
        {
          key: "Mod-f",
          run: (view) => {
            view.dispatch({ effects: toggleSearch.of(true) });
            return true;
          },
        },
      ]),
    ),
  ];
}
