/**
 * Inline scanner: classifies a prose span (paragraph body, heading title,
 * style-argument content) into InlineNodes. Pure — string in, nodes out.
 *
 * Coverage discipline: nothing "falls through". A construct the scanner can
 * bound becomes a style/group/math/pill/chip node; one it cannot bound
 * degrades to the smallest honest unit (a command chip over the control
 * word, a one-char brace chip, a literal-glyph escape) — never to raw
 * multi-character markup. Gaps between nodes are prose content by
 * definition (see nodes.ts coverage()).
 */

import type { InlineNode, PillCommand, Span, StyleKind } from "./nodes";

/* ------------------------------------------------------------------ */
/* Shared low-level lexing helpers (also used by scan-blocks)          */
/* ------------------------------------------------------------------ */

export const MAX_INLINE_ARG = 1000;
/**
 * Cap for prose wrappers (`\footnote`, `\caption`, `\href`). Larger than
 * MAX_INLINE_ARG because these hold whole sentences: past the cap the
 * construct degrades to a chip, which would swallow the prose.
 */
export const MAX_WRAPPER_ARG = 4000;
export const MAX_PILL_ARG = 200;
export const MAX_OPT_ARG = 200;
export const MAX_MATH_SPAN = 5000;
export const MAX_BRACE_DEPTH = 32;
export const MAX_NEST_DEPTH = 16;

/** Command-name characters — TeX control words are letters only. */
export const isLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

const isSpaceOrTab = (code: number): boolean => code === 32 || code === 9;

/** Skip spaces/tabs (never newlines) from `i`; returns the next index. */
export function skipInlineSpace(text: string, i: number): number {
  while (i < text.length && isSpaceOrTab(text.charCodeAt(i))) i++;
  return i;
}

/**
 * True when the newline at `nl` is followed by a blank line (whitespace-only
 * up to the next newline or end) — i.e. a TeX paragraph break.
 */
export function isParagraphBreak(text: string, nl: number, limit: number): boolean {
  let j = nl + 1;
  while (j < limit) {
    const c = text.charCodeAt(j);
    if (c === 10) return true;
    if (!isSpaceOrTab(c)) return false;
    j++;
  }
  // A trailing whitespace run at the limit is not a break.
  return false;
}

/**
 * Match a brace-delimited argument starting at the `{` at `open`. Returns
 * the index of the matching `}` or -1. Skips escaped chars and `%` comments;
 * bails on the length cap, the nesting cap, a paragraph break, or (when
 * `sameLine`) any newline.
 */
