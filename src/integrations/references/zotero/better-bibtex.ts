/**
 * Local Zotero provider — local HTTP on port 23119, no auth, two paths:
 *
 * 1. **Better BibTeX** (Zotero plugin, preferred when installed):
 *    GET http://127.0.0.1:23119/better-bibtex/library?/<libraryId>/library.bib
 *    BBT's value-add is stable, human-readable citation keys.
 *
 * 2. **Zotero's built-in local API** (Zotero 7+, no plugin needed):
 *    GET http://127.0.0.1:23119/api/users/0/items?format=bibtex
 *    Same server, web-API-compatible shape, paginated via Total-Results.
 *    Citation keys are Zotero's auto-generated ones — less pretty than
 *    BBT's, but everything works. Requires "Allow other applications on
 *    this computer to communicate with Zotero" (Settings → Advanced).
 *
 * The provider prefers BBT and silently falls back, so plain-Zotero users
 * get `\cite{}` completions without installing anything.
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
const LOCAL_API_ITEMS = "http://127.0.0.1:23119/api/users/0/items";
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

/** Returns `true` if plain Zotero 7's built-in local API answers. */
export async function probeZoteroLocalApi(): Promise<boolean> {
  try {
    const res = await httpRequest({
      method: "GET",
      url: `${LOCAL_API_ITEMS}?limit=1&format=keys`,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Full-library BibTeX via the built-in local API, draining all pages. */
async function exportViaLocalApi(): Promise<string> {
  const limit = 100;
  const pages: string[] = [];
  let start = 0;
  for (;;) {
    const res = await httpRequest({
      method: "GET",
      url: `${LOCAL_API_ITEMS}?format=bibtex&limit=${limit}&start=${start}`,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Zotero local API export failed (status ${res.status})`);
    }
    pages.push(res.body);
    const total = Number(
      res.headers["total-results"] ?? res.headers["Total-Results"] ?? 0,
    );
    start += limit;
    // No Total-Results header (older builds) → single page is all we get.
    if (!total || start >= total) break;
  }
  return pages.join("\n\n");
}

export function createBetterBibTexProvider(config: BetterBibTexConfig): CitationProvider {
  let cache: Cache | undefined;

  const refresh = async (): Promise<string> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.bibtex;
    }
    let bibtex: string;
    if (await probeBetterBibTex()) {
      const res = await httpRequest({
        method: "GET",
        url: EXPORT_URL(config.libraryId),
        headers: { Accept: "application/x-bibtex; charset=utf-8" },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Better BibTeX export failed (status ${res.status})`);
      }
      bibtex = res.body;
    } else if (await probeZoteroLocalApi()) {
      bibtex = await exportViaLocalApi();
    } else {
      throw new Error(
        "Zotero isn't reachable on 127.0.0.1:23119. Start Zotero 7 and enable " +
          "\"Allow other applications on this computer to communicate with Zotero\" " +
          "(Settings → Advanced). The Better BibTeX plugin is optional.",
      );
    }
    cache = { fetchedAt: now, bibtex };
    return bibtex;
  };

  return {
    id: "zotero-better-bibtex",
    category: "references",
    displayName: "Zotero (local)",

    async status(): Promise<ProviderStatus> {
      if (await probeBetterBibTex()) return "ready";
      return (await probeZoteroLocalApi()) ? "ready" : "error";
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
      if (!entry) throw new Error(`Citation key '${key}' not found in the Zotero library`);
      return { key, source: entry.source };
    },
  };
}
