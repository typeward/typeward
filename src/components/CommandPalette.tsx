import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import { Command, FileText, Sparkles } from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
} from "solid-js";
import type { EditorCommand, Project } from "~/adapters/types";
import { closePalette } from "~/commands/actions";
import {
  navigateTo,
  noteRecentCommand,
  paletteOpen_,
  paletteSeedGeneration_,
  recentCommandIds_,
  takePaletteSeedQuery,
} from "~/commands/palette-store";
import { commands as registryCommands } from "~/commands/registry";
import { dispatchCommand } from "~/commands/run";
import { scoreFields } from "~/lib/fuzzy";
import { shortcutTokens } from "~/lib/shortcuts";
import {
  activateFileByRelPath,
  project,
  requestGotoSource,
} from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { isTrashed, projects } from "~/stores/projects-store";
import { fsVersion } from "~/stores/watcher-store";

/**
 * Shared command palette overlay. Renders once at the App root so Cmd+K
 * works on every screen. Reads commands from the registry, recent projects
 * from projects-store, and (when a project is open) the project's text files
 * for quick-open — a "file:" query prefix (what Mod+P seeds) narrows to files
 * only. Matching is the scored fuzzy matcher in lib/fuzzy; with a query the
 * results flatten into one rank-ordered list, without one the grouped view
 * returns with a "Recently used" section on top. Arrow keys navigate; Enter
 * runs the highlighted row. Esc dismissal goes through `core.closePalette`
 * from the keyboard router.
 */

interface PaletteRow {
  kind: "command" | "project" | "file";
  /** Stable id used for selection state. */
  id: string;
  /** Display title. */
  title: string;
  /** Secondary line under the title. */
  subtitle?: string;
  /** Tokens rendered as <kbd> chips on the right. */
  shortcut?: string;
  /** Group label shown above the first row of each group. */
  group: string;
  run: () => void;
}

// Per-field fuzzy weights: title hits outrank subtitle hits outrank id/group.
const W_TITLE = 1;
const W_SUBTITLE = 0.7;
const W_META = 0.4;

/** Hard cap on rendered rows in ranked/file mode — the listbox scrolls, but
 *  thousands of buttons would make every keystroke re-render sluggish. */
const RANKED_ROW_CAP = 250;

interface FileHit {
  name: string;
  relPath: string;
}

const FILE_INDEX_CAP = 2000;
const FILE_INDEX_MAX_DEPTH = 12;

// Quick-open targets are files the editor can actually open as text — the
// same families the compile walkers and FileTree care about.
const TEXT_FILE_RE =
  /\.(tex|typ|md|bib|cls|sty|bst|def|ldf|fd|clo|cnf|txt|csv|json|ya?ml|toml)$/i;

// Mirrors FileTree's shouldHide pruning (dotfiles cover .git/.typeward) plus
// the junk directories the walker must not descend into.
const skipEntry = (name: string): boolean => {
  if (name.startsWith(".")) return true;
  return (
    name === "node_modules" || name === "build" || name === "out" || name === "dist"
  );
};

const joinPath = (parent: string, name: string): string => {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  return parent.includes("\\") ? `${parent}\\${name}` : `${parent}/${name}`;
};

async function walkProjectFiles(root: string): Promise<FileHit[]> {
  const out: FileHit[] = [];
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (out.length >= FILE_INDEX_CAP || depth > FILE_INDEX_MAX_DEPTH) return;
    let entries: DirEntry[];
    try {
      entries = await readDir(abs);
    } catch {
      // Unreadable subtree (permissions, race with a delete) — index the rest.
      return;
    }
    for (const e of entries) {
      if (out.length >= FILE_INDEX_CAP) return;
      if (skipEntry(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        await walk(joinPath(abs, e.name), childRel, depth + 1);
      } else if (TEXT_FILE_RE.test(e.name)) {
        out.push({ name: e.name, relPath: childRel });
      }
    }
  };
  await walk(root, "", 0);
  return out;
}

// Cached across palette opens; the key folds in fsVersion so any watcher
// event invalidates it (same re-key scheme FileTree uses).
let fileIndexCache: { key: string; files: FileHit[] } | null = null;

const isRunnable = (cmd: EditorCommand): boolean => {
  if (!cmd.when) return true;
  try {
    return cmd.when();
  } catch {
    return false;
  }
};

