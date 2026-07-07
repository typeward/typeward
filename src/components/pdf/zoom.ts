/** Pure zoom helpers for the PDF viewer (kept out of PdfViewer.tsx so they can
 * be unit-tested without importing the pdf.js worker). */

export type ZoomMode = number | "fit-width" | "fit-page";

export const FIT_WIDTH_PAD = 48;
export const FIT_HEIGHT_PAD = 32;

/**
 * Scale that fits a page (dims in PDF points) to the scroll container for the
 * given fit mode. Clamped to a sane zoom range; degenerate inputs fall back to
 * 1 (100%).
 */
export function computeFitScale(
  container: { clientWidth: number; clientHeight: number },
  page: { w: number; h: number },
  mode: "fit-width" | "fit-page",
): number {
  if (page.w <= 0 || page.h <= 0) return 1;
  const raw =
    mode === "fit-width"
      ? (container.clientWidth - FIT_WIDTH_PAD) / page.w
      : (container.clientHeight - FIT_HEIGHT_PAD) / page.h;
  if (!Number.isFinite(raw)) return 1;
  // A container narrower/shorter than the padding yields a negative raw; the
  // clamp floors it rather than snapping to 100%.
  return Math.min(4, Math.max(0.25, raw));
}