export function matchBrace(
  text: string,
  open: number,
  maxLen: number,
  sameLine: boolean,
  limit = text.length,
): number {
  let depth = 0;
  const cap = Math.min(limit, open + maxLen + 2);
  for (let j = open; j < cap; j++) {
    const c = text.charCodeAt(j);
    if (c === 92 /* \ */) {
      j++;
      continue;
    }
    if (c === 10 /* \n */) {
      if (sameLine || isParagraphBreak(text, j, limit)) return -1;
      continue;
    }
    if (c === 37 /* % */) {
      const eol = text.indexOf("\n", j);
      if (eol === -1 || eol >= cap) return -1;
      j = eol - 1; // the \n is handled next iteration
      continue;
    }
    if (c === 123 /* { */) {
      depth++;
      if (depth > MAX_BRACE_DEPTH) return -1;
    } else if (c === 125 /* } */) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Find the index just past the closing delimiter of a math span opened at
 * `from` (positioned after the opener), or -1. Bails at paragraph breaks.
 */
export function findMathClose(
  text: string,
  from: number,
  closer: string,
  limit = text.length,
): number {
  const cap = Math.min(limit, from + MAX_MATH_SPAN);
  for (let j = from; j < cap; j++) {
    if (text.startsWith(closer, j)) return j + closer.length;
    const c = text.charCodeAt(j);
    if (c === 92 /* \ */) j++;
    else if (c === 10 && isParagraphBreak(text, j, limit)) return -1;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Construct tables                                                    */
/* ------------------------------------------------------------------ */

/**
 * `\cmd{prose}` — the argument stays live, editable document text. Semantic
 * wrappers (footnote/caption/url) belong here too: what matters is that the
 * prose is not swallowed into an atomic chip, not that the effect is a font.
 */
const INLINE_STYLES: Record<string, StyleKind> = {
  textbf: "bold",
  textit: "italic",
  emph: "italic",
  underline: "underline",
  texttt: "code",
  textsc: "smallcaps",
  textsf: "sans",
  textrm: "serif",
  textnormal: "normal",
  textmd: "normal",
  textup: "normal",
  textsuperscript: "sup",
  textsubscript: "sub",
  MakeUppercase: "upper",
  uppercase: "upper",
  MakeLowercase: "lower",
  lowercase: "lower",
  footnote: "footnote",
  footnotetext: "footnote",
  caption: "caption",
  url: "link",
  path: "link",
  nolinkurl: "link",
  title: "docTitle",
  author: "docAuthor",
  date: "docDate",
  institute: "docInstitute",
  // Author-block containers hold names, not markup — without these the
  // IEEE class's `\author{\IEEEauthorblockN{…}}` swallows the names.
  IEEEauthorblockN: "normal",
  IEEEauthorblockA: "normal",
};

/**
 * Wrappers whose argument has verbatim catcodes: `~ $ \ # &` are literal
 * characters there, not TeX. Their content is NOT rescanned — prose lexing
 * would render `\url{x/~bob}` as "x/ bob", i.e. a wrong URL presented as the
 * truth. Empty children leave the span classified as plain content.
 */
const VERBATIM_ARG_STYLES = new Set(["url", "path", "nolinkurl"]);

/** `\cmd{meta}{prose}` — first argument is metadata, second is live prose. */
const WRAPPED_SECOND_ARG: Record<string, StyleKind> = {
  href: "link",
  textcolor: "colored",
  colorbox: "colored",
};

/** Declarations that style a bare group: `{\em …}`. */
const DECL_STYLES: Record<string, StyleKind> = {
  em: "italic",
  itshape: "italic",
  bfseries: "bold",
  ttfamily: "code",
};

const PILL_COMMANDS = new Set<PillCommand>([
  "cite",
  "ref",
  "eqref",
  "autoref",
  "label",
]);

/** `\X` where X is one of these renders as the literal glyph. */
const ESCAPE_CHARS = new Set(["%", "$", "&", "#", "_", "{", "}"]);

/** `\ ` and `\,` render as a plain space glyph. */
const SPACE_ESCAPES = new Set([" ", ","]);

/* ------------------------------------------------------------------ */
/* Scanner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Scan `[from, to)` of `text` into inline nodes. The span must not contain
 * a paragraph break (the block scanner guarantees this for the spans it
 * hands over). `depth` guards pathological nesting: at the cap, bounded
 * constructs degrade to atomic command chips instead of recursing.
 */
export function scanInline(
  text: string,
  from: number,
  to: number,
  depth = 0,
): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = from;

  const pushCommandChip = (start: number, end: number, name: string, args: Span[]) => {
    nodes.push({ kind: "command", from: start, to: end, name, args });
  };

  while (i < to) {
    const ch = text.charCodeAt(i);

    if (ch === 10 /* \n */) {
      const prev = nodes[nodes.length - 1];
      nodes.push({
        kind: "softNewline",
        from: i,
        to: i + 1,
        joinTight: prev !== undefined && prev.kind === "comment" && prev.to === i,
      });
      i++;
      continue;
    }

    if (ch === 37 /* % */) {
      let eol = text.indexOf("\n", i);
      if (eol === -1 || eol > to) eol = to;
      nodes.push({ kind: "comment", from: i, to: eol });
      i = eol;
      continue;
    }

    if (ch === 36 /* $ */) {
      // Only single-$ math is inline ($$ display is split out by the block
      // scanner; a stray "$$" here is two unmatched dollars).
      const close =
        text.charCodeAt(i + 1) === 36
          ? -1
          : findMathClose(text, i + 1, "$", to);
      if (close !== -1) {
        nodes.push({
          kind: "inlineMath",
          from: i,
          to: close,
          tex: { from: i + 1, to: close - 1 },
          delim: "dollar",
        });
        i = close;
      } else {
        // Lone dollar — honest single glyph.
        nodes.push({ kind: "escape", from: i, to: i + 1, ch: "$" });
        i++;
      }
      continue;
    }

    if (ch === 123 /* { */) {
      const close = matchBrace(text, i, MAX_INLINE_ARG, false, to);
      if (close === -1) {
        nodes.push({ kind: "brace", from: i, to: i + 1, side: "open" });
        i++;
        continue;
      }
      if (depth >= MAX_NEST_DEPTH) {
        pushCommandChip(i, close + 1, "group", [{ from: i, to: close + 1 }]);
        i = close + 1;
        continue;
      }
      // `{\em text}` → styled group; plain `{text}` → invisible group.
      let contentFrom = i + 1;
      let style: StyleKind | null = null;
      if (text.charCodeAt(contentFrom) === 92 /* \ */) {
        let e = contentFrom + 1;
        while (e < close && isLetter(text.charCodeAt(e))) e++;
        const decl = DECL_STYLES[text.slice(contentFrom + 1, e)];
        if (decl !== undefined) {
          style = decl;
          contentFrom = skipInlineSpace(text, e);
        }
      }
      const children = scanInline(text, contentFrom, close, depth + 1);
      if (style !== null) {
        nodes.push({
          kind: "style",
          from: i,
          to: close + 1,
          style,
          hide: [
            { from: i, to: contentFrom },
            { from: close, to: close + 1 },
          ],
          content: { from: contentFrom, to: close },
          children,
        });
      } else {
        nodes.push({
          kind: "group",
          from: i,
          to: close + 1,
          hide: [
            { from: i, to: i + 1 },
            { from: close, to: close + 1 },
          ],
          content: { from: i + 1, to: close },
          children,
        });
      }
      i = close + 1;
      continue;
    }

    if (ch === 125 /* } */) {
      nodes.push({ kind: "brace", from: i, to: i + 1, side: "close" });
      i++;
      continue;
    }

    if (ch === 126 /* ~ */) {
      // Bare tie is a non-breaking space in LaTeX; render it as whitespace
      // instead of a literal tilde (matches the `\ `/`\,` space escapes).
      nodes.push({ kind: "escape", from: i, to: i + 1, ch: " " });
      i++;
      continue;
    }

    if (ch !== 92 /* \ */) {
      i++;
      continue;
    }

    // ---- backslash constructs ----
    const next = i + 1 < to ? text.charCodeAt(i + 1) : -1;

    if (next === 92 /* \\ */) {
      // Hard break, optional [len] on the same line.
      let end = i + 2;
      if (text.charCodeAt(end) === 91 /* [ */) {
        const closeBracket = text.indexOf("]", end + 1);
        const eol = text.indexOf("\n", end);
        if (
          closeBracket !== -1 &&
          closeBracket < to &&
          closeBracket - end <= MAX_OPT_ARG &&
          (eol === -1 || closeBracket < eol)
        ) {
          end = closeBracket + 1;
        }
      }
      nodes.push({ kind: "lineBreak", from: i, to: end });
      i = end;
      continue;
    }

    if (next === 40 /* \( */) {
      const close = findMathClose(text, i + 2, "\\)", to);
      if (close !== -1) {
        nodes.push({
          kind: "inlineMath",
          from: i,
          to: close,
          tex: { from: i + 2, to: close - 2 },
          delim: "paren",
        });
        i = close;
        continue;
      }
      pushCommandChip(i, i + 2, "(", []);
      i += 2;
      continue;
    }

    if (next !== -1 && !isLetter(next)) {
      const nextCh = text[i + 1];
      if (ESCAPE_CHARS.has(nextCh)) {
        nodes.push({ kind: "escape", from: i, to: i + 2, ch: nextCh });
      } else if (SPACE_ESCAPES.has(nextCh)) {
        nodes.push({ kind: "escape", from: i, to: i + 2, ch: " " });
      } else {
        // Symbol control sequence (\;, \!, \~, \^, \") — atomic chip.
        pushCommandChip(i, i + 2, nextCh, []);
      }
      i += 2;
      continue;
    }

    if (next === -1) {
      // Trailing backslash at the span edge.
      pushCommandChip(i, i + 1, "\\", []);
      i++;
      continue;
    }

    // Control word.
    let e = i + 1;
    while (e < to && isLetter(text.charCodeAt(e))) e++;
    const name = text.slice(i + 1, e);

    if (name === "verb") {
      // \verb⟨d⟩…⟨d⟩ / \verb*⟨d⟩…⟨d⟩ — delimiter is the next char, same line.
      let dAt = e;
      if (dAt < to && text.charCodeAt(dAt) === 42 /* * */) dAt++;
      const d = dAt < to ? text[dAt] : "";
      if (d !== "" && d !== "\n") {
        const eol = text.indexOf("\n", dAt + 1);
        const closeAt = text.indexOf(d, dAt + 1);
        if (closeAt !== -1 && closeAt < to && (eol === -1 || closeAt < eol)) {
          nodes.push({ kind: "verb", from: i, to: closeAt + 1 });
          i = closeAt + 1;
          continue;
        }
      }
      pushCommandChip(i, e, name, []);
      i = e;
      continue;
    }

    const style = INLINE_STYLES[name];
    if (style !== undefined) {
      const braceAt = skipInlineSpace(text, e);
      if (braceAt < to && text.charCodeAt(braceAt) === 123 /* { */) {
        const close = matchBrace(text, braceAt, MAX_WRAPPER_ARG, false, to);
        if (close !== -1) {
          if (depth >= MAX_NEST_DEPTH) {
            pushCommandChip(i, close + 1, name, [{ from: braceAt, to: close + 1 }]);
            i = close + 1;
            continue;
          }
          nodes.push({
            kind: "style",
            from: i,
            to: close + 1,
            style,
            hide: [
              { from: i, to: braceAt + 1 },
              { from: close, to: close + 1 },
            ],
            content: { from: braceAt + 1, to: close },
            children: VERBATIM_ARG_STYLES.has(name)
              ? []
              : scanInline(text, braceAt + 1, close, depth + 1),
          });
          i = close + 1;
          continue;
        }
      }
      // No bounded argument — chip the control word alone; following braces
      // classify themselves (group or brace chip).
      pushCommandChip(i, e, name, []);
      i = e;
      continue;
    }

    if ((PILL_COMMANDS as Set<string>).has(name)) {
      let cursor = skipInlineSpace(text, e);
      let optArg: Span | null = null;
      if (cursor < to && text.charCodeAt(cursor) === 91 /* [ */) {
        const closeBracket = text.indexOf("]", cursor + 1);
        const eol = text.indexOf("\n", cursor);
        if (
          closeBracket !== -1 &&
          closeBracket < to &&
          closeBracket - cursor <= MAX_OPT_ARG &&
          (eol === -1 || closeBracket < eol)
        ) {
          optArg = { from: cursor, to: closeBracket + 1 };
          cursor = skipInlineSpace(text, closeBracket + 1);
        }
      }
      if (cursor < to && text.charCodeAt(cursor) === 123 /* { */) {
        const close = matchBrace(text, cursor, MAX_PILL_ARG, true, to);
        if (close !== -1 && close > cursor + 1) {
          nodes.push({
            kind: "pill",
            from: i,
            to: close + 1,
            command: name as PillCommand,
            optArg,
            arg: { from: cursor + 1, to: close },
          });
          i = close + 1;
          continue;
        }
      }
      pushCommandChip(i, e, name, []);
      i = e;
      continue;
    }

    const wrapped = WRAPPED_SECOND_ARG[name];
    if (wrapped !== undefined) {
      // `\href{url}{text}` — the whole `\href{url}{` prefix is one hidden
      // wrapper span so the coverage tiling is unchanged from a `\cmd{…}`.
      const a1 = skipInlineSpace(text, e);
      if (a1 < to && text.charCodeAt(a1) === 123 /* { */) {
        const close1 = matchBrace(text, a1, MAX_OPT_ARG, false, to);
        if (close1 !== -1) {
          const a2 = skipInlineSpace(text, close1 + 1);
          if (a2 < to && text.charCodeAt(a2) === 123 /* { */) {
            const close2 = matchBrace(text, a2, MAX_WRAPPER_ARG, false, to);
            if (close2 !== -1) {
              if (depth >= MAX_NEST_DEPTH) {
                pushCommandChip(i, close2 + 1, name, [
                  { from: a1, to: close1 + 1 },
                  { from: a2, to: close2 + 1 },
                ]);
              } else {
                nodes.push({
                  kind: "style",
                  from: i,
                  to: close2 + 1,
                  style: wrapped,
                  hide: [
                    { from: i, to: a2 + 1 },
                    { from: close2, to: close2 + 1 },
                  ],
                  content: { from: a2 + 1, to: close2 },
                  children: scanInline(text, a2 + 1, close2, depth + 1),
                });
              }
              i = close2 + 1;
              continue;
            }
          }
        }
      }
      // Malformed — fall through to the chip so nothing is half-consumed.
    }

    // Unknown control word: consume `*`, then up to 2 same-line [..] and up
    // to 2 bounded {..} arguments into one atomic chip. Arguments must be
    // ADJACENT (no space) — `\vspace{1em} {\em x}` keeps the styled group
    // out of the chip; a spaced-off group renders as an invisible group.
    let end = e;
    if (end < to && text.charCodeAt(end) === 42 /* * */) end++;
    const args: Span[] = [];
    let bracketCount = 0;
    let braceCount = 0;
    for (;;) {
      const at = end;
      if (at >= to) break;
      const c = text.charCodeAt(at);
      if (c === 91 /* [ */ && bracketCount < 2) {
        const closeBracket = text.indexOf("]", at + 1);
        const eol = text.indexOf("\n", at);
        if (
          closeBracket === -1 ||
          closeBracket >= to ||
          closeBracket - at > MAX_OPT_ARG ||
          (eol !== -1 && closeBracket > eol)
        ) {
          break;
        }
        args.push({ from: at, to: closeBracket + 1 });
        end = closeBracket + 1;
        bracketCount++;
        continue;
      }
      if (c === 123 /* { */ && braceCount < 2) {
        const close = matchBrace(text, at, MAX_INLINE_ARG, false, to);
        if (close === -1) break;
        args.push({ from: at, to: close + 1 });
        end = close + 1;
        braceCount++;
        continue;
      }
      break;
    }
    pushCommandChip(i, end, name, args);
    i = end;
  }

  return nodes;
}
