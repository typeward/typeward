import { describeIpcError } from "~/lib/errors";
import { useNavigate } from "@solidjs/router";
import {
  CalendarClock,
  Cloud,
  FileText,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Plus,
  SearchX,
  Trash2,
  Users,
  X,
} from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";
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
import type { SpaceDef } from "~/ipc";
import { integrationsSettings, projectsRoot } from "~/stores/settings-store";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { TopBar } from "~/components/layout/TopBar";
import { Dialog } from "~/components/primitives/Dialog";
import { Button } from "~/components/primitives/Button";
import { KbdHint } from "~/components/primitives/KbdHint";
import { NotificationsPanel, unreadCount } from "~/components/projects/NotificationsPanel";
import { LibrarySidebar } from "~/components/projects/LibrarySidebar";
import { LibraryViewControls } from "~/components/projects/LibraryViewControls";
import { ProjectMenu } from "~/components/projects/ProjectMenu";
import { TagEditorPopover } from "~/components/projects/TagEditorPopover";
import type { LibrarySelection } from "~/components/projects/library-selection";
import { tagTint, tintColor } from "~/components/projects/tints";
import { dismissBootSplash } from "~/lib/boot-splash";
import { installDismiss } from "~/lib/dismiss";
import { notifyError, notifySuccess } from "~/lib/toast";
import { absoluteStamp, relativeTime } from "~/lib/time";
import { openPalette } from "~/commands/actions";
import {
  requestNewProject_,
  setRequestNewProject,
} from "~/commands/palette-store";
import {
  create,
  duplicate,
  error as projectsError,
  isShared,
  isTrashed,
  isYours,
  loading,
  projects,
  refresh,
  remove,
  rename,
  setDeadline,
  setTrashed,
} from "~/stores/projects-store";
import {
  DEADLINE_TONE_COLOR,
  deadlineStatus,
} from "~/lib/deadlines";
import { project as editorProject, setProject } from "~/stores/editor-store";
import { setPreviousRoute } from "~/stores/nav-store";
import {
  defaultSort,
  defaultView,
  notificationsPanelDefault,
  projectCardWords,
  spaces,
} from "~/stores/workspace-store";

// =================================================================
// Display metadata helpers
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

// =================================================================
// Screen root
// =================================================================

