/**
 * Notebook source ↔ cell-list round-trip.
 *
 * Supports the surface of R Markdown we care about:
 *   - Optional YAML frontmatter at file start (between `---` fences)
 *   - Fenced code chunks of the form ```{lang} ... ```
 *   - Plain prose between fences (rendered as markdown cells)
 *
 * Out of scope (for now):
 *   - Nested fences / inline backticks inside chunks (top-level only)
 *   - Indented chunks (RMD's lesser-used form)
 *   - Chunk options after the language (` ```{r, echo=FALSE} `) — we keep
 *     the raw header so it round-trips, just don't structure it
 */

export type CellKind = "metadata" | "markdown" | "code";

export interface MetadataCell {
  id: string;
  kind: "metadata";
  /** Content between the opening `---` and closing `---`, no fences. */
  content: string;
}

export interface MarkdownCell {
  id: string;
  kind: "markdown";
  content: string;
}

export interface CodeCell {
  id: string;
  kind: "code";
  /** Lowercased: "r", "python", "julia", etc. */
  language: string;
  /**
   * Raw chunk header after the language, e.g. ", echo=FALSE, fig.width=5".
   * Empty string when none. Preserved so serialization is lossless.
   */
  options: string;
  content: string;
}

export type Cell = MetadataCell | MarkdownCell | CodeCell;

let _idCounter = 0;
const makeId = (kind: CellKind): string => {
  _idCounter++;
  return `${kind}-${_idCounter}`;
};

/** Reset the monotonic id counter — test-only. */
export const _resetIdsForTests = (): void => {
  _idCounter = 0;
};

const FENCE_OPEN = /^```\{([A-Za-z][\w-]*)([^}]*)\}\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const META_FENCE = /^---\s*$/;

/**
 * Parse an R Markdown source string into a list of cells. Always returns
 * at least one cell — an empty input becomes a single empty markdown cell
 * so the UI has something to focus on.
 */
export function parseNotebook(source: string): Cell[] {
  const lines = source.split(/\r?\n/);
  const cells: Cell[] = [];
  let i = 0;

  // YAML frontmatter: only valid if the *first* non-empty line is `---`.
  if (lines.length > 0 && META_FENCE.test(lines[0])) {
    const start = 1;
    let end = -1;
    for (let j = start; j < lines.length; j++) {
      if (META_FENCE.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end >= 0) {
      cells.push({
        id: makeId("metadata"),
        kind: "metadata",
        content: lines.slice(start, end).join("\n"),
      });
      i = end + 1;
    }
  }

  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length === 0) return;
    // Trim leading/trailing empty lines but keep internal structure.
    while (prose.length > 0 && prose[0] === "") prose.shift();
    while (prose.length > 0 && prose[prose.length - 1] === "") prose.pop();
    if (prose.length === 0) return;
    cells.push({
      id: makeId("markdown"),
      kind: "markdown",
      content: prose.join("\n"),
    });
    prose = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_OPEN);
    if (fenceMatch) {
      flushProse();
      const language = fenceMatch[1].toLowerCase();
      const options = fenceMatch[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // Consume the closing fence if present. When the fence is unclosed
      // at EOF, the body may have absorbed the trailing newline marker
      // (split("\n") tail) — drop those purely-empty trailing lines.
      const unclosed = i >= lines.length;
      if (!unclosed) i++;
      if (unclosed) {
        while (body.length > 0 && body[body.length - 1] === "") body.pop();
      }
      cells.push({
        id: makeId("code"),
        kind: "code",
        language,
        options,
        content: body.join("\n"),
      });
      continue;
    }
    prose.push(line);
    i++;
  }
  flushProse();

  // Always present at least one cell so the editor isn't blank.
  if (cells.length === 0) {
    cells.push({ id: makeId("markdown"), kind: "markdown", content: "" });
  }
  return cells;
}

/**
 * Serialize a list of cells back to a single source string. Inverse of
 * `parseNotebook` for any input that fits the supported surface — round-
 * tripping a parsed document should be stable modulo trimming of all-empty
 * lines between cells.
 */
export function serializeNotebook(cells: Cell[]): string {
  const parts: string[] = [];
  for (const cell of cells) {
    if (cell.kind === "metadata") {
      parts.push(`---\n${cell.content}\n---`);
    } else if (cell.kind === "markdown") {
      parts.push(cell.content);
    } else {
      // code
      const header = `\`\`\`{${cell.language}${cell.options}}`;
      parts.push(`${header}\n${cell.content}\n\`\`\``);
    }
  }
  // Cells are visually separated by a blank line. Join with double-newline
  // and end with a trailing newline so editors don't flag a missing EOL.
  return parts.join("\n\n") + "\n";
}

/** Build a fresh blank markdown cell — used by the "add cell" button. */
export const blankMarkdownCell = (): MarkdownCell => ({
  id: makeId("markdown"),
  kind: "markdown",
  content: "",
});

/** Build a fresh blank code cell with the given language (default "r"). */
export const blankCodeCell = (language = "r"): CodeCell => ({
  id: makeId("code"),
  kind: "code",
  language,
  options: "",
  content: "",
});
