import { Bell, CheckCircle2, Info, AlertTriangle, X as XIcon } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";

/**
 * Right-side notifications drawer. Slides in from the right when open;
 * unmounts when closed. Animation honors the motion toggle (transitions are
 * neutered globally by `<html data-motion="reduced">`).
 *
 * Notifications themselves are in-memory for now — a backing store lands
 * alongside the real notifications surface (telemetry events, compile
 * failures, sync conflicts, license renewals).
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

export const NotificationsPanel: Component<{
  open: boolean;
  onClose: () => void;
}> = (props) => {
  const dismiss = (id: string) =>
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  const markAllRead = () =>
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));

  return (
    <div
      class="glass absolute right-2 top-2 bottom-2 z-30 flex flex-col overflow-hidden rounded-xl"
      style={{
        width: "320px",
        transition:
          "transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease",
        transform: props.open ? "translateX(0)" : "translateX(calc(100% + 12px))",
        opacity: props.open ? "1" : "0",
        "pointer-events": props.open ? "auto" : "none",
        "box-shadow":
          "var(--shadow-glass-drop), 0 0 0 1px var(--color-glass-stroke)",
      }}
      aria-hidden={!props.open}
      // Hidden via transform/opacity, so its buttons would still be in the
      // tab order without inert (aria-hidden + focusable is a WCAG failure).
      inert={!props.open}
    >
      <div class="flex h-[44px] flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-3">
        <Bell size={14} style={{ color: "var(--color-accent-1)" }} />
        <span class="text-[length:var(--ui-font-sm)] font-semibold text-fg-1">
          Notifications
        </span>
        <span class="mono ml-1 rounded-full px-1.5 text-[10px] text-fg-3"
          style={{ background: "var(--color-control-fill)" }}>
          {notifications().length}
        </span>
        <button
          type="button"
          onClick={markAllRead}
          class="mono ml-auto text-[11px] text-fg-2 hover:text-fg-1"
        >
          mark all read
        </button>
        <button
          type="button"
          onClick={props.onClose}
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
            <div class="grid h-full place-items-center text-[length:var(--ui-font-sm)] text-fg-3">
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
                    <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
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
                    <div class="mono mt-0.5 text-[11px] leading-snug text-fg-3">
                      {n.body}
                    </div>
                  </Show>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(n.id)}
                  aria-label="Dismiss"
                  class="lift flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
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