const ProjectsScreen: Component = () => {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [notifOpen, setNotifOpen] = createSignal(notificationsPanelDefault());
  const [importError, setImportError] = createSignal<string | null>(null);

  // Session-scoped library filter + search (reset on revisit, matching the
  // palette / focus-mode precedent).
  const [selection, setSelection] = createSignal<LibrarySelection>({ kind: "all" });
  const [search, setSearch] = createSignal("");

  // Deleting a space (or a persisted selection pointing at a since-removed one)
  // would otherwise strand the filter on an id with no sidebar row and, if the
  // space had members, silently show a subset with no escape — reset to All.
  createEffect(() => {
    const sel = selection();
    if (sel.kind === "space" && !spaces().some((s) => s.id === sel.id)) {
      setSelection({ kind: "all" });
    }
  });

  // Context menu, tag editor, and the rename/duplicate/delete dialogs are all
  // driven from screen-level signals so a single instance serves every card.
  const [menu, setMenu] =
    createSignal<{ project: Project; x: number; y: number } | null>(null);
  const [tagEditor, setTagEditor] =
    createSignal<{ project: Project; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = createSignal<Project | null>(null);
  const [duplicateTarget, setDuplicateTarget] = createSignal<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<Project | null>(null);
  const [restoreTarget, setRestoreTarget] = createSignal<Project | null>(null);

  onMount(() => {
    dismissBootSplash();
    // AppShell prefetches the library as soon as settings resolve — don't
    // stack a second list_projects on top of one already in flight.
    if (!loading()) void refresh();
  });

  // Import an EXISTING folder (a manually-copied repo / unzipped project) as a
  // Typeward project — distinct from "New project", which scaffolds a starter.
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

  // A trashed project can't be opened — clicking one prompts to restore first.
  const handleOpen = (project: Project) => {
    if (isTrashed(project)) setRestoreTarget(project);
    else openProject(project);
  };

  // Soft-trash / restore route through the store; when the trashed project is
  // the one currently open, tear the editor runtime (and its cloud engine) down.
  const trashProject = async (p: Project) => {
    try {
      await setTrashed(p.rootPath, true);
      if (editorProject()?.rootPath === p.rootPath) setProject(null);
      notifySuccess("Moved to trash", p.name);
    } catch (e) {
      notifyError(describeIpcError(e));
    }
  };
  const restoreProject = async (p: Project) => {
    try {
      await setTrashed(p.rootPath, false);
    } catch (e) {
      notifyError(describeIpcError(e));
    }
  };

  // Known tags across the whole library — feeds the tag-editor suggestions.
  // Trashed projects are excluded so restoring is the only way their tags
  // re-surface as suggestions.
  const knownTags = createMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of projects()) {
      if (isTrashed(p)) continue;
      for (const t of p.tags ?? []) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  });

  const untrashedCount = createMemo(
    () => projects().filter((p) => !isTrashed(p)).length,
  );

  // Single filter → search → sort pipeline replacing the old sortedProjects.
  const visibleProjects = createMemo<Project[]>(() => {
    const sel = selection();
    const q = search().trim().toLowerCase();

    // 0. Trash split — Trashed shows only trashed; every other view excludes it.
    let list = projects().filter((p) => isTrashed(p) === (sel.kind === "trash"));

    // 1. Archive split (non-trash views only) — Archived shows only archived;
    //    every other non-trash view excludes archived.
    if (sel.kind !== "trash")
      list = list.filter((p) => !!p.archived === (sel.kind === "archive"));

    // 2. Selection filter.
    if (sel.kind === "yours") list = list.filter(isYours);
    else if (sel.kind === "shared") list = list.filter(isShared);
    else if (sel.kind === "space") list = list.filter((p) => p.space === sel.id);
    else if (sel.kind === "tag")
      list = list.filter((p) => p.tags?.includes(sel.tag));

    // 3. Search — case-insensitive over name, rootFile, tags.
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.rootFile.toLowerCase().includes(q) ||
          (p.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    }

    // 4. Sort.
    const sorted = [...list];
    switch (defaultSort()) {
      case "name":
        return sorted.sort((a, b) => a.name.localeCompare(b.name));
      case "name-desc":
        return sorted.sort((a, b) => b.name.localeCompare(a.name));
      case "format":
        return sorted.sort(
          (a, b) =>
            a.format.localeCompare(b.format) || a.name.localeCompare(b.name),
        );
      case "created":
        return sorted.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      case "modified":
        return sorted.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
      case "deadline":
        return sorted.sort((a, b) => {
          const da = a.deadline ? Date.parse(a.deadline) : Number.POSITIVE_INFINITY;
          const db = b.deadline ? Date.parse(b.deadline) : Number.POSITIVE_INFINITY;
          return da - db || a.name.localeCompare(b.name);
        });
      case "last-opened":
      default:
        // Most-recently-opened first; never-opened projects sink to the bottom.
        return sorted.sort((a, b) => {
          const ta = a.lastOpenedAt ?? Number.NEGATIVE_INFINITY;
          const tb = b.lastOpenedAt ?? Number.NEGATIVE_INFINITY;
          return tb - ta || a.name.localeCompare(b.name);
        });
    }
  });

  const filtersActive = () =>
    selection().kind !== "all" || search().trim() !== "";

  // Which empty state (if any) to render in place of the grid/list. Shared is
  // always empty today (dedicated coming-soon state); trash falls back to the
  // filter state when a search is active so "Clear filters" stays reachable.
  const emptyMode = (): "none" | "filter" | "shared" | "trash" => {
    const sel = selection();
    if (sel.kind === "shared") return "shared";
    if (visibleProjects().length > 0) return "none";
    if (sel.kind === "trash") return search().trim() !== "" ? "filter" : "trash";
    return filtersActive() ? "filter" : "none";
  };

  const clearFilters = () => {
    setSelection({ kind: "all" });
    setSearch("");
  };

  const openMenu = (project: Project, x: number, y: number) =>
    setMenu({ project, x, y });

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />

      <div class="relative z-10 flex h-full flex-col">
        <TopBar
          notifications={unreadCount()}
          search={{ value: search(), onInput: setSearch }}
          onOpenPalette={() => openPalette()}
          onToggleNotifications={() => setNotifOpen((v) => !v)}
          onOpenSettings={() => {
            setPreviousRoute("/projects");
            navigate("/settings");
          }}
        />

        <div class="relative flex min-h-0 flex-1 gap-2 p-2">
          <LibrarySidebar
            projects={projects()}
            selection={selection()}
            onSelect={setSelection}
            onNewProject={() => setDialogOpen(true)}
            onImport={() => void importFolder()}
          />

          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <div class="flex items-end justify-between px-2 pt-3">
              <div>
                <h1 class="text-xl font-semibold tracking-tight text-fg-1">
                  Library
                </h1>
                <div class="mono mt-0.5 text-xs text-fg-3">
                  {untrashedCount()} project{untrashedCount() === 1 ? "" : "s"} ·
                  local-first
                </div>
              </div>
              <LibraryViewControls />
            </div>

            <div class="mt-2 flex-1 overflow-auto scroll px-1 pb-2">
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
                <Switch
                  fallback={
                    <>
                      <Show
                        when={defaultView() === "cards"}
                        fallback={
                          <ProjectList
                            projects={visibleProjects()}
                            showNew={selection().kind !== "trash"}
                            trash={selection().kind === "trash"}
                            onOpen={handleOpen}
                            onNew={() => setDialogOpen(true)}
                            onMenu={openMenu}
                          />
                        }
                      >
                        <ProjectGrid
                          projects={visibleProjects()}
                          showNew={selection().kind !== "trash"}
                          trash={selection().kind === "trash"}
                          onOpen={handleOpen}
                          onNew={() => setDialogOpen(true)}
                          onMenu={openMenu}
                        />
                      </Show>
                      <Show when={visibleProjects().length > 0}>
                        <div class="mono py-6 text-center text-xs text-fg-3">
                          — end of {visibleProjects().length} project
                          {visibleProjects().length === 1 ? "" : "s"} —
                        </div>
                      </Show>
                    </>
                  }
                >
                  <Match when={emptyMode() === "shared"}>
                    <SharedComingSoonState />
                  </Match>
                  <Match when={emptyMode() === "trash"}>
                    <TrashEmptyState />
                  </Match>
                  <Match when={emptyMode() === "filter"}>
                    <EmptyFilterState onClear={clearFilters} />
                  </Match>
                </Switch>
              </Show>
            </div>
          </div>

          <NotificationsPanel open={notifOpen()} onClose={() => setNotifOpen(false)} />
        </div>
      </div>

      <Show when={menu()}>
        {(m) => (
          <ProjectMenu
            project={m().project}
            x={m().x}
            y={m().y}
            spaces={spaces()}
            onClose={() => setMenu(null)}
            onOpen={() => {
              openProject(m().project);
              setMenu(null);
            }}
            onRename={() => {
              setRenameTarget(m().project);
              setMenu(null);
            }}
            onDuplicate={() => {
              setDuplicateTarget(m().project);
              setMenu(null);
            }}
            onDelete={() => {
              setDeleteTarget(m().project);
              setMenu(null);
            }}
            onTrash={() => {
              const p = m().project;
              setMenu(null);
              void trashProject(p);
            }}
            onRestore={() => {
              const p = m().project;
              setMenu(null);
              void restoreProject(p);
            }}
            onEditTags={() => {
              setTagEditor({ project: m().project, x: m().x, y: m().y });
              setMenu(null);
            }}
          />
        )}
      </Show>

      <Show when={tagEditor()}>
        {(t) => (
          <TagEditorPopover
            project={t().project}
            x={t().x}
            y={t().y}
            suggestions={knownTags()}
            onClose={() => setTagEditor(null)}
          />
        )}
      </Show>

      <NameDialog
        open={renameTarget() != null}
        title="Rename project"
        description="Changes the display name only — the folder path is unchanged."
        initial={renameTarget()?.name ?? ""}
        confirmLabel="Rename"
        onClose={() => setRenameTarget(null)}
        onSubmit={(name) => rename(renameTarget()!.rootPath, name)}
      />

      <NameDialog
        open={duplicateTarget() != null}
        title="Duplicate project"
        description="Copies the project into a new folder under your projects root."
        initial={duplicateTarget() ? `${duplicateTarget()!.name} copy` : ""}
        confirmLabel="Duplicate"
        onClose={() => setDuplicateTarget(null)}
        onSubmit={async (name) => {
          await duplicate(duplicateTarget()!.rootPath, name);
        }}
      />

      <RestorePromptDialog
        project={restoreTarget()}
        onClose={() => setRestoreTarget(null)}
        onRestoreOpen={async (p) => {
          await setTrashed(p.rootPath, false);
          openProject(p);
        }}
      />

      <DeleteConfirmDialog
        project={deleteTarget()}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async (p) => {
          await remove(p.rootPath);
          if (editorProject()?.rootPath === p.rootPath) setProject(null);
        }}
      />

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
// Empty filter state
// =================================================================

