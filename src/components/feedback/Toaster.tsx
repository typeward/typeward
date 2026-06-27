/**
 * App-wide toast surface. Wraps Kobalte's Toast primitive (which provides an
 * `aria-live` region for free) and exposes a small imperative API the rest of
 * the app calls. `notifyError` in particular is how previously-silent async
 * failures (file saves, keyring disconnects, library refresh, sync errors)
 * reach the user instead of vanishing into telemetry.
 *
 * Mount `<Toaster />` once at the App root; `notify*` can be called from
 * anywhere (the Kobalte `toaster` is a global singleton).
 */

import { Toast, toaster } from "@kobalte/core/toast";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-solid";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";

type ToastKind = "error" | "info" | "success";

const KIND: Record<ToastKind, { icon: Component<{ class?: string }>; color: string }> = {
  error: { icon: AlertTriangle, color: "var(--color-err)" },
  info: { icon: Info, color: "var(--color-accent-1)" },
  success: { icon: CheckCircle2, color: "var(--color-accent-1)" },
};

/**
 * Normalize an unknown thrown value (`Error` / string / Tauri rejection object)
 * into a human-readable line. Tauri IPC rejections are frequently plain objects,
 * so `String(e)` would render a useless `[object Object]`.
 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

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
        "box-shadow": "0 8px 28px rgb(0 0 0 / 0.28)",
        "border-left": `3px solid ${meta.color}`,
      }}
    >
      <span style={{ color: meta.color, "flex-shrink": "0", "margin-top": "1px" }}>
        <Dynamic component={meta.icon} class="ui-icon-sm" />
      </span>
      <div class="min-w-0 flex-1">
        <Toast.Title class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
          {title}
        </Toast.Title>
        <Show when={description}>
          <Toast.Description class="mt-0.5 break-words text-[length:var(--ui-font-xs)] text-fg-3">
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

export const notifyError = (title: string, description?: string): void =>
  show("error", title, description);
export const notifyInfo = (title: string, description?: string): void =>
  show("info", title, description);
export const notifySuccess = (title: string, description?: string): void =>
  show("success", title, description);

export const Toaster: Component = () => (
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
