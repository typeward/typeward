import { autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { python } from "@codemirror/legacy-modes/mode/python";
import { r } from "@codemirror/legacy-modes/mode/r";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { markdown } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Component } from "solid-js";
import { createEffect, on, onCleanup, onMount } from "solid-js";

/**
 * Slimmer CodeMirror surface for notebook cells. Differences from the
 * full-file `<CodeMirror>` component:
 *   - No line numbers (cells are typically short)
 *   - No save/compile keymap entries (those go through the global router)
 *   - No push to editor-view-store (cells aren't the singleton "active
 *     editor view" the SyncTeX cursor-line queries assume)
 *   - Language is a free-form string ("r", "python", "yaml", ...) mapped
 *     here to a StreamLanguage / lang-markdown extension
 *
 * Focus is reported via `onFocus` so notebook-shell can highlight the
 * active cell.
 */

interface CellEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** "markdown" | "yaml" | "r" | "python" | "julia" | "sql" | "shell" | ... */
  language: string;
  fontSize?: number;
  onFocus?: () => void;
}

const cellHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "#C4B5FD" },
  { tag: t.tagName, color: "#34D399" },
  { tag: t.string, color: "#67E8F9" },
  { tag: t.comment, color: "#5F6878", fontStyle: "italic" },
  { tag: t.number, color: "#FBBF24" },
  { tag: t.atom, color: "#67E8F9" },
  { tag: t.attributeName, color: "#A7F3D0" },
  { tag: t.literal, color: "var(--color-fg-1)" },
]);

const cellTheme = EditorView.theme({
  "&": {
    fontSize: "13px",
    background: "transparent",
    color: "var(--color-fg-1)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "8px 10px",
    caretColor: "var(--color-accent-1)",
    lineHeight: "1.55",
    minHeight: "1.55em",
  },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { background: "var(--color-control-fill)" },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent-1)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "rgba(139, 92, 246, 0.18)",
  },
  ".cm-scroller": {
    overflow: "auto",
    scrollbarColor: "var(--color-control-fill-hover) transparent",
    scrollbarWidth: "thin",
  },
  ".cm-scroller::-webkit-scrollbar": { width: "10px", height: "10px" },
  ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    background: "var(--color-control-fill)",
    borderRadius: "8px",
    border: "2px solid transparent",
    backgroundClip: "padding-box",
  },
  ".cm-scroller::-webkit-scrollbar-thumb:hover": {
    background: "var(--color-control-fill-hover)",
  },
  ".cm-scroller::-webkit-scrollbar-corner": { background: "transparent" },
});

const langExtension = (language: string): Extension => {
  switch (language.toLowerCase()) {
    case "markdown":
    case "md":
      return markdown();
    case "yaml":
    case "yml":
      return StreamLanguage.define(yaml);
    case "r":
      return StreamLanguage.define(r);
    case "python":
    case "py":
      return StreamLanguage.define(python);
    case "julia":
    case "jl":
      return StreamLanguage.define(julia);
    case "sql":
      return StreamLanguage.define(standardSQL);
    case "bash":
    case "sh":
    case "shell":
      return StreamLanguage.define(shell);
    default:
      return [];
  }
};

export const CellEditor: Component<CellEditorProps> = (props) => {
  let parent!: HTMLDivElement;
  let view: EditorView | undefined;
  const langCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();

  const fontSizeExtension = (size: number) =>
    EditorView.theme({ "&": { fontSize: `${size}px` } });

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        history(),
        drawSelection(),
        autocompletion(),
        search(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        cellTheme,
        syntaxHighlighting(cellHighlight),
        langCompartment.of(langExtension(props.language)),
        fontSizeCompartment.of(fontSizeExtension(props.fontSize ?? 13)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
          }
          if (update.focusChanged && update.view.hasFocus) {
            props.onFocus?.();
          }
        }),
      ],
    });

    view = new EditorView({ state, parent });
    onCleanup(() => view?.destroy());
  });

  // External content sync (parser re-parses → cells re-derive). Use the
  // current view's content as the truth check so user typing doesn't get
  // clobbered by a stale `props.value`.
  createEffect(
    on(
      () => props.value,
      (next) => {
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === next) return;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: next },
        });
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: langCompartment.reconfigure(langExtension(props.language)),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: fontSizeCompartment.reconfigure(
        fontSizeExtension(props.fontSize ?? 13),
      ),
    });
  });

  return <div ref={parent!} class="w-full" />;
};
