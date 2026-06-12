import { autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { markdown } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { tags as t } from "@lezer/highlight";
import type { Component } from "solid-js";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { typst } from "~/adapters/typst/typst-language";
import { getActiveEditorView, pushCursor, setActiveEditorView } from "~/stores/editor-view-store";

export type CodeMirrorLanguage = "latex" | "markdown" | "typst" | "plain";

interface CodeMirrorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeMirrorLanguage;
  fontSize?: number;
  lineWrap?: boolean;
  /** Modal Vim bindings via @replit/codemirror-vim. */
  vimMode?: boolean;
  /** Optional callback that receives the EditorView once mounted. */
  onReady?: (view: EditorView) => void;
  /**
   * Additional extensions appended at mount time — e.g. an LSP integration
   * bound to the current document URI. Re-mount the component (key on file
   * path) to swap these out when switching files.
   */
  extraExtensions?: Extension[];
}

/**
 * Theme tokens are pulled from CSS custom properties so every CodeMirror
 * surface re-skins instantly when the user flips themes/accents. Token color
 * classes (.cm-cmd, .cm-math, ...) follow the design's `.tk-*` vocabulary.
 */
const baseTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    background: "transparent",
    color: "var(--color-fg-1)",
  },
  ".cm-content": {
    fontFamily: "var(--font-mono)",
    padding: "12px 0",
    caretColor: "var(--color-accent-1)",
    lineHeight: "1.65",
  },
  ".cm-gutters": {
    background: "transparent",
    border: "none",
    color: "var(--color-fg-4)",
  },
  ".cm-activeLine": { background: "var(--color-control-fill)" },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--color-fg-2)" },
  ".cm-cursor": {
    borderLeftColor: "var(--color-accent-1)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "var(--color-text-selection)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 14px 0 10px",
    minWidth: "32px",
    fontSize: "11px",
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

const latexHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syntax-cmd)" }, // \commands
  { tag: t.tagName, color: "var(--syntax-env)" }, // \begin{env}
  { tag: t.bracket, color: "var(--syntax-bracket)" },
  { tag: t.string, color: "var(--syntax-math)" }, // math
  { tag: t.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: t.atom, color: "var(--syntax-math)" }, // math operators
  { tag: t.attributeName, color: "var(--syntax-attr)" },
  { tag: t.literal, color: "var(--color-fg-1)" },
]);

export const CodeMirror: Component<CodeMirrorProps> = (props) => {
  let parent!: HTMLDivElement;
  let view: EditorView | undefined;

  const langCompartment = new Compartment();
  const lineWrapCompartment = new Compartment();
  const fontSizeCompartment = new Compartment();
  const vimCompartment = new Compartment();

  const vimExtension = (on: boolean) => (on ? vim() : []);

  const langExtension = (lang: CodeMirrorProps["language"]) => {
    if (lang === "markdown") return markdown();
    if (lang === "typst") return typst();
    if (lang === "plain") return [];
    return StreamLanguage.define(stex);
  };

  const lineWrapExtension = (wrap: boolean) =>
    wrap ? EditorView.lineWrapping : [];

  const fontSizeExtension = (size: number) =>
    EditorView.theme({ "&": { fontSize: `${size}px` } });

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        // Vim must precede the other keymaps so its handlers win in
        // normal/visual mode.
        vimCompartment.of(vimExtension(props.vimMode ?? false)),
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        autocompletion(),
        search(),
        // Mod+S and Mod+Enter intentionally aren't bound here — they go
        // through the global keyboard router (src/commands/keyboard.ts)
        // which reads the CommandRegistry, so the registry's `when()`
        // predicate stays authoritative. defaultKeymap ships its own
        // Mod-Enter (insertBlankLine); left in place it fires *alongside*
        // the router's compile dispatch and a stray blank line gets saved
        // to disk on every keyboard-triggered compile.
        keymap.of([
          ...defaultKeymap.filter((b) => b.key !== "Mod-Enter"),
          ...historyKeymap,
          ...searchKeymap,
        ]),
        baseTheme,
        syntaxHighlighting(latexHighlight),
        langCompartment.of(langExtension(props.language ?? "latex")),
        lineWrapCompartment.of(lineWrapExtension(props.lineWrap ?? true)),
        fontSizeCompartment.of(fontSizeExtension(props.fontSize ?? 13)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) {
            const pos = update.state.selection.main.head;
            const lineInfo = update.state.doc.lineAt(pos);
            pushCursor(lineInfo.number, pos - lineInfo.from + 1);
          }
        }),
        ...(props.extraExtensions ?? []),
      ],
    });

    view = new EditorView({ state, parent });
    setActiveEditorView(view);
    props.onReady?.(view);

    onCleanup(() => {
      // Only clear the global handle if it still points at this instance —
      // guards against unmount-after-remount sequences where a newer
      // instance has already taken over before this cleanup runs.
      const mine = view;
      if (mine) {
        if (getActiveEditorView() === mine) setActiveEditorView(null);
        mine.destroy();
      }
    });
  });

  // Sync external value into the editor when it changes (e.g. when switching files).
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
      effects: langCompartment.reconfigure(langExtension(props.language ?? "latex")),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: lineWrapCompartment.reconfigure(
        lineWrapExtension(props.lineWrap ?? true),
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: vimCompartment.reconfigure(vimExtension(props.vimMode ?? false)),
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

  return <div ref={parent!} class="h-full w-full overflow-hidden scroll" />;
};
