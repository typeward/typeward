import { createSignal } from "solid-js";

import { recordError } from "~/lib/telemetry";
import { notifyInfo } from "~/lib/toast";
import { project } from "~/stores/editor-store";

/**
 * Session-scoped visual-mode pause state (plan 63 §4). A file whose scan
 * blows the budget is rendered as pure source for the rest of the session;
 * the `editor.visualModeLatex` setting itself is untouched and every other
 * file stays visual. Not persisted — a restart retries.
 *
 * Kept out of lib/visual/ so the editor shell can read it without pulling
 * the (dynamic-imported) scanner + decoration layer into its chunk.
 */

const [pausedPaths, setPausedPaths] = createSignal<ReadonlySet<string>>(
  new Set<string>(),
);

let toastShown = false;

// Keys carry the project root — relPaths repeat across projects (main.tex),
// and a pause in one project must not disable visual mode in another.
const pauseKey = (relPath: string): string =>
  `${project()?.rootPath ?? ""}::${relPath}`;

export const visualPaused = (relPath: string): boolean =>
  pausedPaths().has(pauseKey(relPath));

export const VISUAL_PAUSED_TOOLTIP =
  "Visual mode paused for this file — it's too large or unusual to render live";

export function markVisualPaused(relPath: string): void {
  const key = pauseKey(relPath);
  if (pausedPaths().has(key)) return;
  setPausedPaths((prev) => {
    const next = new Set(prev);
    next.add(key);
    return next;
  });
  recordError("visual", "visual mode paused (scan budget exceeded)", relPath);
  if (!toastShown) {
    toastShown = true;
    notifyInfo(
      "Visual mode paused",
      `"${relPath}" is too large or unusual to render live — it stays in source mode for this session.`,
    );
  }
}

export function _resetVisualPausedForTests(): void {
  setPausedPaths(new Set<string>());
  toastShown = false;
}
