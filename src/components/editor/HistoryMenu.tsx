import { History } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createEffect, createSignal } from "solid-js";
import {
  requestHistoryPanel_,
  setRequestHistoryPanel,
} from "~/commands/palette-store";
import { HistoryPanel } from "~/components/editor/HistoryPanel";
import { installDismiss } from "~/lib/dismiss";

/**
 * Project-history popover in the editor top bar (moved out of the left sidebar
 * per user direction 2026-07-19). Hosts the existing HistoryPanel; the
 * `core.fileHistory` palette command and the editor context menu open it
 * through the same requestHistoryPanel intent as before.
 */
export const HistoryMenu: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  createEffect(() => {
    if (!requestHistoryPanel_()) return;
    setOpen(true);
    setRequestHistoryPanel(false);
  });

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        title="Project history"
        aria-label="Project history"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
        class="lift flex h-9 w-9 items-center justify-center rounded-md hover:bg-[var(--color-control-fill)]"
      >
        <History class="ui-icon-chrome" style={{ opacity: 0.85 }} />
      </button>
      <Show when={open()}>
        <div
          tabindex={-1}
          role="group"
          aria-label="Project history"
          class="glass absolute right-0 top-full z-50 mt-1 flex w-[480px] max-w-[92vw] flex-col overflow-hidden rounded-xl"
          style={{
            background: "var(--color-popover-bg)",
            "max-height": "min(70vh, 560px)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div class="scroll min-h-0 flex-1 overflow-y-auto">
            <HistoryPanel />
          </div>
        </div>
      </Show>
    </div>
  );
};
