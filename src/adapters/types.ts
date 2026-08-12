export type ProjectFormat = "latex" | "typst";

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
  format: ProjectFormat;
  /** Display name; defaults to folder basename, user-overridable. */
  name: string;
  /** User-set deadline, ISO date (`YYYY-MM-DD`). Optional. */
  deadline?: string;
  /** Free-form tags for library filtering. Persisted. */
  tags?: string[];
  /** Space id (from the workspace spaces catalog) this project belongs to. */
  space?: string;
  /** Archived (hidden from the default library view). Persisted. */
  archived?: boolean;
  /**
   * In-app soft-trash stamp (epoch millis). Present hides the project from every
   * library view except Trashed and blocks opening; cleared on restore.
   */
  trashedAt?: number;
  /**
   * Last-opened time (epoch millis). Unlike createdAt/modifiedAt this IS
   * persisted to project.json — stamped on open via `touchProjectOpened`.
   */
  lastOpenedAt?: number;
  /**
   * Filesystem timestamps (epoch millis) attached by `list_projects` only —
   * derived from folder/root-file mtime, never persisted to project.json.
   * Absent on projects returned by `open_project` / `create_project`.
   */
  createdAt?: number;
  modifiedAt?: number;
  /**
   * Per-project integration state. Optional: older project.json files load
   * with `integrations` absent; default to an empty object at read time.
   */
  integrations?: ProjectIntegrations;
  /**
   * Per-project LaTeX build overrides (engine, flags). Absent falls back to the
   * global compile settings. Persisted; validated on write.
   */
  build?: ProjectBuild;
}

/** Per-project LaTeX build config; every field optional (unset = global default). */
export interface ProjectBuild {
  engine?: "pdflatex" | "xelatex" | "lualatex" | "tectonic";
  /**
   * Curated multi-pass build recipe. Unset defers to `latexmk`. Mirrors the
   * strict `BuildRecipe` enum in `compile.rs`; never a free-form command.
   */
  recipe?: "latexmk" | "engine-only" | "engine-bibtex" | "engine-biber";
  shellEscape?: boolean;
  synctex?: boolean;
  stopOnFirstError?: boolean;
  autoCompile?: boolean;
}

export interface ProjectIntegrations {
  cloudOrigin?: {
    provider: string;
    accountId: string;
    remotePath: string;
  };
  git?: {
    remote?: string;
    branch?: string;
  };
  references?: {
    provider: string;
    collectionId?: string;
  };
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Path relative to project.rootPath (basename only for external scope). */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based; omitted means "whole line". */
  col?: number;
  endLine?: number;
  endCol?: number;
  /** e.g. "texlab", "compile", "tinymist". */
  source?: string;
  /**
   * How `file` was attributed (compile diagnostics only; absent elsewhere):
   * "project" = validated project-relative path, jumpable; "root-fallback" =
   * attribution unknown, `file` is the entry file; "external" = a distro or
   * package file outside the project — no jump target, collapsed by default.
   */
  scope?: "project" | "root-fallback" | "external";
}

export interface CompileResult {
  ok: boolean;
  /** Absolute path to PDF/HTML/etc. when ok === true. */
  outputPath?: string;
  diagnostics: Diagnostic[];
  /** Raw compiler stdout/stderr; useful for the build log pane. */
  log: string;
  durationMs: number;
  /**
   * True when this result was synthesized from a previous build's PDF found
   * on disk at project open — nothing was compiled. Consumers that report on
   * the build itself (duration pills, "compiled successfully" cards) must
   * skip seeded results; the preview pane shows a "from last build" chip.
   */
  seeded?: boolean;
  /**
   * True when a successful build left the output PDF byte-identical (latexmk
   * "Nothing to do"). The compile orchestration skips the viewer reload,
   * which is most of a no-op recompile's cost.
   */
  pdfUnchanged?: boolean;
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

export interface EditorAdapter {
  /**
   * The project's primary editor language. Consumed to pick the LSP server for
   * a newly-opened project (see EditorScreen). Per-FILE language dispatch
   * (a Typst project holds .md/.bib files too) lives in `adapters/languages.ts`,
   * not here.
   */
  languageId: string;
  format: ProjectFormat;
  /** Compiles the project to its output artifact (PDF today). */
  compile(project: Project): Promise<CompileResult>;
  commands: EditorCommand[];
  /**
   * Vestigial seam members. Preview kind is decided per-file
   * (`languages.ts#previewKindForFile`) and CodeMirror extensions per-file in
   * CodeMirror.tsx, so neither is a per-project adapter fact. Kept optional so
   * older adapter shapes still typecheck; do not add new consumers.
   */
  previewKind?: "pdf";
  cmExtensions?(): unknown[];
}
