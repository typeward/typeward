import type { DocumentExperience } from "~/experiences/types";

export type ProjectFormat =
  | "latex"
  | "typst"
  | "markdown"
  | "rmarkdown";

/**
 * Round-tripped to .typeward/project.json on disk. Anything UI-state-only
 * (last-opened tabs, cursor positions) lives in a separate sidecar file so
 * project.json stays diffable.
 */
export interface Project {
  /** Absolute folder path. */
  rootPath: string;
  /** Entry file relative to rootPath, e.g. "main.tex". */
  rootFile: string;
  experience: DocumentExperience;
  format: ProjectFormat;
  /** Display name; defaults to folder basename, user-overridable. */
  name: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Path relative to project.rootPath. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based; omitted means "whole line". */
  col?: number;
  endLine?: number;
  endCol?: number;
  /** e.g. "texlab", "compile", "tinymist". */
  source?: string;
}

export interface CompileResult {
  ok: boolean;
  /** Absolute path to PDF/HTML/etc. when ok === true. */
  outputPath?: string;
  diagnostics: Diagnostic[];
  /** Raw compiler stdout/stderr; useful for the build log pane. */
  log: string;
  durationMs: number;
}

/**
 * Scope decides which keydown listener routes the shortcut:
 *   - "global": fires regardless of focus (Mod+K, Mod+N, Mod+,)
 *   - "editor": only when the editor surface or its descendants have focus
 *     (Mod+S, Mod+Enter — we don't want them firing while the user types
 *     in an input on Settings)
 * Defaults to "global" when omitted.
 */
export type CommandScope = "global" | "editor";

export interface EditorCommand {
  /** Namespaced, e.g. "latex.compile" or "core.savefile". */
  id: string;
  title: string;
  /** Optional one-line description shown in the palette under the title. */
  subtitle?: string;
  /** Platform-agnostic shortcut, e.g. "Mod+S" (Mod = Cmd on Mac, Ctrl elsewhere). */
  shortcut?: string;
  /** For grouping in the command palette. */
  group?: string;
  scope?: CommandScope;
  /**
   * Gate that decides whether the command is currently runnable. The palette
   * filters by this and the keyboard router skips dispatch when it returns
   * false. Reads stores directly — no args.
   */
  when?: () => boolean;
  run(): void | Promise<void>;
}

/**
 * CodeMirror's `Extension` type is referenced opaquely so this file does not
 * depend on @codemirror/state being installed. Adapters that produce real
 * extensions cast at the use site.
 */
export type CodeMirrorExtension = unknown;

export interface EditorAdapter {
  languageId: string;
  experience: DocumentExperience;
  format: ProjectFormat;
  previewKind: "pdf" | "html" | "notebook";
  cmExtensions(): CodeMirrorExtension[];
  /** Delegates to a CompileProvider chosen by project settings. */
  compile(project: Project): Promise<CompileResult>;
  commands: EditorCommand[];
  // diagnostics$ and completions are streamed; their wire shape is finalized
  // when the LSP transport lands.
}
