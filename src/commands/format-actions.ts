import { activeFile, project } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";

/**
 * Format-aware editing actions shared by the FormatToolbar buttons and the
 * visual-mode palette commands. Word-processor semantics: with a selection,
 * inline styles and blocks WRAP it (and lists convert the selected lines to
 * items); with a bare caret they insert the empty construct with the cursor
 * placed inside.
 */

// Each snippet uses `$|` to mark where the caret should land after insert.
// Text before the marker is the wrap prefix, text after it the wrap suffix.
export type FormatKind =
  | "bold"
  | "italic"
  | "underline"
  | "code"
  | "heading"
  | "heading2"
  | "heading3"
  | "list"
  | "orderedList"
  | "quote"
  | "inlineMath"
  | "equation"
  | "figure"
  | "table"
  | "link"
  | "citation";

/** Markup dialects the formatting actions can write. */
export type FormattingLanguage = "latex" | "typst" | "markdown";

// Deliberately its own table, NOT languages.ts EXT_TO_LANGUAGE: that one
// answers "which highlighter/LSP" and maps .bib to "latex" — but a .bib
// database must get no prose formatting at all (Bold inside an entry would
// corrupt it), so here .bib and every non-prose extension resolve to null.
const FORMATTING_EXT: Record<string, FormattingLanguage> = {
  tex: "latex",
  sty: "latex",
  cls: "latex",
  typ: "typst",
  md: "markdown",
  markdown: "markdown",
};

export function formattingLanguageForPath(
  relPath: string,
): FormattingLanguage | null {
  const dot = relPath.lastIndexOf(".");
  const ext = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : "";
  return FORMATTING_EXT[ext] ?? null;
}

/**
 * Dialect of the active tab, or null when no tab is active or the file takes
 * no prose formatting. The FormatToolbar and the format.* command gates key
 * off this so the Bold affordance disappears entirely on a .bib file.
 */
export function activeFormattingLanguage(): FormattingLanguage | null {
  const f = activeFile();
  return f ? formattingLanguageForPath(f.relPath) : null;
}

const SNIPPETS: {
  latex: Record<FormatKind, string>;
  typst: Record<FormatKind, string>;
  // Markdown has no underline construct — the key is absent on purpose and
  // consumers treat a missing snippet as "unsupported in this dialect".
  markdown: Omit<Record<FormatKind, string>, "underline">;
} = {
  latex: {
    bold: "\\textbf{$|}",
    italic: "\\textit{$|}",
    underline: "\\underline{$|}",
    code: "\\texttt{$|}",
    heading: "\\section{$|}\n",
    heading2: "\\subsection{$|}\n",
    heading3: "\\subsubsection{$|}\n",
    list: "\\begin{itemize}\n  \\item $|\n\\end{itemize}\n",
    orderedList: "\\begin{enumerate}\n  \\item $|\n\\end{enumerate}\n",
    quote: "\\begin{quote}\n  $|\n\\end{quote}\n",
    inlineMath: "$$|$",
    equation: "\\begin{equation}\n  $|\n\\end{equation}\n",
    figure:
      "\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{$|}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}\n",
    table:
      "\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{cc}\n    $| & \\\\\n  \\end{tabular}\n  \\caption{}\n\\end{table}\n",
    link: "\\href{$|}{text}",
    citation: "\\cite{$|}",
  },
  typst: {
    bold: "*$|*",
    italic: "_$|_",
    underline: "#underline[$|]",
    code: "`$|`",
    heading: "= $|",
    heading2: "== $|",
    heading3: "=== $|",
    list: "- $|\n- ",
    orderedList: "+ $|\n+ ",
    quote: "#quote(block: true)[$|]\n",
    inlineMath: "$$|$",
    equation: "$ $|  $\n",
    figure: '#figure(\n  image("$|"),\n  caption: [],\n)\n',
    table: "#table(\n  columns: 2,\n  [$|], [],\n)\n",
    link: '#link("$|")[text]',
    citation: "@$|",
  },
  markdown: {
    bold: "**$|**",
    italic: "*$|*",
    code: "`$|`",
    heading: "# $|\n",
    heading2: "## $|\n",
    heading3: "### $|\n",
    list: "- $|\n- ",
    orderedList: "1. $|\n2. ",
    quote: "> $|\n",
    inlineMath: "$$|$",
    equation: "$$\n$|\n$$\n",
    figure: "![]($|)",
    table: "| $| |  |\n| --- | --- |\n|  |  |\n",
    link: "[text]($|)",
    // Pandoc-style bracketed citekey — the one citation syntax the wider
    // markdown toolchain agrees on. The in-app preview shows it literally,
    // which is the honest rendering for a plain-markdown file.
    citation: "[@$|]",
  },
};

