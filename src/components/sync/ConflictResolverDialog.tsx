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

import {
  readDir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { AlertTriangle, FileText } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import {
  allSyncStatuses,
  clearConflict,
} from "~/integrations/cloud/core";
import { readCloudOrigin } from "~/integrations/cloud/registry";
import { openFile, project } from "~/stores/editor-store";

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
    setActionError(null);
    try {
      if (entry.conflictAbs) await remove(entry.conflictAbs);
      clearConflict(entry.providerId, entry.projectId, entry.relPath);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setActionError(
        `Couldn't keep your copy of "${entry.relPath}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const keepTheirs = async (entry: ConflictEntry) => {
    if (!entry.conflictAbs) {
      clearConflict(entry.providerId, entry.projectId, entry.relPath);
      setRefreshTick((t) => t + 1);
      return;
    }
    // Destructive: overwrites the local file with the remote copy and
    // deletes the sidecar — no undo path, so confirm first.
    let proceed = false;
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      proceed = await ask(
        `Replace your local "${entry.relPath}" with the remote version? Your local edits will be lost.`,
        {
          title: "Keep theirs",
          kind: "warning",
          okLabel: "Replace local copy",
          cancelLabel: "Cancel",
        },
      );
    } catch {
      proceed = window.confirm(
        `Replace your local "${entry.relPath}" with the remote version?`,
      );
    }
    if (!proceed) return;
    setActionError(null);
    try {
      const content = await readTextFile(entry.conflictAbs);
      await writeTextFile(entry.originalAbs, content);
      await remove(entry.conflictAbs);
      clearConflict(entry.providerId, entry.projectId, entry.relPath);
      setRefreshTick((t) => t + 1);
    } catch (e) {
      setActionError(
        `Couldn't replace "${entry.relPath}" with the remote copy: ${e instanceof Error ? e.message : String(e)}`,
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
        <div
          class="mb-2 rounded-md px-3 py-2 text-[11px]"
          style={{
            color: "var(--color-danger-fill)",
            background: "color-mix(in srgb, var(--color-danger-fill) 12%, transparent)",
          }}
        >
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
                  <span class="mono truncate text-[length:var(--ui-font-sm)] text-fg-1">
                    {entry.relPath}
                  </span>
                </div>
                <Show
                  when={entry.conflictRelPath}
                  fallback={
                    <div class="text-[11px] text-fg-3">
                      Couldn't find a `.conflict-*` sibling for this file. The
                      remote copy may have been removed already.
                    </div>
                  }
                >
                  <div class="text-[11px] text-fg-3">
                    Other copy: <span class="mono">{entry.conflictRelPath}</span>
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

/**
 * The sync engine writes conflict files as
 * `<dir>/<stem>.conflict-<ISO>.<ext>` next to the original. Walk the
 * parent directory for the newest match — usually there's exactly one,
 * but if multiple passes have raced we surface the most recent.
 */
async function findLatestConflictSibling(
  projectRoot: string,
  relPath: string,
): Promise<string | undefined> {
  const sep = projectRoot.includes("\\") ? "\\" : "/";
  const lastSlash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const dirRel = lastSlash >= 0 ? relPath.slice(0, lastSlash) : "";
  const baseName = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
  const dotIdx = baseName.lastIndexOf(".");
  const stem = dotIdx <= 0 ? baseName : baseName.slice(0, dotIdx);
  const ext = dotIdx <= 0 ? "" : baseName.slice(dotIdx);

  const absDir =
    dirRel.length === 0
      ? projectRoot.replace(/[\\/]+$/, "")
      : `${projectRoot.replace(/[\\/]+$/, "")}${sep}${dirRel}`;

  let entries: Array<{ name: string }>;
  try {
    entries = await readDir(absDir);
  } catch {
    return undefined;
  }

  const conflictPrefix = `${stem}.conflict-`;
  const matches = entries
    .map((e) => e.name)
    .filter((name) =>
      ext
        ? name.startsWith(conflictPrefix) && name.endsWith(ext)
        : name.startsWith(conflictPrefix),
    )
    .sort()
    .reverse();
  if (matches.length === 0) return undefined;
  return `${absDir}${sep}${matches[0]}`;
}

async function safeReadText(absPath: string): Promise<string> {
  try {
    return await readTextFile(absPath);
  } catch {
    return "";
  }
}
