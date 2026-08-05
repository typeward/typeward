import { History as HistoryIcon, RotateCcw, Trash2 } from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
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
import { adoptDiskContent, openFiles, project } from "~/stores/editor-store";
import { mountHistoryDiff } from "./history-diff";

/**
 * Project history (the top-bar HistoryMenu popover): every recorded version
 * across the whole project, newest first, grouped under local-calendar-day
 * headers with a per-entry time and change summary. Each entry opens as a
 * read-only diff against the file's current state with a Restore action.
 * Versions are recorded on save by the Rust store (history.rs) — at most one
 * per file per five minutes — and restore always snapshots the state it
 * overwrites, so nothing here is destructive.
 */
export const HistoryPanel: Component = () => {
  // Bumped after restore/clear so the resource refetches without a remount.
  const [historyGen, setHistoryGen] = createSignal(0);
  const [selected, setSelected] = createSignal<ipc.ProjectHistoryVersion | null>(null);
  const [busy, setBusy] = createSignal(false);

  const [versions] = createResource(
    () => {
      const p = project();
      return p ? { root: p.rootPath, gen: historyGen() } : null;
    },
    async (src) => {
      try {
        return await ipc.historyListProject(src.root);
      } catch (e) {
        recordError("history-list", "history_list_project failed", e);
        return [] as ipc.ProjectHistoryVersion[];
      }
    },
    { initialValue: [] },
  );

  // Per-entry change summaries. The list is newest-first, so within a file
  // the next entry is the version this one replaced. The store records bytes,
  // not lines — a summary states only size facts, never a line count.
  const summaries = createMemo(() => {
    const byFile = new Map<string, ipc.ProjectHistoryVersion[]>();
    for (const v of versions()) {
      const arr = byFile.get(v.relPath);
      if (arr) arr.push(v);
      else byFile.set(v.relPath, [v]);
    }
    const out = new Map<ipc.ProjectHistoryVersion, string>();
    for (const arr of byFile.values()) {
      for (let i = 0; i < arr.length; i++) {
        out.set(
          arr[i],
          i + 1 < arr.length ? sizeDelta(arr[i].size - arr[i + 1].size) : "first version",
        );
      }
    }
    return out;
  });

  // Fold into day groups. The list order (newest first) is preserved, so a
  // break on the local calendar day is enough.
  const groups = createMemo(() => {
    const out: { label: string; items: ipc.ProjectHistoryVersion[] }[] = [];
    let dayKey = "";
    for (const v of versions()) {
      const day = new Date(v.ts).toDateString();
      if (day !== dayKey) {
        dayKey = day;
        out.push({ label: dayLabel(v.ts), items: [] });
      }
      out[out.length - 1].items.push(v);
    }
    return out;
  });

  /** The version's file, when it's open in a tab (buffer beats disk). */
  const openBuffer = (relPath: string) =>
    openFiles().find((f) => f.relPath === relPath);

  const [versionContent] = createResource(
    () => {
      const p = project();
      const v = selected();
      return p && v ? { root: p.rootPath, rel: v.relPath, hash: v.hash } : null;
    },
    (src) => ipc.historyReadVersion(src.root, src.rel, src.hash),
  );

  // Current state of the selected version's file — the open buffer when the
  // file has a tab, else its on-disk content (versions of files that aren't
  // open must still diff correctly).
  const [currentContent] = createResource(
    () => {
      const p = project();
      const v = selected();
      return p && v ? { root: p.rootPath, rel: v.relPath } : null;
    },
    async (src) => {
      const buf = openBuffer(src.rel);
      if (buf) return buf.content;
      try {
        return await ipc.readProjectTextFile(src.root, src.rel);
      } catch {
        // Deleted/renamed since the version was recorded — diff vs nothing.
        return "";
      }
    },
  );

  const restore = async (version: ipc.ProjectHistoryVersion) => {
    const p = project();
    if (!p || busy()) return;
    setBusy(true);
    try {
      // A dirty open buffer is saved first so the pre-restore state lands on
      // disk — the Rust restore then force-records exactly that state before
      // overwriting it. Files without a tab are already at their disk state.
      const buf = openBuffer(version.relPath);
      if (buf?.dirty) await saveOpenFile(p, buf);
      const restored = await ipc.historyRestore(p.rootPath, version.relPath, version.hash);
      // Store-level replace for an open tab (never a CM dispatch swap):
      // content, clean flag, and a recomputed base hash so the save conflict
      // guard doesn't misfire. The bumped adopt generation remounts the keyed
      // editor on the restored content.
      if (buf) adoptDiskContent(buf.path, restored, await sha256Hex(restored));
      // The restore wrote to disk outside the save funnel — queue the cloud
      // push like every save path, or other devices keep the pre-restore
      // content and interim remote edits mint spurious conflict sidecars.
      notifyLocalSave(p.rootPath, [version.relPath]);
      setSelected(null);
      setHistoryGen((n) => n + 1);
      notifySuccess(
        "Version restored",
        `"${version.relPath}" now holds the version from ${formatWhen(version.ts)}. The replaced state was kept in history.`,
      );
    } catch (e) {
      notifyError("Couldn't restore version", describeIpcError(e));
      recordError("history-restore", `history_restore failed for ${version.relPath}`, e);
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
        { title: "Clear project history", kind: "warning", okLabel: "Clear all history", cancelLabel: "Cancel" },
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
        <span>Project history</span>
        <Show when={versions().length > 0}>
          <button
            type="button"
            title="Clear project history…"
            aria-label="Clear project history…"
            onClick={() => void clearHistory()}
            class="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
          >
            <Trash2 class="ui-icon-menu" style={{ opacity: 0.8 }} />
          </button>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto scroll px-2 pb-2">
        <Show
          when={versions().length > 0}
          fallback={
            <EmptyState text="No versions yet. Typeward records one automatically on save — at most one per file every five minutes." />
          }
        >
          <For each={groups()}>
            {(group) => (
              <>
                <div
                  class="label-xs sticky top-0 z-10 px-1.5 pb-1 pt-2 text-fg-3"
                  style={{ background: "var(--color-popover-bg)" }}
                >
                  {group.label}
                </div>
                <ul class="flex flex-col gap-1">
                  <For each={group.items}>
                    {(v) => (
                      <li>
                        <button
                          type="button"
                          onClick={() => setSelected(v)}
                          title={`${formatWhen(v.ts)} · ${formatSize(v.size)}`}
                          class="lift glass-soft flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[var(--color-control-fill)]"
                        >
                          <HistoryIcon size={12} class="flex-shrink-0 text-fg-3" />
                          <span class="min-w-0 flex-1">
                            <span class="mono block truncate text-sm text-fg-1">
                              {v.relPath}
                            </span>
                            <span class="block text-xs text-fg-3">
                              {formatTime(v.ts)} · {summaries().get(v)}
                            </span>
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </>
            )}
          </For>
        </Show>
      </div>

      {/* Diff-and-restore dialog for the selected version. The diff shows the
          recorded version as the base and the file's current state as the
          target, so additions since that version read as insertions. */}
      <Dialog
        open={selected() !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Restore this version?"
        description={
          selected()
            ? `"${selected()!.relPath}" from ${formatWhen(selected()!.ts)} (${formatSize(selected()!.size)}) compared against the current state.`
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
            when={versionContent() !== undefined && currentContent() !== undefined}
            fallback={<div class="text-sm text-fg-3">Loading version…</div>}
          >
            <HistoryDiff original={versionContent()!} current={currentContent() ?? ""} />
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

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayLabel(ms: number): string {
  const day = new Date(ms);
  const now = new Date();
  if (day.toDateString() === now.toDateString()) return "Today";
  if (day.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) {
    return "Yesterday";
  }
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  };
  if (day.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return day.toLocaleDateString(undefined, opts);
}

function sizeDelta(d: number): string {
  if (d === 0) return "edited, size unchanged";
  return d > 0 ? `+${formatSize(d)}` : `-${formatSize(-d)}`;
}
