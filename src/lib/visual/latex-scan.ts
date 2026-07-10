/**
 * Pure LaTeX construct scanner for the visual editor mode. No CodeMirror
 * imports — string in, typed nodes out — so the recognition rules are
 * directly unit-testable on fixtures (latex-scan.test.ts).
 *
 * The scanner is deliberately best-effort: anything it can't bound cleanly
 * (unbalanced braces, over-long or multi-line arguments, openers beyond the
 * caller's lookback window) is simply not emitted, which the decoration
 * layer renders as plain source. It never dispatches anything and never
 * throws on malformed input — the zero-corruption invariant of the visual
 * mode rests on this module having no write path at all.
 */

export interface SubRange {
  from: number;
  to: number;
}

export type InlineStyleKind = "bold" | "italic" | "underline";

export interface HeadingNode {
  type: "heading";
  from: number;
  to: number;
  /** 1 = \section, 2 = \subsection, 3 = \subsubsection. */
  level: 1 | 2 | 3;
  /** Wrapper token ranges to hide (`\section{` and `}`). */
  hide: SubRange[];
  /** The argument text, styled but kept as real document text. */
  content: SubRange;
}

export interface InlineStyleNode {
  type: "inlineStyle";
  from: number;
  to: number;
  style: InlineStyleKind;
  hide: SubRange[];
  content: SubRange;
}

export interface ItemNode {
  type: "item";
  /** Span of the `\item` (or `\item[label]`) token itself. */
  from: number;
  to: number;
  /** Ranges replaced by the marker widget / hidden wrapper tokens. */
  hide: SubRange[];
  /** Custom label text kept visible for `\item[label]`; null otherwise. */
  label: SubRange | null;
  /** 1-based ordinal within the enclosing enumerate; null → bullet. */
  ordinal: number | null;
  /** List nesting depth (1 = top-level list) for the hanging indent. */
  depth: number;
}

export type EnvLineRole = "begin" | "end" | "interior";

export interface EnvLineNode {
  type: "envLine";
  /** Full line span (line start to line end, newline excluded). */
  from: number;
  to: number;
  env: string;
  role: EnvLineRole;
}

export interface PillNode {
  type: "pill";
  from: number;
  to: number;
  /** cite / ref / eqref / autoref / label. */
  command: string;
  hide: SubRange[];
  content: SubRange;
}

export interface CommentNode {
  type: "comment";
  /** From the `%` to the end of the line. */
  from: number;
  to: number;
}

export interface MathNode {
  type: "math";
  from: number;
  to: number;
  /** True for \[…\] and $$…$$; inline $…$ / \(…\) are false. */
  display: boolean;
}

export type VisualNode =
  | HeadingNode
  | InlineStyleNode
  | ItemNode
  | EnvLineNode
  | PillNode
  | CommentNode
  | MathNode;

export interface ScanOptions {
  /** Injectable clock (tests); defaults to performance.now / Date.now. */
  now?: () => number;
  /**
   * Absolute deadline in the `now()` timebase. Crossing it aborts the scan
   * (the layer then marks the file visual-paused). Defaults to
   * now() + SCAN_BUDGET_MS.
   */
  deadlineMs?: number;
}

export interface ScanResult {
  nodes: VisualNode[];
  /** True when the budget guard fired; `nodes` is empty then. */
  aborted: boolean;
}

/** Lookback the decoration layer prepends to the viewport for env openers. */
export const LOOKBACK_BYTES = 20_000;
/** findPreambleEnd never looks past this many chars. */
export const PREAMBLE_SCAN_BYTES = 100_000;
/** Hard budget for one scan+build pass (see plan 63 §3). */
export const SCAN_BUDGET_MS = 8;

const MAX_HEADING_ARG = 500;
const MAX_INLINE_ARG = 1000;
const MAX_PILL_ARG = 200;
const MAX_ITEM_LABEL = 200;
const MAX_MATH_SPAN = 5000;
const MAX_BRACE_DEPTH = 32;
/** Budget clock is sampled once per this many loop steps. */
const BUDGET_STRIDE = 2048;

const LIST_ENVS = new Set(["itemize", "enumerate"]);
const QUOTE_ENVS = new Set(["quote"]);
const VERBATIM_ENVS = new Set(["verbatim", "verbatim*"]);
const MATH_ENVS = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
]);

const HEADING_LEVELS: Record<string, 1 | 2 | 3> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
};

const INLINE_STYLES: Record<string, InlineStyleKind> = {
  textbf: "bold",
  textit: "italic",
  emph: "italic",
  underline: "underline",
};

