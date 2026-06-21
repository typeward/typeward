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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSettings {
    #[serde(rename = "autoCompile")]
    pub auto_compile: bool,
    #[serde(rename = "vimMode")]
    pub vim_mode: bool,
    #[serde(rename = "spellCheck")]
    pub spell_check: bool,
    #[serde(rename = "lineWrap")]
    pub line_wrap: bool,
    #[serde(rename = "fontSize")]
    pub font_size: u16,
    // Halting matches the engines' historical hardcoded behavior, so the
    // serde default keeps older settings.json files loading unchanged.
    #[serde(rename = "stopOnFirstError", default = "default_true")]
    pub stop_on_first_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiSettings {
    pub density: String,
    pub animations: bool,
    #[serde(rename = "ambientLights", default = "default_true")]
    pub ambient_lights: bool,
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
            theme: "aurora".into(),
            accent: "violet-cyan".into(),
            editor: EditorSettings::default(),
            projects_root: default_projects_root().to_string_lossy().into(),
            compile_engine: "system-tex".into(),
            onboarded: false,
            ui: UiSettings::default(),
            workspace: WorkspaceSettings::default(),
            integrations: IntegrationsSettings::default(),
        }
    }
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            auto_compile: false,
            vim_mode: false,
            spell_check: true,
            line_wrap: true,
            font_size: 13,
            stop_on_first_error: true,
        }
    }
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            density: "cozy".into(),
            animations: true,
            ambient_lights: true,
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

// Re-export for command handlers
pub use tauri::Manager;
