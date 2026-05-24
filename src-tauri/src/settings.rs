use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

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
    #[serde(default)]
    pub jabref: JabRefSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BetterBibTexSettings {
    #[serde(default)]
    pub enabled: bool,
    /// Zotero library id; `1` is the user's personal library.
    #[serde(rename = "libraryId", default = "default_library_id")]
    pub library_id: u32,
}

impl Default for BetterBibTexSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            library_id: default_library_id(),
        }
    }
}

fn default_library_id() -> u32 {
    1
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JabRefSettings {
    /// Absolute paths to `.bib` files the user has added.
    #[serde(default)]
    pub paths: Vec<String>,
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiSettings {
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
    pub widgets: HashMap<String, bool>,
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
}

pub fn default_projects_root() -> PathBuf {
    dirs::document_dir()
        .map(|d| d.join("Typeward"))
        .unwrap_or_else(|| PathBuf::from("Typeward"))
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
    Ok(settings)
}

pub fn save(app_handle: &tauri::AppHandle, settings: &Settings) -> Result<(), SettingsError> {
    let path = settings_path(app_handle)?;
    let json = serde_json::to_vec_pretty(settings)?;
    fs_ops::atomic_write(&path, &json)?;
    Ok(())
}

// Re-export for command handlers
pub use tauri::Manager;
