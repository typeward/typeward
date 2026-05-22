/**
 * ID ↔ relative-path map for Google Drive.
 *
 * Drive uses opaque file ids — paths are derived by walking
 * `parents` chains. Walking on every delta is expensive (and broken
 * when `drive.file` scope means we can't see ancestors we didn't
 * create), so we cache the mapping next to the project's sync cursor.
 *
 * Persisted at `<cache>/.typeward/integrations/gdrive/idmap.json`.
 */

import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export interface IdMap {
  /** id → project-relative path (POSIX-style, no leading slash). */
  files: Record<string, string>;
  /** id → project-relative directory path. Used during path computation. */
  folders: Record<string, string>;
}

export function emptyIdMap(): IdMap {
  return { files: {}, folders: {} };
}

export async function loadIdMap(absPath: string): Promise<IdMap> {
  try {
    if (!(await exists(absPath))) return emptyIdMap();
    const raw = await readTextFile(absPath);
    const parsed = JSON.parse(raw) as IdMap;
    return {
      files: parsed.files ?? {},
      folders: parsed.folders ?? {},
    };
  } catch {
    return emptyIdMap();
  }
}

export async function saveIdMap(absPath: string, map: IdMap): Promise<void> {
  await writeTextFile(absPath, JSON.stringify(map));
}
