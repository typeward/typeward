import { createSignal } from "solid-js";
import type { CellRunResult } from "~/ipc";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";
import { cells } from "~/stores/notebook-store";
import { project } from "~/stores/editor-store";

/**
 * Per-cell execution state + outputs. The Rust `run_r_chunk` command is
 * backed by a persistent R kernel per project, so variables defined in
 * cell N survive into cell N+1. Use `restartRKernel()` (Settings header)
 * to drop state.
 *
 * `outputs` is keyed by cell id, not cell index, because cell reorders /
 * deletions in the notebook-store don't invalidate run history we still
 * want to show.
 *
 * `running` is a small set rather than a single id because Run All
 * iterates sequentially and we want the active cell's spinner to glow
 * without blocking the user from inspecting earlier cells.
 */

const [outputs, setOutputs] = createSignal<Record<string, CellRunResult>>({});
const [runningIds, setRunningIds] = createSignal<ReadonlySet<string>>(new Set());

const markRunning = (id: string, running: boolean) => {
  setRunningIds((prev) => {
    if (running && prev.has(id)) return prev;
    if (!running && !prev.has(id)) return prev;
    const next = new Set(prev);
    if (running) next.add(id);
    else next.delete(id);
    return next;
  });
};

/**
 * Execute one code cell. Markdown / metadata cells are ignored (the
 * caller is responsible for filtering, but we double-check to keep
 * misuse from spawning Rscript on YAML).
 */
export async function runCellById(cellId: string): Promise<void> {
  const p = project();
  if (!p) return;
  const cell = cells().find((c) => c.id === cellId);
  if (!cell || cell.kind !== "code") return;

  // Today only R cells run. Non-R code cells get a stub message so the
  // user sees we acknowledged the click without silently doing nothing.
  if (cell.language !== "r") {
    setOutputs((prev) => ({
      ...prev,
      [cellId]: {
        ok: false,
        stdout: "",
        stderr: `Language "${cell.language}" doesn't have a per-cell runner yet. Use Render for the whole document.`,
        exitCode: -1,
        durationMs: 0,
      },
    }));
    return;
  }

  markRunning(cellId, true);
  try {
    const result = await ipc.runRChunk({
      projectRoot: p.rootPath,
      code: cell.content,
    });
    setOutputs((prev) => ({ ...prev, [cellId]: result }));
  } catch (e) {
    setOutputs((prev) => ({
      ...prev,
      [cellId]: {
        ok: false,
        stdout: "",
        stderr: String(e),
        exitCode: -1,
        durationMs: 0,
      },
    }));
    recordError("cell-run-failed", `runCellById threw for ${cellId}`, e);
  } finally {
    markRunning(cellId, false);
  }
}

/**
 * Sequentially run every code cell. Bails on the first failure so the
 * user isn't drowned in cascading errors from a broken upstream cell —
 * matches the behavior of `knitr::knit` with `error=FALSE`.
 */
export async function runAllCells(): Promise<void> {
  for (const cell of cells()) {
    if (cell.kind !== "code") continue;
    await runCellById(cell.id);
    const result = outputs()[cell.id];
    if (result && !result.ok) break;
  }
}

/** Clear the stored output for a cell (e.g. on delete). */
export const clearCellOutput = (cellId: string): void => {
  setOutputs((prev) => {
    if (!(cellId in prev)) return prev;
    const next = { ...prev };
    delete next[cellId];
    return next;
  });
};

/**
 * Drop the persistent R kernel for the active project, then wipe every
 * stored cell output so the notebook looks freshly opened. The next cell
 * run lazily respawns the kernel.
 */
export async function restartRKernel(): Promise<void> {
  const p = project();
  if (!p) return;
  try {
    await ipc.stopRKernel(p.rootPath);
  } catch (e) {
    recordError("kernel-stop-failed", "stopRKernel threw", e);
  }
  setOutputs({});
}

export { outputs, runningIds };
