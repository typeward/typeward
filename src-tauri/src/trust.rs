//! Per-machine shell-escape trust store. Shell-escape lets a LaTeX document run
//! arbitrary programs during compile, so it is opt-in per project AND recorded
//! OUTSIDE the project (a cloned project.json can't grant itself). Analogous to
//! VS Code's workspace trust. Keyed by canonical root path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::fs_ops;
use crate::project;

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustStore {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: HashMap<String, String>, // canonical root -> "granted" | "denied"
}

fn trust_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("shell-escape-trust.json"))
}

fn load(app: &tauri::AppHandle) -> TrustStore {
    let Some(path) = trust_path(app) else {
        return TrustStore::default();
    };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => TrustStore::default(),
    }
}

fn save(app: &tauri::AppHandle, store: &TrustStore) -> Result<(), String> {
    let path = trust_path(app).ok_or_else(|| "no app data dir".to_string())?;
    let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    fs_ops::atomic_write(&path, &json).map_err(|e| e.to_string())
}

fn canon(root: &Path) -> String {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// True when this project's canonical root has a `granted` trust entry.
pub fn is_shell_escape_granted(app: &tauri::AppHandle, root: &Path) -> bool {
    load(app)
        .entries
        .get(&canon(root))
        .map(|v| v == "granted")
        .unwrap_or(false)
}

#[tauri::command]
pub async fn shell_escape_trust_get(
    app: tauri::AppHandle,
    project_root: String,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        Ok(load(&app).entries.get(&canon(root)).cloned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clear a stored shell-escape DENIAL so the trust prompt can run again. A
/// stored grant is left untouched — revoking a grant stays an explicit
/// `shell_escape_trust_set(root, "denied")`.
#[tauri::command]
pub async fn trust_clear_shell_escape(
    app: tauri::AppHandle,
    project_root: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        let mut store = load(&app);
        let key = canon(root);
        if store.entries.get(&key).map(|v| v == "denied").unwrap_or(false) {
            store.entries.remove(&key);
            save(&app, &store)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_escape_trust_set(
    app: tauri::AppHandle,
    project_root: String,
    grant: String,
) -> Result<(), String> {
    if grant != "granted" && grant != "denied" {
        return Err("grant must be 'granted' or 'denied'".into());
    }
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        let mut store = load(&app);
        store.entries.insert(canon(root), grant);
        save(&app, &store)
    })
    .await
    .map_err(|e| e.to_string())?
}
