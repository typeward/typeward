//! Custom theme loader. Themes are user-authored JSON files in
//! `<app_data>/themes/` — one file per theme, the file stem is the theme id.
//! The frontend injects validated tokens as CSS custom properties on top of
//! a built-in base theme.
//!
//! Validation lives here (not only in the webview) because token values end
//! up inside an injected `<style>` element: a value that closes the
//! declaration block could smuggle arbitrary CSS. The local user is trusted,
//! but a project README telling someone to paste a "theme" into the folder
//! shouldn't be a styling injection vector either.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const BUILTIN_BASES: [&str; 6] = ["light", "dark", "daylight", "lamplight", "aurora", "paper"];
const MAX_THEME_FILE_BYTES: u64 = 64 * 1024;
const MAX_TOKENS: usize = 200;
const MAX_TOKEN_VALUE_CHARS: usize = 256;

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize)]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    /// Built-in theme the tokens layer on top of (decides every token the
    /// file doesn't override, plus light/dark treatment of embedded surfaces).
    pub base: String,
    pub tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomThemesResult {
    pub themes: Vec<CustomTheme>,
    /// One human-readable line per file that failed validation — surfaced in
    /// Settings so a typo doesn't silently drop the theme.
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ThemeFile {
    name: String,
    base: String,
    #[serde(default)]
    tokens: BTreeMap<String, String>,
}

fn themes_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "could not resolve app data dir".to_string())?
        .join("themes");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn valid_token_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("--") else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 64
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_token_value(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_TOKEN_VALUE_CHARS
        && !value
            .chars()
            .any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\') || c.is_control())
}

fn validate(file: &ThemeFile) -> Result<(), String> {
    if file.name.trim().is_empty() || file.name.chars().count() > 64 {
        return Err("`name` must be 1-64 characters".into());
    }
    if !BUILTIN_BASES.contains(&file.base.as_str()) {
        return Err(format!(
            "`base` must be one of {} (got `{}`)",
            BUILTIN_BASES.join(", "),
            file.base
        ));
    }
    if file.tokens.len() > MAX_TOKENS {
        return Err(format!("too many tokens (max {MAX_TOKENS})"));
    }
    for (key, value) in &file.tokens {
        if !valid_token_key(key) {
            return Err(format!(
                "token `{key}` — keys must look like `--color-bg-base` (lowercase, digits, dashes)"
            ));
        }
        if !valid_token_value(value) {
            return Err(format!(
                "token `{key}` — values are capped at {MAX_TOKEN_VALUE_CHARS} chars and must not contain `;` `{{` `}}` `<` `>` `\\`"
            ));
        }
    }
    Ok(())
}

/// File stem → theme id. Restricted so the id is safe inside a CSS attribute
/// selector and a settings.json string.
fn id_from_stem(stem: &str) -> Option<String> {
    let ok = !stem.is_empty()
        && stem.len() <= 64
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| stem.to_string())
}

#[tauri::command]
pub async fn custom_themes_list(app: tauri::AppHandle) -> CmdResult<CustomThemesResult> {
    // Runs on boot; the dir scan + per-file JSON reads stay off the event loop.
    tokio::task::spawn_blocking(move || -> CmdResult<CustomThemesResult> {
        let dir = themes_dir(&app)?;
        let mut themes = Vec::new();
        let mut warnings = Vec::new();

        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Symlinked theme files are skipped like every other user-content
            // reader in the app (snapshots, templates).
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    warnings.push(format!("{file_name}: symlinks are not loaded"));
                    continue;
                }
                Ok(meta) if meta.len() > MAX_THEME_FILE_BYTES => {
                    warnings.push(format!("{file_name}: file too large (max 64 KB)"));
                    continue;
                }
                Err(e) => {
                    warnings.push(format!("{file_name}: {e}"));
                    continue;
                }
                _ => {}
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(id_from_stem)
            else {
                warnings.push(format!(
                    "{file_name}: file name must use only letters, digits, `-`, `_`"
                ));
                continue;
            };
            let parsed: Result<ThemeFile, _> = fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()));
            match parsed {
                Ok(file) => match validate(&file) {
                    Ok(()) => themes.push(CustomTheme {
                        id,
                        name: file.name.trim().to_string(),
                        base: file.base,
                        tokens: file.tokens,
                    }),
                    Err(reason) => warnings.push(format!("{file_name}: {reason}")),
                },
                Err(reason) => warnings.push(format!("{file_name}: {reason}")),
            }
        }

        themes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(CustomThemesResult { themes, warnings })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop a working example into the themes folder so users have something to
