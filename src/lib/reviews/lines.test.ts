import { describe, it, expect } from "vitest";
import { lineRange, offsetToLine, toLF } from "./lines";

describe("toLF", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(toLF("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
  it("returns the input unchanged when no CR is present", () => {
    const s = "a\nb";
    expect(toLF(s)).toBe(s);
  });
  it("maps LF-space offsets to the CM6 line for CRLF files", () => {
    const crlf = "one\r\ntwo\r\nthree\r\nfour body";
    const lf = toLF(crlf);
    expect(lf.indexOf("four")).toBe(14); // the CM6/LF-space anchor offset
    expect(offsetToLine(lf, 14)).toBe(4);
    // The same offset over the raw disk text lands a line early — the bug
    // toLF exists to prevent.
    expect(offsetToLine(crlf, 14)).toBe(3);
  });
});

describe("offsetToLine", () => {
  const doc = "line1\nline2\nline3";
  it("is 1-based and counts newlines before the offset", () => {
    expect(offsetToLine(doc, 0)).toBe(1);
    expect(offsetToLine(doc, 3)).toBe(1);
    expect(offsetToLine(doc, 6)).toBe(2); // just after the first \n
    expect(offsetToLine(doc, doc.length)).toBe(3);
  });
  it("clamps out-of-range offsets", () => {
    expect(offsetToLine(doc, -5)).toBe(1);
    expect(offsetToLine(doc, 9999)).toBe(3);
  });
});

describe("lineRange", () => {
  const doc = "line1\nline2\nline3";
  it("returns the [from,to) span of a 1-based line, excluding the newline", () => {
    expect(lineRange(doc, 1)).toEqual({ from: 0, to: 5 });
    expect(lineRange(doc, 2)).toEqual({ from: 6, to: 11 });
    expect(lineRange(doc, 3)).toEqual({ from: 12, to: 17 }); // last line, no trailing \n
    expect(doc.slice(6, 11)).toBe("line2");
  });
  it("clamps a past-EOF line to the last line", () => {
    expect(lineRange(doc, 99)).toEqual({ from: 12, to: 17 });
  });
  it("handles a trailing newline and empty content", () => {
    expect(lineRange("a\n", 2)).toEqual({ from: 2, to: 2 });
    expect(lineRange("", 1)).toEqual({ from: 0, to: 0 });
  });
});
