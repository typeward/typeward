/**
 * Which webview window this bundle is running in. The detached PDF preview
 * window (E11) loads the same index.html with `?window=preview`; it is a
 * read-only mirror of the main window and must NEVER write shared disk state
 * (settings.json, project sidecars) — the main window is the single writer.
 * Stores transitively imported by the preview (settings-store) consult this to
 * skip persistence. Evaluated once at load; the query string never changes.
 */
export const isPreviewWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("window") === "preview";
