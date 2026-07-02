import { describeIpcError } from "~/lib/errors";
import { useNavigate } from "@solidjs/router";
import {
  BookMarked,
  CalendarClock,
  ChevronDown,
  Compass,
  FlaskConical,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  GraduationCap,
  LayoutGrid,
  List,
  Plus,
  Tag,
  Upload,
  X,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createEffect, createMemo, createResource, createSignal, onMount } from "solid-js";
import type { Project, ProjectFormat } from "~/adapters/types";
import { stripMarkupForWordCount } from "~/adapters/format-tables";
import { createCloudBackedProject } from "~/integrations/cloud/create";
import {
  cloudProviderForAccount,
  type CloudAccountRef,
} from "~/integrations/cloud/registry";
import type { RemoteFolder } from "~/integrations/types";
import { CloneDialog } from "~/components/vcs/CloneDialog";
import { TemplateGallery } from "~/components/templates/TemplateGallery";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "~/ipc";
import { integrationsSettings, projectsRoot } from "~/stores/settings-store";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { TopBar } from "~/components/layout/TopBar";
import { Dialog } from "~/components/primitives/Dialog";
import { Button } from "~/components/primitives/Button";
import { KbdHint } from "~/components/primitives/KbdHint";
import { NotificationsPanel, unreadCount } from "~/components/projects/NotificationsPanel";
import { currentTier } from "~/integrations/entitlements";
import { dismissBootSplash } from "~/lib/boot-splash";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { openPalette } from "~/commands/actions";
import {
  requestNewProject_,
  setRequestNewProject,
} from "~/commands/palette-store";
import {
  create,
  error as projectsError,
  loading,
  projects,
  refresh,
  setDeadline,
} from "~/stores/projects-store";
import {
  DEADLINE_TONE_COLOR,
  deadlineStatus,
} from "~/lib/deadlines";
import { setPreviousRoute } from "~/stores/nav-store";
import {
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  projectCardWords,
  type ProjectsSort,
  type ProjectsView,
  setDefaultSort,
  setDefaultView,
} from "~/stores/workspace-store";

// =================================================================
// Display metadata helpers — disk only carries name + format today;
// the rest is rendered with placeholder "—" until real fields land.
// =================================================================

const FORMAT_LABEL: Record<ProjectFormat, string> = {
  latex: "LaTeX",
  typst: "Typst",
};

// Theme-aware via CSS vars set in tokens.css + light theme overrides.
const FORMAT_ACCENT: Record<ProjectFormat, string> = {
  latex: "var(--format-latex)",
  typst: "var(--format-typst)",
};

const SORT_LABEL: Record<ProjectsSort, string> = {
  "last-opened": "Default order",
  name: "Name (A–Z)",
  "name-desc": "Name (Z–A)",
  created: "Date created",
  modified: "Last modified",
  deadline: "Deadline",
  format: "Format",
};

// `list_projects` now carries fs created/modified timestamps + the user-set
// deadline, so every sort below resolves against real data.
const AVAILABLE_SORTS: readonly ProjectsSort[] = [
  "last-opened",
  "name",
  "name-desc",
  "created",
  "modified",
  "deadline",
  "format",
];

// =================================================================
// Screen root
// =================================================================

