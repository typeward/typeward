/**
 * Zotero Web API provider.
 *
 * Setup: user creates a personal API key at zotero.org/settings/keys, then
 * pastes it into Typeward settings together with their numeric user id.
 * The key is stored via the OS keyring under service `zotero-web` and
 * account = user id; the user id itself lives in `settings.json` (not
 * sensitive).
 *
 * Endpoints used:
 *   GET /users/{userId}/items?format=bibtex&limit=100  → full library
 *   GET /users/{userId}/items?q=…&format=json          → search metadata
 *
 * Rate limit: 50 req/sec/IP per Zotero docs — well within our per-call
 * tempo. No batching layer needed.
 */

import { httpRequest } from "~/integrations/http";
import type { Citation, CitationProvider, ProviderStatus } from "~/integrations/types";

import { parseBibTex } from "../bibtex";

const API_ROOT = "https://api.zotero.org";
const KEYRING_SERVICE = "zotero-web";
const PAGE_LIMIT = 100;
const MAX_PAGES = 50; // 5000 entries cap on initial export

export interface ZoteroWebConfig {
  /** Zotero numeric user id (visible in zotero.org/settings/keys). */
  userId: string;
}

interface ZoteroJsonItem {
  key: string;
  data?: {
    title?: string;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
    date?: string;
    DOI?: string;
  };
}

export function createZoteroWebProvider(config: ZoteroWebConfig): CitationProvider {
  const authRef = {
    service: KEYRING_SERVICE,
    account: config.userId,
    header: "Authorization",
    prefix: "Bearer ",
  };
  const label = `Zotero (account ${config.userId})`;

  return {
    id: `zotero-web:${config.userId}`,
    category: "references",
    displayName: label,

    async status(): Promise<ProviderStatus> {
      try {
        const res = await httpRequest({
          method: "GET",
          url: `${API_ROOT}/users/${encodeURIComponent(config.userId)}/items?limit=1&format=keys`,
          authRef,
        });
        return res.status >= 200 && res.status < 300 ? "ready" : "error";
      } catch {
        return "error";
      }
    },

    async exportAllAsBibTex(): Promise<string> {
      const chunks: string[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const start = page * PAGE_LIMIT;
        const res = await httpRequest({
          method: "GET",
          url: `${API_ROOT}/users/${encodeURIComponent(config.userId)}/items?format=bibtex&limit=${PAGE_LIMIT}&start=${start}`,
          authRef,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`Zotero export failed (status ${res.status})`);
        }
        const body = res.body.trim();
        if (!body) break;
        chunks.push(body);
        const totalResults = Number.parseInt(res.headers["total-results"] ?? "0", 10);
        if (Number.isFinite(totalResults) && start + PAGE_LIMIT >= totalResults) break;
      }
      return chunks.join("\n\n");
    },

    async searchLibrary(query: string, library?: string): Promise<Citation[]> {
      // Single-library provider — its whole library is named by displayName.
      if (library !== undefined && library !== label) return [];
      const params = new URLSearchParams({
        format: "json",
        limit: "50",
        qmode: "titleCreatorYear",
      });
      if (query.trim()) params.set("q", query.trim());

      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/users/${encodeURIComponent(config.userId)}/items?${params.toString()}`,
        authRef,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Zotero search failed (status ${res.status})`);
      }
      const items = JSON.parse(res.body) as ZoteroJsonItem[];
      return items.map((it) => ({ ...toCitation(it), library: label }));
    },

    async fetchEntry(key: string) {
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/users/${encodeURIComponent(config.userId)}/items/${encodeURIComponent(key)}?format=bibtex`,
        authRef,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Zotero entry fetch failed (status ${res.status}) for ${key}`);
      }
      const entries = parseBibTex(res.body);
      if (entries.length === 0) {
        throw new Error(`Zotero returned no BibTeX for ${key}`);
      }
      return { key: entries[0].key, source: entries[0].source };
    },
  };
}

function toCitation(item: ZoteroJsonItem): Citation {
  const data = item.data ?? {};
  const authors = (data.creators ?? []).map((c) =>
    c.name ? c.name : [c.lastName, c.firstName].filter(Boolean).join(", "),
  );
  const yearMatch = data.date?.match(/\d{4}/);
  return {
    key: item.key,
    title: data.title ?? item.key,
    authors,
    year: yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined,
    doi: data.DOI,
    providerEntryId: item.key,
  };
}