/// copy from instead of reverse-engineering the token vocabulary. Returns the
/// file path; refuses to overwrite an edited copy.
#[tauri::command]
pub async fn custom_theme_write_sample(app: tauri::AppHandle) -> CmdResult<String> {
    // create_dir_all + fs::write; keep the disk IO off the event-loop thread.
    tokio::task::spawn_blocking(move || -> CmdResult<String> {
        let dir = themes_dir(&app)?;
        let path = dir.join("harbor.json");
        if !path.exists() {
            fs::write(&path, SAMPLE_THEME_JSON).map_err(|e| e.to_string())?;
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open the themes folder in the OS file manager.
#[tauri::command]
pub async fn custom_themes_open_dir(app: tauri::AppHandle) -> CmdResult<()> {
    // create_dir_all + launching the OS file manager can block; keep it off
    // the event-loop thread.
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        use tauri_plugin_opener::OpenerExt;
        let dir = themes_dir(&app)?;
        app.opener()
            .open_path(dir.to_string_lossy(), None::<&str>)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Working example: a deep-sea dark theme on the Lamplight base. Every token
/// group a theme author typically wants is represented — surfaces, text,
/// controls, accent, semantic colors, editor syntax, ambient blobs.
// `r##"…"##` (not `r#"…"#`): the JSON's hex colors contain the `"#`
// sequence (e.g. `"#0b1418"`), which would otherwise close an `r#"` raw
// string early. The content has no `"##`, so the doubled hashes are safe.
const SAMPLE_THEME_JSON: &str = r##"{
  "name": "Harbor",
  "base": "lamplight",
  "tokens": {
    "--color-bg-base": "#0b1418",
    "--color-fg-1": "#dce8ea",
    "--color-fg-2": "#93aab0",
    "--color-fg-3": "#6c8389",
    "--color-fg-4": "#4e6268",
    "--color-glass-fill": "rgb(18 32 38 / 0.72)",
    "--color-glass-stroke": "#1e3138",
    "--color-glass-stroke-strong": "#2c454e",
    "--color-glass-inset-fill": "rgb(220 232 234 / 0.04)",
    "--color-glass-inset-stroke": "#1e3138",
    "--color-glass-soft-fill": "rgb(220 232 234 / 0.03)",
    "--color-control-fill": "rgb(220 232 234 / 0.06)",
    "--color-control-fill-hover": "rgb(220 232 234 / 0.10)",
    "--color-control-stroke": "#2c454e",
    "--color-overlay-dim": "rgb(4 10 12 / 0.35)",
    "--color-overlay-scrim": "rgb(4 10 12 / 0.55)",
    "--color-popover-bg": "rgb(14 26 31 / 0.97)",
    "--color-topbar-bg": "rgb(11 20 24 / 0.85)",
    "--color-selection-bg": "rgb(94 196 192 / 0.14)",
    "--color-text-selection": "rgb(94 196 192 / 0.35)",
    "--color-card-bg": "rgb(16 29 34 / 0.92)",
    "--color-card-bg-soft": "rgb(14 26 31 / 0.70)",
    "--format-latex": "#6fb3ad",
    "--format-typst": "#8aa86f",
    "--color-accent-1": "#5ec4c0",
    "--color-accent-2": "#3a8d96",
    "--color-accent-fg": "#08171a",
    "--accent-text-1": "#7fd4cf",
    "--accent-text-2": "#5ec4c0",
    "--color-ok": "#5fae7d",
    "--color-warn": "#c9a85c",
    "--color-err": "#d4766b",
    "--syntax-cmd": "#7cb8e4",
    "--syntax-env": "#5fae7d",
    "--syntax-math": "#d4766b",
    "--syntax-comment": "rgb(220 232 234 / 0.35)",
    "--syntax-bracket": "rgb(220 232 234 / 0.45)",
    "--syntax-attr": "#6fb3ad",
    "--blob-1": "#11343c",
    "--blob-2": "#0e2a31",
    "--blob-3": "#143f44",
    "--blob-4": "#0c2228",
    "--blob-1-op": "0.55",
    "--blob-2-op": "0.45",
    "--blob-3-op": "0.40",
    "--blob-4-op": "0.35"
  }
}
"##;

#[cfg(test)]
mod tests {
    use super::*;

    fn theme_file(tokens: &[(&str, &str)]) -> ThemeFile {
        ThemeFile {
            name: "Test".into(),
            base: "daylight".into(),
            tokens: tokens
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn sample_theme_passes_validation() {
        let parsed: ThemeFile = serde_json::from_str(SAMPLE_THEME_JSON).unwrap();
        assert!(validate(&parsed).is_ok());
        assert_eq!(parsed.base, "lamplight");
    }

    #[test]
    fn rejects_css_injection_in_values() {
        for bad in [
            "#fff; background: red",
            "#fff }",
            "url(x) {",
            "a\\62",
            "<img>",
        ] {
            let f = theme_file(&[("--color-bg-base", bad)]);
            assert!(validate(&f).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn rejects_bad_keys_and_bases() {
        assert!(validate(&theme_file(&[("color-bg", "#fff")])).is_err());
        assert!(validate(&theme_file(&[("--Color-Bg", "#fff")])).is_err());
        let mut f = theme_file(&[("--color-bg-base", "#fff")]);
        f.base = "obsidian".into();
        assert!(validate(&f).is_err());
    }

    #[test]
    fn accepts_color_mix_and_gradients() {
        let f = theme_file(&[
            (
                "--color-text-selection",
                "color-mix(in srgb, #5ec4c0 35%, transparent)",
            ),
            ("--blob-1-op", "0.55"),
        ]);
        assert!(validate(&f).is_ok());
    }

    #[test]
    fn id_from_stem_rules() {
        assert_eq!(id_from_stem("harbor"), Some("harbor".into()));
        assert_eq!(id_from_stem("my_theme-2"), Some("my_theme-2".into()));
        assert_eq!(id_from_stem("bad name"), None);
        assert_eq!(id_from_stem("bad.name"), None);
        assert_eq!(id_from_stem(""), None);
    }
}
