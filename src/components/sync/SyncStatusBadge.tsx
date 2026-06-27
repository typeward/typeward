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
import { Show, createMemo, createSignal } from "solid-js";

import { notifyError } from "~/components/feedback/Toaster";
import { allSyncStatuses } from "~/integrations/cloud/core";
import type { SyncPhase } from "~/integrations/types";

import { ConflictResolverDialog } from "./ConflictResolverDialog";

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
  /** Free-form detail from the worst status, surfaced on error click. */
  message?: string;
}

export const SyncStatusBadge: Component = () => {
  const [resolverOpen, setResolverOpen] = createSignal(false);

  const aggregate = createMemo<Aggregated | null>(() => {
    const all = Array.from(allSyncStatuses().values());
    if (all.length === 0) return null;
    let worst: SyncPhase = "idle";
    let conflicts = 0;
    for (const s of all) {
      if (PHASE_RANK[s.phase] > PHASE_RANK[worst]) worst = s.phase;
      conflicts += s.conflicts.length;
    }
    const message = all.find((s) => s.phase === worst && s.message)?.message;
    return { phase: worst, count: all.length, conflicts, message };
  });

  return (
    <>
      <Show when={aggregate()}>
        {(agg) => (
          <button
            type="button"
            class="lift flex items-center gap-1.5 rounded-md px-2 py-1 text-[length:var(--ui-font-xs)] disabled:cursor-default"
            disabled={agg().conflicts === 0 && agg().phase !== "error"}
            onClick={() => {
              if (agg().conflicts > 0) setResolverOpen(true);
              else if (agg().phase === "error")
                notifyError("Sync error", agg().message ?? "A cloud sync operation failed.");
            }}
            style={{
              background: agg().phase === "idle"
                ? "var(--color-control-fill)"
                : agg().phase === "conflict" || agg().phase === "error"
                  ? "color-mix(in srgb, var(--color-err) 14%, transparent)"
                  : "color-mix(in srgb, var(--color-accent-1) 14%, transparent)",
              color: agg().phase === "idle"
                ? "var(--color-fg-2)"
                : agg().phase === "conflict" || agg().phase === "error"
                  ? "var(--color-err)"
                  : "var(--color-accent-1)",
            }}
            title={
              agg().conflicts > 0
                ? `${agg().conflicts} unresolved conflict${agg().conflicts === 1 ? "" : "s"} — click to resolve`
                : agg().phase === "error"
                  ? `${agg().message ?? "Sync error"} — click for details`
                  : `${agg().count} cloud-backed project${agg().count === 1 ? "" : "s"}`
            }
          >
            <PhaseIcon phase={agg().phase} />
            <span>{labelFor(agg().phase, agg().conflicts)}</span>
          </button>
        )}
      </Show>
      <ConflictResolverDialog open={resolverOpen()} onOpenChange={setResolverOpen} />
    </>
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
