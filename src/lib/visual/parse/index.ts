/**
 * Facade for the visual-mode parse layer. Pure — CM-free — so everything is
 * unit-testable on plain strings; the StateField (field.ts) is the only
 * consumer that touches CodeMirror types, via the structural ChangeAdapter.
 */

import type { VisualDoc } from "./nodes";
import type { Budget } from "./scan-blocks";
import { ScanAborted, parseDocument } from "./scan-blocks";
import type { ChangeAdapter, UpdateResult } from "./incremental";
import { updateVisualDoc } from "./incremental";

export type {
  BlockNode,
  CoverKind,
  CoverSpan,
  EnvKind,
  EnvironmentBlock,
  HeadingBlock,
  InlineNode,
  ItemMarkerBlock,
  ParagraphBlock,
  PillCommand,
  Span,
  StyleKind,
  VisualDoc,
} from "./nodes";
export {
  assertTotalCoverage,
  blockAt,
  blockIndexAt,
  coverage,
} from "./nodes";
export type { ChangeAdapter, UpdateResult } from "./incremental";
export { mapVisualDoc } from "./incremental";
export { findPreambleEnd } from "./scan-blocks";

/** Budget for the enable-time full parse. */
export const FULL_PARSE_BUDGET_MS = 25;
/** Budget for the per-edit incremental rescan. */
export const RESCAN_BUDGET_MS = 4;
/** Cheap size gate — beyond this the file is visual-paused up front. */
export const MAX_VISUAL_BYTES = 1_500_000;
/** A single line longer than this pauses the file (minified-input guard). */
export const MAX_LINE_LENGTH = 20_000;

export interface ParseOptions {
  /** Injectable clock (tests pass a constant to disable the budget). */
  now?: () => number;
  budgetMs?: number;
}

const defaultNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

const makeBudget = (opts: ParseOptions, defaultMs: number): Budget => {
  const now = opts.now ?? defaultNow;
  return { now, deadline: now() + (opts.budgetMs ?? defaultMs), counter: 0 };
};

/**
 * Pre-parse eligibility gate: file size and pathological line length. False
 * means "pause before the first visual paint".
 */
export function passesSizeGate(text: string): boolean {
  if (text.length > MAX_VISUAL_BYTES) return false;
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf("\n", lineStart);
    const end = nl === -1 ? text.length : nl;
    if (end - lineStart > MAX_LINE_LENGTH) return false;
    if (nl === -1) return true;
    lineStart = nl + 1;
  }
}

/** Full parse. Null on budget abort (caller pauses the file). */
export function parseVisualDoc(text: string, opts: ParseOptions = {}): VisualDoc | null {
  try {
    const { blocks, preambleEnd } = parseDocument(
      text,
      makeBudget(opts, FULL_PARSE_BUDGET_MS),
    );
    return { length: text.length, blocks, preambleEnd, stale: false };
  } catch (e) {
    if (e instanceof ScanAborted) return null;
    throw e;
  }
}

/**
 * Incremental update after a transaction. Never throws on budget expiry —
 * degrades to the offset-mapped stale tree (`result.stale`), which the field
 * repairs with an idle full reparse.
 */
export function updateDoc(
  oldDoc: VisualDoc,
  changes: ChangeAdapter,
  newText: string,
  opts: ParseOptions = {},
): UpdateResult {
  return updateVisualDoc(
    oldDoc,
    changes,
    newText,
    makeBudget(opts, RESCAN_BUDGET_MS),
  );
}
