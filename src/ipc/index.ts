import { invoke } from "@tauri-apps/api/core";
import type {
  CompileResult,
  Diagnostic,
  Project,
  ProjectFormat,
  ProjectIntegrations,
} from "~/adapters/types";

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

export const detectTex = (): Promise<EngineProbe> => invoke("detect_tex");

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
 */
export const readProjectBinaryFile = async (
  projectRoot: string,
  relPath: string,
): Promise<Uint8Array> => {
  const bytes = await invoke<number[]>("read_project_binary_file", {
    projectRoot,
    relPath,
  });
  return Uint8Array.from(bytes);
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
 */
export const writeProjectBinaryFile = (
  projectRoot: string,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> =>
  invoke("write_project_binary_file", {
    projectRoot,
    relPath,
    bytes: Array.from(bytes),
  });

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

export const compileLatex = async (
  project: Project,
  engine?: "system-tex" | "tectonic",
  haltOnError?: boolean,
): Promise<CompileResult> => {
  const result = await invoke<BackendCompileResult>("compile_latex", {
    project,
    engine,
    haltOnError,
  });
  return {
    ok: result.ok,
    outputPath: result.outputPath,
    diagnostics: result.diagnostics,
    log: result.log,
    durationMs: result.durationMs,
  };
};

export const compileTypst = async (project: Project): Promise<CompileResult> => {
  const result = await invoke<BackendCompileResult>("compile_typst", { project });
  return {
    ok: result.ok,
    outputPath: result.outputPath,
    diagnostics: result.diagnostics,
    log: result.log,
    durationMs: result.durationMs,
  };
};

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
}): Promise<SyncTexForwardLocation | null> =>
  invoke("synctex_forward", { args });

export const synctexInverse = (args: {
  projectRoot: string;
  pdfPath: string;
  page: number;
  x: number;
  y: number;
}): Promise<SyncTexInverseLocation | null> =>
  invoke("synctex_inverse", { args });

// ----- Settings ------------------------------------------------------------

export interface AppSettings {
  theme: string;
  accent: string;
  editor: {
    autoCompile: boolean;
    vimMode: boolean;
    spellCheck: boolean;
    lineWrap: boolean;
    fontSize: number;
    stopOnFirstError: boolean;
  };
  projectsRoot: string;
  compileEngine: string;
  onboarded: boolean;
  ui: UiSettings;
  workspace: WorkspaceSettings;
  integrations: IntegrationsSettings;
}

export interface UiSettings {
  density: string; // "compact" | "cozy" | "comfortable"
  animations: boolean;
  ambientLights: boolean;
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
  mendeley: { profileId?: string; displayName?: string };
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

export const saveSettings = (settings: AppSettings): Promise<void> =>
  invoke("save_settings", { settings });

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

export const gitInit = (repoPath: string, bare = false): Promise<void> =>
  invoke("git_init", { repoPath, bare });

export const gitStatus = (repoPath: string): Promise<GitStatusSummary> =>
  invoke("git_status", { repoPath });

export const gitStage = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_stage", { repoPath, paths });

export const gitUnstage = (repoPath: string, paths: string[]): Promise<void> =>
  invoke("git_unstage", { repoPath, paths });

export const gitCommit = (
  repoPath: string,
  message: string,
  author?: GitAuthor,
): Promise<string> => invoke("git_commit", { repoPath, message, author });

export const gitLog = (repoPath: string, limit?: number): Promise<GitCommit[]> =>
  invoke("git_log", { repoPath, limit });

export const gitBranchList = (repoPath: string): Promise<GitBranch[]> =>
  invoke("git_branch_list", { repoPath });

export const gitBranchCreate = (
  repoPath: string,
  name: string,
  checkout = false,
): Promise<void> => invoke("git_branch_create", { repoPath, name, checkout });

export const gitBranchCheckout = (repoPath: string, name: string): Promise<void> =>
  invoke("git_branch_checkout", { repoPath, name });

export const gitFetch = (repoPath: string, remote?: string): Promise<void> =>
  invoke("git_fetch", { repoPath, remote });

export const gitPull = (
  repoPath: string,
  remote?: string,
  author?: GitAuthor,
): Promise<void> => invoke("git_pull", { repoPath, remote, author });

export const gitPush = (
  repoPath: string,
  remote?: string,
  branch?: string,
): Promise<void> => invoke("git_push", { repoPath, remote, branch });

export const gitClone = (url: string, destPath: string): Promise<void> =>
  invoke("git_clone", { url, destPath });

export const overleafImportZip = (
  zipPath: string,
  parentDir: string,
  name: string,
): Promise<Project> => invoke("overleaf_import_zip", { zipPath, parentDir, name });

// ----- Grammar -----------------------------------------------------------

export type GrammarSyntax = "plain" | "latex" | "typst";

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
}

export const grammarCheck = (
  text: string,
  file: string,
  syntax: GrammarSyntax = "plain",
): Promise<GrammarDiagnostic[]> =>
  invoke("grammar_check", { text, file, syntax });

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
