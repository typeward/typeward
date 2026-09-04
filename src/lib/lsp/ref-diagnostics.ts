import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { indexLabels, indexLoaded } from "~/stores/index-store";
import type { IndexEntry } from "~/ipc";

/**
 * In-editor "undefined reference" diagnostics for LaTeX, sourced from the same
 * project index that powers uncapped completion and go-to-definition. A
 * `\ref` / `\eqref` / `\cref` / ... whose key matches no `\label` anywhere in
 * the project is flagged in the gutter — so a Tectonic-only user (no texlab)
 * catches a broken cross-reference while editing instead of at compile time.
 *
 * Scope is deliberately narrow to stay high-confidence:
 *  - REFERENCES ONLY, not `\cite`: a label's definition set is closed and fully
 *    scanned (`\label` in project `.tex` files), whereas a citekey can come from
 *    a `.bib` the index never saw — too false-positive-prone to flag.
 *  - Mounted ONLY when no language server owns the editor (texlab ships its own
 *    undefined-reference diagnostics); see the wiring in text-shell.
 *  - Silent until the index has loaded (`indexLoaded`), so a project open
 *    doesn't briefly flag every reference against an empty label set.
 */

// A reference command followed by a braced key list. Requires the closing brace
// so a half-typed `\ref{foo` (still being written) is never flagged.
const REF_G = /\\(?:eq|c|C|page|auto|name|v|V|labelc)?ref(?:range)?\*?\s*\{([^}]*)\}/g;
const LABEL_G = /\\label\{([^}]+)\}/g;

export interface DanglingRef {
  from: number;
  to: number;
  key: string;
}

/** Whether the character offset `pos` sits after an unescaped `%` on its line
 *  (i.e. inside a TeX comment), so a reference written in a comment is ignored. */
function inComment(doc: string, pos: number): boolean {
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  for (let i = lineStart; i < pos; i++) {
    if (doc[i] === "%" && doc[i - 1] !== "\\") return true;
  }
  return false;
}

/** The comma-separated keys inside a reference argument, each with its offset
 *  (of the trimmed key) within the argument text. */
function keysWithOffsets(inner: string): Array<{ key: string; offset: number }> {
  const out: Array<{ key: string; offset: number }> = [];
  let base = 0;
  for (const part of inner.split(",")) {
    const lead = part.length - part.trimStart().length;
    const key = part.trim();
    if (key) out.push({ key, offset: base + lead });
    base += part.length + 1; // + 1 for the comma
  }
  return out;
}

/** Active-buffer `\label{...}` keys — a reference to a label defined anywhere in
 *  the current file is valid even before the on-disk index has rescanned. */
function bufferLabels(doc: string): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  let guard = 0;
  LABEL_G.lastIndex = 0;
  while ((m = LABEL_G.exec(doc)) !== null && guard++ < 50_000) {
    out.add(m[1].trim());
  }
  return out;
}

/**
 * Every reference in `doc` whose key is not in `labels`, with the precise range
 * of the offending key. Pure and unit-tested; the linter below supplies the
 * document and the merged label set.
 */
export function findDanglingRefs(doc: string, labels: Set<string>): DanglingRef[] {
  const out: DanglingRef[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  REF_G.lastIndex = 0;
  while ((m = REF_G.exec(doc)) !== null && guard++ < 100_000) {
    if (inComment(doc, m.index)) continue;
    const inner = m[1];
    const innerStart = m.index + m[0].indexOf("{") + 1;
    for (const { key, offset } of keysWithOffsets(inner)) {
      if (labels.has(key)) continue;
      const from = innerStart + offset;
      out.push({ from, to: from + key.length, key });
    }
  }
  return out;
}

/** Every `\label{...}` occurrence in the buffer with its key's range, skipping
 *  commented-out lines (a commented label is not a real definition). */
function bufferLabelOccurrences(doc: string): DanglingRef[] {
  const out: DanglingRef[] = [];
  let m: RegExpExecArray | null;
  let guard = 0;
  LABEL_G.lastIndex = 0;
  while ((m = LABEL_G.exec(doc)) !== null && guard++ < 50_000) {
    if (inComment(doc, m.index)) continue;
    const key = m[1].trim();
    if (!key) continue;
    const from = m.index + m[0].indexOf("{") + 1;
    out.push({ from, to: from + m[1].length, key });
  }
  return out;
}

/**
 * Every `\label` in the buffer that is defined more than once in the project —
 * either repeated within this file, or also defined in another file (per the
 * index). Both make `\ref` resolve to an arbitrary one, so LaTeX warns.
 * `activeRelPath` excludes this file's own index entries from the cross-file
 * test (they are the same labels being scanned here, not duplicates).
 */
export function findDuplicateLabels(
  doc: string,
  activeRelPath: string,
  index: IndexEntry[],
): DanglingRef[] {
  const occ = bufferLabelOccurrences(doc);
  const counts = new Map<string, number>();
  for (const o of occ) counts.set(o.key, (counts.get(o.key) ?? 0) + 1);
  const definedElsewhere = new Set<string>();
  for (const e of index) {
    if (e.file !== activeRelPath) definedElsewhere.add(e.key);
  }
  return occ.filter(
    (o) => (counts.get(o.key) ?? 0) >= 2 || definedElsewhere.has(o.key),
  );
}

/**
 * CM6 linter emitting an undefined-reference warning per dangling `\ref` key
 * and a duplicate-label warning per `\label` defined more than once in the
 * project. Both are index-backed and high-confidence; see the module header for
 * why this is references-only and no-LSP-only.
 */
export function refDiagnosticsExtension(activeRelPath: string): Extension {
  return linter(
    (view): readonly Diagnostic[] => {
      // Can't validate against an index that hasn't finished its first scan —
      // every cross-file label would look undefined / non-duplicate.
      if (!indexLoaded()) return [];
      const doc = view.state.doc.toString();
      const index = indexLabels();
      const labels = new Set<string>(index.map((e) => e.key));
      for (const key of bufferLabels(doc)) labels.add(key);
      const out: Diagnostic[] = [];
      // A project with no labels at all can't meaningfully validate references
      // (more likely a not-yet-populated index than a real all-dangling doc).
      if (labels.size > 0) {
        for (const d of findDanglingRefs(doc, labels)) {
          out.push({
            from: d.from,
            to: d.to,
            severity: "warning",
            source: "ref-check",
            message: `Reference to undefined label "${d.key}"`,
            markClass: "cm-lint-ref-undefined",
          });
        }
      }
      for (const d of findDuplicateLabels(doc, activeRelPath, index)) {
        out.push({
          from: d.from,
          to: d.to,
          severity: "warning",
          source: "ref-check",
          message: `Label "${d.key}" is defined more than once`,
          markClass: "cm-lint-label-duplicate",
        });
      }
      return out;
    },
    { delay: 500 },
  );
}
