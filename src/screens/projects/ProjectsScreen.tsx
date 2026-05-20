import { useNavigate } from "@solidjs/router";
import {
  Archive,
  BookMarked,
  ChevronDown,
  Clock,
  Compass,
  FlaskConical,
  Folder as FolderIcon,
  FolderOpen,
  GitBranch,
  GraduationCap,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Star,
  Tag,
  Trash,
  Upload,
  Users,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import type { Project, ProjectFormat } from "~/adapters/types";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { TopBar } from "~/components/layout/TopBar";
import { Dialog } from "~/components/primitives/Dialog";
import { Button } from "~/components/primitives/Button";
import { KbdHint } from "~/components/primitives/KbdHint";
import { ComposerHero } from "~/components/projects/ComposerHero";
import { NotificationsPanel } from "~/components/projects/NotificationsPanel";
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
} from "~/stores/projects-store";
import { setPreviousRoute } from "~/stores/nav-store";
import {
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  type ProjectsSort,
  type ProjectsView,
  setDefaultSort,
  setDefaultView,
} from "~/stores/workspace-store";
import { WidgetsMenu } from "~/widgets/WidgetsMenu";
import { WidgetsShelf } from "~/widgets/WidgetsShelf";

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
  "last-opened": "Last opened",
  created: "Created",
  name: "Name",
  modified: "Modified",
  format: "Format",
};

// =================================================================
// Screen root
// =================================================================

const ProjectsScreen: Component = () => {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [notifOpen, setNotifOpen] = createSignal(notificationsPanelDefault());

  onMount(() => {
    void refresh();
  });

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
      case "format":
        return list.sort((a, b) => a.format.localeCompare(b.format));
      // The disk metadata doesn't carry created/modified/last-opened
      // yet, so these fall back to insertion order from the Rust listing.
      default:
        return list;
    }
  });

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />

      <div class="relative z-10 flex h-full flex-col">
        <TopBar
          notifications={0}
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
            totalCount={projects().length}
          />

          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <ComposerHero
              onCompose={() => setDialogOpen(true)}
              onOpenProject={(p) =>
                navigate(`/editor?path=${encodeURIComponent(p)}`)
              }
            />
            <Toolbar />
            <WidgetsShelf />

            <div class="mt-1 flex-1 overflow-auto scroll px-1 pb-2">
              <Show when={projectsError()}>
                <div class="mb-3 rounded-lg border border-[var(--color-err)]/30 p-3 text-[length:var(--ui-font-sm)] text-[var(--color-err)]">
                  Failed to list projects: {projectsError()}
                </div>
              </Show>
              <Show
                when={!loading() || projects().length > 0}
                fallback={
                  <div class="py-10 text-center text-[length:var(--ui-font-sm)] text-fg-3">
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
                <div class="mono py-6 text-center text-[11px] text-fg-4">
                  — end of {projects().length} project{projects().length === 1 ? "" : "s"} —
                </div>
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

const Sidebar: Component<{ onNewProject: () => void; totalCount: number }> = (
  props,
) => {
  const librarySection = (): SidebarItem[] => [
    { id: "all", label: "All projects", icon: FolderIcon, count: props.totalCount, active: true },
    { id: "recent", label: "Recently opened", icon: Clock },
    { id: "starred", label: "Starred", icon: Star },
    { id: "shared", label: "Shared with me", icon: Users },
    { id: "archive", label: "Archive", icon: Archive },
    { id: "trash", label: "Trash", icon: Trash },
  ];

  const spacesSection = (): SidebarItem[] => [
    { id: "sp1", label: "Stochastic Lab", icon: FlaskConical, dot: "#8B5CF6" },
    { id: "sp2", label: "Thesis 2026", icon: GraduationCap, dot: "#22D3EE" },
    { id: "sp3", label: "Conference Drafts", icon: Compass, dot: "#F59E0B" },
    { id: "sp4", label: "Reading group", icon: BookMarked, dot: "#10B981" },
  ];

  const tagsSection = (): SidebarItem[] => [
    { id: "t1", label: "icml-2026", icon: Tag, tint: "#A78BFA" },
    { id: "t2", label: "neurips-2025", icon: Tag, tint: "#67E8F9" },
    { id: "t3", label: "in-review", icon: Tag, tint: "#FBBF24" },
    { id: "t4", label: "archived", icon: Tag, tint: "#9CA3AF" },
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
          class="lift glow-violet relative flex h-9 w-full items-center justify-center gap-2 rounded-lg accent-grad text-[length:var(--ui-font-sm)] font-semibold text-white"
        >
          <Plus size={14} stroke-width={2.4} />
          <span>New project</span>
          <span class="ml-1">
            <KbdHint shortcut="Mod+N" size="md" tone="dark" />
          </span>
        </button>
        <div class="mt-2 grid grid-cols-1 gap-1.5">
          <SidebarMiniButton icon={<Upload size={11} style={{ opacity: 0.7 }} />}>
            Import
          </SidebarMiniButton>
        </div>
      </div>

      <div class="flex-1 space-y-3.5 overflow-auto scroll p-2">
        <SidebarGroup label="Library" items={librarySection()} />
        <Show when={enableSpaces()}>
          <SidebarGroup label="Spaces" items={spacesSection()} hasAdd />
        </Show>
        <Show when={enableTags()}>
          <SidebarGroup label="Tags" items={tagsSection()} />
        </Show>
      </div>

      {/* Subscription footer — Storage info removed (premature; lands with cloud sync) */}
      <div class="border-t border-glass-stroke p-3">
        <button
          type="button"
          class="lift glass-soft flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-[length:var(--ui-font-xs)] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
        >
          <span class="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-accent-1)" }} />
          <span>Free plan</span>
          <span class="mono text-fg-4">·</span>
          <span class="text-fg-3">Upgrade</span>
        </button>
      </div>
    </div>
  );
};

