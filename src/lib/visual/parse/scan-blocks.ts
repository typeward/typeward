/**
 * Block scanner: segments the document into the top-level BlockNode tree —
 * preamble, doc markers, headings, paragraphs, display math, environments
 * (recursing into transparent kinds), item markers, comment lines, blanks.
 * Pure; prose spans are handed to scanInline.
 *
 * Blocks are newline-inclusive: each block ends after the `\n` that
 * terminates it (or at the limit), so blocks tile the document by
 * construction — the invariant assertTotalCoverage() checks.
 */

import type {
  BlockNode,
  EnvKind,
  HeadingBlock,
  Span,
} from "./nodes";
import { TRANSPARENT_ENV_KINDS } from "./nodes";
import {
  MAX_OPT_ARG,
  findMathClose,
  isLetter,
  isParagraphBreak,
  matchBrace,
  scanInline,
  skipInlineSpace,
} from "./scan-inline";

export const PREAMBLE_SCAN_BYTES = 100_000;

const MAX_HEADING_ARG = 500;
/** Budget clock is sampled once per this many scanner steps. */
const BUDGET_STRIDE = 4096;

const HEADING_LEVELS: Record<string, 1 | 2 | 3> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
};

const ENV_KINDS: Record<string, EnvKind> = {
  itemize: "list",
  enumerate: "list",
  description: "list",
  quote: "quote",
  quotation: "quote",
  abstract: "prose",
  center: "prose",
  flushleft: "prose",
  flushright: "prose",
  equation: "mathEnv",
  "equation*": "mathEnv",
  align: "mathEnv",
  "align*": "mathEnv",
  gather: "mathEnv",
  "gather*": "mathEnv",
  multline: "mathEnv",
  "multline*": "mathEnv",
  eqnarray: "mathEnv",
  "eqnarray*": "mathEnv",
  displaymath: "mathEnv",
  table: "table",
  "table*": "table",
  tabular: "table",
  "tabular*": "table",
  longtable: "table",
  figure: "figure",
  "figure*": "figure",
  verbatim: "verbatim",
  "verbatim*": "verbatim",
  lstlisting: "verbatim",
  minted: "verbatim",
};

const envKindOf = (name: string): EnvKind => ENV_KINDS[name] ?? "unknown";

const RE_ENV_NAME = /^\{([a-zA-Z]+\*?)\}/;

/** Thrown internally on budget expiry; callers of parseDocument catch it. */
export class ScanAborted extends Error {
  constructor() {
    super("visual scan budget exceeded");
  }
}

export interface Budget {
  now: () => number;
  deadline: number;
  counter: number;
}

const checkBudget = (b: Budget): void => {
  if (++b.counter >= BUDGET_STRIDE) {
    b.counter = 0;
    if (b.now() > b.deadline) throw new ScanAborted();
  }
};

/* ------------------------------------------------------------------ */
/* Boundary finder                                                     */
/* ------------------------------------------------------------------ */

type Boundary =
  | { type: "limit"; pos: number }
  | { type: "blank"; pos: number }
  | { type: "begin"; pos: number; name: string; nameEnd: number }
  | { type: "end"; pos: number; name: string; nameEnd: number }
  | { type: "heading"; pos: number; level: 1 | 2 | 3; starred: boolean; nameEnd: number }
  | { type: "displayMath"; pos: number; delim: "bracket" | "dollars" }
  | { type: "item"; pos: number; nameEnd: number };

/**
 * Scan forward from `i` for the next structural boundary, skipping over
 * regions that are opaque to structure: escaped chars, `%` comments to EOL,
 * inline `$…$` / `\(…\)` math, and `\verb⟨d⟩…⟨d⟩`. `inList` enables `\item`
 * boundaries. A blank boundary points at the `\n` that ends the last
 * non-blank line (the paragraph keeps that newline; the blank block starts
 * on the next line).
 */
