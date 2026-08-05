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

#[derive(Debug, Error)]
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
) -> Result<(), String> {
    // Runs inside the async command so the runtime context is present for the
    // `tokio::spawn` the impl performs; the impl itself has no `.await`.
    watch_project_impl(&app, &manager, args).map_err(|e| e.to_string())
}

fn watch_project_impl(
    app: &AppHandle,
    manager: &WatcherManager,
    args: WatchArgs,
) -> Result<(), WatcherError> {
    let project_id = args.project_id;
    let root_path = PathBuf::from(&args.root);
    // Gate to opened projects (see project.rs) — XSS must not be able to watch
    // arbitrary directories and exfiltrate filesystem activity.
    if !crate::project::is_registered_root(&root_path) {
        return Err(WatcherError::Watch(format!(
            "not an opened project root: {}",
            args.root
        )));
    }

    // notify uses synchronous callbacks; we hop onto a tokio mpsc to bridge
    // to the async Tauri emit.
    let (tx, mut rx) = mpsc::unbounded_channel::<Event>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |res| {
        match res {
            Ok(ev) => {
                let _ = tx.send(ev);
            }
            // Backend errors used to be dropped silently. An inotify watch-limit
            // failure means files created in new subdirectories never appear
            // until the project is reopened, with nothing to explain it — so at
            // least say so, and force a refresh: the frontend re-reads the tree
            // on any event, which is the recovery for a missed one.
            Err(e) => {
                eprintln!("[watcher] backend error: {e}");
                let _ = tx.send(
                    Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan),
                );
            }
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
        // Coalesce bursts: a single compile writes aux/log/fls/synctex/pdf in
        // one go (10+ raw events). Without this each one drives a separate
        // emit -> fsVersion bump -> FileTree refetch of every expanded dir.
        // We also drop internal-state churn (.typeward/, .git/) at the source
        // so autosave snapshots never wake the tree.
        loop {
            let first = match rx.recv().await {
                Some(e) => e,
                None => break,
            };
            let burst_started = tokio::time::Instant::now();
            let mut events = vec![first];
            let mut closed = false;
            loop {
                // Bound the burst two ways. Quiet-gap-only coalescing never
                // flushes while events keep arriving under the window — an
                // external `latexmk -pvc`, a logger appending to a project file,
                // or a long download into the folder would hold the tree stale
                // indefinitely while `events` grew without limit.
                if events.len() >= MAX_COALESCED_EVENTS
                    || burst_started.elapsed() >= MAX_COALESCE_WINDOW
                {
                    break;
                }
                match tokio::time::timeout(COALESCE_WINDOW, rx.recv()).await {
                    Ok(Some(e)) => events.push(e),
                    Ok(None) => {
                        closed = true;
                        break;
                    }
                    Err(_) => break, // quiet gap — flush the burst
                }
            }

            let mut seen = std::collections::HashSet::new();
            let mut paths: Vec<String> = Vec::new();
            let mut last_kind = String::from("any");
            // "You missed events, rescan" markers: inotify queue overflow and
            // FSEvents MustScanSubDirs arrive with EMPTY paths, so the
            // non-empty guard below used to swallow them — leaving the FileTree,
            // palette file cache, and TODO scan stale for the rest of the
            // session after any bulk operation (git checkout, large pull, unzip).
            let mut needs_rescan = false;
            for ev in &events {
                if ev.need_rescan() {
                    needs_rescan = true;
                }
                last_kind = classify(&ev.kind);
                for p in &ev.paths {
                    let s = p.to_string_lossy().into_owned();
                    if is_internal_path(&s) {
                        continue;
                    }
                    if seen.insert(s.clone()) {
                        paths.push(s);
                    }
                }
            }

            if needs_rescan && paths.is_empty() {
                // Name the root so the frontend's per-path filter keeps it.
                paths.push(root_path.to_string_lossy().into_owned());
                last_kind = String::from("any");
            }

            if !paths.is_empty() {
                let payload = WatcherEvent {
                    kind: last_kind,
                    paths,
                };
                if let Err(e) = emit_app.emit_to(crate::ipc_guard::MAIN_LABEL, &event_name, payload)
                {
                    eprintln!("[watcher:{}] emit failed: {}", log_id, e);
                }
            }
            if closed {
                break;
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
) -> Result<(), String> {
    let mut watchers = manager.watchers.lock().expect("watcher lock poisoned");
    if watchers.remove(&project_id).is_some() {
        Ok(())
    } else {
        Err(WatcherError::NotWatched(project_id).to_string())
    }
}

const COALESCE_WINDOW: Duration = Duration::from_millis(150);

/// Hard ceilings on one coalesced burst, so a process writing into the project
/// faster than [`COALESCE_WINDOW`] can't starve emits forever (stale tree) while
/// the pending-event vector grows without bound.
const MAX_COALESCE_WINDOW: Duration = Duration::from_secs(1);
const MAX_COALESCED_EVENTS: usize = 512;

/// True for paths under Typeward's own sidecar (`.typeward/`) or VCS metadata
/// (`.git/`) — churn the FileTree never needs to react to, and the source of
/// the autosave feedback loop.
fn is_internal_path(path: &str) -> bool {
    let norm = path.replace('\\', "/");
    norm.contains("/.typeward/")
        || norm.contains("/.git/")
        || norm.ends_with("/.typeward")
        || norm.ends_with("/.git")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_internal_path_flags_sidecar_and_vcs_churn() {
        // The autosave feedback loop and .git churn must be dropped at the source
        // (forward slashes and Windows backslashes both).
        assert!(is_internal_path(
            "/home/u/proj/.typeward/snapshots/main.tex.snap"
        ));
        assert!(is_internal_path("C:\\Users\\u\\proj\\.git\\index"));
        assert!(is_internal_path(
            "C:\\Users\\u\\proj\\.typeward\\build\\main.pdf"
        ));
        assert!(is_internal_path("/proj/.typeward"));
        assert!(is_internal_path("/proj/.git"));
    }

    #[test]
    fn is_internal_path_passes_normal_project_files() {
        assert!(!is_internal_path("/home/u/proj/main.tex"));
        assert!(!is_internal_path("/home/u/proj/chapters/intro.tex"));
        assert!(!is_internal_path("C:\\Users\\u\\proj\\figures\\plot.png"));
        // A file whose name merely starts with .typeward is not the sidecar dir.
        assert!(!is_internal_path("/proj/.typeward-notes.txt"));
        assert!(!is_internal_path("/proj/mygit/config"));
    }

    #[test]
    fn classify_maps_event_kinds() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind};
        assert_eq!(classify(&EventKind::Create(CreateKind::Any)), "create");
        assert_eq!(classify(&EventKind::Modify(ModifyKind::Any)), "modify");
        assert_eq!(classify(&EventKind::Remove(RemoveKind::Any)), "remove");
        assert_eq!(classify(&EventKind::Any), "any");
    }
}
