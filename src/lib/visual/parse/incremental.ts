/**
 * Incremental update: map the previous VisualDoc through a transaction's
 * changes, rescan only the damaged region, and splice the untouched tail
 * back on. The splice is anchored on BLANK blocks (paragraph breaks) because
 * TeX resets inline context there — every bounded construct the scanners
 * recognize (brace args, math spans, comments, \verb) also bails at a
 * paragraph break, so a region parse that ends cleanly at a blank anchor is
 * provably identical to the full parse's restriction (the equivalence
 * property test in incremental.test.ts is the falsifier).
 *
 * Fallbacks, in order: no usable anchor → full reparse; budget abort →
 * offset-mapped stale tree (`stale: true`, display-only until the idle
 * reparse lands).
 */

import type { BlockNode, InlineNode, Span, VisualDoc } from "./nodes";
import { blockIndexAt } from "./nodes";
import type { Budget } from "./scan-blocks";
import { ScanAborted, parseDocument, parseTopRegion } from "./scan-blocks";
import { MAX_MATH_SPAN } from "./scan-inline";

/**
 * Structural subset of CodeMirror's ChangeDesc — kept local so the parse
 * layer stays free of CM imports (pure, unit-testable on plain data).
 */
export interface ChangeAdapter {
  mapPos(pos: number, assoc?: number): number;
  iterChangedRanges(
    f: (fromA: number, toA: number, fromB: number, toB: number) => void,
  ): void;
}

/* ------------------------------------------------------------------ */
/* Deep offset mapping                                                 */
/* ------------------------------------------------------------------ */

type PosMap = (pos: number, assoc: number) => number;

const mapSpan = (s: Span, m: PosMap): Span => ({
  from: m(s.from, 1),
  to: m(s.to, -1),
});

const mapSpanOrNull = (s: Span | null, m: PosMap): Span | null =>
  s === null ? null : mapSpan(s, m);

function mapInline(node: InlineNode, m: PosMap): InlineNode {
  const base = { from: m(node.from, 1), to: m(node.to, -1) };
  switch (node.kind) {
    case "style":
      return {
        ...node,
        ...base,
        hide: node.hide.map((h) => mapSpan(h, m)),
        content: mapSpan(node.content, m),
        children: node.children.map((c) => mapInline(c, m)),
      };
    case "group":
      return {
        ...node,
        ...base,
        hide: node.hide.map((h) => mapSpan(h, m)),
        content: mapSpan(node.content, m),
        children: node.children.map((c) => mapInline(c, m)),
      };
    case "inlineMath":
      return { ...node, ...base, tex: mapSpan(node.tex, m) };
    case "pill":
      return {
        ...node,
        ...base,
        optArg: mapSpanOrNull(node.optArg, m),
        arg: mapSpan(node.arg, m),
      };
    case "command":
      return { ...node, ...base, args: node.args.map((a) => mapSpan(a, m)) };
    default:
      return { ...node, ...base };
  }
}

export function mapBlock(block: BlockNode, m: PosMap): BlockNode {
  const base = { from: m(block.from, 1), to: m(block.to, -1) };
  switch (block.kind) {
    case "heading":
      return {
        ...block,
        ...base,
        hide: block.hide.map((h) => mapSpan(h, m)),
        content: mapSpan(block.content, m),
        inlines: block.inlines.map((i) => mapInline(i, m)),
      };
    case "paragraph":
      return { ...block, ...base, inlines: block.inlines.map((i) => mapInline(i, m)) };
    case "displayMath":
      return { ...block, ...base, tex: mapSpan(block.tex, m) };
    case "environment":
      return {
        ...block,
        ...base,
        beginToken: mapSpan(block.beginToken, m),
        endToken: mapSpanOrNull(block.endToken, m),
        body: mapSpan(block.body, m),
        children:
          block.children === null
            ? null
            : block.children.map((c) => mapBlock(c, m)),
      };
    case "itemMarker":
      return {
        ...block,
        ...base,
        hide: block.hide.map((h) => mapSpan(h, m)),
        label: mapSpanOrNull(block.label, m),
      };
    default:
      return { ...block, ...base };
  }
}

/**
 * Offset-map the whole tree through changes. Blocks overlapping a change
 * come out geometrically distorted — callers use this only as the stale
 * display fallback (`stale: true`) or for pure-shift tails.
 */
