/**
 * Toast service — the imperative `notify*` API the whole app calls. Kept
 * dependency-free (no Kobalte, no JSX) so stores, commands, and lib code can
 * enqueue toasts with a plain static import, without pulling the rendering
 * stack into their module graph (which also kept it out of their unit tests).
 *
 * The `<Toaster>` component (components/feedback/Toaster.tsx) owns the Kobalte
 * rendering and drains this queue reactively. `notifyError` in particular is
 * how previously-silent async failures reach the user instead of vanishing
 * into the console.
 */

import { createSignal } from "solid-js";

import { describeIpcError } from "~/lib/errors";
import { recordError } from "~/lib/telemetry";

export type ToastKind = "error" | "info" | "success";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastRequest {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  action?: ToastAction;
}

let _seq = 0;
// Ring-bounded so an early burst before <Toaster> mounts (or a runaway loop)
// can't grow without limit; the component drains this each time it changes.
const MAX_PENDING = 32;
const [pendingToasts, setPendingToasts] = createSignal<ToastRequest[]>([]);

export { pendingToasts };

function enqueue(
  kind: ToastKind,
  title: string,
  description?: string,
  action?: ToastAction,
): void {
  setPendingToasts((prev) => {
    const next = [...prev, { id: ++_seq, kind, title, description, action }];
    return next.length > MAX_PENDING ? next.slice(next.length - MAX_PENDING) : next;
  });
}

export const notifyError = (
  title: string,
  description?: string,
  action?: ToastAction,
): void => {
  // Mirror every error toast to the console so a dismissed toast still
  // leaves a local debugging trace.
  try {
    recordError("toast-error", title, description);
  } catch {
    /* logging must never block the toast itself */
  }
  enqueue("error", title, description, action);
};
export const notifyInfo = (
  title: string,
  description?: string,
  action?: ToastAction,
): void => enqueue("info", title, description, action);
export const notifySuccess = (
  title: string,
  description?: string,
  action?: ToastAction,
): void => enqueue("success", title, description, action);

/** @deprecated use `describeIpcError` from `~/lib/errors`. */
export const errorText = describeIpcError;
