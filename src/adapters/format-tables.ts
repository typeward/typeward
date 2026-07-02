import type { ProjectFormat } from "./types";

/**
 * Per-format prose/markup facts that feature UI needs. Keyed by an exhaustive
 * `Record<ProjectFormat, ...>` so adding a format fails to compile until every
 * table here is extended — the same lockstep guarantee FormatToolbar's snippet
 * table gives, applied to the branches that used to live inline in feature
 * components (citation insertion, word-count markup stripping).
 */

const CITATION: Record<ProjectFormat, (key: string) => string> = {
  latex: (key) => `\\cite{${key}}`,
  typst: (key) => `@${key}`,
};

/** How a citation key is inserted into source for each format. */
export function citationSnippet(format: ProjectFormat, key: string): string {
  return CITATION[format](key);
}

const STRIP_MARKUP: Record<ProjectFormat, (text: string) => string> = {
  latex: (t) => t.replace(/(^|[^\\])%.*$/gm, "$1").replace(/\\[a-zA-Z@]+\*?/g, " "),
  typst: (t) => t.replace(/\/\/.*$/gm, "").replace(/#[a-zA-Z][\w.]*/g, " "),
};

/**
 * Strip format-specific line comments + markup tokens ahead of an approximate
 * word count. The caller applies the format-agnostic punctuation strip.
 */
export function stripMarkupForWordCount(text: string, format: ProjectFormat): string {
  return STRIP_MARKUP[format](text);
}
