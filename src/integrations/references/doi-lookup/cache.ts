/**
 * Per-project storage for DOI / arXiv lookups.
 *
 * DOI lookup isn't a "library" in the sense Zotero/Mendeley/JabRef are —
 * it's a one-shot resolver that drops entries into a project-local
 * `.bib` file. The aggregator picks this file up alongside provider
 * exports and merges into `library.bib`.
 *
 * Path: `<project>/.typeward/citations/local.bib`. Lives inside the
 * project so per-project lookups don't bleed across projects.
 */

import * as ipc from "~/ipc";
import type { Project } from "~/adapters/types";

import { dedupeBibTex, parseBibTex } from "../bibtex";

export const LOCAL_REL_PATH = ".typeward/citations/local.bib";

export async function readLocalAdditions(project: Project): Promise<string> {
  try {
    return await ipc.readProjectTextFile(project.rootPath, LOCAL_REL_PATH);
  } catch {
    return "";
  }
}

export async function appendLocalAddition(
  project: Project,
  bibtex: string,
): Promise<{ added: boolean; key: string }> {
  const existing = await readLocalAdditions(project);
  const merged = dedupeBibTex([
    { providerId: "doi-local", bibtex: existing },
    { providerId: "doi-local-new", bibtex },
  ]);

  const newEntries = parseBibTex(bibtex);
  const key = newEntries[0]?.key ?? "";
  const alreadyPresent = merged.duplicates.includes(key);

  await ipc.writeProjectTextFile(project.rootPath, LOCAL_REL_PATH, merged.bibtex);

  return { added: !alreadyPresent, key };
}
