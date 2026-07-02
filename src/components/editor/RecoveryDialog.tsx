import { History, Trash2 } from "lucide-solid";
import type { Component } from "solid-js";
import { For } from "solid-js";
import * as ipc from "~/ipc";
import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";

interface RecoveryDialogProps {
  /** Project root absolute path. */
  projectRoot: string;
  open: boolean;
  orphans: ipc.Snapshot[];
  onClose: () => void;
  /**
   * User chose to restore. The caller writes the snapshot's content back to
   * each file (so the editor view reflects it on next read).
   */
  onRestore: (snapshots: ipc.Snapshot[]) => Promise<void> | void;
}

export const RecoveryDialog: Component<RecoveryDialogProps> = (props) => {
  const discardAll = async () => {
    // Deletes the snapshots — the only copy of these unsaved edits.
    let proceed = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      proceed = await ask(
        `Delete ${props.orphans.length} recovered snapshot${props.orphans.length === 1 ? "" : "s"}? The unsaved edits they hold can't be restored afterwards.`,
        {
          title: "Discard snapshots",
          kind: "warning",
          okLabel: "Discard",
          cancelLabel: "Keep",
        },
      );
    } catch {
      proceed = window.confirm("Delete the recovered snapshots permanently?");
    }
    if (!proceed) return;
    for (const s of props.orphans) {
      try {
        await ipc.clearSnapshot(props.projectRoot, s.relPath);
      } catch {
        /* best-effort */
      }
    }
    props.onClose();
  };

  const restoreAll = async () => {
    await props.onRestore(props.orphans);
    // Snapshots stay on disk until the next save clears them, in case the
    // user closes the app immediately and we want a second chance.
    props.onClose();
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="Recover unsaved changes?"
      description="Typeward found buffered edits that were never saved to disk."
      widthClass="w-[520px]"
      footer={
        <>
          <Button variant="danger" onClick={() => void discardAll()} leadingIcon={<Trash2 size={14} />}>
            Discard all
          </Button>
          <Button variant="primary" onClick={() => void restoreAll()} leadingIcon={<History size={14} />}>
            Restore all
          </Button>
        </>
      }
    >
      <ul class="flex flex-col gap-1.5 text-sm mono">
        <For each={props.orphans}>
          {(s) => (
            <li class="glass-inset flex items-center gap-2 rounded-md px-2.5 py-1.5">
              <span class="truncate text-fg-1">{s.relPath}</span>
              <span class="ml-auto text-xs text-fg-3">
                {formatRelative(s.snapshotMtime)}
              </span>
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  );
};

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}
