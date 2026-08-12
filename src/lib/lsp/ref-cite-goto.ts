import { EditorView, keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { indexCitations, indexLabels } from "~/stores/index-store";
import { requestGotoSource } from "~/stores/editor-store";
import type { IndexEntry } from "~/ipc";

/**
 * Go-to-definition for `\ref`/`\cite` keys, served synchronously from the
 * project index (see index-store) rather than a language-server round trip.
 * Mod+click (or F12 at the cursor) on a reference jumps to the `\label` that
 * defines it — across chapter files — and on a citation to its `.bib` entry.
 * This is the navigation half of the same in-memory index that powers uncapped
 * completion; on a book-length project it resolves in microseconds and reaches
 * a label defined in any file, which is exactly where a cross-file jump matters.
 */

// The command immediately before the `{` that encloses the cursor. Mirrors the
// families in ref-cite-completion, anchored at the end (the `{` follows).
const REF_CMD = /\\(?:eq|c|C|page|auto|name|v|V|labelc)?ref(?:range)?\*?$/;
const CITE_CMD =
  /\\(?:foot|text|paren|super|auto|smart|full|no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\])*$/;

// How far to scan for the enclosing braces / preceding command. Reference and
// citation arguments are short; a bounded window keeps a click on a huge doc cheap.
const WIN = 2000;

export interface DefTarget {
  relPath: string;
  line: number;
  key: string;
  kind: "ref" | "cite";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `{...}` argument enclosing `pos`, plus the offset of its opening brace,
 *  or null when the cursor isn't inside a single-level brace group. */
function enclosingArg(
  doc: string,
  pos: number,
): { open: number; inner: string } | null {
  const backStop = Math.max(0, pos - WIN);
  let open = -1;
  for (let i = pos - 1; i >= backStop; i--) {
    const c = doc[i];
    // A closing brace between the cursor and any opening brace means the cursor
    // sits after a completed argument, not inside one.
    if (c === "}") return null;
    if (c === "{" && doc[i - 1] !== "\\") {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  const fwdStop = Math.min(doc.length, pos + WIN);
  let close = -1;
  for (let i = pos; i < fwdStop; i++) {
    const c = doc[i];
    if (c === "}") {
      close = i;
      break;
    }
    // A nested `{` before the close is not a plain key list — bail rather than
    // guess.
    if (c === "{") return null;
  }
  if (close === -1) return null;
  return { open, inner: doc.slice(open + 1, close) };
}

/** The comma-separated key covering `offset` within an argument's inner text. */
function keyAt(inner: string, offset: number): string {
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === ",") {
      if (i >= offset) break;
      start = i + 1;
    }
  }
  let end = inner.indexOf(",", Math.max(start, offset));
  if (end === -1) end = inner.length;
  return inner.slice(start, end).trim();
}

function find(entries: IndexEntry[], key: string): IndexEntry | null {
  for (const e of entries) if (e.key === key) return e;
  return null;
}

/** 1-based line of the first `\label{key}` in the active buffer, or null. */
function bufferLabelLine(doc: string, key: string): number | null {
  const re = new RegExp("\\\\label\\{" + escapeRegExp(key) + "\\}");
  const m = re.exec(doc);
  if (!m) return null;
  let line = 1;
  for (let i = 0; i < m.index; i++) if (doc[i] === "\n") line++;
  return line;
}

/**
 * Resolve the definition target for a `\ref`/`\cite` key under `pos`. Pure and
 * unit-tested; the CM6 wiring below only supplies the document, cursor, and the
 * two index arrays. Returns null when the cursor is not on a resolvable key.
 */
export function resolveRefCiteTarget(
  doc: string,
  pos: number,
  activeRelPath: string,
  labels: IndexEntry[],
  citations: IndexEntry[],
): DefTarget | null {
  const arg = enclosingArg(doc, pos);
  if (!arg) return null;
  const before = doc.slice(Math.max(0, arg.open - 80), arg.open);
  const isRef = REF_CMD.test(before);
  const isCite = !isRef && CITE_CMD.test(before);
  if (!isRef && !isCite) return null;

  const key = keyAt(arg.inner, pos - (arg.open + 1));
  if (!key) return null;

  if (isRef) {
    const hit = find(labels, key);
    if (hit) return { relPath: hit.file, line: hit.line, key, kind: "ref" };
    // A label defined in the file being edited may not be in the disk index yet.
    const line = bufferLabelLine(doc, key);
    if (line != null) return { relPath: activeRelPath, line, key, kind: "ref" };
    return null;
  }
  const hit = find(citations, key);
  if (!hit) return null;
  return { relPath: hit.file, line: hit.line, key, kind: "cite" };
}

/** CM6 extension: Mod+click and F12 jump to a `\ref`/`\cite` key's definition. */
export function refCiteGotoExtension(activeRelPath: string): Extension {
  const tryGoto = (view: EditorView, pos: number): boolean => {
    const t = resolveRefCiteTarget(
      view.state.doc.toString(),
      pos,
      activeRelPath,
      indexLabels(),
      indexCitations(),
    );
    if (!t) return false;
    requestGotoSource(t.relPath, t.line);
    return true;
  };
  return [
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        // Only swallow the click when it actually resolves a target, so a
        // Mod+click elsewhere keeps its default behaviour.
        if (!tryGoto(view, pos)) return false;
        event.preventDefault();
        return true;
      },
    }),
    Prec.high(
      keymap.of([
        {
          key: "F12",
          run: (view) => tryGoto(view, view.state.selection.main.head),
        },
      ]),
    ),
  ];
}
