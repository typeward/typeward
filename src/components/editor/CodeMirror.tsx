import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
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
  /** Source-pane keybinding engine: standard bindings, @replit/codemirror-vim,
   *  or @replit/codemirror-emacs. */
  keybindings?: "none" | "vim" | "emacs";
  /**
   * Visual editing mode (LaTeX): a hidden-source WYSIWYG layer — StateField
   * decorations + atomic ranges over the real source. Markup never renders
   * inline; edits always hit the source text through normal transactions.
   * While visual is on, vim/emacs are force-suspended (modal/chorded bindings
   * and atomic widget navigation are incoherent together); the keybindings
   * setting itself is untouched and restores when visual turns off.
   */
  visualMode?: boolean;
  /**
   * Raised when the visual layer's parse budget aborts — the host marks the
   * file visual-paused for the session and flips `visualMode` off.
   */
  onVisualPause?: () => void;
  /**
   * Raised when a visual-mode widget is activated (click, `$`) — the host
   * opens the LaTeX edit popover for the construct span.
   */
  onVisualPopover?: (intent: { from: number; to: number; kind: string }) => void;
  /** Resolve a project-relative asset path for visual-mode figure previews. */
  visualResolveAsset?: (relPath: string) => string | null;
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
  /**
   * Stable identity for the buffer this editor shows (the file path). The
   * editor remounts on tab switch and again when the LSP session attaches;
   * this key lets it stash and restore undo history, cursor, and scroll
   * across those remounts, so switching away and back does not throw away
   * undo. Restoration only applies when the stashed document still matches
   * `value` (an out-of-editor content replace mounts fresh). Omit to opt out.
   */
  stashKey?: string;
  /**
   * Whether this view is the visible/active one. The editor pool keeps several
   * views mounted at once (display-toggled) so switching tabs never rebuilds
   * the height-map; only the active view owns the shared editor handle
   * (editor-view-store) and feeds the global cursor signals. Defaults to true
   * for a stand-alone mount. When it flips true (a pooled view is revealed) the
   * view claims the handle and re-pushes its cursor.
   */
  active?: boolean;
}

/**
 * Serialized editor state (doc + selection + history) plus scroll offset, kept
 * per file across the editor's remounts, bounded LRU. `doc` is retained
 * separately so restoration can verify the buffer hasn't diverged before
 * replaying stale history. Scroll is DOM state, not part of EditorState, so it
 * rides alongside and is re-applied after the first layout pass.
 */
