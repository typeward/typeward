import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { indexCitations, indexLabels } from "~/stores/index-store";
import type { IndexEntry } from "~/ipc";
import { perfRecord } from "~/lib/perf-marks";

// First useful \ref/\cite completion per editor session, so the benchmark can
// see the local source's latency (a synchronous in-memory lookup) the same way
// it reads the LSP source's `lsp.completion.first-useful`.
let firstLocalRecorded = false;

/**
 * Local, uncapped `\ref`/`\cite` completion sourced from the project index
 * (see index-store) merged with the active buffer's own `\label`s. Serves the
 * two commands the benchmark showed texlab handling slowly (a server round
 * trip, capped at 50 items) — here it is a synchronous in-memory lookup, so
 * the first useful completion is sub-millisecond and every label is reachable.
 *
 * The reference (`\ref`, `\eqref`, `\cref`, `\pageref`, `\autoref`, ...) and
 * citation (`\cite`, `\citep`, `\textcite`, `\footcite`, ...) command families
 * both take a comma-separated key list inside braces; the source fires on the
 * key segment under the cursor.
 */

// A reference command immediately before `{...cursor`. The trailing group
// captures the partial key segment (after the last comma) being typed.
const REF_RE =
  /\\(?:eq|c|C|page|auto|name|v|V|labelc)?ref(?:range)?\*?\{([^}]*)$/;
const CITE_RE =
  /\\(?:foot|text|paren|super|auto|smart|full|no)?cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)$/;

/** The partial key under the cursor within a `\ref{a,b,cur` style argument. */
function segment(inner: string): { text: string; start: number } {
  const comma = inner.lastIndexOf(",");
  const from = comma === -1 ? 0 : comma + 1;
  return { text: inner.slice(from).trimStart(), start: from + (inner.slice(from).length - inner.slice(from).trimStart().length) };
}

/** Active-buffer `\label{...}` keys, so a freshly typed label completes before
 *  the disk index has rescanned. Bounded scan of the current document. */
function bufferLabels(doc: string): Set<string> {
  const out = new Set<string>();
  const re = /\\label\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(doc)) !== null && guard++ < 20_000) {
    out.add(m[1].trim());
  }
  return out;
}

function toCompletions(entries: IndexEntry[], extraKeys: Set<string>, boost: number): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const e of entries) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({
      label: e.key,
      detail: e.context || undefined,
      type: boost > 0 ? "variable" : "constant",
      boost,
    });
  }
  for (const key of extraKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: key, type: "variable", boost: boost + 1 });
  }
  return out;
}

function refCiteSource(ctx: CompletionContext): CompletionResult | null {
  const t0 = performance.now();
  const before = ctx.state.doc.sliceString(
    Math.max(0, ctx.pos - 400),
    ctx.pos,
  );
  const isRef = REF_RE.test(before);
  const isCite = !isRef && CITE_RE.test(before);
  if (!isRef && !isCite) return null;
  const m = (isRef ? REF_RE : CITE_RE).exec(before)!;
  const inner = m[1];
  const seg = segment(inner);
  // Position where the current key segment begins in the document.
  const from = ctx.pos - (inner.length - seg.start);

  const options = isRef
    ? toCompletions(indexLabels(), bufferLabels(ctx.state.doc.toString()), 1)
    : toCompletions(indexCitations(), new Set(), 0);
  if (options.length === 0 && !ctx.explicit) return null;
  if (!firstLocalRecorded) {
    firstLocalRecorded = true;
    perfRecord("lsp.completion.first-useful", performance.now() - t0, `local items=${options.length}`);
  }
  return {
    from,
    options,
    // Re-filter client-side while the key segment is being typed; the set is
    // complete (unlike texlab's truncated list), so no re-query is needed.
    validFor: /^[^,}]*$/,
  };
}

/** Whether the cursor sits inside a `\ref`/`\cite` key argument — used by the
 *  LSP completion source to yield those contexts to this local source. */
export function isRefCiteContext(before: string): boolean {
  return REF_RE.test(before) || CITE_RE.test(before);
}

/** Standalone autocompletion extension for when no LSP session owns the
 *  editor (texlab absent). When a session IS present, the source is composed
 *  into the LSP override instead — see cm6.ts. */
export function refCiteCompletionExtension(): Extension {
  return autocompletion({ override: [refCiteSource] });
}

export { refCiteSource };
