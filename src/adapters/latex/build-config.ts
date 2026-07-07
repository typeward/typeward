import type { Project, ProjectBuild } from "~/adapters/types";
import type { BuildOptionsWire } from "~/ipc";
import { isTauriMobile } from "~/lib/platform";
import { compileEngine, editorSettings } from "~/stores/settings-store";

/** The concrete engine a project compiles with, after resolving the per-project
 * override against the global default. `texlive-wasm` is the mobile engine. */
export type EffectiveEngine =
  | "pdflatex"
  | "xelatex"
  | "lualatex"
  | "tectonic"
  | "texlive-wasm";

const OVERRIDE_ENGINES = ["pdflatex", "xelatex", "lualatex", "tectonic"] as const;

/** The curated multi-pass recipe values; mirrors `compile.rs`'s `BuildRecipe`. */
export type BuildRecipe = NonNullable<ProjectBuild["recipe"]>;

export interface EffectiveBuild {
  engine: EffectiveEngine;
  recipe: BuildRecipe;
  shellEscape: boolean;
  synctex: boolean;
  stopOnFirstError: boolean;
  autoCompile: boolean;
}

/** The global compile-engine setting mapped to a concrete engine — the default
 * for projects without their own build config. `system-tex` → `pdflatex`. */
function globalEngine(): EffectiveEngine {
  const g = compileEngine();
  if (g === "texlive-wasm") return "texlive-wasm";
  if (g === "tectonic") return "tectonic";
  return "pdflatex";
}

/**
 * Resolve a project's effective build: the per-project `build` override wins,
 * falling back to the global compile settings. Mobile forces `texlive-wasm`
 * (no system TeX). Single source of truth for the compile path, the SyncTeX
 * engine branch, the status-bar build menu, and the sidebar engine pill.
 */
export function effectiveBuild(p: Project): EffectiveBuild {
  const b = p.build;
  const engine: EffectiveEngine = isTauriMobile()
    ? "texlive-wasm"
    : b?.engine && (OVERRIDE_ENGINES as readonly string[]).includes(b.engine)
      ? b.engine
      : globalEngine();
  const ed = editorSettings();
  return {
    engine,
    recipe: b?.recipe ?? "latexmk",
    shellEscape: b?.shellEscape ?? false,
    synctex: b?.synctex ?? true,
    stopOnFirstError: b?.stopOnFirstError ?? ed.stopOnFirstError,
    autoCompile: b?.autoCompile ?? ed.autoCompile,
  };
}

/** Wire options for `ipc.compileLatex`. texlive-wasm never reaches this (it
 * routes through the WASM provider), so it maps to pdflatex defensively. */
export function buildOptionsWire(eff: EffectiveBuild): BuildOptionsWire {
  return {
    engine: eff.engine === "texlive-wasm" ? "pdflatex" : eff.engine,
    recipe: eff.recipe,
    shellEscape: eff.shellEscape,
    synctex: eff.synctex,
    haltOnError: eff.stopOnFirstError,
  };
}
