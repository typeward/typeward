import {
  Bell,
  Search,
  Settings as SettingsIcon,
} from "lucide-solid";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import { KbdHint } from "~/components/primitives/KbdHint";
import { SubscriptionBadge } from "~/components/account/SubscriptionBadge";
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
      {/* Centered Cmd+K search. Flexes to fill, max width matches the projects
        center column. */}
      <div class="flex flex-1 justify-center">
        <button
          type="button"
          onClick={() => props.onOpenPalette?.()}
          class="lift glass-soft flex h-9 w-full max-w-[640px] items-center gap-2.5 rounded-lg px-3 text-[length:var(--ui-font-sm)] text-fg-3 hover:text-fg-2"
        >
          <Search class="ui-icon-chrome" style={{ opacity: 0.6 }} />
          <span>Search projects, papers, collaborators…</span>
          <span class="ml-auto">
            <KbdHint shortcut="Mod+K" />
          </span>
        </button>
      </div>

      {/* Right cluster — density-sized icons */}
      <div class="absolute right-4 top-0 flex h-full items-center gap-2">
        <SubscriptionBadge />
        <GitStatusBar />
        <SyncStatusBadge />
        <button
          type="button"
          data-notif-toggle
          onClick={() => props.onToggleNotifications?.()}
          aria-label="Notifications"
          class="lift relative flex h-9 w-9 items-center justify-center rounded-md text-fg-2 hover:bg-[var(--color-control-fill)]"
        >
          <Bell class="ui-icon-chrome" style={{ opacity: 0.85 }} />
          <Show when={props.notifications && props.notifications > 0}>
            <span
              class="mono absolute -right-0.5 -top-0.5 rounded-full px-1 text-[11px]"
              style={{
                background: "color-mix(in srgb, var(--color-err) 18%, transparent)",
                color: "var(--color-err)",
              }}
            >
              {props.notifications}
            </span>
          </Show>
        </button>
        <button
          type="button"
          onClick={() => props.onOpenSettings?.()}
          aria-label="Settings"
          class="lift flex h-9 w-9 items-center justify-center rounded-md text-fg-2 hover:bg-[var(--color-control-fill)]"
        >
          <SettingsIcon class="ui-icon-chrome" style={{ opacity: 0.85 }} />
        </button>
      </div>
    </div>
  );
};

