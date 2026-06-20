/**
 * Local Zotero provider — local HTTP on port 23119, no auth, two paths:
 *
 * 1. **Better BibTeX** (Zotero plugin, preferred for the personal library):
 *    GET http://127.0.0.1:23119/better-bibtex/library?/1/library.bib
 *    BBT's value-add is stable, human-readable citation keys.
 *
 * 2. **Zotero's built-in local API** (Zotero 7+, no plugin needed):
 *    GET http://127.0.0.1:23119/api/users/0/items?format=bibtex
 *    Same server, web-API-compatible shape, paginated via Total-Results.
 *    It also enumerates group libraries (`/api/users/0/groups`), so the
 *    provider can discover and export every library the user belongs to
 *    without any manual library-id configuration. Requires "Allow other
 *    applications on this computer to communicate with Zotero" (Settings →
 *    Advanced).
 *
 * The provider auto-discovers libraries: the personal library plus any group
 * libraries. The personal library exports via BBT when available (nicer keys)
 * and falls back to the local API; group libraries always use the local API
 * (their BBT internal ids don't match the public group ids the API reports).
 *
 * Search is done in-process against the cached export, refreshed lazily with a
 * 60-second TTL. Each cached entry is tagged with its source library so the
 * references panel can list and filter by library.
 */

import { httpRequest } from "~/integrations/http";
import type { Citation, CitationProvider, ProviderStatus } from "~/integrations/types";

import { type CitationFields, extractFields, parseBibTex } from "../bibtex";

const BASE = "http://127.0.0.1:23119";
const PROBE_URL = `${BASE}/better-bibtex/`;
const BBT_PERSONAL_URL = `${BASE}/better-bibtex/library?/1/library.bib`;
const GROUPS_URL = `${BASE}/api/users/0/groups?format=json`;
const PERSONAL_ITEMS = `${BASE}/api/users/0/items`;
const GROUP_ITEMS = (id: string) => `${BASE}/api/groups/${id}/items`;
const PERSONAL_LIBRARY_NAME = "My Library";
const CACHE_TTL_MS = 60_000;
const LIST_LIMIT = 200;

interface LibraryRef {
  /** "user" for the personal library, or the numeric group id. */
  id: string;
  name: string;
  kind: "user" | "group";
}

interface TaggedEntry {
  key: string;
  source: string;
  library: string;
  fields: CitationFields;
}

interface Cache {
  fetchedAt: number;
  bibtex: string;
  entries: TaggedEntry[];
}

/** `true` if the Better BibTeX HTTP server is reachable. */
export async function probeBetterBibTex(): Promise<boolean> {
  try {
    const res = await httpRequest({ method: "HEAD", url: PROBE_URL });
    return res.status === 200 || res.status === 404; // 404 is OK — service is up
  } catch {
    return false;
  }
}

