use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fs_ops;

/// User settings persisted to `<app_data_dir>/settings.json`. Themes/accents
/// also live in localStorage on the frontend for instant boot, but this file
/// is the durable copy that survives a webview cache clear.
///
/// New sections (`ui`, `workspace`) carry `#[serde(default)]` so older
/// settings.json files don't break on upgrade — missing fields fall back to
/// their per-section defaults.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: String,
    pub accent: String,
    pub editor: EditorSettings,
    #[serde(rename = "projectsRoot")]
    pub projects_root: String,
    #[serde(rename = "compileEngine")]
    pub compile_engine: String,
    #[serde(default)]
    pub onboarded: bool,
    #[serde(default)]
    pub ui: UiSettings,
    #[serde(default)]
    pub workspace: WorkspaceSettings,
    #[serde(default)]
    pub integrations: IntegrationsSettings,
    #[serde(default)]
    pub profile: ProfileSettings,
    #[serde(default)]
    pub updates: UpdatesSettings,
    #[serde(default)]
    pub history: HistorySettings,
    #[serde(default)]
    pub compile: CompileSettings,
}

/// Compile behaviour the Rust side owns.
///
/// `strictOffline` passes Tectonic's `--only-cached`, so a compile can never
/// reach the network — the honest backing for an "offline" claim. Default OFF:
/// Tectonic downloads packages on first use, and turning this on before the
/// cache is warm breaks builds. `None` means "not specified by the caller" and
/// is preserved across settings saves (see [`save`]).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompileSettings {
    #[serde(
        rename = "strictOffline",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub strict_offline: Option<bool>,
}

/// Local per-file version-history retention (history.rs). Clamped to
/// 10–200 at the load boundary — the TS store applies the same clamp
/// (settings-store.ts), so an out-of-range value from a hand-edited
/// settings.json can't balloon the store or truncate it to nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistorySettings {
    #[serde(
        rename = "maxVersionsPerFile",
        default = "default_history_max_versions"
    )]
    pub max_versions_per_file: u32,
}

pub const HISTORY_MIN_VERSIONS_PER_FILE: u32 = 10;
pub const HISTORY_MAX_VERSIONS_PER_FILE: u32 = 200;

fn default_history_max_versions() -> u32 {
    50
}

impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            max_versions_per_file: default_history_max_versions(),
        }
    }
}

/// Auto-update preferences. The check is a plain HTTPS GET to the GitHub
/// releases manifest — no identifiers, no telemetry — so this defaults ON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatesSettings {
    #[serde(rename = "checkAutomatically", default = "default_true")]
    pub check_automatically: bool,
}

impl Default for UpdatesSettings {
    fn default() -> Self {
        Self {
            check_automatically: true,
        }
    }
}