const PILL_COMMANDS = new Set(["cite", "ref", "eqref", "autoref", "label"]);

const defaultNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

interface EnvFrame {
  name: string;
  itemCount: number;
}

const isRelevantEnv = (name: string): boolean =>
  LIST_ENVS.has(name) ||
  QUOTE_ENVS.has(name) ||
  VERBATIM_ENVS.has(name) ||
  MATH_ENVS.has(name);

export type EnvCategory = "list" | "quote" | "verbatim" | "math";

/** Category of an environment name the scanner emits envLine nodes for. */
export function envCategory(name: string): EnvCategory | null {
  if (LIST_ENVS.has(name)) return "list";
  if (QUOTE_ENVS.has(name)) return "quote";
  if (VERBATIM_ENVS.has(name)) return "verbatim";
  if (MATH_ENVS.has(name)) return "math";
  return null;
}

const isInteriorEnv = (name: string): boolean =>
  QUOTE_ENVS.has(name) || VERBATIM_ENVS.has(name) || MATH_ENVS.has(name);

/** Command-name characters — TeX control words are letters only. */
const isLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

/**
 * Match a brace-delimited argument starting at the `{` at `open`. Returns the
 * index of the matching `}` or -1. Skips escaped braces and `%` comments;
 * bails on the length cap, the nesting cap, or (when `sameLine`) a newline.
 */
