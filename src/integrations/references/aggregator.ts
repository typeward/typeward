/**
 * Reference-library aggregator.
 *
 * Walks every registered `CitationProvider`, concatenates `exportAllAsBibTex`
 * output, dedupes by citation key, and writes the result to
 * `<project>/.typeward/citations/library.bib`.
 *
 * The path is deliberately inside the project tree (not `<app_data>`) so:
 *   1. The compile provider's file walker auto-discovers it
 *      and enables BibTeX when any `.bib` is found.
 *   2. texlab / tinymist see it as a normal `.bib` in the workspace and
 *      provide `\cite{}` completions over its keys for free.
 *   3. Per-project libraries stay isolated — different projects can bind
 *      different Zotero collections without cross-contamination.
 *
 * The file is rewritten on every refresh whose result differs from disk (an
 * identical result is a no-op so the language server doesn't reparse). A leading comment
 * marks it as auto-generated so users don't hand-edit and lose changes.
 */

import * as ipc from "~/ipc";
import type { Project } from "~/adapters/types";
import { describeIpcError } from "~/lib/errors";
import { recordError } from "~/lib/telemetry";

import { dedupeBibTex } from "./bibtex";
import { readLocalAdditions } from "./doi-lookup/cache";
import { citationProviders } from "./registry";

export const LIBRARY_REL_PATH = ".typeward/citations/library.bib";

export interface RefreshResult {
  /** Number of providers whose exports succeeded. */
  providersOk: number;
  /** Number of providers that errored — those are skipped, not fatal. */
  providersFailed: number;
  /** Per-provider failure detail, for surfacing to the user. */
  failures: Array<{ providerId: string; message: string }>;
  /** Citation keys present in the final library. */
  totalKeys: number;
  /** Duplicate keys that were skipped (later occurrence dropped). */
  duplicates: string[];
}

/**
 * Refresh the project's cached library.bib from every registered provider.
 *
 * One slow / failing provider does not block the others — the function
 * always writes whatever exports succeeded. The caller can show a toast
 * for the failures.
 */
export async function refreshLibraryBib(project: Project): Promise<RefreshResult> {
  const sources: Array<{ providerId: string; bibtex: string }> = [];
  const failures: RefreshResult["failures"] = [];
  let providersOk = 0;

  for (const provider of citationProviders()) {
    try {
      const bibtex = await provider.exportAllAsBibTex();
      if (bibtex.trim().length > 0) {
        sources.push({ providerId: provider.id, bibtex });
      }
      providersOk++;
    } catch (e) {
      failures.push({ providerId: provider.id, message: describeIpcError(e) });
      recordError("references-refresh", `provider ${provider.id} export failed`, e);
    }
  }

  // Project-local DOI / arXiv lookups live in their own file so they
  // survive across provider changes and aren't tied to any account.
  const local = await readLocalAdditions(project);
  if (local.trim().length > 0) {
    sources.push({ providerId: "doi-local", bibtex: local });
  }

  const { bibtex, duplicates } = dedupeBibTex(sources);

  // Content-address the write: the language server reparses library.bib on
  // every on-disk change, so a refresh that produced identical bytes (the
  // common case — nothing changed in Zotero since last time) must not touch the
  // file and spuriously invalidate texlab's parse.
  const existing = await ipc
    .readProjectTextFile(project.rootPath, LIBRARY_REL_PATH)
    .catch(() => null);
  if (existing !== bibtex) {
    await ipc.writeProjectTextFile(project.rootPath, LIBRARY_REL_PATH, bibtex);
  }

  return {
    providersOk,
    providersFailed: failures.length,
    failures,
    totalKeys: countKeys(bibtex),
    duplicates,
  };
}

function countKeys(bibtex: string): number {
  let count = 0;
  for (let i = 0; i < bibtex.length; i++) {
    if (bibtex[i] === "@" && /[A-Za-z]/.test(bibtex[i + 1] ?? "")) {
      const rest = bibtex.slice(i, i + 16).toLowerCase();
      if (
        !rest.startsWith("@string") &&
        !rest.startsWith("@preamble") &&
        !rest.startsWith("@comment")
      ) {
        count++;
      }
    }
  }
  return count;
}
