import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import { Check, FileText, RotateCcw } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createResource, createSignal } from "solid-js";
import { Dialog } from "~/components/primitives/Dialog";
import { Switch } from "~/components/forms/Switch";
import {
  ENGINES,
  RECIPES,
  usePerProjectBuild,
} from "~/components/editor/BuildConfigMenu";
import * as ipc from "~/ipc";
import { describeIpcError } from "~/lib/errors";
import { notifyError } from "~/lib/toast";
import { recordError } from "~/lib/telemetry";
import { project, setProject } from "~/stores/editor-store";
import { fsVersion } from "~/stores/watcher-store";

// Module-scope open signal so the sidebar gear, the pill's BuildConfigMenu
// footer, and the status-bar menu can all raise the single mounted dialog
// without prop-drilling (mirrors the requestNewProject / requestSaveTemplate
// intent-signal pattern).
const [open, setOpen] = createSignal(false);
export const projectSettingsOpen = open;
export const openProjectSettings = () => setOpen(true);

const SKIP_DIRS = new Set(["build", "out", "dist", "node_modules"]);

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return parent + name;
  return parent.includes("\\") ? `${parent}\\${name}` : `${parent}/${name}`;
}

/**
 * Depth-first walk of the project tree collecting root-file candidates (files
 * whose extension matches the project format). Mirrors FileTree's reader but
 * flattens to relative paths, skips dot-dirs (`.git`/`.typeward`) and build
 * clutter, and caps the result so a pathological tree can't stall the picker.
 */
