/**
 * Local error logging. `recordError` is a thin wrapper over `console.error`
 * for local debugging — nothing is persisted to disk or transmitted anywhere.
 */
export function recordError(
  kind: string,
  summary: string,
  detail?: unknown,
): void {
  // Logging must never break the caller — a synchronous throw here would
  // otherwise surface in whatever error path called us.
  try {
    if (detail !== undefined) {
      console.error(`[${kind}] ${summary}`, detail);
    } else {
      console.error(`[${kind}] ${summary}`);
    }
  } catch {
    /* swallow: logging an error must not itself raise */
  }
}
