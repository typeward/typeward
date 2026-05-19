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

    createEffect(
      on(
        () => {
          const f = activeFile();
          const p = project();
          return f && p
            ? { rootPath: p.rootPath, relPath: f.relPath, content: f.content, dirty: f.dirty }
            : null;
        },
        async (state) => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (!state) return;

          // File just became clean (saved) — drop the snapshot.
          if (!state.dirty) {
            try {
              await ipc.clearSnapshot(state.rootPath, state.relPath);
              lastSavedSnapshot = "";
            } catch {
              /* non-Tauri / no permissions; harmless */
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
