import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import { ChevronRight, File as FileIcon, FileText, Folder } from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import {
  anchoredMenuEvent,
  isMenuKey,
  menuEventAtRect,
} from "~/lib/menu-position";
import { touchAffordances } from "~/stores/viewport-store";
import { fsVersion } from "~/stores/watcher-store";

export interface FileNode {
  name: string;
  /** Absolute path. */
  path: string;
  /** Path relative to root. */
  relPath: string;
  isDir: boolean;
}

interface FileTreeProps {
  rootPath: string;
  /** Relative path of the currently-open file, e.g. "main.tex". */
  activeRelPath: string | null;
  onOpen: (relPath: string) => void;
  /** Right-click on a file row. */
  onFileMenu?: (node: FileNode, e: MouseEvent) => void;
  /** Right-click on a directory row. */
  onDirMenu?: (node: FileNode, e: MouseEvent) => void;
  /** Right-click on empty tree space (below/around the rows). */
  onEmptyMenu?: (e: MouseEvent) => void;
  /** Bumped by "Collapse all" — resets every non-root directory to collapsed. */
  collapseGeneration?: number;
}

async function readChildren(absPath: string, relPath: string): Promise<FileNode[]> {
  const entries: DirEntry[] = await readDir(absPath);
  return entries
    .filter((e) => !shouldHide(e.name))
    .map((e) => ({
      name: e.name,
      path: joinPath(absPath, e.name),
      relPath: relPath ? `${relPath}/${e.name}` : e.name,
      isDir: e.isDirectory,
    }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
}

function shouldHide(name: string): boolean {
  if (name === ".typeward") return false; // visible but de-emphasized below
  if (name.startsWith(".")) return true;
  // Hide LaTeX build clutter from the default view; user can find them in their
  // file manager if they need to.
  return /\.(aux|fdb_latexmk|fls|out|toc|log|synctex\.gz)$/.test(name);
}

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  // Use platform-native separator: if the parent has any backslash, treat as Windows.
  return parent.includes("\\") ? `${parent}\\${name}` : `${parent}/${name}`;
}

function treeRows(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'),
  );
}

// ARIA tree keyboard pattern over the rendered row buttons (DOM order matches
// visual order): arrows move focus, and the roving tabindex — exactly one row
// with tabIndex 0 — moves with it via the container's focusin handler, so the
// whole tree costs a single Tab stop entering and leaving.
function handleTreeKeydown(e: KeyboardEvent & { currentTarget: HTMLElement }) {
  const rows = treeRows(e.currentTarget);
  if (rows.length === 0) return;
  const current = rows.findIndex((r) => r === document.activeElement);
  if (e.key === "ArrowDown") {
    rows[Math.min(current + 1, rows.length - 1)]?.focus();
  } else if (e.key === "ArrowUp") {
    rows[Math.max(current - 1, 0)]?.focus();
  } else if (e.key === "Home") {
    rows[0]?.focus();
  } else if (e.key === "End") {
    rows[rows.length - 1]?.focus();
  } else if (e.key === "ArrowRight") {
    const el = rows[current];
    if (el?.getAttribute("aria-expanded") === "false") {
      el.click();
    } else if (el?.getAttribute("aria-expanded") === "true") {
      // APG: on an open node, ArrowRight descends to the first child (the
      // next row in DOM order, when it's one level deeper).
      const next = rows[current + 1];
      const level = Number(el.getAttribute("aria-level"));
      if (next && Number(next.getAttribute("aria-level")) === level + 1) {
        next.focus();
      }
    }
  } else if (e.key === "ArrowLeft") {
    const el = rows[current];
    if (el?.getAttribute("aria-expanded") === "true") {
      el.click();
    } else if (el) {
      // APG: on a leaf or collapsed node, ArrowLeft ascends to the parent —
      // the nearest preceding row one level shallower.
      const level = Number(el.getAttribute("aria-level"));
      for (let i = current - 1; i >= 0; i--) {
        if (Number(rows[i].getAttribute("aria-level")) === level - 1) {
          rows[i].focus();
          break;
        }
      }
    }
  } else {
    return;
  }
  e.preventDefault();
}

// Clicking or arrowing onto a row moves the roving 0 with focus, so Tab
// re-enters the tree at the row the user left it on.
function handleTreeFocusIn(e: FocusEvent & { currentTarget: HTMLElement }) {
  const t = e.target;
  if (!(t instanceof HTMLElement) || t.getAttribute("role") !== "treeitem") return;
  for (const row of treeRows(e.currentTarget)) row.tabIndex = row === t ? 0 : -1;
}

