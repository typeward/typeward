/**
 * Minimal BibTeX scanner. Just enough to find entry boundaries and keys
 * for deduplication and listing.
 *
 * NOT a full parser — we don't need value extraction here. The compile
 * pipeline (texlab / the compile engine) parses the canonical .bib that we emit; the
 * frontend only needs to know what keys exist and where each entry's
 * `@type{key, ...}` block starts and ends.
 */

export interface ParsedEntry {
  /** e.g. "article", "book", "misc". Lowercase. */
  type: string;
  /** Citation key. */
  key: string;
  /** Full source slice including the leading `@type{...}` and trailing `}`. */
  source: string;
}

/**
 * Split a BibTeX file into top-level entries by scanning for `@` followed
 * by an identifier and balanced braces. Comments (`%`) outside entries
 * are skipped. Malformed entries are silently dropped — partial results
 * are better than throwing on a single bad entry.
 */
export function parseBibTex(input: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] !== "@") {
      i = advanceToNext(input, i);
      continue;
    }

    const start = i;
    i++; // consume `@`

    const typeMatch = readIdent(input, i);
    if (!typeMatch) {
      i = advanceToNext(input, i);
      continue;
    }
    const type = typeMatch.value.toLowerCase();
    i = typeMatch.end;

    // Skip @string, @preamble, @comment — they don't have citation keys.
    if (type === "string" || type === "preamble" || type === "comment") {
      i = skipBalancedBraces(input, i);
      continue;
    }

    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] !== "{") {
      i = advanceToNext(input, i);
      continue;
    }
    i++; // consume `{`

    while (i < input.length && /\s/.test(input[i])) i++;
    const keyMatch = readKey(input, i);
    if (!keyMatch) {
      i = advanceToNext(input, i);
      continue;
    }
    i = keyMatch.end;
    const key = keyMatch.value;

    const blockEnd = skipBalancedBracesFromInside(input, i);
    out.push({ type, key, source: input.slice(start, blockEnd) });
    i = blockEnd;
  }

  return out;
}

interface Scan {
  value: string;
  end: number;
}

function readIdent(s: string, start: number): Scan | null {
  let i = start;
  while (i < s.length && /[A-Za-z]/.test(s[i])) i++;
  if (i === start) return null;
  return { value: s.slice(start, i), end: i };
}

function readKey(s: string, start: number): Scan | null {
  let i = start;
  while (i < s.length && s[i] !== "," && s[i] !== "}" && !/\s/.test(s[i])) i++;
  if (i === start) return null;
  return { value: s.slice(start, i), end: i };
}

function advanceToNext(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length && s[i] !== "@") i++;
  return i;
}

function skipBalancedBraces(s: string, start: number): number {
  let i = start;
  while (i < s.length && s[i] !== "{") i++;
  if (i >= s.length) return s.length;
  return skipBalancedBracesFromInside(s, i + 1);
}

function skipBalancedBracesFromInside(s: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

export interface DedupResult {
  /** Concatenated BibTeX with one entry per key. */
  bibtex: string;
  /** Keys that appeared more than once; later occurrences were dropped. */
  duplicates: string[];
}

/**
 * Concat entries from multiple sources, keeping the first occurrence of
 * each citation key. Comment header records the per-source key counts so
 * a human reading the file can see where entries came from.
 */
export function dedupeBibTex(
  sources: Array<{ providerId: string; bibtex: string }>,
): DedupResult {
  const seen = new Map<string, string>();
  const dups: string[] = [];
  const perProvider: Record<string, number> = {};

  for (const src of sources) {
    const parsed = parseBibTex(src.bibtex);
    perProvider[src.providerId] = parsed.length;
    for (const entry of parsed) {
      if (seen.has(entry.key)) {
        dups.push(entry.key);
        continue;
      }
      seen.set(entry.key, entry.source);
    }
  }

  const header = buildHeader(perProvider, dups.length);
  const body = Array.from(seen.values()).join("\n\n");
  return {
    bibtex: header + body + (body ? "\n" : ""),
    duplicates: dups,
  };
}

/**
 * Pull display-ready fields (title, authors, year) out of a single
 * BibTeX entry source. Intentionally tolerant — unrecognized syntax just
 * yields missing fields, never throws. The aggregator's `library.bib` is
 * authoritative for compile; this extractor only feeds picker UIs.
 */
export interface CitationFields {
  title?: string;
  authors: string[];
  year?: number;
  doi?: string;
}

export function extractFields(entrySource: string): CitationFields {
  const title = unwrap(grab(entrySource, "title"));
  const authorRaw = unwrap(grab(entrySource, "author"));
  const year = parseYear(unwrap(grab(entrySource, "year")));
  const doi = unwrap(grab(entrySource, "doi"));
  const authors = authorRaw
    ? authorRaw
        .split(/\s+and\s+/i)
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  return { title, authors, year, doi };
}

function grab(entry: string, field: string): string | undefined {
  const re = new RegExp(`\\b${field}\\s*=\\s*`, "i");
  const match = entry.match(re);
  if (!match || match.index === undefined) return undefined;
  let i = match.index + match[0].length;
  if (i >= entry.length) return undefined;

  const ch = entry[i];
  if (ch === "{") return readBraced(entry, i + 1);
  if (ch === '"') return readQuoted(entry, i + 1);
  // Bare value — keep until next comma at top-level brace depth 0.
  return readBare(entry, i);
}

function readBraced(s: string, start: number): string {
  let depth = 1;
  let i = start;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth > 0) i++;
  }
  return s.slice(start, i);
}

function readQuoted(s: string, start: number): string {
  let i = start;
  while (i < s.length && s[i] !== '"') i++;
  return s.slice(start, i);
}

function readBare(s: string, start: number): string {
  let i = start;
  while (i < s.length && s[i] !== "," && s[i] !== "}" && s[i] !== "\n") i++;
  return s.slice(start, i).trim();
}

function unwrap(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Strip outer braces / quotes and collapse whitespace, but only the
  // outermost — nested braces are kept for citation conventions like
  // `{Smith}` to preserve capitalization.
  let out = raw.replace(/\s+/g, " ").trim();
  while (out.startsWith("{") && out.endsWith("}")) {
    out = out.slice(1, -1).trim();
  }
  return out.length ? out : undefined;
}

function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/\d{4}/);
  return m ? Number.parseInt(m[0], 10) : undefined;
}

function buildHeader(counts: Record<string, number>, dupCount: number): string {
  const lines = [
    "% Auto-generated by Typeward. Do not edit by hand — edits will be",
    "% overwritten on the next library refresh.",
    "%",
    "% Source providers:",
  ];
  for (const [provider, count] of Object.entries(counts)) {
    lines.push(`%   - ${provider}: ${count} entries`);
  }
  if (dupCount > 0) {
    lines.push(`% Skipped ${dupCount} duplicate key${dupCount === 1 ? "" : "s"}.`);
  }
  lines.push("", "");
  return lines.join("\n");
}