const ProjectsScreen: Component = () => {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [notifOpen, setNotifOpen] = createSignal(notificationsPanelDefault());
  const [importError, setImportError] = createSignal<string | null>(null);

  onMount(() => {
    dismissBootSplash();
    // AppShell prefetches the library as soon as settings resolve — don't
    // stack a second list_projects on top of one already in flight.
    if (!loading()) void refresh();
  });

  // Import an EXISTING folder (a manually-copied repo / unzipped project) as a
  // Typeward project — distinct from "New project", which scaffolds a starter.
  // The Rust gate only allows folders under the projects root, so default the
  // picker there and surface an actionable error otherwise.
  const importFolder = async () => {
    setImportError(null);
    const root = projectsRoot();
    const picked = await openFileDialog({
      title: "Pick a project folder to import",
      directory: true,
      multiple: false,
      defaultPath: root || undefined,
    });
    if (!picked || typeof picked !== "string") return;
    try {
      const project = await ipc.importProjectFolder(picked);
      await refresh();
      openProject(project);
    } catch (e) {
      const msg = describeIpcError(e);
      setImportError(
        /outside the projects root/i.test(msg)
          ? `Import only works for folders inside your projects root${
              root ? ` (${root})` : ""
            }. Move the folder there first, or use Clone / Overleaf import from New project.`
          : `Could not import folder: ${msg}`,
      );
    }
  };

  createEffect(() => {
    if (requestNewProject_()) {
      setDialogOpen(true);
      setRequestNewProject(false);
    }
  });

  const openProject = (project: Project) => {
    navigate(`/editor?path=${encodeURIComponent(project.rootPath)}`);
  };

  const sortedProjects = createMemo<Project[]>(() => {
    const list = [...projects()];
    switch (defaultSort()) {
      case "name":
        return list.sort((a, b) => a.name.localeCompare(b.name));
      case "name-desc":
        return list.sort((a, b) => b.name.localeCompare(a.name));
      case "format":
        return list.sort(
          (a, b) => a.format.localeCompare(b.format) || a.name.localeCompare(b.name),
        );
      case "created":
        return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      case "modified":
        return list.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
      case "deadline":
        // Soonest first; projects without a deadline sink to the bottom.
        return list.sort((a, b) => {
          const da = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
          const db = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
          return da - db || a.name.localeCompare(b.name);
        });
      // "last-opened" has no backing metadata yet — keep the Rust listing's
      // name order as the stable default.
      default:
        return list;
    }
  });

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />

      <div class="relative z-10 flex h-full flex-col">
        <TopBar
          notifications={unreadCount()}
          onOpenPalette={() => openPalette()}
          onToggleNotifications={() => setNotifOpen((v) => !v)}
          onOpenSettings={() => {
            setPreviousRoute("/projects");
            navigate("/settings");
          }}
        />

        <div class="relative flex min-h-0 flex-1 gap-2 p-2">
          <Sidebar
            onNewProject={() => setDialogOpen(true)}
            onImport={() => void importFolder()}
            totalCount={projects().length}
          />

          <div class="flex min-w-0 flex-1 flex-col gap-2">
            {/* Library header — the library IS the screen now; the old
                ComposerHero (AI compose preview) was demoted out entirely.
                The opt-in Widgets panel is unmounted for now — see
                design/widgets.md; src/widgets/ remains for its return. */}
            <div class="flex items-end justify-between px-2 pt-3">
              <div>
                <h1 class="text-xl font-semibold tracking-tight text-fg-1">
                  Library
                </h1>
                <div class="mono mt-0.5 text-xs text-fg-3">
                  {projects().length} project{projects().length === 1 ? "" : "s"} ·
                  local-first
                </div>
              </div>
            </div>
            <Toolbar />

            <div class="mt-1 flex-1 overflow-auto scroll px-1 pb-2">
              <Show when={importError()}>
                <div class="mb-3 flex items-start justify-between gap-3 rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]">
                  <span class="select-text">{importError()}</span>
                  <button
                    type="button"
                    onClick={() => setImportError(null)}
                    class="-m-1.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded p-1.5 text-fg-3 hover:text-fg-1"
                    aria-label="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
              </Show>
              <Show when={projectsError()}>
                <div class="mb-3 select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]">
                  Failed to list projects: {projectsError()}
                </div>
              </Show>
              <Show
                when={!loading() || projects().length > 0}
                fallback={
                  <div class="py-10 text-center text-sm text-fg-3">
                    Loading projects…
                  </div>
                }
              >
                <Show
                  when={defaultView() === "cards"}
                  fallback={
                    <ProjectList
                      projects={sortedProjects()}
                      onOpen={openProject}
                      onNew={() => setDialogOpen(true)}
                    />
                  }
                >
                  <ProjectGrid
                    projects={sortedProjects()}
                    onOpen={openProject}
                    onNew={() => setDialogOpen(true)}
                  />
                </Show>
                <Show when={projects().length > 0}>
                  <div class="mono py-6 text-center text-xs text-fg-3">
                    — end of {projects().length} project{projects().length === 1 ? "" : "s"} —
                  </div>
                </Show>
              </Show>
            </div>
          </div>

          <NotificationsPanel open={notifOpen()} onClose={() => setNotifOpen(false)} />
        </div>
      </div>

      <NewProjectDialog
        open={dialogOpen()}
        onClose={() => setDialogOpen(false)}
        onCreated={(p) => {
          setDialogOpen(false);
          openProject(p);
        }}
      />
    </div>
  );
};

export default ProjectsScreen;

// =================================================================
// Sidebar
// =================================================================

interface SidebarItem {
  id: string;
  label: string;
  icon: Component<{ size?: number; class?: string }>;
  count?: number;
  active?: boolean;
  dot?: string;
  tint?: string;
}

