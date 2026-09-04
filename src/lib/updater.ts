/**
 * Auto-updater front end - a thin, defensive wrapper over
 * `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`.
 *
 * DORMANCY. `__UPDATER_CONFIGURED__` is a build-time constant (vite.config.ts)
 * that reads the pubkey out of `tauri.conf.json`. While it is empty we never
 * even import the plugin, so a keyless build has no boot cost and no runtime
 * error. The plugin JS is dynamic-imported only on a real check, so it stays
 * off the boot bundle either way.
 *
 * PRIVACY. A check is a plain HTTPS GET to the GitHub releases manifest, issued
 * by Rust (not the webview, so it needs no CSP origin). It sends the plugin's
 * own user agent and nothing else: no install id, no version, no telemetry.
 * The UX prompts, never installs silently.
 *
 * PLATFORM. `downloadAndInstall` does not mean the same thing everywhere:
 *   - Windows: the plugin hands the NSIS installer to ShellExecute and then
 *     calls `std::process::exit(0)` itself. Nothing after that line in this
 *     module runs. The installer restarts the app (install mode `passive`
 *     passes NSIS `/P /R`), which is why `tauri.conf.json` pins that mode.
 *   - macOS and Linux: install returns normally and WE relaunch.
 * Anything that must survive the swap has to be flushed BEFORE the call, on
 * every platform, because on Windows there is no "after".
 */

import { isTauriMobile } from "~/lib/platform";
import { recordError } from "~/lib/telemetry";
import { describeIpcError } from "~/lib/errors";
import { notifyError, notifyInfo, notifySuccess } from "~/lib/toast";
import { pushNotification } from "~/stores/notifications-store";
import { setRequestUpdateDialog } from "~/commands/palette-store";
import { updaterInstallKind } from "~/ipc";

// `typeof` guard keeps this safe in any context where the define didn't run.
const CONFIGURED =
  typeof __UPDATER_CONFIGURED__ === "boolean" ? __UPDATER_CONFIGURED__ : false;

/** True only on desktop with a configured pubkey. Both the boot check and the
 *  Settings "Check for updates" button gate on this. */
export function isUpdaterConfigured(): boolean {
  return CONFIGURED && !isTauriMobile();
}

// The plugin's `Update` handle from the last successful check. Kept in module
// scope (not a signal) because it carries live methods and a Rust-side resource
// that must be released; the dialog reads only display metadata through the
// palette-store signal and calls back here to install. Minimal structural type
// avoids importing the plugin's types into the boot graph just for annotations.
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
let checkInFlight: Promise<void> | null = null;

/** Release the Rust-side resource behind a handle we are about to drop. */
function releasePending(): void {
  const stale = pendingUpdate;
  pendingUpdate = null;
  if (!stale?.close) return;
  // Best effort: a failed release leaks one handle until exit, which must
  // never turn into a user-visible error.
  void stale.close().catch(() => {});
}

/** Drop the pending handle without installing (dialog dismissed). */
export function discardPendingUpdate(): void {
  releasePending();
}

export interface InstallProgress {
  /** 0..1 when the total size is known, else undefined (indeterminate). */
  fraction: number | undefined;
  downloadedBytes: number;
  totalBytes: number;
}

/** Package types whose updates the OS package manager owns, not us. */
const PACKAGE_MANAGED = new Set(["deb", "rpm"]);

async function installKind(): Promise<string> {
  try {
    return await updaterInstallKind();
  } catch {
    return "unknown";
  }
}

/**
 * A check fails with a target-not-found error when the release carries no
 * artifact for how this copy was installed. That is expected, not broken: we
 * publish one signed artifact per package type, and a `.deb` can only be
 * updated by a `.deb`. Turn it into an explanation instead of an error.
 */
function isTargetMissing(message: string): boolean {
  return (
    message.includes("was not found in the response") ||
    message.includes("were found in the response")
  );
}

