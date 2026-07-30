import type {
  CompileResult,
  EditorAdapter,
  EditorCommand,
  Project,
} from "~/adapters/types";
import * as ipc from "~/ipc";
import { currentCompileId, runCompile, runSyncForward } from "~/commands/compile-runner";
import { buildOptionsWire, effectiveBuild } from "~/adapters/latex/build-config";

/**
 * Shell-escape is dangerous (arbitrary program execution during compile), so
 * the first time a project asks for it we prompt for a per-machine trust grant
 * (stored in Rust, outside the project). Returns whether the flag may be used.
 */
export const ensureShellEscapeTrust = async (project: Project): Promise<boolean> => {
  const current = await ipc.shellEscapeTrustGet(project.rootPath).catch(() => null);
  if (current === "granted") return true;
  if (current === "denied") return false;
  // The confirmation is owned by Rust (shell_escape_trust_set raises a native
  // dialog the renderer can't fabricate, then returns the effective decision) —
  // a renderer-side prompt here would double up and, worse, be forgeable.
  const decision = await ipc
    .shellEscapeTrustSet(project.rootPath, "granted")
    .catch(() => "denied" as const);
  return decision === "granted";
};

const compile = async (project: Project): Promise<CompileResult> => {
  const eff = effectiveBuild(project);
  if (eff.engine === "texlive-wasm") {
    const { compileWithTexliveWasm } = await import(
      "~/providers/compile/texlive-wasm-provider"
    );
    return compileWithTexliveWasm(project);
  }
  const wire = buildOptionsWire(eff);
  // Prompt for shell-escape trust the first time; declining compiles without it
  // rather than erroring.
  if (wire.shellEscape && !(await ensureShellEscapeTrust(project))) {
    return ipc.compileLatex(project, { ...wire, shellEscape: false }, currentCompileId());
  }
  return ipc.compileLatex(project, wire, currentCompileId());
};

/**
 * Adapter-published commands. They're registered with the CommandRegistry
 * when a LaTeX project opens (see commands/boot.ts) and unregistered on close
 * so they don't pollute the palette for other formats.
 *
 * Run handlers reach the orchestration in commands/actions through the
 * compile-runner leaf module rather than importing actions directly — actions
 * imports this module for adapterFor, so a back-import would form a cycle.
 */
const commands: EditorCommand[] = [
  {
    id: "latex.compile",
    title: "Compile LaTeX",
    subtitle: "latexmk / pdflatex via system TeX, Tectonic, or TeX Live WASM",
    shortcut: "Mod+Enter",
    group: "Build",
    scope: "editor",
    when: () => true,
    run: async () => {
      await runCompile();
    },
  },
  {
    id: "latex.syncForward",
    title: "Jump to PDF (forward search)",
    subtitle: "Scroll the preview to the cursor's location — needs synctex",
    shortcut: "Mod+J",
    group: "Navigation",
    scope: "editor",
    when: () => true,
    run: async () => {
      await runSyncForward();
    },
  },
];

/**
 * Phase 1 LatexAdapter. CodeMirror extensions are produced per-file by the
 * editor shell (composing the user's font-size + line-wrap preferences), so
 * the adapter only publishes language identity and its command set.
 */
export const LatexAdapter: EditorAdapter = {
  languageId: "latex",
  format: "latex",
  compile,
  commands,
};