function matchBrace(
  text: string,
  open: number,
  maxLen: number,
  sameLine: boolean,
): number {
  let depth = 0;
  const limit = Math.min(text.length, open + maxLen + 2);
  for (let j = open; j < limit; j++) {
    const c = text.charCodeAt(j);
    if (c === 92 /* \ */) {
      j++; // skip the escaped char (covers \{ \} \% \\)
      continue;
    }
    if (c === 10 /* \n */) {
      if (sameLine) return -1;
      continue;
    }
    if (c === 37 /* % */) {
      const eol = text.indexOf("\n", j);
      if (eol === -1) return -1;
      j = eol; // the \n is handled next iteration
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

/** Skip spaces/tabs (never newlines) from `i`; returns the next index. */
function skipInlineSpace(text: string, i: number): number {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return i;
}

/**
 * Find the closing delimiter of a math span opened at `start` (after the
 * opener). Returns the index just past the closer, or -1.
 */
function findMathClose(text: string, from: number, closer: string): number {
  const limit = Math.min(text.length, from + MAX_MATH_SPAN);
  for (let j = from; j < limit; j++) {
    if (text.startsWith(closer, j)) {
      // A "$$" closer must not match a lone "$" and vice versa: for "$" as
      // closer, "$$" here would be an empty display span — accept anyway,
      // it is cosmetic either way.
      return j + closer.length;
    }
    if (text.charCodeAt(j) === 92 /* \ */) j++;
  }
  return -1;
}

const RE_ENV_NAME = /^\{([a-zA-Z]+\*?)\}/;

/**
 * Scan `text` (absolute document offset `baseOffset`) for visual constructs.
 * Pure and deterministic; see ScanOptions for the injectable budget clock.
 */
export function scanLatex(
  text: string,
  baseOffset = 0,
  opts: ScanOptions = {},
): ScanResult {
  const now = opts.now ?? defaultNow;
  const deadline = opts.deadlineMs ?? now() + SCAN_BUDGET_MS;

  const nodes: VisualNode[] = [];
  const stack: EnvFrame[] = [];
  let verbatimDepth = 0;
  let mathEnvDepth = 0;
  const n = text.length;
  let i = 0;
  let lineStart = 0;
  /** Env begin/end events seen on the current line (emitted at line end). */
  let pendingRoles: { env: string; role: "begin" | "end" }[] = [];
  /** Skip-construct region for an already-emitted $…$/\(…\)/\[…\] span. */
  let mathSpanUntil = -1;
  let budgetCounter = 0;

  const abs = (p: number) => baseOffset + p;

  const innermostInterior = (): string | null => {
    for (let s = stack.length - 1; s >= 0; s--) {
      if (isInteriorEnv(stack[s].name)) return stack[s].name;
    }
    return null;
  };

  const finishLine = (lineEnd: number): void => {
    if (pendingRoles.length > 0) {
      for (const p of pendingRoles) {
        nodes.push({
          type: "envLine",
          from: abs(lineStart),
          to: abs(lineEnd),
          env: p.env,
          role: p.role,
        });
      }
      pendingRoles = [];
      return;
    }
    const env = innermostInterior();
    if (env) {
      nodes.push({
        type: "envLine",
        from: abs(lineStart),
        to: abs(lineEnd),
        env,
        role: "interior",
      });
    }
  };

  /** Pop through the innermost frame named `name` (tolerates bad nesting). */
  const popEnv = (name: string): void => {
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].name === name) {
        for (let k = stack.length - 1; k >= s; k--) {
          const popped = stack[k];
          if (VERBATIM_ENVS.has(popped.name)) verbatimDepth--;
          if (MATH_ENVS.has(popped.name)) mathEnvDepth--;
        }
        stack.length = s;
        return;
      }
    }
  };

  while (i < n) {
    if (++budgetCounter >= BUDGET_STRIDE) {
      budgetCounter = 0;
      if (now() > deadline) return { nodes: [], aborted: true };
    }

    const ch = text.charCodeAt(i);

    if (ch === 10 /* \n */) {
      finishLine(i);
      i++;
      lineStart = i;
      continue;
    }

    // Inside an emitted $…$/\(…\)/\[…\] span: opaque except line tracking.
    if (i < mathSpanUntil) {
      i++;
      continue;
    }

    // Verbatim contents are opaque — only its own \end token terminates.
    if (verbatimDepth > 0) {
      if (ch === 92 /* \ */ && text.startsWith("\\end", i)) {
        const m = RE_ENV_NAME.exec(text.slice(i + 4, i + 4 + 24));
        const top = stack[stack.length - 1];
        if (m && top && VERBATIM_ENVS.has(m[1]) && m[1] === top.name) {
          popEnv(m[1]);
          pendingRoles.push({ env: m[1], role: "end" });
          i += 4 + m[0].length;
          continue;
        }
      }
      i++;
      continue;
    }

    if (ch === 92 /* \ */) {
      const next = i + 1 < n ? text.charCodeAt(i + 1) : -1;

      // Delimiter math — emitted as one node, contents opaque.
      if (mathEnvDepth === 0 && (next === 40 /* ( */ || next === 91 /* [ */)) {
        const display = next === 91;
        const close = findMathClose(text, i + 2, display ? "\\]" : "\\)");
        if (close !== -1) {
          nodes.push({ type: "math", from: abs(i), to: abs(close), display });
          mathSpanUntil = close;
        }
        i += 2;
        continue;
      }

      if (!isLetter(next)) {
        // Escaped special (\% \$ \{ \} \\ …) or a symbol control sequence —
        // consume both chars so the payload is never re-read as a construct.
        i += 2;
        continue;
      }

      // Parse the control word.
      let e = i + 1;
      while (e < n && isLetter(text.charCodeAt(e))) e++;
      const name = text.slice(i + 1, e);

      if (name === "begin" || name === "end") {
        const m = RE_ENV_NAME.exec(text.slice(e, e + 24));
        if (!m) {
          i = e;
          continue;
        }
        const env = m[1];
        if (name === "begin") {
          stack.push({ name: env, itemCount: 0 });
          if (VERBATIM_ENVS.has(env)) verbatimDepth++;
          if (MATH_ENVS.has(env)) mathEnvDepth++;
          if (isRelevantEnv(env)) pendingRoles.push({ env, role: "begin" });
        } else {
          const known = stack.some((f) => f.name === env);
          if (known) popEnv(env);
          if (isRelevantEnv(env) && known) pendingRoles.push({ env, role: "end" });
        }
        i = e + m[0].length;
        continue;
      }

      // Math-env contents are opaque to every other construct.
      if (mathEnvDepth > 0) {
        i = e;
        continue;
      }

      const level = HEADING_LEVELS[name];
      if (level !== undefined) {
        // Starred variant (\section*{…}) hides the star with the token.
        const tokenEnd = text.charCodeAt(e) === 42 /* * */ ? e + 1 : e;
        const braceAt = skipInlineSpace(text, tokenEnd);
        if (text.charCodeAt(braceAt) === 123 /* { */) {
          const close = matchBrace(text, braceAt, MAX_HEADING_ARG, true);
          if (close !== -1 && close > braceAt + 1) {
            nodes.push({
              type: "heading",
              from: abs(i),
              to: abs(close + 1),
              level,
              hide: [
                { from: abs(i), to: abs(braceAt + 1) },
                { from: abs(close), to: abs(close + 1) },
              ],
              content: { from: abs(braceAt + 1), to: abs(close) },
            });
            i = braceAt + 1; // keep scanning inside the title
            continue;
          }
        }
        i = tokenEnd;
        continue;
      }

      const style = INLINE_STYLES[name];
      if (style !== undefined) {
        const braceAt = skipInlineSpace(text, e);
        if (text.charCodeAt(braceAt) === 123 /* { */) {
          const close = matchBrace(text, braceAt, MAX_INLINE_ARG, false);
          if (close !== -1 && close > braceAt + 1) {
            nodes.push({
              type: "inlineStyle",
              from: abs(i),
              to: abs(close + 1),
              style,
              hide: [
                { from: abs(i), to: abs(braceAt + 1) },
                { from: abs(close), to: abs(close + 1) },
              ],
              content: { from: abs(braceAt + 1), to: abs(close) },
            });
            i = braceAt + 1; // keep scanning inside — styles nest
            continue;
          }
        }
        i = e;
        continue;
      }

      if (name === "item") {
        // Innermost list frame owns the marker; \item outside any tracked
        // list (opener beyond the lookback) degrades to a plain bullet.
        let listFrame: EnvFrame | null = null;
        let depth = 0;
        for (let s = 0; s < stack.length; s++) {
          if (LIST_ENVS.has(stack[s].name)) {
            depth++;
            listFrame = stack[s];
          }
        }
        const bracketAt = skipInlineSpace(text, e);
        if (text.charCodeAt(bracketAt) === 91 /* [ */) {
          const closeBracket = text.indexOf("]", bracketAt + 1);
          const eol = text.indexOf("\n", bracketAt + 1);
          if (
            closeBracket !== -1 &&
            closeBracket - bracketAt <= MAX_ITEM_LABEL &&
            (eol === -1 || closeBracket < eol)
          ) {
            nodes.push({
              type: "item",
              from: abs(i),
              to: abs(closeBracket + 1),
              hide: [
                { from: abs(i), to: abs(bracketAt + 1) },
                { from: abs(closeBracket), to: abs(closeBracket + 1) },
              ],
              label: { from: abs(bracketAt + 1), to: abs(closeBracket) },
              ordinal: null,
              depth: Math.max(depth, 1),
            });
            i = bracketAt + 1;
            continue;
          }
          // Unterminated label — leave the whole item as source.
          i = e;
          continue;
        }
        const ordinal =
          listFrame && listFrame.name === "enumerate"
            ? ++listFrame.itemCount
            : null;
        // Hide a single following space so the marker doesn't double-gap.
        const hideTo = text.charCodeAt(e) === 32 ? e + 1 : e;
        nodes.push({
          type: "item",
          from: abs(i),
          to: abs(e),
          hide: [{ from: abs(i), to: abs(hideTo) }],
          label: null,
          ordinal,
          depth: Math.max(depth, 1),
        });
        i = e;
        continue;
      }

      if (PILL_COMMANDS.has(name)) {
        const argAt = skipInlineSpace(text, e);
        const argCh = text.charCodeAt(argAt);
        if (argCh === 123 /* { */) {
          const close = matchBrace(text, argAt, MAX_PILL_ARG, true);
          if (close !== -1 && close > argAt + 1) {
            nodes.push({
              type: "pill",
              from: abs(i),
              to: abs(close + 1),
              command: name,
              hide: [
                { from: abs(i), to: abs(argAt + 1) },
                { from: abs(close), to: abs(close + 1) },
              ],
              content: { from: abs(argAt + 1), to: abs(close) },
            });
            i = close + 1; // keys carry no nested constructs
            continue;
          }
        }
        // Optional-arg forms (\cite[p.3]{k}) render as source in v1.
        i = e;
        continue;
      }

      i = e;
      continue;
    }

    // Math-env contents: opaque (no comments, no $-spans re-parsed).
    if (mathEnvDepth > 0) {
      i++;
      continue;
    }

    if (ch === 37 /* % */) {
      // Escaped % was consumed as a pair above, so this one is live.
      let eol = text.indexOf("\n", i);
      if (eol === -1) eol = n;
      nodes.push({ type: "comment", from: abs(i), to: abs(eol) });
      i = eol;
      continue;
    }

    if (ch === 36 /* $ */) {
      const display = text.charCodeAt(i + 1) === 36;
      const opener = display ? 2 : 1;
      const close = findMathClose(text, i + opener, display ? "$$" : "$");
      if (close !== -1) {
        nodes.push({ type: "math", from: abs(i), to: abs(close), display });
        mathSpanUntil = close;
      }
      i += opener;
      continue;
    }

    i++;
  }

  finishLine(n);
  return { nodes, aborted: false };
}

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