const Sidebar: Component<{
  onNewProject: () => void;
  onImport: () => void;
  totalCount: number;
}> = (props) => {
  const navigate = useNavigate();
  // Only views that exist. Recently-opened/Starred/Archive/Trash were dead
  // nav with no backing data — they return when their features do.
  const librarySection = (): SidebarItem[] => [
    { id: "all", label: "All projects", icon: FolderIcon, count: props.totalCount, active: true },
  ];

  const spacesSection = (): SidebarItem[] => [
    { id: "sp1", label: "Stochastic Lab", icon: FlaskConical, dot: "var(--color-accent-1)" },
    { id: "sp2", label: "Thesis 2026", icon: GraduationCap, dot: "var(--color-accent-2)" },
    { id: "sp3", label: "Conference Drafts", icon: Compass, dot: "var(--color-warn)" },
    { id: "sp4", label: "Reading group", icon: BookMarked, dot: "var(--color-ok)" },
  ];

  const tagsSection = (): SidebarItem[] => [
    { id: "t1", label: "icml-2026", icon: Tag, tint: "var(--color-accent-1)" },
    { id: "t2", label: "neurips-2025", icon: Tag, tint: "var(--color-accent-2)" },
    { id: "t3", label: "in-review", icon: Tag, tint: "var(--color-warn)" },
    { id: "t4", label: "archived", icon: Tag, tint: "var(--color-fg-3)" },
  ];

  return (
    <div
      class="glass flex flex-col overflow-hidden rounded-xl"
      style={{ width: "240px", height: "100%" }}
    >
      <div class="border-b border-glass-stroke p-3">
        <button
          type="button"
          onClick={props.onNewProject}
          class="lift glow-accent relative flex h-9 w-full items-center justify-center gap-2 rounded-lg accent-grad text-sm font-semibold"
        >
          <Plus size={14} stroke-width={2.4} />
          <span>New project</span>
          <span class="ml-1">
            <KbdHint shortcut="Mod+N" size="md" tone="dark" />
          </span>
        </button>
        <div class="mt-2 grid grid-cols-1 gap-1.5">
          {/* Imports an existing folder under the projects root. Clone +
              Overleaf zip import live in the New-project dialog. */}
          <SidebarMiniButton
            icon={<Upload size={11} style={{ opacity: 0.7 }} />}
            onClick={props.onImport}
          >
            Import folder
          </SidebarMiniButton>
        </div>
      </div>

      <div class="flex-1 space-y-3.5 overflow-auto scroll p-2">
        <SidebarGroup label="Library" items={librarySection()} />
        <Show when={enableSpaces()}>
          <SidebarGroup label="Spaces · sample" items={spacesSection()} />
        </Show>
        <Show when={enableTags()}>
          <SidebarGroup label="Tags · sample" items={tagsSection()} />
        </Show>
      </div>

      {/* Subscription footer — Storage info removed (premature; lands with cloud sync) */}
      <div class="border-t border-glass-stroke p-3">
        <button
          type="button"
          onClick={() => {
            setPreviousRoute("/projects");
            navigate("/settings");
          }}
          class="lift glass-soft flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-xs text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
        >
          <span class="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-accent-1)" }} />
          <span class="capitalize">{currentTier()} plan</span>
          <span class="mono text-fg-4">·</span>
          <span class="text-fg-3">Manage</span>
        </button>
      </div>
    </div>
  );
};

const SidebarGroup: Component<{
  label: string;
  items: SidebarItem[];
}> = (props) => (
  <div>
    <div class="label-xs mb-1.5 flex items-center justify-between px-2 text-fg-3">
      <span>{props.label}</span>
    </div>
    <For each={props.items}>
      {(item) => (
        <button
          type="button"
          class={`lift relative flex w-full items-center gap-2 rounded-md px-2 text-base ${
            item.active
              ? "side-active bg-[var(--color-selection-bg)] text-fg-1"
              : "text-fg-2 hover:bg-[var(--color-control-fill)]"
          }`}
          style={{ height: "var(--ui-row)" }}
        >
          <Show
            when={item.dot}
            fallback={<item.icon class="ui-icon-menu" />}
          >
            <span
              class="h-1.5 w-1.5 rounded-full"
              style={{ background: item.dot }}
            />
          </Show>
          <span class={item.active ? "font-medium" : ""}>{item.label}</span>
          <Show when={item.count != null}>
            <span class="mono ml-auto text-xs text-fg-3">{item.count}</span>
          </Show>
        </button>
      )}
    </For>
  </div>
);

