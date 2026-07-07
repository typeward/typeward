/**
 * App-wide mirror of Harper grammar diagnostics, keyed by file path.
 *
 * Each editor lint pass (`src/lib/grammar/cm6.ts`) writes its raw results here
 * so surfaces outside the editor — the Logs panel's Grammar tab — can read a
 * consolidated, cross-file view without re-running the check. The editor's
 * `@codemirror/lint` state stays the source of truth for in-buffer squiggles;
 * this store is a read model for everything else.
 *
 * The shape is frozen (a later Logs-panel feature depends on it): file entries
 * carry `updatedAt` so a stale pass can be reasoned about, and
 * `grammarTotalCount()` sums across files for a badge.
 */

import { createSignal } from "solid-js";
import type * as ipc from "~/ipc";

export interface GrammarFileDiagnostics {
  file: string;
  updatedAt: number;
  items: ipc.GrammarDiagnostic[];
}

const [diagnostics, setDiagnostics] = createSignal<
  ReadonlyMap<string, GrammarFileDiagnostics>
>(new Map());

export function grammarDiagnostics(): ReadonlyMap<string, GrammarFileDiagnostics> {
  return diagnostics();
}

export function setGrammarFileDiagnostics(
  file: string,
  items: ipc.GrammarDiagnostic[],
): void {
  const next = new Map(diagnostics());
  if (items.length === 0) {
    if (!next.has(file)) return;
    next.delete(file);
  } else {
    next.set(file, { file, updatedAt: Date.now(), items });
  }
  setDiagnostics(next);
}

export function clearGrammarDiagnostics(): void {
  if (diagnostics().size === 0) return;
  setDiagnostics(new Map());
}

export function grammarTotalCount(): number {
  let total = 0;
  for (const entry of diagnostics().values()) total += entry.items.length;
  return total;
}