/// Who the user is, as far as this machine is concerned. Purely local: it
/// seeds a template's `author` variable. Nothing here is transmitted. (Git
/// commit identity comes from the user's own gitconfig, never from here.)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProfileSettings {
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub affiliation: String,
    /// Absolute path of the avatar image copied into `<app_data>/profile/`.
    /// Backend-owned — only `profile::set_profile_avatar` /
    /// `profile::clear_profile_avatar` ever write it, so a renderer save that
    /// omits it must not clear it (see [`merge_backend_owned`]). Absent until
    /// the user picks one.
    #[serde(
        rename = "avatarPath",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub avatar_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSettings {
    #[serde(rename = "autoCompile")]
    pub auto_compile: bool,
    /// "none" | "vim" | "emacs". The empty serde default is a sentinel for
    /// "absent from the file" so `sanitize_loaded_settings` can migrate the
    /// legacy boolean below without clobbering an explicit "none".
    #[serde(default)]
    pub keybindings: String,
    /// Pre-2026-08-13 shape: `vimMode: bool`. Read-only migration input —
    /// never serialized back, so the key disappears on the next save.
    #[serde(rename = "vimMode", default, skip_serializing)]
    pub legacy_vim_mode: bool,
    #[serde(rename = "lineWrap")]
    pub line_wrap: bool,
    #[serde(rename = "fontSize")]
    pub font_size: u16,
    // Halting matches the engines' historical hardcoded behavior, so the
    // serde default keeps older settings.json files loading unchanged.
    #[serde(rename = "stopOnFirstError", default = "default_true")]
    pub stop_on_first_error: bool,
    // Additive editor-behavior fields; each defaults so older settings.json
    // files load unchanged. (The removed `spellCheck` key is simply ignored.)
    #[serde(rename = "lineNumbers", default = "default_true")]
    pub line_numbers: bool,
    #[serde(rename = "highlightActiveLine", default = "default_true")]
    pub highlight_active_line: bool,
    #[serde(default = "default_true")]
    pub autocomplete: bool,
    #[serde(rename = "bracketMatching", default = "default_true")]
    pub bracket_matching: bool,
    #[serde(rename = "autoCloseBrackets", default = "default_true")]
    pub auto_close_brackets: bool,
    #[serde(rename = "tabSize", default = "default_tab_size")]
    pub tab_size: u8,
    #[serde(rename = "lineHeight", default = "default_line_height")]
    pub line_height: String,
    /// When on, the idle debounce writes the buffer to disk; when off it only
    /// snapshots for crash recovery. Rust never reads it — it exists here so the
    /// renderer's choice survives the save/load roundtrip instead of being
    /// dropped by serde and restored to the default on the next launch.
    #[serde(rename = "autosaveEnabled", default = "default_true")]
    pub autosave_enabled: bool,
    #[serde(rename = "autosaveDelayMs", default = "default_autosave_delay")]
    pub autosave_delay_ms: u32,
    #[serde(rename = "pdfDefaultZoom", default = "default_pdf_zoom")]
    pub pdf_default_zoom: u16,
    #[serde(rename = "pdfInvertDark", default)]
    pub pdf_invert_dark: bool,
    #[serde(rename = "visualModeLatex", default)]
    pub visual_mode_latex: bool,
}

