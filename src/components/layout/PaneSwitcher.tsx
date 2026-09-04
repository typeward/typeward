import { Eye, FileText, FolderTree, ScrollText } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { handleTablistKeydown, rovingTabIndex } from "~/lib/tablist-nav";
import { compileState, lastResult } from "~/stores/editor-store";
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
  const errorCount = (): number =>
    lastResult()?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  const logsLabel = (): string => {
    if (compileState() !== "error") return "Toggle logs";
    const n = errorCount();
    // Zero errors with an error state = the compile itself blew up before
    // producing diagnostics; the dot badge still needs a spoken counterpart.
    return n > 0
      ? `Toggle logs, ${n} error${n === 1 ? "" : "s"}`
      : "Toggle logs, compile failed";
  };
  return (
    <div
      class="glass-soft mx-2 mb-2 flex min-h-[52px] flex-shrink-0 items-center gap-1 rounded-xl border border-glass-stroke p-1"
      // Bottom-anchored bar: keep the tap targets above iPad/Android
      // gesture-nav insets (viewport-fit=cover exposes the env() values).
      style={{
        "padding-bottom": "calc(0.25rem + env(safe-area-inset-bottom, 0px))",
      }}
      role="tablist"
      aria-label="Editor panes"
      onKeyDown={(e) =>
        handleTablistKeydown(e, {
          count: OPTIONS.length,
          activeIndex: OPTIONS.findIndex((o) => o.pane === activePane()),
          activate: (i) => setActivePane(OPTIONS[i].pane),
        })
      }
    >
      <For each={OPTIONS}>
        {(opt) => {
          const active = () => activePane() === opt.pane;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              tabIndex={rovingTabIndex(active())}
              onClick={() => setActivePane(opt.pane)}
              class={`lift flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg text-base font-medium transition ${
                active() ? "text-fg-1" : "text-fg-3 hover:text-fg-2"
              }`}
              style={
                active()
                  ? {
                      background:
                        "linear-gradient(180deg, color-mix(in srgb, var(--color-accent-1) 18%, transparent), color-mix(in srgb, var(--color-accent-1) 8%, transparent))",
                      border: "1px solid color-mix(in srgb, var(--color-accent-1) 32%, transparent)",
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
        class="lift relative flex h-11 w-11 items-center justify-center rounded-lg text-fg-3 hover:text-fg-1"
        aria-label={logsLabel()}
        title={logsLabel()}
        // Stable hook for the LogsSheet focus-restore: the aria-label is
        // dynamic (error counts), so name-based queries break exactly in the
        // compile-failed flow the sheet exists for.
        data-logs-toggle
      >
        <ScrollText size={18} />
        <Show when={compileState() === "error"}>
          <span
            aria-hidden
            class="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-[var(--color-danger-fill)] px-1 text-[10px] font-semibold leading-4 text-white"
          >
            {errorCount() > 0 ? errorCount() : "•"}
          </span>
        </Show>
      </button>
    </div>
  );
};
