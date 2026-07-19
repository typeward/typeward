import { createEffect, createRoot, on } from "solid-js";
import type { Project } from "~/adapters/types";
import { saveOpenFile } from "~/commands/actions";
import * as ipc from "~/ipc";
import { formatShortcutForDisplay } from "~/lib/shortcuts";
import { notifyError } from "~/lib/toast";
import { recordError } from "~/lib/telemetry";
import { activeFile, project, type OpenFile } from "~/stores/editor-store";
import { editorSettings } from "~/stores/settings-store";

/**
 * Debounced autosave. After an idle delay (the `autosaveDelayMs` setting,
 * default 500ms) the active file's pending edits are flushed:
 *
 *   - `autosaveEnabled` on (default): a real save to disk via `saveOpenFile`
 *     (conflict-guarded write + cloud push + auto-compile). The dirty→clean
 *     transition then clears any crash-recovery snapshot.
 *   - off: only a crash-recovery snapshot to
 *     `<project>/.typeward/snapshots/<rel>.snap`, cleared on the next manual save.
 *
 * Idempotent: a second call is a no-op. The createRoot keeps the effect alive
 * for the page's lifetime; installing twice would leak a second undisposable
 * root running duplicate writes.
 */
let _autosaveInstalled = false;
export function setupAutosave(): void {
  if (_autosaveInstalled) return;
  _autosaveInstalled = true;
  createRoot(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Per-file last-snapshotted content. A single shared string would let
    // file A's save clear the marker file B was compared against, and two
    // files with identical content would skip a needed snapshot.
    const lastSnapshotByFile = new Map<string, string>();
    // Files whose autosave has already toasted a failure this session, so a
    // full disk can't produce a toast on every idle tick.
    const toastedFailures = new Set<string>();
    type AutosaveState = {
      project: Project;
      file: OpenFile;
    };
    let prev: AutosaveState | null = null;

    const fileKey = (s: AutosaveState): string =>
      `${s.project.rootPath} ${s.file.relPath}`;

    const sameFile = (a: AutosaveState | null, b: AutosaveState | null): boolean =>
      !!a &&
      !!b &&
      a.project.rootPath === b.project.rootPath &&
      a.file.relPath === b.file.relPath;

    // Flush the pending edit: a real save when autosave is on, else a snapshot.
    const persist = async (s: AutosaveState): Promise<void> => {
      const key = fileKey(s);
      if (editorSettings().autosaveEnabled) {
        try {
          await saveOpenFile(s.project, s.file);
          // A real save left nothing to snapshot; drop any stale marker so a
          // later autosave-off toggle re-snapshots from a clean slate.
          lastSnapshotByFile.delete(key);
        } catch (e) {
          recordError("autosave-failed", `autosave of ${s.file.relPath} failed`, e);
          if (!toastedFailures.has(key)) {
            toastedFailures.add(key);
            notifyError(
              "Autosave failed",
              `Could not save "${s.file.relPath}". Save manually with ${formatShortcutForDisplay("Mod+S")}.`,
            );
          }
        }
        return;
      }
      try {
        await ipc.writeSnapshot(s.project.rootPath, s.file.relPath, s.file.content);
        lastSnapshotByFile.set(key, s.file.content);
      } catch {
        /* swallow; recovery UI surfaces this on next launch if needed */
      }
    };

    createEffect(
      on(
        (): AutosaveState | null => {
          const f = activeFile();
          const p = project();
          return f && p ? { project: p, file: f } : null;
        },
        async (state) => {
          const previous = prev;
          prev = state;

          if (timer) {
            clearTimeout(timer);
            timer = null;
            // Switching away from a dirty file mid-debounce: flush its pending
            // edit rather than dropping it, so edits in the last <500ms before a
            // tab switch survive (real save or snapshot per the setting).
            if (
              previous &&
              previous.file.dirty &&
              !sameFile(previous, state) &&
              previous.file.content !== lastSnapshotByFile.get(fileKey(previous))
            ) {
              await persist(previous);
            }
          }
          if (!state) return;

          // Clear the snapshot only on an actual dirty -> clean transition for
          // the SAME file (i.e. a real save). Merely activating an
          // already-clean file (e.g. the root file on project open) must NOT
          // delete its orphan snapshot — crash recovery still needs it.
          if (!state.file.dirty) {
            if (sameFile(previous, state) && previous?.file.dirty) {
              try {
                await ipc.clearSnapshot(state.project.rootPath, state.file.relPath);
                lastSnapshotByFile.delete(fileKey(state));
              } catch {
                /* non-Tauri / no permissions; harmless */
              }
            }
            return;
          }

          // Skip if content matches the last successful snapshot (avoid
          // rewriting the same bytes when other props change).
          if (state.file.content === lastSnapshotByFile.get(fileKey(state))) return;

          timer = setTimeout(() => {
            void persist(state);
          }, editorSettings().autosaveDelayMs);
        },
      ),
    );
  });
}
