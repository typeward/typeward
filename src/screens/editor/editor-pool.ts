/**
 * Pure reducer logic for the editor view pool (see text-shell.tsx CenterPane).
 * The pool keeps several files' CodeMirror views mounted at once so a tab switch
 * to an already-open file is a display flip rather than a height-map rebuild.
 *
 * Extracted from the component so the invariants that keep it correct — one live
 * view per file PATH, FIFO eviction that never drops the active view, stable
 * insertion order (so a reveal never reshuffles the DOM) — are unit-tested
 * rather than only exercised by the live app.
 */

export interface PoolEntry {
  /** The full editorKey: `${path}::a${adopt}::${lsp}::${grammar}::${grammarLang}`. */
  key: string;
  /** Absolute file path — the supersession identity (at most one live view per path). */
  path: string;
  relPath: string;
}

/**
 * Make `entry` (identified by its editorKey) the active pooled view.
 *
 * - Already live (same key): returns `prev` UNCHANGED (same reference), so
 *   revealing a live view never reshuffles insertion order — the reveal stays a
 *   pure CSS display flip with no DOM move / re-measure.
 * - New key: supersedes any live entry for the SAME path first (an LSP attach /
 *   grammar toggle / adoptGeneration bump mints a new key for one path and must
 *   replace, not duplicate — two live views for one URI double-open it to the
 *   LSP and defeat the fresh-EditorState adopt guard), appends, then evicts the
 *   oldest NON-active entry until within `limit`.
 */
export function withActiveEntry(
  prev: PoolEntry[],
  entry: PoolEntry,
  limit: number,
): PoolEntry[] {
  if (prev.some((e) => e.key === entry.key)) return prev;
  const next = prev.filter((e) => e.path !== entry.path);
  next.push(entry);
  while (next.length > limit) {
    const victim = next.findIndex((e) => e.key !== entry.key);
    if (victim < 0) break; // only the active entry remains — never evict it
    next.splice(victim, 1);
  }
  return next;
}

/**
 * Drop entries whose file is no longer open (a closed tab). Returns `prev`
 * unchanged (same reference) when nothing was pruned, so the signal doesn't
 * churn on unrelated openFiles updates.
 */
export function prunePool(
  prev: PoolEntry[],
  openPaths: ReadonlySet<string>,
): PoolEntry[] {
  return prev.some((e) => !openPaths.has(e.path))
    ? prev.filter((e) => openPaths.has(e.path))
    : prev;
}
