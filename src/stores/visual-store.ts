import { createSignal } from "solid-js";

import { recordError } from "~/lib/telemetry";
import { notifyInfo } from "~/lib/toast";

/**
 * Session-scoped visual-mode pause state. A file whose parse blows the budget
 * is rendered as pure source for the rest of the session; the
 * `editor.visualModeLatex` setting itself is untouched and every other file
 * stays visual. Not persisted — a restart retries.
 *
 * Kept out of lib/visual/ so the editor shell can read it without pulling
 * the (dynamic-imported) parser + decoration layer into its chunk.
 */

const [pausedPaths, setPausedPaths] = createSignal<ReadonlySet<string>>(
  new Set<string>(),
);

let toastShown = false;

export const visualPaused = (relPath: string): boolean =>
  pausedPaths().has(relPath);

export const VISUAL_PAUSED_TOOLTIP =
  "Visual mode paused for this file — it's too large or unusual to render live";

/**
 * Popover intent raised by the visual layer's widget activation (and by
 * typing `$` — a new-math draft). The VisualPopover component mounted in
 * CenterPane observes and clears it. `to === from` means "insert here".
 */
export interface VisualPopoverIntent {
  /** Construct span at open time (Apply re-validates against a snapshot). */
  from: number;
  to: number;
  /** Coarse construct family — "widget" | "doc" | "newMath" | … */
  kind: string;
}

const [popoverIntent, setPopoverIntent] =
  createSignal<VisualPopoverIntent | null>(null);

export const visualPopoverIntent = popoverIntent;
export const requestVisualPopover = (intent: VisualPopoverIntent): void => {
  setPopoverIntent(intent);
};
export const clearVisualPopover = (): void => {
  setPopoverIntent(null);
};

export function markVisualPaused(relPath: string): void {
  if (pausedPaths().has(relPath)) return;
  setPausedPaths((prev) => {
    const next = new Set(prev);
    next.add(relPath);
    return next;
  });
  recordError("visual", "visual mode paused (parse budget exceeded)", relPath);
  if (!toastShown) {
    toastShown = true;
    notifyInfo(
      "Visual mode paused",
      `"${relPath}" is too large or unusual to render live — it stays in source mode for this session.`,
    );
  }
}
