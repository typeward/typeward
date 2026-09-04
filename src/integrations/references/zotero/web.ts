/**
 * Zotero Web API provider.
 *
 * Setup: user creates a personal API key at zotero.org/settings/keys, then
 * pastes it into Typeward settings together with their numeric user id.
 * The key is stored via the OS keyring under service `zotero-web` and
 * account = user id; the user id itself lives in `settings.json` (not
 * sensitive).
 *
 * Like the local provider, this auto-discovers the personal library plus any
 * group libraries the key can read, and each library's collections (folders),
 * surfacing them as a tree the references panel can browse. Search filters an
 * in-process cache of the exported BibTeX so the keys shown in the picker are
 * the same citation keys that land in the aggregated `library.bib`.
 *
 * Rate limit: 50 req/sec/IP per Zotero docs — well within our per-call tempo.
 *
 * Node ids are namespaced (`zw:`) so they never collide with the local Zotero
 * provider's bare ids when both are configured at once.
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

const API_ROOT = "https://api.zotero.org";
const KEYRING_SERVICE = "zotero-web";
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // 5000 entries cap per library
const MAX_COLLECTION_PAGES = 25;
const CACHE_TTL_MS = 60_000;
const LIST_LIMIT = 200;
const PERSONAL_LIBRARY_NAME = "My Library";
const NS = "zw:"; // node-id namespace for this provider

export interface ZoteroWebConfig {
  /** Zotero numeric user id (visible in zotero.org/settings/keys). */
  userId: string;
}

interface TaggedEntry {
  key: string;
  source: string;
  libId: string;
  library: string;
  fields: CitationFields;
}

