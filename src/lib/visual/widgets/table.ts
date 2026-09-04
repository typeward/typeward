/**
 * Read-only table widget: renders a tabular body as a formatted table.
 * Editing goes through the popover (in-place cell editing is a later
 * phase). Cells are shown as text with trivial style wrappers stripped;
 * a cell the stripper can't make markup-free demotes the whole preview to
 * the labeled card (never raw markup on the page).
 */

import { WidgetType } from "@codemirror/view";

export interface ParsedTable {
  rows: string[][];
  caption: string | null;
}

/** Strip wrappers a table cell commonly carries; null = still markup-y. */
function cellText(src: string): string | null {
  let s = src.trim();
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s
      .replace(/\\(?:textbf|textit|texttt|emph|underline|mathrm|text)\{([^{}]*)\}/g, "$1")
      .replace(/\\multicolumn\{\d+\}\{[^{}]*\}\{([^{}]*)\}/g, "$1")
      .replace(/\$([^$]*)\$/g, "$1")
      .replace(/\\(?:hline|toprule|midrule|bottomrule|centering|small|footnotesize)\b/g, "")
      .replace(/\\%/g, "%")
      .replace(/\\&/g, "&")
      .replace(/\\_/g, "_")
      .replace(/\\#/g, "#");
    if (s === before) break;
  }
  s = s.trim();
  return /\\[a-zA-Z]|[{}]/.test(s) ? null : s;
}

/** Parse the innermost tabular of an env body. Null = not previewable. */
export function parseTabular(body: string): ParsedTable | null {
  let cells = body;
  const begin = /\\begin\{tabular\*?\}/.exec(cells);
  if (begin) {
    let i = begin.index + begin[0].length;
    // Skip the optional [pos] and the {colspec} (colspec may nest braces).
    if (cells[i] === "[") {
      const close = cells.indexOf("]", i);
      if (close === -1) return null;
      i = close + 1;
    }
    if (cells[i] === "{") {
      let depth = 0;
      let j = i;
      for (; j < cells.length; j++) {
        if (cells[j] === "{") depth++;
        else if (cells[j] === "}" && --depth === 0) break;
      }
      if (depth !== 0) return null;
      i = j + 1;
    }
    const end = cells.indexOf("\\end{tabular", i);
    cells = cells.slice(i, end === -1 ? undefined : end);
  }

  // Rows on \\ and cells on & — at brace depth 0, outside inline math.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let depth = 0;
  let inMath = false;
  for (let i = 0; i < cells.length; i++) {
    const ch = cells[i];
    if (ch === "\\" && cells[i + 1] === "\\" && depth === 0 && !inMath) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    if (ch === "\\") {
      cell += ch + (cells[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "$") inMath = !inMath;
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "&" && depth === 0 && !inMath) {
      row.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.trim() !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const textRows: string[][] = [];
  for (const r of rows) {
    const texts: string[] = [];
    for (const c of r) {
      const t = cellText(c);
      if (t === null) return null;
      texts.push(t);
    }
    if (texts.some((t) => t !== "")) textRows.push(texts);
  }
  if (textRows.length === 0) return null;

  const captionMatch = /\\caption\{([^{}]*)\}/.exec(body);
  return { rows: textRows, caption: captionMatch ? captionMatch[1] : null };
}

export class TableWidget extends WidgetType {
  constructor(readonly table: ParsedTable, readonly sourceKey: string) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.sourceKey === this.sourceKey;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-vis-table";
    wrap.title = "Click to edit";
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (let r = 0; r < this.table.rows.length; r++) {
      const tr = document.createElement("tr");
      for (const cell of this.table.rows[r]) {
        const td = document.createElement(r === 0 ? "th" : "td");
        td.textContent = cell;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    if (this.table.caption) {
      const cap = document.createElement("div");
      cap.className = "cm-vis-figcaption";
      cap.textContent = this.table.caption;
      wrap.appendChild(cap);
    }
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}
