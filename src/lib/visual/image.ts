/**
 * The visible image: what the document "reads as" in visual mode — the
 * concatenation of content spans, with each widget and hidden-newline
 * contributing a single space-class unit. Word motion, the visual search
 * panel, and clipboard normalization all consume THIS one iterator, so the
 * three can never disagree about what is visible.
 */

import type { VisualDoc } from "./parse";
import { coverage } from "./parse";

export interface ImageSegment {
  /** Document offsets of the segment. */
  from: number;
  to: number;
  /**
   * "text"   — real characters, visible verbatim;
   * "space"  — a widget or hidden run standing in as one space-class unit
   *            (atomic: the caret never rests inside it).
   */
  kind: "text" | "space";
}

/**
 * Segments across `[from, to)` in document order. Hidden spans and widgets
 * both read as a single space unit (they separate words); adjacent
 * non-content spans merge into one unit.
 */
export function imageSegments(
  doc: VisualDoc,
  from: number,
  to: number,
): ImageSegment[] {
  const spans = coverage(doc);
  const out: ImageSegment[] = [];
  for (const s of spans) {
    if (s.to <= from) continue;
    if (s.from >= to) break;
    const f = Math.max(s.from, from);
    const t = Math.min(s.to, to);
    if (t <= f) continue;
    const kind: ImageSegment["kind"] = s.kind === "content" ? "text" : "space";
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to === f && kind === "space") {
      last.to = t;
    } else {
      out.push({ from: f, to: t, kind });
    }
  }
  return out;
}

export interface ImageWindow {
  /** The image text of the window (spaces stand in for non-content). */
  text: string;
  /** Document offset for each image-text index (length text.length + 1). */
  toDoc: (imagePos: number) => number;
  /** Image index for a document offset (clamps into the window). */
  fromDoc: (docPos: number) => number;
}

/**
 * Materialize the image for a document window — the search panel and
 * clipboard use this; word motion uses imageSegments directly.
 */
export function buildImageWindow(
  doc: VisualDoc,
  docText: string,
  from: number,
  to: number,
): ImageWindow {
  const segments = imageSegments(doc, from, to);
  let text = "";
  const starts: number[] = []; // image start index per segment
  for (const seg of segments) {
    starts.push(text.length);
    text += seg.kind === "text" ? docText.slice(seg.from, seg.to) : " ";
  }

  const toDoc = (imagePos: number): number => {
    if (segments.length === 0) return from;
    let lo = 0;
    let hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= imagePos) lo = mid;
      else hi = mid - 1;
    }
    const seg = segments[lo];
    const offset = imagePos - starts[lo];
    return seg.kind === "text"
      ? Math.min(seg.from + offset, seg.to)
      : offset <= 0
        ? seg.from
        : seg.to;
  };

  const fromDoc = (docPos: number): number => {
    if (segments.length === 0) return 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (docPos < seg.from) return starts[i];
      if (docPos < seg.to) {
        return seg.kind === "text" ? starts[i] + (docPos - seg.from) : starts[i];
      }
    }
    return text.length;
  };

  return { text, toDoc, fromDoc };
}

const isWordChar = (ch: string): boolean => /[\p{L}\p{N}_]/u.test(ch);

/**
 * The next word boundary in the visible image from `docPos` in `dir`.
 * Word chars are Unicode letters/digits/underscore over the image text —
 * hidden markup neither counts as word characters nor blocks a word from
 * continuing across it (an invisible `}` must not create a phantom stop).
 */
export function imageWordBoundary(
  doc: VisualDoc,
  docText: string,
  docPos: number,
  dir: 1 | -1,
): number {
  // A generous local window keeps this O(paragraph), not O(document).
  const windowFrom = Math.max(0, docPos - 2000);
  const windowTo = Math.min(docText.length, docPos + 2000);
  const win = buildImageWindow(doc, docText, windowFrom, windowTo);
  let i = win.fromDoc(docPos);

  if (dir > 0) {
    const n = win.text.length;
    while (i < n && !isWordChar(win.text[i])) i++;
    while (i < n && isWordChar(win.text[i])) i++;
  } else {
    while (i > 0 && !isWordChar(win.text[i - 1])) i--;
    while (i > 0 && isWordChar(win.text[i - 1])) i--;
  }
  return win.toDoc(i);
}