fn default_tab_size() -> u8 {
    2
}
fn default_line_height() -> String {
    "normal".into()
}
fn default_autosave_delay() -> u32 {
    500
}
fn default_pdf_zoom() -> u16 {
    110
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiSettings {
    pub density: String,
    /// Interface scale in percent (100 = 1.0). The frontend owns the 90–150
    /// step-5 clamp at its load boundary; Rust only round-trips the value.
    #[serde(rename = "uiScale", default = "default_ui_scale")]
    pub ui_scale: u16,
    pub animations: bool,
    #[serde(rename = "ambientLights", default = "default_true")]
    pub ambient_lights: bool,
    #[serde(rename = "accentGradient", default = "default_true")]
    pub accent_gradient: bool,
    #[serde(rename = "glowEffects", default = "default_true")]
    pub glow_effects: bool,
    #[serde(rename = "customThemesEnabled")]
    pub custom_themes_enabled: bool,
    #[serde(rename = "activeCustomTheme")]
    pub active_custom_theme: Option<String>,
}

fn default_true() -> bool {
    true
}
fn default_ui_scale() -> u16 {
    100
}

/// Integrations preferences. Each sub-section is `#[serde(default)]` so the
/// block stays additive across versions — older settings.json files load
/// against the new binary without losing any other fields.
///
/// Phase 0 ships the shape with all sub-sections empty. Phases 1–7 populate
/// the relevant subset (Zotero account refs, cloud provider state, AI active
/// provider, etc.). Tokens NEVER live here — credentials go through the OS
/// keyring via `integrations::credentials`. Anything in this struct that
/// references a credential carries only an *account identifier*, never the
/// secret itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntegrationsSettings {
    #[serde(default)]
    pub references: ReferencesSettings,
    #[serde(default)]
    pub cloud: CloudSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub grammar: GrammarSettings,
    #[serde(default)]
    pub templates: TemplatesSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReferencesSettings {
    /// Identifier of the active provider for the picker UI when multiple
    /// are configured. Optional — when absent, all enabled providers fan
    /// out in parallel.
    #[serde(rename = "activeProvider", default)]
    pub active_provider: Option<String>,
    #[serde(rename = "betterBibTex", default)]
    pub better_bib_tex: BetterBibTexSettings,
    #[serde(rename = "zoteroWeb", default)]
    pub zotero_web: ZoteroWebSettings,
    #[serde(default)]
    pub mendeley: MendeleyAccountSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BetterBibTexSettings {
    /// Local Zotero provider on/off. Libraries (personal + groups) are
    /// auto-discovered, so there's no library-id field anymore — a stale
    /// `libraryId` in an older settings.json is simply ignored on read.
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ZoteroWebSettings {
    /// Numeric Zotero user id. The API key lives in the OS keyring under
    /// service `zotero-web`, account = user id.
    #[serde(rename = "userId", default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MendeleyAccountSettings {
    /// Mendeley profile id of the connected account. The token bundle
    /// (access + refresh + expiry) lives in the OS keyring under
    /// service `mendeley`, account = profile id.
    #[serde(rename = "profileId", default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
    /// The exact redirect URL registered in the user's Mendeley app. Mirrored
    /// by the OAuth flow so it matches Mendeley's exact-match check. Not secret.
    #[serde(
        rename = "redirectUri",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub redirect_uri: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CloudSettings {
    #[serde(default)]
    pub accounts: Vec<CloudAccountRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudAccountRef {
    pub provider: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub label: Option<String>,
    // WebDAV accounts carry their server URL + username here (the password is
    // in the keyring). Optional so an account written by an older build still
    // deserializes; the frontend turns a missing value into a reconnect prompt.
    #[serde(rename = "baseUrl", default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(
        rename = "allowPrivateHost",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub allow_private_host: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiSettings {
    /// Master switch. When off, the editor hides every AI surface (chat
    /// panel, toolbar toggle) and no provider activates — zero AI traffic.
    /// Defaults OFF: every AI provider needs a key or a local daemon the user
    /// has to set up first, so an opt-in switch matches the grammar checker.
    #[serde(default)]
    pub enabled: bool,
    #[serde(rename = "activeProvider", default)]
    pub active_provider: Option<String>,
    #[serde(rename = "ollamaBaseUrl", default)]
    pub ollama_base_url: Option<String>,
    #[serde(rename = "perProviderModel", default)]
    pub per_provider_model: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrammarSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TemplatesSettings {
    #[serde(rename = "recentTemplateIds", default)]
    pub recent_template_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSettings {
    #[serde(rename = "enableSpaces")]
    pub enable_spaces: bool,
    #[serde(rename = "enableTags")]
    pub enable_tags: bool,
    #[serde(rename = "notificationsPanelDefault")]
    pub notifications_panel_default: bool,
    #[serde(rename = "defaultView")]
    pub default_view: String,
    #[serde(rename = "defaultSort")]
    pub default_sort: String,
    /// Per-card enable map for the Projects dashboard (legacy name kept so
    /// pre-dashboard settings.json files carry their toggles over).
    pub widgets: HashMap<String, bool>,
    /// Whether the dashboard panel shows above the project grid.
    #[serde(rename = "dashboardEnabled", default)]
    pub dashboard_enabled: bool,
    /// User-arranged card order (drag & drop). Unknown ids are ignored;
    /// missing ids append in registry order.
    #[serde(rename = "dashboardOrder", default)]
    pub dashboard_order: Vec<String>,
    /// Show an approximate word count on each project card. Opt-in because it
    /// reads each project's root file when the library renders.
    #[serde(rename = "projectCardWords", default)]
    pub project_card_words: bool,
    /// Which summary statistics the dashboard Statistics card shows (ids from
    /// the frontend stat catalog). The frontend coerces unknown ids and caps
    /// the count, so this is stored loosely.
    #[serde(rename = "statsCards", default = "default_stats_cards")]
    pub stats_cards: Vec<String>,
    /// User-defined library spaces (the catalog; per-project membership lives in
    /// each project.json `space` field). Order = display order. Additive.
    #[serde(default)]
    pub spaces: Vec<SpaceDef>,
    /// Editor pane layout ("split" | "editor" | "preview"). The frontend owns
    /// the enum validation at its load boundary; Rust only round-trips it.
    #[serde(rename = "editorLayout", default = "default_editor_layout")]
    pub editor_layout: String,
    /// Where the logs/issues console docks ("drawer" | "pdf-tab").
    #[serde(rename = "consolePosition", default = "default_console_position")]
    pub console_position: String,
    /// Sidebar width in px once the user drags the handle. `None` = never
    /// dragged, the sidebar keeps auto-fitting its tab strip.
    #[serde(rename = "sidebarPx", default)]
    pub sidebar_px: Option<u16>,
    /// Editor panel's fraction of the editor/preview split (frontend clamps).
    #[serde(rename = "centerSplit", default = "default_center_split")]
    pub center_split: f64,
}

fn default_editor_layout() -> String {
    "split".into()
}
fn default_console_position() -> String {
    "pdf-tab".into()
}
fn default_center_split() -> f64 {
    0.55
}

/// A workspace "space" — a named, tinted grouping for the library sidebar. The
/// `tint` is a named palette id (not a raw color) so themes re-tint it; the
/// frontend maps it to CSS vars and coerces unknown names.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpaceDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tint: String,
}

fn default_stats_cards() -> Vec<String> {
    vec![
        "latex".into(),
        "typst".into(),
        "deadlines".into(),
        "overdue".into(),
    ]
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // Daylight is the documented brand default; a fresh install with no
            // settings.json must hydrate to it, not the Aurora :root baseline.
            theme: "daylight".into(),
            accent: "violet-cyan".into(),
            editor: EditorSettings::default(),
            projects_root: default_projects_root().to_string_lossy().into(),
            compile_engine: "system-tex".into(),
            onboarded: false,
            ui: UiSettings::default(),
            workspace: WorkspaceSettings::default(),
            integrations: IntegrationsSettings::default(),
            profile: ProfileSettings::default(),
            updates: UpdatesSettings::default(),
            history: HistorySettings::default(),
            compile: CompileSettings::default(),
        }
    }
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            auto_compile: false,
            keybindings: "none".into(),
            legacy_vim_mode: false,
            line_wrap: true,
            font_size: 13,
            stop_on_first_error: true,
            line_numbers: true,
            highlight_active_line: true,
            autocomplete: true,
            bracket_matching: true,
            auto_close_brackets: true,
            tab_size: 2,
            line_height: "normal".into(),
            autosave_enabled: true,
            autosave_delay_ms: 500,
            pdf_default_zoom: 110,
            pdf_invert_dark: false,
            visual_mode_latex: false,
        }
    }
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            density: "cozy".into(),
            ui_scale: 100,
            animations: true,
            ambient_lights: true,
            accent_gradient: true,
            glow_effects: true,
            custom_themes_enabled: false,
            active_custom_theme: None,
        }
    }
}

impl Default for WorkspaceSettings {
    fn default() -> Self {
        Self {
            enable_spaces: true,
            enable_tags: true,
            notifications_panel_default: false,
            default_view: "cards".into(),
            default_sort: "last-opened".into(),
            widgets: HashMap::new(),
            dashboard_enabled: false,
            dashboard_order: Vec::new(),
            project_card_words: false,
            stats_cards: default_stats_cards(),
            spaces: Vec::new(),
            editor_layout: default_editor_layout(),
            console_position: default_console_position(),
            sidebar_px: None,
            center_split: default_center_split(),
        }
    }
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("could not resolve app data dir")]
    NoAppDataDir,
    #[error("projects root must be an absolute path under Documents: {0}")]
    InvalidProjectsRoot(String),
}

