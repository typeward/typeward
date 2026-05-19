import { Command, Sparkles } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { EditorCommand, Project } from "~/adapters/types";
import { closePalette } from "~/commands/actions";
import { paletteOpen_ } from "~/commands/palette-store";
import { commands as registryCommands } from "~/commands/registry";
import { shortcutTokens } from "~/lib/shortcuts";
import { projects } from "~/stores/projects-store";

/**
 * Shared command palette overlay. Renders once at the App root so Cmd+K
 * works on every screen. Reads commands from the registry and recent
 * projects from projects-store. Arrow keys navigate; Enter runs the
 * highlighted row. Esc dismissal goes through `core.closePalette` from
 * the keyboard router.
 */

interface PaletteRow {
  kind: "command" | "project";
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

const matchesQuery = (q: string, ...fields: Array<string | undefined>): boolean => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f && f.toLowerCase().includes(needle));
};

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

  createEffect(() => {
    if (paletteOpen_()) {
      setQuery("");
      setSelectedIdx(0);
      // Defer focus until the input has actually rendered.
      queueMicrotask(() => inputRef?.focus());
    }
  });

  const rows = createMemo<PaletteRow[]>(() => {
    const q = query();
    const cmdRows: PaletteRow[] = registryCommands()
      .filter(isRunnable)
      // Hide bookkeeping commands like the Esc-to-close binding — they
      // exist for the keyboard router, not the palette UI.
      .filter((c) => c.id !== "core.closePalette" && c.id !== "core.togglePalette")
      .filter((c) =>
        matchesQuery(q, c.title, c.subtitle, c.id, c.group),
      )
      .map<PaletteRow>((c) => ({
        kind: "command",
        id: c.id,
        title: c.title,
        subtitle: c.subtitle,
        shortcut: c.shortcut,
        group: c.group ?? "Commands",
        run: () => {
          closePalette();
          void c.run();
        },
      }));

    const recentProjects: PaletteRow[] = projects()
      .filter((p) => matchesQuery(q, p.name, p.rootFile, p.format))
      .slice(0, 5)
      .map<PaletteRow>((p) => ({
        kind: "project",
        id: `project:${p.rootPath}`,
        title: p.name,
        subtitle: `${p.format} · ${p.rootFile}`,
        group: "Recent projects",
        run: () => {
          closePalette();
          openProject(p);
        },
      }));

    // Projects first when query is empty (matches design's "Recent" section),
    // commands first when the user is searching for something specific.
    return q
      ? [...cmdRows, ...recentProjects]
      : [...recentProjects, ...cmdRows];
  });

  // Group rows by their `group` field while preserving order — render
  // sections with the group label as a header.
  const groupedRows = createMemo(() => {
    const list = rows();
    const groups: Array<{ label: string; rows: PaletteRow[] }> = [];
    for (const row of list) {
      const last = groups[groups.length - 1];
      if (last && last.label === row.group) {
        last.rows.push(row);
      } else {
        groups.push({ label: row.group, rows: [row] });
      }
    }
    return groups;
  });

  createEffect(() => {
    // Clamp the selection when the row count shrinks.
    const max = rows().length;
    if (selectedIdx() >= max) setSelectedIdx(Math.max(0, max - 1));
  });

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
      e.preventDefault();
      const row = rows()[selectedIdx()];
      if (row) row.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  };

  return (
    <Show when={paletteOpen_()}>
      <div
        class="fixed inset-0 z-50 flex items-start justify-center pt-[120px]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(10,11,15,0.55) 0%, rgba(10,11,15,0.85) 100%)",
          "backdrop-filter": "blur(2px) saturate(120%)",
        }}
        onClick={() => closePalette()}
      >
        <div
          class="glass glow-violet w-[560px] overflow-hidden rounded-2xl"
          onClick={(e) => e.stopPropagation()}
          style={{ background: "var(--color-popover-bg)" }}
          onKeyDown={handleKey}
        >
          <div class="flex h-[52px] items-center gap-3 border-b border-glass-stroke px-4">
            <Sparkles size={14} style={{ opacity: 0.6 }} />
            <input
              ref={(el) => (inputRef = el)}
              placeholder="Jump to project, command, or paper…"
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSelectedIdx(0);
              }}
              class="flex-1 bg-transparent text-[14px] text-fg-1 placeholder:text-fg-3 focus:outline-none"
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

          <div class="max-h-[360px] overflow-auto scroll p-2">
            <Show
              when={rows().length > 0}
              fallback={
                <div class="px-3 py-8 text-center text-[12px] text-fg-3">
                  No matches for "{query()}"
                </div>
              }
            >
              <For each={groupedRows()}>
                {(g) => (
                  <div>
                    <div class="label-xs px-2.5 pb-1.5 pt-2 text-fg-3">{g.label}</div>
                    <For each={g.rows}>
                      {(row) => {
                        const idx = () => rows().indexOf(row);
                        const active = () => idx() === selectedIdx();
                        return (
                          <button
                            type="button"
                            onClick={() => row.run()}
                            onMouseEnter={() => setSelectedIdx(idx())}
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
                              <Command size={12} />
                            </div>
                            <div class="min-w-0 flex-1">
                              <div class="truncate text-[13px] text-fg-1">
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

          <div class="mono flex h-[34px] items-center gap-3 border-t border-glass-stroke px-3 text-[11px] text-fg-3">
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
  // Lazy import to avoid pulling palette-store ↔ actions cycle at module load.
  import("~/commands/palette-store").then(({ navigateTo }) => {
    navigateTo(`/editor?path=${encodeURIComponent(p.rootPath)}`);
  });
};
