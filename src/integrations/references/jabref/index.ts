/**
 * JabRef provider — file-based, no auth.
 *
 * Many academics manage references entirely as `.bib` files curated in
 * JabRef. We support that workflow by reading one or more `.bib` files
 * from the user's filesystem. No JabRef-specific protocol — JabRef just
 * happens to be the most common authoring tool for these files.
 *
 * Paths live in `IntegrationsSettings.references` (Phase 7 will let users
 * pick them via the dialog plugin). File reads go through the Tauri fs
 * plugin, which honors the existing `fs:allow-read-text-file` scope for
 * `$HOME/**`, `$DOCUMENT/**`, `$DESKTOP/**`.
 */

import { readTextFile } from "@tauri-apps/plugin-fs";

import type { Citation, CitationProvider, ProviderStatus } from "~/integrations/types";

import { extractFields, parseBibTex } from "../bibtex";

const CACHE_TTL_MS = 60_000;

export interface JabRefConfig {
  /** Absolute paths to `.bib` files. */
  paths: string[];
}

interface Cache {
  fetchedAt: number;
  bibtex: string;
}

export function createJabRefProvider(config: JabRefConfig): CitationProvider {
  let cache: Cache | undefined;

  const readAll = async (): Promise<string> => {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.bibtex;
    }

    const chunks: string[] = [];
    for (const path of config.paths) {
      try {
        chunks.push(await readTextFile(path));
      } catch {
        // Missing / unreadable file is non-fatal — just drop it. status()
        // will report "error" so the user knows to fix the configuration.
      }
    }

    const bibtex = chunks.join("\n\n");
    cache = { fetchedAt: now, bibtex };
    return bibtex;
  };

  return {
    id: `jabref:${config.paths.join("|") || "empty"}`,
    category: "references",
    displayName:
      config.paths.length === 1
        ? `JabRef (${basename(config.paths[0])})`
        : `JabRef (${config.paths.length} files)`,

    async status(): Promise<ProviderStatus> {
      if (config.paths.length === 0) return "unconfigured";
      try {
        await readAll();
        return cache && cache.bibtex.length > 0 ? "ready" : "error";
      } catch {
        return "error";
      }
    },

    async exportAllAsBibTex(): Promise<string> {
      return readAll();
    },

    async searchLibrary(query: string): Promise<Citation[]> {
      const bibtex = await readAll();
      const entries = parseBibTex(bibtex);
      const q = query.trim().toLowerCase();
      const matched = q
        ? entries.filter((e) => {
            const f = extractFields(e.source);
            const hay = [
              e.key,
              f.title ?? "",
              f.authors.join(" "),
              f.year != null ? String(f.year) : "",
            ]
              .join(" ")
              .toLowerCase();
            return hay.includes(q);
          })
        : entries;

      return matched.slice(0, 50).map((entry) => {
        const f = extractFields(entry.source);
        return {
          key: entry.key,
          title: f.title ?? entry.key,
          authors: f.authors,
          year: f.year,
          doi: f.doi,
        };
      });
    },

    async fetchEntry(key: string) {
      const bibtex = await readAll();
      const entries = parseBibTex(bibtex);
      const entry = entries.find((e) => e.key === key);
      if (!entry) throw new Error(`Citation key '${key}' not found in JabRef library`);
      return { key, source: entry.source };
    },
  };
}

function basename(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
}
