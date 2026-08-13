/**
 * Read-only unified diff of a recorded version against the current buffer,
 * rendered with `@codemirror/merge`. The merge package is dynamic-imported so
 * the diff stack stays off the boot path (`check:bundle` budget) — same
 * discipline as the updater chunk. Rendering inside the editor stack
 * means the `--color-*` theme tokens apply for free.
 */
export async function mountHistoryDiff(
  parent: HTMLElement,
  original: string,
  current: string,
): Promise<() => void> {
  const [{ unifiedMergeView }, { EditorView }, { EditorState }] = await Promise.all([
    import("@codemirror/merge"),
    import("@codemirror/view"),
    import("@codemirror/state"),
  ]);

  const theme = EditorView.theme({
    "&": {
      fontSize: "12px",
      background: "transparent",
      color: "var(--color-fg-1)",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      padding: "8px 0",
    },
    ".cm-gutters": {
      background: "transparent",
      border: "none",
      color: "var(--color-fg-4)",
    },
    ".cm-changedLine": {
      background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
    },
    ".cm-changedText": {
      background: "color-mix(in srgb, var(--color-ok) 26%, transparent)",
    },
    ".cm-deletedChunk": {
      background: "color-mix(in srgb, var(--color-err) 10%, transparent)",
    },
    ".cm-deletedChunk del": {
      background: "color-mix(in srgb, var(--color-err) 24%, transparent)",
      textDecoration: "none",
    },
  });

  const view = new EditorView({
    parent,
    doc: current,
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      unifiedMergeView({ original, mergeControls: false }),
      theme,
    ],
  });
  return () => view.destroy();
}