const SidebarMiniButton: Component<{
  icon: JSX.Element;
  children: JSX.Element;
  onClick?: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={() => props.onClick?.()}
    class="lift glass-soft flex items-center justify-center gap-1.5 rounded-md text-xs text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
    style={{ height: "var(--ui-row-sm)" }}
  >
    {props.icon}
    <span>{props.children}</span>
  </button>
);

// =================================================================
// Toolbar — Sort / View
// =================================================================

const Toolbar: Component = () => {
  const [sortOpen, setSortOpen] = createSignal(false);
  let sortRef: HTMLDivElement | undefined;
  installDismiss(() => sortRef, sortOpen, () => setSortOpen(false));
  useListboxOpenFocus(sortOpen, () => sortRef);
  return (
    <div class="flex items-center gap-2 px-1 pt-1">
      <div class="ml-auto flex items-center gap-1.5">
        <div class="relative" ref={sortRef}>
          <button
            type="button"
            onClick={() => setSortOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={sortOpen()}
            class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <span>
              Sort: <span class="text-fg-1">{SORT_LABEL[defaultSort()]}</span>
            </span>
            <ChevronDown size={10} style={{ opacity: 0.5 }} />
          </button>
          <Show when={sortOpen()}>
            <div
              role="listbox"
              tabindex={-1}
              onKeyDown={(e) => handleListboxKeydown(e, sortRef, () => setSortOpen(false))}
              class="glass absolute right-0 top-full z-30 mt-1 w-[180px] rounded-lg"
              style={{ padding: "6px", background: "var(--color-popover-bg)" }}
            >
              <For each={AVAILABLE_SORTS}>
                {(key) => {
                  const active = () => defaultSort() === key;
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={active()}
                      tabindex={-1}
                      onClick={() => {
                        setDefaultSort(key);
                        setSortOpen(false);
                      }}
                      class={`lift flex w-full items-center justify-between rounded-md px-2.5 text-left text-sm ${
                        active()
                          ? "bg-[var(--color-control-fill-hover)] text-fg-1"
                          : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                      }`}
                      style={{ height: "var(--ui-row-sm)" }}
                    >
                      <span>{SORT_LABEL[key]}</span>
                      <Show when={active()}>
                        <span class="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-accent-1)" }} />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        <div class="glass-soft flex items-center gap-0.5 rounded-md p-0.5">
          <ViewToggleButton
            view="cards"
            active={defaultView() === "cards"}
            label="Cards"
            icon={<LayoutGrid size={12} />}
          />
          <ViewToggleButton
            view="list"
            active={defaultView() === "list"}
            label="List"
            icon={<List size={12} />}
          />
        </div>
      </div>
    </div>
  );
};

const ViewToggleButton: Component<{
  view: ProjectsView;
  active: boolean;
  label: string;
  icon: JSX.Element;
}> = (props) => (
  <button
    type="button"
    onClick={() => setDefaultView(props.view)}
    aria-label={props.label}
    title={props.label}
    class={`flex h-7 w-7 items-center justify-center rounded ${
      props.active
        ? "bg-[var(--color-selection-bg)] text-fg-1"
        : "text-fg-2 hover:bg-[var(--color-control-fill)]"
    }`}
  >
    {props.icon}
  </button>
);

// =================================================================
// Project grid / list / cards
// =================================================================

const ProjectGrid: Component<{
  projects: Project[];
  onOpen: (p: Project) => void;
  onNew: () => void;
}> = (props) => (
  <div
    class="grid gap-3"
    style={{
      "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))",
      "grid-auto-rows": "min-content",
    }}
  >
    <NewProjectTile onClick={props.onNew} />
    <For each={props.projects}>
      {(p) => <ProjectCard project={p} onOpen={() => props.onOpen(p)} />}
    </For>
  </div>
);

const ProjectList: Component<{
  projects: Project[];
  onOpen: (p: Project) => void;
  onNew: () => void;
}> = (props) => (
  <div class="flex flex-col gap-1.5">
    <button
      type="button"
      onClick={props.onNew}
      class="card-glow lift flex items-center gap-3 rounded-md px-3 hover:bg-[var(--color-control-fill)]"
      style={{
        height: "var(--ui-row-lg)",
        background: "var(--color-card-bg-soft)",
        border: "1px dashed var(--color-glass-stroke-strong)",
      }}
    >
      <span class="flex h-7 w-7 items-center justify-center rounded-md accent-grad">
        <Plus size={13} stroke-width={2.4} />
      </span>
      <span class="text-sm font-medium text-fg-1">New project</span>
      <span class="ml-auto">
        <KbdHint shortcut="Mod+N" size="sm" />
      </span>
    </button>
    <For each={props.projects}>
      {(p) => <ProjectRow project={p} onOpen={() => props.onOpen(p)} />}
    </For>
  </div>
);

const NewProjectTile: Component<{ onClick: () => void }> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class="card-glow flex flex-col items-center justify-center gap-2.5 overflow-hidden rounded-xl"
    style={{
      height: "180px",
      background: "var(--color-card-bg-soft)",
      border: "1.5px dashed var(--color-glass-stroke-strong)",
      padding: "var(--ui-pad-card)",
    }}
  >
    <div class="glow-accent flex h-12 w-12 items-center justify-center rounded-2xl accent-grad">
      <Plus size={18} stroke-width={2.4} />
    </div>
    <div class="text-center">
      <div class="text-base font-semibold text-fg-1">
        New project
      </div>
      <div class="mt-0.5 text-xs text-fg-3">
        template, import, or compose
      </div>
    </div>
    <KbdHint shortcut="Mod+N" size="sm" />
  </button>
);

