import { createEffect, createRoot } from "solid-js";

import { settingsLoaded, shareCrashReports } from "~/stores/settings-store";

// Whether the SDK chunk was fetched this session — the opt-out branch must
// not import ~250 KB just to shut down a client that never existed.
let sdkLoaded = false;

/**
 * Crash reporting is an egress OPT-IN (privacy brand: nothing leaves the
 * machine by default). This gate watches the persisted
 * `privacy.shareCrashReports` setting and dynamic-imports the Sentry module
 * only when the user has enabled it — opted-out users never fetch the SDK
 * chunk at all. Toggling off at runtime flushes and disables the client.
 *
 * Init therefore waits for settings.json to load; anything thrown before
 * that still lands in the local telemetry.log via installFrontendErrorHook,
 * reportable later from the Diagnostics surface when it exists.
 */
export function installSentryGate(): void {
  createRoot(() => {
    createEffect(() => {
      if (!settingsLoaded()) return;
      if (shareCrashReports()) {
        sdkLoaded = true;
        void import("./sentry").then((m) => m.initSentry()).catch(() => {});
      } else if (sdkLoaded) {
        void import("./sentry").then((m) => m.shutdownSentry()).catch(() => {});
      }
    });
  });
}
