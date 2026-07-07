/**
 * Tiny indirection that lets the format adapters trigger the compile / forward-
 * search orchestration (owned by commands/actions) WITHOUT importing it.
 *
 * actions imports the adapters (for adapterFor), so a direct back-import from an
 * adapter to actions — static or dynamic — forms a module cycle. actions injects
 * its runners here once at load; the adapters read them through this leaf module,
 * keeping the dependency graph one-way (adapters -> this leaf; actions -> this
 * leaf + adapters).
 */
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
