import {
  ChevronDown,
  ChevronUp,
  CircleDot,
  FilePlus,
  ListTree,
  Zap,
} from "lucide-solid";
import { exists } from "@tauri-apps/plugin-fs";
import type { Component, JSX } from "solid-js";
import { For, Show, createEffect, createResource, createSignal } from "solid-js";
import { FileTree } from "~/components/editor/FileTree";
import { ReferencesPanel } from "~/components/references/ReferencesPanel";
import { CommitPanel } from "~/components/vcs/CommitPanel";
import { ReviewPanel } from "~/components/reviews/ReviewPanel";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";
import { activeFile, project } from "~/stores/editor-store";
import { compileEngine, integrationsSettings } from "~/stores/settings-store";
import { allOpenThreadCount } from "~/stores/review-store";

const ENGINE_LABEL: Record<string, string> = {
  "system-tex": "pdflatex",
  tectonic: "Tectonic (xelatex)",
  "texlive-wasm": "TeX Live (WASM)",
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

export type LeftTab = "files" | "references" | "scm" | "review" | "todo";

interface EditorSidebarProps {
  tab: LeftTab;
  setTab: (t: LeftTab) => void;
  outlineCollapsed: boolean;
  setOutlineCollapsed: (fn: (v: boolean) => boolean) => void;
  onSelectFile: (relPath: string) => void;
}

export const EditorSidebar: Component<EditorSidebarProps> = (props) => {
  const [newFileOpen, setNewFileOpen] = createSignal(false);
  const [newFileName, setNewFileName] = createSignal("");
  const [newFileError, setNewFileError] = createSignal<string | null>(null);

  // The SCM tab is meaningless outside a git repo — `.git` can be a dir or
  // (worktrees) a file; `exists` covers both. Non-Tauri contexts resolve
  // false and simply hide the tab.
  const [isGitRepo] = createResource(
    () => project()?.rootPath ?? null,
    async (root) => {
      if (!root) return false;
      try {
        return await exists(`${root}/.git`);
      } catch {
        return false;
      }
    },
    { initialValue: false },
  );

  // If SCM was active and the project switched to a non-repo, the tab
  // strip no longer shows it — bounce back to Files.
  createEffect(() => {
    if (!isGitRepo() && props.tab === "scm") props.setTab("files");
  });

  // Refs only earns a tab once at least one citation provider is set up —
  // an empty panel teaches users to ignore the sidebar.
  const hasReferences = () => {
    const refs = integrationsSettings().references;
    return (
      refs.betterBibTex.enabled ||
      Boolean(refs.zoteroWeb.userId) ||
      Boolean(refs.mendeley.profileId)
    );
  };
  createEffect(() => {
    if (!hasReferences() && props.tab === "references") props.setTab("files");
  });

  const createNewFile = async () => {
    const p = project();
    const name = newFileName().trim().replace(/\\/g, "/");
    if (!p || !name) return;
    try {
      // The IPC validates the project-relative path and creates parent
      // dirs, so "chapters/intro.tex" also works as a folder shortcut.
      await ipc.writeProjectTextFile(p.rootPath, name, "");
      setNewFileOpen(false);
      setNewFileName("");
      setNewFileError(null);
      props.onSelectFile(name);
    } catch (e) {
      setNewFileError(String(e));
      recordError("new-file", `creating ${name} failed`, e);
    }
  };

  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      {/* Tab row — Files / Review / TODO. SCM only inside git repos; Refs
          only when a citation provider is configured. */}
      <div class="flex flex-shrink-0 items-center gap-0 border-b border-glass-stroke px-2 pt-1.5">
        <For
          each={[
            { id: "files" as LeftTab, label: "Files" },
            ...(hasReferences() ? [{ id: "references" as LeftTab, label: "Refs" }] : []),
            ...(isGitRepo() ? [{ id: "scm" as LeftTab, label: "SCM" }] : []),
            { id: "review" as LeftTab, label: "Review", count: allOpenThreadCount() },
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

      {/* "Files" section header — uppercase label + new-file action. */}
      <Show when={props.tab === "files"}>
        <div
          class="flex h-9 flex-shrink-0 items-center justify-between px-3 text-[length:var(--ui-font-xs)] uppercase tracking-[0.1em] text-fg-3"
        >
          <span>Files</span>
          <button
            type="button"
            title="New file"
            aria-label="New file"
            onClick={() => {
              setNewFileOpen((v) => !v);
              setNewFileError(null);
            }}
            class="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
          >
            <FilePlus class="ui-icon-menu" style={{ opacity: 0.8 }} />
          </button>
        </div>
        <Show when={newFileOpen()}>
          <div class="flex-shrink-0 px-3 pb-2">
            <input
              type="text"
              value={newFileName()}
              onInput={(e) => setNewFileName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createNewFile();
                if (e.key === "Escape") {
                  setNewFileOpen(false);
                  setNewFileName("");
                  setNewFileError(null);
                }
              }}
              ref={(el) => setTimeout(() => el.focus(), 0)}
              placeholder="name.tex — Enter to create, Esc to cancel"
              class="glass-inset w-full rounded-md px-2 py-1.5 text-[12px] text-fg-1 placeholder:text-fg-3 focus:outline-none focus:ring-1 focus:ring-[var(--color-accent-1)]"
            />
            <Show when={newFileError()}>
              <div class="mt-1 text-[11px]" style={{ color: "var(--color-err)" }}>
                {newFileError()}
              </div>
            </Show>
          </div>
        </Show>
      </Show>

      <div class="min-h-0 flex-1 overflow-auto scroll">
        <Show when={props.tab === "files" && project()}>
          <FileTree
            rootPath={project()!.rootPath}
            activeRelPath={activeFile()?.relPath ?? null}
            onOpen={props.onSelectFile}
          />
        </Show>
        <Show when={props.tab === "references"}>
          <ReferencesPanel />
        </Show>
        <Show when={props.tab === "scm"}>
          <CommitPanel />
        </Show>
        <Show when={props.tab === "review"}>
          <ReviewPanel />
        </Show>
        <Show when={props.tab === "todo"}>
          <EmptyTab
            icon={<CircleDot size={20} />}
            title="TODO collection — coming soon"
            body="This tab will collect %! TODO: comments from your sources. It isn't built yet."
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
        </div>
        <div class="grid grid-cols-2 gap-2">
          <Stat label="Words" value={wordCount()} />
          <Stat label="Lines" value={lineCount()} />
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
            Document outline isn't built yet — coming soon.
          </div>
        </div>
      </Show>
    </div>
  );
};
