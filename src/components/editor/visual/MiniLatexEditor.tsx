import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import type { Component } from "solid-js";
import { onCleanup, onMount } from "solid-js";

/**
 * The popover's tiny LaTeX field: its own EditorView with its own history —
 * fully detached from the document editor (the popover is the ONE place
 * markup is meant to be visible).
 */
export const MiniLatexEditor: Component<{
  initial: string;
  /** Fires on every change (drives the live KaTeX preview). */
  onChange?: (value: string) => void;
  /** Mod+Enter inside the field commits. */
  onSubmit?: () => void;
  onReady?: (view: EditorView) => void;
}> = (props) => {
  let parent!: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: props.initial,
        extensions: [
          history(),
          drawSelection(),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                props.onSubmit?.();
                return true;
              },
            },
            ...defaultKeymap.filter((b) => b.key !== "Mod-Enter"),
            ...historyKeymap,
          ]),
          StreamLanguage.define(stex),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": {
              fontSize: "13px",
              background: "var(--color-control-fill)",
              borderRadius: "6px",
              border: "1px solid var(--color-control-stroke)",
            },
            "&.cm-focused": { outline: "none", borderColor: "var(--color-accent-1)" },
            ".cm-content": {
              fontFamily: "var(--font-mono)",
              padding: "8px 10px",
              caretColor: "var(--color-accent-1)",
              minHeight: "2.2em",
              maxHeight: "14em",
            },
            ".cm-scroller": { overflow: "auto", maxHeight: "14em" },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) props.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
      parent,
    });
    props.onReady?.(view);
    view.focus();

    onCleanup(() => view?.destroy());
  });

  return <div ref={parent!} class="w-full" />;
};
