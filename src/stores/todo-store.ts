import { createEffect, createResource, createRoot, createSignal } from "solid-js";
import * as ipc from "~/ipc";
import { project } from "~/stores/editor-store";
import { fsVersion } from "~/stores/watcher-store";
import { openTodoThreadCount } from "~/stores/review-store";

/**
 * Scanned TODO/FIXME/NOTE markers for the active project (from the Rust
 * `scan_project_todos` IPC). Rescans on project switch and on a debounced
 * filesystem-version bump — saves/autosave already bump `fsVersion` through the
 * watcher, so no extra save hook is needed. Scans disk, not dirty buffers, so a
 * just-typed marker appears after the next save.
 */

const [debouncedFs, setDebouncedFs] = createSignal(0);

const todos = createRoot(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const v = fsVersion();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => setDebouncedFs(v), 500);
  });

  const [res] = createResource(
    () => {
      const p = project();
      return p ? ([p.rootPath, debouncedFs()] as const) : null;
    },
    async ([root]) => {
      try {
        // Tag with the root so a project switch can't surface the previous
        // project's markers during the in-flight rescan (createResource keeps
        // the last resolved value while refetching).
        return { root, items: await ipc.scanProjectTodos(root) };
      } catch {
        return { root, items: [] as ipc.TodoItem[] };
      }
    },
    { initialValue: { root: null as string | null, items: [] as ipc.TodoItem[] } },
  );
  return res;
});

export const scannedTodos = (): ipc.TodoItem[] => {
  const snapshot = todos();
  return snapshot && snapshot.root === project()?.rootPath ? snapshot.items : [];
};
export const todoCount = (): number =>
  scannedTodos().length + openTodoThreadCount();
