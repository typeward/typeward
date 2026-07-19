import { Check, Eraser, Settings2 } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createResource } from "solid-js";
import type { ProjectBuild } from "~/adapters/types";
import type { BuildRecipe } from "~/adapters/latex/build-config";
import { effectiveBuild } from "~/adapters/latex/build-config";
import { ensureShellEscapeTrust } from "~/adapters/latex/LatexAdapter";
import { Switch } from "~/components/forms/Switch";
import * as ipc from "~/ipc";
import { describeIpcError } from "~/lib/errors";
import { handleListboxKeydown } from "~/lib/listbox-nav";
import { notifyError, notifySuccess } from "~/lib/toast";
import { project, setProject } from "~/stores/editor-store";

type OverrideEngine = NonNullable<ProjectBuild["engine"]>;

export const ENGINE_LABEL: Record<string, string> = {
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
  tectonic: "Tectonic",
  "texlive-wasm": "TeX Live (WASM)",
};

export const ENGINES: { id: OverrideEngine; label: string }[] = [
  { id: "pdflatex", label: "pdfLaTeX" },
  { id: "xelatex", label: "XeLaTeX" },
  { id: "lualatex", label: "LuaLaTeX" },
  { id: "tectonic", label: "Tectonic" },
];

export const RECIPES: { id: BuildRecipe; label: string; hint: string }[] = [
  {
    id: "latexmk",
    label: "Latexmk (auto)",
    hint: "Automatic bibliography and rerun passes",
  },
  {
    id: "engine-only",
    label: "Engine only (×2)",
    hint: "Two engine passes, no bibliography",
  },
  {
    id: "engine-bibtex",
    label: "Engine + BibTeX",
    hint: "BibTeX between passes (classic .bib)",
  },
  {
    id: "engine-biber",
    label: "Engine + Biber",
    hint: "Biber between passes (biblatex)",
  },
];

/**
 * Per-project build patch + trust logic, shared by the popover menu and the
 * project-settings dialog so both write project.json identically (mirroring
 * `set_project_deadline`) and the store update keeps the pill/menu/dialog in
 * sync. `active` gates the shell-escape trust probe to when the surface is open.
 */
export function usePerProjectBuild(active: () => boolean) {
  const eff = () => {
    const p = project();
    return p ? effectiveBuild(p) : null;
  };

  const [trust, { refetch: refetchTrust }] = createResource(
    () => (active() ? project()?.rootPath : undefined),
    (root) => ipc.shellEscapeTrustGet(root).catch(() => null),
  );

  const patch = async (change: Partial<ProjectBuild>) => {
    const p = project();
    if (!p) return;
    const next: ProjectBuild = { ...(p.build ?? {}), ...change };
    try {
      const updated = await ipc.setProjectBuild(p.rootPath, next);
      setProject(updated);
    } catch (e) {
      notifyError("Couldn't update build settings", describeIpcError(e));
    }
  };

  const reset = async () => {
    const p = project();
    if (!p) return;
    try {
      const updated = await ipc.setProjectBuild(p.rootPath, null);
      setProject(updated);
    } catch (e) {
      notifyError("Couldn't reset build settings", describeIpcError(e));
    }
  };

  const onToggleShellEscape = async (on: boolean) => {
    await patch({ shellEscape: on });
    const p = project();
    // Prompt for the machine-level grant the moment it's turned on, so the
    // first compile isn't surprising. Toggling off just clears the flag.
    if (on && p) {
      await ensureShellEscapeTrust(p);
      void refetchTrust();
    }
  };

  // A stored denial makes ensureShellEscapeTrust return early forever — this
  // is the one UI path that clears it (grants are untouched) and re-prompts.
  const reapproveShellEscape = async () => {
    const p = project();
    if (!p) return;
    try {
      await ipc.trustClearShellEscape(p.rootPath);
    } catch (e) {
      notifyError("Couldn't clear the shell-escape block", describeIpcError(e));
      return;
    }
    await ensureShellEscapeTrust(p);
    void refetchTrust();
  };

  return { eff, trust, patch, reset, onToggleShellEscape, reapproveShellEscape };
}

interface BuildConfigMenuProps {
  /** Which way the popover expands from its trigger. */
  direction: "up" | "down";
  onClose: () => void;
  onOpenSettings: () => void;
}

/**
 * Popover body for a LaTeX project's per-project build config: engine list,
 * curated recipe list (hidden for engines that run their own bib passes), the
 * four flag toggles, and a footer. Extracted so the status-bar `BuildMenu` and
 * the sidebar engine pill share one implementation; each owns its own trigger,
 * open state, and dismiss.
 */
