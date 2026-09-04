/**
 * TopBar sync status indicator. Aggregates per-(provider, project)
 * sync states from the engine's status store and surfaces one pill with
 * the worst current phase (conflict > error > disconnected > offline >
 * pulling/pushing > idle).
 *
 * Hidden entirely when no cloud-backed projects are currently being
 * tracked, so users without cloud sync see no chrome. A cloud-bound project
 * whose engine can't start still registers a "disconnected" entry — the
 * badge must never vanish while the user believes syncing is on.
 */

import { useLocation, useNavigate } from "@solidjs/router";
import { AlertTriangle, Check, Cloud, CloudOff, Loader2, X } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createEffect, createMemo, createSignal, on } from "solid-js";

import { notifyError } from "~/components/feedback/Toaster";
import { allSyncStatuses, conflictResolverIntent } from "~/integrations/cloud/core";
import type { SyncPhase } from "~/integrations/types";
import { setPreviousRoute, setSettingsSectionIntent } from "~/stores/nav-store";

import { ConflictResolverDialog } from "./ConflictResolverDialog";

const PHASE_RANK: Record<SyncPhase, number> = {
  conflict: 6,
  error: 5,
  disconnected: 4,
  offline: 3,
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
  const navigate = useNavigate();
  const location = useLocation();

  // The engine's conflict toast carries a Resolve action; it raises this
  // intent instead of importing the dialog (engine code stays component-free).
  createEffect(
    on(
      conflictResolverIntent,
      (gen) => {
        if (gen > 0) setResolverOpen(true);
      },
      { defer: true },
    ),
  );

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

  const clickable = (agg: Aggregated): boolean =>
    agg.conflicts > 0 || agg.phase === "error" || agg.phase === "disconnected";

  return (
    <>
      <Show when={aggregate()}>
        {(agg) => (
          <button
            type="button"
            class="lift flex items-center gap-1.5 rounded-md px-2 py-1 text-xs disabled:cursor-default"
            disabled={!clickable(agg())}
            onClick={() => {
              if (agg().conflicts > 0) setResolverOpen(true);
              else if (agg().phase === "disconnected") {
                // Reconnecting happens in Settings → Cloud storage; deep-link
                // there the same way the sidebar plan pill does.
                setPreviousRoute(location.pathname);
                setSettingsSectionIntent("int-cloud");
                navigate("/settings");
              } else if (agg().phase === "error")
                notifyError("Sync error", agg().message ?? "A cloud sync operation failed.");
            }}
            style={{
              background:
                agg().phase === "conflict" || agg().phase === "error"
                  ? "color-mix(in srgb, var(--color-err) 14%, transparent)"
                  : agg().phase === "disconnected"
                    ? "color-mix(in srgb, var(--color-warn) 14%, transparent)"
                    : agg().phase === "pulling" || agg().phase === "pushing"
                      ? "color-mix(in srgb, var(--color-accent-1) 14%, transparent)"
                      : "var(--color-control-fill)",
              color:
                agg().phase === "conflict" || agg().phase === "error"
                  ? "var(--color-err)"
                  : agg().phase === "disconnected"
                    ? "var(--color-warn)"
                    : agg().phase === "pulling" || agg().phase === "pushing"
                      ? "var(--color-accent-1)"
                      : "var(--color-fg-2)",
            }}
            title={
              agg().conflicts > 0
                ? `${agg().conflicts} unresolved conflict${agg().conflicts === 1 ? "" : "s"} (click to resolve)`
                : agg().phase === "error"
                  ? `${agg().message ?? "Sync error"} (click for details)`
                  : agg().phase === "disconnected"
                    ? `${agg().message ?? "Sync is off"} (click to open Settings)`
                    : agg().phase === "offline"
                      ? `${agg().message ?? "Can't reach the cloud"} (retrying automatically)`
                      : `${agg().count} cloud-backed project${agg().count === 1 ? "" : "s"}`
            }
          >
            <PhaseIcon phase={agg().phase} />
            {/* Not a live region: the poll loop flips pulling/idle every
               minute, which would spam screen readers indefinitely. */}
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
    <Show when={props.phase === "offline" || props.phase === "disconnected"}>
      <CloudOff class="ui-icon-sm" />
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
    case "offline":
      return "Offline, will retry";
    case "disconnected":
      return "Sync off";
    case "conflict":
      return "Conflict";
    case "idle":
    default:
      return "Synced";
  }
}