function nextBoundary(
  text: string,
  i: number,
  limit: number,
  inList: boolean,
  budget: Budget,
): Boundary {
  while (i < limit) {
    checkBudget(budget);
    const ch = text.charCodeAt(i);

    if (ch === 10 /* \n */) {
      if (isParagraphBreak(text, i, limit)) return { type: "blank", pos: i + 1 };
      i++;
      continue;
    }

    if (ch === 37 /* % */) {
      const eol = text.indexOf("\n", i);
      i = eol === -1 || eol > limit ? limit : eol;
      continue;
    }

    if (ch === 36 /* $ */) {
      if (text.charCodeAt(i + 1) === 36) {
        return { type: "displayMath", pos: i, delim: "dollars" };
      }
      const close = findMathClose(text, i + 1, "$", limit);
      i = close === -1 ? i + 1 : close;
      continue;
    }

    if (ch !== 92 /* \ */) {
      i++;
      continue;
    }

    const next = i + 1 < limit ? text.charCodeAt(i + 1) : -1;

    if (next === 91 /* \[ */) return { type: "displayMath", pos: i, delim: "bracket" };

    if (next === 40 /* \( */) {
      const close = findMathClose(text, i + 2, "\\)", limit);
      i = close === -1 ? i + 2 : close;
      continue;
    }

    if (!isLetter(next)) {
      i += 2; // escaped char or symbol control sequence
      continue;
    }

    let e = i + 1;
    while (e < limit && isLetter(text.charCodeAt(e))) e++;
    const name = text.slice(i + 1, e);

    if (name === "begin" || name === "end") {
      const m = RE_ENV_NAME.exec(text.slice(e, e + 24));
      if (m) {
        return { type: name, pos: i, name: m[1], nameEnd: e + m[0].length };
      }
      i = e;
      continue;
    }

    const level = HEADING_LEVELS[name];
    if (level !== undefined) {
      const starred = text.charCodeAt(e) === 42; /* * */
      return { type: "heading", pos: i, level, starred, nameEnd: starred ? e + 1 : e };
    }

    if (name === "item" && inList) {
      return { type: "item", pos: i, nameEnd: e };
    }

    if (name === "verb") {
      const d = e < limit ? text[e] : "";
      if (d !== "" && d !== "\n" && d !== "*") {
        const eol = text.indexOf("\n", e + 1);
        const closeAt = text.indexOf(d, e + 1);
        if (closeAt !== -1 && closeAt < limit && (eol === -1 || closeAt < eol)) {
          i = closeAt + 1;
          continue;
        }
      }
    }

    i = e;
  }
  return { type: "limit", pos: limit };
}

/* ------------------------------------------------------------------ */
/* Token helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Extend a structural token that ends at `end` through the trailing newline
 * when the rest of its line is blank — so hidden `\begin{itemize}` lines
 * vanish entirely instead of leaving an empty visual line.
 */
function extendThroughBlankTail(text: string, end: number, limit: number): number {
  let j = end;
  while (j < limit) {
    const c = text.charCodeAt(j);
    if (c === 10) return j + 1;
    if (c !== 32 && c !== 9) return end;
    j++;
  }
  return limit;
}

/** Consume one same-line `[..]` after `end` (env placement args). */
function consumeOptArg(text: string, end: number, limit: number): number {
  const at = skipInlineSpace(text, end);
  if (at < limit && text.charCodeAt(at) === 91 /* [ */) {
    const closeBracket = text.indexOf("]", at + 1);
    const eol = text.indexOf("\n", at);
    if (
      closeBracket !== -1 &&
      closeBracket < limit &&
      closeBracket - at <= MAX_OPT_ARG &&
      (eol === -1 || closeBracket < eol)
    ) {
      return closeBracket + 1;
    }
  }
  return end;
}

/* ------------------------------------------------------------------ */
/* Block parser                                                        */
/* ------------------------------------------------------------------ */

interface ParseCtx {
  text: string;
  budget: Budget;
}

interface ParseRegionResult {
  blocks: BlockNode[];
  /** Position after the region (== limit, or after a stop `\end` token). */
  end: number;
  /** The stop env's `\end{name}` token span, when that closed the region. */
  stopToken: Span | null;
}

/**
 * Parse `[from, limit)` into blocks. `stopEnv` names the enclosing
 * transparent environment whose `\end` closes this region; `listDepth`
 * counts enclosing list envs (for item markers and hanging indents).
 */
