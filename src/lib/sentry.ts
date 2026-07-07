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
 * Crash/error reporting via Sentry. This module is loaded ONLY through a
 * dynamic import (see index.tsx): the SDK with tracing + replay is ~250 KB,
 * which would blow the check-bundle-shape boot-path ceiling as a static
 * entry import. The ingest host must stay allowlisted in tauri.conf.json's
 * CSP `connect-src`, and Replay needs the existing `worker-src blob:`.
 */
export function initSentry(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.DEV ? "development" : "production",
    integrations: [
      Sentry.browserTracingIntegration(),
      // Replay masks all text and blocks media by default — document content
      // in the editor never leaves the machine readable. Don't relax
      // maskAllText/blockAllMedia without a product decision.
      Sentry.replayIntegration(),
    ],
    tracesSampleRate: 1.0,
    // No first-party HTTP backend: webview traffic is Tauri IPC plus
    // third-party hosts (Supabase, providers). Injecting sentry-trace/baggage
    // headers into those would only risk CORS preflight failures.
    tracePropagationTargets: [],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    enableLogs: true,
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