/// Containment anchor for mobile, which has no Documents dir at all. Seeded
/// once from setup with the app data dir, before the first settings read.
#[cfg(mobile)]
static ROOT_ANCHOR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Seed the mobile fallback anchor. Must run before any `load`/`save`, since
/// both validate the projects root against it.
#[cfg(mobile)]
pub fn set_root_anchor(dir: PathBuf) {
    let _ = ROOT_ANCHOR.set(dir);
}

#[cfg(mobile)]
fn seeded_anchor() -> Option<PathBuf> {
    ROOT_ANCHOR.get().cloned()
}

#[cfg(not(mobile))]
fn seeded_anchor() -> Option<PathBuf> {
    None
}

/// Directory the projects root must live under. `dirs::document_dir()` is the
/// answer on a normal desktop; without it — mobile always, and Linux installs
/// with no `xdg-user-dirs` configured — fall back to the seeded anchor and then
/// to `~/Documents`. The fallbacks are load-bearing: returning `None` makes
/// every settings write fail validation, and a relative default would put the
/// project library wherever the app happened to be launched from.
fn root_anchor() -> Option<PathBuf> {
    dirs::document_dir()
        .or_else(seeded_anchor)
        .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
}

pub fn default_projects_root() -> PathBuf {
    root_anchor()
        .map(|d| d.join("Typeward"))
        .unwrap_or_else(|| PathBuf::from("Typeward"))
}

