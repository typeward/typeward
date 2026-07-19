import { invoke } from "@tauri-apps/api/core";
import { isTauriMobile } from "~/lib/platform";
import type {
  CompileResult,
  Diagnostic,
  Project,
  ProjectBuild,
  ProjectFormat,
  ProjectIntegrations,
} from "~/adapters/types";

/** True on desktop builds (Win/Mac/Linux); false on Android/iOS. */
export function isDesktop(): boolean {
  return !isTauriMobile();
}

/**
 * Guard for wrappers whose Rust command is cfg-gated off mobile builds
 * (TeX detection, SyncTeX, LSP — see `src-tauri/src/lib.rs`). Calling one on
 * mobile would otherwise reject with Tauri's opaque unknown-command error;
 * fail fast with an actionable message at the single wrapper chokepoint.
 */
export function assertDesktopCommand(command: string): void {
  if (isTauriMobile()) {
    throw new Error(`"${command}" is a desktop-only feature, unavailable on this device.`);
  }
}

// ----- TeX engine detection ------------------------------------------------

export interface TexEngine {
  name: string;
  path: string | null;
  version: string | null;
  installed: boolean;
}

export interface EngineProbe {
  engines: TexEngine[];
  anyLatexAvailable: boolean;
}

export const detectTex = (): Promise<EngineProbe> => {
  assertDesktopCommand("detect_tex");
  return invoke("detect_tex");
};

// ----- Projects ------------------------------------------------------------

export const listProjects = (root?: string): Promise<Project[]> =>
  invoke("list_projects", { root });

export const createProject = (params: {
  name: string;
  format: ProjectFormat;
  parent?: string;
}): Promise<Project> => invoke("create_project", params);

export const openProject = (path: string): Promise<Project> =>
  invoke("open_project", { path });

export const importProjectFolder = (path: string): Promise<Project> =>
  invoke("import_project_folder", { path });

export const setProjectIntegrations = (
  projectRoot: string,
  integrations: ProjectIntegrations,
): Promise<Project> =>
  invoke("set_project_integrations", { projectRoot, integrations });

/** Set (ISO `YYYY-MM-DD`) or clear (`null`) a project's deadline. */
export const setProjectDeadline = (
  projectRoot: string,
  deadline: string | null,
): Promise<Project> =>
  invoke("set_project_deadline", { projectRoot, deadline });

/** Replace a project's tag list (normalized + capped in Rust). */
export const setProjectTags = (
  projectRoot: string,
  tags: string[],
): Promise<Project> => invoke("set_project_tags", { projectRoot, tags });

/** Assign the project to a space (`null` clears membership). */
export const setProjectSpace = (
  projectRoot: string,
  space: string | null,
): Promise<Project> => invoke("set_project_space", { projectRoot, space });

/** Move a project to the in-app trash (`true`) or restore it (`false`). */
export const setProjectTrashed = (
  projectRoot: string,
  trashed: boolean,
): Promise<Project> => invoke("set_project_trashed", { projectRoot, trashed });

export const setProjectArchived = (
  projectRoot: string,
  archived: boolean,
): Promise<Project> =>
  invoke("set_project_archived", { projectRoot, archived });

/** Stamp the project's last-opened time. Fire-and-forget on open. */
export const touchProjectOpened = (projectRoot: string): Promise<void> =>
  invoke("touch_project_opened", { projectRoot });

/** Rename a project's display name (folder path unchanged). */
export const renameProject = (
  projectRoot: string,
  name: string,
): Promise<Project> => invoke("rename_project", { projectRoot, name });

/** Move a project to the OS trash (recoverable). */
export const deleteProject = (projectRoot: string): Promise<void> =>
  invoke("delete_project", { projectRoot });

/** Duplicate a project into a fresh sibling folder; returns the new project. */
export const duplicateProject = (
  projectRoot: string,
  newName?: string,
): Promise<Project> =>
  invoke("duplicate_project", { projectRoot, newName: newName ?? null });

export interface TodoItem {
  file: string;
  line: number;
  kind: "todo" | "fixme" | "note";
  text: string;
}

