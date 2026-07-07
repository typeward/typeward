/**
 * TopBar git status indicator: branch + ahead/behind counters.
 *
 * Hidden when the active project isn't a git repo so users not using
 * VCS see no chrome. Refreshes on window focus / visibility plus a slow
 * background interval that skips hidden windows — this bar can outlive
 * the editor (project() stays set after leaving it), so a fast perpetual
 * poll would walk the worktree for the rest of the session.
 */

import { ChevronDown, ChevronUp, GitBranch } from "lucide-solid";
import type { Component } from "solid-js";
import {
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import * as ipc from "~/ipc";
import { project } from "~/stores/editor-store";

const POLL_INTERVAL_MS = 30_000;

export const GitStatusBar: Component = () => {
  const [tick, setTick] = createSignal(0);
  let handle: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    if (handle !== undefined) {
      clearInterval(handle);
      handle = undefined;
    }
  };
  // Gated on the interval handle so a halted bar (non-repo / error) stays
  // halted on focus too, until the active project changes and re-arms it.
  const refresh = () => {
    if (handle !== undefined) setTick((t) => t + 1);
  };
  // Re-arm polling whenever the active project changes; a non-repo result
  // halts it (see the fetcher) so we don't run libgit2 status walks
  // forever on plain folders for the whole session.
  createEffect(
    on(
      () => project()?.rootPath,
      () => {
        stopPolling();
        // Slow background cadence only catches external git activity while
        // the user sits on this screen; skipped while hidden/minimized —
        // the focus/visibility listeners refresh promptly on return.
        handle = setInterval(() => {
          if (!document.hidden) setTick((t) => t + 1);
        }, POLL_INTERVAL_MS);
      },
    ),
  );
  const onFocus = () => refresh();
  const onVisibilityChange = () => {
    if (!document.hidden) refresh();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  onCleanup(() => {
    stopPolling();
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  const [summary] = createResource(
    () => [project()?.rootPath, tick()] as const,
    async ([rootPath]) => {
      if (!rootPath) {
        stopPolling();
        return null;
      }
      try {
        return await ipc.gitStatus(rootPath);
      } catch {
        // Not a git repo, or some transient error. Stop polling and collapse
        // the bar — quieter than a "not a repo" pill, and avoids pointless
        // status walks on non-repo projects.
        stopPolling();
        return null;
      }
    },
  );

  return (
    <Show when={summary()?.branch}>
      <div
        class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
        style={{
          background: "var(--color-control-fill)",
          color: "var(--color-fg-2)",
        }}
        title={
          summary()?.upstream
            ? `Tracking ${summary()?.upstream}${
                (summary()?.ahead ?? 0) > 0 ? ` · ahead ${summary()?.ahead}` : ""
              }${(summary()?.behind ?? 0) > 0 ? ` · behind ${summary()?.behind}` : ""}`
            : "No upstream configured"
        }
      >
        <GitBranch class="ui-icon-sm" />
        <span class="mono">{summary()?.branch}</span>
        <Show when={(summary()?.ahead ?? 0) > 0}>
          <span class="ml-0.5 flex items-center">
            <ChevronUp class="ui-icon-sm" />
            {summary()?.ahead}
          </span>
        </Show>
        <Show when={(summary()?.behind ?? 0) > 0}>
          <span class="ml-0.5 flex items-center">
            <ChevronDown class="ui-icon-sm" />
            {summary()?.behind}
          </span>
        </Show>
      </div>
    </Show>
  );
};