export const BuildConfigMenu: Component<BuildConfigMenuProps> = (props) => {
  let panelRef: HTMLDivElement | undefined;
  const { eff, trust, patch, reset, onToggleShellEscape, reapproveShellEscape } =
    usePerProjectBuild(() => true);

  // Tectonic and the WASM engine run their own bibliography passes, so a curated
  // recipe would be ignored — hide it and say so instead.
  const recipeApplies = () => {
    const e = eff()?.engine;
    return e !== undefined && e !== "tectonic" && e !== "texlive-wasm";
  };

  const doReset = async () => {
    await reset();
    props.onClose();
  };

  // Stale-aux recovery: delete regenerable build artifacts, keep the PDF.
  const doClean = async () => {
    const p = project();
    if (!p) return;
    try {
      const removed = await ipc.compileClean(p);
      notifySuccess(
        "Auxiliary files cleaned",
        removed === 0
          ? "Nothing to remove — the build directory was already clean."
          : `Removed ${removed} build ${removed === 1 ? "file" : "files"}. Compile again for a fresh build.`,
      );
    } catch (e) {
      notifyError("Couldn't clean build files", describeIpcError(e));
    }
    props.onClose();
  };

  // The panel mixes two single-select listboxes (engine, recipe) with
  // interactive Switch rows and footer buttons, so the root is a plain labeled
  // group — a listbox root would nest interactive controls inside option
  // semantics. handleListboxKeydown still roves the option rows (they live in
  // the sub-listboxes) and closes on Escape.
  return (
    <div
      ref={panelRef}
      role="group"
      aria-label="Build configuration"
      tabindex={-1}
      onKeyDown={(e) => handleListboxKeydown(e, panelRef, props.onClose)}
      class={`glass absolute left-0 z-50 w-[248px] rounded-lg py-1.5 ${
        props.direction === "up" ? "bottom-full mb-1" : "top-full mt-1"
      }`}
      style={{ background: "var(--color-popover-bg)" }}
    >
      <Show when={eff()}>
        <div class="label-xs px-3 py-1 text-fg-3">Engine</div>
        <div role="listbox" aria-label="Engine">
          <For each={ENGINES}>
            {(en) => {
              const activeEngine = () => eff()!.engine === en.id;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={activeEngine()}
                  tabindex={-1}
                  onClick={() => void patch({ engine: en.id })}
                  class="flex h-7 w-full items-center px-3 text-left text-sm hover:bg-[var(--color-control-fill)]"
                >
                  <span class={activeEngine() ? "font-medium text-fg-1" : "text-fg-2"}>
                    {en.label}
                  </span>
                  <Show when={activeEngine()}>
                    <Check size={12} class="ml-auto" style={{ color: "var(--color-accent-1)" }} />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>

        <div class="my-1.5 border-t border-glass-stroke" />

        <Show
          when={recipeApplies()}
          fallback={
            <div class="px-3 py-1 text-[10px] leading-tight text-fg-3">
              {ENGINE_LABEL[eff()!.engine] ?? eff()!.engine} runs its own
              bibliography passes — recipe is ignored.
            </div>
          }
        >
          <div class="label-xs px-3 py-1 text-fg-3">Recipe</div>
          <div role="listbox" aria-label="Recipe">
            <For each={RECIPES}>
              {(rc) => {
                const activeRecipe = () => eff()!.recipe === rc.id;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={activeRecipe()}
                    tabindex={-1}
                    onClick={() => void patch({ recipe: rc.id })}
                    title={rc.hint}
                    class="flex h-7 w-full items-center px-3 text-left text-sm hover:bg-[var(--color-control-fill)]"
                  >
                    <span class={activeRecipe() ? "font-medium text-fg-1" : "text-fg-2"}>
                      {rc.label}
                    </span>
                    <Show when={activeRecipe()}>
                      <Check size={12} class="ml-auto" style={{ color: "var(--color-accent-1)" }} />
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <div class="my-1.5 border-t border-glass-stroke" />

        <BuildToggle
          label="Shell-escape"
          hint={
            <Show
              when={trust() === "denied"}
              fallback={<>Lets the document run programs — needs approval</>}
            >
              <button
                type="button"
                onClick={() => void reapproveShellEscape()}
                class="text-left underline decoration-dotted underline-offset-2 hover:text-fg-1"
              >
                Blocked on this machine — re-approve…
              </button>
            </Show>
          }
          checked={eff()!.shellEscape}
          onChange={(v) => void onToggleShellEscape(v)}
        />
        <BuildToggle
          label="SyncTeX"
          hint="Forward/inverse search between source and PDF"
          checked={eff()!.synctex}
          onChange={(v) => void patch({ synctex: v })}
        />
        <BuildToggle
          label="Stop on first error"
          hint="Halt at the first error instead of collecting all"
          checked={eff()!.stopOnFirstError}
          onChange={(v) => void patch({ stopOnFirstError: v })}
        />
        <BuildToggle
          label="Auto-compile on save"
          checked={eff()!.autoCompile}
          onChange={(v) => void patch({ autoCompile: v })}
        />

        <div class="mt-1 flex items-center justify-between border-t border-glass-stroke px-3 pt-1.5">
          <button
            type="button"
            onClick={() => void doClean()}
            title="Delete aux/bbl/log build artifacts — fixes builds wedged by stale auxiliary files (e.g. after changing the bibliography setup)"
            class="lift flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
          >
            <Eraser size={11} />
            Clean auxiliary files
          </button>
          <button
            type="button"
            onClick={() => {
              props.onClose();
              props.onOpenSettings();
            }}
            title="Project settings"
            class="lift flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
          >
            <Settings2 size={11} />
            Project settings…
          </button>
        </div>
        <div class="flex items-center justify-start px-3 pb-0.5 pt-1">
          <button
            type="button"
            onClick={() => void doReset()}
            class="text-xs text-fg-3 hover:text-fg-1"
          >
            Reset to global defaults
          </button>
        </div>
      </Show>
    </div>
  );
};

const BuildToggle: Component<{
  label: string;
  hint?: JSX.Element;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = (props) => (
  <div class="flex items-center gap-2 px-3 py-1.5">
    <div class="min-w-0 flex-1">
      <div class="text-sm text-fg-1">{props.label}</div>
      <Show when={props.hint}>
        <div class="text-[10px] leading-tight text-fg-3">{props.hint}</div>
      </Show>
    </div>
    <Switch checked={props.checked} onChange={props.onChange} />
  </div>
);
