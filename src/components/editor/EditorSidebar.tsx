import { describeIpcError } from "~/lib/errors";
import {
  BookMarked,
  ChevronUp,
  ChevronsDownUp,
  ClipboardCopy,
  Copy,
  ExternalLink,
  Files,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Import,
  GitBranch,
  ListTodo,
  MessageSquare,
  Pencil,
  Settings2,
  Trash2,
  Zap,
} from "lucide-solid";
import { exists, readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { FileTree, type FileNode } from "~/components/editor/FileTree";
import { OutlinePanel } from "~/components/editor/OutlinePanel";
import { ReferencesPanel } from "~/components/references/ReferencesPanel";
import { TodoPanel } from "~/components/editor/TodoPanel";
import { CommitPanel } from "~/components/vcs/CommitPanel";
import { ReviewPanel } from "~/components/reviews/ReviewPanel";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  createContextMenuState,
} from "~/components/primitives/ContextMenu";
import { Dialog } from "~/components/primitives/Dialog";
import { Button } from "~/components/primitives/Button";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";
import { notifyError, notifySuccess } from "~/lib/toast";
import { refsAvailability } from "~/integrations/references/availability";
import { citationProviders } from "~/integrations/references/registry";
import {
  activeFile,
  closeFileByRelPath,
  openFiles,
  project,
  remapOpenFilesUnderDir,
  renameOpenFile,
  setProject,
} from "~/stores/editor-store";
import { effectiveBuild } from "~/adapters/latex/build-config";
import {
  BuildConfigMenu,
  ENGINE_LABEL,
} from "~/components/editor/BuildConfigMenu";
import { openProjectSettings } from "~/components/editor/ProjectSettingsDialog";
import { installDismiss } from "~/lib/dismiss";
import { useListboxOpenFocus } from "~/lib/listbox-nav";
import { handleTablistKeydown, rovingTabIndex } from "~/lib/tablist-nav";
import { fileManagerLabel } from "~/lib/platform-nouns";
import {
  openCommentThreadCount,
  reanchorThreadById,
  remapThreadDir,
  remapThreadFile,
} from "~/stores/review-store";
import { todoCount } from "~/stores/todo-store";
import { touchAffordances } from "~/stores/viewport-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { gitStateVersion } from "~/stores/git-store";

/**
 * Shared left sidebar for the editor's TextShell.
 * Owns search + tabs + FileTree + outline + project footer. Lives in its
 * own file to keep the shell component lean.
 *
 * Selection state (which tab is active, whether the outline is
 * collapsed) is owned by the parent shell — keeps the sidebar reusable
 * and lets future shells decide what tabs they support.
 */

export type LeftTab = "files" | "references" | "scm" | "review" | "todo";

interface SidebarTab {
  id: LeftTab;
  label: string;
  icon: Component<{ size?: number }>;
  count?: number;
}

interface EditorSidebarProps {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  outlineCollapsed: boolean;
  setOutlineCollapsed: (fn: (v: boolean) => boolean) => void;
  onSelectFile: (relPath: string) => void;
  /** Reports the tab strip's natural width so the shell can fit the sidebar. */
  onTabsMeasured?: (px: number) => void;
}

/** What the shared NamePromptDialog is currently asking for. */
interface PromptRequest {
  title: string;
  placeholder: string;
  initial: string;
  confirmLabel: string;
  /** Throws (Error/string) to surface an inline error; resolve = success + close. */
  onConfirm: (value: string) => Promise<void> | void;
}

/** Payload for the FileTree context menu (which surface was right-clicked). */
type FileMenuPayload =
  | { kind: "file"; node: FileNode }
  | { kind: "dir"; node: FileNode }
  | { kind: "empty" };

/** Platform-native join matching EditorScreen's joinPath convention. */
const joinAbs = (parent: string, rel: string): string => {
  const sep = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(sep) ? parent + rel : parent + sep + rel;
};

/**
 * Flat list of the project's directories (rel paths, forward slashes) for the
 * Move to… picker. Depth/entry-capped walk; hidden and dependency dirs are
 * skipped like the FileTree hides them.
 */
async function listProjectDirs(rootPath: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth >= 6 || out.length >= 200) return;
    let entries: DirEntry[];
    try {
      entries = await readDir(abs);
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory || e.name.startsWith(".") || e.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      out.push(childRel);
      await walk(joinAbs(abs, e.name), childRel, depth + 1);
    }
  };
  await walk(rootPath, "", 0);
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