export const CommandPalette: Component = () => {
  const [query, setQuery] = createSignal("");
  const [selectedIdx, setSelectedIdx] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let restoreFocusTo: HTMLElement | null = null;

  createEffect(() => {
    if (paletteOpen_()) {
      restoreFocusTo =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setQuery(takePaletteSeedQuery() ?? "");
      setSelectedIdx(0);
      // Defer focus until the input has actually rendered.
      queueMicrotask(() => inputRef?.focus());
    } else if (restoreFocusTo) {
      // Hand focus back on close — otherwise it drops to <body> and the
      // keyboard router gates every editor-scoped shortcut until a click.
      if (restoreFocusTo.isConnected) restoreFocusTo.focus();
      else getActiveEditorView()?.focus();
      restoreFocusTo = null;
    }
  });

  // Seeding an ALREADY-open palette (Mod+P while Mod+K is up): the open state
  // doesn't change, so adopt the new query here. On a fresh open the seed was
  // already consumed by the open effect above and this finds nothing.
  createEffect(
    on(
      paletteSeedGeneration_,
      () => {
        if (!paletteOpen_()) return;
        const q = takePaletteSeedQuery();
        if (q === null) return;
        setQuery(q);
        setSelectedIdx(0);
        queueMicrotask(() => inputRef?.focus());
      },
      { defer: true },
    ),
  );

  // Quick-open file index: walked lazily on palette open, re-keyed by watcher
  // events, served from the module cache when nothing changed.
  const [fileIndex] = createResource(
    () => {
      const proj = project();
      return paletteOpen_() && proj ? `${proj.rootPath}|${fsVersion()}` : null;
    },
    async (key) => {
      if (fileIndexCache?.key === key) return fileIndexCache.files;
      const root = project()?.rootPath;
      if (!root) return [];
      const files = await walkProjectFiles(root);
      fileIndexCache = { key, files };
      return files;
    },
  );

  const rows = createMemo<PaletteRow[]>(() => {
    const raw = query().trim();
    // "file:" prefix = quick-open mode (what Mod+P seeds): files only,
    // matched against the remainder of the query.
    const fileMode = raw.toLowerCase().startsWith("file:");
    const q = fileMode ? raw.slice("file:".length).trim() : raw;

    const toCommandRow = (c: EditorCommand, group: string): PaletteRow => ({
      kind: "command",
      id: c.id,
      title: c.title,
      subtitle: c.subtitle,
      shortcut: c.shortcut,
      group,
      run: () => {
        noteRecentCommand(c.id);
        closePalette();
        dispatchCommand(c);
      },
    });
    const toProjectRow = (p: Project, group: string): PaletteRow => ({
      kind: "project",
      id: `project:${p.rootPath}`,
      title: p.name,
      subtitle: `${p.format} · ${p.rootFile}`,
      group,
      run: () => {
        closePalette();
        openProject(p);
      },
    });
    const toFileRow = (f: FileHit, group: string): PaletteRow => ({
      kind: "file",
      id: `file:${f.relPath}`,
      title: f.name,
      subtitle: f.relPath,
      group,
      run: () => {
        closePalette();
        // Already-open tabs activate in place (keeps cursor/scroll); the goto
        // intent — which force-moves the caret — is only for unopened files.
        if (!activateFileByRelPath(f.relPath)) requestGotoSource(f.relPath, 1);
      },
    });

    let fileHits: FileHit[] = [];
    // File rows only make sense with the editor mounted — from the Projects/
    // Settings screens their goto intent has no consumer (same gate as the
    // core.quickOpen command).
    if (document.querySelector("[data-editor-shell]") !== null) {
      try {
        fileHits = fileIndex() ?? [];
      } catch {
        // Resource accessor re-throws a failed walk — the palette still works
        // without file rows.
      }
    }

    if (fileMode) {
      return fileHits
        .map((f) => ({
          f,
          score: scoreFields(q, [
            { text: f.name, weight: W_TITLE },
            { text: f.relPath, weight: W_META },
          ]),
        }))
        .filter((s): s is { f: FileHit; score: number } => s.score !== null)
        .sort((a, b) => b.score - a.score || a.f.relPath.length - b.f.relPath.length)
        .slice(0, RANKED_ROW_CAP)
        .map((s) => toFileRow(s.f, "Files"));
    }

    const visibleCommands = registryCommands()
      .filter(isRunnable)
      // Hide bookkeeping commands like the Esc-to-close binding — they
      // exist for the keyboard router, not the palette UI.
      .filter((c) => c.id !== "core.closePalette" && c.id !== "core.togglePalette");
    const openProjects = projects().filter((p) => !isTrashed(p));

    if (!q) {
      // Grouped browse view: recently-used commands first, then recent
      // projects, then every command under its own group.
      const byId = new Map(visibleCommands.map((c) => [c.id, c]));
      const recentRows = recentCommandIds_()
        .map((id) => byId.get(id))
        .filter((c): c is EditorCommand => c !== undefined)
        .map((c) => toCommandRow(c, "Recently used"));
      const projectRows = openProjects
        .slice(0, 5)
        .map((p) => toProjectRow(p, "Recent projects"));
      const cmdRows = visibleCommands.map((c) =>
        toCommandRow(c, c.group ?? "Commands"),
      );
      return [...recentRows, ...projectRows, ...cmdRows];
    }

    // Ranked mode: one flat list across commands, projects, and files,
    // highest score first; ties break toward shorter titles.
    const scored: Array<{ row: PaletteRow; score: number }> = [];
    for (const c of visibleCommands) {
      const score = scoreFields(q, [
        { text: c.title, weight: W_TITLE },
        { text: c.subtitle, weight: W_SUBTITLE },
        { text: c.id, weight: W_META },
        { text: c.group, weight: W_META },
      ]);
      if (score !== null) scored.push({ row: toCommandRow(c, "Results"), score });
    }
    for (const p of openProjects) {
      const score = scoreFields(q, [
        { text: p.name, weight: W_TITLE },
        { text: p.rootFile, weight: W_SUBTITLE },
        { text: p.format, weight: W_META },
      ]);
      if (score !== null) scored.push({ row: toProjectRow(p, "Results"), score });
    }
    for (const f of fileHits) {
      const score = scoreFields(q, [
        { text: f.name, weight: W_TITLE },
        { text: f.relPath, weight: W_META },
      ]);
      if (score !== null) scored.push({ row: toFileRow(f, "Results"), score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.row.title.length - b.row.title.length)
      .slice(0, RANKED_ROW_CAP)
      .map((s) => s.row);
  });

  // Group rows by their `group` field while preserving order — render
  // sections with the group label as a header. The absolute index rides
  // along so rows don't need an O(n) indexOf per render.
  const groupedRows = createMemo(() => {
    const list = rows();
    const groups: Array<{
      label: string;
      rows: Array<{ row: PaletteRow; idx: number }>;
    }> = [];
    list.forEach((row, idx) => {
      const last = groups[groups.length - 1];
      if (last && last.label === row.group) {
        last.rows.push({ row, idx });
      } else {
        groups.push({ label: row.group, rows: [{ row, idx }] });
      }
    });
    return groups;
  });

  createEffect(() => {
    // Clamp the selection when the row count shrinks.
    const max = rows().length;
    if (selectedIdx() >= max) setSelectedIdx(Math.max(0, max - 1));
  });

  // Selection is aria-activedescendant, not DOM focus, so keyboard moves
  // don't scroll natively — keep the highlighted row inside the fold.
  createEffect(
    on(selectedIdx, (i) => {
      document
        .getElementById(`palette-option-${i}`)
        ?.scrollIntoView({ block: "nearest" });
    }),
  );

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const max = rows().length;
      setSelectedIdx((i) => (max === 0 ? 0 : (i + 1) % max));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const max = rows().length;
      setSelectedIdx((i) => (max === 0 ? 0 : (i - 1 + max) % max));
    } else if (e.key === "Enter") {
      if (e.isComposing) return;
      e.preventDefault();
      const row = rows()[selectedIdx()];
      if (row) row.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "Tab") {
      // Focus trap: the palette is the only interactive surface while open;
      // letting Tab walk into the obscured background loses the keyboard user.
      e.preventDefault();
    }
  };

  return (
    <Show when={paletteOpen_()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[120px]"
        style={{
          background: "var(--color-overlay-scrim)",
          "backdrop-filter": "blur(2px) saturate(120%)",
        }}
        onClick={() => closePalette()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          class="glass glow-accent w-[560px] overflow-hidden rounded-2xl"
          onClick={(e) => e.stopPropagation()}
          style={{ background: "var(--color-popover-bg)" }}
          onKeyDown={handleKey}
        >
          <div class="flex h-[52px] items-center gap-3 border-b border-glass-stroke px-4">
            <Sparkles size={14} style={{ opacity: 0.6 }} />
            <input
              ref={(el) => (inputRef = el)}
              placeholder="Search commands, files, and projects…"
              value={query()}
              role="combobox"
              aria-label="Search commands, files, and projects"
              aria-expanded="true"
              aria-controls="palette-listbox"
              aria-activedescendant={
                rows().length > 0 ? `palette-option-${selectedIdx()}` : undefined
              }
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSelectedIdx(0);
              }}
              class="flex-1 rounded-md bg-transparent text-base text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
            />
            <kbd
              class="mono rounded px-1.5 py-0.5 text-[10px] text-fg-2"
              style={{
                background: "var(--color-control-fill)",
                border: "1px solid var(--color-control-stroke)",
              }}
            >
              esc
            </kbd>
          </div>

          <div
            id="palette-listbox"
            role="listbox"
            aria-label="Results"
            class="max-h-[360px] overflow-auto scroll p-2"
          >
            <Show
              when={rows().length > 0}
              fallback={
                <div class="px-3 py-8 text-center text-sm text-fg-3">
                  No matches for "{query()}"
                </div>
              }
            >
              <For each={groupedRows()}>
                {(g) => (
                  <div>
                    <div class="label-xs px-2.5 pb-1.5 pt-2 text-fg-3">{g.label}</div>
                    <For each={g.rows}>
                      {({ row, idx }) => {
                        const active = () => idx === selectedIdx();
                        return (
                          <button
                            type="button"
                            id={`palette-option-${idx}`}
                            role="option"
                            aria-selected={active()}
                            onClick={() => row.run()}
                            onMouseEnter={() => setSelectedIdx(idx)}
                            class={`flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left ${
                              active()
                                ? "bg-[var(--color-control-fill-hover)]"
                                : "hover:bg-[var(--color-control-fill)]"
                            }`}
                          >
                            <div
                              class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
                              style={{ background: "var(--color-control-fill)" }}
                            >
                              <Show
                                when={row.kind === "file"}
                                fallback={<Command size={12} />}
                              >
                                <FileText size={12} />
                              </Show>
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="truncate text-base text-fg-1">
                                {row.title}
                              </div>
                              <Show when={row.subtitle}>
                                <div class="mono truncate text-[10px] text-fg-3">
                                  {row.subtitle}
                                </div>
                              </Show>
                            </div>
                            <Show when={row.shortcut}>
                              <div class="flex items-center gap-0.5">
                                <For each={shortcutTokens(row.shortcut!)}>
                                  {(tok) => (
                                    <kbd
                                      class="mono rounded px-1.5 py-0.5 text-[10px] text-fg-2"
                                      style={{
                                        background: "var(--color-control-fill)",
                                        border: "1px solid var(--color-control-stroke)",
                                      }}
                                    >
                                      {tok}
                                    </kbd>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </div>

          <div class="mono flex h-[34px] items-center gap-3 border-t border-glass-stroke px-3 text-xs text-fg-3">
            <span class="flex items-center gap-1">
              <kbd
                class="rounded px-1 py-0.5 text-[10px]"
                style={{
                  background: "var(--color-control-fill)",
                  border: "1px solid var(--color-control-stroke)",
                }}
              >
                ↑↓
              </kbd>
              navigate
            </span>
            <span class="flex items-center gap-1">
              <kbd
                class="rounded px-1 py-0.5 text-[10px]"
                style={{
                  background: "var(--color-control-fill)",
                  border: "1px solid var(--color-control-stroke)",
                }}
              >
                ↵
              </kbd>
              run
            </span>
            <span class="ml-auto flex items-center gap-1.5">
              <span class="h-3 w-3 rounded accent-grad" />
              Typeward
            </span>
          </div>
        </div>
      </div>
    </Show>
  );
};

const openProject = (p: Project) => {
  navigateTo(`/editor?path=${encodeURIComponent(p.rootPath)}`);
};