fn canonical_existing_ancestor(path: &Path) -> Result<PathBuf, SettingsError> {
    let mut current = path;
    loop {
        if current.exists() {
            return Ok(current.canonicalize()?);
        }
        current = current.parent().ok_or_else(|| {
            SettingsError::InvalidProjectsRoot(path.to_string_lossy().into_owned())
        })?;
    }
}

pub fn validate_projects_root(root: &Path) -> Result<(), SettingsError> {
    if !root.is_absolute() {
        return Err(SettingsError::InvalidProjectsRoot(
            root.to_string_lossy().into_owned(),
        ));
    }
    let documents = root_anchor()
        .ok_or_else(|| SettingsError::InvalidProjectsRoot(root.to_string_lossy().into_owned()))?;
    let documents = canonical_existing_ancestor(&documents)?;
    let candidate = canonical_existing_ancestor(root)?;
    if candidate.starts_with(&documents) {
        Ok(())
    } else {
        Err(SettingsError::InvalidProjectsRoot(
            root.to_string_lossy().into_owned(),
        ))
    }
}

fn sanitize_loaded_settings(mut settings: Settings) -> Settings {
    if validate_projects_root(Path::new(&settings.projects_root)).is_err() {
        settings.projects_root = default_projects_root().to_string_lossy().into_owned();
    }
    settings.history.max_versions_per_file = settings
        .history
        .max_versions_per_file
        .clamp(HISTORY_MIN_VERSIONS_PER_FILE, HISTORY_MAX_VERSIONS_PER_FILE);
    // Enum clamp + legacy migration: a file predating the `keybindings` enum
    // carries only `vimMode`; anything unrecognized degrades to "none".
    settings.editor.keybindings = match settings.editor.keybindings.as_str() {
        "none" | "vim" | "emacs" => settings.editor.keybindings,
        _ if settings.editor.legacy_vim_mode => "vim".into(),
        _ => "none".into(),
    };
    settings
}

fn settings_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, SettingsError> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| SettingsError::NoAppDataDir)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("settings.json"))
}

/// settings.json is read-modify-written from several independent places — the
/// renderer's debounced `save_settings` (which merges backend-owned keys off
/// disk first) and the avatar IPC — and each
/// of those runs on its own `spawn_blocking` thread. Without a lock the two
/// halves of one sequence interleave with another's and whichever section the
/// loser had just changed is silently dropped: a typed display name, or the
/// avatar path whose picture then orphans in app data.
///
/// Blocking is correct here: every caller is already off the event loop, and the
/// critical section is one small file read plus one atomic write.
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

/// A poisoned lock only means another writer panicked mid-sequence; settings.json
/// is written atomically, so continuing is strictly better than wedging every
/// settings write for the rest of the session.
fn lock_settings() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn load(app_handle: &tauri::AppHandle) -> Result<Settings, SettingsError> {
    let _guard = lock_settings();
    load_locked(app_handle)
}

