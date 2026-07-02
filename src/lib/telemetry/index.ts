import { describeIpcError } from "~/lib/errors";
import * as ipc from "~/ipc";

/**
 * Frontend telemetry surface. All forwarding to the Rust panic log is
 * fire-and-forget; failures here must never break the UI.
 */
export function recordError(
  kind: string,
  summary: string,
  detail?: unknown,
): void {
  // Telemetry is best-effort and must never break the caller — guard the whole
  // path (a synchronous throw from the IPC layer wouldn't be caught by the
  // promise `.catch` alone).
  try {
    const detailStr =
      detail instanceof Error
        ? `${detail.message}\n${detail.stack ?? ""}`
        : detail !== undefined
          ? describeIpcError(detail)
          : undefined;
    void ipc.recordTelemetry(kind, summary, detailStr).catch(() => {});
  } catch {
    /* swallow: recording an error must not itself raise */
  }
}

/**
 * Hook into window-level error events so unhandled rejections / runtime
 * errors land in the same log as Rust panics. Idempotent.
 */
export function installFrontendErrorHook(): void {
  if (typeof window === "undefined") return;
  if ((window as unknown as { __typewardTelemetryInstalled?: boolean }).__typewardTelemetryInstalled) return;
  (window as unknown as { __typewardTelemetryInstalled?: boolean }).__typewardTelemetryInstalled = true;

  window.addEventListener("error", (event) => {
    recordError(
      "frontend-error",
      event.message,
      event.error instanceof Error ? event.error : event.filename,
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordError("frontend-error", "unhandled rejection", event.reason);
  });
}