const EmptyFilterState: Component<{ onClear: () => void }> = (props) => (
  <div class="flex flex-col items-center gap-3 py-16 text-center">
    <div
      class="flex h-12 w-12 items-center justify-center rounded-2xl"
      style={{ background: "var(--color-control-fill)" }}
    >
      <SearchX size={20} class="text-fg-3" />
    </div>
    <div>
      <div class="text-base font-semibold text-fg-1">No projects match</div>
      <div class="mt-0.5 text-sm text-fg-3">
        Nothing here for the current filter and search.
      </div>
    </div>
    <Button variant="secondary" size="sm" onClick={props.onClear}>
      Clear filters
    </Button>
  </div>
);

const SharedComingSoonState: Component = () => (
  <div class="flex flex-col items-center gap-3 py-16 text-center">
    <div
      class="flex h-12 w-12 items-center justify-center rounded-2xl"
      style={{ background: "var(--color-control-fill)" }}
    >
      <Users size={20} class="text-fg-3" />
    </div>
    <div>
      <div class="text-base font-semibold text-fg-1">
        Nothing shared with you yet
      </div>
      <div class="mt-0.5 text-sm text-fg-3">
        Sharing and collaboration are coming soon.
      </div>
    </div>
  </div>
);

const TrashEmptyState: Component = () => (
  <div class="flex flex-col items-center gap-3 py-16 text-center">
    <div
      class="flex h-12 w-12 items-center justify-center rounded-2xl"
      style={{ background: "var(--color-control-fill)" }}
    >
      <Trash2 size={20} class="text-fg-3" />
    </div>
    <div>
      <div class="text-base font-semibold text-fg-1">Trash is empty</div>
      <div class="mt-0.5 text-sm text-fg-3">
        Projects you move to the trash can be restored or deleted permanently.
      </div>
    </div>
  </div>
);

