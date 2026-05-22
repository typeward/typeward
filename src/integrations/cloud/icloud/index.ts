/**
 * iCloud Drive — OS-mediated, not a CloudFsProvider.
 *
 * iCloud Drive has no public third-party REST API. The integration is
 * a folder-picker shortcut: on macOS, `~/Library/Mobile Documents/
 * com~apple~CloudDocs/` is a normal directory the OS keeps synced
 * across devices. We open a project there as a regular local project;
 * the existing file watcher reconciles changes that arrive from other
 * devices.
 *
 * On iPadOS (future Phase 3 follow-up), the equivalent is
 * `UIDocumentPickerViewController` via a Tauri iOS plugin. On Windows
 * / Linux / Android iCloud Drive simply isn't accessible — the
 * CloudPickerDialog (Phase 2.6) hides the entry there.
 */

import { platform } from "@tauri-apps/plugin-os";

const MAC_PATH_SUFFIX = "Library/Mobile Documents/com~apple~CloudDocs";

export interface ICloudAvailability {
  available: boolean;
  /** Absolute path to the iCloud Drive root, when available. */
  rootPath?: string;
  reason?: string;
}

export async function detectICloudDrive(): Promise<ICloudAvailability> {
  const os = await platform();
  if (os !== "macos") {
    return {
      available: false,
      reason: os === "ios"
        ? "iOS / iPadOS support arrives with the document picker integration."
        : "iCloud Drive is only accessible on Apple platforms.",
    };
  }
  const home = await getHomeDir();
  if (!home) {
    return { available: false, reason: "Could not resolve $HOME on this system." };
  }
  return {
    available: true,
    rootPath: joinPath(home, MAC_PATH_SUFFIX),
  };
}

async function getHomeDir(): Promise<string | null> {
  if (typeof process !== "undefined" && process.env?.HOME) {
    return process.env.HOME;
  }
  try {
    const mod = await import("@tauri-apps/api/path");
    return await mod.homeDir();
  } catch {
    return null;
  }
}

function joinPath(...segments: string[]): string {
  const sep = segments[0].includes("\\") ? "\\" : "/";
  return segments
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, "") : s.replace(/^[\\/]+|[\\/]+$/g, "")))
    .filter(Boolean)
    .join(sep);
}
