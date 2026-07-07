/**
 * Harper `LintKind` → visual family mapping — the single source of truth for
 * how a grammar lint is colored, labelled, and grouped across the editor
 * underline, the tooltip chip, and the Problems panel.
 *
 * Four families, each bound to a status token:
 *  - spelling (`--color-err`, red)   — outright errors: misspellings, typos.
 *  - grammar  (`--color-warn`, amber) — structural: agreement, punctuation.
 *  - style    (`--color-ok`, green)   — advisory prose polish.
 *  - misc     (`--color-info`, blue)  — word choice / usage / regionalisms.
 *
 * The 20 keys below mirror Harper's `LintKind` enum. Anything Harper adds that
 * isn't listed degrades to `misc` (the blue, lowest-urgency bucket).
 */

export type GrammarFamily = "spelling" | "grammar" | "style" | "misc";

export interface GrammarFamilyMeta {
  /** Human-facing chip label. */
  label: string;
  /** Theme token as a ready-to-use `var(--…)` reference. */
  cssVar: string;
}

export const GRAMMAR_FAMILIES: readonly GrammarFamily[] = [
  "spelling",
  "grammar",
  "style",
  "misc",
];

export const GRAMMAR_FAMILY_META: Record<GrammarFamily, GrammarFamilyMeta> = {
  spelling: { label: "Spelling", cssVar: "var(--color-err)" },
  grammar: { label: "Grammar", cssVar: "var(--color-warn)" },
  style: { label: "Style", cssVar: "var(--color-ok)" },
  misc: { label: "Miscellaneous", cssVar: "var(--color-info)" },
};

const KIND_TO_FAMILY: Record<string, GrammarFamily> = {
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

export function familyForKind(kind: string): GrammarFamily {
  return KIND_TO_FAMILY[kind] ?? "misc";
}

export function familyMetaForKind(kind: string): GrammarFamilyMeta {
  return GRAMMAR_FAMILY_META[familyForKind(kind)];
}

/** "WordChoice" -> "Word Choice"; a bare word passes through unchanged. */
export function humanizeKind(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2");
}
