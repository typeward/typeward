import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import { ChevronRight, File as FileIcon, FileText, Folder } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createResource, createSignal } from "solid-js";
import { fsVersion } from "~/stores/watcher-store";

interface FileTreeProps {
  rootPath: string;
  /** Relative path of the currently-open file, e.g. "main.tex". */
  activeRelPath: string | null;
  onOpen: (relPath: string) => void;
}

interface FileNode {
  name: string;
  /** Absolute path. */
  path: string;
  /** Path relative to root. */
  relPath: string;
  isDir: boolean;
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

// Roving arrow-key navigation over the rendered row buttons (DOM order
// matches visual order). Rows stay plain tabbable <button>s — the rove is an
// ergonomics layer, not a full ARIA tree.
function handleTreeKeydown(e: KeyboardEvent & { currentTarget: HTMLElement }) {
  const rows = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
  );
  if (rows.length === 0) return;
  const current =
    document.activeElement instanceof HTMLButtonElement
      ? rows.indexOf(document.activeElement)
      : -1;
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
    if (el?.getAttribute("aria-expanded") === "false") el.click();
  } else if (e.key === "ArrowLeft") {
    const el = rows[current];
    if (el?.getAttribute("aria-expanded") === "true") el.click();
  } else {
    return;
  }
  e.preventDefault();
}

export const FileTree: Component<FileTreeProps> = (props) => {
  // The "Files" section header used to live here; it's now owned by
  // EditorSidebar so action icons (new folder / new file / more) can sit
  // across from it in the same row.
  return (
    <div
      class="scroll h-full overflow-auto px-1.5 pb-2"
      onKeyDown={handleTreeKeydown}
    >
      <DirectoryNode
        path={props.rootPath}
        relPath=""
        name="root"
        depth={0}
        activeRelPath={props.activeRelPath}
        onOpen={props.onOpen}
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
  startExpanded?: boolean;
}

const DirectoryNode: Component<DirectoryNodeProps> = (props) => {
  const [expanded, setExpanded] = createSignal(props.startExpanded ?? false);
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

  return (
    <div>
      <Show when={props.depth > 0}>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded()}
          aria-label={`${expanded() ? "Collapse" : "Expand"} ${props.name}`}
          class="lift flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-base text-fg-2 hover:bg-[var(--color-control-fill)]"
          style={{ "padding-left": `${4 + props.depth * 12}px` }}
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
                />
              ) : (
                <FileEntry
                  node={child}
                  depth={props.depth + 1}
                  active={props.activeRelPath === child.relPath}
                  onOpen={props.onOpen}
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
}> = (props) => {
  const Icon = pickIcon(props.node.name);
  return (
    <button
      type="button"
      onClick={() => props.onOpen(props.node.relPath)}
      aria-current={props.active ? "true" : undefined}
      class={`lift flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-base ${
        props.active
          ? "bg-[var(--color-control-fill-hover)] text-fg-1"
          : "text-fg-2 hover:bg-[var(--color-control-fill)]"
      }`}
      style={{ "padding-left": `${22 + props.depth * 12}px` }}
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