// =================================================================
// Project grid / list / cards
// =================================================================

interface CardCollectionProps {
  projects: Project[];
  /** Render the New-project affordance (suppressed in the trash view). */
  showNew: boolean;
  /** Trash view — cards/rows dim, hide the deadline editor, and swap the
   *  modified line for "Trashed …". */
  trash: boolean;
  onOpen: (p: Project) => void;
  onNew: () => void;
  onMenu: (p: Project, x: number, y: number) => void;
}

const ProjectGrid: Component<CardCollectionProps> = (props) => (
  <div
    class="grid gap-3"
    style={{
      "grid-template-columns": "repeat(auto-fill, minmax(240px, 1fr))",
      "grid-auto-rows": "min-content",
    }}
  >
    <Show when={props.showNew}>
      <NewProjectTile onClick={props.onNew} />
    </Show>
    <For each={props.projects}>
      {(p) => (
        <ProjectCard
          project={p}
          trash={props.trash}
          onOpen={() => props.onOpen(p)}
          onMenu={(x, y) => props.onMenu(p, x, y)}
        />
      )}
    </For>
  </div>
);

const ProjectList: Component<CardCollectionProps> = (props) => (
  <div class="flex flex-col gap-1.5">
    <Show when={props.showNew}>
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
        <span class="flex h-6 w-6 items-center justify-center rounded-md accent-grad">
          <Plus size={13} stroke-width={2.4} />
        </span>
        <span class="text-sm font-medium text-fg-1">New project</span>
        <span class="ml-auto">
          <KbdHint shortcut="Mod+N" size="sm" />
        </span>
      </button>
    </Show>
    <For each={props.projects}>
      {(p) => (
        <ProjectRow
          project={p}
          trash={props.trash}
          onOpen={() => props.onOpen(p)}
          onMenu={(x, y) => props.onMenu(p, x, y)}
        />
      )}
    </For>
  </div>
);

