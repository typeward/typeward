/**
 * Canonical normalizer for unknown thrown values — Tauri IPC rejections,
 * `Error` instances, strings, or serialized objects — into a readable line.
 *
 * Rust commands now reject with a plain string equal to the source error's
 * Display text (the IPC error contract), so a string rejection is the message
 * verbatim. Legacy plugin rejections and non-Error throws can still be objects,
 * so those are unwrapped by `message`/`error` field or JSON — the one thing this
 * must never produce is `[object Object]` (the historical login-error bug).
 */
export function describeIpcError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.error === "string" && o.error) return o.error;
    try {
      const j = JSON.stringify(e);
      if (j && j !== "{}") return j;
    } catch {
      /* fall through to String() */
    }
  }
  return String(e);
}
