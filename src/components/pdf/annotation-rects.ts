/**
 * Glyph-level refinement of a thread highlight: matches an annotation's source
 * anchor text against the page's pdfjs text items and returns per-line word
 * rects in top-origin PDF points. Pure (no pdfjs import) so it unit-tests
 * without a worker. Reuses anchor.ts's masking/normalization/tokenizer so the
 * PDF-side matcher and the source-side matcher can never disagree on what a
 * word is. Below-threshold answers are null, never a guess — the caller falls
 * back to the SyncTeX box or the coarse band.
 */

import { maskMarkup, normalizeWord, wordRe } from "~/lib/pdf-annotations/anchor";

export interface PtRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Mirrors matchSelectionToSource's threshold — keep the two in lockstep. */
const MIN_SCORE = 0.6;

/** Vertical slop when testing item centers against the SyncTeX hbox. */
const BOX_SLOP_PT = 3;
/** Fallback window around the SyncTeX baseline: text sits mostly above `y`
 * (y is the baseline of the last line of the paragraph's first hbox), so the
 * window is asymmetric. */
const BAND_ABOVE_PT = 20;
const BAND_BELOW_PT = 8;
/** One-shot widened window for wrapped paragraphs SyncTeX attributed to a
 * neighboring line — bounded so a same-phrase match elsewhere on the page
 * can't be picked up. */
const WIDE_WINDOW_PT = 45;

/** Two typeset lines closer than this share a baseline group. */
const BASELINE_GROUP_PT = 2;

interface WordBox {
  norm: string;
  rect: PtRect;
  baseline: number;
}

function itemWords(
  items: Array<{ str: string; transform: number[]; width: number; height: number }>,
  pageHeightPt: number,
): WordBox[] {
  const out: WordBox[] = [];
  for (const item of items) {
    if (item.str.length === 0) continue;
    const left = item.transform[4];
    const baseline = pageHeightPt - item.transform[5];
    const top = baseline - item.height;
    // Per-word sub-rects prorated by char count — pdfjs reports one width per
    // item, not per glyph; close enough for a highlight band.
    const charW = item.width / item.str.length;
    const re = wordRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(item.str)) !== null) {
      const norm = normalizeWord(m[0]);
      if (!norm) continue;
      out.push({
        norm,
        rect: {
          left: left + m.index * charW,
          top,
          width: m[0].length * charW,
          height: item.height,
        },
        baseline,
      });
    }
  }
  // Reading order: baseline-major, left-minor (with the same tolerance the
  // merge uses, so a jittered baseline doesn't interleave two lines).
  out.sort((a, b) =>
    Math.abs(a.baseline - b.baseline) < BASELINE_GROUP_PT
      ? a.rect.left - b.rect.left
      : a.baseline - b.baseline,
  );
  return out;
}

function mergePerBaseline(words: WordBox[]): PtRect[] {
  const rects: PtRect[] = [];
  let group: WordBox[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const left = Math.min(...group.map((w) => w.rect.left));
    const right = Math.max(...group.map((w) => w.rect.left + w.rect.width));
    const top = Math.min(...group.map((w) => w.rect.top));
    const bottom = Math.max(...group.map((w) => w.rect.top + w.rect.height));
    rects.push({ left, top, width: right - left, height: bottom - top });
    group = [];
  };
  for (const w of words) {
    if (group.length > 0 && Math.abs(w.baseline - group[0].baseline) >= BASELINE_GROUP_PT) {
      flush();
    }
    group.push(w);
  }
  flush();
  return rects;
}

/** Slide the anchor word sequence over the candidate stream — the same
 * ≥ MIN_SCORE match-ratio scoring as matchSelectionToSource, including its
 * single-word fallback when the window holds fewer words than the anchor. */
function matchWords(words: WordBox[], anchor: string[]): WordBox[] | null {
  const n = anchor.length;
  if (words.length < n) {
    const single = words.find((w) => w.norm === anchor[0]);
    return single ? [single] : null;
  }
  let bestScore = 0;
  let bestIdx = -1;
  for (let i = 0; i + n <= words.length; i++) {
    let matches = 0;
    for (let j = 0; j < n; j++) {
      if (words[i + j].norm === anchor[j]) matches++;
    }
    const score = matches / n;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < MIN_SCORE) return null;
  return words.slice(bestIdx, bestIdx + n);
}

/**
 * @param items        pdfjs text items for the page (str + transform + extents)
 * @param pageHeightPt unscaled page height — pdfjs baselines are bottom-origin
 * @param ann          the annotation's SyncTeX geometry + source anchor text
 * @returns one merged rect per typeset line of the matched anchor, or null.
 */
export function locateAnchorRects(
  items: Array<{ str: string; transform: number[]; width: number; height: number }>,
  pageHeightPt: number,
  ann: { y: number; box?: PtRect | null; anchorText: string },
): PtRect[] | null {
  const anchorRe = wordRe();
  const masked = maskMarkup(ann.anchorText);
  const anchor: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(masked)) !== null) {
    const norm = normalizeWord(m[0]);
    if (norm) anchor.push(norm);
  }
  if (anchor.length === 0) return null;

  const words = itemWords(items, pageHeightPt);
  if (words.length === 0) return null;

  const box = ann.box ?? null;
  const narrow: [number, number] = box
    ? [box.top - BOX_SLOP_PT, box.top + box.height + BOX_SLOP_PT]
    : [ann.y - BAND_ABOVE_PT, ann.y + BAND_BELOW_PT];
  const center = box ? box.top + box.height / 2 : ann.y;
  const wide: [number, number] = [center - WIDE_WINDOW_PT, center + WIDE_WINDOW_PT];

  for (const [lo, hi] of [narrow, wide]) {
    const candidates = words.filter((w) => {
      const vc = w.rect.top + w.rect.height / 2;
      return vc >= lo && vc <= hi;
    });
    if (candidates.length === 0) continue;
    const matched = matchWords(candidates, anchor);
    if (matched) return mergePerBaseline(matched);
  }
  return null;
}