// Re-derive which row holds the roving 0: the focused row, else the active
// file's row, else the first row. Needed whenever rows change under the tree —
// the watcher refresh preserves node identity where it can, but a removed row
// would otherwise take the tree's only Tab stop with it.
function syncRovingTabIndex(container: HTMLElement): void {
  const rows = treeRows(container);
  if (rows.length === 0) return;
  const target =
    rows.find((r) => r === document.activeElement) ??
    rows.find((r) => r.getAttribute("aria-selected") === "true") ??
    rows[0];
  for (const row of rows) row.tabIndex = row === target ? 0 : -1;
}

// Shared keyboard-invocation helpers (Shift+F10 / ContextMenu key anchoring)
// live in lib/menu-position alongside the clamping math.

export const FileTree: Component<FileTreeProps> = (props) => {
  // The "Files" section header used to live here; it's now owned by
  // EditorSidebar so action icons (new folder / new file / more) can sit
  // across from it in the same row.
  let treeRef: HTMLDivElement | undefined;

  // Rows render with tabIndex -1 and appear asynchronously (per-directory
  // resources), so the container owns the roving-0 bookkeeping: re-derive it
  // when rows mount/unmount or the active row moves (aria-selected flips).
  // Attribute writes from the sync itself aren't observed, so no feedback loop.
  onMount(() => {
    const el = treeRef;
    if (!el) return;
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        syncRovingTabIndex(el);
      });
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Project files"
      class="scroll h-full overflow-auto px-1.5 pb-2"
      onKeyDown={handleTreeKeydown}
      onFocusIn={handleTreeFocusIn}
      onContextMenu={(e) => props.onEmptyMenu?.(anchoredMenuEvent(e))}
    >
      <DirectoryNode
        path={props.rootPath}
        relPath=""
        name="root"
        depth={0}
        activeRelPath={props.activeRelPath}
        onOpen={props.onOpen}
        onFileMenu={props.onFileMenu}
        onDirMenu={props.onDirMenu}
        collapseGeneration={props.collapseGeneration}
        startExpanded
      />
    </div>
  );
};

interface DirectoryNodeProps {
  path: string;
  relPath: string;
  name: string;
  depth: number;
  activeRelPath: string | null;
  onOpen: (relPath: string) => void;
  onFileMenu?: (node: FileNode, e: MouseEvent) => void;
  onDirMenu?: (node: FileNode, e: MouseEvent) => void;
  collapseGeneration?: number;
  startExpanded?: boolean;
}

