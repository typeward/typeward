// @sentry/browser, not @sentry/solid: the Solid wrapper's only additions are
// a solid-router tracing integration and an ErrorBoundary HOC, and its
// @solidjs/router peer range (<=0.15) conflicts with our 0.16. The browser
// package exposes the identical init/integration/capture API.
import * as Sentry from "@sentry/browser";

// The DSN is a public routing identifier, not a secret — safe to commit.
const DSN =
  "https://20ad6af910fa6634a2a400656db18be1@o4511688473640960.ingest.de.sentry.io/4511688490418256";

let initialized = false;

/**
 * Redact absolute filesystem paths that would carry the user's identity before
 * an event leaves the machine — the frontend mirror of the Rust submission
 * scrubber (diagnostics.rs). Home directories collapse to `~`; other Windows
 * paths collapse to their basename. The "Share crash reports" consent promises
 * scrubbed reports, so error messages / breadcrumbs (which routinely embed IPC
 * paths) must not ship raw. URL-safe: the drive-letter form can't match http
 * URLs, and the home patterns only touch `Users`/`home` segments.
 */
export function scrubPaths(s: string): string {
  return (
    s
      // Home directories (identity) -> ~. Allow spaces in the profile name
      // ("First Last") — bounded by the next separator so it stays within the
      // one segment. This is the load-bearing PII redaction.
      .replace(/[A-Za-z]:[\\/]Users[\\/][^\\/]+/gi, "~")
      .replace(/\/(?:Users|home)\/[^/]+/g, "~")
      // Remaining Windows absolute paths -> basename (drive form never in URLs).
      .replace(/[A-Za-z]:[\\/](?:[^\\/\s"']+[\\/])+([^\\/\s"']+)/g, "$1")
      // Remaining POSIX absolute paths -> basename (mirrors the Rust scrubber).
      // URL-safe via a captured preceding char (NO lookbehind — WebKit/JSC only
      // got regex lookbehind in Safari 16.4, below the macOS 12+ / WebKitGTK
      // floor, and the safari13 build target): the path must start at the string
      // start or after a char that isn't a word char, `:` or `/` (so
      // `https://host/a/b` and a scheme's `//` are skipped) nor `~` (so an
      // already-collapsed `~/a/b` keeps its structure). >=2 segments so a lone
      // `/word` in prose isn't eaten.
      .replace(
        /(^|[^\w:/~])((?:\/[^/\s"']+){2,})/g,
        (_m, pre: string, path: string) =>
          pre + path.slice(path.lastIndexOf("/") + 1),
      )
  );
}

function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  if (event.message) event.message = scrubPaths(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubPaths(ex.value);
    // Stack-frame paths carry the app origin in a bundled build, but dev/file://
    // frames and native paths can leak the home dir — scrub them too.
    for (const fr of ex.stacktrace?.frames ?? []) {
      if (fr.filename) fr.filename = scrubPaths(fr.filename);
      if (fr.abs_path) fr.abs_path = scrubPaths(fr.abs_path);
    }
  }
  for (const bc of event.breadcrumbs ?? []) {
    if (bc.message) bc.message = scrubPaths(bc.message);
    // console/log breadcrumbs stash their args in `data`, which can hold paths.
    if (bc.data) {
      const data = bc.data as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") data[k] = scrubPaths(v);
      }
    }
  }
  return event;
}

/**
 * Crash/error reporting via Sentry. This module is loaded ONLY through a
 * dynamic import (see sentry-gate.ts): a static entry import would blow the
 * check-bundle-shape boot-path ceiling. The ingest host must stay
 * allowlisted in tauri.conf.json's CSP `connect-src`.
 */
export function initSentry(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.DEV ? "development" : "production",
    // Errors only, deliberately: the "Share crash reports" opt-in consents to
    // crash/error reports and nothing broader. Don't add tracing, session
    // replay, or log forwarding without widening that consent copy first.
    sendDefaultPii: false,
    // Scrub absolute filesystem paths (identity) before egress, matching the
    // Rust submission scrubber and the consent copy's "scrubbed" promise.
    beforeSend: scrubEvent,
  });
}

/**
 * Opt-out at runtime (Settings -> Security -> Share crash reports OFF).
 * `close()` flushes in-flight events and disables the client; a later
 * re-enable goes through initSentry() again, which creates a fresh client.
 */
export function shutdownSentry(): void {
  if (!initialized) return;
  initialized = false;
  void Sentry.close(2000).catch(() => {});
}

/**
 * For errors caught by Solid ErrorBoundaries — those never reach
 * window.onerror, so Sentry's global handlers can't see them.
 */
export function reportCrash(err: unknown): void {
  if (!initialized) return;
  Sentry.captureException(err, { tags: { source: "app-error-boundary" } });
}

/** Dev-only end-to-end delivery check (palette: "Send Sentry test error"). */
export function sendTestError(): void {
  Sentry.captureMessage("Sentry verification message", "info");
  // Thrown outside any caller's try/catch so it exercises the real
  // global-handler -> transport -> CSP pipeline, not just captureException.
  window.setTimeout(() => {
    throw new Error("Sentry verification error (dev test command)");
  }, 0);
}
