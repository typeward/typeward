import type {
  CodeMirrorExtension,
  CompileResult,
  EditorAdapter,
  EditorCommand,
  Project,
} from "~/adapters/types";
import * as ipc from "~/ipc";

const compile = (project: Project): Promise<CompileResult> => {
  return ipc.compileRmarkdown(project);
};

/**
 * R Markdown adapter — runs `Rscript -e "rmarkdown::render(...)"` for a
 * whole-file PDF render. Cell-level execution is intentionally not wired
 * in this slice (see plan.md for the notebook scope ladder). The shell
 * picks NotebookShell because experience === "notebook".
 */
const commands: EditorCommand[] = [
  {
    id: "rmarkdown.render",
    title: "Render R Markdown",
    subtitle: "Rscript rmarkdown::render → PDF (whole file)",
    shortcut: "Mod+Enter",
    group: "Build",
    scope: "editor",
    when: () => true,
    run: async () => {
      const { compileActiveProject } = await import("~/commands/actions");
      await compileActiveProject();
    },
  },
];

export const RmarkdownAdapter: EditorAdapter = {
  languageId: "rmarkdown",
  experience: "notebook",
  format: "rmarkdown",
  previewKind: "pdf",
  cmExtensions(): CodeMirrorExtension[] {
    return [];
  },
  compile,
  commands,
};
