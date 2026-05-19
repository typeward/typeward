import { createSignal } from "solid-js";
import * as ipc from "~/ipc";
import type { Project, ProjectFormat } from "~/adapters/types";
import type { DocumentExperience } from "~/experiences/types";
import { projectsRoot } from "~/stores/settings-store";

const [projects, setProjects] = createSignal<Project[]>([]);
const [loading, setLoading] = createSignal<boolean>(false);
const [error, setError] = createSignal<string | null>(null);
const [active, setActive] = createSignal<Project | null>(null);

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
  experience?: DocumentExperience;
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

async function open(path: string): Promise<Project> {
  const project = await ipc.openProject(path);
  setActive(project);
  return project;
}

export {
  active,
  create,
  error,
  loading,
  open,
  projects,
  refresh,
  setActive,
};
