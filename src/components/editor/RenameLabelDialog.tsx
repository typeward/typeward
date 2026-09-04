import type { Component } from "solid-js";
import { createEffect, createSignal, on, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { requestRenameLabel_ } from "~/commands/palette-store";
import { project } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { labelKeyAtCursor } from "~/lib/label-key";
import { renameLabelWorkflow } from "~/lib/rename-label";
import * as ipc from "~/ipc";
import { notifyError, notifyInfo, notifySuccess } from "~/lib/toast";
import { describeIpcError } from "~/lib/errors";

/**
 * Project-wide `\label` rename. Mounted once at the App root; opened by the
 * `latex.renameLabel` command via the `requestRenameLabel` signal. Reads the key
 * under the cursor, shows the reference count, and drives the safe rename
 * workflow (save dirty -> rewrite on disk -> reload open buffers -> reindex).
 */
export const RenameLabelDialog: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [key, setKey] = createSignal("");
  const [name, setName] = createSignal("");
  const [summary, setSummary] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let inputRef: HTMLInputElement | undefined;

  createEffect(
    on(
      requestRenameLabel_,
      (nonce) => {
        if (!nonce) return;
        const p = project();
        const view = getActiveEditorView();
        if (!p || !view) {
          notifyInfo("Open a LaTeX file to rename a label.");
          return;
        }
        const doc = view.state.doc.toString();
        const k = labelKeyAtCursor(doc, view.state.selection.main.head);
        if (!k) {
          notifyInfo("Place the cursor on a \\label or \\ref to rename it.");
          return;
        }
        setKey(k);
        setName(k);
        setError(null);
        setBusy(false);
        setSummary("Scanning references…");
        setOpen(true);
        // rAF, not queueMicrotask: this command is usually run from the command
        // palette, whose close-handler restores focus to the editor
        // synchronously — focusing the input a frame later wins that race.
        requestAnimationFrame(() => {
          inputRef?.focus();
          inputRef?.select();
        });
        void ipc
          .findProjectReferences(p.rootPath, k)
          .then((refs) => {
            const files = new Set(refs.map((r) => r.file)).size;
            setSummary(
              `${refs.length} occurrence${refs.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`,
            );
          })
          .catch(() => setSummary(""));
      },
      // NOT deferred: the dialog is lazily mounted only once the rename nonce
      // first goes > 0, so the effect must fire on that mounting value (a
      // defer would skip the very invocation that mounted it).
    ),
  );

  const submit = async () => {
    const p = project();
    if (!p || busy()) return;
    const newKey = name().trim();
    if (!newKey) {
      setError("Enter a new label key.");
      return;
    }
    if (newKey === key()) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await renameLabelWorkflow(p.rootPath, key(), newKey);
      notifySuccess(
        `Renamed "${key()}" to "${newKey}" across ${result.filesChanged.length} file${
          result.filesChanged.length === 1 ? "" : "s"
        }.`,
      );
      setOpen(false);
    } catch (e) {
      setError(describeIpcError(e));
      notifyError("Couldn't rename the label", describeIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open()}
      onOpenChange={setOpen}
      title="Rename label"
      widthClass="w-[440px]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy()}
            onClick={() => void submit()}
          >
            Rename
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-2">
        <p class="text-xs text-fg-2">
          Renaming <span class="font-mono text-fg-1">{key()}</span>
          <Show when={summary()}> ({summary()})</Show>
        </p>
        <input
          ref={inputRef}
          type="text"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="new label key"
          aria-invalid={error() !== null}
          class="glass-inset w-full rounded-md px-2.5 py-2 text-sm text-fg-1 placeholder:text-fg-2 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-1)]"
        />
        <Show when={error()}>
          <div role="alert" class="text-xs" style={{ color: "var(--color-err)" }}>
            {error()}
          </div>
        </Show>
      </div>
    </Dialog>
  );
};