interface StashEntry {
  json: unknown;
  doc: string;
  scrollTop: number;
}
const STASH_LIMIT = 12;
const stateStash = new Map<string, StashEntry>();
function stashPut(key: string, entry: StashEntry): void {
  stateStash.delete(key);
  stateStash.set(key, entry);
  while (stateStash.size > STASH_LIMIT) {
    const oldest = stateStash.keys().next().value;
    if (oldest === undefined) break;
    stateStash.delete(oldest);
  }
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
  // The focused arm mirrors the package base theme's selector shape on
  // purpose: @codemirror/view styles the focused selection with
  // "&light.cm-focused > .cm-scroller > .cm-selectionLayer
  // .cm-selectionBackground" (five classes), so any shorter selector loses
  // the cascade only while focused and the stock lavender shows instead of
  // the theme token. Matching the shape ties specificity; extension themes
  // mount after the base theme, so the tie breaks our way in both states.
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
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
  // True while a programmatic value-sync dispatch applies store content, so the
  // updateListener doesn't echo it back as a user edit (marking the file dirty)
  // nor push it as a cursor move — critical once background pooled views take
  // external edits.
  let applyingExternal = false;
  // Whether this view currently owns the shared active-view handle. Only the
  // active pooled view feeds the global cursor signals and answers
  // getActiveEditorView(); a background view stays silent.
  let selfActive = false;

  // Take ownership of the shared active-view handle and refresh the cursor
  // signals for the now-visible file. A display-toggle reveal fires no
  // selection event, so without this the status bar keeps the previous file's
  // Ln/Col until the caret moves.
  const claimActiveView = () => {
    if (!view) return;
    selfActive = true;
    setActiveEditorView(view);
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    pushCursor(line.number, head - line.from + 1);
  };

  const langCompartment = new Compartment();
  const lineWrapCompartment = new Compartment();
  const visualCompartment = new Compartment();
  const metricsCompartment = new Compartment();
  const keybindingsCompartment = new Compartment();
  const lineNumbersCompartment = new Compartment();
  const activeLineCompartment = new Compartment();
  const completionCompartment = new Compartment();
  const bracketMatchCompartment = new Compartment();
  const closeBracketsCompartment = new Compartment();
  const indentCompartment = new Compartment();

  // The binding engines are dynamically imported so they stay out of the
  // editor's critical chunk for the default ("none") config; each loads only
  // when the user first selects it.
  const bindingFactories: Partial<Record<"vim" | "emacs", () => Extension>> = {};
  const keybindingsWanted = (): "none" | "vim" | "emacs" =>
    (props.visualMode ?? false) ? "none" : (props.keybindings ?? "none");
  // Generation counter: a setting change while a chunk is still loading must
  // win over the stale import resolving after it.
  let keybindingsGen = 0;
  const applyKeybindings = async () => {
    const gen = ++keybindingsGen;
    const want = keybindingsWanted();
    if (want === "none") {
      view?.dispatch({ effects: keybindingsCompartment.reconfigure([]) });
      return;
    }
    if (!bindingFactories[want]) {
      bindingFactories[want] =
        want === "vim"
          ? (await import("@replit/codemirror-vim")).vim
          : (await import("@replit/codemirror-emacs")).emacs;
    }
    if (gen !== keybindingsGen) return;
    view?.dispatch({
      effects: keybindingsCompartment.reconfigure(bindingFactories[want]!()),
    });
  };

  // Visual mode follows the vim pattern: dynamic-imported on first enable so
  // the parser + decoration layer stay off the boot path, swapped through a
  // compartment so toggling preserves undo history, cursor, scroll, and the
  // LSP didOpen session (an editorKey remount would throw all four away).
  let visualFactory:
    | ((cfg: {
        onPause?: () => void;
        onOpenPopover?: (intent: { from: number; to: number; kind: string }) => void;
        resolveAsset?: (relPath: string) => string | null;
      }) => Extension)
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
        visualFactory({
          onPause: () => props.onVisualPause?.(),
          onOpenPopover: (intent) => props.onVisualPopover?.(intent),
          resolveAsset: (relPath) => props.visualResolveAsset?.(relPath) ?? null,
        }),
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
    const extensions: Extension[] = [
        // Vim/emacs must precede the other keymaps so their handlers win.
        // Loaded on demand once an engine is selected.
        keybindingsCompartment.of([]),
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
        // to disk on every keyboard-triggered compile. The same collision
        // exists for the format shortcuts: defaultKeymap's Mod-i
        // (selectParentSyntax) doubles format.italic and historyKeymap's
        // Mod-u (undoSelection) doubles format.underline, so both are
        // filtered too (Mod-b is unbound in CM6, nothing to drop there).
        // Any new keymap source must not reintroduce Mod-Enter, Mod-i,
        // or Mod-u bindings.
        keymap.of([
          ...defaultKeymap.filter(
            (b) => b.key !== "Mod-Enter" && b.key !== "Mod-i",
          ),
          ...historyKeymap.filter((b) => b.key !== "Mod-u"),
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
          if (update.docChanged && !applyingExternal) {
            const text = update.state.doc.toString();
            lastEmitted = text;
            props.onChange(text);
          }
          // Only the active view drives the shared cursor signals — a background
          // pooled view applying an external edit must not clobber the status
          // bar with a non-visible file's position.
          if (
            (update.selectionSet || update.docChanged) &&
            selfActive &&
            !applyingExternal
          ) {
            const pos = update.state.selection.main.head;
            const lineInfo = update.state.doc.lineAt(pos);
            pushCursor(lineInfo.number, pos - lineInfo.from + 1);
          }
        }),
        ...(props.extraExtensions ?? []),
    ];

    // Restore undo/selection from the last time this file was mounted, but
    // only when the buffer hasn't diverged since (an out-of-editor content
    // replace or a stale stash falls through to a fresh state on `value`).
    const stashed = props.stashKey ? stateStash.get(props.stashKey) : undefined;
    const restoring = !!stashed && stashed.doc === props.value;
    const state = restoring
      ? EditorState.fromJSON(stashed.json, { extensions }, { history: historyField })
      : EditorState.create({ doc: props.value, extensions });

    view = new EditorView({ state, parent });
    // Claim the active handle only when this view is the visible one; a pooled
    // view pre-warmed in the background must not steal it from the active view.
    if (props.active ?? true) claimActiveView();
    if (restoring && stashed) {
      // Scroll is DOM state — re-apply after CM6's first layout pass, or the
      // initial measure clobbers it back to the top.
      const top = stashed.scrollTop;
      view.requestMeasure({
        read: () => null,
        write: () => {
          if (view) view.scrollDOM.scrollTop = top;
        },
      });
    }
    props.onReady?.(view);

    onCleanup(() => {
      // Only clear the global handle if it still points at this instance —
      // guards against unmount-after-remount sequences where a newer
      // instance has already taken over before this cleanup runs.
      const mine = view;
      if (mine) {
        // Stash undo + selection + scroll so a tab switch away and back (or an
        // LSP-attach remount) preserves them. Runs before destroy, while the
        // view and its scroll DOM are still live.
        if (props.stashKey) {
          stashPut(props.stashKey, {
            json: mine.state.toJSON({ history: historyField }),
            doc: mine.state.doc.toString(),
            scrollTop: mine.scrollDOM.scrollTop,
          });
        }
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
        // Store-driven content replace, not a user edit: flag it so the update
        // listener doesn't echo it back as a dirty-marking change.
        applyingExternal = true;
        try {
          view.dispatch({
            changes: { from: 0, to: current.length, insert: next },
          });
        } finally {
          applyingExternal = false;
        }
      },
      { defer: true },
    ),
  );

  // Claim the active handle when the pool reveals this view (display toggled
  // on). Losing active is a no-op — the newly-revealed view claims it.
  createEffect(
    on(
      () => props.active ?? true,
      (active) => {
        if (active) claimActiveView();
        else selfActive = false;
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
    // Read synchronously so the effect tracks keybindings + visualMode.
    keybindingsWanted();
    void applyKeybindings();
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
