import { createEffect, createRoot, on } from "solid-js";
import * as ipc from "~/ipc";
import { activeFile, project } from "~/stores/editor-store";

/**
 * Debounced autosave: whenever the active file is dirty, snapshot to
 * `<project>/.typeward/snapshots/<rel>.snap` after 500ms idle. On save
 * (dirty → clean), the snapshot is cleared.
 *
 * Idempotent: safe to call once at app boot. The createRoot keeps the
 * effect alive for the page's lifetime.
 */
export function setupAutosave(): void {
  createRoot(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSavedSnapshot = "";
    type AutosaveState = {
      rootPath: string;
      relPath: string;
      content: string;
      dirty: boolean;
    };
    let prev: AutosaveState | null = null;

    const sameFile = (a: AutosaveState | null, b: AutosaveState | null): boolean =>
      !!a && !!b && a.rootPath === b.rootPath && a.relPath === b.relPath;

    createEffect(
      on(
        (): AutosaveState | null => {
          const f = activeFile();
          const p = project();
          return f && p
            ? { rootPath: p.rootPath, relPath: f.relPath, content: f.content, dirty: f.dirty }
            : null;
        },
        async (state) => {
          const previous = prev;
          prev = state;

          if (timer) {
            clearTimeout(timer);
            timer = null;
            // Switching away from a dirty file mid-debounce: flush its pending
            // snapshot rather than dropping it, so edits in the last <500ms
            // before a tab switch survive a crash.
            if (
              previous &&
              previous.dirty &&
              !sameFile(previous, state) &&
              previous.content !== lastSavedSnapshot
            ) {
              try {
                await ipc.writeSnapshot(previous.rootPath, previous.relPath, previous.content);
              } catch {
                /* swallow; best-effort */
              }
            }
          }
          if (!state) return;

          // Clear the snapshot only on an actual dirty -> clean transition for
          // the SAME file (i.e. a real save). Merely activating an
          // already-clean file (e.g. the root file on project open) must NOT
          // delete its orphan snapshot — crash recovery still needs it.
          if (!state.dirty) {
            if (sameFile(previous, state) && previous?.dirty) {
              try {
                await ipc.clearSnapshot(state.rootPath, state.relPath);
                lastSavedSnapshot = "";
              } catch {
                /* non-Tauri / no permissions; harmless */
              }
            }
            return;
          }

          // Skip if content matches the last successful snapshot (avoid
          // rewriting the same bytes when other props change).
          if (state.content === lastSavedSnapshot) return;

          timer = setTimeout(async () => {
            try {
              await ipc.writeSnapshot(state.rootPath, state.relPath, state.content);
              lastSavedSnapshot = state.content;
            } catch {
              /* swallow; recovery UI surfaces this on next launch if needed */
            }
          }, 500);
        },
      ),
    );
  });
}
