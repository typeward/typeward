import { Eye, FileText, FolderTree, ScrollText } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For } from "solid-js";
import {
  activePane,
  type Pane,
  setActivePane,
  toggleLogsSheet,
} from "~/stores/viewport-store";

/**
 * Bottom segmented control for tablet viewports. Three primary panes
 * (sidebar/editor/preview) plus a Logs sheet toggle. Every control is
 * sized to a 44px+ tap target (iOS HIG / Material both put the floor
 * there) and lives at the bottom of the viewport for thumb-reach.
 */

const OPTIONS: { pane: Pane; label: string; icon: () => JSX.Element }[] = [
  { pane: "sidebar", label: "Files", icon: () => <FolderTree size={18} /> },
  { pane: "editor", label: "Edit", icon: () => <FileText size={18} /> },
  { pane: "preview", label: "Preview", icon: () => <Eye size={18} /> },
];

export const PaneSwitcher: Component = () => {
  return (
    <div
      class="glass-soft mx-2 mb-2 flex h-[52px] flex-shrink-0 items-center gap-1 rounded-xl border border-glass-stroke p-1"
      role="tablist"
      aria-label="Editor panes"
    >
      <For each={OPTIONS}>
        {(opt) => {
          const active = () => activePane() === opt.pane;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              onClick={() => setActivePane(opt.pane)}
              class={`lift flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition ${
                active() ? "text-fg-1" : "text-fg-3 hover:text-fg-2"
              }`}
              style={
                active()
                  ? {
                      background:
                        "linear-gradient(180deg, rgba(139,92,246,0.18), rgba(139,92,246,0.08))",
                      border: "1px solid rgba(139,92,246,0.32)",
                    }
                  : undefined
              }
            >
              {opt.icon()}
              <span>{opt.label}</span>
            </button>
          );
        }}
      </For>
      <div class="mx-0.5 h-6 w-px bg-glass-stroke" aria-hidden />
      <button
        type="button"
        onClick={() => toggleLogsSheet()}
        class="lift flex h-11 w-11 items-center justify-center rounded-lg text-fg-3 hover:text-fg-1"
        aria-label="Toggle logs"
        title="Toggle logs"
      >
        <ScrollText size={18} />
      </button>
    </div>
  );
};