export function createZoteroWebProvider(config: ZoteroWebConfig): CitationProvider {
  const authRef = {
    service: KEYRING_SERVICE,
    account: config.userId,
    header: "Authorization",
    prefix: "Bearer ",
  };
  const label = `Zotero (account ${config.userId})`;
  const uid = encodeURIComponent(config.userId);

  let cache: { fetchedAt: number; bibtex: string; entries: TaggedEntry[] } | undefined;
  let libCache: { fetchedAt: number; libraries: LibraryRef[] } | undefined;
  let nodeCache: { fetchedAt: number; nodes: LibraryNode[] } | undefined;
  const collCache = new Map<string, { fetchedAt: number; entries: TaggedEntry[] }>();
  // Per-library cache so browsing one library doesn't export the whole catalog
  // (the full `refresh()` export stays for `exportAllAsBibTex` → library.bib).
  const libEntriesCache = new Map<string, { fetchedAt: number; entries: TaggedEntry[] }>();

  const apiBase = (lib: LibraryRef): string =>
    lib.kind === "user" ? `${API_ROOT}/users/${uid}` : `${API_ROOT}/groups/${lib.id}`;

  const loadLibraries = async (): Promise<LibraryRef[]> => {
    const now = Date.now();
    if (libCache && now - libCache.fetchedAt < CACHE_TTL_MS) return libCache.libraries;
    const libraries: LibraryRef[] = [
      { id: "user", name: PERSONAL_LIBRARY_NAME, kind: "user" },
    ];
    try {
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/users/${uid}/groups?format=json`,
        authRef,
      });
      if (res.status >= 200 && res.status < 300) {
        const arr = JSON.parse(res.body) as Array<{
          id?: number | string;
          data?: { id?: number | string; name?: string };
        }>;
        for (const g of arr) {
          const id = String(g.id ?? g.data?.id ?? "");
          if (!id) continue;
          libraries.push({ id, name: g.data?.name ?? `Group ${id}`, kind: "group" });
        }
      }
    } catch {
      // Groups are best-effort; the personal library still works.
    }
    libCache = { fetchedAt: now, libraries };
    return libraries;
  };

  const discoverCollections = async (lib: LibraryRef): Promise<CollectionRef[]> => {
    const base = apiBase(lib);
    const raw: RawCollection[] = [];
    let start = 0;
    for (let page = 0; page < MAX_COLLECTION_PAGES; page++) {
      const res = await httpRequest({
        method: "GET",
        url: `${base}/collections?format=json&limit=100&start=${start}`,
        authRef,
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
      const total = Number(res.headers["total-results"] ?? "0");
      start += 100;
      if (!total || start >= total || arr.length === 0) break;
    }
    return pruneTrashedCollections(raw);
  };

  // BibTeX for an items endpoint. The first page reveals Total-Results; the
  // rest are fetched concurrently (bounded) instead of one round-trip at a
  // time. (limit/start span the FULL item set incl. attachments/notes, so a
  // window of only child items yields a blank `format=bibtex` page even though
  // real entries follow — we drain by count, never by empty body.)
  const exportItems = async (itemsUrl: string): Promise<string> => {
    const page = async (start: number) =>
      httpRequest({
        method: "GET",
        url: `${itemsUrl}?format=bibtex&limit=${PAGE_LIMIT}&start=${start}`,
        authRef,
      }).then((res) => {
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`Zotero export failed (status ${res.status})`);
        }
        return res;
      });
    const first = await page(0);
    const total = Number(first.headers["total-results"] ?? "0");
    if (!total || total <= PAGE_LIMIT) return first.body;
    const starts: number[] = [];
    for (let s = PAGE_LIMIT; s < total && s < PAGE_LIMIT * MAX_PAGES; s += PAGE_LIMIT) {
      starts.push(s);
    }
    const rest = await mapLimit(starts, 5, (s) => page(s).then((r) => r.body));
    return [first.body, ...rest].join("\n\n");
  };

  const tag = (bibtex: string, lib: LibraryRef): TaggedEntry[] =>
    parseBibTex(bibtex).map((e) => ({
      key: e.key,
      source: e.source,
      libId: libNodeId(lib),
      library: lib.name,
      fields: extractFields(e.source),
    }));

  const refresh = async () => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
    const libraries = await loadLibraries();
    const blocks: string[] = [];
    const entries: TaggedEntry[] = [];
    let anySuccess = false;
    for (const lib of libraries) {
      let bibtex: string;
      try {
        bibtex = await exportItems(`${apiBase(lib)}/items`);
        anySuccess = true;
      } catch {
        continue; // Skip a single failing library.
      }
      if (bibtex.trim().length === 0) continue;
      blocks.push(bibtex);
      entries.push(...tag(bibtex, lib));
    }
    // Every export threw (bad key / outage) — don't cache the empty result.
    if (!anySuccess && libraries.length > 0) {
      throw new Error("Zotero Web API export failed for every library.");
    }
    cache = { fetchedAt: now, bibtex: blocks.join("\n\n"), entries };
    return cache;
  };

  const collectionEntries = async (
    nodeId: string,
    lib: LibraryRef,
    collKey: string,
  ): Promise<TaggedEntry[]> => {
    const now = Date.now();
    const hit = collCache.get(nodeId);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;
    const bibtex = await exportItems(
      `${apiBase(lib)}/collections/${encodeURIComponent(collKey)}/items/top`,
    );
    const entries = tag(bibtex, lib);
    collCache.set(nodeId, { fetchedAt: now, entries });
    return entries;
  };

  const libraryEntries = async (lib: LibraryRef): Promise<TaggedEntry[]> => {
    const libId = libNodeId(lib);
    const now = Date.now();
    const hit = libEntriesCache.get(libId);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;
    const entries = tag(await exportItems(`${apiBase(lib)}/items`), lib);
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
    id: `zotero-web:${config.userId}`,
    category: "references",
    displayName: label,

    async status(): Promise<ProviderStatus> {
      try {
        const res = await httpRequest({
          method: "GET",
          url: `${API_ROOT}/users/${uid}/items?limit=1&format=keys`,
          authRef,
        });
        return res.status >= 200 && res.status < 300 ? "ready" : "error";
      } catch {
        return "error";
      }
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
      const libraries = await loadLibraries();
      const nodes: LibraryNode[] = libraries.map((lib) => ({
        id: NS + libNodeId(lib),
        name: lib.name,
        kind: "library",
      }));
      nodeCache = { fetchedAt: now, nodes };
      return nodes;
    },

    async listCollections(libraryNodeId: string): Promise<LibraryNode[]> {
      if (!libraryNodeId.startsWith(NS)) return [];
      // Not cached — the folder tree must mirror Zotero on every open/refresh.
      const node = resolveNode(libraryNodeId.slice(NS.length), await loadLibraries());
      if (!node || node.kind !== "library") return [];
      let colls: CollectionRef[] = [];
      try {
        colls = await discoverCollections(node.lib);
      } catch {
        // No enumerable collections for this library.
      }
      return colls.map((c) => ({
        id: NS + collNodeId(node.lib, c.key),
        name: c.name,
        parentId: c.parent ? NS + collNodeId(node.lib, c.parent) : undefined,
        kind: "collection",
      }));
    },

    async searchLibrary(query: string, library?: string): Promise<Citation[]> {
      const q = query.trim().toLowerCase();

      let pool: TaggedEntry[];
      if (library === undefined) {
        pool = (await refresh()).entries;
      } else {
        if (!library.startsWith(NS)) return []; // Not one of this provider's nodes.
        const node = resolveNode(library.slice(NS.length), await loadLibraries());
        if (!node) return [];
        if (node.kind === "collection") {
          pool = await collectionEntries(library, node.lib, node.collKey);
        } else {
          pool = await libraryEntries(node.lib);
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
