/**
 * Cloud-backed project creation.
 *
 * `createCloudBackedProject`:
 *   1. generates a project id (slugified remote folder name + short random
 *      suffix so two roots with the same name don't collide)
 *   2. SEEDS the local cache from existing remote content first — downloads
 *      every remote file, records its sync state, and persists the cursor — so
 *      the local working copy mirrors the remote at create time and the first
 *      sync pass doesn't treat a planted starter as a conflict
 *   3. writes project metadata: detected from the seeded content when the
 *      remote had files, or a fresh starter shell when the remote was empty
 *   4. records the `cloudOrigin` binding
 *
 * Returns the persisted project (with `integrations.cloudOrigin` set) along
 * with the seeded engine.
 */

import { writeTextFile } from "@tauri-apps/plugin-fs";

import * as ipc from "~/ipc";
import type { Project, ProjectFormat } from "~/adapters/types";

import { SyncEngine, projectCacheRoot } from "./core";
import {
  cloudProviderForAccount,
  type CloudAccountRef,
} from "./registry";
import type { RemoteFolder } from "~/integrations/types";

export interface CreateCloudBackedProjectOptions {
  account: CloudAccountRef;
  remoteRoot: RemoteFolder;
  /** Display name for the new project. Defaults to the remote folder name. */
  name?: string;
  format: ProjectFormat;
  projectsRoot: string;
}

export interface CreateCloudBackedProjectResult {
  project: Project;
  engine: SyncEngine;
}

export async function createCloudBackedProject(
  opts: CreateCloudBackedProjectOptions,
): Promise<CreateCloudBackedProjectResult> {
  const name = opts.name ?? opts.remoteRoot.name;
  const projectId = makeProjectId(opts.remoteRoot.name);
  const cacheRoot = projectCacheRoot(
    opts.projectsRoot,
    opts.account.provider,
    projectId,
  );

  const provider = cloudProviderForAccount(opts.account);
  const engine = new SyncEngine(provider, {
    providerId: provider.id,
    projectId,
    rootId: opts.remoteRoot.id,
    projectsRoot: opts.projectsRoot,
    cacheRoot,
  });

  // 1. Seed the cache from existing remote content before any metadata is
  //    written. This downloads remote files, records their sync state, and
  //    persists the post-enumeration cursor so the first sync pass continues
  //    cleanly instead of conflicting a planted starter against the remote.
  const seededCount = await engine.seedFromRemote();

  // 2. Write project metadata.
  let project: Project;
  if (seededCount > 0) {
    // Remote had content — detect the root file from what we just downloaded.
    try {
      project = await ipc.importProjectFolder(cacheRoot);
    } catch {
      // Remote folder has files but no .tex/.typ entry — add a starter for the
      // requested format, then import. The starter pushes on first save.
      await seedStarterFile(cacheRoot, name, opts.format);
      project = await ipc.importProjectFolder(cacheRoot);
    }
  } else {
    // Empty remote — the usual starter shell; it pushes on first save.
    project = await ipc.createProject({
      name,
      format: opts.format,
      parent: cacheRoot,
    });
  }

  // 3. Record the cloud binding so subsequent opens start an engine.
  project = await ipc.setProjectIntegrations(project.rootPath, {
    cloudOrigin: {
      provider: opts.account.provider,
      accountId: opts.account.accountId,
      remotePath: opts.remoteRoot.id,
    },
  });

  return { project, engine };
}

/**
 * Minimal starter for a remote folder that had files but no LaTeX/Typst entry.
 *
 * Mirrors Rust's canonical `ProjectFormat::starter_content` (project.rs); kept
 * in sync by hand because no existing IPC seeds a starter into a pre-existing
 * folder (create_project makes a fresh directory, import_project_folder only
 * detects an existing root file). Keep the two in step until a
 * write_starter_file IPC exists.
 */
async function seedStarterFile(
  cacheRoot: string,
  name: string,
  format: ProjectFormat,
): Promise<void> {
  const sep = cacheRoot.includes("\\") ? "\\" : "/";
  const file = format === "typst" ? "main.typ" : "main.tex";
  const content =
    format === "typst"
      ? `= ${name}\n\nWelcome to ${name}.\n`
      : `\\documentclass{article}\n\\title{${name}}\n\\author{}\n\\date{\\today}\n\n\\begin{document}\n\\maketitle\n\nWelcome to ${name}.\n\\end{document}\n`;
  await writeTextFile(`${cacheRoot}${sep}${file}`, content);
}

function makeProjectId(folderName: string): string {
  const slug = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "project";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slug}-${suffix}`;
}
