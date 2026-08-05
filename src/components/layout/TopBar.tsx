import {
  Bell,
  Search,
  Settings as SettingsIcon,
  X,
} from "lucide-solid";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import { IconButton } from "~/components/primitives/IconButton";
import { KbdHint } from "~/components/primitives/KbdHint";
import { SyncStatusBadge } from "~/components/sync/SyncStatusBadge";
import { GitStatusBar } from "~/components/vcs/GitStatusBar";

interface TopBarProps {
  /** Triggered when the user clicks the centered search button or presses Cmd+K. */
  onOpenPalette?: () => void;
  /** Triggered when the user clicks the gear. */
  onOpenSettings?: () => void;
  /** Triggered when the user clicks the bell. The Projects screen wires
   *  this to the notifications panel toggle; other screens may ignore it. */
  onToggleNotifications?: () => void;
  /** Optional unread notification count badge. */
  notifications?: number;
  /** When present, the center slot becomes a real library-search input (Projects
   *  screen) instead of the palette button. The palette stays one click away via
   *  the Mod+K chip. */
  search?: { value: string; onInput: (v: string) => void };
}

/**
 * Window chrome for Projects + Settings shells. Centered global search; right
 * cluster has bell (toggles notifications panel on Projects screen) and
 * settings gear. Traffic lights + brand cluster + workspace pill were removed
 * 2026-05-15 (Tauri owns chrome; brand belongs in the product, not the bar).
 *
 * Icon sizes consume `--ui-icon-chrome` via the `.ui-icon-chrome` utility,
 * so density swaps re-flow correctly.
 */
export const TopBar: Component<TopBarProps> = (props) => {
  return (
    <div
      class="glass relative flex h-[52px] items-center border-b border-glass-stroke px-4"
      style={{ background: "var(--color-topbar-bg)" }}
    >
      {/* Centered slot. On the Projects screen (search prop present) this is the
        live library-search input; elsewhere it's the palette button. Both share
        the same shell size so window chrome stays stable across screens. */}
      <div class="flex flex-1 justify-center">
        <Show
          when={props.search}
          fallback={
            <button
              type="button"
              onClick={() => props.onOpenPalette?.()}
              class="lift glass-soft flex h-9 w-full max-w-[640px] items-center gap-2.5 rounded-lg px-3 text-sm text-fg-3 hover:text-fg-2"
            >
              <Search class="ui-icon-chrome" style={{ opacity: 0.6 }} />
              <span>Search commands and projects…</span>
              <span class="ml-auto">
                <KbdHint shortcut="Mod+K" />
              </span>
            </button>
          }
        >
          {(search) => (
            <div class="glass-soft flex h-9 w-full max-w-[640px] items-center gap-2.5 rounded-lg px-3 text-sm focus-within:ring-1 focus-within:ring-[var(--color-accent-1)]">
              <Search class="ui-icon-chrome flex-shrink-0 text-fg-3" style={{ opacity: 0.6 }} />
              <input
                type="text"
                value={search().value}
                placeholder="Search projects…"
                aria-label="Search projects"
                onInput={(e) => search().onInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (search().value) {
                      e.stopPropagation();
                      search().onInput("");
                    } else {
                      e.currentTarget.blur();
                    }
                  }
                }}
                class="min-w-0 flex-1 bg-transparent text-fg-1 placeholder:text-fg-3 outline-none"
              />
              <Show when={search().value}>
                <button
                  type="button"
                  onClick={() => search().onInput("")}
                  aria-label="Clear search"
                  class="lift flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
                >
                  <X size={12} />
                </button>
              </Show>
              <button
                type="button"
                onClick={() => props.onOpenPalette?.()}
                aria-label="Open command palette"
                class="lift flex-shrink-0 rounded"
              >
                <KbdHint shortcut="Mod+K" />
              </button>
            </div>
          )}
        </Show>
      </div>

      {/* Right cluster — density-sized icons */}
      <div class="absolute right-4 top-0 flex h-full items-center gap-2">
        <GitStatusBar />
        <SyncStatusBadge />
        {/* Inline fg-2 keeps the chrome tint the ghost variant's text
            utilities would otherwise override. */}
        <IconButton
          label="Notifications"
          size="lg"
          data-notif-toggle
          onClick={() => props.onToggleNotifications?.()}
          class="relative"
          style={{ color: "var(--color-fg-2)" }}
        >
          <Bell class="ui-icon-chrome" style={{ opacity: 0.85 }} />
          <Show when={props.notifications && props.notifications > 0}>
            <span
              class="mono absolute -right-0.5 -top-0.5 rounded-full px-1 text-xs"
              style={{
                background: "color-mix(in srgb, var(--color-err) 18%, transparent)",
                color: "var(--color-err)",
              }}
            >
              {props.notifications}
            </span>
          </Show>
        </IconButton>
        <IconButton
          label="Settings"
          size="lg"
          onClick={() => props.onOpenSettings?.()}
          style={{ color: "var(--color-fg-2)" }}
        >
          <SettingsIcon class="ui-icon-chrome" style={{ opacity: 0.85 }} />
        </IconButton>
      </div>
    </div>
  );
};