/** `true` if plain Zotero 7's built-in local API answers. */
export async function probeZoteroLocalApi(): Promise<boolean> {
  try {
    const res = await httpRequest({
      method: "GET",
      url: `${PERSONAL_ITEMS}?limit=1&format=keys`,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Discover the personal library plus any group libraries via the local API. */
async function discoverLibraries(localApi: boolean): Promise<LibraryRef[]> {
  const libs: LibraryRef[] = [{ id: "user", name: PERSONAL_LIBRARY_NAME, kind: "user" }];
  if (!localApi) return libs;
  try {
    const res = await httpRequest({ method: "GET", url: GROUPS_URL });
    if (res.status >= 200 && res.status < 300) {
      const arr = JSON.parse(res.body) as Array<{
        id?: number | string;
        name?: string;
        data?: { id?: number | string; name?: string };
      }>;
      for (const g of arr) {
        const id = String(g.id ?? g.data?.id ?? "");
        if (!id) continue;
        libs.push({ id, name: g.data?.name ?? g.name ?? `Group ${id}`, kind: "group" });
      }
    }
  } catch {
    // Groups are best-effort; the personal library still works.
  }
  return libs;
}

/** Full-library BibTeX via the built-in local API, draining all pages. */
async function exportViaLocalApi(itemsUrl: string): Promise<string> {
  const limit = 100;
  const pages: string[] = [];
  let start = 0;
  for (;;) {
    const res = await httpRequest({
      method: "GET",
      url: `${itemsUrl}?format=bibtex&limit=${limit}&start=${start}`,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Zotero local API export failed (status ${res.status})`);
    }
    pages.push(res.body);
    const total = Number(
      res.headers["total-results"] ?? res.headers["Total-Results"] ?? 0,
    );
    start += limit;
    if (!total || start >= total) break;
  }
  return pages.join("\n\n");
}

/** Export one library's BibTeX, preferring BBT for the personal library. */
async function exportLibrary(lib: LibraryRef, bbt: boolean): Promise<string> {
  if (lib.kind === "user") {
    if (bbt) {
      try {
        const res = await httpRequest({
          method: "GET",
          url: BBT_PERSONAL_URL,
          headers: { Accept: "application/x-bibtex; charset=utf-8" },
        });
        if (res.status >= 200 && res.status < 300) return res.body;
      } catch {
        // Fall back to the local API below.
      }
    }
    return exportViaLocalApi(PERSONAL_ITEMS);
  }
  return exportViaLocalApi(GROUP_ITEMS(lib.id));
}

export function createBetterBibTexProvider(): CitationProvider {
  let cache: Cache | undefined;

  const refresh = async (): Promise<Cache> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;

    const [bbt, localApi] = await Promise.all([
      probeBetterBibTex(),
      probeZoteroLocalApi(),
    ]);
    if (!bbt && !localApi) {
      throw new Error(
        "Zotero isn't reachable on 127.0.0.1:23119. Start Zotero 7 and enable " +
          "\"Allow other applications on this computer to communicate with Zotero\" " +
          "(Settings → Advanced). The Better BibTeX plugin is optional.",
      );
    }

    const libraries = await discoverLibraries(localApi);
    const blocks: string[] = [];
    const entries: TaggedEntry[] = [];
    for (const lib of libraries) {
      let bibtex: string;
      try {
        bibtex = await exportLibrary(lib, bbt);
      } catch {
        // Skip a single failing library rather than failing the whole refresh.
        continue;
      }
      if (bibtex.trim().length === 0) continue;
      blocks.push(bibtex);
      for (const e of parseBibTex(bibtex)) {
        entries.push({
          key: e.key,
          source: e.source,
          library: lib.name,
          fields: extractFields(e.source),
        });
      }
    }

    cache = { fetchedAt: now, bibtex: blocks.join("\n\n"), entries };
    return cache;
  };

  const toCitation = (e: TaggedEntry): Citation => ({
    key: e.key,
    title: e.fields.title ?? e.key,
    authors: e.fields.authors,
    year: e.fields.year,
    doi: e.fields.doi,
    library: e.library,
  });

  return {
    id: "zotero-better-bibtex",
    category: "references",
    displayName: "Zotero (local)",

    async status(): Promise<ProviderStatus> {
      const [bbt, localApi] = await Promise.all([
        probeBetterBibTex(),
        probeZoteroLocalApi(),
      ]);
      return bbt || localApi ? "ready" : "error";
    },

    async exportAllAsBibTex(): Promise<string> {
      return (await refresh()).bibtex;
    },

    async listLibraries(): Promise<string[]> {
      const [bbt, localApi] = await Promise.all([
        probeBetterBibTex(),
        probeZoteroLocalApi(),
      ]);
      if (!bbt && !localApi) return [];
      return (await discoverLibraries(localApi)).map((l) => l.name);
    },

    async searchLibrary(query: string, library?: string): Promise<Citation[]> {
      const { entries } = await refresh();
      const q = query.trim().toLowerCase();
      const matches = entries.filter((e) => {
        if (library !== undefined && e.library !== library) return false;
        if (!q) return true;
        return [
          e.key,
          e.fields.title ?? "",
          e.fields.authors.join(" "),
          e.fields.year != null ? String(e.fields.year) : "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(q);
      });
      return matches.slice(0, LIST_LIMIT).map(toCitation);
    },

    async fetchEntry(key: string) {
      const { entries } = await refresh();
      const entry = entries.find((e) => e.key === key);
      if (!entry) throw new Error(`Citation key '${key}' not found in the Zotero library`);
      return { key, source: entry.source };
    },
  };
}