export const EditorSidebar: Component<EditorSidebarProps> = (props) => {
  const [prompt, setPrompt] = createSignal<PromptRequest | null>(null);
  const [collapseGen, setCollapseGen] = createSignal(0);
  const fileMenu = createContextMenuState<FileMenuPayload>();

  // When the sidebar is dragged narrower than the tab strip's natural width,
  // tabs collapse to icon-only. The natural width is measured off a hidden
  // full-label clone (below) so it stays known even while compact renders.
  const [compact, setCompact] = createSignal(false);
  let naturalWidth = 0;
  let measureStripRef: HTMLDivElement | undefined;

  // The SCM tab is meaningless outside a git repo — `.git` can be a dir or
  // (worktrees) a file; `exists` covers both. Non-Tauri contexts resolve
  // false and simply hide the tab.
  const [isGitRepo] = createResource(
    () => [project()?.rootPath ?? null, gitStateVersion()] as const,
    async ([root]) => {
      if (!root) return false;
      try {
        return await exists(`${root}/.git`);
      } catch {
        return false;
      }
    },
    { initialValue: false },
  );

  // Mobile has no git IPC at all (the commands are cfg-gated off), so the tab
  // never appears there rather than offering actions that cannot run.
  const showScm = () => ipc.gitAvailable() && isGitRepo();

  // If SCM was active and the project switched to a non-repo, the tab strip
  // no longer shows it — bounce to Files.
  createEffect(() => {
    if (!showScm() && props.tab === "scm") props.setTab("files");
  });

  // Refs earns a tab once at least one citation provider is registered
  // (configured) AND the reachability probe hasn't proven every provider
  // unreachable. Configured-but-unknown still shows the tab; it only drops out
  // after a definitive all-unreachable result (e.g. Zotero enabled but closed).
  const showRefs = () =>
    citationProviders().length > 0 && refsAvailability() !== "none-ready";
  createEffect(() => {
    if (!showRefs() && props.tab === "references") props.setTab("files");
  });

  // Re-anchor an orphaned thread to the current editor selection. The store
  // is the source of truth; the CM decoration bridge re-renders from it.
  const handleReanchor = (threadId: string) => {
    const view = getActiveEditorView();
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.from === sel.to) return;
    const anchorText = view.state.doc.sliceString(sel.from, sel.to);
    reanchorThreadById(threadId, sel.from, sel.to, anchorText);
  };

  // ---- File-tree operations (header buttons + context menus) --------------

  /** Directory portion of a rel path ("chapters/intro.tex" -> "chapters"). */
  const parentRel = (relPath: string): string => {
    const i = relPath.replace(/\\/g, "/").lastIndexOf("/");
    return i < 0 ? "" : relPath.slice(0, i);
  };

  const openNewFilePrompt = (dirRel: string) => {
    const seed = dirRel ? `${dirRel}/` : "";
    setPrompt({
      title: "New file",
      placeholder: "name.tex",
      initial: seed,
      confirmLabel: "Create",
      onConfirm: async (value) => {
        const p = project();
        const name = value.trim().replace(/\\/g, "/");
        if (!p || !name) return;
        // The write IPC replaces the target unconditionally — an existing name
        // would silently wipe that file.
        if (await exists(`${p.rootPath}/${name}`)) {
          throw new Error("A file with this name already exists");
        }
        try {
          // Validates the project-relative path and creates parent dirs, so
          // "chapters/intro.tex" also works as a folder shortcut.
          await ipc.writeProjectTextFile(p.rootPath, name, "");
        } catch (e) {
          recordError("new-file", `creating ${name} failed`, e);
          throw e;
        }
        props.onSelectFile(name);
      },
    });
  };

  const openNewFolderPrompt = (dirRel: string) => {
    const seed = dirRel ? `${dirRel}/` : "";
    setPrompt({
      title: "New folder",
      placeholder: "chapters",
      initial: seed,
      confirmLabel: "Create",
      onConfirm: async (value) => {
        const p = project();
        const name = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
        if (!p || !name) return;
        if (await exists(`${p.rootPath}/${name}`)) {
          throw new Error("A folder with this name already exists");
        }
        try {
          await ipc.createProjectDir(p.rootPath, name);
        } catch (e) {
          recordError("new-folder", `creating ${name} failed`, e);
          throw e;
        }
      },
    });
  };

  /**
   * Post-move/rename bookkeeping shared by Rename… and Move to…: repoint open
   * buffers, keep comment/TODO threads attached, and re-target the project's
   * entry file when it travelled with the move.
   */
  const afterPathMove = async (node: FileNode, newRel: string) => {
    const p = project();
    if (!p) return;
    if (node.isDir) {
      remapOpenFilesUnderDir(node.relPath, newRel, p.rootPath);
      remapThreadDir(node.relPath, newRel);
      const prefix = `${node.relPath}/`;
      if (p.rootFile.startsWith(prefix)) {
        const newRoot = `${newRel}/${p.rootFile.slice(prefix.length)}`;
        try {
          setProject(await ipc.setProjectRootFile(p.rootPath, newRoot));
        } catch (e) {
          recordError("move-path", `repointing rootFile to ${newRoot} failed`, e);
        }
      }
    } else {
      // Keep an open buffer attached (content + dirty preserved).
      renameOpenFile(node.relPath, newRel, joinAbs(p.rootPath, newRel));
      if (p.rootFile === node.relPath) {
        try {
          setProject(await ipc.setProjectRootFile(p.rootPath, newRel));
        } catch (e) {
          recordError("move-path", `repointing rootFile to ${newRel} failed`, e);
        }
      }
      remapThreadFile(node.relPath, newRel);
    }
  };

  const openRenamePrompt = (node: FileNode) => {
    const dir = parentRel(node.relPath);
    setPrompt({
      title: node.isDir ? "Rename folder" : "Rename file",
      placeholder: node.isDir ? "chapters" : "name.tex",
      initial: node.name,
      confirmLabel: "Rename",
      onConfirm: async (value) => {
        const p = project();
        const trimmed = value.trim().replace(/\\/g, "/");
        if (!p || !trimmed || trimmed === node.name) return;
        const newRel = dir ? `${dir}/${trimmed}` : trimmed;
        if (newRel === node.relPath) return;
        try {
          await ipc.renameProjectFile(p.rootPath, node.relPath, newRel);
        } catch (e) {
          recordError("rename-file", `renaming ${node.relPath} failed`, e);
          throw e;
        }
        await afterPathMove(node, newRel);
      },
    });
  };

  // Pick files anywhere on disk and copy them into `dirRel` ("" = project
  // root). The dialog returns absolute paths, which is exactly why the copy
  // happens in the Rust import IPC rather than through the fs plugin.
  const addFiles = async (dirRel: string) => {
    const p = project();
    if (!p) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, title: "Add files to project" });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return;
    try {
      const created = await ipc.importFilesIntoProject(p.rootPath, dirRel, paths);
      if (created.length === 0) return;
      notifySuccess(
        created.length === 1
          ? `Added ${created[0].split("/").pop()}`
          : `Added ${created.length} files`,
      );
    } catch (e) {
      notifyError("Couldn't add files", describeIpcError(e));
      recordError("import-files", `importing into ${dirRel || "the project root"} failed`, e);
    }
  };

  // ---- Move to… dialog ----------------------------------------------------

  const [moveNode, setMoveNode] = createSignal<FileNode | null>(null);
  const [moveDirs] = createResource(
    () => (moveNode() ? (project()?.rootPath ?? null) : null),
    async (root) => (root ? await listProjectDirs(root) : []),
    { initialValue: [] },
  );
  // Valid destinations: the root plus every project dir, minus the node's
  // current parent (a no-op move) and — for folders — the node's own subtree.
  const moveTargets = createMemo<string[]>(() => {
    const node = moveNode();
    if (!node) return [];
    const parent = parentRel(node.relPath);
    return ["", ...(moveDirs() ?? [])].filter((d) => {
      if (d === parent) return false;
      if (node.isDir && (d === node.relPath || d.startsWith(`${node.relPath}/`)))
        return false;
      return true;
    });
  });

  const doMove = async (destRel: string) => {
    const node = moveNode();
    const p = project();
    setMoveNode(null);
    if (!node || !p) return;
    try {
      const newRel = await ipc.moveProjectPath(p.rootPath, node.relPath, destRel);
      await afterPathMove(node, newRel);
    } catch (e) {
      notifyError("Couldn't move", describeIpcError(e));
      recordError("move-path", `moving ${node.relPath} failed`, e);
    }
  };

  const duplicateFile = async (node: FileNode) => {
    const p = project();
    if (!p) return;
    try {
      const newRel = await ipc.duplicateProjectFile(p.rootPath, node.relPath);
      props.onSelectFile(newRel);
    } catch (e) {
      notifyError("Couldn't duplicate file", describeIpcError(e));
      recordError("duplicate-file", `duplicating ${node.relPath} failed`, e);
    }
  };

  const deletePath = async (node: FileNode) => {
    const p = project();
    if (!p) return;
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const ok = await ask(
      node.isDir
        ? `Move the folder "${node.name}" and its contents to the trash? You can restore it from your system trash.`
        : `Move "${node.name}" to the trash? Any unsaved changes in this file will be lost. You can restore it from your system trash.`,
      { title: "Delete", kind: "warning", okLabel: "Move to trash", cancelLabel: "Cancel" },
    );
    if (!ok) return;
    try {
      await ipc.deleteProjectPath(p.rootPath, node.relPath);
    } catch (e) {
      notifyError("Couldn't delete", describeIpcError(e));
      recordError("delete-path", `deleting ${node.relPath} failed`, e);
      return;
    }
    // Close any open tab(s) the delete just orphaned. Threads are left in
    // place — the file is trash-recoverable.
    if (node.isDir) {
      const prefix = `${node.relPath}/`;
      for (const rel of openFiles()
        .map((f) => f.relPath)
        .filter((rel) => rel === node.relPath || rel.startsWith(prefix))) {
        closeFileByRelPath(rel);
      }
    } else {
      closeFileByRelPath(node.relPath);
    }
  };

  const copyRelPath = async (node: FileNode) => {
    try {
      // The Tauri clipboard plugin, not navigator.clipboard: the latter needs a
      // secure context + user-gesture and is unreliable under WebKitGTK (Linux).
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(node.relPath);
    } catch (e) {
      notifyError("Couldn't copy path", describeIpcError(e));
    }
  };

  const revealInFileManager = async (node: FileNode) => {
    const p = project();
    if (!p) return;
    try {
      await ipc.revealProjectPath(p.rootPath, node.relPath);
    } catch (e) {
      notifyError("Couldn't reveal file", describeIpcError(e));
    }
  };

  // The tabs shown, in order. Files always; Review/TODO carry live counters.
  // The label + icon serve the full and compact renderings.
  const tabDefs = createMemo<SidebarTab[]>(() => [
    { id: "files", label: "Files", icon: Files },
    ...(showRefs()
      ? [{ id: "references" as LeftTab, label: "Refs", icon: BookMarked }]
      : []),
    ...(showScm() ? [{ id: "scm" as LeftTab, label: "SCM", icon: GitBranch }] : []),
    { id: "review", label: "Review", icon: MessageSquare, count: openCommentThreadCount() },
    { id: "todo", label: "TODO", icon: ListTodo, count: todoCount() },
    // History moved to the top-bar HistoryMenu popover (2026-07-19).
  ]);

  // Natural width is measured off the hidden full-label clone, not the visible
  // strip — so a compact (icon-only) render can't shrink the measured width and
  // trap the strip in compact mode. The shell sizes the sidebar to this width.
  let tabStripRef: HTMLDivElement | undefined;
  const measureTabs = () => {
    const el = measureStripRef;
    if (!el) return;
    const style = getComputedStyle(el);
    const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    const kids = Array.from(el.children) as HTMLElement[];
    let content = padX;
    for (const k of kids) content += k.offsetWidth;
    if (kids.length > 1) content += gap * (kids.length - 1);
    naturalWidth = Math.ceil(content);
    props.onTabsMeasured?.(naturalWidth);
    evaluateCompact();
  };
  // Flip to icons when the visible strip can't fit full labels; expand back with
  // an 8px hysteresis band so it doesn't oscillate at the threshold.
  const evaluateCompact = () => {
    const el = tabStripRef;
    if (!el || naturalWidth === 0) return;
    const avail = el.clientWidth;
    if (!compact() && avail < naturalWidth) setCompact(true);
    else if (compact() && avail >= naturalWidth + 8) setCompact(false);
  };
  createEffect(() => {
    // Track the reactive bits that add/remove tabs or change a counter width.
    showRefs();
    showScm();
    openCommentThreadCount();
    todoCount();
    queueMicrotask(measureTabs);
  });
  onMount(() => {
    if (!tabStripRef) return;
    const ro = new ResizeObserver(() => evaluateCompact());
    ro.observe(tabStripRef);
    onCleanup(() => ro.disconnect());
  });

  // Reading activeFile().content straight from the footer would recount
  // words/lines in the same flush as every keystroke (updateActiveFile
  // replaces the file object per edit). Snapshot the content on a trailing
  // debounce instead; a file-identity change bypasses the debounce so
  // counts don't lag on tab switch.
  const [statsContent, setStatsContent] = createSignal<string | null>(
    activeFile()?.content ?? null,
  );
  let statsTimer: ReturnType<typeof setTimeout> | undefined;
  let statsPath: string | undefined;
  createEffect(() => {
    const f = activeFile();
    const content = f?.content ?? null;
    if (statsTimer !== undefined) {
      clearTimeout(statsTimer);
      statsTimer = undefined;
    }
    if (f?.path !== statsPath) {
      statsPath = f?.path;
      setStatsContent(content);
      return;
    }
    statsTimer = setTimeout(() => {
      statsTimer = undefined;
      setStatsContent(content);
    }, 300);
  });
  onCleanup(() => {
    if (statsTimer !== undefined) clearTimeout(statsTimer);
  });
  const stats = createMemo(() => {
    const s = statsContent();
    return s == null ? null : countStats(s);
  });

  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      {/* Tab row — Files / Review / TODO. SCM shows only inside git repos and
          Refs only with a configured citation provider. */}
      <div
        ref={tabStripRef}
        role="tablist"
        aria-label="Sidebar panels"
        onKeyDown={(e) =>
          handleTablistKeydown(e, {
            count: tabDefs().length,
            activeIndex: tabDefs().findIndex((t) => t.id === props.tab),
            activate: (i) => props.setTab(tabDefs()[i].id),
          })
        }
        class="flex flex-shrink-0 items-center gap-0 overflow-x-auto scroll border-b border-glass-stroke px-2 pt-1.5"
      >
        <For each={tabDefs()}>
          {(t) => {
            const active = () => props.tab === t.id;
            return (
              <button
                type="button"
                role="tab"
                id={`sidebar-tab-${t.id}`}
                aria-selected={active()}
                aria-controls="sidebar-tabpanel"
                aria-label={t.label}
                tabIndex={rovingTabIndex(active())}
                title={compact() ? t.label : undefined}
                onClick={() => props.setTab(t.id)}
                class={`relative flex flex-shrink-0 items-center gap-1.5 px-2.5 text-base font-medium ${
                  active() ? "text-fg-1" : "text-fg-3 hover:text-fg-2"
                }`}
                // 44px tabs on coarse pointers. The hidden measurement clone
                // below must mirror this ternary so it measures the same size
                // variant the strip renders.
                style={{ height: touchAffordances() ? "44px" : "var(--ui-row)" }}
              >
                <Show when={compact() && t.id !== "files"} fallback={t.label}>
                  <Dynamic component={t.icon} size={14} />
                </Show>
                <Show when={t.count != null}>
                  <span
                    class="mono rounded-full px-1.5 py-0.5 text-xs"
                    style={{
                      background: active()
                        ? "color-mix(in srgb, var(--color-accent-1) 18%, transparent)"
                        : "var(--color-control-fill)",
                      color: active() ? "var(--color-accent-1)" : "var(--color-fg-3)",
                    }}
                  >
                    {t.count}
                  </span>
                </Show>
                <Show when={active()}>
                  <span
                    class="absolute bottom-0 left-2.5 right-2.5 h-[2px] rounded"
                    style={{
                      background:
                        "linear-gradient(90deg, var(--color-accent-1), var(--color-accent-2))",
                    }}
                  />
                </Show>
              </button>
            );
          }}
        </For>
      </div>
      {/* Hidden full-label clone: the sole width-measurement source, so the
          natural width stays known even while the visible strip renders icons. */}
      <div
        ref={measureStripRef}
        aria-hidden="true"
        class="pointer-events-none flex items-center gap-0 px-2"
        style={{
          position: "absolute",
          top: "0",
          left: "0",
          visibility: "hidden",
          "white-space": "nowrap",
        }}
      >
        <For each={tabDefs()}>
          {(t) => (
            <span
              class="flex flex-shrink-0 items-center gap-1.5 px-2.5 text-base font-medium"
              style={{ height: touchAffordances() ? "44px" : "var(--ui-row)" }}
            >
              {t.label}
              <Show when={t.count != null}>
                <span class="mono rounded-full px-1.5 py-0.5 text-xs">{t.count}</span>
              </Show>
            </span>
          )}
        </For>
      </div>

      {/* "Files" section header — uppercase label + new-file / new-folder actions. */}
      <Show when={props.tab === "files"}>
        <div
          class="label-xs flex flex-shrink-0 items-center justify-between px-3 text-fg-3"
          classList={{
            "h-11": touchAffordances(),
            "h-9": !touchAffordances(),
          }}
        >
          <span>File tree</span>
          <div class="flex items-center gap-0.5">
            <button
              type="button"
              title="New folder"
              aria-label="New folder"
              onClick={() => openNewFolderPrompt("")}
              class="flex items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
              classList={{
                "h-11 w-11": touchAffordances(),
                "h-6 w-6": !touchAffordances(),
              }}
            >
              <FolderPlus class="ui-icon-menu" style={{ opacity: 0.8 }} />
            </button>
            <button
              type="button"
              title="New file"
              aria-label="New file"
              onClick={() => openNewFilePrompt("")}
              class="flex items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
              classList={{
                "h-11 w-11": touchAffordances(),
                "h-6 w-6": !touchAffordances(),
              }}
            >
              <FilePlus class="ui-icon-menu" style={{ opacity: 0.8 }} />
            </button>
          </div>
        </div>
      </Show>

      {/* One shared tabpanel whose content swaps with the selected tab. */}
      <div
        id="sidebar-tabpanel"
        role="tabpanel"
        aria-labelledby={`sidebar-tab-${props.tab}`}
        class="min-h-0 flex-1 overflow-auto scroll"
      >
        <Show when={props.tab === "files" && project()}>
          <FileTree
            rootPath={project()!.rootPath}
            activeRelPath={activeFile()?.relPath ?? null}
            onOpen={props.onSelectFile}
            onFileMenu={(node, e) => fileMenu.openAt(e, { kind: "file", node })}
            onDirMenu={(node, e) => fileMenu.openAt(e, { kind: "dir", node })}
            onEmptyMenu={(e) => fileMenu.openAt(e, { kind: "empty" })}
            collapseGeneration={collapseGen()}
          />
        </Show>
        <Show when={props.tab === "references"}>
          <ReferencesPanel />
        </Show>
        <Show when={props.tab === "scm"}>
          <CommitPanel />
        </Show>
        <Show when={props.tab === "review"}>
          <ReviewPanel onRequestReanchor={handleReanchor} />
        </Show>
        <Show when={props.tab === "todo"}>
          <TodoPanel />
        </Show>
      </div>

      <OutlinePanel
        collapsed={props.outlineCollapsed}
        onToggle={() => props.setOutlineCollapsed((v) => !v)}
      />

      <div class="flex-shrink-0 space-y-2.5 border-t border-glass-stroke p-3">
        <div class="flex items-center justify-between">
          <span class="label-xs text-fg-3">Project</span>
          <button
            type="button"
            title="Project settings"
            aria-label="Project settings"
            onClick={() => openProjectSettings()}
            class="flex items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
            classList={{
              "h-11 w-11": touchAffordances(),
              "h-6 w-6": !touchAffordances(),
            }}
          >
            <Settings2 class="ui-icon-menu" style={{ opacity: 0.8 }} />
          </button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <Stat label="Words" value={stats()?.words ?? "–"} />
          <Stat label="Lines" value={stats()?.lines ?? "–"} />
        </div>
        <Show when={project()?.format === "latex"}>
          <EnginePill />
        </Show>
      </div>

      <Show when={fileMenu.menu()}>
        {(m) => {
          const nodeOf = (p: FileMenuPayload) => (p.kind === "empty" ? undefined : p);
          return (
            <ContextMenu x={m().x} y={m().y} onClose={fileMenu.close}>
              <Show when={nodeOf(m().payload)}>
                {(pl) => (
                  <>
                    <Show when={pl().kind === "file"}>
                      <ContextMenuItem
                        icon={FolderOpen}
                        label="Open"
                        onClick={() => {
                          fileMenu.close();
                          props.onSelectFile(pl().node.relPath);
                        }}
                      />
                    </Show>
                    <ContextMenuItem
                      icon={Pencil}
                      label="Rename…"
                      onClick={() => {
                        fileMenu.close();
                        openRenamePrompt(pl().node);
                      }}
                    />
                    <Show when={pl().kind === "file"}>
                      <ContextMenuItem
                        icon={Copy}
                        label="Duplicate"
                        onClick={() => {
                          fileMenu.close();
                          void duplicateFile(pl().node);
                        }}
                      />
                    </Show>
                    <ContextMenuItem
                      icon={FolderInput}
                      label="Move to…"
                      onClick={() => {
                        fileMenu.close();
                        setMoveNode(pl().node);
                      }}
                    />
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      icon={FilePlus}
                      label="New file here"
                      onClick={() => {
                        fileMenu.close();
                        openNewFilePrompt(
                          pl().kind === "dir"
                            ? pl().node.relPath
                            : parentRel(pl().node.relPath),
                        );
                      }}
                    />
                    <ContextMenuItem
                      icon={FolderPlus}
                      label="New folder here"
                      onClick={() => {
                        fileMenu.close();
                        openNewFolderPrompt(
                          pl().kind === "dir"
                            ? pl().node.relPath
                            : parentRel(pl().node.relPath),
                        );
                      }}
                    />
                    <ContextMenuItem
                      icon={Import}
                      label="Add files here…"
                      onClick={() => {
                        fileMenu.close();
                        void addFiles(
                          pl().kind === "dir"
                            ? pl().node.relPath
                            : parentRel(pl().node.relPath),
                        );
                      }}
                    />
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      icon={ClipboardCopy}
                      label="Copy relative path"
                      onClick={() => {
                        fileMenu.close();
                        void copyRelPath(pl().node);
                      }}
                    />
                    <ContextMenuItem
                      icon={ExternalLink}
                      label={fileManagerLabel()}
                      onClick={() => {
                        fileMenu.close();
                        void revealInFileManager(pl().node);
                      }}
                    />
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      icon={Trash2}
                      label="Delete…"
                      danger
                      onClick={() => {
                        fileMenu.close();
                        void deletePath(pl().node);
                      }}
                    />
                  </>
                )}
              </Show>
              <Show when={m().payload.kind === "empty"}>
                <ContextMenuItem
                  icon={FilePlus}
                  label="New file"
                  onClick={() => {
                    fileMenu.close();
                    openNewFilePrompt("");
                  }}
                />
                <ContextMenuItem
                  icon={FolderPlus}
                  label="New folder"
                  onClick={() => {
                    fileMenu.close();
                    openNewFolderPrompt("");
                  }}
                />
                <ContextMenuItem
                  icon={Import}
                  label="Add files…"
                  onClick={() => {
                    fileMenu.close();
                    void addFiles("");
                  }}
                />
                <ContextMenuSeparator />
                <ContextMenuItem
                  icon={ChevronsDownUp}
                  label="Collapse all"
                  onClick={() => {
                    fileMenu.close();
                    setCollapseGen((g) => g + 1);
                  }}
                />
              </Show>
            </ContextMenu>
          );
        }}
      </Show>

      <NamePromptDialog request={prompt()} onClose={() => setPrompt(null)} />

      {/* Move to… destination picker — the project root plus every directory
          visible in the tree, minus the source's parent and its own subtree. */}
      <Dialog
        open={moveNode() !== null}
        onOpenChange={(o) => {
          if (!o) setMoveNode(null);
        }}
        title={moveNode() ? `Move "${moveNode()!.name}" to…` : ""}
        widthClass="w-[420px]"
      >
        <div class="flex max-h-72 flex-col gap-0.5 overflow-auto scroll">
          <For each={moveTargets()}>
            {(dest) => (
              <button
                type="button"
                onClick={() => void doMove(dest)}
                class="lift flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
              >
                <Folder class="ui-icon-menu flex-shrink-0 text-fg-3" />
                <span class="truncate">{dest === "" ? "Project root" : dest}</span>
              </button>
            )}
          </For>
          <Show when={!moveDirs.loading && moveTargets().length === 0}>
            <div class="px-2 py-1.5 text-sm text-fg-3">
              No other folders in this project.
            </div>
          </Show>
        </div>
      </Dialog>
    </div>
  );
};

