import type { GrammarSyntax } from "~/ipc";

/**
 * Editor language for a single file. This is per-FILE, not per-project: a
 * Typst or LaTeX project routinely contains `.md` and `.bib` files that each
 * need their own syntax highlighting, grammar dialect, and (non-)LSP routing.
 *
 * This module is the single source of truth for that dispatch — the editor
 * shell, CodeMirror, the grammar wiring, and the LSP wiring all derive from it
 * instead of each hand-maintaining a parallel extension->language table (the
 * old shape, where three near-identical mappers drifted independently).
 */
export type EditorLanguage = "latex" | "markdown" | "typst" | "plain";

/** Languages that ship a language server (texlab / tinymist). */
export type LspLanguage = "latex" | "typst";

const EXT_TO_LANGUAGE: Record<string, EditorLanguage> = {
  tex: "latex",
  bib: "latex",
  typ: "typst",
  md: "markdown",
};

export function languageForFile(relPath: string): EditorLanguage {
  const dot = relPath.lastIndexOf(".");
  const ext = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : "";
  return EXT_TO_LANGUAGE[ext] ?? "plain";
}

/**
 * Which right-pane preview a file drives: markdown files get the in-app HTML
 * preview, everything else the compiled-PDF viewer.
 */
export function previewKindForFile(relPath: string): "markdown" | "pdf" {
  return languageForFile(relPath) === "markdown" ? "markdown" : "pdf";
}

const LANGUAGE_TO_GRAMMAR: Record<EditorLanguage, GrammarSyntax> = {
  latex: "latex",
  typst: "typst",
  markdown: "markdown",
  plain: "plain",
};

export function grammarSyntaxForLanguage(lang: EditorLanguage): GrammarSyntax {
  return LANGUAGE_TO_GRAMMAR[lang];
}

const LANGUAGE_TO_LSP: Record<EditorLanguage, LspLanguage | null> = {
  latex: "latex",
  typst: "typst",
  markdown: null,
  plain: null,
};

export function lspLanguageForFile(relPath: string): LspLanguage | null {
  return LANGUAGE_TO_LSP[languageForFile(relPath)];
}

const LSP_LANGUAGES: readonly LspLanguage[] = ["latex", "typst"];

/**
 * Narrow an adapter's `languageId` to a known LSP language, or null when the
 * format ships no language server.
 */
export function asLspLanguage(id: string): LspLanguage | null {
  return (LSP_LANGUAGES as readonly string[]).includes(id)
    ? (id as LspLanguage)
    : null;
}
