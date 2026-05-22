/**
 * Conflict resolution helper for cloud sync.
 *
 * When a file changed on both sides since the last successful sync, the
 * engine picks the newer mtime as the winner and writes the loser to
 * `<name>.conflict-<ISO>.<ext>` next to the original. The user can then
 * inspect the loser via the ConflictResolverDialog (Phase 2.6).
 *
 * Rationale for newest-wins (vs a 3-way merge): we're dealing with
 * arbitrary binary + text files, and a wrong merge would silently
 * corrupt content. Preserving both copies keeps the user in control;
 * the .conflict-* suffix is a visible-in-FileTree breadcrumb.
 */

export interface ConflictDecision {
  /** Side whose content should land at the canonical path. */
  winner: "local" | "remote";
  /** Where to write the losing copy. Relative to the same parent as the original. */
  conflictPath: string;
}

export function decideConflict(
  relPath: string,
  localMtime: number,
  remoteMtime: number,
  now: number = Date.now(),
): ConflictDecision {
  const winner = localMtime >= remoteMtime ? "local" : "remote";
  return {
    winner,
    conflictPath: suffixWithConflict(relPath, now),
  };
}

/**
 * Insert `.conflict-<ISO>` before the extension.
 *
 *   "main.tex"          → "main.conflict-2026-05-22T18-30-00Z.tex"
 *   "fig/diagram.png"   → "fig/diagram.conflict-2026-05-22T18-30-00Z.png"
 *   "Makefile"          → "Makefile.conflict-2026-05-22T18-30-00Z"
 */
export function suffixWithConflict(relPath: string, atMs: number): string {
  const iso = new Date(atMs).toISOString().replace(/[:.]/g, "-");
  const lastSlash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return `${dir}${base}.conflict-${iso}`;
  }
  const stem = base.slice(0, dot);
  const ext = base.slice(dot);
  return `${dir}${stem}.conflict-${iso}${ext}`;
}