const snippetFor = (
  lang: FormattingLanguage,
  kind: FormatKind,
): string | undefined =>
  (SNIPPETS[lang] as Partial<Record<FormatKind, string>>)[kind];

/** Whether a dialect has a construct for `kind` (markdown lacks underline). */
export const supportsFormat = (
  lang: FormattingLanguage,
  kind: FormatKind,
): boolean => snippetFor(lang, kind) !== undefined;

/**
 * Kinds where a non-empty selection becomes the construct's content. The
 * others ("figure", "table", "link", "citation") take their content in a
 * slot the selection doesn't map onto, so they keep caret-insert semantics.
 */
const WRAP_KINDS: ReadonlySet<FormatKind> = new Set([
  "bold",
  "italic",
  "underline",
  "code",
  "heading",
  "heading2",
  "heading3",
  "quote",
  "inlineMath",
  "equation",
]);

const listBlock = (
  lang: FormattingLanguage,
  kind: "list" | "orderedList",
  lines: string[],
): string => {
  if (lang === "markdown") {
    const items = lines.map((l, i) =>
      kind === "list" ? `- ${l}` : `${i + 1}. ${l}`,
    );
    return `${items.join("\n")}\n`;
  }
  if (lang === "typst") {
    const marker = kind === "list" ? "-" : "+";
    return `${lines.map((l) => `${marker} ${l}`).join("\n")}\n`;
  }
  const env = kind === "list" ? "itemize" : "enumerate";
  const items = lines.map((l) => `  \\item ${l}`).join("\n");
  return `\\begin{${env}}\n${items}\n\\end{${env}}\n`;
};

export function applyFormat(kind: FormatKind): void {
  const view = getActiveEditorView();
  if (!view) return;
  // The active FILE decides the dialect — a README.md inside a LaTeX project
  // must get **markdown** syntax, never \textbf{}. The project format is only
  // the fallback for views not backed by a tab. Files with no formatting
  // dialect (.bib, images) and constructs the dialect lacks (underline in
  // markdown) no-op.
  const file = activeFile();
  const lang = file
    ? formattingLanguageForPath(file.relPath)
    : (project()?.format ?? "latex");
  if (lang === null) return;
  const raw = snippetFor(lang, kind);
  if (raw === undefined) return;
  const sel = view.state.selection.main;

  // Selected lines → list items (the Word gesture for "make this a list").
  if (!sel.empty && (kind === "list" || kind === "orderedList")) {
    const lines = view.state
      .sliceDoc(sel.from, sel.to)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length > 0) {
      const block = listBlock(lang, kind, lines);
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: block },
        selection: { anchor: sel.from + block.length },
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
  }

  const marker = raw.indexOf("$|");
  const prefix = marker >= 0 ? raw.slice(0, marker) : raw;
  const suffix = marker >= 0 ? raw.slice(marker + 2) : "";

  // Selection wrap: the selected text becomes the content and stays selected
  // so repeated formatting (bold, then italic) keeps compounding.
  if (!sel.empty && marker >= 0 && WRAP_KINDS.has(kind)) {
    const selected = view.state.sliceDoc(sel.from, sel.to);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: prefix + selected + suffix },
      selection: {
        anchor: sel.from + prefix.length,
        head: sel.from + prefix.length + selected.length,
      },
      scrollIntoView: true,
    });
    view.focus();
    return;
  }

  // Bare caret: insert the empty construct, cursor at the marker.
  const head = sel.head;
  const text = prefix + suffix;
  const cursorOffset = marker >= 0 ? marker : text.length;
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + cursorOffset },
    scrollIntoView: true,
  });
  view.focus();
}