async function explainUnavailable(message: string): Promise<void> {
  const kind = await installKind();
  if (PACKAGE_MANAGED.has(kind)) {
    notifyInfo(
      "Updates come from your package manager",
      `This copy of Typeward was installed from a .${kind} package. Install the new version the same way, or download it from the Typeward releases page.`,
    );
    return;
  }
  notifyInfo(
    "No update available for this build",
    "This release has no download matching how Typeward was installed. Grab the latest version from the Typeward releases page.",
  );
  recordError("updater", "no updater target for this install kind", message);
}

/**
 * Check for a newer release. On the `silent` (auto/boot) path every failure and
 * the unconfigured case are swallowed - the user is never interrupted. On the
 * manual path (Settings button) the outcome is always surfaced as a toast, and
 * an available update raises the non-modal dialog.
 *
 * Concurrent calls share one in-flight check: the Settings button and the boot
 * timer can otherwise race and leave two `Update` handles with one reference.
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
        "This build predates automatic updates. Grab new versions from the Typeward releases page.",
      );
    }
    return;
  }

  if (checkInFlight) return checkInFlight;
  checkInFlight = runCheck(silent).finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

async function runCheck(silent: boolean): Promise<void> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = (await check()) as PendingUpdate | null;
    if (!update) {
      releasePending();
      if (!silent) {
        notifySuccess("You're up to date", "No newer version available.");
      }
      return;
    }
    // A second check supersedes whatever the first one found.
    releasePending();
    pendingUpdate = update;
    // `once` per version: the boot check runs on every launch, and an update
    // the user keeps postponing must not re-announce itself each time. A newer
    // release carries a new key and does announce.
    pushNotification({
      kind: "info",
      title: `Typeward ${update.version} is available`,
      body: `You're on ${update.currentVersion}. Open Settings to install it.`,
      key: `update-available:${update.version}`,
      once: true,
    });
    setRequestUpdateDialog({
      version: update.version,
      currentVersion: update.currentVersion,
      notes: (update.body ?? "").trim(),
      date: update.date,
    });
  } catch (e) {
    const message = describeIpcError(e);
    // Network blips, an unreachable manifest, a signature mismatch - none of
    // these should ever nag on the auto path.
    if (silent) {
      recordError("updater", "silent update check failed", e);
    } else if (isTargetMissing(message)) {
      await explainUnavailable(message);
    } else {
      notifyError("Couldn't check for updates", message);
    }
  }
}

/**
 * Persist everything the running app is holding that a restart would drop.
 *
 * Mirrors the window-close guard in `EditorScreen`, minus its discard prompt:
 * the user already chose to install, so dirty buffers are saved rather than
 * queried. Autosave snapshots are deliberately not forced - they exist for
 * crash recovery, and a real save of the same buffer supersedes them.
 *
 * Failures here must not block the install; a partially flushed app that
 * updates is better than an app that refuses to update. Each step is isolated
 * so one failure cannot skip the others.
 */
async function flushBeforeRestart(): Promise<void> {
  const steps: Array<() => Promise<void> | void> = [];
  try {
    const [actions, reviews, ai] = await Promise.all([
      import("~/commands/actions"),
      import("~/stores/review-store"),
      import("~/stores/ai-chat-store"),
    ]);
    steps.push(() => ai.abortActiveAiStream());
    steps.push(() => actions.saveAllDirtyFiles());
    steps.push(() => reviews.flushPendingReviewSave());
    steps.push(() => ai.flushPendingAiChatSaves());
  } catch (e) {
    recordError("updater", "could not load flush handlers before update", e);
    return;
  }
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      recordError("updater", "flush before update failed", e);
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

  // Must happen before downloadAndInstall: on Windows the plugin terminates
  // this process from inside that call, so there is no "after" to flush in.
  await flushBeforeRestart();

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

  // Reached on macOS and Linux only. On Windows the NSIS installer has already
  // taken over and restarts the app itself.
  pendingUpdate = null;
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