function parseRegion(
  ctx: ParseCtx,
  from: number,
  limit: number,
  stopEnv: string | null,
  listDepth: number,
  ordinalRef: { n: number } | null,
): ParseRegionResult {
  const { text, budget } = ctx;
  const blocks: BlockNode[] = [];
  let i = from;

  const flushBlanksAndComments = (): boolean => {
    // At a line start: emit blank runs and whole-line comments as blocks.
    // Returns true when it consumed something.
    let consumed = false;
    for (;;) {
      checkBudget(budget);
      if (i >= limit) return consumed;
      // Blank-line run.
      let j = i;
      let sawBlank = false;
      for (;;) {
        let k = j;
        while (k < limit) {
          const c = text.charCodeAt(k);
          if (c === 10) break;
          if (c !== 32 && c !== 9) break;
          k++;
        }
        if (k < limit && text.charCodeAt(k) === 10) {
          j = k + 1;
          sawBlank = true;
          continue;
        }
        // Whitespace-only tail at the limit counts as blank filler.
        if (k >= limit && j < limit) {
          j = limit;
          sawBlank = true;
        }
        break;
      }
      if (sawBlank && j > i) {
        blocks.push({ kind: "blank", from: i, to: j });
        i = j;
        consumed = true;
        continue;
      }
      // Whole-line comment.
      const at = skipInlineSpace(text, i);
      if (at < limit && text.charCodeAt(at) === 37 /* % */) {
        let eol = text.indexOf("\n", at);
        eol = eol === -1 || eol >= limit ? limit : eol + 1;
        blocks.push({ kind: "commentLine", from: i, to: eol });
        i = eol;
        consumed = true;
        continue;
      }
      return consumed;
    }
  };

  const emitParagraph = (start: number, end: number): void => {
    if (end <= start) return;
    blocks.push({
      kind: "paragraph",
      from: start,
      to: end,
      inlines: scanInline(text, start, end),
    });
  };

  while (i < limit) {
    checkBudget(budget);
    flushBlanksAndComments();
    if (i >= limit) break;

    const b = nextBoundary(text, i, limit, listDepth > 0, budget);

    if (b.type === "limit") {
      emitParagraph(i, limit);
      i = limit;
      break;
    }

    if (b.type === "blank") {
      emitParagraph(i, b.pos);
      i = b.pos;
      continue;
    }

    if (b.type === "end") {
      if (stopEnv !== null && b.name === stopEnv) {
        emitParagraph(i, b.pos);
        const tokenEnd = extendThroughBlankTail(text, b.nameEnd, limit);
        return { blocks, end: tokenEnd, stopToken: { from: b.pos, to: tokenEnd } };
      }
      // Stray \end — flows into the paragraph, where it chips.
      const para = paragraphThrough(ctx, b.nameEnd, limit, listDepth > 0);
      emitParagraph(i, para);
      i = para;
      continue;
    }

    if (b.type === "heading") {
      emitParagraph(i, b.pos);
      const heading = tryHeading(ctx, b, limit);
      if (heading !== null) {
        blocks.push(heading);
        i = heading.to;
      } else {
        // Unbounded title — the paragraph flow chips the control word.
        const para = paragraphThrough(ctx, b.nameEnd, limit, listDepth > 0);
        emitParagraph(b.pos, para);
        i = para;
      }
      continue;
    }

    if (b.type === "displayMath") {
      emitParagraph(i, b.pos);
      const opener = b.delim === "bracket" ? 2 : 2; /* \[ or $$ */
      const closer = b.delim === "bracket" ? "\\]" : "$$";
      const close = findMathClose(text, b.pos + opener, closer, limit);
      if (close !== -1) {
        const to = extendThroughBlankTail(text, close, limit);
        blocks.push({
          kind: "displayMath",
          from: b.pos,
          to,
          tex: { from: b.pos + opener, to: close - closer.length },
          delim: b.delim,
        });
        i = to;
      } else {
        // Unclosed opener — flows into the paragraph (chips / lone glyphs).
        const para = paragraphThrough(ctx, b.pos + opener, limit, listDepth > 0);
        emitParagraph(b.pos, para);
        i = para;
      }
      continue;
    }

    if (b.type === "item") {
      emitParagraph(i, b.pos);
      blocks.push(itemMarker(ctx, b, limit, listDepth, ordinalRef));
      i = blocks[blocks.length - 1].to;
      continue;
    }

    // b.type === "begin"
    emitParagraph(i, b.pos);
    const env = parseEnvironment(ctx, b, limit, listDepth);
    blocks.push(env);
    i = env.to;
  }

  return { blocks, end: limit, stopToken: null };
}

/**
 * Find where the paragraph continues to when the structural token ending at
 * `tokenEnd` turned out not to form a block (stray \end, unbounded heading):
 * the next boundary after the token, so the scanner doesn't loop on the same
 * position. The token itself stays paragraph text and chips inline.
 */