const NewProjectTile: Component<{ onClick: () => void }> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class="card-glow flex flex-col items-start justify-between overflow-hidden rounded-xl text-left"
    style={{
      height: "180px",
      background: "var(--color-card-bg-soft)",
      border: "1.5px dashed var(--color-glass-stroke-strong)",
      padding: "var(--ui-pad-card)",
    }}
  >
    <div class="glow-accent flex h-7 w-7 items-center justify-center rounded-md accent-grad">
      <Plus size={16} stroke-width={2.4} />
    </div>
    <div>
      <div class="text-base font-semibold text-fg-1">New project</div>
      <div class="mt-0.5 text-xs text-fg-3">template, import, or compose</div>
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

/** Resolve a project's space to its catalog entry (for the tint bar + title). */
const spaceOf = (p: Project): SpaceDef | undefined =>
  p.space ? spaces().find((s) => s.id === p.space) : undefined;

/** Cloud + git presence chips, shown inline in the card/row footer. */
const SyncChips: Component<{ project: Project }> = (props) => {
  const cloud = () => props.project.integrations?.cloudOrigin;
  const git = () => props.project.integrations?.git;
  return (
    <>
      <Show when={cloud()}>
        {(c) => (
          <span
            class="flex flex-shrink-0 items-center text-fg-3"
            title={`Synced · ${c().provider}`}
          >
            <Cloud size={11} />
          </span>
        )}
      </Show>
      <Show when={git()}>
        {(g) => (
          <span
            class="flex flex-shrink-0 items-center text-fg-3"
            title={`Git repository${g().branch ? ` · ${g().branch}` : ""}`}
          >
            <GitBranch size={11} />
          </span>
        )}
      </Show>
    </>
  );
};

/** Full created/modified/last-opened stamps for a card/row title attribute. */
function metaTitle(p: Project): string {
  const parts: string[] = [];
  if (p.createdAt != null) parts.push(`Created ${absoluteStamp(p.createdAt)}`);
  if (p.modifiedAt != null) parts.push(`Modified ${absoluteStamp(p.modifiedAt)}`);
  if (p.lastOpenedAt != null)
    parts.push(`Last opened ${absoluteStamp(p.lastOpenedAt)}`);
  return parts.join(" · ");
}

