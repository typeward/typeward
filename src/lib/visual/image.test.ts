import { describe, expect, it } from "vitest";

import { buildImageWindow, imageSegments, imageWordBoundary } from "./image";
import { parseVisualDoc, type VisualDoc } from "./parse";

function parse(text: string): VisualDoc {
  const doc = parseVisualDoc(text, { now: () => 0 });
  if (doc === null) throw new Error("unexpected abort");
  return doc;
}

describe("visible image", () => {
  it("reads styled text without its markup", () => {
    const text = "Plain \\textbf{bold} tail";
    const doc = parse(text);
    const win = buildImageWindow(doc, text, 0, text.length);
    expect(win.text).toBe("Plain  bold  tail");
  });

  it("maps image offsets back into the document", () => {
    const text = "A \\textbf{bc} d";
    const doc = parse(text);
    const win = buildImageWindow(doc, text, 0, text.length);
    const imgIdx = win.text.indexOf("bc");
    const docIdx = win.toDoc(imgIdx);
    expect(text.slice(docIdx, docIdx + 2)).toBe("bc");
    expect(win.fromDoc(docIdx)).toBe(imgIdx);
  });

  it("word motion crosses hidden wrappers without phantom stops", () => {
    const text = "alpha \\textbf{beta} gamma";
    const doc = parse(text);
    // From inside "beta", a forward word jump lands after "beta" (not at the
    // hidden brace), and the next one lands after "gamma".
    const betaStart = text.indexOf("beta");
    const afterBeta = imageWordBoundary(doc, text, betaStart, 1);
    expect(text.slice(betaStart, afterBeta)).toBe("beta");
    const afterGamma = imageWordBoundary(doc, text, afterBeta, 1);
    expect(text.slice(afterGamma - 5, afterGamma)).toBe("gamma");
    // Backward from just after "beta" lands at its start.
    expect(imageWordBoundary(doc, text, afterBeta, -1)).toBe(betaStart);
  });

  it("treats widgets as single space-class units", () => {
    const text = "see \\cite{knuth} now";
    const doc = parse(text);
    const segs = imageSegments(doc, 0, text.length);
    const spaceSegs = segs.filter((s) => s.kind === "space");
    expect(spaceSegs).toHaveLength(1);
    const win = buildImageWindow(doc, text, 0, text.length);
    expect(win.text).toBe("see   now");
  });
});
