/**
 * TopBar sync status indicator. Aggregates per-(provider, project)
 * sync states from the engine's status store and surfaces one pill with
 * the worst current phase (conflict > error > pulling/pushing > idle).
 *
 * Hidden entirely when no cloud-backed projects are currently being
 * tracked, so users without cloud sync see no chrome.
 */

import { AlertTriangle, Check, Cloud, Loader2, X } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createMemo } from "solid-js";

import { allSyncStatuses } from "~/integrations/cloud/core";
import type { SyncPhase } from "~/integrations/types";

const PHASE_RANK: Record<SyncPhase, number> = {
  conflict: 4,
  error: 3,
  pulling: 2,
  pushing: 2,
  idle: 1,
};

interface Aggregated {
  phase: SyncPhase;
  count: number;
  conflicts: number;
}

export const SyncStatusBadge: Component = () => {
  const aggregate = createMemo<Aggregated | null>(() => {
    const all = Array.from(allSyncStatuses().values());
    if (all.length === 0) return null;
    let worst: SyncPhase = "idle";
    let conflicts = 0;
    for (const s of all) {
      if (PHASE_RANK[s.phase] > PHASE_RANK[worst]) worst = s.phase;
      conflicts += s.conflicts.length;
    }
    return { phase: worst, count: all.length, conflicts };
  });

  return (
    <Show when={aggregate()}>
      {(agg) => (
        <div
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--ui-font-xs)]"
          style={{
            background: agg().phase === "idle"
              ? "var(--color-control-fill)"
              : agg().phase === "conflict"
                ? "rgba(248, 113, 113, 0.16)"
                : agg().phase === "error"
                  ? "rgba(248, 113, 113, 0.16)"
                  : "rgba(99, 102, 241, 0.16)",
            color: agg().phase === "idle"
              ? "var(--color-fg-2)"
              : agg().phase === "conflict" || agg().phase === "error"
                ? "rgb(248, 113, 113)"
                : "rgb(129, 140, 248)",
          }}
          title={
            agg().conflicts > 0
              ? `${agg().conflicts} unresolved conflict${agg().conflicts === 1 ? "" : "s"}`
              : `${agg().count} cloud-backed project${agg().count === 1 ? "" : "s"}`
          }
        >
          <PhaseIcon phase={agg().phase} />
          <span>{labelFor(agg().phase, agg().conflicts)}</span>
        </div>
      )}
    </Show>
  );
};

const PhaseIcon: Component<{ phase: SyncPhase }> = (props) => (
  <>
    <Show when={props.phase === "idle"}>
      <Cloud class="ui-icon-sm" />
    </Show>
    <Show when={props.phase === "pulling" || props.phase === "pushing"}>
      <Loader2 class="ui-icon-sm animate-spin" />
    </Show>
    <Show when={props.phase === "conflict"}>
      <AlertTriangle class="ui-icon-sm" />
    </Show>
    <Show when={props.phase === "error"}>
      <X class="ui-icon-sm" />
    </Show>
    <Show when={false}>
      <Check class="ui-icon-sm" />
    </Show>
  </>
);

function labelFor(phase: SyncPhase, conflicts: number): string {
  if (conflicts > 0) return `${conflicts} conflict${conflicts === 1 ? "" : "s"}`;
  switch (phase) {
    case "pulling":
      return "Pulling…";
    case "pushing":
      return "Pushing…";
    case "error":
      return "Sync error";
    case "conflict":
      return "Conflict";
    case "idle":
    default:
      return "Synced";
  }
}
