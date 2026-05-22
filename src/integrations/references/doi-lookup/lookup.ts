/**
 * DOI / arXiv lookup — no auth, no API key, just HTTP content negotiation.
 *
 * Strategy: route everything through `https://doi.org/<doi>` with
 * `Accept: application/x-bibtex`. The DOI Foundation's content-
 * negotiation server returns publisher-supplied BibTeX directly. arXiv
 * papers since 2022 get an auto-assigned DOI under the `10.48550/`
 * prefix, so we synthesize that and reuse the DOI path.
 *
 * Older arXiv papers without a DOI fall through to the arXiv API as a
 * fallback. CrossRef is reserved for a later pass if doi.org coverage
 * gaps emerge.
 */

import { httpRequest } from "~/integrations/http";

const DOI_URL_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,}\/[^\s]+)$/i;
const ARXIV_URL_RE = /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z]+(?:[.\-][a-z]+)*\/\d{7}(?:v\d+)?)$/i;

export type LookupInputKind = "doi" | "arxiv" | "unknown";

export interface ClassifiedInput {
  kind: LookupInputKind;
  /** The normalized id (DOI string or arXiv id), or the original input when unknown. */
  id: string;
}

export function classifyLookupInput(raw: string): ClassifiedInput {
  const trimmed = raw.trim();
  const doi = trimmed.match(DOI_URL_RE);
  if (doi) return { kind: "doi", id: doi[1] };
  const arxiv = trimmed.match(ARXIV_URL_RE);
  if (arxiv) return { kind: "arxiv", id: arxiv[1] };
  return { kind: "unknown", id: trimmed };
}

export interface LookupResult {
  /** Full BibTeX entry, ready to append to a `.bib` file. */
  bibtex: string;
  /** Parsed citation key for dedup / quick reference. */
  key: string;
}

/**
 * Look up `input` and return a BibTeX entry. Throws on network failure,
 * non-2xx status, or unrecognized input shape.
 */
export async function lookupCitation(input: string): Promise<LookupResult> {
  const classified = classifyLookupInput(input);
  switch (classified.kind) {
    case "doi":
      return lookupViaDoi(classified.id);
    case "arxiv":
      return lookupArxiv(classified.id);
    default:
      throw new Error(
        `Could not parse '${input}' as a DOI or arXiv id. Examples: "10.1145/3290605.3300479", "2403.04132".`,
      );
  }
}

async function lookupViaDoi(doi: string): Promise<LookupResult> {
  const url = `https://doi.org/${encodeURI(doi)}`;
  const res = await httpRequest({
    method: "GET",
    url,
    headers: { Accept: "application/x-bibtex; charset=utf-8" },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DOI lookup failed (status ${res.status}): ${doi}`);
  }
  const bibtex = res.body.trim();
  if (!bibtex.startsWith("@")) {
    throw new Error(
      `DOI lookup returned non-BibTeX content for ${doi} — check that the DOI is registered with the DOI Foundation.`,
    );
  }
  return { bibtex, key: extractKey(bibtex) ?? doi };
}

async function lookupArxiv(arxivId: string): Promise<LookupResult> {
  // arXiv papers since 2022 carry an auto-minted DOI; try the DOI path
  // first (richer metadata via publisher records). Older papers fall
  // through to the arXiv Atom API.
  const syntheticDoi = `10.48550/arXiv.${stripVersion(arxivId)}`;
  try {
    return await lookupViaDoi(syntheticDoi);
  } catch {
    return await lookupArxivAtom(arxivId);
  }
}

async function lookupArxivAtom(arxivId: string): Promise<LookupResult> {
  const url = `http://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`;
  const res = await httpRequest({ method: "GET", url, headers: { Accept: "application/atom+xml" } });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`arXiv lookup failed (status ${res.status}): ${arxivId}`);
  }
  return atomEntryToBibTex(arxivId, res.body);
}

/**
 * Minimal Atom → BibTeX. Pulls title, authors, year from the first <entry>
 * via regex; good enough for a single-paper response from arxiv.org/api/query.
 * Not robust against arbitrary feeds, which is fine — we know the shape.
 */
function atomEntryToBibTex(arxivId: string, atom: string): LookupResult {
  const title = textOf(atom, "title", 2)?.replace(/\s+/g, " ").trim() ?? arxivId;
  const published = textOf(atom, "published")?.slice(0, 4) ?? "";
  const authors: string[] = [];
  const authorRegex = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g;
  for (let m: RegExpExecArray | null; (m = authorRegex.exec(atom)); ) {
    authors.push(m[1].trim());
  }
  const key = `arxiv${stripVersion(arxivId).replace(/[^A-Za-z0-9]/g, "")}`;

  const bibtex = [
    `@misc{${key},`,
    `  title = {${title}},`,
    `  author = {${authors.join(" and ")}},`,
    `  year = {${published}},`,
    `  eprint = {${arxivId}},`,
    `  archivePrefix = {arXiv},`,
    `  url = {https://arxiv.org/abs/${arxivId}},`,
    `}`,
  ].join("\n");

  return { bibtex, key };
}

function textOf(xml: string, tag: string, occurrence = 1): string | undefined {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = regex.exec(xml))) {
    count++;
    if (count === occurrence) return match[1];
  }
  return undefined;
}

function stripVersion(arxivId: string): string {
  return arxivId.replace(/v\d+$/, "");
}

function extractKey(bibtex: string): string | undefined {
  const match = bibtex.match(/^@\w+\{([^,\s]+)/);
  return match?.[1];
}