const OverflowButton: Component<{ onOpen: (x: number, y: number) => void }> = (
  props,
) => (
  <button
    type="button"
    aria-label="Project options"
    onClick={(e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      props.onOpen(r.left, r.bottom + 4);
    }}
    class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
  >
    <MoreHorizontal size={14} />
  </button>
);

const ArchivedChip: Component = () => (
  <span
    class="mono rounded px-1.5 py-0.5 text-[10px] text-fg-3"
    style={{ background: "var(--color-control-fill)" }}
  >
    Archived
  </span>
);

const TagChip: Component<{ tag: string }> = (props) => (
  <span
    class="mono flex items-center gap-1 rounded px-1 py-0.5 text-[9px] text-fg-3"
    style={{ background: "var(--color-control-fill)" }}
  >
    <span
      class="h-1 w-1 rounded-full"
      style={{ background: tagTint(props.tag) }}
    />
    <span class="max-w-[72px] truncate">{props.tag}</span>
  </span>
);

interface CardProps {
  project: Project;
  trash: boolean;
  onOpen: () => void;
  onMenu: (x: number, y: number) => void;
}

const ProjectCard: Component<CardProps> = (props) => {
  const accentColor = FORMAT_ACCENT[props.project.format];
  const tags = () => props.project.tags ?? [];
  const space = () => spaceOf(props.project);
  const cardTitle = () => {
    const s = space();
    const meta = metaTitle(props.project);
    return [s ? `Space: ${s.name}` : "", meta].filter(Boolean).join(" · ");
  };
  return (
    <div
      role="button"
      tabindex={0}
      title={cardTitle() || undefined}
      onClick={props.onOpen}
      onKeyDown={openOnKey(props.onOpen)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      class={`card-glow group relative flex flex-col gap-2 overflow-hidden rounded-xl text-left ${
        props.project.archived || props.trash ? "opacity-60" : ""
      }`}
      style={{
        height: "180px",
        background: "var(--color-card-bg)",
        padding: "var(--ui-pad-card)",
      }}
    >
      <Show when={space()}>
        {(s) => (
          <span
            class="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
            style={{ background: tintColor(s().tint) }}
          />
        )}
      </Show>
      <div class="flex items-center gap-2">
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
        <Show when={props.project.archived}>
          <ArchivedChip />
        </Show>
        <div class="ml-auto flex items-center gap-0.5">
          <Show when={!props.trash}>
            <DeadlineEditor
              deadline={props.project.deadline}
              onChange={(d) => void setDeadline(props.project.rootPath, d)}
            />
          </Show>
          <OverflowButton onOpen={props.onMenu} />
        </div>
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

      <Show when={tags().length > 0}>
        <div class="flex flex-wrap items-center gap-1">
          <For each={tags().slice(0, 3)}>{(t) => <TagChip tag={t} />}</For>
          <Show when={tags().length > 3}>
            <span class="mono text-[9px] text-fg-2">+{tags().length - 3}</span>
          </Show>
        </div>
      </Show>

      <div class="mono flex flex-col gap-0.5 text-xs text-fg-3">
        <div class="flex items-center justify-between gap-2">
          <span class="flex min-w-0 items-center gap-1.5">
            <FolderOpen size={10} style={{ opacity: 0.6 }} />
            <span class="truncate">{props.project.rootFile}</span>
            <SyncChips project={props.project} />
          </span>
          <ProjectWordCount project={props.project} />
        </div>
        <div class="truncate">
          <Show
            when={props.trash}
            fallback={
              <Show when={props.project.modifiedAt != null}>
                Modified {relativeTime(props.project.modifiedAt!)}
              </Show>
            }
          >
            <Show when={props.project.trashedAt != null}>
              Trashed {relativeTime(props.project.trashedAt!)}
            </Show>
          </Show>
        </div>
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
        class="flex flex-shrink-0 items-center gap-1 text-fg-2"
        title="Approximate words in the root file"
      >
        <FileText size={9} style={{ opacity: 0.6 }} />
        {count()!.toLocaleString()}w
      </span>
    </Show>
  );
};

function approxWordCount(text: string, format: ProjectFormat): number {
  let t = stripMarkupForWordCount(text, format);
  t = t.replace(/[{}[\]()\\$&#~^_*=]/g, " ");
  return t.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

const ProjectRow: Component<CardProps> = (props) => {
  const accentColor = FORMAT_ACCENT[props.project.format];
  const tags = () => props.project.tags ?? [];
  const space = () => spaceOf(props.project);
  return (
    <div
      role="button"
      tabindex={0}
      onClick={props.onOpen}
      onKeyDown={openOnKey(props.onOpen)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      class={`card-glow group relative flex items-center gap-3 overflow-hidden rounded-md px-3 text-left ${
        props.project.archived || props.trash ? "opacity-60" : ""
      }`}
      style={{
        height: "var(--ui-row-lg)",
        background: "var(--color-card-bg)",
      }}
    >
      <Show when={space()}>
        {(s) => (
          <span
            class="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
            style={{ background: tintColor(s().tint) }}
          />
        )}
      </Show>
      <span
        class="h-2 w-2 flex-shrink-0 rounded-full"
        style={{ background: accentColor }}
      />
      <span class="min-w-0 truncate text-sm font-medium text-fg-1">
        {props.project.name}
      </span>
      <Show when={props.project.archived}>
        <ArchivedChip />
      </Show>
      <Show when={tags().length > 0}>
        <div class="hidden items-center gap-1 xl:flex">
          <For each={tags().slice(0, 2)}>{(t) => <TagChip tag={t} />}</For>
          <Show when={tags().length > 2}>
            <span class="mono text-[9px] text-fg-2">+{tags().length - 2}</span>
          </Show>
        </div>
      </Show>
      <span class="mono flex-shrink-0 text-xs text-fg-3">
        {FORMAT_LABEL[props.project.format]}
      </span>
      <span class="mono ml-auto flex flex-shrink-0 items-center gap-2 text-xs text-fg-3">
        <span title={metaTitle(props.project) || undefined}>
          <Show
            when={props.trash}
            fallback={
              <Show when={props.project.modifiedAt != null}>
                Modified {relativeTime(props.project.modifiedAt!)}
              </Show>
            }
          >
            <Show when={props.project.trashedAt != null}>
              Trashed {relativeTime(props.project.trashedAt!)}
            </Show>
          </Show>
        </span>
        <span class="truncate" style={{ "max-width": "180px" }}>
          {props.project.rootFile}
        </span>
        <SyncChips project={props.project} />
        <Show when={!props.trash}>
          <DeadlineEditor
            deadline={props.project.deadline}
            onChange={(d) => void setDeadline(props.project.rootPath, d)}
          />
        </Show>
        <OverflowButton onOpen={props.onMenu} />
      </span>
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
        aria-label={status() ? "Change deadline" : "Set a deadline"}
        onClick={() => setOpen((v) => !v)}
        title={
          status()
            ? `Deadline: ${status()!.label} (${status()!.relative}) — click to change`
            : "Set a deadline"
        }
        class={`flex h-6 w-6 items-center justify-center rounded transition-opacity hover:bg-[var(--color-control-fill)] ${
          status()
            ? ""
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        }`}
        style={{ color: status() ? DEADLINE_TONE_COLOR[status()!.tone] : "var(--color-fg-3)" }}
      >
        <CalendarClock size={13} />
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
// Shared name dialog (rename / duplicate) + delete confirm
// =================================================================

const NameDialog: Component<{
  open: boolean;
  title: string;
  description?: string;
  initial: string;
  confirmLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}> = (props) => {
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  // Seed the field from the target each time the dialog opens; leave it alone
  // while closing so the value doesn't flicker during Kobalte's exit anim.
  createEffect(() => {
    if (props.open) {
      setName(props.initial);
      setErr(null);
      setBusy(false);
    }
  });

  const submit = async () => {
    const n = name().trim();
    if (!n) {
      setErr("Name is required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await props.onSubmit(n);
      props.onClose();
    } catch (e) {
      setErr(describeIpcError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title={props.title}
      description={props.description}
      widthClass="w-[420px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy()}>
            {busy() ? "Working…" : props.confirmLabel}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <input
          type="text"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing && !busy()) void submit();
          }}
          /* eslint-disable-next-line jsx-a11y/no-autofocus */
          autofocus
          class="glass-inset rounded-md px-3 py-2 text-sm text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
        />
        <Show when={err()}>
          <div class="select-text text-sm text-[var(--color-err)]">{err()}</div>
        </Show>
      </div>
    </Dialog>
  );
};

const DeleteConfirmDialog: Component<{
  project: Project | null;
  onClose: () => void;
  onConfirm: (project: Project) => Promise<void>;
}> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.project) {
      setErr(null);
      setBusy(false);
    }
  });

  const confirm = async () => {
    const p = props.project;
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      await props.onConfirm(p);
      props.onClose();
    } catch (e) {
      setErr(describeIpcError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.project != null}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title="Delete permanently"
      widthClass="w-[440px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy()}>
            {busy() ? "Deleting…" : "Delete permanently"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3 text-sm text-fg-2">
        <p>
          Remove{" "}
          <span class="font-semibold text-fg-1">{props.project?.name}</span> from
          your library and move its folder to the {trashLabel()}?
        </p>
        <Show when={props.project?.integrations?.cloudOrigin}>
          <p class="text-fg-3">
            The remote copy on your cloud provider stays untouched.
          </p>
        </Show>
        <Show when={err()}>
          <div class="select-text text-[var(--color-err)]">{err()}</div>
        </Show>
      </div>
    </Dialog>
  );
};

const RestorePromptDialog: Component<{
  project: Project | null;
  onClose: () => void;
  onRestoreOpen: (project: Project) => Promise<void>;
}> = (props) => {
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  createEffect(() => {
    if (props.project) {
      setErr(null);
      setBusy(false);
    }
  });

  const confirm = async () => {
    const p = props.project;
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      await props.onRestoreOpen(p);
      props.onClose();
    } catch (e) {
      setErr(describeIpcError(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.project != null}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title="Project is in the trash"
      widthClass="w-[420px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void confirm()} disabled={busy()}>
            {busy() ? "Restoring…" : "Restore & open"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3 text-sm text-fg-2">
        <p>
          <span class="font-semibold text-fg-1">{props.project?.name}</span> is
          in the trash. Restore it to open it.
        </p>
        <Show when={err()}>
          <div class="select-text text-[var(--color-err)]">{err()}</div>
        </Show>
      </div>
    </Dialog>
  );
};

function trashLabel(): string {
  const platform =
    typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
  if (platform.includes("win")) return "Recycle Bin";
  if (platform.includes("mac")) return "Trash";
  return "system trash";
}

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
            <legend class="text-sm font-medium text-fg-2">Where</legend>
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
                      <span class="text-sm font-medium text-fg-1">{opt.label}</span>
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
            <legend class="text-sm font-medium text-fg-2">Account</legend>
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
            <legend class="text-sm font-medium text-fg-2">Remote folder</legend>
            <Show
              when={!remoteRoots.loading}
              fallback={<div class="text-xs text-fg-3">Loading remote folders…</div>}
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
                        <span class="text-sm text-fg-1">{folder.name}</span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </fieldset>
        </Show>

        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-medium text-fg-2">Name</span>
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
          <legend class="text-sm font-medium text-fg-2">Format</legend>
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
                    <span class="text-sm font-medium text-fg-1">{f.label}</span>
                    <span class="text-xs text-fg-3">{f.sub}</span>
                  </div>
                </label>
              )}
            </For>
          </div>
        </fieldset>

        <Show when={err()}>
          <div class="select-text text-sm text-[var(--color-err)]">{err()}</div>
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