export function mapVisualDoc(
  doc: VisualDoc,
  changes: ChangeAdapter,
  newLength: number,
): VisualDoc {
  const m: PosMap = (pos, assoc) => changes.mapPos(pos, assoc);
  const blocks = doc.blocks.map((b) => mapBlock(b, m));
  // Re-tile after distortion: clamp and drop empties so the stale tree
  // still satisfies the block-tiling invariant for the decoration builder.
  const tiled: BlockNode[] = [];
  let cursor = 0;
  for (const b of blocks) {
    const from = Math.max(cursor, Math.min(b.from, newLength));
    const to = Math.max(from, Math.min(b.to, newLength));
    if (to <= from) continue;
    if (from > cursor) {
      tiled.push({ kind: "rawSource", from: cursor, to: from, reason: "stale-gap" });
    }
    tiled.push(from === b.from && to === b.to ? b : { ...b, from, to } as BlockNode);
    cursor = to;
  }
  if (cursor < newLength) {
    tiled.push({ kind: "rawSource", from: cursor, to: newLength, reason: "stale-gap" });
  }
  return {
    length: newLength,
    blocks: tiled,
    preambleEnd:
      doc.preambleEnd === null ? null : changes.mapPos(doc.preambleEnd, 1),
    stale: true,
  };
}

/* ------------------------------------------------------------------ */
/* Splice update                                                       */
/* ------------------------------------------------------------------ */

/** True when the region parse ended cleanly for a blank-anchor splice. */
function regionEndsClean(blocks: BlockNode[], from: number, limit: number): boolean {
  if (blocks.length === 0) return from === limit;
  const last = blocks[blocks.length - 1];
  if (blocks[0].from !== from || last.to !== limit) return false;
  // An env truncated by the limit would have parsed further in a full scan
  // (unclosed children propagate to their top-level ancestor, so checking
  // the top level covers nesting).
  for (const b of blocks) {
    if (b.kind === "environment" && b.endToken === null) return false;
  }
  return true;
}

export interface UpdateResult {
  doc: VisualDoc;
  /** True when the result is the offset-mapped stale fallback. */
  stale: boolean;
}

/**
 * Compute the new VisualDoc after `changes`. Throws ScanAborted only never —
 * budget aborts degrade to the mapped stale tree internally.
 */
export function updateVisualDoc(
  oldDoc: VisualDoc,
  changes: ChangeAdapter,
  newText: string,
  budget: Budget,
): UpdateResult {
  let dFromA = Infinity;
  let dToA = -1;
  let dToB = -1;
  changes.iterChangedRanges((fromA, toA, _fromB, toB) => {
    if (fromA < dFromA) dFromA = fromA;
    if (toA > dToA) dToA = toA;
    if (toB > dToB) dToB = toB;
  });
  if (dToA < 0) {
    return { doc: { ...oldDoc, length: newText.length }, stale: oldDoc.stale };
  }

  try {
    const doc = spliceUpdate(oldDoc, changes, newText, budget, {
      dFromA,
      dToA,
      dToB,
    });
    return { doc, stale: false };
  } catch (e) {
    if (e instanceof ScanAborted) {
      return { doc: mapVisualDoc(oldDoc, changes, newText.length), stale: true };
    }
    throw e;
  }
}

function fullParse(newText: string, budget: Budget): VisualDoc {
  const { blocks, preambleEnd } = parseDocument(newText, budget);
  return { length: newText.length, blocks, preambleEnd, stale: false };
}

