/**
 * Conflict resolution operations for cloud sync.
 *
 * These own the on-disk state-machine transition for a `.conflict-<ISO>`
 * sidecar (finding: this logic used to live inside ConflictResolverDialog,
 * which also bypassed editor-store so a resolved file kept its pre-resolution
 * buffer and the next save resurrected the discarded version). Keeping them
 * next to the engine/conflict naming means the sibling convention has one
 * owner, and the "keep theirs" path can adopt the new disk content into any
 * open tab so the buffer and canonical file stay consistent.
 *
 * Writes still go through plugin-fs (the cloud cache is granted under
 * $DOCUMENT/**); the branded normalizer on the engine side remains the guard
 * for attacker-influenced remote paths.
 */

import { readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";

import { sha256Hex } from "~/lib/hash";
import { adoptDiskContent, openFiles } from "~/stores/editor-store";

import { clearConflict } from "./sync-status";

export interface ConflictTarget {
  /** Status-store key parts so we can clear after resolution. */
  providerId: string;
  projectId: string;
  /** Original file's project-relative path. */
  relPath: string;
  /** Absolute path of the original file. */
  originalAbs: string;
  /** Absolute path of the most-recent `.conflict-*` sibling, if one exists. */
  conflictAbs?: string;
}

/** Keep the local copy: delete the conflict sibling, drop the tracked conflict. */
export async function resolveConflictKeepMine(target: ConflictTarget): Promise<void> {
  if (target.conflictAbs) {
    await remove(target.conflictAbs);
  }
  clearConflict(target.providerId, target.projectId, target.relPath);
}

/**
 * Keep the remote copy: overwrite the original with the sidecar's content,
 * delete the sidecar, and — crucially — reload any open tab for the original so
 * its buffer matches the file the user just chose to keep (otherwise the next
 * Mod+S would write back the pre-resolution content and un-resolve the
 * conflict).
 */
export async function resolveConflictKeepTheirs(target: ConflictTarget): Promise<void> {
  if (!target.conflictAbs) {
    clearConflict(target.providerId, target.projectId, target.relPath);
    return;
  }
  const content = await readTextFile(target.conflictAbs);
  await writeTextFile(target.originalAbs, content);
  await remove(target.conflictAbs);
  if (openFiles().some((f) => f.path === target.originalAbs)) {
    adoptDiskContent(target.originalAbs, content, await sha256Hex(content));
  }
  clearConflict(target.providerId, target.projectId, target.relPath);
}

/**
 * The sync engine writes conflict files as
 * `<dir>/<stem>.conflict-<ISO>.<ext>` next to the original. Walk the parent
 * directory for the newest match — usually there's exactly one, but if multiple
 * passes have raced we surface the most recent.
 */
export async function findLatestConflictSibling(
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
