import { describeIpcError } from "~/lib/errors";
import { createSignal } from "solid-js";
import * as ipc from "~/ipc";
import type { Project, ProjectFormat } from "~/adapters/types";
import { projectsRoot } from "~/stores/settings-store";

const [projects, setProjects] = createSignal<Project[]>([]);
const [loading, setLoading] = createSignal<boolean>(false);
const [error, setError] = createSignal<string | null>(null);

export const isTrashed = (p: Project): boolean => p.trashedAt != null;
/** Future sharing signal. Today nothing is shared; when cloud sharing lands,
 *  this is the ONE place that learns to recognize it. */
export const isShared = (_p: Project): boolean => false;
export const isYours = (p: Project): boolean => !isShared(p);

async function refresh() {
  setLoading(true);
  setError(null);
  try {
    const root = projectsRoot() || undefined;
    const list = await ipc.listProjects(root);
    setProjects(list);
  } catch (e) {
    setError(describeIpcError(e));
    setProjects([]);
  } finally {
    setLoading(false);
  }
}

async function create(input: {
  name: string;
  format: ProjectFormat;
}): Promise<Project> {
  const project = await ipc.createProject({
    ...input,
    parent: projectsRoot() || undefined,
  });
  setProjects((prev) => [...prev, project].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  ));
  return project;
}

/** Patch a single project in the store by rootPath with the command's returned
 *  `next`. The shallow merge preserves listing-only fields (created/modified
 *  timestamps) that the setter commands don't return, but the Rust `Project`
 *  serializes tags/space/archived/trashedAt with `skip_serializing_if`, so a field
 *  cleared to its default is OMITTED from `next` — reconstruct those explicitly
 *  from the default rather than letting the spread keep the stale value (e.g.
 *  unarchive / restore / move-to-None / remove-last-tag). */
function patch(next: Project): void {
  setProjects((prev) =>
    prev.map((p) =>
      p.rootPath === next.rootPath
        ? {
            ...p,
            ...next,
            tags: next.tags ?? [],
            space: next.space,
            archived: next.archived ?? false,
            trashedAt: next.trashedAt,
          }
        : p,
    ),
  );
}

/** Persist a deadline (ISO `YYYY-MM-DD`, or `null` to clear) + patch the store. */
async function setDeadline(rootPath: string, deadline: string | null): Promise<void> {
  await ipc.setProjectDeadline(rootPath, deadline);
  setProjects((prev) =>
    prev.map((p) =>
      p.rootPath === rootPath ? { ...p, deadline: deadline ?? undefined } : p,
    ),
  );
}

async function setTags(rootPath: string, tags: string[]): Promise<void> {
  patch(await ipc.setProjectTags(rootPath, tags));
}

async function setSpace(rootPath: string, space: string | null): Promise<void> {
  patch(await ipc.setProjectSpace(rootPath, space));
}

async function setTrashed(rootPath: string, trashed: boolean): Promise<void> {
  patch(await ipc.setProjectTrashed(rootPath, trashed));
}

async function setArchived(rootPath: string, archived: boolean): Promise<void> {
  patch(await ipc.setProjectArchived(rootPath, archived));
}

async function rename(rootPath: string, name: string): Promise<void> {
  patch(await ipc.renameProject(rootPath, name));
}

/** Trash a project and drop it from the store. */
async function remove(rootPath: string): Promise<void> {
  await ipc.deleteProject(rootPath);
  setProjects((prev) => prev.filter((p) => p.rootPath !== rootPath));
}

/** Duplicate a project; append the copy to the store (re-sorted by name). */
async function duplicate(rootPath: string, name?: string): Promise<Project> {
  const copy = await ipc.duplicateProject(rootPath, name);
  setProjects((prev) =>
    [...prev, copy].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    ),
  );
  return copy;
}

export {
  create,
  duplicate,
  error,
  loading,
  projects,
  refresh,
  remove,
  rename,
  setArchived,
  setDeadline,
  setSpace,
  setTags,
  setTrashed,
};