/**
 * Small prefilled-input dialog shared by new-file / new-folder / rename. The
 * caller's `onConfirm` throws to surface an inline error (e.g. name collision)
 * and resolves to close.
 */
const NamePromptDialog: Component<{
  request: PromptRequest | null;
  onClose: () => void;
}> = (props) => {
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  createEffect(() => {
    const req = props.request;
    if (!req) return;
    setValue(req.initial);
    setError(null);
    queueMicrotask(() => {
      inputRef?.focus();
      // Select the file stem so a rename edits the name, not the extension.
      const v = inputRef?.value ?? "";
      const dot = v.lastIndexOf(".");
      inputRef?.setSelectionRange(0, dot > 0 ? dot : v.length);
    });
  });

  const submit = async () => {
    const req = props.request;
    if (!req || busy()) return;
    setBusy(true);
    try {
      await req.onConfirm(value());
      props.onClose();
    } catch (e) {
      setError(describeIpcError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.request !== null}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title={props.request?.title ?? ""}
      widthClass="w-[420px]"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={busy()} onClick={() => void submit()}>
            {props.request?.confirmLabel ?? "OK"}
          </Button>
        </>
      }
    >
      <input
        ref={inputRef}
        type="text"
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={props.request?.placeholder}
        aria-invalid={error() !== null}
        aria-describedby={error() ? "name-prompt-error" : undefined}
        class="glass-inset w-full rounded-md px-2.5 py-2 text-sm text-fg-1 placeholder:text-fg-2 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-1)]"
      />
      <Show when={error()}>
        <div
          id="name-prompt-error"
          role="alert"
          class="mt-2 text-xs"
          style={{ color: "var(--color-err)" }}
        >
          {error()}
        </div>
      </Show>
    </Dialog>
  );
};


