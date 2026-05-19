import {
  ChevronDown,
  ChevronUp,
  CircleDot,
  FilePlus,
  FolderPlus,
  Inbox,
  ListTree,
  MoreHorizontal,
  Search,
  Zap,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { FileTree } from "~/components/editor/FileTree";
import { activeFile, project } from "~/stores/editor-store";
import { compileEngine } from "~/stores/settings-store";
import { KbdHint } from "~/components/primitives/KbdHint";

const ENGINE_LABEL: Record<string, string> = {
  "system-tex": "pdflatex",
  tectonic: "Tectonic (xelatex)",
  busytex: "busytex (WASM)",
};

/**
 * Shared left sidebar for the editor's TextShell.
 * Owns search + tabs + FileTree + outline + project footer. Lives in its
 * own file to keep the shell component lean.
 *
 * Selection state (which tab is active, whether the outline is
 * collapsed) is owned by the parent shell — keeps the sidebar reusable
 * and lets future shells decide what tabs they support.
 */

export type LeftTab = "files" | "review" | "todo";

interface EditorSidebarProps {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  outlineCollapsed: boolean;
  setOutlineCollapsed: (fn: (v: boolean) => boolean) => void;
  onSelectFile: (relPath: string) => void;
}

export const EditorSidebar: Component<EditorSidebarProps> = (props) => {
  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      <div class="flex-shrink-0 border-b border-glass-stroke p-2.5">
        <button
          type="button"
          class="lift glass-inset flex w-full items-center gap-2 rounded-lg px-2.5 text-[length:var(--ui-font-sm)] text-fg-3 hover:text-fg-2"
          style={{ height: "var(--ui-row)" }}
        >
          <Search class="ui-icon-menu" style={{ opacity: 0.6 }} />
          <span>Search files…</span>
          <span class="ml-auto">
            <KbdHint shortcut="Mod+P" />
          </span>
        </button>
      </div>

      {/* Tab row — Files / Review / TODO. */}
      <div class="flex flex-shrink-0 items-center gap-0 border-b border-glass-stroke px-2 pt-1.5">
        <For
          each={[
            { id: "files" as LeftTab, label: "Files" },
            { id: "review" as LeftTab, label: "Review", count: 0 },
            { id: "todo" as LeftTab, label: "TODO", count: 0 },
          ]}
        >
          {(t) => {
            const active = () => props.tab === t.id;
            return (
              <button
                type="button"
                onClick={() => props.setTab(t.id)}
                class={`relative flex items-center gap-1.5 px-2.5 text-[length:var(--ui-font-base)] font-medium ${
                  active() ? "text-fg-1" : "text-fg-3 hover:text-fg-2"
                }`}
                style={{ height: "var(--ui-row)" }}
              >
                {t.label}
                <Show when={t.count != null}>
                  <span
                    class="mono rounded-full px-1.5 py-0.5 text-[length:var(--ui-font-xs)]"
                    style={{
                      background: active()
                        ? "rgba(139,92,246,0.18)"
                        : "var(--color-control-fill)",
                      color: active() ? "var(--color-accent-1)" : "var(--color-fg-3)",
                    }}
                  >
                    {t.count}
                  </span>
                </Show>
                <Show when={active()}>
                  <span
                    class="absolute -bottom-px left-2.5 right-2.5 h-[2px] rounded"
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

      {/* "Files" section header (was inside FileTree) — uppercase label on
        the left, new-folder / new-file / more action icons on the right. */}
      <Show when={props.tab === "files"}>
        <div
          class="flex h-9 flex-shrink-0 items-center justify-between px-3 text-[length:var(--ui-font-xs)] uppercase tracking-[0.1em] text-fg-3"
        >
          <span>Files</span>
          <div class="flex items-center gap-0.5">
            <button
              type="button"
              title="New folder"
              class="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
            >
              <FolderPlus class="ui-icon-menu" style={{ opacity: 0.8 }} />
            </button>
            <button
              type="button"
              title="New file"
              class="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
            >
              <FilePlus class="ui-icon-menu" style={{ opacity: 0.8 }} />
            </button>
            <button
              type="button"
              title="More"
              class="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
            >
              <MoreHorizontal class="ui-icon-menu" style={{ opacity: 0.8 }} />
            </button>
          </div>
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-auto scroll">
        <Show when={props.tab === "files" && project()}>
          <FileTree
            rootPath={project()!.rootPath}
            activeRelPath={activeFile()?.relPath ?? null}
            onOpen={props.onSelectFile}
          />
        </Show>
        <Show when={props.tab === "review"}>
          <EmptyTab
            icon={<Inbox size={20} />}
            title="No reviews yet"
            body="Once collaborators leave comments on your draft, they'll appear here. Phase 4 unlocks real-time review."
          />
        </Show>
        <Show when={props.tab === "todo"}>
          <EmptyTab
            icon={<CircleDot size={20} />}
            title="No TODOs"
            body="Mark passages with comments like %! TODO: tighten proof — they'll be collected here."
          />
        </Show>
      </div>

      <OutlinePanel
        collapsed={props.outlineCollapsed}
        onToggle={() => props.setOutlineCollapsed((v) => !v)}
      />

      <div class="flex-shrink-0 space-y-2.5 border-t border-glass-stroke p-3">
        <div class="flex items-center justify-between">
          <span class="label-xs text-fg-3">Project</span>
          <div class="mono flex items-center gap-1.5 text-[11px] text-fg-2">
            <ListTree size={10} style={{ opacity: 0.7 }} />
            main · local
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2">
          <Stat label="Words" value={wordCount()} />
          <Stat label="Lines" value={lineCount()} />
          <Stat label="Files" value="—" />
        </div>
        <Show when={project()?.format === "latex"}>
          <div class="glass-soft flex items-center gap-2 rounded-lg px-2.5 py-2">
            <Zap size={12} style={{ color: "var(--color-accent-1)" }} />
            <span class="text-[11px] text-fg-2">Engine</span>
            <span class="mono ml-auto text-[11px] text-fg-1">
              {ENGINE_LABEL[compileEngine()] ?? compileEngine()}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
};


const Stat: Component<{ label: string; value: string }> = (props) => (
  <div class="glass-soft rounded-lg px-2 py-1.5">
    <div class="label-xs text-fg-3">{props.label}</div>
    <div class="mono mt-0.5 text-[13px] font-semibold text-fg-1">
      {props.value}
    </div>
  </div>
);

const wordCount = (): string => {
  const f = activeFile();
  if (!f) return "—";
  return f.content
    .replace(/[\s ]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .length.toLocaleString();
};

const lineCount = (): string => {
  const f = activeFile();
  if (!f) return "—";
  return f.content.split("\n").length.toLocaleString();
};

const EmptyTab: Component<{ icon: JSX.Element; title: string; body: string }> = (
  props,
) => (
  <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
    <div
      class="flex h-10 w-10 items-center justify-center rounded-full"
      style={{ background: "var(--color-control-fill)" }}
    >
      {props.icon}
    </div>
    <div class="text-[13px] font-semibold text-fg-1">{props.title}</div>
    <div class="text-[11px] leading-relaxed text-fg-3">{props.body}</div>
  </div>
);

const OutlinePanel: Component<{ collapsed: boolean; onToggle: () => void }> = (
  props,
) => {
  return (
    <div class="flex-shrink-0 border-t border-glass-stroke">
      <button
        type="button"
        onClick={props.onToggle}
        class="lift flex h-9 w-full items-center gap-2 px-3 hover:bg-[var(--color-control-fill)]"
      >
        <ListTree size={12} style={{ opacity: 0.65 }} />
        <span class="text-[12px] font-medium text-fg-2">Outline</span>
        <span class="mono text-[10px] text-fg-3">document structure</span>
        <Show
          when={props.collapsed}
          fallback={<ChevronDown size={12} class="ml-auto opacity-55" />}
        >
          <ChevronUp size={12} class="ml-auto opacity-55" />
        </Show>
      </button>
      <Show when={!props.collapsed}>
        <div class="max-h-[200px] space-y-1.5 overflow-auto scroll px-2.5 pb-2.5">
          <div class="text-[11px] text-fg-3 px-2 py-1.5 italic">
            Outline tracking lands when CodeMirror's structure tree wires up to
            the editor (Phase 2 polish).
          </div>
        </div>
      </Show>
    </div>
  );
};
