import { Bell, CheckCircle2, Info, AlertTriangle, X as XIcon } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { installDismiss } from "~/lib/dismiss";

/**
 * Right-side notifications drawer. Slides in from the right when open;
 * unmounts when closed. Animation honors the motion toggle (transitions are
 * neutered globally by `<html data-motion="reduced">`).
 *
 * Notifications themselves are in-memory for now — a backing store lands
 * alongside the real notifications surface (compile failures, sync
 * conflicts, update notices).
 */

export interface Notification {
  id: string;
  kind: "info" | "ok" | "warn" | "err";
  title: string;
  body?: string;
  ts: number;
  read?: boolean;
}

const [notifications, setNotifications] = createSignal<Notification[]>([
  {
    id: "welcome",
    kind: "info",
    title: "Welcome to Typeward",
    body: "Notifications about compiles, syncs, and updates land here.",
    ts: Date.now(),
  },
]);

export const unreadCount = (): number =>
  notifications().filter((n) => !n.read).length;

// Shared open-state, CommandPalette-style: the drawer mounts once at the App
// root and every screen's bell drives the same signal, so notifications are
// reachable from Projects, Settings, and the editor alike.
const [notifOpen, setNotifOpen] = createSignal(false);
export { notifOpen };
export const toggleNotifications = (): void => {
  setNotifOpen((v) => !v);
};
export const openNotifications = (): void => {
  setNotifOpen(true);
};
export const closeNotifications = (): void => {
  setNotifOpen(false);
};

export const NotificationsPanel: Component = () => {
  const dismiss = (id: string) =>
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  const markAllRead = () =>
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));

  let panelRef: HTMLDivElement | undefined;
  // Close when clicking anywhere outside the drawer, except the bell toggle
  // (its own handler closes it — otherwise the two would fight and reopen).
  installDismiss(() => panelRef, () => notifOpen(), () => closeNotifications(), {
    ignoreSelector: "[data-notif-toggle]",
  });

  return (
    <div
      ref={panelRef}
      class="glass fixed right-2 top-[60px] bottom-2 z-40 flex flex-col overflow-hidden rounded-xl"
      style={{
        width: "320px",
        // Near-opaque like the other floating surfaces: a floating bare-glass
        // panel over live page content depends on backdrop-filter sampling
        // WebKit does not do reliably under transformed/faded ancestors.
        background: "var(--color-popover-bg)",
        transition:
          "transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease",
        // `none`, not the identity translateX(0): a lingering transform keeps
        // a compositing layer alive, the case where WebKit samples a glass
        // panel's backdrop from the wrong region at rest.
        transform: notifOpen() ? "none" : "translateX(calc(100% + 12px))",
        opacity: notifOpen() ? undefined : "0",
        "pointer-events": notifOpen() ? "auto" : "none",
        "box-shadow":
          "var(--shadow-glass-drop), 0 0 0 1px var(--color-glass-stroke)",
      }}
      aria-hidden={!notifOpen()}
      // Hidden via transform/opacity, so its buttons would still be in the
      // tab order without inert (aria-hidden + focusable is a WCAG failure).
      inert={!notifOpen()}
    >
      <div class="flex h-[44px] flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-3">
        <Bell size={14} style={{ color: "var(--color-accent-1)" }} />
        <span class="text-sm font-semibold text-fg-1">
          Notifications
        </span>
        <span class="mono ml-1 rounded-full px-1.5 text-[10px] text-fg-3"
          style={{ background: "var(--color-control-fill)" }}>
          {notifications().length}
        </span>
        <button
          type="button"
          onClick={markAllRead}
          class="mono ml-auto text-xs text-fg-2 hover:text-fg-1"
        >
          mark all read
        </button>
        <button
          type="button"
          onClick={closeNotifications}
          aria-label="Close notifications"
          class="lift flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
        >
          <XIcon size={12} class="text-fg-2" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-auto scroll p-2">
        <Show
          when={notifications().length > 0}
          fallback={
            <div class="grid h-full place-items-center text-sm text-fg-3">
              nothing here yet
            </div>
          }
        >
          <For each={notifications()}>
            {(n) => (
              <div class="glass-soft mb-1.5 flex items-start gap-2.5 rounded-lg p-2.5">
                <Icon kind={n.kind} />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="text-sm font-medium text-fg-1">
                      {n.title}
                    </span>
                    <Show when={!n.read}>
                      <span
                        class="h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--color-accent-1)" }}
                      />
                    </Show>
                  </div>
                  <Show when={n.body}>
                    <div class="mono mt-0.5 select-text text-xs leading-snug text-fg-3">
                      {n.body}
                    </div>
                  </Show>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(n.id)}
                  aria-label="Dismiss"
                  class="lift flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
                >
                  <XIcon size={10} class="text-fg-3" />
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

const Icon: Component<{ kind: Notification["kind"] }> = (props) => {
  const map: Record<Notification["kind"], { node: JSX.Element; tint: string }> = {
    info: { node: <Info size={13} />, tint: "var(--color-accent-2)" },
    ok: { node: <CheckCircle2 size={13} />, tint: "var(--color-ok)" },
    warn: { node: <AlertTriangle size={13} />, tint: "var(--color-warn)" },
    err: { node: <AlertTriangle size={13} />, tint: "var(--color-err)" },
  };
  const entry = map[props.kind];
  return (
    <span
      class="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
      style={{ background: "var(--color-control-fill)", color: entry.tint }}
    >
      {entry.node}
    </span>
  );
};
