import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentUnit,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { markdown } from "@codemirror/lang-markdown";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Component } from "solid-js";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { typst } from "~/adapters/typst/typst-language";
import type { EditorLanguage } from "~/adapters/languages";
import { getActiveEditorView, pushCursor, setActiveEditorView } from "~/stores/editor-view-store";

// The editor's per-file language is owned by adapters/languages; the CM
// component maps each value to a CodeMirror language extension (langExtension).
export type CodeMirrorLanguage = EditorLanguage;

interface CodeMirrorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeMirrorLanguage;
  fontSize?: number;
  /** Content line-height (a unitless multiplier string, e.g. "1.65"). */
  lineHeight?: string;
  lineWrap?: boolean;
  lineNumbers?: boolean;
  highlightActiveLine?: boolean;
  /** Base (non-LSP) autocompletion. Suppressed when `lspActive`. */
  autocomplete?: boolean;
  bracketMatching?: boolean;
  autoCloseBrackets?: boolean;
  /** Indent width in spaces (also the Tab display width). */
  tabSize?: number;
  /** Modal Vim bindings via @replit/codemirror-vim. */
  vimMode?: boolean;
  /**
   * Visual editing mode (LaTeX): a decoration layer that renders common
   * constructs over the real source. Edits always hit the source; the layer
   * never dispatches document changes.
   */
  visualMode?: boolean;
  /**
   * Raised when the visual layer's scan budget aborts — the host marks the
   * file visual-paused for the session and flips `visualMode` off.
   */
  onVisualPause?: () => void;
  /**
   * True when an LSP session supplies its own `autocompletion({ override })`
   * via `extraExtensions`. The base `autocompletion()` is then suppressed so
   * the two configs don't both surface completions for the same buffer.
   */
  lspActive?: boolean;
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
    // em, not px — tracks the user-configured editor font size.
    fontSize: "0.85em",
  },
  // The library's `&light` base theme paints tooltips/panels stock
  // white-on-light regardless of the app theme; token-driven rules here win
  // over package base themes and re-skin with the rest of the chrome.
  ".cm-tooltip": {
    background: "var(--color-popover-bg)",
    border: "1px solid var(--color-glass-stroke)",
    color: "var(--color-fg-1)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--color-selection-bg)",
    color: "var(--color-fg-1)",
  },
  ".cm-panels": {
    background: "var(--color-popover-bg)",
    color: "var(--color-fg-1)",
  },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-glass-stroke)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-glass-stroke)" },
  ".cm-textfield": {
    background: "var(--color-control-fill)",
    border: "1px solid var(--color-control-stroke)",
    color: "var(--color-fg-1)",
  },
  ".cm-button": {
    background: "var(--color-control-fill)",
    backgroundImage: "none",
    border: "1px solid var(--color-control-stroke)",
    color: "var(--color-fg-1)",
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
  // Last string we emitted via onChange. Lets the value-sync effect skip a
  // full doc.toString() when props.value is just our own echo coming back.
  let lastEmitted: string | null = null;

  const langCompartment = new Compartment();
  const lineWrapCompartment = new Compartment();
  const visualCompartment = new Compartment();
  const metricsCompartment = new Compartment();
  const vimCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();
  const activeLineCompartment = new Compartment();
  const completionCompartment = new Compartment();
  const bracketMatchCompartment = new Compartment();
  const closeBracketsCompartment = new Compartment();
  const indentCompartment = new Compartment();

  // Vim is dynamically imported so the engine stays out of the editor's
  // critical chunk for the default (vim-off) config; it loads only when the
  // user turns vim on.
  let vimFactory: (() => Extension) | null = null;
  const applyVim = async (on: boolean) => {
    if (!on) {
      view?.dispatch({ effects: vimCompartment.reconfigure([]) });
      return;
    }
    if (!vimFactory) {
      vimFactory = (await import("@replit/codemirror-vim")).vim;
    }
    // A toggle-off may have landed while the chunk was loading.
    if (!(props.vimMode ?? false)) return;
    view?.dispatch({ effects: vimCompartment.reconfigure(vimFactory()) });
  };

  // Visual mode follows the vim pattern: dynamic-imported on first enable so
  // the scanner + decoration layer stay off the boot path, swapped through a
  // compartment so toggling preserves undo history, cursor, scroll, and the
  // LSP didOpen session (an editorKey remount would throw all four away).
  let visualFactory:
    | ((cfg: { onPause?: () => void }) => Extension)
    | null = null;
  const applyVisual = async (on: boolean) => {
    if (!on) {
      view?.dispatch({ effects: visualCompartment.reconfigure([]) });
      return;
    }
    if (!visualFactory) {
      visualFactory = (await import("~/lib/visual/cm6")).visualExtension;
    }
    // A toggle-off may have landed while the chunk was loading.
    if (!(props.visualMode ?? false)) return;
    view?.dispatch({
      effects: visualCompartment.reconfigure(
        visualFactory({ onPause: () => props.onVisualPause?.() }),
      ),
    });
  };

  const langExtension = (lang: CodeMirrorProps["language"]) => {
    if (lang === "markdown") return markdown();
    if (lang === "typst") return typst();
    if (lang === "plain") return [];
    return StreamLanguage.define(stex);
  };

  const lineWrapExtension = (wrap: boolean) =>
    wrap ? EditorView.lineWrapping : [];

  const metricsExtension = (size: number, lineHeight: string): Extension =>
    EditorView.theme({
      "&": { fontSize: `${size}px` },
      ".cm-content": { lineHeight },
    });

  // Base completion is suppressed when an LSP session supplies its own override.
  const completionExtension = (lspActive: boolean, on: boolean): Extension =>
    lspActive || !on ? [] : autocompletion();

  const indentExtension = (size: number): Extension => [
    EditorState.tabSize.of(size),
    indentUnit.of(" ".repeat(size)),
  ];

  const toggle = (on: boolean, ext: () => Extension): Extension =>
    on ? ext() : [];

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        // Vim must precede the other keymaps so its handlers win in
        // normal/visual mode. Loaded on demand once vim is enabled.
        vimCompartment.of([]),
        lineNumbersCompartment.of(toggle(props.lineNumbers ?? true, lineNumbers)),
        history(),
        drawSelection(),
        activeLineCompartment.of(
          toggle(props.highlightActiveLine ?? true, highlightActiveLine),
        ),
        indentCompartment.of(indentExtension(props.tabSize ?? 2)),
        bracketMatchCompartment.of(
          toggle(props.bracketMatching ?? true, bracketMatching),
        ),
        closeBracketsCompartment.of(
          (props.autoCloseBrackets ?? true)
            ? [closeBrackets(), keymap.of(closeBracketsKeymap)]
            : [],
        ),
        // Suppress the base completion when an LSP session injects its own
        // `autocompletion({ override })` via extraExtensions — otherwise both
        // configs merge and the default source surfaces alongside LSP results.
        completionCompartment.of(
          completionExtension(props.lspActive ?? false, props.autocomplete ?? true),
        ),
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
        visualCompartment.of([]),
        metricsCompartment.of(
          metricsExtension(props.fontSize ?? 13, props.lineHeight ?? "1.65"),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const text = update.state.doc.toString();
            lastEmitted = text;
            props.onChange(text);
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
        // Our own change echoing back through the store — nothing to apply,
        // and skipping the doc.toString() avoids a per-keystroke allocation.
        if (next === lastEmitted) return;
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
    void applyVim(props.vimMode ?? false);
  });

  createEffect(() => {
    void applyVisual(props.visualMode ?? false);
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: metricsCompartment.reconfigure(
        metricsExtension(props.fontSize ?? 13, props.lineHeight ?? "1.65"),
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: lineNumbersCompartment.reconfigure(
        toggle(props.lineNumbers ?? true, lineNumbers),
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: activeLineCompartment.reconfigure(
        toggle(props.highlightActiveLine ?? true, highlightActiveLine),
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: completionCompartment.reconfigure(
        completionExtension(props.lspActive ?? false, props.autocomplete ?? true),
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: bracketMatchCompartment.reconfigure(
        toggle(props.bracketMatching ?? true, bracketMatching),
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: closeBracketsCompartment.reconfigure(
        (props.autoCloseBrackets ?? true)
          ? [closeBrackets(), keymap.of(closeBracketsKeymap)]
          : [],
      ),
    });
  });

  createEffect(() => {
    if (!view) return;
    view.dispatch({
      effects: indentCompartment.reconfigure(indentExtension(props.tabSize ?? 2)),
    });
  });

  return <div ref={parent!} class="h-full w-full overflow-hidden scroll" />;
};