const openOnKey = (onOpen: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onOpen();
  }
};

const ProjectCard: Component<{ project: Project; onOpen: () => void }> = (props) => {
  const accentColor = FORMAT_ACCENT[props.project.format];
  return (
    <div
      role="button"
      tabindex={0}
      onClick={props.onOpen}
      onKeyDown={openOnKey(props.onOpen)}
      class="card-glow group flex flex-col gap-2 rounded-xl text-left"
      style={{
        height: "180px",
        background: "var(--color-card-bg)",
        padding: "var(--ui-pad-card)",
      }}
    >
      <div class="flex items-center justify-between gap-2">
        <span
          class="mono rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            background: "var(--color-control-fill)",
            color: accentColor,
            border: `1px solid color-mix(in oklab, ${accentColor} 30%, transparent)`,
          }}
        >
          {FORMAT_LABEL[props.project.format]}
        </span>
        <DeadlineEditor
          deadline={props.project.deadline}
          onChange={(d) => void setDeadline(props.project.rootPath, d)}
        />
      </div>

      <div
        class="mt-1 flex-1 text-base font-semibold leading-snug text-fg-1"
        style={{
          "text-wrap": "pretty",
          display: "-webkit-box",
          "-webkit-line-clamp": 2,
          "-webkit-box-orient": "vertical",
          overflow: "hidden",
        }}
      >
        {props.project.name}
      </div>

      <div class="mono flex items-center justify-between gap-2 text-xs text-fg-3">
        <span class="flex min-w-0 items-center gap-1.5">
          <FolderOpen size={10} style={{ opacity: 0.6 }} />
          <span class="truncate">{props.project.rootFile}</span>
        </span>
        <ProjectWordCount project={props.project} />
      </div>
    </div>
  );
};

/**
 * Approximate word count for the project's root file. Opt-in
 * (`workspace.projectCardWords`) because it reads each project's root file
 * when the library renders. Counts only the root file — `\input{}` children
 * aren't followed — so it's labelled "~".
 */
const ProjectWordCount: Component<{ project: Project }> = (props) => {
  const [count] = createResource(
    () => (projectCardWords() ? props.project : null),
    async (p) => {
      try {
        const text = await ipc.readProjectTextFile(p.rootPath, p.rootFile);
        return approxWordCount(text, p.format);
      } catch {
        return null;
      }
    },
  );
  return (
    <Show when={projectCardWords() && count() != null}>
      <span
        class="flex flex-shrink-0 items-center gap-1"
        title="Approximate words in the root file"
      >
        <FileText size={9} style={{ opacity: 0.6 }} />
        {count()!.toLocaleString()}w
      </span>
    </Show>
  );
};

