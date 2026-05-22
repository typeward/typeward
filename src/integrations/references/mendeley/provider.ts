/**
 * Mendeley REST API provider.
 *
 * Backed by the `auth.ts` token vault — every call fetches a fresh
 * (refreshed if needed) access token and includes it as the Authorization
 * bearer. We deliberately don't use the `authRef` keyring shortcut here
 * because Mendeley's tokens are JSON-bundled in one keyring slot
 * (access + refresh + expiry) — the provider needs to unpack and refresh
 * proactively before hitting the API.
 */

import { httpRequest } from "~/integrations/http";
import type { Citation, CitationProvider, ProviderStatus } from "~/integrations/types";

import { parseBibTex } from "../bibtex";
import { getAccessToken, type MendeleyAccount } from "./auth";

const API_ROOT = "https://api.mendeley.com";
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

interface MendeleyDocument {
  id: string;
  title?: string;
  authors?: Array<{ first_name?: string; last_name?: string }>;
  year?: number;
  identifiers?: { doi?: string };
}

export function createMendeleyProvider(account: MendeleyAccount): CitationProvider {
  const auth = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await getAccessToken(account.profileId)}`,
  });

  return {
    id: `mendeley:${account.profileId}`,
    category: "references",
    displayName: `Mendeley (${account.displayName})`,

    async status(): Promise<ProviderStatus> {
      try {
        await getAccessToken(account.profileId);
        return "ready";
      } catch {
        return "unconfigured";
      }
    },

    async exportAllAsBibTex(): Promise<string> {
      const headers = {
        ...(await auth()),
        Accept: "application/x-bibtex",
      };
      const chunks: string[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * PAGE_LIMIT;
        const res = await httpRequest({
          method: "GET",
          url: `${API_ROOT}/documents?view=bib&limit=${PAGE_LIMIT}&offset=${offset}`,
          headers,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`Mendeley export failed (status ${res.status})`);
        }
        const body = res.body.trim();
        if (!body) break;
        chunks.push(body);
        // Mendeley returns Link header with `rel="next"` while there's more.
        if (!/rel="next"/.test(res.headers.link ?? "")) break;
      }
      return chunks.join("\n\n");
    },

    async searchLibrary(query: string): Promise<Citation[]> {
      const params = new URLSearchParams({ limit: "50" });
      if (query.trim()) params.set("query", query.trim());

      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/documents?${params.toString()}`,
        headers: {
          ...(await auth()),
          Accept: "application/vnd.mendeley-document.1+json",
        },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Mendeley search failed (status ${res.status})`);
      }
      const docs = JSON.parse(res.body) as MendeleyDocument[];
      return docs.map(toCitation);
    },

    async fetchEntry(key: string) {
      // Mendeley document ids aren't BibTeX keys; the BibTeX export uses
      // synthesized author/year keys. Fetch a single-document bibtex via
      // ?id=<docId>&view=bib so we can map back when the picker passes a
      // Mendeley id. For arbitrary citation keys we fall back to scanning
      // the full export — slow but correct.
      const single = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/documents?id=${encodeURIComponent(key)}&view=bib&limit=1`,
        headers: {
          ...(await auth()),
          Accept: "application/x-bibtex",
        },
      });
      if (single.status >= 200 && single.status < 300 && single.body.includes("@")) {
        const entries = parseBibTex(single.body);
        if (entries[0]) return { key: entries[0].key, source: entries[0].source };
      }

      // Fallback — scan a fresh export.
      const all = parseBibTex(await this.exportAllAsBibTex());
      const entry = all.find((e) => e.key === key);
      if (!entry) throw new Error(`Citation key '${key}' not found in Mendeley library`);
      return { key, source: entry.source };
    },
  };
}

function toCitation(doc: MendeleyDocument): Citation {
  const authors = (doc.authors ?? []).map((a) =>
    [a.last_name, a.first_name].filter(Boolean).join(", "),
  );
  return {
    key: doc.id,
    title: doc.title ?? doc.id,
    authors,
    year: doc.year,
    doi: doc.identifiers?.doi,
    providerEntryId: doc.id,
  };
}
