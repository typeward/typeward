import type { Component } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { listWidgets } from "./registry";
import "./builtins";
import { widgetEnabled } from "~/stores/workspace-store";
import { isTabletViewport } from "~/stores/viewport-store";

/**
 * Horizontal (or vertical on tablet) row of enabled widgets. Hidden entirely
 * when no widget is enabled. Each widget gets a uniform glass-soft card with
 * its own title strip; the widget body fills the remaining space.
 *
 * Spec: /design/widgets.md.
 */
export const WidgetsShelf: Component = () => {
  const enabled = createMemo(() => {
    const map = widgetEnabled();
    return listWidgets().filter((w) => {
      const explicit = map[w.id];
      return explicit === undefined ? w.defaultEnabled : explicit;
    });
  });

  return (
    <Show when={enabled().length > 0}>
      <div
        class={`flex gap-2 overflow-x-auto scroll px-1 pb-1 ${
          isTabletViewport() ? "flex-col" : ""
        }`}
        style={{ "scroll-snap-type": "x mandatory" }}
      >
        <For each={enabled()}>
          {(w) => (
            <div
              class="glass-soft flex flex-shrink-0 flex-col gap-2 rounded-xl"
              style={{
                width: isTabletViewport() ? "100%" : "320px",
                height: "200px",
                padding: "var(--ui-pad-card)",
                "scroll-snap-align": "start",
              }}
            >
              <div class="flex items-center gap-2">
                <span style={{ color: "var(--color-accent-1)" }}>
                  {w.icon(13)}
                </span>
                <span class="label-xs text-fg-2">{w.title}</span>
              </div>
              <div class="min-h-0 flex-1">
                <w.Render />
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};
