//! Unified file watcher service. One Rust `notify` watcher per project root;
//! typed events are emitted on a single channel that all frontend consumers
//! (preview, file tree, editor buffers, build system) subscribe to.
//!
//! Wire shape:
//!   watch_project { project_id, root } -> {}        (invoke)
//!   unwatch_project { project_id } -> {}            (invoke)
//!   `watcher:<project_id>:event` events             (emit -> frontend)
//!
//! Phase 1 v0 emits the raw notify event kinds. A higher-level classifier
//! (compile-output / external-edit / generated-file / branch-switch) will
//! sit on top of this stream once the build pipeline is fleshed out.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Debug, Default)]
pub struct WatcherManager {
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum WatcherError {
    #[error("watch error: {0}")]
    Watch(String),
    #[error("project not watched: {0}")]
    NotWatched(String),
}

impl From<notify::Error> for WatcherError {
    fn from(e: notify::Error) -> Self {
        WatcherError::Watch(e.to_string())
    }
}

#[derive(Debug, Deserialize)]
pub struct WatchArgs {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub root: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WatcherEvent {
    pub kind: String,
    pub paths: Vec<String>,
}

#[tauri::command]
pub async fn watch_project(
    app: AppHandle,
    manager: State<'_, WatcherManager>,
    args: WatchArgs,
) -> Result<(), WatcherError> {
    let project_id = args.project_id;
    let root_path = PathBuf::from(&args.root);

    // notify uses synchronous callbacks; we hop onto a tokio mpsc to bridge
    // to the async Tauri emit.
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })?;

    watcher.configure(
        Config::default()
            .with_poll_interval(Duration::from_secs(1))
            .with_compare_contents(false),
    )?;
    watcher.watch(&root_path, RecursiveMode::Recursive)?;

    let event_name = format!("watcher:{}:event", project_id);
    let emit_app = app.clone();
    let log_id = project_id.clone();
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let payload = WatcherEvent {
                kind: classify(&event.kind),
                paths: event
                    .paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            };
            if let Err(e) = emit_app.emit(&event_name, payload) {
                eprintln!("[watcher:{}] emit failed: {}", log_id, e);
            }
        }
    });

    let mut watchers = manager.watchers.lock().expect("watcher lock poisoned");
    // Replacing an existing watcher drops the old one, which detaches it.
    watchers.insert(project_id, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_project(
    manager: State<'_, WatcherManager>,
    project_id: String,
) -> Result<(), WatcherError> {
    let mut watchers = manager.watchers.lock().expect("watcher lock poisoned");
    if watchers.remove(&project_id).is_some() {
        Ok(())
    } else {
        Err(WatcherError::NotWatched(project_id))
    }
}

fn classify(kind: &EventKind) -> String {
    match kind {
        EventKind::Create(_) => "create".into(),
        EventKind::Modify(_) => "modify".into(),
        EventKind::Remove(_) => "remove".into(),
        EventKind::Access(_) => "access".into(),
        EventKind::Other => "other".into(),
        EventKind::Any => "any".into(),
    }
}