const DirectoryNode: Component<DirectoryNodeProps> = (props) => {
  const [expanded, setExpanded] = createSignal(props.startExpanded ?? false);
  // "Collapse all" bump: fold every non-root directory. The root (depth 0)
  // stays open so the tree never fully disappears.
  createEffect(
    on(
      () => props.collapseGeneration,
      () => {
        if (props.depth > 0) setExpanded(false);
      },
      { defer: true },
    ),
  );
  // Source bundles the expanded path with fsVersion so any watcher event
  // bumps the cache key and forces a re-read. Cheap for shallow trees;
  // refine to a per-directory invalidation if it becomes a hotspot.
  // Reuse the previous fetch's node objects for unchanged entries so the
  // reference-keyed <For> below keeps row DOM alive across watcher bumps —
  // otherwise every save collapses nested folders (fresh DirectoryNode =
  // fresh `expanded` signal) and drops the focused row.
  let prevByRelPath = new Map<string, FileNode>();
  let fetchGen = 0;
  const [children] = createResource(
    () => (expanded() ? `${props.path}|${fsVersion()}` : null),
    async (key) => {
      if (!key) return [];
      const gen = ++fetchGen;
      const fresh = await readChildren(props.path, props.relPath);
      const merged = fresh.map((node) => {
        const prev = prevByRelPath.get(node.relPath);
        // path must match too: the tree survives in-editor project switches,
        // and a relPath collision across roots would resurrect the previous
        // project's node (stale absolute path) in the new project's tree.
        return prev && prev.isDir === node.isDir && prev.path === node.path
          ? prev
          : node;
      });
      // Only the newest in-flight fetch may commit the identity map —
      // createResource is latest-wins for the value, and the map must track
      // the node objects actually rendered.
      if (gen === fetchGen) {
        prevByRelPath = new Map(merged.map((node) => [node.relPath, node]));
      }
      return merged;
    },
  );

  const selfNode = (): FileNode => ({
    name: props.name,
    path: props.path,
    relPath: props.relPath,
    isDir: true,
  });

  return (
    <div>
      <Show when={props.depth > 0}>
        <button
          type="button"
          role="treeitem"
          // depth already counts from 1 for the first visible ring (the depth-0
          // root renders no row), which is exactly aria-level's 1-based scale.
          aria-level={props.depth}
          tabIndex={-1}
          onClick={() => setExpanded((v) => !v)}
          onContextMenu={(e) => props.onDirMenu?.(selfNode(), anchoredMenuEvent(e))}
          onKeyDown={(e) => {
            if (!isMenuKey(e)) return;
            e.preventDefault();
            e.stopPropagation();
            props.onDirMenu?.(selfNode(), menuEventAtRect(e.currentTarget));
          }}
          aria-expanded={expanded()}
          class="lift flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-base text-fg-2 hover:bg-[var(--color-control-fill)]"
          // 44px rows + a wider indent step on coarse pointers — keying this
          // on width gave landscape tablets the small desktop rows.
          classList={{ "min-h-11": touchAffordances() }}
          style={{
            "padding-left": `${4 + props.depth * (touchAffordances() ? 16 : 12)}px`,
          }}
        >
          <ChevronRight
            class={`ui-icon-menu transition ${expanded() ? "rotate-90" : ""}`}
          />
          <Folder class="ui-icon-menu text-fg-3" />
          <span class="truncate">{props.name}</span>
        </button>
      </Show>
      <Show when={expanded() || props.depth === 0}>
        <Show when={children.error}>
          <div
            class="flex items-center gap-1.5 px-1.5 py-1 text-xs text-[var(--color-err)]"
            style={{ "padding-left": `${22 + props.depth * 12}px` }}
            title={String(children.error)}
          >
            <span class="truncate">Couldn't read this folder</span>
          </div>
        </Show>
        {/* Guard the For: a Solid resource value accessor re-throws once the
            fetcher rejected, so reading children() while errored would abort
            this node's render (the error row above would never commit) and
            emit a recurring unhandled rejection on each watcher re-key. */}
        <Show when={!children.error}>
          <For each={children() ?? []}>
            {(child) =>
              child.isDir ? (
                <DirectoryNode
                  path={child.path}
                  relPath={child.relPath}
                  name={child.name}
                  depth={props.depth + 1}
                  activeRelPath={props.activeRelPath}
                  onOpen={props.onOpen}
                  onFileMenu={props.onFileMenu}
                  onDirMenu={props.onDirMenu}
                  collapseGeneration={props.collapseGeneration}
                />
              ) : (
                <FileEntry
                  node={child}
                  depth={props.depth + 1}
                  active={props.activeRelPath === child.relPath}
                  onOpen={props.onOpen}
                  onMenu={props.onFileMenu}
                />
              )
            }
          </For>
        </Show>
      </Show>
    </div>
  );
};

const FileEntry: Component<{
  node: FileNode;
  depth: number;
  active: boolean;
  onOpen: (relPath: string) => void;
  onMenu?: (node: FileNode, e: MouseEvent) => void;
}> = (props) => {
  const Icon = pickIcon(props.node.name);
  return (
    <button
      type="button"
      role="treeitem"
      aria-level={props.depth}
      tabIndex={-1}
      onClick={() => props.onOpen(props.node.relPath)}
      onContextMenu={(e) => props.onMenu?.(props.node, anchoredMenuEvent(e))}
      onKeyDown={(e) => {
        if (!isMenuKey(e)) return;
        e.preventDefault();
        e.stopPropagation();
        props.onMenu?.(props.node, menuEventAtRect(e.currentTarget));
      }}
      // aria-selected is the tree-idiomatic selection attribute; aria-current
      // stays alongside it for consumers that surface the "current" landmark.
      aria-selected={props.active ? "true" : undefined}
      aria-current={props.active ? "true" : undefined}
      class={`lift flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-base ${
        props.active
          ? "side-active bg-[var(--color-selection-bg)] text-fg-1"
          : "text-fg-2 hover:bg-[var(--color-control-fill)]"
      }`}
      classList={{ "min-h-11": touchAffordances() }}
      style={{
        "padding-left": `${22 + props.depth * (touchAffordances() ? 16 : 12)}px`,
      }}
    >
      <Icon class="ui-icon-menu text-fg-3" />
      <span class="truncate">{props.node.name}</span>
    </button>
  );
};

function pickIcon(name: string): Component<{ size?: number; class?: string }> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tex") || lower.endsWith(".typ") || lower.endsWith(".md")) {
    return FileText;
  }
  return FileIcon;
}
