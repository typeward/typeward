import type { Component } from "solid-js";
import { Show, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { Button } from "~/components/primitives/Button";
import { installDismiss } from "~/lib/dismiss";
import { localAuthor } from "~/lib/reviews/identity";
import { createThread } from "~/lib/reviews/types";
import { activeFile } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import {
  addThread,
  clearReviewCompose,
  requestThreadPanel,
  reviewComposeIntent,
  type ReviewComposeIntent,
} from "~/stores/review-store";

/**
 * Compose popover for a new editor-anchored review comment / TODO — the
 * editor-side twin of the PDF selection chip's compose view, so both entry
 * points share one contract: write the note first, then the thread appears.
 *
 * Portals to document.body for the same reason as VisualPopover: glass
 * ancestors inside the panes re-anchor `fixed` positioning and open stacking
 * contexts, so an in-pane popover could paint under the preview pane.
 */
export const ReviewComposePopover: Component = () => (
  <Show when={reviewComposeIntent()} keyed>
    {(intent) => <ComposeBody intent={intent} />}
  </Show>
);

const ComposeBody: Component<{ intent: ReviewComposeIntent }> = (props) => {
  let root!: HTMLDivElement;
  let box!: HTMLTextAreaElement;
  // Bind to the view AND file the compose was opened against; a file switch
  // while the popover is open must never anchor the thread in another file.
  const view = getActiveEditorView();
  const openRel = activeFile()?.relPath ?? null;
  const openPath = activeFile()?.path ?? null;
  const [draft, setDraft] = createSignal("");

  const isTodo = props.intent.kind === "todo";
  // Position under the selection start; clamped to the viewport.
  const coords = view?.coordsAtPos(props.intent.from) ?? null;
  const top = coords ? Math.min(coords.bottom + 8, window.innerHeight - 230) : 120;
  const left = coords ? Math.min(Math.max(coords.left - 20, 12), window.innerWidth - 360) : 120;

  const close = (): void => {
    clearReviewCompose();
    view?.focus();
  };

  installDismiss(
    () => root,
    () => true,
    close,
  );

  onMount(() => box.focus());

  const submit = (): void => {
    const body = draft().trim();
    if (body === "") return;
    const v = view;
    if (!v || !v.dom.isConnected || openRel === null || activeFile()?.path !== openPath) {
      return close();
    }
    // The document can move while composing (autosave adoption, sync) —
    // clamp so stale offsets can't land past the end.
    const to = Math.min(props.intent.to, v.state.doc.length);
    const from = Math.min(props.intent.from, to);
    const thread = createThread(
      openRel,
      from,
      to,
      props.intent.anchorText,
      localAuthor(),
      body,
      props.intent.kind,
    );
    addThread(thread);
    requestThreadPanel(thread.id);
    close();
  };

  return (
    <Portal>
      <div
        ref={root!}
        class="fixed z-50 flex w-[340px] max-w-[92vw] flex-col gap-2 rounded-lg p-3 shadow-lg"
        style={{
          top: `${top}px`,
          left: `${left}px`,
          background: "var(--color-popover-bg)",
          border: "1px solid var(--color-glass-stroke)",
          "box-shadow": "var(--shadow-glass-drop)",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={isTodo ? "New TODO" : "New comment"}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium" style={{ color: "var(--color-fg-3)" }}>
            {isTodo ? "New TODO" : "New comment"}
          </span>
          <span class="text-[10px]" style={{ color: "var(--color-fg-4)" }}>
            Mod+Enter to add
          </span>
        </div>
        <textarea
          ref={box!}
          rows={3}
          placeholder="Add a note…"
          class="scroll w-full resize-none rounded-md px-2.5 py-2 text-sm outline-none"
          style={{
            background: "var(--color-control-fill)",
            color: "var(--color-fg-1)",
            border: "1px solid var(--color-control-stroke)",
          }}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div class="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={draft().trim() === ""} onClick={submit}>
            {isTodo ? "Add TODO" : "Add comment"}
          </Button>
        </div>
      </div>
    </Portal>
  );
};