async function collectSourceFiles(
  root: string,
  ext: string,
  cap = 500,
): Promise<string[]> {
  const out: string[] = [];
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    if (out.length >= cap) return;
    let entries: DirEntry[];
    try {
      entries = await readDir(absDir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const name = e.name;
      if (name.startsWith(".")) continue;
      if (e.isDirectory) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(joinPath(absDir, name), relDir ? `${relDir}/${name}` : name);
      } else if (name.toLowerCase().endsWith(ext)) {
        out.push(relDir ? `${relDir}/${name}` : name);
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * Per-project settings dialog. Mounted once in the shell behind the module
 * `projectSettingsOpen` signal. Owns the main-file picker (both formats) and,
 * for LaTeX, the build section (recipe / engine / flags) — the latter shares
 * `usePerProjectBuild` with `BuildConfigMenu` so a change here is reflected in
 * the pill and the status-bar menu instantly.
 */
export const ProjectSettingsDialog: Component = () => {
  const ext = () => (project()?.format === "typst" ? ".typ" : ".tex");

  const [files] = createResource(
    () => {
      const p = project();
      if (!open() || !p) return null;
      // Re-walk when the file tree changes so a just-created/renamed file shows.
      fsVersion();
      return { root: p.rootPath, ext: ext() };
    },
    (key) => collectSourceFiles(key.root, key.ext),
    { initialValue: [] },
  );

  const { eff, patch, reset, trust, onToggleShellEscape } =
    usePerProjectBuild(open);

  const recipeApplies = () => {
    const e = eff()?.engine;
    return e !== undefined && e !== "tectonic" && e !== "texlive-wasm";
  };

  const pickRoot = async (rel: string) => {
    const p = project();
    if (!p || p.rootFile === rel) return;
    try {
      const updated = await ipc.setProjectRootFile(p.rootPath, rel);
      setProject(updated);
    } catch (e) {
      notifyError("Couldn't set main file", describeIpcError(e));
      recordError("project-settings", `setting main file ${rel} failed`, e);
    }
  };

  return (
    <Dialog
      open={open()}
      onOpenChange={setOpen}
      title="Project settings"
      widthClass="w-[520px]"
    >
      <div class="space-y-5">
        <section>
          <h3 class="label-xs text-fg-3">Main file</h3>
          <p class="mt-0.5 text-xs text-fg-3">
            The entry file the compiler builds.
          </p>
          <div class="glass-inset mt-2 max-h-56 overflow-auto scroll rounded-lg p-1">
            <Show
              when={files().length > 0}
              fallback={
                <div class="px-2 py-3 text-center text-xs text-fg-3">
                  No {ext()} files found in this project.
                </div>
              }
            >
              <For each={files()}>
                {(rel) => {
                  const isRoot = () => project()?.rootFile === rel;
                  return (
                    <button
                      type="button"
                      onClick={() => void pickRoot(rel)}
                      class={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                        isRoot()
                          ? "bg-[var(--color-control-fill)] text-fg-1"
                          : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                      }`}
                    >
                      <FileText size={13} class="flex-shrink-0 opacity-70" />
                      <span class="mono min-w-0 flex-1 truncate">{rel}</span>
                      <Show when={isRoot()}>
                        <Check
                          size={13}
                          class="flex-shrink-0"
                          style={{ color: "var(--color-accent-1)" }}
                        />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>
        </section>

        <Show when={project()?.format === "latex" && eff()}>
          <section>
            <div class="flex items-center justify-between">
              <h3 class="label-xs text-fg-3">Build</h3>
              <button
                type="button"
                onClick={() => void reset()}
                class="lift -my-0.5 flex items-center gap-1 rounded px-1.5 py-1 text-xs text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
              >
                <RotateCcw size={11} />
                Reset to global defaults
              </button>
            </div>

            <div class="mt-2 space-y-1.5">
              <div class="label-xs text-fg-3">Engine</div>
              <div class="flex flex-wrap gap-1.5">
                <For each={ENGINES}>
                  {(en) => {
                    const activeEngine = () => eff()!.engine === en.id;
                    return (
                      <button
                        type="button"
                        onClick={() => void patch({ engine: en.id })}
                        aria-pressed={activeEngine()}
                        class={`rounded-md px-2.5 py-1 text-sm ${
                          activeEngine()
                            ? "bg-[var(--color-control-fill)] font-medium text-fg-1"
                            : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                        }`}
                        style={
                          activeEngine()
                            ? { "box-shadow": "inset 0 0 0 1px var(--color-accent-1)" }
                            : undefined
                        }
                      >
                        {en.label}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>

            <div class="mt-3 space-y-1.5">
              <div class="label-xs text-fg-3">Recipe</div>
              <Show
                when={recipeApplies()}
                fallback={
                  <p class="text-xs text-fg-3">
                    This engine runs its own bibliography passes, so the recipe
                    is ignored.
                  </p>
                }
              >
                <div class="space-y-1.5">
                  <For each={RECIPES}>
                    {(rc) => {
                      const activeRecipe = () => eff()!.recipe === rc.id;
                      return (
                        <button
                          type="button"
                          onClick={() => void patch({ recipe: rc.id })}
                          aria-pressed={activeRecipe()}
                          class="glass-soft flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--color-control-fill)]"
                          style={
                            activeRecipe()
                              ? { "box-shadow": "inset 0 0 0 1px var(--color-accent-1)" }
                              : undefined
                          }
                        >
                          <div class="min-w-0 flex-1">
                            <div class="text-sm font-medium text-fg-1">{rc.label}</div>
                            <div class="text-xs text-fg-3">{rc.hint}</div>
                          </div>
                          <Show when={activeRecipe()}>
                            <Check
                              size={14}
                              class="mt-0.5 flex-shrink-0"
                              style={{ color: "var(--color-accent-1)" }}
                            />
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="mt-3 space-y-0.5">
              <DialogToggle
                label="Shell-escape"
                hint={
                  trust() === "denied"
                    ? "Blocked on this machine"
                    : "Lets the document run programs (needs approval)"
                }
                checked={eff()!.shellEscape}
                onChange={(v) => void onToggleShellEscape(v)}
              />
              <DialogToggle
                label="SyncTeX"
                hint="Forward/inverse search between source and PDF"
                checked={eff()!.synctex}
                onChange={(v) => void patch({ synctex: v })}
              />
              <DialogToggle
                label="Stop on first error"
                hint="Halt at the first error instead of collecting all"
                checked={eff()!.stopOnFirstError}
                onChange={(v) => void patch({ stopOnFirstError: v })}
              />
              <DialogToggle
                label="Auto-compile on save"
                checked={eff()!.autoCompile}
                onChange={(v) => void patch({ autoCompile: v })}
              />
            </div>
          </section>
        </Show>
      </div>
    </Dialog>
  );
};

const DialogToggle: Component<{
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = (props) => (
  <div class="flex items-center gap-2 py-1.5">
    <div class="min-w-0 flex-1">
      <div class="text-sm text-fg-1">{props.label}</div>
      <Show when={props.hint}>
        <div class="text-xs leading-tight text-fg-3">{props.hint}</div>
      </Show>
    </div>
    <Switch checked={props.checked} onChange={props.onChange} />
  </div>
);
