import type {
  CompileResult,
  EditorAdapter,
  EditorCommand,
  Project,
} from "~/adapters/types";
import { hasEntitlement } from "~/integrations/entitlements";
import * as ipc from "~/ipc";
import { currentCompileId, runCompile } from "~/commands/compile-runner";

const compile = async (project: Project): Promise<CompileResult> => {
  // Typst is a Pro format. A free user can still open and read .typ files
  // (it's a text editor); compiling is the enforcement point, and the message
  // lands in the Issues tab via the compile orchestration's error path.
  if (!hasEntitlement("formats.typst")) {
    throw new Error("Typst support requires Typeward Pro.");
  }
  return ipc.compileTypst(project, currentCompileId());
};

/**
 * Typst compiles natively to PDF — no LaTeX engine required, which is
 * one of its main selling points. tinymist provides LSP completions when
 * present on PATH (wired via the LSP store on project load).
 *
 * The build handler reaches the orchestration through the compile-runner leaf
 * module rather than importing commands/actions directly, keeping the
 * adapter -> actions dependency one-way (actions imports this module for
 * adapterFor).
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
      await runCompile();
    },
  },
];

export const TypstAdapter: EditorAdapter = {
  languageId: "typst",
  format: "typst",
  compile,
  commands,
};