/**
 * Interactive engine chip in the Project footer. Clicking it toggles the shared
 * {@link BuildConfigMenu}. The popover opens *upward* into the sidebar body:
 * the chip sits at the footer, and the sidebar root clips overflow, so a
 * downward menu would be hidden.
 */
const EnginePill: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  useListboxOpenFocus(open, () => rootRef);

  const label = () => {
    const p = project();
    if (!p) return "";
    const e = effectiveBuild(p).engine;
    return ENGINE_LABEL[e] ?? e;
  };

  return (
    <div class="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
        title="Build settings: engine, recipe, and compile options"
        class="lift group glass-soft flex w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-2 hover:border-[var(--color-control-stroke)] hover:bg-[var(--color-control-fill)]"
      >
        <Zap size={12} style={{ color: "var(--color-accent-1)" }} />
        <span class="text-xs text-fg-2">Engine</span>
        <span class="mono ml-auto text-xs text-fg-1">{label()}</span>
        {/* Disclosure cue — the pill opens the build-config popover. */}
        <ChevronUp
          size={12}
          class="text-fg-3 transition-transform group-hover:-translate-y-0.5"
          style={{ opacity: open() ? 1 : 0.7 }}
        />
      </button>
      <Show when={open()}>
        <BuildConfigMenu
          direction="up"
          matchTriggerWidth
          onClose={() => setOpen(false)}
          onOpenSettings={openProjectSettings}
        />
      </Show>
    </div>
  );
};

const Stat: Component<{ label: string; value: string }> = (props) => (
  <div class="glass-soft rounded-lg px-2 py-1.5">
    <div class="label-xs text-fg-3">{props.label}</div>
    <div class="mono mt-0.5 text-base font-semibold text-fg-1">
      {props.value}
    </div>
  </div>
);

// Mirrors the JS regex \s set so word boundaries match the old
// replace(/\s+/)-and-split implementation exactly.
const isWhitespaceCode = (c: number): boolean =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

// Single allocation-free pass — the previous regex/split pipeline made
// three O(n) passes and allocated a whole-document word array each time.
const countStats = (s: string): { words: string; lines: string } => {
  let words = 0;
  let lines = 1;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) lines++;
    if (isWhitespaceCode(c)) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return { words: words.toLocaleString(), lines: lines.toLocaleString() };
};