function paragraphThrough(
  ctx: ParseCtx,
  tokenEnd: number,
  limit: number,
  inList: boolean,
): number {
  const b = nextBoundary(ctx.text, tokenEnd, limit, inList, ctx.budget);
  return b.pos;
}

function tryHeading(
  ctx: ParseCtx,
  b: Extract<Boundary, { type: "heading" }>,
  limit: number,
): HeadingBlock | null {
  const { text } = ctx;
  const braceAt = skipInlineSpace(text, b.nameEnd);
  if (braceAt >= limit || text.charCodeAt(braceAt) !== 123 /* { */) return null;
  const close = matchBrace(text, braceAt, MAX_HEADING_ARG, true, limit);
  if (close === -1) return null;
  const to = extendThroughBlankTail(text, close + 1, limit);
  return {
    kind: "heading",
    from: b.pos,
    to,
    level: b.level,
    starred: b.starred,
    hide: [
      { from: b.pos, to: braceAt + 1 },
      { from: close, to },
    ],
    content: { from: braceAt + 1, to: close },
    inlines: scanInline(text, braceAt + 1, close),
  };
}

function itemMarker(
  ctx: ParseCtx,
  b: Extract<Boundary, { type: "item" }>,
  limit: number,
  listDepth: number,
  ordinalRef: { n: number } | null,
): BlockNode {
  const { text } = ctx;
  const bracketAt = skipInlineSpace(text, b.nameEnd);
  if (bracketAt < limit && text.charCodeAt(bracketAt) === 91 /* [ */) {
    const closeBracket = text.indexOf("]", bracketAt + 1);
    const eol = text.indexOf("\n", bracketAt + 1);
    if (
      closeBracket !== -1 &&
      closeBracket < limit &&
      closeBracket - bracketAt <= MAX_OPT_ARG &&
      (eol === -1 || closeBracket < eol)
    ) {
      const labelTo = extendThroughBlankTail(text, closeBracket + 1, limit);
      return {
        kind: "itemMarker",
        from: b.pos,
        to: labelTo,
        hide: [
          { from: b.pos, to: bracketAt + 1 },
          { from: closeBracket, to: labelTo },
        ],
        label: { from: bracketAt + 1, to: closeBracket },
        ordinal: null,
        depth: listDepth,
      };
    }
  }
  const ordinal = ordinalRef !== null ? ++ordinalRef.n : null;
  // Swallow one following space (no marker double-gap), or — when the rest
  // of the line is blank — the whole tail, so `\item⏎content` reads as one
  // item instead of a marker followed by a phantom paragraph gap.
  let to =
    b.nameEnd < limit && text.charCodeAt(b.nameEnd) === 32
      ? b.nameEnd + 1
      : b.nameEnd;
  to = extendThroughBlankTail(text, to, limit);
  return {
    kind: "itemMarker",
    from: b.pos,
    to,
    hide: [{ from: b.pos, to }],
    label: null,
    ordinal,
    depth: listDepth,
  };
}

function parseEnvironment(
  ctx: ParseCtx,
  b: Extract<Boundary, { type: "begin" }>,
  limit: number,
  listDepth: number,
): BlockNode {
  const { text, budget } = ctx;
  const name = b.name;
  const envKind = envKindOf(name);
  const isList = envKind === "list";

  let tokenEnd = consumeOptArg(text, b.nameEnd, limit);
  tokenEnd = extendThroughBlankTail(text, tokenEnd, limit);
  const beginToken: Span = { from: b.pos, to: tokenEnd };

  if (TRANSPARENT_ENV_KINDS.has(envKind)) {
    const ordinalRef = name === "enumerate" ? { n: 0 } : null;
    const region = parseRegion(
      ctx,
      tokenEnd,
      limit,
      name,
      isList ? listDepth + 1 : listDepth,
      ordinalRef,
    );
    return {
      kind: "environment",
      from: b.pos,
      to: region.end,
      name,
      envKind,
      beginToken,
      endToken: region.stopToken,
      body: { from: tokenEnd, to: region.stopToken ? region.stopToken.from : region.end },
      children: region.blocks,
      listDepth: isList ? listDepth + 1 : listDepth,
    };
  }

  // Opaque env: find the matching \end{name}. Verbatim kinds take the first
  // literal \end{name}; others count same-name nesting.
  const endMarker = `\\end{${name}}`;
  const beginMarker = `\\begin{${name}}`;
  let depth = 1;
  let searchAt = tokenEnd;
  let endTokenStart = -1;
  while (searchAt < limit) {
    checkBudget(budget);
    const at = text.indexOf(endMarker, searchAt);
    if (at === -1 || at >= limit) break;
    if (envKind !== "verbatim") {
      let inner = text.indexOf(beginMarker, searchAt);
      while (inner !== -1 && inner < at) {
        depth++;
        inner = text.indexOf(beginMarker, inner + beginMarker.length);
      }
    }
    depth--;
    if (depth === 0) {
      endTokenStart = at;
      break;
    }
    searchAt = at + endMarker.length;
  }

  if (endTokenStart === -1) {
    // Unclosed env — the body runs to the region limit.
    return {
      kind: "environment",
      from: b.pos,
      to: limit,
      name,
      envKind,
      beginToken,
      endToken: null,
      body: { from: tokenEnd, to: limit },
      children: null,
      listDepth,
    };
  }

  const endTokenEnd = extendThroughBlankTail(
    text,
    endTokenStart + endMarker.length,
    limit,
  );
  return {
    kind: "environment",
    from: b.pos,
    to: endTokenEnd,
    name,
    envKind,
    beginToken,
    endToken: { from: endTokenStart, to: endTokenEnd },
    body: { from: tokenEnd, to: endTokenStart },
    children: null,
    listDepth,
  };
}

