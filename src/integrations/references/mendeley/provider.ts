/**
 * Mendeley REST API provider.
 *
 * Backed by the `auth.ts` token vault — every call fetches a fresh
 * (refreshed if needed) access token and includes it as the Authorization
 * bearer. We deliberately don't use the `authRef` keyring shortcut here
 * because Mendeley's tokens are JSON-bundled in one keyring slot
 * (access + refresh + expiry) — the provider needs to unpack and refresh
 * proactively before hitting the API.
 *
 * Browsing mirrors the Zotero providers: the personal library plus its
 * **folders** (Mendeley's collections, nested via `parent_id`) are surfaced as
 * a node tree, and search filters an in-process cache of the exported BibTeX so
 * the keys shown are the same citation keys that land in `library.bib`. (The
 * older JSON-search path returned Mendeley document ids, which never matched
 * the BibTeX keys — an inserted `\cite{}` wouldn't resolve.)
 *
 * Mendeley API specifics that bit us before:
 *   - Pagination is opaque **marker/cursor** based: follow the `Link: rel="next"`
 *     URL verbatim — there is NO `offset`/`start` param (`limit` max 500).
 *   - `/documents` has no `folder_id` filter. A folder's contents come from
 *     `GET /folders/{id}/documents`, which returns only document *ids* (no
 *     BibTeX), so per-folder BibTeX means fetching each doc's `?view=bib`.
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
  collNodeId,
  isValidKey,
  libNodeId,
  resolveNode,
} from "../zotero/nodes";
import { getAccessToken, type MendeleyAccount } from "./auth";

const API_ROOT = "https://api.mendeley.com";
const PAGE_LIMIT = 500; // Mendeley's documented max
const MAX_PAGES = 50;
const MAX_FOLDER_DOCS = 500; // cap per-folder per-document BibTeX fetches
const DOC_FETCH_CONCURRENCY = 6;
const CACHE_TTL_MS = 60_000;
const LIST_LIMIT = 200;
const PERSONAL_LIBRARY_NAME = "My Library";

interface TaggedEntry {
  key: string;
  source: string;
  fields: CitationFields;
}

/**
 * Extract the `rel="next"` URL from a `Link` header. Mendeley returns opaque
 * cursor URLs the client must follow verbatim, so we never construct page URLs.
 */
export function parseNextLink(linkHeader: string | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) return m[1];
  }
  return null;
}

