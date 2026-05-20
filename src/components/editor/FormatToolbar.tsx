import {
  AtSign,
  Bold,
  Code2,
  Heading1,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Pi,
  Quote,
  Sigma,
  Table2,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For } from "solid-js";
import type { ProjectFormat } from "~/adapters/types";
import { project } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";

// Each snippet uses `$|` to mark where the caret should land after insert.
// Strip the marker to get the literal text; cursor offset = marker index.
type Kind =
  | "bold"
  | "italic"
  | "code"
  | "heading"
  | "list"
  | "orderedList"
  | "quote"
  | "inlineMath"
  | "equation"
  | "figure"
  | "table"
  | "link"
  | "citation";

const SNIPPETS: Record<ProjectFormat, Record<Kind, string>> = {
  latex: {
    bold: "\\textbf{$|}",
    italic: "\\textit{$|}",
    code: "\\texttt{$|}",
    heading: "\\section{$|}\n",
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
    code: "`$|`",
    heading: "= $|",
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
};

const insertSnippet = (kind: Kind) => {
  const view = getActiveEditorView();
  if (!view) return;
  const fmt = project()?.format ?? "latex";
  const raw = SNIPPETS[fmt][kind];
  const caretMarker = raw.indexOf("$|");
  const text = caretMarker >= 0 ? raw.replace("$|", "") : raw;
  const head = view.state.selection.main.head;
  const cursorOffset = caretMarker >= 0 ? caretMarker : text.length;

  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + cursorOffset },
    scrollIntoView: true,
  });
  view.focus();
};

interface ToolBtn {
  kind: Kind;
  label: string;
  icon: (size: number) => JSX.Element;
}

const STYLE_GROUP: ToolBtn[] = [
  { kind: "bold", label: "Bold", icon: (s) => <Bold size={s} /> },
  { kind: "italic", label: "Italic", icon: (s) => <Italic size={s} /> },
  { kind: "code", label: "Inline code", icon: (s) => <Code2 size={s} /> },
];

const STRUCTURE_GROUP: ToolBtn[] = [
  { kind: "heading", label: "Heading", icon: (s) => <Heading1 size={s} /> },
  { kind: "list", label: "Bulleted list", icon: (s) => <List size={s} /> },
  {
    kind: "orderedList",
    label: "Numbered list",
    icon: (s) => <ListOrdered size={s} />,
  },
  { kind: "quote", label: "Block quote", icon: (s) => <Quote size={s} /> },
];

const INSERT_GROUP: ToolBtn[] = [
  { kind: "inlineMath", label: "Inline math", icon: (s) => <Pi size={s} /> },
  { kind: "equation", label: "Equation", icon: (s) => <Sigma size={s} /> },
  { kind: "figure", label: "Figure", icon: (s) => <ImageIcon size={s} /> },
  { kind: "table", label: "Table", icon: (s) => <Table2 size={s} /> },
  { kind: "link", label: "Link", icon: (s) => <LinkIcon size={s} /> },
  { kind: "citation", label: "Citation", icon: (s) => <AtSign size={s} /> },
];

/**
 * Format toolbar mounted below the file-tabs strip in the editor pane.
 * Three groups separated by vertical dividers: text style, document
 * structure, insert. Each button inserts a format-aware snippet at the
 * caret (LaTeX / Typst).
 */
export const FormatToolbar: Component = () => {
  return (
    <div class="flex h-9 flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-glass-stroke px-2 scroll">
      <ToolGroup buttons={STYLE_GROUP} />
      <Divider />
      <ToolGroup buttons={STRUCTURE_GROUP} />
      <Divider />
      <ToolGroup buttons={INSERT_GROUP} />
    </div>
  );
};

const ToolGroup: Component<{ buttons: ToolBtn[] }> = (props) => (
  <For each={props.buttons}>
    {(b) => (
      <button
        type="button"
        onClick={() => insertSnippet(b.kind)}
        title={b.label}
        aria-label={`Insert ${b.label}`}
        class="lift flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-[var(--color-control-fill-hover)] hover:text-fg-1"
      >
        {b.icon(13)}
      </button>
    )}
  </For>
);

const Divider: Component = () => (
  <div class="mx-1 h-4 w-px flex-shrink-0" style={{ background: "var(--color-control-stroke)" }} />
);
