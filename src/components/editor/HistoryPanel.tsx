import { History as HistoryIcon, RotateCcw, Trash2 } from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import * as ipc from "~/ipc";
import { saveOpenFile } from "~/commands/actions";
import { notifyLocalSave } from "~/integrations/cloud/init";
import { describeIpcError } from "~/lib/errors";
import { sha256Hex } from "~/lib/hash";
import { recordError } from "~/lib/telemetry";
import { notifyError, notifySuccess } from "~/lib/toast";
import { activeFile, adoptDiskContent, project } from "~/stores/editor-store";
import { mountHistoryDiff } from "./history-diff";

/**
 * Sidebar History tab: the active file's recorded versions (newest first),
 * each openable as a read-only diff against the current buffer with a Restore
 * action. Versions are recorded on save by the Rust store (history.rs) — at
 * most one per file per five minutes — and restore always snapshots the state
 * it overwrites, so nothing here is destructive.
 */
export const HistoryPanel: Component = () => {
  // Bumped after restore/clear so the resource refetches without a tab switch.
  const [historyGen, setHistoryGen] = createSignal(0);
  const [selected, setSelected] = createSignal<ipc.HistoryVersion | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [versions] = createResource(
    () => {
      const p = project();
      const f = activeFile();
      return p && f ? { root: p.rootPath, rel: f.relPath, gen: historyGen() } : null;
    },
    async (src) => {
      try {
        return await ipc.historyList(src.root, src.rel);
      } catch (e) {
        recordError("history-list", `history_list failed for ${src.rel}`, e);
        return [] as ipc.HistoryVersion[];
      }
    },
    { initialValue: [] },
  );

  // The selected version's content, for the diff. Failures surface inside the
  // dialog body rather than a toast so the list stays usable.
  const [versionContent] = createResource(
    () => {
      const p = project();
      const f = activeFile();
      const v = selected();
      return p && f && v ? { root: p.rootPath, rel: f.relPath, hash: v.hash } : null;
    },
    (src) => ipc.historyReadVersion(src.root, src.rel, src.hash),
  );

  const restore = async (version: ipc.HistoryVersion) => {
    const p = project();
    const f = activeFile();
    if (!p || !f || busy()) return;
    setBusy(true);
    try {
      // A dirty buffer is saved first so the pre-restore state lands on disk —
      // the Rust restore then force-records exactly that state before
      // overwriting it.
      if (f.dirty) await saveOpenFile(p, f);
      const restored = await ipc.historyRestore(p.rootPath, f.relPath, version.hash);
      // Store-level replace (never a CM dispatch swap): content, clean flag,
      // and a recomputed base hash so the save conflict guard doesn't misfire.
      // The bumped adopt generation remounts the keyed editor on the restored
      // content — without it the mounted CM doc stays stale and the next
      // keystroke + autosave would write the pre-restore text back to disk.
      adoptDiskContent(f.path, restored, await sha256Hex(restored));
      // The restore wrote to disk outside the save funnel — queue the cloud
      // push like every save path, or other devices keep the pre-restore
      // content and interim remote edits mint spurious conflict sidecars.
      notifyLocalSave(p.rootPath, [f.relPath]);
      setSelected(null);
      setHistoryGen((n) => n + 1);
      notifySuccess(
        "Version restored",
        `"${f.relPath}" now holds the version from ${formatWhen(version.ts)}. The replaced state was kept in history.`,
      );
    } catch (e) {
      notifyError("Couldn't restore version", describeIpcError(e));
      recordError("history-restore", `history_restore failed for ${f.relPath}`, e);
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    const p = project();
    if (!p || busy()) return;
    let proceed = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      proceed = await ask(
        `Delete every recorded version for "${p.name}"? Files on disk are untouched, but earlier states can no longer be restored.`,
        { title: "Clear project history", kind: "warning", okLabel: "Delete history", cancelLabel: "Keep" },
      );
    } catch {
      proceed = window.confirm("Delete every recorded version for this project?");
    }
    if (!proceed) return;
    setBusy(true);
    try {
      await ipc.historyClear(p.rootPath);
      setHistoryGen((n) => n + 1);
    } catch (e) {
      notifyError("Couldn't clear history", describeIpcError(e));
      recordError("history-clear", "history_clear failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="flex h-full flex-col">
      <div class="label-xs flex h-9 flex-shrink-0 items-center justify-between px-3 text-fg-3">
        <span>File history</span>
        <Show when={versions().length > 0}>
          <button
            type="button"
            title="Clear project history"
            aria-label="Clear project history"
            onClick={() => void clearHistory()}
            class="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
          >
            <Trash2 class="ui-icon-menu" style={{ opacity: 0.8 }} />
          </button>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto scroll px-2 pb-2">
        <Show when={activeFile()} fallback={<EmptyState text="Open a file to see its history." />}>
          <Show
            when={versions().length > 0}
            fallback={
              <EmptyState text="No versions yet. Typeward records one automatically on save — at most one per file every five minutes." />
            }
          >
            <ul class="flex flex-col gap-1">
              <For each={versions()}>
                {(v, i) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => setSelected(v)}
                      class="lift glass-soft flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--color-control-fill)]"
                    >
                      <HistoryIcon size={12} class="flex-shrink-0 text-fg-3" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm text-fg-1">{formatWhen(v.ts)}</span>
                        <span class="mono block text-xs text-fg-3">
                          {formatSize(v.size)}
                          <Show when={i() === 0}> · latest</Show>
                        </span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>

      {/* Diff-and-restore dialog for the selected version. The diff shows the
          recorded version as the base and the current buffer as the target,
          so additions since that version read as insertions. */}
      <Dialog
        open={selected() !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Restore this version?"
        description={
          selected()
            ? `"${activeFile()?.relPath ?? ""}" from ${formatWhen(selected()!.ts)} (${formatSize(selected()!.size)}) compared against the current buffer.`
            : ""
        }
        widthClass="w-[760px]"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy() || versionContent() === undefined}
              leadingIcon={<RotateCcw size={14} />}
              onClick={() => {
                const v = selected();
                if (v) void restore(v);
              }}
            >
              Restore this version
            </Button>
          </>
        }
      >
        <Show
          when={!versionContent.error}
          fallback={
            <div class="text-sm" style={{ color: "var(--color-err)" }}>
              {describeIpcError(versionContent.error)}
            </div>
          }
        >
          <Show
            when={versionContent() !== undefined}
            fallback={<div class="text-sm text-fg-3">Loading version…</div>}
          >
            <HistoryDiff original={versionContent()!} current={activeFile()?.content ?? ""} />
          </Show>
        </Show>
        <div class="mt-3 text-xs leading-relaxed text-fg-3">
          Restoring replaces the file on disk and in the editor. The current
          state is recorded in history first, so this cannot lose work.
        </div>
      </Dialog>
    </div>
  );
};

/** Async-mounted unified diff (the merge package loads on demand). */
const HistoryDiff: Component<{ original: string; current: string }> = (props) => {
  let el: HTMLDivElement | undefined;
  let destroy: (() => void) | null = null;
  let generation = 0;

  createEffect(() => {
    const original = props.original;
    const current = props.current;
    const gen = ++generation;
    destroy?.();
    destroy = null;
    if (!el) return;
    el.textContent = "";
    void mountHistoryDiff(el, original, current)
      .then((teardown) => {
        // A newer mount (or unmount) superseded this one while the chunk loaded.
        if (gen !== generation) teardown();
        else destroy = teardown;
      })
      .catch((e) => {
        recordError("history-diff", "mounting the history diff failed", e);
      });
  });
  onCleanup(() => {
    generation++;
    destroy?.();
    destroy = null;
  });

  return (
    <div
      ref={el}
      class="glass-inset overflow-auto scroll rounded-md"
      style={{ "max-height": "55vh", "min-height": "120px" }}
    />
  );
};

const EmptyState: Component<{ text: string }> = (props) => (
  <div class="px-2 py-3 text-sm leading-relaxed text-fg-3">{props.text}</div>
);

function formatWhen(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