function approxWordCount(text: string, format: ProjectFormat): number {
  // Format-specific comment/markup stripping rides adapter format tables so a
  // new format extends one exhaustive record; the punctuation strip + count
  // below are format-agnostic.
  let t = stripMarkupForWordCount(text, format);
  t = t.replace(/[{}[\]()\\$&#~^_*=]/g, " ");
  return t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

const ProjectRow: Component<{ project: Project; onOpen: () => void }> = (props) => {
  const accentColor = FORMAT_ACCENT[props.project.format];
  return (
    <div
      role="button"
      tabindex={0}
      onClick={props.onOpen}
      onKeyDown={openOnKey(props.onOpen)}
      class="card-glow group flex items-center gap-3 rounded-md px-3 text-left"
      style={{
        height: "var(--ui-row-lg)",
        background: "var(--color-card-bg)",
      }}
    >
      <span
        class="h-2 w-2 rounded-full"
        style={{ background: accentColor }}
      />
      <span class="min-w-0 truncate text-sm font-medium text-fg-1">
        {props.project.name}
      </span>
      <span class="mono flex-shrink-0 text-xs text-fg-3">
        {FORMAT_LABEL[props.project.format]}
      </span>
      <span class="mono ml-auto truncate text-xs text-fg-3" style={{ "max-width": "180px" }}>
        {props.project.rootFile}
      </span>
      <DeadlineEditor
        deadline={props.project.deadline}
        onChange={(d) => void setDeadline(props.project.rootPath, d)}
      />
    </div>
  );
};

/**
 * Deadline chip + date popover. Shows the deadline (color-coded by urgency) or
 * a hover-revealed "deadline" affordance when unset. Lives inside clickable
 * project cards, so every interaction stops propagation to avoid opening the
 * project underneath.
 */
const DeadlineEditor: Component<{
  deadline?: string;
  onChange: (deadline: string | null) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  const status = createMemo(() => deadlineStatus(props.deadline));

  return (
    <div
      ref={rootRef}
      class="relative flex-shrink-0"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          status()
            ? `Deadline: ${status()!.label} (${status()!.relative}) — click to change`
            : "Set a deadline"
        }
        class="mono flex h-6 items-center gap-1 rounded px-1.5 text-[10px] hover:bg-[var(--color-control-fill)]"
        style={{ color: status() ? DEADLINE_TONE_COLOR[status()!.tone] : "var(--color-fg-3)" }}
      >
        <CalendarClock size={10} />
        <Show
          when={status()}
          fallback={
            <span class="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              deadline
            </span>
          }
        >
          {/* Overdue/soon urgency must read without color — append the relative phrase. */}
          <span>
            {status()!.tone === "normal"
              ? status()!.label
              : `${status()!.label} · ${status()!.relative}`}
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div
          class="glass absolute right-0 top-full z-40 mt-1 flex w-[200px] flex-col gap-2 rounded-lg"
          style={{ padding: "var(--ui-pad-section)", background: "var(--color-popover-bg)" }}
        >
          <span class="label-xs text-fg-3">Deadline</span>
          <input
            type="date"
            value={props.deadline ?? ""}
            onInput={(e) => props.onChange(e.currentTarget.value || null)}
            class="glass-inset rounded-md px-2 py-1.5 text-sm text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
          <Show when={status()}>
            <div class="flex items-center justify-between">
              <span
                class="mono text-[10px]"
                style={{ color: DEADLINE_TONE_COLOR[status()!.tone] }}
              >
                {status()!.relative}
              </span>
              <button
                type="button"
                onClick={() => {
                  props.onChange(null);
                  setOpen(false);
                }}
                class="text-xs text-fg-3 hover:text-[var(--color-err)]"
              >
                Clear
              </button>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

// =================================================================
// New project dialog (unchanged from previous version)
// =================================================================

const FORMATS: Array<{ id: ProjectFormat; label: string; sub: string }> = [
  { id: "latex", label: "LaTeX", sub: "main.tex + bib + figures" },
  { id: "typst", label: "Typst", sub: "Modern alternative to LaTeX" },
];

const NewProjectDialog: Component<{
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}> = (props) => {
  const [name, setName] = createSignal("");
  const [format, setFormat] = createSignal<ProjectFormat>("latex");
  const [deadlineInput, setDeadlineInput] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [location, setLocation] = createSignal<"local" | "cloud">("local");
  const [account, setAccount] = createSignal<CloudAccountRef | null>(null);
  const [remoteRoot, setRemoteRoot] = createSignal<RemoteFolder | null>(null);
  const [cloneOpen, setCloneOpen] = createSignal(false);
  const [galleryOpen, setGalleryOpen] = createSignal(false);

  const importOverleafZip = async () => {
    const picked = await openFileDialog({
      title: "Pick an Overleaf-exported .zip",
      filters: [{ name: "Zip", extensions: ["zip"] }],
      multiple: false,
    });
    if (!picked || typeof picked !== "string") return;
    const root = projectsRoot();
    if (!root) {
      setErr("Set a projects root in Settings first.");
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      const projectName = inferNameFromPath(picked);
      const project = await ipc.overleafImportZip(picked, root, projectName);
      reset();
      props.onCreated(project);
    } catch (e) {
      setErr(describeIpcError(e));
      setSubmitting(false);
    }
  };

  const cloudAccounts = createMemo<CloudAccountRef[]>(() =>
    integrationsSettings()
      .cloud.accounts.filter((a) => a.provider === "dropbox" || a.provider === "webdav")
      .map((a) => ({
        provider: a.provider as CloudAccountRef["provider"],
        accountId: a.accountId,
        label: a.label,
        baseUrl: a.baseUrl,
        username: a.username,
        allowPrivateHost: a.allowPrivateHost,
      })),
  );

  const [remoteRoots] = createResource(account, async (acc) => {
    if (!acc) return [];
    const root = projectsRoot();
    if (!root) return [];
    try {
      const provider = cloudProviderForAccount(acc);
      return await provider.listRoots();
    } catch (e) {
      setErr(`Could not list remote folders: ${describeIpcError(e)}`);
      return [];
    }
  });

  const reset = () => {
    setName("");
    setFormat("latex");
    setDeadlineInput("");
    setErr(null);
    setSubmitting(false);
    setLocation("local");
    setAccount(null);
    setRemoteRoot(null);
  };

  const submit = async () => {
    if (!name().trim()) {
      setErr("Name is required");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      let project: Project;
      if (location() === "cloud") {
        const acc = account();
        const root = remoteRoot();
        const projRoot = projectsRoot();
        if (!acc || !root || !projRoot) {
          throw new Error("Pick a cloud account and a remote folder first.");
        }
        const result = await createCloudBackedProject({
          account: acc,
          remoteRoot: root,
          name: name().trim(),
          format: format(),
          projectsRoot: projRoot,
        });
        // Engine starts automatically once the project becomes the active
        // one in editor-store; init.ts watches `project()`.
        project = result.project;
      } else {
        project = await create({ name: name().trim(), format: format() });
      }
      const dl = deadlineInput().trim();
      if (dl) {
        try {
          await ipc.setProjectDeadline(project.rootPath, dl);
          project = { ...project, deadline: dl };
        } catch {
          // Non-fatal — the project exists; the deadline just didn't stick.
        }
      }
      reset();
      props.onCreated(project);
    } catch (e) {
      setErr(describeIpcError(e));
      setSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      reset();
      props.onClose();
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={handleOpenChange}
      title="New project"
      description="Pick a format. Typeward creates a folder under your projects root with a starter file."
      widthClass="w-[560px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={submitting()}
          >
            {submitting() ? "Creating..." : "Create"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-glass-stroke px-3 py-2">
          <span class="text-xs text-fg-3">Or start from:</span>
          <Button variant="ghost" size="sm" onClick={() => setGalleryOpen(true)}>
            Template
          </Button>
          <span class="text-xs text-fg-3">·</span>
          <Button variant="ghost" size="sm" onClick={() => setCloneOpen(true)}>
            Clone repository
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void importOverleafZip()}>
            Overleaf zip
          </Button>
        </div>

        <Show when={cloudAccounts().length > 0}>
          <fieldset class="flex flex-col gap-2">
            <legend class="text-sm font-medium text-fg-2">
              Where
            </legend>
            <div class="grid grid-cols-2 gap-2">
              <For each={[{ id: "local" as const, label: "Local", sub: "Folder under your projects root" }, { id: "cloud" as const, label: "Cloud", sub: "Sync with a connected provider" }]}>
                {(opt) => (
                  <label
                    class={`lift flex items-start gap-2.5 rounded-md border p-2.5 ${
                      location() === opt.id
                        ? "border-transparent bg-[var(--color-selection-bg)] shadow-[0_0_0_1.5px_var(--color-accent-1)]"
                        : "border-glass-stroke hover:bg-[var(--color-control-fill)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="location"
                      value={opt.id}
                      checked={location() === opt.id}
                      onChange={() => setLocation(opt.id)}
                      class="mt-1 h-3 w-3 accent-[var(--color-accent-1)]"
                    />
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="text-sm font-medium text-fg-1">
                        {opt.label}
                      </span>
                      <span class="text-xs text-fg-3">{opt.sub}</span>
                    </div>
                  </label>
                )}
              </For>
            </div>
          </fieldset>
        </Show>

        <Show when={location() === "cloud"}>
          <fieldset class="flex flex-col gap-2">
            <legend class="text-sm font-medium text-fg-2">
              Account
            </legend>
            <div class="flex flex-col gap-1">
              <For each={cloudAccounts()}>
                {(acc) => (
                  <label
                    class={`lift flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 ${
                      account()?.accountId === acc.accountId &&
                      account()?.provider === acc.provider
                        ? "border-transparent bg-[var(--color-selection-bg)] shadow-[0_0_0_1.5px_var(--color-accent-1)]"
                        : "border-glass-stroke hover:bg-[var(--color-control-fill)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="cloud-account"
                      checked={
                        account()?.accountId === acc.accountId &&
                        account()?.provider === acc.provider
                      }
                      onChange={() => {
                        setAccount(acc);
                        setRemoteRoot(null);
                      }}
                      class="h-3 w-3 accent-[var(--color-accent-1)]"
                    />
                    <span class="mono text-xs uppercase tracking-wider text-fg-3">
                      {acc.provider}
                    </span>
                    <span class="text-sm text-fg-1">
                      {acc.label ?? acc.accountId}
                    </span>
                  </label>
                )}
              </For>
            </div>
          </fieldset>
        </Show>

        <Show when={location() === "cloud" && account()}>
          <fieldset class="flex flex-col gap-2">
            <legend class="text-sm font-medium text-fg-2">
              Remote folder
            </legend>
            <Show
              when={!remoteRoots.loading}
              fallback={
                <div class="text-xs text-fg-3">Loading remote folders…</div>
              }
            >
              <Show
                when={(remoteRoots() ?? []).length > 0}
                fallback={
                  <div class="text-xs text-fg-3">
                    No folders found. Create one in the provider's web UI, then
                    come back.
                  </div>
                }
              >
                <div class="max-h-40 overflow-auto scroll rounded-md border border-glass-stroke">
                  <For each={remoteRoots() ?? []}>
                    {(folder) => (
                      <label
                        class={`flex items-center gap-2 border-b border-glass-stroke px-2.5 py-1.5 last:border-b-0 ${
                          remoteRoot()?.id === folder.id
                            ? "bg-[var(--color-selection-bg)]"
                            : "hover:bg-[var(--color-control-fill)]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="remote-root"
                          checked={remoteRoot()?.id === folder.id}
                          onChange={() => {
                            setRemoteRoot(folder);
                            if (!name().trim()) setName(folder.name);
                          }}
                          class="h-3 w-3 accent-[var(--color-accent-1)]"
                        />
                        <span class="text-sm text-fg-1">
                          {folder.name}
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </fieldset>
        </Show>

        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-fg-2">
            Name
          </span>
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing && !submitting()) void submit();
            }}
            placeholder="My thesis"
            class="glass-inset rounded-md px-3 py-2 text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-fg-2">
            Deadline <span class="text-xs font-normal text-fg-3">(optional)</span>
          </span>
          <input
            type="date"
            value={deadlineInput()}
            onInput={(e) => setDeadlineInput(e.currentTarget.value)}
            class="glass-inset w-fit rounded-md px-3 py-2 text-sm text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
        </label>

        <fieldset class="flex flex-col gap-2">
          <legend class="text-sm font-medium text-fg-2">
            Format
          </legend>
          <div class="grid grid-cols-2 gap-2">
            <For each={FORMATS}>
              {(f) => (
                <label
                  class={`lift flex items-start gap-2.5 rounded-md border p-2.5 ${
                    format() === f.id
                      ? "border-transparent bg-[var(--color-selection-bg)] shadow-[0_0_0_1.5px_var(--color-accent-1)]"
                      : "border-glass-stroke hover:bg-[var(--color-control-fill)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="format"
                    value={f.id}
                    checked={format() === f.id}
                    onChange={() => setFormat(f.id)}
                    class="mt-1 h-3 w-3 accent-[var(--color-accent-1)]"
                  />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="text-sm font-medium text-fg-1">
                      {f.label}
                    </span>
                    <span class="text-xs text-fg-3">{f.sub}</span>
                  </div>
                </label>
              )}
            </For>
          </div>
        </fieldset>

        <Show when={err()}>
          <div class="select-text text-sm text-[var(--color-err)]">
            {err()}
          </div>
        </Show>
      </div>
      <CloneDialog
        open={cloneOpen()}
        onOpenChange={setCloneOpen}
        onCloned={() => {
          reset();
          props.onClose();
        }}
      />
      <TemplateGallery
        open={galleryOpen()}
        onOpenChange={setGalleryOpen}
        onCreated={(project) => {
          reset();
          props.onCreated(project);
        }}
      />
    </Dialog>
  );
};

function inferNameFromPath(absPath: string): string {
  const trimmed = absPath.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
  return base.replace(/\.zip$/i, "");
}
