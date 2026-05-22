/**
 * Cloud-backed project creation.
 *
 * `createCloudBackedProject` orchestrates:
 *   1. project id generation (slugified remote folder name + short
 *      random suffix so two roots with the same name don't collide)
 *   2. local cache directory prep under
 *      `<projectsRoot>/.remote-cache/<provider>/<projectId>/`
 *   3. `createProject({ name, format, parent: cacheRoot })` — creates
 *      the same starter shell as a local project
 *   4. `setProjectIntegrations({ cloudOrigin })` — records the binding
 *   5. engine seed via `enumerateFiles` — pulls any existing remote
 *      content into the cache so the local working copy reflects the
 *      remote at create time. New remote folders return zero files.
 *
 * Returns the persisted project (with `integrations.cloudOrigin` set)
 * along with the engine ready to start.
 */

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

  const provider = cloudProviderForAccount(opts.account, {
    projectsRoot: opts.projectsRoot,
    projectId,
  });

  // 1. Local shell — same starter content as a normal new project,
  //    just rooted inside the per-project cache directory.
  const initial = await ipc.createProject({
    name,
    format: opts.format,
    parent: cacheRoot,
  });

  // 2. Record the cloud binding on disk so subsequent opens know to
  //    instantiate an engine for this project.
  const project = await ipc.setProjectIntegrations(initial.rootPath, {
    cloudOrigin: {
      provider: opts.account.provider,
      accountId: opts.account.accountId,
      remotePath: opts.remoteRoot.id,
    },
  });

  const engine = new SyncEngine(provider, {
    providerId: provider.id,
    projectId,
    rootId: opts.remoteRoot.id,
    projectsRoot: opts.projectsRoot,
  });

  return { project, engine };
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
