import { createEffect, createRoot } from "solid-js";

import * as ipc from "~/ipc";
import { noteInstallId, settingsLoaded, shareCrashReports } from "~/stores/settings-store";

// Whether the SDK chunk was fetched this session — the opt-out branch must
// not import the SDK just to shut down a client that never existed.
let sdkLoaded = false;
// The crash-on-previous-run scan fires at most once per session (Rust also
// guards once-per-process, and re-checks the opt-in server-side).
let scanKicked = false;

/**
 * Crash reporting is an egress OPT-IN (privacy brand: nothing leaves the
 * machine by default). This gate watches the persisted
 * `privacy.shareCrashReports` setting and dynamic-imports the Sentry module
 * only when the user has enabled it — opted-out users never fetch the SDK
 * chunk at all. Toggling off at runtime flushes and disables the client.
 *
 * The same opt-in also kicks the Rust-side crash scan (`scan_and_submit_crashes`):
 * `panic` events from previous runs, newer than the persisted watermark, are
 * submitted through the scrubbed one-shot path (max 5 per launch).
 *
 * Init therefore waits for settings.json to load; anything thrown before
 * that still lands in the local telemetry.log via installFrontendErrorHook,
 * reportable later from Settings -> Diagnostics.
 */
export function installSentryGate(): void {
  createRoot(() => {
    createEffect(() => {
      if (!settingsLoaded()) return;
      if (shareCrashReports()) {
        sdkLoaded = true;
        void import("./sentry").then((m) => m.initSentry()).catch(() => {});
        if (!scanKicked) {
          scanKicked = true;
          // Fire-and-forget: delivery failures keep the watermark in place and
          // retry next launch. noteInstallId keeps the settings mirror from
          // clobbering a just-minted id on the next save.
          void ipc
            .scanAndSubmitCrashes()
            .then((r) => noteInstallId(r.installId))
            .catch(() => {});
        }
      } else if (sdkLoaded) {
        void import("./sentry").then((m) => m.shutdownSentry()).catch(() => {});
      }
    });
  });
}
