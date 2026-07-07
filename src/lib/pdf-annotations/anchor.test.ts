import { describe, it, expect } from "vitest";
import { matchSelectionToSource } from "./anchor";

describe("matchSelectionToSource", () => {
  const source = [
    "\\section{Introduction}",
    "The quick brown fox jumps over the lazy dog.",
    "We prove \\textbf{the main theorem} here. % TODO check",
    "Another paragraph entirely.",
  ].join("\n");

  it("anchors a multi-word selection to the source offsets", () => {
    const m = matchSelectionToSource(source, 2, "quick brown fox");
    expect(m).not.toBeNull();
    expect(source.slice(m!.fromOffset, m!.toOffset)).toBe("quick brown fox");
  });

  it("strips markup so words inside commands match", () => {
    const m = matchSelectionToSource(source, 3, "the main theorem");
    expect(m).not.toBeNull();
    expect(source.slice(m!.fromOffset, m!.toOffset)).toBe("the main theorem");
  });

  it("tolerates a minority of mismatched words", () => {
    // 3 of 4 words match ("quick brown fox" present, "cat" doesn't) → 0.75.
    const m = matchSelectionToSource(source, 2, "quick brown fox cat");
    expect(m).not.toBeNull();
  });

  it("returns null when nothing matches well enough", () => {
    expect(matchSelectionToSource(source, 2, "completely unrelated words here")).toBeNull();
  });

  it("falls back to a single word when the selection is one word", () => {
    const m = matchSelectionToSource(source, 2, "lazy");
    expect(m).not.toBeNull();
    expect(source.slice(m!.fromOffset, m!.toOffset)).toBe("lazy");
  });
});