/** Scan the project's source files for TODO/FIXME/NOTE markers. */
export const scanProjectTodos = (projectRoot: string): Promise<TodoItem[]> =>
  invoke("scan_project_todos", { projectRoot });

// ----- File I/O ------------------------------------------------------------

export const readProjectTextFile = (
  projectRoot: string,
  relPath: string,
): Promise<string> =>
  invoke("read_project_text_file", { projectRoot, relPath });

/**
 * Read raw bytes for a project-relative file. The WASM compile provider
 * pulls figure assets (`.png`/`.jpg`/`.pdf`) through this so
 * `\includegraphics{...}` resolves inside the engine's in-memory FS.
 *
 * The command returns a raw IPC body (ArrayBuffer), not a JSON number array,
 * so large reads don't pay the ~3-4x serialization bloat.
 */
export const readProjectBinaryFile = async (
  projectRoot: string,
  relPath: string,
): Promise<Uint8Array> => {
  const buf = await invoke<ArrayBuffer>("read_project_binary_file", {
    projectRoot,
    relPath,
  });
  return new Uint8Array(buf);
};

export const writeProjectTextFile = (
  projectRoot: string,
  relPath: string,
  content: string,
): Promise<void> =>
  invoke("write_project_text_file", { projectRoot, relPath, content });

/**
 * Persist arbitrary binary bytes. Used by the WASM compile provider to
 * write the engine-emitted PDF into `<project>/.typeward/build/<base>.pdf`
 * so the file-backed PdfViewer can render it without changes.
 *
 * The bytes ride as the raw IPC request body (ArrayBuffer) rather than a JSON
 * number array; the path metadata travels as percent-encoded headers (the JSON
 * arg slot is taken by the raw body, and header values must be ASCII).
 */