/// The `*_locked` pair is the whole reason [`SETTINGS_LOCK`] can be taken at
/// exactly one level: sequences that need load+save to be atomic call these,
/// the single-shot public entry points wrap them.
fn load_locked(app_handle: &tauri::AppHandle) -> Result<Settings, SettingsError> {
    let path = settings_path(app_handle)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let bytes = fs::read(&path)?;
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(settings) => Ok(sanitize_loaded_settings(settings)),
        Err(e) => {
            // Corrupt settings.json (partial/torn write, disk glitch, bad hand
            // edit). Preserve the original bytes as a `.corrupt` sibling BEFORE
            // returning defaults — otherwise the next save() overwrites and
            // permanently destroys the user's real settings. Only degrade to
            // defaults once the backup actually succeeded; if the rename fails
            // (e.g. a transient Windows sharing violation from AV/indexer),
            // propagate the error and keep the pre-fix behaviour so nothing
            // overwrites the still-present real file.
            let backup = path.with_file_name("settings.json.corrupt");
            match fs::rename(&path, &backup) {
                Ok(()) => {
                    eprintln!(
                        "[settings] settings.json was unreadable ({e}); backed up to {} and reset to defaults.",
                        backup.display()
                    );
                    Ok(Settings::default())
                }
                Err(rename_err) => {
                    eprintln!(
                        "[settings] settings.json was unreadable ({e}) and could not be backed up ({rename_err}); refusing to reset."
                    );
                    Err(e.into())
                }
            }
        }
    }
}

pub fn save(app_handle: &tauri::AppHandle, settings: &Settings) -> Result<(), SettingsError> {
    let _guard = lock_settings();
    save_locked(app_handle, settings)
}

fn save_locked(app_handle: &tauri::AppHandle, settings: &Settings) -> Result<(), SettingsError> {
    validate_projects_root(Path::new(&settings.projects_root))?;
    let path = settings_path(app_handle)?;
    let json = serde_json::to_vec_pretty(settings)?;
    fs_ops::atomic_write(&path, &json)?;
    Ok(())
}

/// Read-modify-write the stored settings as one atomic step. Anything that
/// changes a single section must go through here rather than a `load` / mutate /
/// `save` triple, which races every other writer (see [`SETTINGS_LOCK`]).
pub fn update<F>(app_handle: &tauri::AppHandle, mutate: F) -> Result<(), SettingsError>
where
    F: FnOnce(&mut Settings),
{
    let _guard = lock_settings();
    let mut settings = load_locked(app_handle)?;
    mutate(&mut settings);
    save_locked(app_handle, &settings)
}

/// Persist a payload that came from the renderer, carrying backend-owned keys
/// forward from disk first. Both halves run under one lock so a concurrent
/// backend write can't land between the read and the write and be overwritten.
/// Called on the `save_settings` path only — a Reset writes `Settings::default()`
/// through [`save`] and is meant to clear them.
pub fn save_preserving_backend_owned(
    app_handle: &tauri::AppHandle,
    incoming: &mut Settings,
) -> Result<(), SettingsError> {
    let _guard = lock_settings();
    // Propagate a read failure instead of skipping the merge: a missing file
    // still reads as `Ok(defaults)`, so genuine first boot is unaffected, but an
    // unreadable-yet-present settings.json (transient AV/indexer lock) must not
    // be overwritten with a renderer payload that was itself built from
    // defaults — that silently discards the user's whole configuration.
    let existing = load_locked(app_handle)?;
    merge_backend_owned(incoming, &existing);
    save_locked(app_handle, incoming)
}

/// The renderer's `buildSettings()` payload carries only the keys its own
/// settings tree knows about, so serializing it verbatim would reset any key the
/// backend owns. Carry the on-disk value forward wherever the payload left one
/// unset (`None`); an explicit value from the frontend still wins.
fn merge_backend_owned(incoming: &mut Settings, existing: &Settings) {
    if incoming.compile.strict_offline.is_none() {
        incoming.compile.strict_offline = existing.compile.strict_offline;
    }
    if incoming.profile.avatar_path.is_none() {
        incoming.profile.avatar_path = existing.profile.avatar_path.clone();
    }
}

