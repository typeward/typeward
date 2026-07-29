//! Allowlist of paths the OS delivered to this app through drag-drop.
//!
//! `import_files_into_project` copies renderer-supplied ABSOLUTE paths into a
//! project, and the project is readable through the project IPC — so an
//! ungated source path is an arbitrary-file-read primitive for a compromised
//! webview (drop `~/.ssh/id_rsa` into the project, read it back). The renderer
//! cannot be trusted to say "the user dropped this", so Rust learns it
//! independently: the drag-drop window/webview event fires in the backend
//! before the frontend's own listener, and only the paths seen there may be
//! imported. (Dialog-picked files take the other branch — the dialog plugin
//! adds them to the fs runtime scope itself.)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A dropped path is imported by the frontend on the same user gesture, so a
/// short window is enough. Anything longer only widens the forgery surface for
/// a webview compromised after the drop.
const TTL: Duration = Duration::from_secs(120);

/// Backstop against unbounded growth from repeated many-file drops; TTL
/// pruning normally keeps the table far below this.
const MAX_ENTRIES: usize = 4096;

fn table() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static TABLE: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Canonicalize so a symlinked or differently-spelled form of the same file
/// can't be presented as "not the path that was dropped" (or vice versa).
/// A path that cannot be canonicalized is keyed verbatim; it will simply fail
/// the later lookup unless the same unresolvable form was recorded.
fn key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn prune(map: &mut HashMap<PathBuf, Instant>, now: Instant) {
    map.retain(|_, at| now.saturating_duration_since(*at) < TTL);
    if map.len() > MAX_ENTRIES {
        map.clear();
    }
}

pub fn record(paths: &[PathBuf]) {
    record_at(paths, Instant::now());
}

fn record_at(paths: &[PathBuf], now: Instant) {
    let mut map = table().lock().unwrap_or_else(|e| e.into_inner());
    prune(&mut map, now);
    for path in paths {
        map.insert(key(path), now);
    }
}

pub fn is_allowed(path: &Path) -> bool {
    is_allowed_at(path, Instant::now())
}

fn is_allowed_at(path: &Path, now: Instant) -> bool {
    let mut map = table().lock().unwrap_or_else(|e| e.into_inner());
    prune(&mut map, now);
    map.contains_key(&key(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test uses its own file so the process-global table can't make the
    /// suite order-dependent.
    fn temp_file(tag: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("typeward-drop-allow-{}-{tag}", std::process::id()));
        std::fs::write(&path, b"x").expect("temp file");
        path
    }

    #[test]
    fn records_and_allows_a_dropped_path() {
        let path = temp_file("recorded");
        let now = Instant::now();
        record_at(std::slice::from_ref(&path), now);

        assert!(is_allowed_at(&path, now));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_path_that_was_never_dropped_is_rejected() {
        let path = temp_file("never-dropped");

        assert!(!is_allowed_at(&path, Instant::now()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_record_expires_after_the_ttl() {
        let path = temp_file("expiring");
        let now = Instant::now();
        record_at(std::slice::from_ref(&path), now);

        assert!(!is_allowed_at(&path, now + TTL + Duration::from_secs(1)));
        let _ = std::fs::remove_file(&path);
    }
}
