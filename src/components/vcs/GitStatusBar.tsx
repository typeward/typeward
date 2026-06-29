/**
 * TopBar git status indicator: branch + ahead/behind counters.
 *
 * Hidden when the active project isn't a git repo so users not using
 * VCS see no chrome. Polls every 4 seconds (slower cadence than the
 * CommitPanel since this is just a glance affordance).
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

const POLL_INTERVAL_MS = 4_000;

export const GitStatusBar: Component = () => {
  const [tick, setTick] = createSignal(0);
  let handle: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    if (handle !== undefined) {
      clearInterval(handle);
      handle = undefined;
    }
  };
  // Re-arm polling whenever the active project changes; a non-repo result
  // halts it (see the fetcher) so we don't run a libgit2 status walk every
  // 4s forever on plain folders for the whole session.
  createEffect(
    on(
      () => project()?.rootPath,
      () => {
        stopPolling();
        handle = setInterval(() => setTick((t) => t + 1), POLL_INTERVAL_MS);
      },
    ),
  );
  onCleanup(stopPolling);

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
        // the bar — quieter than a "not a repo" pill, and avoids a pointless
        // status walk every 4s on non-repo projects.
        stopPolling();
        return null;
      }
    },
  );

  return (
    <Show when={summary()?.branch}>
      <div
        class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--ui-font-xs)]"
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
