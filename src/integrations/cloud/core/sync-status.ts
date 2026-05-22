/**
 * Per-project sync status — feeds the TopBar badge and the
 * SyncDetailDrawer. One status per (provider, project) pair so multiple
 * cloud-backed projects can show concurrent state.
 */

import { createSignal } from "solid-js";

import type { SyncPhase, SyncStatus } from "~/integrations/types";

const DEFAULT_STATUS: SyncStatus = {
  phase: "idle",
  conflicts: [],
};

const [statuses, setStatuses] = createSignal<ReadonlyMap<string, SyncStatus>>(new Map());

function key(providerId: string, projectId: string): string {
  return `${providerId}::${projectId}`;
}

export function getSyncStatus(providerId: string, projectId: string): SyncStatus {
  return statuses().get(key(providerId, projectId)) ?? DEFAULT_STATUS;
}

export function setSyncPhase(
  providerId: string,
  projectId: string,
  phase: SyncPhase,
  message?: string,
): void {
  setStatuses((m) => {
    const next = new Map(m);
    const prev = next.get(key(providerId, projectId)) ?? DEFAULT_STATUS;
    next.set(key(providerId, projectId), {
      ...prev,
      phase,
      message,
      lastSyncAt: phase === "idle" ? Date.now() : prev.lastSyncAt,
    });
    return next;
  });
}

export function recordConflicts(
  providerId: string,
  projectId: string,
  conflicts: string[],
): void {
  setStatuses((m) => {
    const next = new Map(m);
    const prev = next.get(key(providerId, projectId)) ?? DEFAULT_STATUS;
    next.set(key(providerId, projectId), {
      ...prev,
      phase: conflicts.length > 0 ? "conflict" : prev.phase,
      conflicts,
    });
    return next;
  });
}

export function clearSyncStatus(providerId: string, projectId: string): void {
  setStatuses((m) => {
    const next = new Map(m);
    next.delete(key(providerId, projectId));
    return next;
  });
}

/** Reactive accessor for surfaces that need to react to any project's status. */
export const allSyncStatuses = statuses;