// Re-export for command handlers
pub use tauri::Manager;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_vim_mode_migrates_to_the_keybindings_enum() {
        // Pre-enum file: only `vimMode: true` — becomes "vim".
        let mut s = Settings::default();
        s.editor.keybindings = String::new();
        s.editor.legacy_vim_mode = true;
        assert_eq!(sanitize_loaded_settings(s).editor.keybindings, "vim");

        // An explicit enum value wins over a stale legacy boolean.
        let mut s = Settings::default();
        s.editor.keybindings = "emacs".into();
        s.editor.legacy_vim_mode = true;
        assert_eq!(sanitize_loaded_settings(s).editor.keybindings, "emacs");

        // Garbage degrades to "none", not to the legacy boolean's absence.
        let mut s = Settings::default();
        s.editor.keybindings = "hjkl".into();
        assert_eq!(sanitize_loaded_settings(s).editor.keybindings, "none");
    }

    #[test]
    fn vim_mode_key_is_read_for_migration_but_never_written_back() {
        let editor: EditorSettings = serde_json::from_value(serde_json::json!({
            "autoCompile": false,
            "vimMode": true,
            "lineWrap": true,
            "fontSize": 13
        }))
        .unwrap();
        assert!(editor.legacy_vim_mode);
        assert_eq!(editor.keybindings, "");
        let out = serde_json::to_value(&editor).unwrap();
        assert!(out.get("vimMode").is_none());
        assert!(out.get("keybindings").is_some());
    }

    #[test]
    fn backend_owned_keys_survive_a_frontend_settings_roundtrip() {
        let mut existing = Settings::default();
        existing.compile.strict_offline = Some(true);

        // What the renderer sends back: its settings tree has no `compile` key.
        let mut payload = serde_json::to_value(Settings::default()).unwrap();
        payload.as_object_mut().unwrap().remove("compile");
        let mut incoming: Settings = serde_json::from_value(payload).unwrap();
        assert_eq!(incoming.compile.strict_offline, None);

        merge_backend_owned(&mut incoming, &existing);
        assert_eq!(incoming.compile.strict_offline, Some(true));
    }

    #[test]
    fn an_explicit_strict_offline_value_wins_over_the_stored_one() {
        let mut existing = Settings::default();
        existing.compile.strict_offline = Some(true);
        let mut incoming = Settings::default();
        incoming.compile.strict_offline = Some(false);

        merge_backend_owned(&mut incoming, &existing);
        assert_eq!(incoming.compile.strict_offline, Some(false));
    }

    #[test]
    fn the_stored_avatar_path_survives_a_frontend_settings_roundtrip() {
        let mut existing = Settings::default();
        existing.profile.avatar_path = Some("/data/profile/avatar.png".into());

        // The renderer never invents an avatar path — it serializes the profile
        // section without one.
        let mut payload = serde_json::to_value(Settings::default()).unwrap();
        payload["profile"]["displayName"] = serde_json::json!("Ada");
        let mut incoming: Settings = serde_json::from_value(payload).unwrap();
        assert_eq!(incoming.profile.avatar_path, None);

        merge_backend_owned(&mut incoming, &existing);
        assert_eq!(
            incoming.profile.avatar_path.as_deref(),
            Some("/data/profile/avatar.png")
        );
        assert_eq!(incoming.profile.display_name, "Ada");
    }

    #[test]
    fn profile_defaults_are_empty_and_the_avatar_key_is_omitted() {
        let settings = Settings::default();
        assert_eq!(settings.profile.display_name, "");
        assert_eq!(settings.profile.email, "");
        assert_eq!(settings.profile.affiliation, "");
        assert_eq!(settings.profile.avatar_path, None);
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"profile\""));
        assert!(!json.contains("avatarPath"));
    }

    #[test]
    fn profile_loads_from_a_settings_file_that_predates_it() {
        let mut payload = serde_json::to_value(Settings::default()).unwrap();
        payload.as_object_mut().unwrap().remove("profile");
        let loaded: Settings = serde_json::from_value(payload).unwrap();
        assert_eq!(loaded.profile.display_name, "");
        assert_eq!(loaded.profile.avatar_path, None);
    }

    /// serde drops unknown keys silently, so an editor field the renderer sends
    /// but this struct lacks is written, discarded, and restored to its default
    /// on the next launch — the user's choice reverting itself every relaunch.
    #[test]
    fn an_editor_toggle_survives_a_settings_roundtrip() {
        let mut settings = Settings::default();
        assert!(settings.editor.autosave_enabled);
        settings.editor.autosave_enabled = false;

        let json = serde_json::to_vec_pretty(&settings).unwrap();
        assert!(String::from_utf8_lossy(&json).contains("\"autosaveEnabled\""));
        let reloaded: Settings = serde_json::from_slice(&json).unwrap();
        assert!(!reloaded.editor.autosave_enabled);
    }

    #[test]
    fn an_editor_blob_predating_the_autosave_toggle_defaults_it_on() {
        let mut payload = serde_json::to_value(Settings::default()).unwrap();
        payload["editor"]
            .as_object_mut()
            .unwrap()
            .remove("autosaveEnabled");
        let loaded: Settings = serde_json::from_value(payload).unwrap();
        assert!(loaded.editor.autosave_enabled);
    }

    #[test]
    fn strict_offline_defaults_off_and_is_omitted_when_unset() {
        let settings = Settings::default();
        assert_eq!(settings.compile.strict_offline, None);
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("strictOffline"));
    }

    #[test]
    fn validate_projects_root_rejects_relative_path() {
        // rootFile flows into engines as a positional arg and the projects root
        // gates clone/init destinations; a non-absolute root must never pass.
        assert!(validate_projects_root(Path::new("relative/dir")).is_err());
        assert!(validate_projects_root(Path::new("")).is_err());
    }

    #[test]
    fn validate_projects_root_rejects_path_outside_documents() {
        // The temp dir lives outside ~/Documents on every supported host.
        let outside = std::env::temp_dir();
        assert!(validate_projects_root(&outside).is_err());
    }

    #[test]
    fn validate_projects_root_accepts_new_dir_under_documents() {
        let Some(docs) = dirs::document_dir() else {
            return;
        };
        if !docs.exists() {
            return;
        }
        // A not-yet-created project directory under Documents validates because
        // its first existing ancestor (Documents) is under the boundary.
        let candidate = docs.join("Typeward").join("test-new-project-xyz");
        assert!(validate_projects_root(&candidate).is_ok());
    }

    #[test]
    fn sanitize_falls_back_when_projects_root_invalid() {
        let s = Settings {
            projects_root: "not/absolute/root".into(),
            ..Settings::default()
        };
        let sanitized = sanitize_loaded_settings(s);
        assert_eq!(
            sanitized.projects_root,
            default_projects_root().to_string_lossy().into_owned()
        );
    }

    #[test]
    fn sanitize_clamps_history_retention_to_bounds() {
        let mut s = Settings::default();
        assert_eq!(s.history.max_versions_per_file, 50);

        s.history.max_versions_per_file = 3;
        assert_eq!(
            sanitize_loaded_settings(s.clone())
                .history
                .max_versions_per_file,
            HISTORY_MIN_VERSIONS_PER_FILE
        );

        s.history.max_versions_per_file = 10_000;
        assert_eq!(
            sanitize_loaded_settings(s.clone())
                .history
                .max_versions_per_file,
            HISTORY_MAX_VERSIONS_PER_FILE
        );

        s.history.max_versions_per_file = 75;
        assert_eq!(
            sanitize_loaded_settings(s).history.max_versions_per_file,
            75
        );
    }

    #[test]
    fn sanitize_keeps_valid_projects_root() {
        let Some(docs) = dirs::document_dir() else {
            return;
        };
        if !docs.exists() {
            return;
        }
        let valid = docs.join("Typeward");
        let s = Settings {
            projects_root: valid.to_string_lossy().into_owned(),
            ..Settings::default()
        };
        let sanitized = sanitize_loaded_settings(s);
        assert_eq!(
            sanitized.projects_root,
            valid.to_string_lossy().into_owned()
        );
    }
}