export const writeProjectBinaryFile = (
  projectRoot: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> =>
  invoke("write_project_binary_file", bytes, {
    headers: {
      "x-project-root": encodeURIComponent(projectRoot),
      "x-rel-path": encodeURIComponent(relPath),
    },
  });

// ----- File-tree operations (context menus) --------------------------------
//
// Renderer-driven file ops backing the FileTree context menus. Each Rust
// command gates on the opened-project registry, validates the project-relative
// path (leading-dash guard included), and rejects `.typeward`/`.git` first
// components. The watcher picks the changes up automatically (fsVersion bump).

/** Repoint the project's entry (`rootFile`) — root-file picker / rename-the-root. */
export const setProjectRootFile = (
  projectRoot: string,
  relPath: string,
): Promise<Project> =>
  invoke("set_project_root_file", { projectRoot, relPath });

/** Move a project-relative file. Source must exist and not be a symlink; dest must be free. */
export const renameProjectFile = (
  projectRoot: string,
  fromRel: string,
  toRel: string,
): Promise<void> =>
  invoke("rename_project_file", { projectRoot, fromRel, toRel });

/** Trash (desktop) or hard-remove (mobile) a project-relative file or directory. */
export const deleteProjectPath = (
  projectRoot: string,
  relPath: string,
): Promise<void> =>
  invoke("delete_project_path", { projectRoot, relPath });

/** Create a project-relative directory (parents included). */
export const createProjectDir = (
  projectRoot: string,
  relPath: string,
): Promise<void> =>
  invoke("create_project_dir", { projectRoot, relPath });

/** Copy a project-relative file to a fresh "<name> copy.ext" sibling; returns the new rel path. */
export const duplicateProjectFile = (
  projectRoot: string,
  relPath: string,
): Promise<string> =>
  invoke("duplicate_project_file", { projectRoot, relPath });

/** Reveal a project-relative file in the OS file manager (registry-gated). */
export const revealProjectPath = (
  projectRoot: string,
  relPath: string,
): Promise<void> => invoke("reveal_project_path", { projectRoot, relPath });

/**
 * Copy OS-absolute files (drag-drop / file picker) into a project directory
 * (`""` = project root). Dropped/picked paths sit outside the fs plugin's
 * runtime scope, so the copy happens in Rust. Collisions auto-suffix " (2)";
 * returns the created rel paths.
 */
export const importFilesIntoProject = (
  projectRoot: string,
  targetRelDir: string,
  sourcePaths: string[],
): Promise<string[]> =>
  invoke("import_files_into_project", { projectRoot, targetRelDir, sourcePaths });

/**
 * Move a project-relative file or directory into another project directory
 * (`""` = project root), keeping the leaf name. Never overwrites; returns the
 * new rel path.
 */
export const moveProjectPath = (
  projectRoot: string,
  fromRel: string,
  toRelDir: string,
): Promise<string> =>
  invoke("move_project_path", { projectRoot, fromRel, toRelDir });

/**
 * Reuse the Rust LaTeX log parser from frontend compile paths (WASM engine).
 * Keeps diagnostic shape identical across engines without a TS duplicate.
 */
export const parseLatexLog = (
  log: string,
  entry: string,
): Promise<Array<Diagnostic & { source: string }>> =>
  invoke("parse_latex_log_cmd", { log, entry });

// ----- Compile -------------------------------------------------------------

/**
 * Backend compile result wire shape. Matches the TS `CompileResult` type from
 * src/adapters/types.ts. Diagnostics carry a `source` field that the typed
 * adapter shape lacks; we drop it on the way through.
 */
interface BackendCompileResult {
  ok: boolean;
  outputPath?: string;
  diagnostics: Array<Diagnostic & { source: string }>;
  log: string;
  durationMs: number;
}

/** Structured, resolved build options passed to `compile_latex`. */
export interface BuildOptionsWire {
  engine: "pdflatex" | "xelatex" | "lualatex" | "tectonic";
  recipe: "latexmk" | "engine-only" | "engine-bibtex" | "engine-biber";
  shellEscape: boolean;
  synctex: boolean;
  haltOnError: boolean;
}

export const compileLatex = async (
  project: Project,
  options: BuildOptionsWire,
  compileId?: string,
): Promise<CompileResult> => {
  const result = await invoke<BackendCompileResult>("compile_latex", {
    project,
    options,
    compileId,
  });
  return {
    ok: result.ok,
    outputPath: result.outputPath,
    diagnostics: result.diagnostics,
    log: result.log,
    durationMs: result.durationMs,
  };
};

/** Set (or clear with `null`) the per-project LaTeX build config. */
export const setProjectBuild = (
  projectRoot: string,
  build: ProjectBuild | null,
): Promise<Project> => invoke("set_project_build", { projectRoot, build });

/** Read the per-machine shell-escape trust for a project (`null` = unset). */
export const shellEscapeTrustGet = (
  projectRoot: string,
): Promise<string | null> => invoke("shell_escape_trust_get", { projectRoot });

export const shellEscapeTrustSet = (
  projectRoot: string,
  grant: "granted" | "denied",
): Promise<void> => invoke("shell_escape_trust_set", { projectRoot, grant });

export const compileTypst = async (
  project: Project,
  compileId?: string,
): Promise<CompileResult> => {
  const result = await invoke<BackendCompileResult>("compile_typst", {
    project,
    compileId,
  });
  return {
    ok: result.ok,
    outputPath: result.outputPath,
    diagnostics: result.diagnostics,
    log: result.log,
    durationMs: result.durationMs,
  };
};

/**
 * Kill an in-flight compile's process tree. Quietly succeeds when the id is
 * no longer registered (the compile finished first — a normal race). The
 * cancelled compile IPC itself rejects with the stable marker string exported
 * as `COMPILE_CANCELLED` from `~/commands/compile-runner`.
 */
export const compileCancel = (compileId: string): Promise<void> =>
  invoke("compile_cancel", { compileId });

// ----- SyncTeX -------------------------------------------------------------

export interface SyncTexForwardLocation {
  page: number;
  /** PDF points (1pt = 1/72 inch), top-left origin. */
  x: number;
  y: number;
  h: number;
  v: number;
}

export interface SyncTexInverseLocation {
  /** Absolute source path as returned by `synctex edit`. */
  file: string;
  line: number;
}

export const synctexForward = (args: {
  projectRoot: string;
  pdfPath: string;
  /** Source file relative to projectRoot. */
  sourceFile: string;
  line: number;
}): Promise<SyncTexForwardLocation | null> => {
  assertDesktopCommand("synctex_forward");
  return invoke("synctex_forward", { args });
};

export const synctexInverse = (args: {
  projectRoot: string;
  pdfPath: string;
  page: number;
  x: number;
  y: number;
}): Promise<SyncTexInverseLocation | null> => {
  assertDesktopCommand("synctex_inverse");
  return invoke("synctex_inverse", { args });
};

// ----- Settings ------------------------------------------------------------

export interface AppSettings {
  theme: string;
  accent: string;
  editor: {
    autoCompile: boolean;
    vimMode: boolean;
    lineWrap: boolean;
    fontSize: number;
    stopOnFirstError: boolean;
    lineNumbers: boolean;
    highlightActiveLine: boolean;
    autocomplete: boolean;
    bracketMatching: boolean;
    autoCloseBrackets: boolean;
    tabSize: number;
    lineHeight: string;
    autosaveDelayMs: number;
    pdfDefaultZoom: number;
    pdfInvertDark: boolean;
    visualModeLatex: boolean;
  };
  projectsRoot: string;
  compileEngine: string;
  onboarded: boolean;
  ui: UiSettings;
  workspace: WorkspaceSettings;
  integrations: IntegrationsSettings;
  // Optional: settings.json files predating the privacy section lack it.
  privacy?: PrivacySettings;
  // Optional: settings.json files predating the updates section lack it.
  updates?: UpdatesSettings;
  // Optional: settings.json files predating the sync section lack it.
  sync?: SyncSettings;
  // Optional: settings.json files predating the history section lack it.
  history?: HistorySettings;
  // Optional: settings.json files predating the feedback section lack it.
  feedback?: FeedbackSettings;
}

/** Occasional in-app "give us feedback" card — nothing is sent without an
 *  explicit Send, so the prompt itself defaults ON. */
export interface FeedbackSettings {
  promptsEnabled: boolean;
}

/** Local file-history retention (versions kept per file, clamped 10–200). */
export interface HistorySettings {
  maxVersionsPerFile: number;
}

/** Settings-sync preferences — device-local (the toggle itself never syncs). */
export interface SyncSettings {
  syncSettings: boolean;
}

/** Auto-update preferences. The launch check is a plain HTTPS GET to GitHub. */
export interface UpdatesSettings {
  checkAutomatically: boolean;
}

/** Egress opt-ins — everything defaults to OFF (zero reporting unless enabled). */
export interface PrivacySettings {
  shareCrashReports: boolean;
  /** Random UUIDv4 attached to crash reports. Rust mints it on the first
   *  submission; the frontend only preserves it across settings roundtrips. */
  installId?: string;
}

export interface UiSettings {
  density: string; // "compact" | "cozy" | "comfortable"
  /** Interface scale in percent (90–150, step 5). Optional: settings.json
   *  files predating the field lack it; absent = 100. */
  uiScale?: number;
  animations: boolean;
  ambientLights: boolean;
  accentGradient: boolean;
  glowEffects: boolean;
  customThemesEnabled: boolean;
  activeCustomTheme: string | null;
}

export interface WorkspaceSettings {
  enableSpaces: boolean;
  enableTags: boolean;
  notificationsPanelDefault: boolean;
  defaultView: string; // "cards" | "list"
  defaultSort: string; // "last-opened" | "created" | "name" | "modified" | "format"
  /** Per-card enable map for the Projects dashboard (legacy `widgets` name). */
  widgets: Record<string, boolean>;
  dashboardEnabled: boolean;
  dashboardOrder: string[];
  /** Show an approximate word count on each project card. */
  projectCardWords: boolean;
  /** Stat ids shown on the dashboard Statistics card (frontend coerces). */
  statsCards: string[];
  /** User-defined library spaces catalog (order = display order). */
  spaces: SpaceDef[];
  /** Editor pane layout ("split" | "editor" | "preview"). Optional:
   *  settings.json files predating the field lack it; absent = "split". */
  editorLayout?: string;
  /** Console dock ("drawer" | "pdf-tab"). Optional; absent = "pdf-tab". */
  consolePosition?: string;
  /** Sidebar width in px once the user drags the handle; null/absent = keep
   *  auto-fitting the tab strip. */
  sidebarPx?: number | null;
  /** Editor panel's fraction of the editor/preview split. Optional; absent
   *  = 0.55. */
  centerSplit?: number;
}

/** A library "space" — a named, tinted grouping. `tint` is a palette id. */
export interface SpaceDef {
  id: string;
  name: string;
  tint: string;
}

/**
 * Per-integration preferences. Tokens NEVER live here — they're stored via
 * the OS keyring (see src/integrations/auth/credentials.ts). The fields
 * below only reference *which* keyring slot is in use.
 */
export interface IntegrationsSettings {
  references: ReferencesProvidersSettings;
  cloud: {
    accounts: Array<{
      provider: string;
      accountId: string;
      label?: string;
      baseUrl?: string;
      username?: string;
      allowPrivateHost?: boolean;
    }>;
  };
  vcs: {
    git: { authorName?: string; authorEmail?: string };
    github: { accountId?: string };
  };
  ai: {
    /** Master switch — off hides every AI surface and deactivates providers. */
    enabled: boolean;
    activeProvider?: string;
    ollamaBaseUrl?: string;
    perProviderModel: Record<string, string>;
  };
  grammar: { enabled: boolean; language?: string };
  templates: { recentTemplateIds: string[] };
  account: { signedInEmail?: string; lastValidatedAt?: string };
}

export interface ReferencesProvidersSettings {
  activeProvider?: string;
  betterBibTex: { enabled: boolean };
  zoteroWeb: { userId?: string };
  mendeley: { profileId?: string; displayName?: string; redirectUri?: string };
}

export const loadSettings = (): Promise<AppSettings> => invoke("load_settings");

/** Overwrite settings.json with the defaults (Settings → Security → Reset). */
export const resetSettings = (): Promise<void> => invoke("reset_settings");

/**
 * Zip the project sources (skips `.git`/`.typeward`, symlinks, build junk)
 * into the project's `.typeward/build/` sidecar and return the zip's path.
 */
export const exportProjectZip = (project: Project): Promise<string> =>
  invoke("export_project_zip", { project });

/**
 * Convert the project's root document to Word (`.docx`) or standalone HTML via
 * pandoc. The artifact lands in the project's `.typeward/build/` sidecar and
 * its absolute path is returned; the frontend copies the bytes to the user's
 * chosen destination through the dialog (same tail as {@link exportProjectZip}).
 */
export const exportPandoc = (
  project: Project,
  format: "docx" | "html",
): Promise<string> => invoke("export_pandoc", { project, format });

/** One review comment flattened into a PDF sticky note (source anchor + text). */
export interface AnnotationInput {
  /** Source file relative to the project root. */
  file: string;
  /** 1-based source line. */
  line: number;
  title: string;
  body: string;
}

/** An annotation that couldn't be placed (no SyncTeX mapping, missing file…). */
export interface SkippedAnnotation {
  file: string;
  line: number;
  reason: string;
}

export interface AnnotatedExportResult {
  /** Absolute path of the annotated PDF in `.typeward/build/`. */
  path: string;
  /** Count of successfully placed annotations. */
  annotated: number;
  skipped: SkippedAnnotation[];
}

/**
 * Place review comments into the compiled PDF as `/Text` sticky notes, mapped
 * to page coordinates via SyncTeX forward search. LaTeX-only (needs SyncTeX).
 */
export const exportPdfAnnotated = (
  project: Project,
  pdfPath: string,
  annotations: AnnotationInput[],
): Promise<AnnotatedExportResult> =>
  invoke("export_pdf_annotated", { project, pdfPath, annotations });

export const saveSettings = (settings: AppSettings): Promise<void> =>
  invoke("save_settings", { settings });

/** Last server `updated_at` + value hash for one synced settings key. */
export interface SyncKeyState {
  seenUpdatedAt: string;
  hash: string;
}

/**
 * `<app_data>/settings-sync.json`: per-key sync bookkeeping keyed by Supabase
 * user id (account switching must not cross-apply). Lives outside settings.json
 * so a settings roundtrip or Reset can't clobber it.
 */
export type SettingsSyncState = Record<string, Record<string, SyncKeyState>>;

export const loadSyncState = (): Promise<SettingsSyncState> => invoke("load_sync_state");

export const saveSyncState = (state: SettingsSyncState): Promise<void> =>
  invoke("save_sync_state", { state });

// ----- Custom themes -------------------------------------------------------

export interface CustomTheme {
  id: string;
  name: string;
  base: string; // one of the built-in theme ids
  tokens: Record<string, string>;
}

export interface CustomThemesResult {
  themes: CustomTheme[];
  /** One line per file that failed validation (typo'd token, bad base, …). */
  warnings: string[];
}

/** Scan `<app_data>/themes/*.json` for user-authored themes. */
export const customThemesList = (): Promise<CustomThemesResult> =>
  invoke("custom_themes_list");

/** Write the bundled sample theme (no-op if present); returns its path. */
export const customThemeWriteSample = (): Promise<string> =>
  invoke("custom_theme_write_sample");

/** Open the custom themes folder in the OS file manager. */
export const customThemesOpenDir = (): Promise<void> =>
  invoke("custom_themes_open_dir");

// ----- Git ----------------------------------------------------------------

export type GitChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "typechange"
  | "none";

export interface GitFileStatus {
  path: string;
  staged: GitChangeKind;
  unstaged: GitChangeKind;
  untracked: boolean;
}

export interface GitStatusSummary {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitCommit {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  /** Unix epoch seconds. */
  timestamp: number;
}

export interface GitBranch {
  name: string;
  isHead: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitAuthor {
  name: string;
  email: string;
}

/** libgit2 (git2/OpenSSL) is desktop-only — the git commands are cfg-gated out
 * of mobile builds. `gitAvailable()` is the single lever every VCS surface
 * checks so mobile degrades to "no SCM" instead of throwing on an unknown IPC
 * command. */
export const gitAvailable = (): boolean => isDesktop();

export const gitInit = (repoPath: string, bare = false): Promise<void> => {
  assertDesktopCommand("git_init");
  return invoke("git_init", { repoPath, bare });
};

export const gitStatus = (repoPath: string): Promise<GitStatusSummary> => {
  assertDesktopCommand("git_status");
  return invoke("git_status", { repoPath });
};

export const gitStage = (repoPath: string, paths: string[]): Promise<void> => {
  assertDesktopCommand("git_stage");
  return invoke("git_stage", { repoPath, paths });
};

export const gitUnstage = (repoPath: string, paths: string[]): Promise<void> => {
  assertDesktopCommand("git_unstage");
  return invoke("git_unstage", { repoPath, paths });
};

export const gitCommit = (
  repoPath: string,
  message: string,
  author?: GitAuthor,
): Promise<string> => {
  assertDesktopCommand("git_commit");
  return invoke("git_commit", { repoPath, message, author });
};

export const gitLog = (repoPath: string, limit?: number): Promise<GitCommit[]> => {
  assertDesktopCommand("git_log");
  return invoke("git_log", { repoPath, limit });
};

export const gitBranchList = (repoPath: string): Promise<GitBranch[]> => {
  assertDesktopCommand("git_branch_list");
  return invoke("git_branch_list", { repoPath });
};

export const gitBranchCreate = (
  repoPath: string,
  name: string,
  checkout = false,
): Promise<void> => {
  assertDesktopCommand("git_branch_create");
  return invoke("git_branch_create", { repoPath, name, checkout });
};

export const gitBranchCheckout = (repoPath: string, name: string): Promise<void> => {
  assertDesktopCommand("git_branch_checkout");
  return invoke("git_branch_checkout", { repoPath, name });
};

export const gitFetch = (repoPath: string, remote?: string): Promise<void> => {
  assertDesktopCommand("git_fetch");
  return invoke("git_fetch", { repoPath, remote });
};

export const gitPull = (
  repoPath: string,
  remote?: string,
  author?: GitAuthor,
): Promise<void> => {
  assertDesktopCommand("git_pull");
  return invoke("git_pull", { repoPath, remote, author });
};

export const gitPush = (
  repoPath: string,
  remote?: string,
  branch?: string,
): Promise<void> => {
  assertDesktopCommand("git_push");
  return invoke("git_push", { repoPath, remote, branch });
};

export const gitClone = (url: string, destPath: string): Promise<void> => {
  assertDesktopCommand("git_clone");
  return invoke("git_clone", { url, destPath });
};

export const overleafImportZip = (
  zipPath: string,
  parentDir: string,
  name: string,
): Promise<Project> => invoke("overleaf_import_zip", { zipPath, parentDir, name });

// ----- Grammar -----------------------------------------------------------

export type GrammarSyntax = "plain" | "markdown" | "latex" | "typst";

/** BCP-47 tags Harper's five English dialects map from. */
export type GrammarDialect = "en-US" | "en-GB" | "en-CA" | "en-AU" | "en-IN";

export const GRAMMAR_DIALECTS: readonly GrammarDialect[] = [
  "en-US",
  "en-GB",
  "en-CA",
  "en-AU",
  "en-IN",
];

/** Narrow a persisted `grammar.language` string to a known dialect, or undefined. */
export function asGrammarDialect(
  raw: string | undefined | null,
): GrammarDialect | undefined {
  return raw && (GRAMMAR_DIALECTS as readonly string[]).includes(raw)
    ? (raw as GrammarDialect)
    : undefined;
}

export interface GrammarDiagnostic {
  severity: "warning" | "info";
  message: string;
  file: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  source: string;
  replacements: string[];
  /** Harper `LintKind` key, e.g. "Spelling", "WordChoice". */
  kind: string;
  /** Position-agnostic lint hash (decimal string) for `grammarIgnoreLint`. */
  contextHash: string;
}

export const grammarCheck = (
  text: string,
  file: string,
  syntax: GrammarSyntax = "plain",
  dialect?: GrammarDialect,
): Promise<GrammarDiagnostic[]> =>
  invoke("grammar_check", { text, file, syntax, dialect: dialect ?? null });

/** Add a word to the app-global personal dictionary (Harper stops flagging it). */
export const grammarAddWord = (word: string): Promise<void> =>
  invoke("grammar_add_word", { word });

export const grammarRemoveWord = (word: string): Promise<void> =>
  invoke("grammar_remove_word", { word });

export const grammarListWords = (): Promise<string[]> =>
  invoke("grammar_list_words");

/** Suppress a specific lint everywhere it recurs, by its `contextHash`. */
export const grammarIgnoreLint = (contextHash: string): Promise<void> =>
  invoke("grammar_ignore_lint", { contextHash });

export const grammarClearIgnored = (): Promise<void> =>
  invoke("grammar_clear_ignored");

// ----- Templates --------------------------------------------------------

export interface TemplateVariable {
  key: string;
  label: string;
  default: string;
  multiline: boolean;
}

export interface TemplateFile {
  path: string;
  template: boolean;
}

export interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  format: ProjectFormat;
  tags: string[];
  thumbnail: string | null;
  rootFile: string;
  variables: TemplateVariable[];
  files: TemplateFile[];
  entitlement: string | null;
  source: "builtin" | "custom";
}

export const templatesList = (): Promise<TemplateManifest[]> =>
  invoke("templates_list");

export const templateInstantiate = (
  templateId: string,
  destParent: string,
  name: string,
  vars: Record<string, string>,
): Promise<Project> =>
  invoke("template_instantiate", { templateId, destParent, name, vars });

export const templateSave = (
  project: Project,
  name: string,
  description: string,
): Promise<TemplateManifest> =>
  invoke("template_save", { project, name, description });

// ----- Autosave / recovery -------------------------------------------------

export interface Snapshot {
  relPath: string;
  content: string;
  snapshotMtime: number;
  fileMtime: number | null;
}

export const writeSnapshot = (
  projectRoot: string,
  relPath: string,
  content: string,
): Promise<void> => invoke("write_snapshot", { projectRoot, relPath, content });

export const clearSnapshot = (
  projectRoot: string,
  relPath: string,
): Promise<void> => invoke("clear_snapshot", { projectRoot, relPath });

export const listOrphanSnapshots = (projectRoot: string): Promise<Snapshot[]> =>
  invoke("list_orphan_snapshots", { projectRoot });

// ----- Project history -------------------------------------------------------

/** One recorded version of one file. `ts` epoch ms, `size` uncompressed bytes. */
export interface HistoryVersion {
  /** SHA-256 of the uncompressed content (the blob's content address). */
  hash: string;
  ts: number;
  size: number;
}

/**
 * Record the file's current on-disk state into the local version history.
 * Resolves `false` on the normal skips (unchanged content, inside the
 * 5-minute throttle window, untracked extension, oversize) — callers on the
 * save path fire-and-forget this; it must never block or fail a save.
 */
export const historyRecord = (
  projectRoot: string,
  relPath: string,
  forced = false,
): Promise<boolean> => invoke("history_record", { projectRoot, relPath, forced });

/** One file's recorded versions, newest first. */
export const historyList = (
  projectRoot: string,
  relPath: string,
): Promise<HistoryVersion[]> => invoke("history_list", { projectRoot, relPath });

/** Decompress one recorded version. The hash must belong to this file's history. */
export const historyReadVersion = (
  projectRoot: string,
  relPath: string,
  hash: string,
): Promise<string> => invoke("history_read_version", { projectRoot, relPath, hash });

/**
 * Overwrite the working file with a recorded version. Rust force-records the
 * current on-disk state first, so the overwritten state is always one entry
 * up in the same list. Returns the restored content for the buffer refresh.
 */
export const historyRestore = (
  projectRoot: string,
  relPath: string,
  hash: string,
): Promise<string> => invoke("history_restore", { projectRoot, relPath, hash });

/** Delete one project's entire version history (blobs + index). */
export const historyClear = (projectRoot: string): Promise<void> =>
  invoke("history_clear", { projectRoot });

// ----- Telemetry -----------------------------------------------------------

export interface TelemetryEvent {
  at: string;
  kind: string;
  summary: string;
  detail: string | null;
}

export const recordTelemetry = (
  kind: string,
  summary: string,
  detail?: string,
): Promise<void> => invoke("record_event", { kind, summary, detail });

export const listRecentTelemetry = (limit?: number): Promise<TelemetryEvent[]> =>
  invoke("list_recent_events", { limit });

/** Raw telemetry.log contents (bounded file) for the Export-log save-as flow. */
export const readTelemetryLog = (): Promise<string> =>
  invoke("read_telemetry_log");

// ----- Crash reports (Diagnostics) ------------------------------------------

/**
 * The exact scrubbed payload `submitErrorReport` would send, plus attached
 * metadata. Computed WITHOUT sending — the confirm dialog renders it verbatim.
 */
export interface ReportPreview {
  kind: string;
  at: string;
  summary: string;
  detail: string | null;
  appVersion: string;
  os: string;
  osVersion: string;
  arch: string;
  /** Null until the first submission mints one. */
  installId: string | null;
}

export const previewErrorReport = (
  event: TelemetryEvent,
): Promise<ReportPreview> => invoke("preview_error_report", { event });

export interface SubmitReportResult {
  installId: string;
}

/** Send ONE user-confirmed event to Sentry (scrubbed in Rust before egress). */
export const submitErrorReport = (
  event: TelemetryEvent,
): Promise<SubmitReportResult> => invoke("submit_error_report", { event });

export interface CrashScanResult {
  submitted: number;
  installId: string | null;
}

/**
 * Crash-on-previous-run scan: submits watermark-new `panic` events (max 5).
 * No-ops unless `privacy.shareCrashReports` is on (re-checked in Rust) and
 * runs at most once per process.
 */
export const scanAndSubmitCrashes = (): Promise<CrashScanResult> =>
  invoke("scan_and_submit_crashes");

// ----- System info (Diagnostics header / bug reports) ------------------------

export interface SystemToolProbe {
  name: string;
  /** PATH probe result only — never the resolved path. */
  found: boolean;
}

export interface SystemInfo {
  appVersion: string;
  os: string;
  osVersion: string;
  arch: string;
  compileEngine: string;
  tools: SystemToolProbe[];
}

export const collectSystemInfo = (): Promise<SystemInfo> =>
  invoke("collect_system_info");

/**
 * Clear a stored shell-escape DENIAL so the trust prompt can run again — the
 * reverse path for "Blocked on this machine". A stored grant is untouched.
 */
export const trustClearShellEscape = (projectRoot: string): Promise<void> =>
  invoke("trust_clear_shell_escape", { projectRoot });
