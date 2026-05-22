/**
 * Better BibTeX (Zotero plugin) provider — local HTTP, no auth.
 *
 * Better BibTeX exposes a local HTTP server on port 23119 when Zotero
 * is running with the plugin installed. URL pattern:
 *   GET http://127.0.0.1:23119/better-bibtex/library?/<libraryId>/library.bib
 * returns the library as BibTeX with extension-determined formatting.
 *
 * Phase 1 targets library 1 (the user's personal library). Group library
 * support is a future toggle; surface as a configurable `libraryId` in
 * settings when we add the UI.
 *
 * Search is done in-process against the cached export, refreshed lazily
 * with a 60-second TTL. That's more than fast enough for typical Zotero
 * libraries (a few thousand items at most) and avoids us building a
 * second IPC pathway for the JSON-RPC sub-API.
 */

import { httpRequest } from "~/integrations/http";
import type { Citation, CitationProvider, ProviderStatus } from "~/integrations/types";

import { extractFields, parseBibTex } from "../bibtex";

const PROBE_URL = "http://127.0.0.1:23119/better-bibtex/";
const EXPORT_URL = (libraryId: number) =>
  `http://127.0.0.1:23119/better-bibtex/library?/${libraryId}/library.bib`;
const CACHE_TTL_MS = 60_000;

export interface BetterBibTexConfig {
  /** Zotero library id; `1` is the user's personal library. */
  libraryId: number;
}

interface Cache {
  fetchedAt: number;
  bibtex: string;
}

/**
 * Returns `true` if the Better BibTeX HTTP server is reachable. Used at
 * onboarding to decide whether to surface the provider in settings.
 */
export async function probeBetterBibTex(): Promise<boolean> {
  try {
    const res = await httpRequest({ method: "HEAD", url: PROBE_URL });
    return res.status === 200 || res.status === 404; // 404 is OK — service is up
  } catch {
    return false;
  }
}

export function createBetterBibTexProvider(config: BetterBibTexConfig): CitationProvider {
  let cache: Cache | undefined;

  const refresh = async (): Promise<string> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.bibtex;
    }
    const res = await httpRequest({
      method: "GET",
      url: EXPORT_URL(config.libraryId),
      headers: { Accept: "application/x-bibtex; charset=utf-8" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Better BibTeX export failed (status ${res.status})`);
    }
    cache = { fetchedAt: now, bibtex: res.body };
    return res.body;
  };

  return {
    id: "zotero-better-bibtex",
    category: "references",
    displayName: "Zotero (Better BibTeX)",

    async status(): Promise<ProviderStatus> {
      return (await probeBetterBibTex()) ? "ready" : "error";
    },

    async exportAllAsBibTex(): Promise<string> {
      return refresh();
    },

    async searchLibrary(query: string): Promise<Citation[]> {
      const bibtex = await refresh();
      const entries = parseBibTex(bibtex);
      const q = query.trim().toLowerCase();
      const matches = q
        ? entries.filter((e) => {
            const fields = extractFields(e.source);
            const haystack = [
              e.key,
              fields.title ?? "",
              fields.authors.join(" "),
              fields.year != null ? String(fields.year) : "",
            ]
              .join(" ")
              .toLowerCase();
            return haystack.includes(q);
          })
        : entries;

      return matches.slice(0, 50).map((entry) => {
        const fields = extractFields(entry.source);
        return {
          key: entry.key,
          title: fields.title ?? entry.key,
          authors: fields.authors,
          year: fields.year,
          doi: fields.doi,
        };
      });
    },

    async fetchEntry(key: string) {
      const bibtex = await refresh();
      const entries = parseBibTex(bibtex);
      const entry = entries.find((e) => e.key === key);
      if (!entry) throw new Error(`Citation key '${key}' not found in Better BibTeX library`);
      return { key, source: entry.source };
    },
  };
}
