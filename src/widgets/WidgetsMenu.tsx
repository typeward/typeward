import { ChevronDown, LayoutGrid } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { listWidgets } from "./registry";
import "./builtins";
import { toggleWidget, widgetEnabled } from "~/stores/workspace-store";

/**
 * Dropdown trigger + popover that lets the user enable/disable each
 * registered widget. State persists via `workspace-store` (which is wired
 * to Rust settings.json).
 *
 * Implementation note: simple click-outside popover via document listener;
 * no Kobalte Popover here because the menu needs to span beyond the trigger
 * and Kobalte's positioning is overkill for this use.
 */
export const WidgetsMenu: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  const handleDocClick = (e: MouseEvent) => {
    if (!rootRef) return;
    if (rootRef.contains(e.target as Node)) return;
    setOpen(false);
  };

  const onTrigger = () => {
    setOpen((v) => !v);
    if (!open()) {
      // We just closed it; nothing to wire. When opening, attach the
      // listener on the next tick so the click that opened doesn't
      // immediately close.
      return;
    }
    setTimeout(() => document.addEventListener("click", handleDocClick), 0);
  };

  onCleanup(() => document.removeEventListener("click", handleDocClick));

  const widgets = () => listWidgets();
  const isOn = (id: string, def: boolean) => {
    const map = widgetEnabled();
    return map[id] === undefined ? def : map[id];
  };

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        onClick={onTrigger}
        class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[length:var(--ui-font-sm)] text-fg-2 hover:bg-white/[0.04]"
      >
        <LayoutGrid size={12} style={{ opacity: 0.7 }} />
        <span>Widgets</span>
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>
      <Show when={open()}>
        <div
          class="glass absolute left-0 top-full z-40 mt-1 w-[280px] rounded-xl"
          style={{
            padding: "var(--ui-pad-section)",
            background: "rgba(15,17,22,0.96)",
            "animation": "var(--motion-dropdown, none)",
          }}
        >
          <div class="mb-2 flex items-center justify-between px-1">
            <span class="label-xs text-fg-3">Widgets</span>
            <span class="mono text-[10px] text-fg-4">{widgets().length}</span>
          </div>
          <div class="flex flex-col gap-0.5 max-h-[380px] overflow-auto scroll">
            <For each={widgets()}>
              {(w) => (
                <button
                  type="button"
                  onClick={() => toggleWidget(w.id)}
                  class="lift flex items-center gap-2.5 rounded-md p-2 text-left hover:bg-white/[0.04]"
                >
                  <span
                    class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
                    style={{ background: "rgba(255,255,255,0.04)" }}
                  >
                    {w.icon(13)}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                        {w.title}
                      </span>
                      <Show when={w.stub}>
                        <span
                          class="mono rounded px-1 text-[9px]"
                          style={{
                            background: "rgba(255,255,255,0.04)",
                            color: "var(--color-fg-3)",
                          }}
                        >
                          stub
                        </span>
                      </Show>
                    </div>
                    <div class="mono mt-0.5 text-[10px] text-fg-3">
                      {w.description}
                    </div>
                  </div>
                  <span
                    class="flex h-4 w-[26px] items-center rounded-full p-0.5 transition-colors"
                    style={{
                      background: isOn(w.id, w.defaultEnabled)
                        ? "var(--color-accent-1)"
                        : "rgba(255,255,255,0.08)",
                    }}
                  >
                    <span
                      class="h-3 w-3 rounded-full bg-white"
                      style={{
                        transform: isOn(w.id, w.defaultEnabled)
                          ? "translateX(10px)"
                          : "translateX(0)",
                        transition: "transform 150ms ease-out",
                      }}
                    />
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
};
