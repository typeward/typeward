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
 *    It also enumerates group libraries (`/api/users/0/groups`) and each
 *    library's collections (`/collections`), so the provider can discover and
 *    export every library and folder without any manual configuration.
 *    Requires "Allow other applications on this computer to communicate with
 *    Zotero" (Settings → Advanced).
 *
 * The provider auto-discovers libraries (personal + groups) and their
 * collections. The personal library exports via BBT when available (nicer keys)
 * and falls back to the local API; group libraries always use the local API
 * (their BBT internal ids don't match the public group ids). Collection
 * contents follow the same per-library choice so an inserted `\cite{key}`
 * always resolves against the aggregated `library.bib`.
 *
 * Search is done in-process against cached exports, refreshed lazily with a
 * 60-second TTL. Each cached entry is tagged with its library so the references
 * panel can list and filter by library or collection.
 */

import { httpRequest } from "~/integrations/http";
import type {
  Citation,
  CitationProvider,
  LibraryNode,
  ProviderStatus,
} from "~/integrations/types";

import { type CitationFields, extractFields, parseBibTex } from "../bibtex";
import { mapLimit } from "../concurrency";
import {
  type CollectionRef,
  type LibraryRef,
  type RawCollection,
  collNodeId,
  isValidKey,
  libNodeId,
  pruneTrashedCollections,
  resolveNode,
} from "./nodes";

const BASE = "http://127.0.0.1:23119";
const PROBE_URL = `${BASE}/better-bibtex/`;
const BBT_PERSONAL_URL = `${BASE}/better-bibtex/library?/1/library.bib`;
// BBT pull-export for one collection by its Zotero key. `1` is the personal
// library id (matches BBT_PERSONAL_URL); group collections go via the local API
// instead because their keys aren't addressable through this personal-library
// endpoint.
const BBT_COLLECTION_URL = (collKey: string) =>
  `${BASE}/better-bibtex/collection?/1/${encodeURIComponent(collKey)}.bibtex`;
const GROUPS_URL = `${BASE}/api/users/0/groups?format=json`;
const PERSONAL_ITEMS = `${BASE}/api/users/0/items`;
const PERSONAL_LIBRARY_NAME = "My Library";
const CACHE_TTL_MS = 60_000;
const LIST_LIMIT = 200;
const MAX_COLLECTION_PAGES = 25; // 2500 collections cap during discovery

interface TaggedEntry {
  key: string;
  source: string;
  /** Stable library node id — unique even when display names collide. */
  libId: string;
  /** Human-readable library name for display. */
  library: string;
  fields: CitationFields;
}

interface Cache {
  fetchedAt: number;
  bibtex: string;
  entries: TaggedEntry[];
}

interface Libraries {
  libraries: LibraryRef[];
  bbt: boolean;
  localApi: boolean;
}

/** REST base for a library: personal under /users/0, groups under /groups/{id}. */
function apiBase(lib: LibraryRef): string {
  return lib.kind === "user"
    ? `${BASE}/api/users/0`
    : `${BASE}/api/groups/${lib.id}`;
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

/** Discover one library's collections (flat list with parent links). */
async function discoverCollections(lib: LibraryRef): Promise<CollectionRef[]> {
  const base = apiBase(lib);
  const raw: RawCollection[] = [];
  const limit = 100;
  let start = 0;
  for (let page = 0; page < MAX_COLLECTION_PAGES; page++) {
    const res = await httpRequest({
      method: "GET",
      url: `${base}/collections?format=json&limit=${limit}&start=${start}`,
    });
    if (res.status < 200 || res.status >= 300) break;
    const arr = JSON.parse(res.body) as Array<{
      key?: string;
      deleted?: boolean | number;
      data?: {
        key?: string;
        name?: string;
        parentCollection?: string | false;
        deleted?: boolean | number;
      };
    }>;
    for (const c of arr) {
      const key = c.key ?? c.data?.key;
      if (!key || !isValidKey(key)) continue;
      const parentRaw = c.data?.parentCollection;
      const parent =
        typeof parentRaw === "string" && isValidKey(parentRaw) ? parentRaw : null;
      raw.push({
        key,
        name: c.data?.name ?? key,
        parent,
        deleted: Boolean(c.data?.deleted ?? c.deleted),
      });
    }
    const total = Number(
      res.headers["total-results"] ?? res.headers["Total-Results"] ?? 0,
    );
    start += limit;
    if (!total || start >= total || arr.length === 0) break;
  }
  return pruneTrashedCollections(raw);
}

const PAGE = 100;
const PAGE_CONCURRENCY = 5;

/**
 * Full BibTeX via the built-in local API. The first page reveals `Total-Results`;
 * the remaining pages are fetched concurrently (bounded) rather than one IPC
 * round-trip at a time — large libraries were the "loading slow" cost.
 */
async function exportViaLocalApi(itemsUrl: string): Promise<string> {
  const page = async (start: number): Promise<string> => {
    const res = await httpRequest({
      method: "GET",
      url: `${itemsUrl}?format=bibtex&limit=${PAGE}&start=${start}`,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Zotero local API export failed (status ${res.status})`);
    }
    return res.body;
  };
  const first = await httpRequest({
    method: "GET",
    url: `${itemsUrl}?format=bibtex&limit=${PAGE}&start=0`,
  });
  if (first.status < 200 || first.status >= 300) {
    throw new Error(`Zotero local API export failed (status ${first.status})`);
  }
  const total = Number(
    first.headers["total-results"] ?? first.headers["Total-Results"] ?? 0,
  );
  if (!total || total <= PAGE) return first.body;
  const starts: number[] = [];
  for (let s = PAGE; s < total; s += PAGE) starts.push(s);
  const rest = await mapLimit(starts, PAGE_CONCURRENCY, page);
  return [first.body, ...rest].join("\n\n");
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
  return exportViaLocalApi(`${apiBase(lib)}/items`);
}

/**
 * BibTeX for the items in one collection. The personal library prefers BBT
 * (so collection keys match the BBT-keyed `library.bib`); groups and the
 * no-BBT case use the local API. `/items/top` excludes child notes/attachments.
 */
async function exportCollection(
  lib: LibraryRef,
  collKey: string,
  bbt: boolean,
): Promise<string> {
  if (lib.kind === "user" && bbt) {
    try {
      const res = await httpRequest({
        method: "GET",
        url: BBT_COLLECTION_URL(collKey),
        headers: { Accept: "application/x-bibtex; charset=utf-8" },
      });
      if (res.status >= 200 && res.status < 300 && res.body.includes("@")) {
        return res.body;
      }
    } catch {
      // Fall back to the local API below.
    }
  }
  return exportViaLocalApi(
    `${apiBase(lib)}/collections/${encodeURIComponent(collKey)}/items/top`,
  );
}

export function createBetterBibTexProvider(): CitationProvider {
  let cache: Cache | undefined;
  let libCache: (Libraries & { fetchedAt: number }) | undefined;
  let nodeCache: { fetchedAt: number; nodes: LibraryNode[] } | undefined;
  const collCache = new Map<string, { fetchedAt: number; entries: TaggedEntry[] }>();
  // Per-library entry cache keyed by libId, so browsing one library exports
  // only that library instead of the whole catalog (the full `refresh()` export
  // is reserved for `exportAllAsBibTex` → library.bib).
  const libEntriesCache = new Map<string, { fetchedAt: number; entries: TaggedEntry[] }>();

  // Single source of truth for the library set + reachability, shared by the
  // export cache, the node list, and node-id resolution so they never drift to
  // different discovery snapshots. Failures aren't cached (so a transient
  // outage self-heals on the next call).
  const loadLibraries = async (): Promise<Libraries> => {
    const now = Date.now();
    if (libCache && now - libCache.fetchedAt < CACHE_TTL_MS) return libCache;
    const [bbt, localApi] = await Promise.all([
      probeBetterBibTex(),
      probeZoteroLocalApi(),
    ]);
    if (!bbt && !localApi) return { libraries: [], bbt, localApi };
    const libraries = await discoverLibraries(localApi);
    libCache = { fetchedAt: now, libraries, bbt, localApi };
    return libCache;
  };

  const tag = (bibtex: string, lib: LibraryRef): TaggedEntry[] =>
    parseBibTex(bibtex).map((e) => ({
      key: e.key,
      source: e.source,
      libId: libNodeId(lib),
      library: lib.name,
      fields: extractFields(e.source),
    }));

  const refresh = async (): Promise<Cache> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;

    const { libraries, bbt, localApi } = await loadLibraries();
    if (!bbt && !localApi) {
      throw new Error(
        "Zotero isn't reachable on 127.0.0.1:23119. Start Zotero 7 and enable " +
          "\"Allow other applications on this computer to communicate with Zotero\" " +
          "(Settings → Advanced). The Better BibTeX plugin is optional.",
      );
    }

    const blocks: string[] = [];
    const entries: TaggedEntry[] = [];
    let anySuccess = false;
    for (const lib of libraries) {
      let bibtex: string;
      try {
        bibtex = await exportLibrary(lib, bbt);
        anySuccess = true;
      } catch {
        // Skip a single failing library rather than failing the whole refresh.
        continue;
      }
      if (bibtex.trim().length === 0) continue;
      blocks.push(bibtex);
      entries.push(...tag(bibtex, lib));
    }

    // Every export threw (transient outage) — don't cache the empty result, so
    // the next call retries instead of serving blank for the full TTL.
    if (!anySuccess && libraries.length > 0) {
      throw new Error("Zotero export failed for every library.");
    }

    cache = { fetchedAt: now, bibtex: blocks.join("\n\n"), entries };
    return cache;
  };

  const collectionEntries = async (
    nodeId: string,
    lib: LibraryRef,
    collKey: string,
    bbt: boolean,
  ): Promise<TaggedEntry[]> => {
    const now = Date.now();
    const hit = collCache.get(nodeId);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;
    const entries = tag(await exportCollection(lib, collKey, bbt), lib);
    collCache.set(nodeId, { fetchedAt: now, entries });
    return entries;
  };

  const libraryEntries = async (
    lib: LibraryRef,
    bbt: boolean,
  ): Promise<TaggedEntry[]> => {
    const libId = libNodeId(lib);
    const now = Date.now();
    const hit = libEntriesCache.get(libId);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;
    const entries = tag(await exportLibrary(lib, bbt), lib);
    libEntriesCache.set(libId, { fetchedAt: now, entries });
    return entries;
  };

  const matchesQuery = (e: TaggedEntry, q: string): boolean => {
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
      const { bbt, localApi } = await loadLibraries();
      return bbt || localApi ? "ready" : "error";
    },

    invalidate(): void {
      cache = undefined;
      libCache = undefined;
      nodeCache = undefined;
      collCache.clear();
      libEntriesCache.clear();
    },

    async exportAllAsBibTex(): Promise<string> {
      return (await refresh()).bibtex;
    },

    async listLibraryNodes(): Promise<LibraryNode[]> {
      const now = Date.now();
      if (nodeCache && now - nodeCache.fetchedAt < CACHE_TTL_MS) return nodeCache.nodes;
      const { libraries, bbt, localApi } = await loadLibraries();
      if (!bbt && !localApi) return [];
      const nodes: LibraryNode[] = libraries.map((lib) => ({
        id: libNodeId(lib),
        name: lib.name,
        kind: "library",
      }));
      nodeCache = { fetchedAt: now, nodes };
      return nodes;
    },

    async listCollections(libraryNodeId: string): Promise<LibraryNode[]> {
      // Not cached — the folder tree must mirror Zotero on every open/refresh
      // (deleted folders shouldn't linger). Discovery is one cheap request; the
      // heavy citation exports stay cached.
      const { libraries } = await loadLibraries();
      const node = resolveNode(libraryNodeId, libraries);
      if (!node || node.kind !== "library") return [];
      let colls: CollectionRef[] = [];
      try {
        colls = await discoverCollections(node.lib);
      } catch {
        // A library that won't enumerate collections simply has none here.
      }
      return colls.map((c) => ({
        id: collNodeId(node.lib, c.key),
        name: c.name,
        parentId: c.parent ? collNodeId(node.lib, c.parent) : undefined,
        kind: "collection",
      }));
    },

    async searchLibrary(query: string, library?: string): Promise<Citation[]> {
      const q = query.trim().toLowerCase();

      let pool: TaggedEntry[];
      if (library === undefined) {
        pool = (await refresh()).entries;
      } else {
        const { libraries, bbt } = await loadLibraries();
        const node = resolveNode(library, libraries);
        if (!node) return []; // Not one of this provider's nodes.
        if (node.kind === "collection") {
          pool = await collectionEntries(library, node.lib, node.collKey, bbt);
        } else {
          pool = await libraryEntries(node.lib, bbt);
        }
      }

      return pool
        .filter((e) => matchesQuery(e, q))
        .slice(0, LIST_LIMIT)
        .map(toCitation);
    },

    async fetchEntry(key: string) {
      const { entries } = await refresh();
      const entry = entries.find((e) => e.key === key);
      if (!entry) throw new Error(`Citation key '${key}' not found in the Zotero library`);
      return { key, source: entry.source };
    },
  };
}
