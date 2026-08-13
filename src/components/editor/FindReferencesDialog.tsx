import type { Component } from "solid-js";
import { createEffect, createSignal, For, on, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { requestFindReferences_ } from "~/commands/palette-store";
import { project, requestGotoSource } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { labelKeyAtCursor } from "~/lib/label-key";
import * as ipc from "~/ipc";
import { notifyError, notifyInfo } from "~/lib/toast";
import { describeIpcError } from "~/lib/errors";

/**
 * List every occurrence of the `\label`/`\ref` key under the cursor across the
 * project (definition + uses), grouped by file; click a row to jump. Mounted
 * once at the App root behind its own request nonce; opened by
 * `latex.findReferences`. Read-only — reuses `find_project_references` and the
 * `requestGotoSource` navigation the inverse-search / go-to-def paths use.
 */
export const FindReferencesDialog: Component = () => {
  const [open, setOpen] = createSignal(false);
  const [key, setKey] = createSignal("");
  const [refs, setRefs] = createSignal<ipc.ReferenceHit[]>([]);
  const [loading, setLoading] = createSignal(false);

  createEffect(
    on(requestFindReferences_, (nonce) => {
      if (!nonce) return;
      const p = project();
      const view = getActiveEditorView();
      if (!p || !view) {
        notifyInfo("Open a LaTeX file to find references.");
        return;
      }
      const k = labelKeyAtCursor(view.state.doc.toString(), view.state.selection.main.head);
      if (!k) {
        notifyInfo("Place the cursor on a \\label or \\ref to find its references.");
        return;
      }
      setKey(k);
      setRefs([]);
      setLoading(true);
      setOpen(true);
      ipc
        .findProjectReferences(p.rootPath, k)
        .then((r) => setRefs(r))
        .catch((e) => notifyError("Couldn't find references", describeIpcError(e)))
        .finally(() => setLoading(false));
    }),
    // Not deferred — see RenameLabelDialog: the nonce that mounts this dialog is
    // the value the open effect must act on.
  );

  const grouped = (): Array<[string, ipc.ReferenceHit[]]> => {
    const byFile = new Map<string, ipc.ReferenceHit[]>();
    for (const r of refs()) {
      const arr = byFile.get(r.file) ?? [];
      arr.push(r);
      byFile.set(r.file, arr);
    }
    return [...byFile.entries()];
  };

  const jump = (r: ipc.ReferenceHit) => {
    requestGotoSource(r.file, r.line);
    setOpen(false);
  };

  return (
    <Dialog
      open={open()}
      onOpenChange={setOpen}
      title="References"
      widthClass="w-[560px]"
      footer={
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      }
    >
      <div class="flex flex-col gap-2">
        <p class="text-xs text-fg-2">
          <span class="font-mono text-fg-1">{key()}</span>
          <Show when={loading()}> — scanning…</Show>
          <Show when={!loading()}>
            {" "}
            — {refs().length} occurrence{refs().length === 1 ? "" : "s"} in{" "}
            {grouped().length} file{grouped().length === 1 ? "" : "s"}
          </Show>
        </p>
        <div class="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
          <For each={grouped()}>
            {([file, hits]) => (
              <div>
                <div class="label-xs px-1 pb-1 text-fg-3">{file}</div>
                <For each={hits}>
                  {(r) => (
                    <button
                      type="button"
                      onClick={() => jump(r)}
                      class="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-[var(--color-control-fill)]"
                    >
                      <span class="tabular-nums text-fg-3">{r.line}</span>
                      <Show when={r.kind === "label"}>
                        <span class="text-[10px] uppercase text-[var(--color-accent-1)]">
                          def
                        </span>
                      </Show>
                      <span class="truncate font-mono text-fg-1">{r.context}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
          <Show when={!loading() && refs().length === 0}>
            <div class="px-1 text-xs text-fg-3">No references found.</div>
          </Show>
        </div>
      </div>
    </Dialog>
  );
};
