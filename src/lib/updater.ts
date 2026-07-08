/**
 * Auto-updater front end — a thin, defensive wrapper over
 * `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`.
 *
 * DORMANCY. The whole feature stays inert until an updater keypair exists and
 * its public key is pasted into `tauri.conf.json` (root-credential class — see
 * `_plans/40-distribution-signing-updates.md`). `__UPDATER_CONFIGURED__` is a
 * build-time constant (vite.config.ts) that reads that pubkey; while it's empty
 * we never even import the plugin, so there is no boot cost and no runtime
 * error. The plugin JS is dynamic-imported only on a real check so it stays off
 * the boot bundle either way.
 *
 * PRIVACY. A check is a plain HTTPS GET to the GitHub releases manifest — no
 * install id, no telemetry. The UX prompts, never installs silently.
 */

import { isTauriMobile } from "~/lib/platform";
import { recordError } from "~/lib/telemetry";
import { describeIpcError } from "~/lib/errors";
import { notifyError, notifyInfo, notifySuccess } from "~/lib/toast";
import { setRequestUpdateDialog } from "~/commands/palette-store";

// `typeof` guard keeps this safe in any context where the define didn't run.
const CONFIGURED =
  typeof __UPDATER_CONFIGURED__ === "boolean" ? __UPDATER_CONFIGURED__ : false;

/** True only on desktop with a configured pubkey. Both the boot check and the
 *  Settings "Check for updates" button gate on this. */
export function isUpdaterConfigured(): boolean {
  return CONFIGURED && !isTauriMobile();
}

// The plugin's `Update` handle from the last successful check. Kept in module
// scope (not a signal) because it carries live methods; the dialog reads only
// display metadata through the palette-store signal and calls back here to
// install. Minimal structural type — avoids importing the plugin's types into
// the boot graph just for an annotation.
interface PendingUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall: (
    onEvent?: (e: {
      event: "Started" | "Progress" | "Finished";
      data?: { contentLength?: number; chunkLength?: number };
    }) => void,
  ) => Promise<void>;
  close?: () => Promise<void>;
}

let pendingUpdate: PendingUpdate | null = null;

export interface InstallProgress {
  /** 0..1 when the total size is known, else undefined (indeterminate). */
  fraction: number | undefined;
  downloadedBytes: number;
  totalBytes: number;
}

/**
 * Check for a newer release. On the `silent` (auto/boot) path every failure and
 * the unconfigured case are swallowed — the user is never interrupted. On the
 * manual path (Settings button) the outcome is always surfaced as a toast, and
 * an available update raises the non-modal dialog.
 */
export async function checkForUpdates({
  silent,
}: {
  silent: boolean;
}): Promise<void> {
  if (isTauriMobile()) {
    if (!silent) {
      notifyInfo(
        "Updates are managed by your app store",
        "Install Typeward updates from the store you got it from.",
      );
    }
    return;
  }

  if (!isUpdaterConfigured()) {
    if (!silent) {
      notifyInfo(
        "Updates aren't configured yet",
        "This build predates automatic updates — grab new versions from the Typeward download page.",
      );
    }
    return;
  }

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = (await check()) as PendingUpdate | null;
    if (!update) {
      pendingUpdate = null;
      if (!silent) notifySuccess("You're up to date", "No newer version available.");
      return;
    }
    pendingUpdate = update;
    setRequestUpdateDialog({
      version: update.version,
      currentVersion: update.currentVersion,
      notes: (update.body ?? "").trim(),
      date: update.date,
    });
  } catch (e) {
    // Network blips, an unreachable manifest, a signature mismatch — none of
    // these should ever nag on the auto path.
    if (silent) {
      recordError("updater", "silent update check failed", e);
    } else {
      notifyError("Couldn't check for updates", describeIpcError(e));
    }
  }
}

/**
 * Download + install the update found by the last check, reporting progress,
 * then relaunch into the new version. Throws on failure so the caller can keep
 * its button in an error state; callers surface the message.
 */
export async function installPendingUpdate(
  onProgress?: (p: InstallProgress) => void,
): Promise<void> {
  const update = pendingUpdate;
  if (!update) throw new Error("No pending update to install.");

  let downloaded = 0;
  let total = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") {
      total = e.data?.contentLength ?? 0;
    } else if (e.event === "Progress") {
      downloaded += e.data?.chunkLength ?? 0;
    }
    onProgress?.({
      fraction: total > 0 ? Math.min(1, downloaded / total) : undefined,
      downloadedBytes: downloaded,
      totalBytes: total,
    });
  });

  // A fresh install is staged; relaunch swaps into it. On Windows the NSIS
  // installer replaces the running exe, so relaunch is the natural handoff.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/**
 * Fire the delayed post-paint boot check. No-op unless auto-checking is on AND
 * the updater is configured (dormant otherwise). Never blocks startup; the
 * timer is cleared on teardown so it can't fire into a torn-down app.
 */
export function scheduleBootUpdateCheck(
  checkAutomatically: () => boolean,
): () => void {
  if (!isUpdaterConfigured()) return () => {};
  const timer = setTimeout(() => {
    if (checkAutomatically()) void checkForUpdates({ silent: true });
  }, 10_000);
  return () => clearTimeout(timer);
}
