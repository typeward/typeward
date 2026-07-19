/**
 * Tiny indirection that lets the format adapters trigger the compile / forward-
 * search orchestration (owned by commands/actions) WITHOUT importing it.
 *
 * actions imports the adapters (for adapterFor), so a direct back-import from an
 * adapter to actions — static or dynamic — forms a module cycle. actions injects
 * its runners here once at load; the adapters read them through this leaf module,
 * keeping the dependency graph one-way (adapters -> this leaf; actions -> this
 * leaf + adapters).
 *
 * This leaf also owns the in-flight compile id for the same reason: actions
 * mints it per attempt, the adapters attach it to the compile IPC, and the
 * cancel path targets it — none of which may re-import actions.
 */
import * as ipc from "~/ipc";

type Runner = () => Promise<void> | void;

let compile: Runner = () => {};
let syncForward: Runner = () => {};

export function setCompileRunners(runners: {
  compile: Runner;
  syncForward: Runner;
}): void {
  compile = runners.compile;
  syncForward = runners.syncForward;
}

export const runCompile = (): Promise<void> | void => compile();
export const runSyncForward = (): Promise<void> | void => syncForward();

// ----- Compile cancellation --------------------------------------------------

/**
 * Stable marker a cancelled `compile_latex`/`compile_typst` rejects with.
 * Mirrors `COMPILE_CANCELLED` in `src-tauri/src/compile.rs` (cross-referenced
 * there); commands reject with the plain Display string, so the rejection
 * message equals this constant verbatim. Lives here — not in `~/ipc` — so the
 * orchestration can compare against it even when tests mock the IPC module.
 */
export const COMPILE_CANCELLED = "compile-cancelled";

let activeCompileId: string | undefined;
let cancelledCompileId: string | undefined;

/** Mint and record the id for the compile attempt about to run. */
export function beginCompileAttempt(): string {
  activeCompileId = crypto.randomUUID();
  if (cancelledCompileId !== activeCompileId) cancelledCompileId = undefined;
  return activeCompileId;
}

/** Clear the recorded id once its attempt settles (id-checked so a stale
 *  settle can't clobber a newer attempt's handle). */
export function endCompileAttempt(id: string): void {
  if (activeCompileId === id) activeCompileId = undefined;
  if (cancelledCompileId === id) cancelledCompileId = undefined;
}

/** The in-flight compile id, for adapters to attach to the compile IPC. */
export const currentCompileId = (): string | undefined => activeCompileId;

/**
 * True when the given attempt was cancelled before its compile IPC started.
 * Rust only learns about an id when compile_latex/compile_typst begins, but
 * the Stop button is live from the moment compileState flips — a click during
 * the save phase or the shell-escape trust prompt would otherwise be lost.
 * The orchestration checks this between those steps and the IPC call.
 */
export const wasCancelledEarly = (id: string): boolean =>
  cancelledCompileId === id;

/**
 * Ask Rust to kill the in-flight compile's process tree. No-op when nothing
 * is running. The compile IPC itself then rejects with the stable
 * `COMPILE_CANCELLED` marker, which the orchestration maps back to idle.
 * Also records the id frontend-side for the pre-registration window (see
 * `wasCancelledEarly`) — Rust quietly ignores ids it never saw.
 */
export async function cancelCompile(): Promise<void> {
  const id = activeCompileId;
  if (id === undefined) return;
  cancelledCompileId = id;
  await ipc.compileCancel(id);
}