function spliceUpdate(
  oldDoc: VisualDoc,
  changes: ChangeAdapter,
  newText: string,
  budget: Budget,
  damage: { dFromA: number; dToA: number; dToB: number },
): VisualDoc {
  const { dFromA, dToA, dToB } = damage;

  // A stale tree has unreliable geometry — never splice on top of it.
  if (oldDoc.stale) return fullParse(newText, budget);

  // Damage in or before the preamble/doc-begin region → full reparse (the
  // preamble boundary itself may have moved).
  const oldBodyStart = bodyStartOf(oldDoc);
  if (dFromA < oldBodyStart) return fullParse(newText, budget);

  // Restart point. Construct decisions look ahead: a FAILED math-close scan
  // reads up to MAX_MATH_SPAN chars past its opener, and a failed \verb
  // delimiter scan reads to its line end — so text before the damage can
  // parse differently once the damage changes what those windows saw. The
  // restart must therefore clear both windows: at or before
  // dFromA - MAX_MATH_SPAN, and at or before the damage line's start.
  // Text before dFromA is unchanged, so newText serves for old-side lookups.
  const lineStartA = newText.lastIndexOf("\n", Math.max(0, dFromA - 1)) + 1;
  const safePos = Math.min(dFromA - MAX_MATH_SPAN, lineStartA);
  if (safePos <= oldBodyStart) return fullParse(newText, budget);
  const startIdx = blockIndexAt(oldDoc, Math.min(safePos, oldDoc.length - 1));
  if (startIdx < 0) return fullParse(newText, budget);
  const restart = oldDoc.blocks[startIdx];
  if (restart === undefined || restart.from < oldBodyStart) {
    return fullParse(newText, budget);
  }
  // Positions before the damage map identically.
  const restartPos = restart.from;

  // Whether the body is still open at the restart point (affects stopEnv).
  // parseDocument scans the body with stopEnv "document" for fragments too,
  // so only a docEnd already behind the restart point switches to null.
  let docEnded = false;
  for (let i = 0; i < startIdx; i++) {
    if (oldDoc.blocks[i].kind === "docEnd") {
      docEnded = true;
      break;
    }
  }
  const stopEnv = docEnded ? null : "document";

  // Blank-anchor candidates: old top-level blank blocks entirely after the
  // damage; their mapped starts are pure shifts. The anchor must still sit
  // at a line start in the NEW text — an edit that prepends non-blank
  // content onto the blank's own line destroys its paragraph-break role
  // even though the blank's characters are untouched.
  let anchorIdx = -1;
  let anchorPosB = -1;
  for (let i = startIdx + 1; i < oldDoc.blocks.length; i++) {
    const b = oldDoc.blocks[i];
    if (b.kind !== "blank" || b.from < dToA) continue;
    const posB = changes.mapPos(b.from, 1);
    if (posB >= dToB && (posB === 0 || newText.charCodeAt(posB - 1) === 10)) {
      anchorIdx = i;
      anchorPosB = posB;
      break;
    }
  }

  if (anchorIdx === -1) {
    // No anchor after the damage — rescan to the end of the document.
    const region = parseTopRegion(newText, restartPos, newText.length, budget, stopEnv);
    const head = oldDoc.blocks.slice(0, startIdx);
    const blocks = [...head, ...region.blocks];
    if (region.stopToken) {
      blocks.push({ kind: "docEnd", from: region.stopToken.from, to: region.stopToken.to });
      if (region.end < newText.length) {
        const tail = parseTopRegion(newText, region.end, newText.length, budget, null);
        blocks.push(...tail.blocks);
      }
    }
    return {
      length: newText.length,
      blocks,
      preambleEnd: oldDoc.preambleEnd,
      stale: false,
    };
  }

  // The replaced region carrying the old \end{document} would flip the
  // tail's parse context — not splice-safe.
  for (let i = startIdx; i < anchorIdx; i++) {
    if (oldDoc.blocks[i].kind === "docEnd") return fullParse(newText, budget);
  }

  // Region parse up to the anchor; splice the shifted tail on when clean.
  const region = parseTopRegion(newText, restartPos, anchorPosB, budget, stopEnv);
  if (
    region.stopToken !== null ||
    !regionEndsClean(region.blocks, restartPos, anchorPosB)
  ) {
    // \end{document} inside the damaged region, or a construct truncated by
    // the anchor — the anchor is not equivalence-safe here.
    return fullParse(newText, budget);
  }

  const m: PosMap = (pos, assoc) => changes.mapPos(pos, assoc);
  const tail = oldDoc.blocks.slice(anchorIdx).map((b) => mapBlock(b, m));
  const middle = [...region.blocks];
  // A full parse emits maximal blank runs; a region ending in blanks and the
  // blank anchor are one run there, so merge them at the seam.
  const lastR = middle[middle.length - 1];
  if (lastR && lastR.kind === "blank" && tail[0]?.kind === "blank" && lastR.to === tail[0].from) {
    middle[middle.length - 1] = { kind: "blank", from: lastR.from, to: tail[0].to };
    tail.shift();
  }
  return {
    length: newText.length,
    blocks: [...oldDoc.blocks.slice(0, startIdx), ...middle, ...tail],
    preambleEnd: oldDoc.preambleEnd,
    stale: false,
  };
}

/** Offset where body scanning starts (after docBegin; 0 for fragments). */
function bodyStartOf(doc: VisualDoc): number {
  for (const b of doc.blocks) {
    if (b.kind === "docBegin") return b.to;
    if (b.kind !== "preamble") break;
  }
  return 0;
}