const SidebarGroup: Component<{
  label: string;
  items: SidebarItem[];
  hasAdd?: boolean;
}> = (props) => (
  <div>
    <div class="label-xs mb-1.5 flex items-center justify-between px-2 text-fg-3">
      <span>{props.label}</span>
      <Show when={props.hasAdd}>
        <button
          type="button"
          class="flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
        >
          <Plus size={10} style={{ opacity: 0.6 }} />
        </button>
      </Show>
    </div>
    <For each={props.items}>
      {(item) => (
        <button
          type="button"
          class={`lift relative flex w-full items-center gap-2 rounded-md px-2 text-[length:var(--ui-font-base)] ${
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
            <span class="mono ml-auto text-[length:var(--ui-font-xs)] text-fg-3">{item.count}</span>
          </Show>
        </button>
      )}
    </For>
  </div>
);

const SidebarMiniButton: Component<{
  icon: JSX.Element;
  children: JSX.Element;
}> = (props) => (
  <button
    type="button"
    class="lift glass-soft flex items-center justify-center gap-1.5 rounded-md text-[length:var(--ui-font-xs)] text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
    style={{ height: "var(--ui-row-sm)" }}
  >
    {props.icon}
    <span>{props.children}</span>
  </button>
);

// =================================================================
// Toolbar — Widgets / Sort / View
// =================================================================

const Toolbar: Component = () => {
  const [sortOpen, setSortOpen] = createSignal(false);
  return (
    <div class="flex items-center gap-2 px-1 pt-1">
      <WidgetsMenu />

      <div class="ml-auto flex items-center gap-1.5">
        <div class="relative">
          <button
            type="button"
            onClick={() => setSortOpen((v) => !v)}
            class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[length:var(--ui-font-xs)] text-fg-2 hover:bg-[var(--color-control-fill)]"
          >
            <span>
              Sort: <span class="text-fg-1">{SORT_LABEL[defaultSort()]}</span>
            </span>
            <ChevronDown size={10} style={{ opacity: 0.5 }} />
          </button>
          <Show when={sortOpen()}>
            <div
              class="glass absolute right-0 top-full z-30 mt-1 w-[180px] rounded-lg"
              style={{ padding: "6px", background: "var(--color-popover-bg)" }}
              onMouseLeave={() => setSortOpen(false)}
            >
              <For each={Object.keys(SORT_LABEL) as ProjectsSort[]}>
                {(key) => {
                  const active = () => defaultSort() === key;
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        setDefaultSort(key);
                        setSortOpen(false);
                      }}
                      class={`lift flex w-full items-center justify-between rounded-md px-2.5 text-left text-[length:var(--ui-font-sm)] ${
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
      <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">New project</span>
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
    <div class="glow-violet flex h-12 w-12 items-center justify-center rounded-2xl accent-grad">
      <Plus size={18} stroke-width={2.4} />
    </div>
    <div class="text-center">
      <div class="text-[length:var(--ui-font-base)] font-semibold text-fg-1">
        New project
      </div>
      <div class="mt-0.5 text-[length:var(--ui-font-xs)] text-fg-3">
        template, import, or compose
      </div>
    </div>
    <KbdHint shortcut="Mod+N" size="sm" />
  </button>
);

const ProjectCard: Component<{ project: Project; onOpen: () => void }> = (props) => {
  const accentColor = FORMAT_ACCENT[props.project.format];
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="card-glow group flex flex-col gap-2 rounded-xl text-left"
      style={{
        height: "180px",
        background: "var(--color-card-bg)",
        padding: "var(--ui-pad-card)",
      }}
    >
      <div class="flex items-center justify-between">
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
        <div class="flex items-center gap-1">
          <span
            class="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
            title="Star"
          >
            <Star size={11} class="text-fg-3" />
          </span>
          <span
            class="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
          >
            <MoreHorizontal size={11} class="text-fg-3" />
          </span>
        </div>
      </div>

      <div
        class="mt-1 flex-1 text-[length:var(--ui-font-base)] font-semibold leading-snug text-fg-1"
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

      <div class="mono flex items-center justify-between text-[11px] text-fg-3">
        <span class="flex items-center gap-1.5">
          <FolderOpen size={10} style={{ opacity: 0.6 }} />
          <span class="truncate" style={{ "max-width": "120px" }}>
            {props.project.rootFile}
          </span>
        </span>
        <span class="flex items-center gap-1">
          <GitBranch size={10} style={{ opacity: 0.6 }} />
          main
        </span>
      </div>
    </button>
  );
};

const ProjectRow: Component<{ project: Project; onOpen: () => void }> = (props) => {
  const accentColor = FORMAT_ACCENT[props.project.format];
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="card-glow flex items-center gap-3 rounded-md px-3 text-left"
      style={{
        height: "var(--ui-row-lg)",
        background: "var(--color-card-bg)",
      }}
    >
      <span
        class="h-2 w-2 rounded-full"
        style={{ background: accentColor }}
      />
      <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
        {props.project.name}
      </span>
      <span class="mono text-[11px] text-fg-3">
        {FORMAT_LABEL[props.project.format]}
      </span>
      <span class="mono ml-auto truncate text-[11px] text-fg-3" style={{ "max-width": "180px" }}>
        {props.project.rootFile}
      </span>
    </button>
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
  const [submitting, setSubmitting] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const reset = () => {
    setName("");
    setFormat("latex");
    setErr(null);
    setSubmitting(false);
  };

  const submit = async () => {
    if (!name().trim()) {
      setErr("Name is required");
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const project = await create({ name: name().trim(), format: format() });
      reset();
      props.onCreated(project);
    } catch (e) {
      setErr(String(e));
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
        <label class="flex flex-col gap-1.5">
          <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-2">
            Name
          </span>
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="My thesis"
            class="glass-inset rounded-md px-3 py-2 text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-4 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-1)]"
          />
        </label>

        <fieldset class="flex flex-col gap-2">
          <legend class="text-[length:var(--ui-font-sm)] font-medium text-fg-2">
            Format
          </legend>
          <div class="grid grid-cols-2 gap-2">
            <For each={FORMATS}>
              {(f) => (
                <label
                  class={`lift flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 ${
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
                    <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                      {f.label}
                    </span>
                    <span class="text-[11px] text-fg-3">{f.sub}</span>
                  </div>
                </label>
              )}
            </For>
          </div>
        </fieldset>

        <Show when={err()}>
          <div class="text-[length:var(--ui-font-sm)] text-[var(--color-err)]">
            {err()}
          </div>
        </Show>
      </div>
    </Dialog>
  );
};
