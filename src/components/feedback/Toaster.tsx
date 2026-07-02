/**
 * App-wide toast surface. Owns the Kobalte Toast rendering (which provides an
 * `aria-live` region for free) and drains the dependency-free toast queue in
 * `~/lib/toast` — so the imperative `notify*` service stays Kobalte-free and
 * callable from stores/commands/lib without pulling this rendering stack.
 *
 * Mount `<Toaster />` once at the App root. The `notify*` functions are
 * re-exported here for existing component-layer callers.
 */

import { Toast, toaster } from "@kobalte/core/toast";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createEffect } from "solid-js";
import { Dynamic } from "solid-js/web";

import { pendingToasts, type ToastKind } from "~/lib/toast";

export {
  notifyError,
  notifyInfo,
  notifySuccess,
  errorText,
} from "~/lib/toast";

const KIND: Record<ToastKind, { icon: Component<{ class?: string }>; color: string }> = {
  error: { icon: AlertTriangle, color: "var(--color-err)" },
  info: { icon: Info, color: "var(--color-accent-1)" },
  success: { icon: CheckCircle2, color: "var(--color-accent-1)" },
};

function show(kind: ToastKind, title: string, description?: string): void {
  const meta = KIND[kind];
  toaster.show((props) => (
    <Toast
      toastId={props.toastId}
      duration={kind === "error" ? 7000 : 4000}
      class="glass"
      style={{
        display: "flex",
        "align-items": "flex-start",
        gap: "10px",
        padding: "12px 12px 12px 14px",
        "border-radius": "12px",
        background: "var(--color-popover-bg)",
        "border-left": `3px solid ${meta.color}`,
      }}
    >
      <span style={{ color: meta.color, "flex-shrink": "0", "margin-top": "1px" }}>
        <Dynamic component={meta.icon} class="ui-icon-sm" />
      </span>
      <div class="min-w-0 flex-1">
        <Toast.Title class="text-sm font-medium text-fg-1">
          {title}
        </Toast.Title>
        <Show when={description}>
          <Toast.Description class="mt-0.5 select-text break-words text-xs text-fg-3">
            {description}
          </Toast.Description>
        </Show>
      </div>
      <Toast.CloseButton
        class="lift -m-1 flex-shrink-0 rounded p-1 text-fg-3 hover:text-fg-1"
        aria-label="Dismiss notification"
      >
        <X class="ui-icon-sm" />
      </Toast.CloseButton>
    </Toast>
  ));
}

export const Toaster: Component = () => {
  // Drain the pure toast queue into Kobalte. Track the last id shown so each
  // request renders exactly once even though the signal carries a rolling
  // window of recent entries.
  let lastShown = 0;
  createEffect(() => {
    for (const t of pendingToasts()) {
      if (t.id > lastShown) {
        lastShown = t.id;
        show(t.kind, t.title, t.description);
      }
    }
  });

  return (
    <Toast.Region>
      <Toast.List
        class="scroll"
        style={{
          position: "fixed",
          bottom: "16px",
          right: "16px",
          "z-index": "9999",
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          width: "min(380px, calc(100vw - 32px))",
          "max-height": "100vh",
          margin: "0",
          padding: "0",
          "list-style": "none",
          outline: "none",
          overflow: "hidden",
        }}
      />
    </Toast.Region>
  );
};
