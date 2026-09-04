import { describe, it, expect } from "vitest";
import { locateAnchorRects } from "./annotation-rects";

const PAGE_H = 792;

/** pdfjs-shaped text item: transform[5] is the bottom-origin baseline, so a
 * top-origin `baselineTop` here maps to PAGE_H - baselineTop. */
function item(
  str: string,
  left: number,
  baselineTop: number,
  width: number,
  height = 10,
) {
  return { str, transform: [1, 0, 0, 1, left, PAGE_H - baselineTop], width, height };
}

describe("locateAnchorRects", () => {
  it("matches an anchor wrapped across two typeset lines as two merged rects", () => {
    const items = [
      item("the quick brown fox", 72, 100, 95),
      item("jumps over the lazy dog", 72, 112, 118),
    ];
    const rects = locateAnchorRects(items, PAGE_H, {
      y: 100,
      anchorText: "the quick brown fox jumps over the lazy dog",
    });
    expect(rects).not.toBeNull();
    expect(rects!.length).toBe(2);
    expect(rects![0].top).toBeCloseTo(90);
    expect(rects![1].top).toBeCloseTo(102);
    expect(rects![0].left).toBeCloseTo(72);
    expect(rects![1].left).toBeCloseTo(72);
  });

  it("matches markup-bearing anchor text against plain rendered words", () => {
    // 33 chars over 330pt: charW = 10, "main" starts at char 9, "holds" ends
    // at char 27 — the rect covers exactly the matched word run.
    const items = [item("We prove main theorem holds today", 72, 100, 330)];
    const rects = locateAnchorRects(items, PAGE_H, {
      y: 100,
      anchorText: "\\textbf{main theorem} holds",
    });
    expect(rects).not.toBeNull();
    expect(rects!.length).toBe(1);
    expect(rects![0].left).toBeCloseTo(72 + 9 * 10);
    expect(rects![0].left + rects![0].width).toBeCloseTo(72 + 27 * 10);
  });

  it("matches ligature glyphs through normalizeWord", () => {
    const items = [item("the ﬁnal ﬁgure", 72, 100, 70)];
    const rects = locateAnchorRects(items, PAGE_H, {
      y: 100,
      anchorText: "the final figure",
    });
    expect(rects).not.toBeNull();
    expect(rects!.length).toBe(1);
  });

  it("returns null below the match threshold instead of guessing", () => {
    const items = [item("the quick brown fox", 72, 100, 95)];
    const rects = locateAnchorRects(items, PAGE_H, {
      y: 100,
      anchorText: "completely unrelated words here",
    });
    expect(rects).toBeNull();
  });

  it("uses the SyncTeX box to pick the right instance of a repeated phrase", () => {
    const items = [
      item("the quick brown fox", 72, 100, 95),
      item("the quick brown fox", 72, 300, 95),
    ];
    const rects = locateAnchorRects(items, PAGE_H, {
      y: 300,
      box: { left: 72, top: 290, width: 95, height: 10 },
      anchorText: "the quick brown fox",
    });
    expect(rects).not.toBeNull();
    expect(rects!.length).toBe(1);
    expect(rects![0].top).toBeCloseTo(290);
  });

  it("widens the candidate window once when the narrow band misses", () => {
    // Text sits 35pt below the SyncTeX baseline — outside [y-20, y+8], inside
    // the one-shot +-45pt window.
    const items = [item("the quick brown fox", 72, 135, 95)];
    const rects = locateAnchorRects(items, PAGE_H, {
      y: 100,
      anchorText: "the quick brown fox",
    });
    expect(rects).not.toBeNull();
    expect(rects![0].top).toBeCloseTo(125);
  });
});
