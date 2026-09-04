/**
 * Display-ready PDF annotation data — the seam between the review store (source
 * offsets) and the PDF viewer (page geometry). Lives in lib/ (not the viewer)
 * because both the in-process mapper and the detached-window bridge produce and
 * consume these, and neither should depend on the viewer component.
 */

/**
 * A review/TODO thread resolved to a PDF location, ready to paint. `page`/`y`
 * come from SyncTeX forward; `anchorText` is carried for optional glyph-level
 * refinement. Serializable by design so it can cross the E11 window bridge.
 */
export interface PdfAnnotation {
  threadId: string;
  kind: "comment" | "todo";
  /** 1-based page number. */
  page: number;
  /** PDF points from the top of the page (SyncTeX y). */
  y: number;
  /** SyncTeX hbox in top-origin pt; null when unreported. */
  box?: { left: number; top: number; width: number; height: number } | null;
  anchorText: string;
}

/**
 * Payload for a thread created from a PDF text selection. `x`/`y` are the
 * selection's anchor point in PDF points (page-relative) so the host can run
 * SyncTeX inverse to find the source line; `body` is the composer text.
 */
export interface CreateThreadInput {
  kind: "comment" | "todo";
  page: number;
  x: number;
  y: number;
  selectedText: string;
  body: string;
}
