import * as ipc from "~/ipc";
import { saveAllDirtyFiles } from "~/commands/actions";
import { adoptDiskContent, openFiles } from "~/stores/editor-store";
import { noteProjectFilesChanged } from "~/stores/index-store";
import { sha256Hex } from "~/lib/hash";

/**
 * Apply a project-wide label rename safely: save dirty buffers first (so a
 * rewrite can't drop unsaved work), rewrite on disk via Rust, then reload the
 * affected OPEN buffers from the renamed disk (a stale buffer would otherwise
 * save the old key back and revert the rename), and refresh the index.
 */
export async function renameLabelWorkflow(
  projectRoot: string,
  oldKey: string,
  newKey: string,
): Promise<ipc.RenameResult> {
  await saveAllDirtyFiles();
  const result = await ipc.renameProjectLabel(projectRoot, oldKey, newKey);
  for (const rel of result.filesChanged) {
    const open = openFiles().find((f) => f.relPath === rel);
    if (!open) continue;
    const disk = await ipc
      .readProjectTextFile(projectRoot, rel)
      .catch(() => null);
    if (disk == null) continue;
    adoptDiskContent(open.path, disk, await sha256Hex(disk));
  }
  noteProjectFilesChanged();
  return result;
}
