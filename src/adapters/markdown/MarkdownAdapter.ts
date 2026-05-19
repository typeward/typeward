import type {
  CodeMirrorExtension,
  CompileResult,
  EditorAdapter,
  EditorCommand,
  Project,
} from "~/adapters/types";
import * as ipc from "~/ipc";

const compile = (project: Project): Promise<CompileResult> => {
  return ipc.compileMarkdown(project);
};

/**
 * Pandoc handles the Markdown → PDF conversion. The compile command goes
 * through the shared `compileActiveProject` action so the orchestration
 * (save-if-dirty, diagnostics, pdf version bump, telemetry) is identical
 * to the LaTeX path.
 */
const commands: EditorCommand[] = [
  {
    id: "markdown.compile",
    title: "Compile Markdown",
    subtitle: "pandoc → PDF (requires a LaTeX engine on PATH)",
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

export const MarkdownAdapter: EditorAdapter = {
  languageId: "markdown",
  experience: "text",
  format: "markdown",
  previewKind: "pdf",
  cmExtensions(): CodeMirrorExtension[] {
    return [];
  },
  compile,
  commands,
};
