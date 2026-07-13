use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    pub privacy: PrivacySettings,
    #[serde(default)]
    pub updates: UpdatesSettings,
    #[serde(default)]
    pub sync: SyncSettings,
    #[serde(default)]
    pub history: HistorySettings,
    #[serde(default)]
    pub feedback: FeedbackSettings,
}

/// Occasional in-app "give us feedback" card. ON by default because the card
/// is local UI — nothing leaves the machine unless the user presses Send.
/// Synced across devices (a preference, not device state); the prompt's
/// device-local pacing state lives in localStorage (feedback-prompt.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedbackSettings {
    #[serde(rename = "promptsEnabled", default = "default_true")]
    pub prompts_enabled: bool,
}

impl Default for FeedbackSettings {
    fn default() -> Self {
        Self {
            prompts_enabled: true,
        }
    }
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

/// Settings-sync preferences. Device-local by design: the toggle governs
/// whether THIS machine participates, so it is itself excluded from sync
/// (see the frontend denylist in settings-sync.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSettings {
    #[serde(rename = "syncSettings", default = "default_true")]
    pub sync_settings: bool,
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            sync_settings: true,
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

/// Egress opt-ins. Everything here defaults to OFF — the app promises zero
/// network reporting unless the user explicitly enables it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrivacySettings {
    #[serde(rename = "shareCrashReports", default)]
    pub share_crash_reports: bool,
    /// Random UUIDv4 attached to crash reports so Sentry can group per-install
    /// without identifying anyone — never the Supabase account id. Minted by
    /// Rust on the FIRST submission only (diagnostics.rs); absent until then.
    #[serde(rename = "installId", default, skip_serializing_if = "Option::is_none")]
    pub install_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSettings {
    #[serde(rename = "autoCompile")]
    pub auto_compile: bool,
    #[serde(rename = "vimMode")]
    pub vim_mode: bool,
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
    pub vcs: VcsSettings,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub grammar: GrammarSettings,
    #[serde(default)]
    pub templates: TemplatesSettings,
    #[serde(default)]
    pub account: AccountSettings,
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
    // in the keyring). Optional + skipped for the OAuth providers (Dropbox).
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
pub struct VcsSettings {
    #[serde(default)]
    pub git: GitSettings,
    #[serde(default)]
    pub github: GithubSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GitSettings {
    #[serde(rename = "authorName", default)]
    pub author_name: Option<String>,
    #[serde(rename = "authorEmail", default)]
    pub author_email: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GithubSettings {
    #[serde(rename = "accountId", default)]
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSettings {
    /// Master switch. When off, the editor hides every AI surface (chat
    /// panel, toolbar toggle) and no provider activates — zero AI traffic.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "activeProvider", default)]
    pub active_provider: Option<String>,
    #[serde(rename = "ollamaBaseUrl", default)]
    pub ollama_base_url: Option<String>,
    #[serde(rename = "perProviderModel", default)]
    pub per_provider_model: HashMap<String, String>,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            active_provider: None,
            ollama_base_url: None,
            per_provider_model: HashMap::new(),
        }
    }
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AccountSettings {
    #[serde(rename = "signedInEmail", default)]
    pub signed_in_email: Option<String>,
    #[serde(rename = "lastValidatedAt", default)]
    pub last_validated_at: Option<String>,
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
            privacy: PrivacySettings::default(),
            updates: UpdatesSettings::default(),
            sync: SyncSettings::default(),
            history: HistorySettings::default(),
            feedback: FeedbackSettings::default(),
        }
    }
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            auto_compile: false,
            vim_mode: false,
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

pub fn default_projects_root() -> PathBuf {
    dirs::document_dir()
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
    let documents = dirs::document_dir()
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

pub fn load(app_handle: &tauri::AppHandle) -> Result<Settings, SettingsError> {
    let path = settings_path(app_handle)?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let bytes = fs::read(path)?;
    let settings: Settings = serde_json::from_slice(&bytes)?;
    Ok(sanitize_loaded_settings(settings))
}

pub fn save(app_handle: &tauri::AppHandle, settings: &Settings) -> Result<(), SettingsError> {
    validate_projects_root(Path::new(&settings.projects_root))?;
    let path = settings_path(app_handle)?;
    let json = serde_json::to_vec_pretty(settings)?;
    fs_ops::atomic_write(&path, &json)?;
    Ok(())
}

/// Per-key settings-sync bookkeeping: the last server `updated_at` seen for a
/// key and the hash of the value last synced in either direction. The outer
/// map is keyed by Supabase user id so account switching can't cross-apply.
/// Persisted to its own `settings-sync.json` next to settings.json —
/// deliberately NOT inside it, so a settings roundtrip or Reset can't clobber
/// sync metadata. The schema is owned by the frontend engine (settings-sync.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncKeyState {
    #[serde(rename = "seenUpdatedAt")]
    pub seen_updated_at: String,
    pub hash: String,
}

pub type SyncStateFile = HashMap<String, HashMap<String, SyncKeyState>>;

fn sync_state_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, SettingsError> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|_| SettingsError::NoAppDataDir)?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("settings-sync.json"))
}

pub fn load_sync_state(app_handle: &tauri::AppHandle) -> Result<SyncStateFile, SettingsError> {
    let path = sync_state_path(app_handle)?;
    if !path.exists() {
        return Ok(SyncStateFile::default());
    }
    let bytes = fs::read(path)?;
    // Corrupt bookkeeping degrades to empty rather than erroring: an error here
    // would wedge sync behind an unreadable file forever, while an empty state
    // just re-converges on the next pass (server-newer rows re-apply, local-only
    // keys re-seed).
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

pub fn save_sync_state(
    app_handle: &tauri::AppHandle,
    state: &SyncStateFile,
) -> Result<(), SettingsError> {
    let path = sync_state_path(app_handle)?;
    let json = serde_json::to_vec_pretty(state)?;
    fs_ops::atomic_write(&path, &json)?;
    Ok(())
}

// Re-export for command handlers
pub use tauri::Manager;

#[cfg(test)]
mod tests {
    use super::*;

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
            sanitize_loaded_settings(s.clone()).history.max_versions_per_file,
            HISTORY_MIN_VERSIONS_PER_FILE
        );

        s.history.max_versions_per_file = 10_000;
        assert_eq!(
            sanitize_loaded_settings(s.clone()).history.max_versions_per_file,
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
        assert_eq!(sanitized.projects_root, valid.to_string_lossy().into_owned());
    }
}
