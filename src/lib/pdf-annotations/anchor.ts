/**
 * Maps a PDF text selection back to source offsets for anchoring a review/TODO
 * thread created from the PDF. SyncTeX gives us a line (coarse); this narrows to
 * the selected words within a window around that line by fuzzy word-matching
 * against markup-stripped source. Pure + unit-tested. Honest about limits: when
 * no window matches well enough the caller falls back to the whole synctex line.
 */

export interface SourceMatch {
  fromOffset: number;
  toOffset: number;
}

const LIGATURES: [RegExp, string][] = [
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬀ/g, "ff"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
];

export function normalizeWord(w: string): string {
  let s = w.toLowerCase();
  for (const [re, rep] of LIGATURES) s = s.replace(re, rep);
  return s.replace(/[^a-z0-9]/g, "");
}

/** Word tokenizer shared with the PDF-side rect matcher. Fresh instance per
 * call: a /g regex carries lastIndex state across callers. The ﬀ-ﬄ range
 * keeps ligature glyphs (as pdfjs text items render them) inside their word
 * so normalizeWord can expand them. */
export function wordRe(): RegExp {
  return /[A-Za-z0-9'À-ɏﬀ-ﬄ-]+/g;
}

/** Replace LaTeX markup (commands, braces, math toggles, comments) with spaces
 * char-for-char so word offsets into the ORIGINAL string are preserved. */
export function maskMarkup(s: string): string {
  const out = s.split("");
  let i = 0;
  let inComment = false;
  while (i < s.length) {
    const c = s[i];
    if (inComment) {
      if (c === "\n") inComment = false;
      else out[i] = " ";
      i++;
      continue;
    }
    if (c === "%") {
      inComment = true;
      out[i] = " ";
      i++;
      continue;
    }
    if (c === "\\") {
      out[i] = " ";
      i++;
      if (i < s.length && /[A-Za-z]/.test(s[i])) {
        while (i < s.length && /[A-Za-z]/.test(s[i])) {
          out[i] = " ";
          i++;
        }
      } else if (i < s.length) {
        // Symbol command like \% \& \_
        out[i] = " ";
        i++;
      }
      continue;
    }
    if ("{}[]$&#~^_".includes(c)) {
      out[i] = " ";
    }
    i++;
  }
  return out.join("");
}

interface SourceWord {
  norm: string;
  from: number;
  to: number;
}

function sourceWords(source: string, from: number, to: number): SourceWord[] {
  const window = source.slice(from, to);
  const masked = maskMarkup(window);
  const re = wordRe();
  const out: SourceWord[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const norm = normalizeWord(m[0]);
    if (norm) out.push({ norm, from: from + m.index, to: from + m.index + m[0].length });
  }
  return out;
}

function lineOffset(source: string, lineIndex: number): number {
  let offset = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lineIndex && i < lines.length; i++) offset += lines[i].length + 1;
  return offset;
}

const WINDOW_LINES = 5;
const MIN_SCORE = 0.6;

/**
 * @param source     full source text
 * @param synctexLine 1-based line SyncTeX resolved the PDF click to
 * @param selected   the raw selected text from the PDF
 * @returns source offsets spanning the best-matching run of words, or null.
 */
export function matchSelectionToSource(
  source: string,
  synctexLine: number,
  selected: string,
): SourceMatch | null {
  const selWords = selected.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (selWords.length === 0) return null;

  const lineIdx = Math.max(0, synctexLine - 1);
  const startLine = Math.max(0, lineIdx - WINDOW_LINES);
  const endLine = lineIdx + WINDOW_LINES + 1;
  const from = lineOffset(source, startLine);
  const to = Math.min(source.length, lineOffset(source, endLine));

  const words = sourceWords(source, from, to);
  const n = selWords.length;
  if (words.length < n) {
    // Too few source words to fit the selection — try a single-word anchor on
    // the first selected word.
    const single = words.find((w) => w.norm === selWords[0]);
    return single ? { fromOffset: single.from, toOffset: single.to } : null;
  }

  let bestScore = 0;
  let bestIdx = -1;
  for (let i = 0; i + n <= words.length; i++) {
    let matches = 0;
    for (let j = 0; j < n; j++) {
      if (words[i + j].norm === selWords[j]) matches++;
    }
    const score = matches / n;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < MIN_SCORE) return null;
  return { fromOffset: words[bestIdx].from, toOffset: words[bestIdx + n - 1].to };
}
