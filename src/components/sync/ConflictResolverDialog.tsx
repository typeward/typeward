/**
 * Conflict resolver. For each path the sync engine reported as
 * conflicted, surface the matching `.conflict-<ISO>.<ext>` sibling and
 * offer three resolutions:
 *
 *   - Keep mine — delete the conflict sibling, keep the original.
 *   - Keep theirs — swap them: read sibling content, write to the
 *     original, delete the sibling.
 *   - Open both — load both files as editor tabs so the user can
 *     diff-by-eye in the existing editor surface.
 *
 * After any action the conflict is dropped from the engine's tracked
 * list so the badge reflects reality immediately.
 */

import { describeIpcError } from "~/lib/errors";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { AlertTriangle, FileText } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { allSyncStatuses } from "~/integrations/cloud/core";
import {
  findLatestConflictSibling,
  resolveConflictKeepMine,
  resolveConflictKeepTheirs,
} from "~/integrations/cloud/core/resolve";
import { readCloudOrigin } from "~/integrations/cloud/registry";
import { openFile, project } from "~/stores/editor-store";
import { recordError } from "~/lib/telemetry";

interface ConflictResolverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ConflictEntry {
  /** Status-store key parts so we can clear after resolution. */
  providerId: string;
  projectId: string;
  /** Project-absolute root, used to build absolute file paths. */
  projectRoot: string;
  /** Original file's project-relative path. */
  relPath: string;
  /** Absolute path of the original. */
  originalAbs: string;
  /** Absolute path of the most-recent `.conflict-*` sibling. */
  conflictAbs?: string;
  /** Project-relative path of the conflict sibling (for `openFile`). */
  conflictRelPath?: string;
}

export const ConflictResolverDialog: Component<ConflictResolverDialogProps> = (props) => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [actionError, setActionError] = createSignal<string | null>(null);

  const [entries] = createResource(
    () => [allSyncStatuses(), project(), refreshTick()] as const,
    async ([statuses, proj]): Promise<ConflictEntry[]> => {
      if (!proj) return [];
      const origin = readCloudOrigin(proj);
      if (!origin) return [];
      const list: ConflictEntry[] = [];
      for (const [k, status] of statuses) {
        const [providerId, projectId] = k.split("::");
        if (!providerId || !projectId) continue;
        if (status.conflicts.length === 0) continue;
        for (const relPath of status.conflicts) {
          const originalAbs = joinAbs(proj.rootPath, relPath);
          const conflictAbs = await findLatestConflictSibling(proj.rootPath, relPath);
          list.push({
            providerId,
            projectId,
            projectRoot: proj.rootPath,
            relPath,
            originalAbs,
            conflictAbs,
            conflictRelPath: conflictAbs
              ? conflictAbs.slice(proj.rootPath.length + 1)
              : undefined,
          });
        }
      }
      return list;
    },
    { initialValue: [] },
  );

  const total = createMemo(() => entries()?.length ?? 0);

  const keepMine = async (entry: ConflictEntry) => {
    if (entry.conflictAbs) {
      // Destructive: the sidecar is the only saved copy of the other version
      // (which side it holds depends on who won the conflict) — no undo path,
      // so confirm first.
      if (
        !(await confirmDestructive(
          "Keep mine",
          `Delete the conflict copy "${entry.conflictRelPath}"? This is the only saved copy of the other version.`,
          "Delete other copy",
        ))
      ) {
        return;
      }
    }
    setActionError(null);
    try {
      await resolveConflictKeepMine(entry);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      recordError("cloud-conflict", `keep-mine failed for ${entry.relPath}`, e);
      setActionError(
        `Couldn't keep your copy of "${entry.relPath}": ${describeIpcError(e)}`,
      );
    }
  };

  const keepTheirs = async (entry: ConflictEntry) => {
    if (entry.conflictAbs) {
      // Destructive: overwrites the local file with the remote copy and
      // deletes the sidecar — no undo path, so confirm first.
      if (
        !(await confirmDestructive(
          "Keep theirs",
          `Replace your local "${entry.relPath}" with the remote version? Your local edits will be lost.`,
          "Replace local copy",
        ))
      ) {
        return;
      }
    }
    setActionError(null);
    try {
      await resolveConflictKeepTheirs(entry);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      recordError("cloud-conflict", `keep-theirs failed for ${entry.relPath}`, e);
      setActionError(
        `Couldn't replace "${entry.relPath}" with the remote copy: ${describeIpcError(e)}`,
      );
    }
  };

  const openBoth = async (entry: ConflictEntry) => {
    const originalContent = await safeReadText(entry.originalAbs);
    openFile({
      path: entry.originalAbs,
      relPath: entry.relPath,
      content: originalContent,
      dirty: false,
    });
    if (entry.conflictAbs && entry.conflictRelPath) {
      const conflictContent = await safeReadText(entry.conflictAbs);
      openFile({
        path: entry.conflictAbs,
        relPath: entry.conflictRelPath,
        content: conflictContent,
        dirty: false,
      });
    }
    props.onOpenChange(false);
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={`Resolve sync conflicts (${total()})`}
      description="The cloud and local copies diverged for these files. Keep one, or open both to merge by hand."
      widthClass="w-[640px]"
      footer={
        <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <Show when={actionError()}>
        <div class="mb-2 select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]">
          {actionError()}
        </div>
      </Show>
      <Show
        when={total() > 0}
        fallback={
          <div class="flex flex-col items-center gap-2 py-8 text-center text-fg-2">
            <AlertTriangle class="ui-icon-menu text-fg-3/60" />
            <div>No outstanding conflicts.</div>
          </div>
        }
      >
        <div class="flex flex-col gap-2">
          <For each={entries() ?? []}>
            {(entry) => (
              <div class="glass-inset flex flex-col gap-2 rounded-md px-3 py-2.5">
                <div class="flex items-center gap-2">
                  <FileText class="ui-icon-sm text-fg-3" />
                  <span class="mono truncate text-sm text-fg-1">
                    {entry.relPath}
                  </span>
                </div>
                <Show
                  when={entry.conflictRelPath}
                  fallback={
                    <div class="text-xs text-fg-3">
                      Couldn't find a `.conflict-*` sibling for this file. The
                      remote copy may have been removed already.
                    </div>
                  }
                >
                  <div class="text-xs text-fg-3">
                    Other copy: <span class="mono select-text">{entry.conflictRelPath}</span>
                  </div>
                </Show>
                <div class="flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => void keepMine(entry)}>
                    Keep mine
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void keepTheirs(entry)}>
                    Keep theirs
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void openBoth(entry)}>
                    Open both
                  </Button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Dialog>
  );
};

function joinAbs(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  const cleaned = rel.replace(/^[\\/]+/, "");
  return `${trimmed}${sep}${cleaned}`;
}

async function confirmDestructive(
  title: string,
  message: string,
  okLabel: string,
): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(message, { title, kind: "warning", okLabel, cancelLabel: "Cancel" });
  } catch {
    return window.confirm(message);
  }
}

async function safeReadText(absPath: string): Promise<string> {
  try {
    return await readTextFile(absPath);
  } catch {
    return "";
  }
}
