import { createSignal } from "solid-js";
import * as ipc from "~/ipc";
import type { Project, ProjectFormat } from "~/adapters/types";
import { projectsRoot } from "~/stores/settings-store";

const [projects, setProjects] = createSignal<Project[]>([]);
const [loading, setLoading] = createSignal<boolean>(false);
const [error, setError] = createSignal<string | null>(null);

async function refresh() {
  setLoading(true);
  setError(null);
  try {
    const root = projectsRoot() || undefined;
    const list = await ipc.listProjects(root);
    setProjects(list);
  } catch (e) {
    setError(String(e));
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

export {
  create,
  error,
  loading,
  projects,
  refresh,
};
