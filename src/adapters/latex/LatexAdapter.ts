import type {
  CodeMirrorExtension,
  CompileResult,
  EditorAdapter,
  EditorCommand,
  Project,
} from "~/adapters/types";
import * as ipc from "~/ipc";
import { compileEngine, editorSettings } from "~/stores/settings-store";

const compile = async (project: Project): Promise<CompileResult> => {
  const engine = compileEngine();
  if (engine === "texlive-wasm") {
    const { compileWithTexliveWasm } = await import(
      "~/providers/compile/texlive-wasm-provider"
    );
    return compileWithTexliveWasm(project);
  }
  return ipc.compileLatex(project, engine, editorSettings().stopOnFirstError);
};

/**
 * Adapter-published commands. They're registered with the CommandRegistry
 * when a LaTeX project opens (see commands/boot.ts) and
 * unregistered on close so they don't pollute the palette for other formats.
 *
 * Run handlers read from the editor-store directly via the shared actions
 * module — adapters declare *what* runs, not *how* to plumb context through.
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
      const { compileActiveProject } = await import("~/commands/actions");
      await compileActiveProject();
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
      const { syncForwardFromCursor } = await import("~/commands/actions");
      await syncForwardFromCursor();
    },
  },
];

/**
 * Phase 1 LatexAdapter. CodeMirror extensions are produced by the editor
 * shell (so it can compose them with the user's font-size + line-wrap
 * preferences) — the adapter publishes language identity and command set
 * here, and the shell knows what to do with that.
 */
export const LatexAdapter: EditorAdapter = {
  languageId: "latex",
  format: "latex",
  previewKind: "pdf",
  cmExtensions(): CodeMirrorExtension[] {
    return [];
  },
  compile,
  commands,
};