export function createMendeleyProvider(account: MendeleyAccount): CitationProvider {
  const label = `Mendeley (${account.displayName})`;
  // Mendeley exposes a single personal library; folders nest within it.
  const userLib: LibraryRef = { id: "user", name: PERSONAL_LIBRARY_NAME, kind: "user" };

  let cache: { fetchedAt: number; bibtex: string; entries: TaggedEntry[] } | undefined;
  let nodeCache: { fetchedAt: number; nodes: LibraryNode[] } | undefined;
  const folderCache = new Map<string, { fetchedAt: number; entries: TaggedEntry[] }>();

  const auth = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await getAccessToken(account.profileId)}`,
  });

  const tag = (bibtex: string): TaggedEntry[] =>
    parseBibTex(bibtex).map((e) => ({
      key: e.key,
      source: e.source,
      fields: extractFields(e.source),
    }));

  /** Full-library BibTeX, following Mendeley's `Link: rel="next"` cursor. */
  const exportLibraryBibtex = async (): Promise<string> => {
    const headers = { ...(await auth()), Accept: "application/x-bibtex" };
    const chunks: string[] = [];
    let url: string | null = `${API_ROOT}/documents?view=bib&limit=${PAGE_LIMIT}`;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await httpRequest({ method: "GET", url, headers });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Mendeley export failed (status ${res.status})`);
      }
      chunks.push(res.body);
      url = parseNextLink(res.headers.link);
    }
    return chunks.join("\n\n");
  };

  const discoverFolders = async (): Promise<CollectionRef[]> => {
    const headers = {
      ...(await auth()),
      Accept: "application/vnd.mendeley-folder.1+json",
    };
    const out: CollectionRef[] = [];
    let url: string | null = `${API_ROOT}/folders?limit=${PAGE_LIMIT}`;
    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await httpRequest({ method: "GET", url, headers });
      if (res.status < 200 || res.status >= 300) break;
      const arr = JSON.parse(res.body) as Array<{
        id?: string;
        name?: string;
        parent_id?: string;
      }>;
      for (const f of arr) {
        if (!f.id || !isValidKey(f.id)) continue;
        const parent = f.parent_id && isValidKey(f.parent_id) ? f.parent_id : null;
        out.push({ key: f.id, name: f.name ?? f.id, parent });
      }
      url = parseNextLink(res.headers.link);
    }
    return out;
  };

  /** Document ids in a folder (`/folders/{id}/documents` returns ids only). */
  const folderDocumentIds = async (folderId: string): Promise<string[]> => {
    const headers = {
      ...(await auth()),
      Accept: "application/vnd.mendeley-document.1+json",
    };
    const ids: string[] = [];
    let url: string | null = `${API_ROOT}/folders/${encodeURIComponent(
      folderId,
    )}/documents?limit=${PAGE_LIMIT}`;
    for (let page = 0; page < MAX_PAGES && url && ids.length < MAX_FOLDER_DOCS; page++) {
      const res = await httpRequest({ method: "GET", url, headers });
      if (res.status < 200 || res.status >= 300) break;
      const arr = JSON.parse(res.body) as Array<{ id?: string }>;
      for (const d of arr) if (d.id && isValidKey(d.id)) ids.push(d.id);
      url = parseNextLink(res.headers.link);
    }
    return ids;
  };

  const fetchDocBibtex = async (
    id: string,
    headers: Record<string, string>,
  ): Promise<string> => {
    const res = await httpRequest({
      method: "GET",
      url: `${API_ROOT}/documents/${encodeURIComponent(id)}?view=bib`,
      headers,
    });
    return res.status >= 200 && res.status < 300 ? res.body : "";
  };

  const loadAll = async () => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
    const bibtex = await exportLibraryBibtex();
    cache = { fetchedAt: now, bibtex, entries: tag(bibtex) };
    return cache;
  };

  const folderEntries = async (folderId: string): Promise<TaggedEntry[]> => {
    const now = Date.now();
    const hit = folderCache.get(folderId);
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) return hit.entries;
    // Mendeley has no folder→BibTeX call, so resolve the folder's doc ids and
    // pull each document's BibTeX (bounded concurrency + cap).
    const ids = (await folderDocumentIds(folderId)).slice(0, MAX_FOLDER_DOCS);
    // Resolve the bearer once and reuse it across the n per-document fetches.
    const headers = { ...(await auth()), Accept: "application/x-bibtex" };
    const bibs = await mapLimit(ids, DOC_FETCH_CONCURRENCY, (id) =>
      fetchDocBibtex(id, headers),
    );
    const entries = bibs.flatMap((b) => tag(b));
    folderCache.set(folderId, { fetchedAt: now, entries });
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
    library: PERSONAL_LIBRARY_NAME,
  });

  return {
    id: `mendeley:${account.profileId}`,
    category: "references",
    displayName: label,

    async status(): Promise<ProviderStatus> {
      try {
        await getAccessToken(account.profileId);
        return "ready";
      } catch {
        return "unconfigured";
      }
    },

    invalidate(): void {
      cache = undefined;
      nodeCache = undefined;
      folderCache.clear();
    },

    async exportAllAsBibTex(): Promise<string> {
      return (await loadAll()).bibtex;
    },

    async listLibraryNodes(): Promise<LibraryNode[]> {
      const now = Date.now();
      if (nodeCache && now - nodeCache.fetchedAt < CACHE_TTL_MS) return nodeCache.nodes;
      const nodes: LibraryNode[] = [
        { id: libNodeId(userLib), name: userLib.name, kind: "library" },
      ];
      nodeCache = { fetchedAt: now, nodes };
      return nodes;
    },

    async listCollections(libraryNodeId: string): Promise<LibraryNode[]> {
      // Mendeley has a single library; folders all live under it. Not cached —
      // the folder tree must mirror Mendeley on every open/refresh.
      if (resolveNode(libraryNodeId, [userLib])?.kind !== "library") return [];
      let folders: CollectionRef[] = [];
      try {
        folders = await discoverFolders();
      } catch {
        // Folders are best-effort.
      }
      return folders.map((f) => ({
        id: collNodeId(userLib, f.key),
        name: f.name,
        parentId: f.parent ? collNodeId(userLib, f.parent) : undefined,
        kind: "collection",
      }));
    },

    async searchLibrary(query: string, library?: string): Promise<Citation[]> {
      const q = query.trim().toLowerCase();
      let pool: TaggedEntry[];
      if (library === undefined) {
        pool = (await loadAll()).entries;
      } else {
        const node = resolveNode(library, [userLib]);
        if (!node) return []; // Not one of this provider's nodes.
        pool =
          node.kind === "collection"
            ? await folderEntries(node.collKey)
            : (await loadAll()).entries;
      }
      return pool
        .filter((e) => matchesQuery(e, q))
        .slice(0, LIST_LIMIT)
        .map(toCitation);
    },

    async fetchEntry(key: string) {
      const { entries } = await loadAll();
      const entry = entries.find((e) => e.key === key);
      if (!entry) throw new Error(`Citation key '${key}' not found in Mendeley library`);
      return { key, source: entry.source };
    },
  };
}
