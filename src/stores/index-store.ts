import { createSignal } from "solid-js";
import * as ipc from "~/ipc";
import type { IndexEntry, ProjectIndexResult } from "~/ipc";
import { recordError } from "~/lib/telemetry";

/**
 * Frontend mirror of the Rust project index (labels + citation keys scanned
 * from disk). This is the SAVED-files half; the active buffer's own labels are
 * overlaid at query time by the completion source, so a just-typed `\label`
 * completes before any reindex. Refreshed on project open and coalesced
 * watcher events; the completion source reads it synchronously (no IPC on the
 * keystroke path — that latency is the whole point of the local index).
 */

const EMPTY: ProjectIndexResult = { labels: [], citations: [], truncated: false };

const [projectIndex, setProjectIndex] = createSignal<ProjectIndexResult>(EMPTY);
const [indexRoot, setIndexRoot] = createSignal<string | null>(null);

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let queued = false;

/** Labels for the active project (may be stale by one watcher-debounce cycle). */
export const indexLabels = (): IndexEntry[] => projectIndex().labels;
/** Citation keys for the active project. */
export const indexCitations = (): IndexEntry[] => projectIndex().citations;
export const indexTruncated = (): boolean => projectIndex().truncated;

async function runRefresh(root: string, refresh: boolean): Promise<void> {
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  try {
    const result = await ipc.indexProject(root, refresh);
    // Drop a result that landed after the project switched away.
    if (indexRoot() === root) setProjectIndex(result);
  } catch (e) {
    recordError("project-index", "failed to index project labels/citations", e);
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      void runRefresh(root, true);
    }
  }
}

/** Called on project open — loads (cached-or-scanned) index for `root`. */
export function loadProjectIndex(root: string): void {
  setIndexRoot(root);
  setProjectIndex(EMPTY);
  void runRefresh(root, false);
}

/** Called on project close — clears the store and the Rust cache. */
export function clearProjectIndex(): void {
  const root = indexRoot();
  setIndexRoot(null);
  setProjectIndex(EMPTY);
  if (refreshTimer) clearTimeout(refreshTimer);
  if (root) void ipc.unindexProject(root).catch(() => {});
}

/**
 * Called on a watcher event for the active project — debounced rescan. The
 * Rust watcher already coalesces bursts to ~150ms–1s; this second debounce
 * keeps a stream of saves from queuing a rescan per file.
 */
export function noteProjectFilesChanged(): void {
  const root = indexRoot();
  if (!root) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void runRefresh(root, true), 400);
}