/* ------------------------------------------------------------------ */
/* Document entry                                                      */
/* ------------------------------------------------------------------ */

/**
 * Locate `\begin{document}` (skipping `%`-commented occurrences) within the
 * first PREAMBLE_SCAN_BYTES chars. Returns the offset of the match, or null —
 * fragment files without one get no preamble chip.
 */
export function findPreambleEnd(text: string): number | null {
  const limit = Math.min(text.length, PREAMBLE_SCAN_BYTES);
  const re = /\\begin\s*\{document\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= limit) return null;
    const ls = text.lastIndexOf("\n", m.index) + 1;
    let commented = false;
    for (let j = ls; j < m.index; j++) {
      const c = text.charCodeAt(j);
      if (c === 92 /* \ */) {
        j++;
        continue;
      }
      if (c === 37 /* % */) {
        commented = true;
        break;
      }
    }
    if (!commented) return m.index;
  }
  return null;
}

export interface TopRegionResult {
  blocks: BlockNode[];
  end: number;
  stopToken: Span | null;
}

/**
 * Parse a top-level slice of the document (incremental rescan). `stopEnv`
 * is "document" while the body is still open (a stray `\end{document}` in
 * the slice closes it), null after `\end{document}` or for fragments.
 */
export function parseTopRegion(
  text: string,
  from: number,
  limit: number,
  budget: Budget,
  stopEnv: string | null,
): TopRegionResult {
  return parseRegion({ text, budget }, from, limit, stopEnv, 0, null);
}

export interface ParseDocumentResult {
  blocks: BlockNode[];
  preambleEnd: number | null;
}

/** Parse the whole document. Throws ScanAborted on budget expiry. */
export function parseDocument(text: string, budget: Budget): ParseDocumentResult {
  const n = text.length;
  const blocks: BlockNode[] = [];
  let bodyFrom = 0;
  const preambleEnd = findPreambleEnd(text);

  if (preambleEnd !== null) {
    const lineStart = text.lastIndexOf("\n", preambleEnd) + 1;
    if (lineStart > 0) {
      blocks.push({ kind: "preamble", from: 0, to: lineStart });
    }
    // The \begin{document} line: leading indent + token + blank tail.
    const m = /^\\begin\s*\{document\}/.exec(text.slice(preambleEnd));
    const tokenEnd = extendThroughBlankTail(text, preambleEnd + (m ? m[0].length : 0), n);
    blocks.push({ kind: "docBegin", from: lineStart, to: tokenEnd });
    bodyFrom = tokenEnd;
  }

  // Body region; \end{document} closes it like a stop env.
  const region = parseRegion({ text, budget }, bodyFrom, n, "document", 0, null);
  blocks.push(...region.blocks);
  if (region.stopToken) {
    blocks.push({ kind: "docEnd", from: region.stopToken.from, to: region.stopToken.to });
    if (region.end < n) {
      // TeX ignores trailing text; parse it as ordinary blocks anyway.
      const tail = parseRegion({ text, budget }, region.end, n, null, 0, null);
      blocks.push(...tail.blocks);
    }
  }

  return { blocks, preambleEnd };
}
