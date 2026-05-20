import type {
  CodeMirrorExtension,
  CompileResult,
  EditorAdapter,
  EditorCommand,
  Project,
} from "~/adapters/types";
import * as ipc from "~/ipc";

const compile = (project: Project): Promise<CompileResult> => {
  return ipc.compileTypst(project);
};

/**
 * Typst compiles natively to PDF — no LaTeX engine required, which is
 * one of its main selling points. tinymist provides LSP completions when
 * present on PATH (wired via the LSP store on project load).
 */
const commands: EditorCommand[] = [
  {
    id: "typst.compile",
    title: "Compile Typst",
    subtitle: "typst CLI — native PDF, no LaTeX engine needed",
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

export const TypstAdapter: EditorAdapter = {
  languageId: "typst",
  format: "typst",
  previewKind: "pdf",
  cmExtensions(): CodeMirrorExtension[] {
    return [];
  },
  compile,
  commands,
};
