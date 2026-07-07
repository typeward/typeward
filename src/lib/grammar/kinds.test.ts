import { describe, expect, it } from "vitest";

import {
  familyForKind,
  familyMetaForKind,
  GRAMMAR_FAMILIES,
  GRAMMAR_FAMILY_META,
  humanizeKind,
  type GrammarFamily,
} from "./kinds";

const EXPECTED: Record<string, GrammarFamily> = {
  Spelling: "spelling",
  Typo: "spelling",
  Malapropism: "spelling",
  Eggcorn: "spelling",
  Grammar: "grammar",
  Agreement: "grammar",
  BoundaryError: "grammar",
  Capitalization: "grammar",
  Punctuation: "grammar",
  Style: "style",
  Enhancement: "style",
  Readability: "style",
  Redundancy: "style",
  Repetition: "style",
  Formatting: "style",
  WordChoice: "misc",
  Miscellaneous: "misc",
  Nonstandard: "misc",
  Regionalism: "misc",
  Usage: "misc",
};

describe("familyForKind", () => {
  it("maps all 20 LintKind keys to the documented family", () => {
    expect(Object.keys(EXPECTED)).toHaveLength(20);
    for (const [kind, family] of Object.entries(EXPECTED)) {
      expect(familyForKind(kind)).toBe(family);
    }
  });

  it("falls back to misc for unknown kinds", () => {
    expect(familyForKind("SomethingHarperAddedLater")).toBe("misc");
    expect(familyForKind("")).toBe("misc");
  });

  it("resolves meta (label + css var) for every family", () => {
    for (const family of GRAMMAR_FAMILIES) {
      const meta = GRAMMAR_FAMILY_META[family];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.cssVar).toMatch(/^var\(--color-/);
    }
  });

  it("familyMetaForKind matches familyForKind", () => {
    expect(familyMetaForKind("Typo")).toBe(GRAMMAR_FAMILY_META.spelling);
    expect(familyMetaForKind("unknown")).toBe(GRAMMAR_FAMILY_META.misc);
  });
});

describe("humanizeKind", () => {
  it("splits camelCase compound kinds", () => {
    expect(humanizeKind("WordChoice")).toBe("Word Choice");
    expect(humanizeKind("BoundaryError")).toBe("Boundary Error");
  });

  it("passes single words through", () => {
    expect(humanizeKind("Spelling")).toBe("Spelling");
  });
});
