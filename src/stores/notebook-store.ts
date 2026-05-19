import { createEffect, createRoot, createSignal } from "solid-js";
import type { Cell } from "~/lib/notebook/parser";
import { parseNotebook, serializeNotebook } from "~/lib/notebook/parser";
import { activeFile, project, updateActiveFile } from "~/stores/editor-store";

/**
 * Notebook cells store. The canonical source of truth for an .Rmd file's
 * content is still `editor-store.activeFile.content` (a string) —
 * that keeps autosave, file-watcher reconciliation, and the regular save
 * path working unchanged. This store derives a `Cell[]` view of that
 * string when the active file is a notebook source, and pushes edits
 * back to `updateActiveFile` so the string and the cell list stay in
 * lockstep.
 *
 * The feedback-loop guard: `lastSyncedContent` records what we last wrote
 * to (or read from) `activeFile.content`. The reactive parse skips when
 * the new content matches — that prevents the "edit cell → serialize →
 * activeFile.content changes → re-parse → cell ids churn → editor loses
 * focus" cycle.
 */

const [cells, setCells] = createSignal<Cell[]>([]);
const [activeCellId, setActiveCellId] = createSignal<string | null>(null);

let lastSyncedContent: string | null = null;
let lastSyncedPath: string | null = null;

const isNotebookFile = (relPath: string): boolean => {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".rmd");
};

const isNotebookProject = (format: string): boolean => format === "rmarkdown";

// Module-level effect: re-parse on file path change or external content
// change. Wrapped in createRoot so it lives for the page's lifetime.
createRoot(() => {
  createEffect(() => {
    const f = activeFile();
    const p = project();
    if (!f || !p || !isNotebookProject(p.format) || !isNotebookFile(f.relPath)) {
      if (cells().length > 0) setCells([]);
      lastSyncedContent = null;
      lastSyncedPath = null;
      return;
    }
    if (f.path === lastSyncedPath && f.content === lastSyncedContent) return;
    const pathChanged = f.path !== lastSyncedPath;
    const parsed = parseNotebook(f.content);
    setCells(parsed);
    lastSyncedContent = f.content;
    lastSyncedPath = f.path;
    // Default focus to the first cell on a fresh file load.
    if (pathChanged || activeCellId() === null) {
      setActiveCellId(parsed[0]?.id ?? null);
    }
  });
});

const applyCellUpdate = (next: Cell[]) => {
  setCells(next);
  const serialized = serializeNotebook(next);
  lastSyncedContent = serialized;
  updateActiveFile({ content: serialized, dirty: true });
};

export const updateCellContent = (id: string, content: string): void => {
  const list = cells();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const existing = list[idx];
  if (existing.content === content) return;
  const next = list.slice();
  next[idx] = { ...existing, content } as Cell;
  applyCellUpdate(next);
};

export const addCellAfter = (afterId: string | null, cell: Cell): void => {
  const list = cells();
  if (!afterId) {
    applyCellUpdate([...list, cell]);
    setActiveCellId(cell.id);
    return;
  }
  const idx = list.findIndex((c) => c.id === afterId);
  if (idx < 0) {
    applyCellUpdate([...list, cell]);
  } else {
    applyCellUpdate([...list.slice(0, idx + 1), cell, ...list.slice(idx + 1)]);
  }
  setActiveCellId(cell.id);
};

export const deleteCell = (id: string): void => {
  const list = cells();
  if (list.length <= 1) return; // keep at least one cell
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const next = list.filter((c) => c.id !== id);
  applyCellUpdate(next);
  // Move focus to the sibling that took the deleted cell's slot.
  const fallback = next[Math.min(idx, next.length - 1)];
  if (fallback) setActiveCellId(fallback.id);
};

export const moveCell = (id: string, direction: "up" | "down"): void => {
  const list = cells();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const target = direction === "up" ? idx - 1 : idx + 1;
  if (target < 0 || target >= list.length) return;
  const next = list.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  applyCellUpdate(next);
};

export const changeCellLanguage = (id: string, language: string): void => {
  const list = cells();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0 || list[idx].kind !== "code") return;
  const next = list.slice();
  next[idx] = { ...(list[idx] as Cell & { kind: "code" }), language: language.toLowerCase() };
  applyCellUpdate(next);
};

export { activeCellId, cells, setActiveCellId };
