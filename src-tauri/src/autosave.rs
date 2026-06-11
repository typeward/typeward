//! Crash recovery via debounced snapshots. The frontend pushes the buffer
//! contents here every ~500ms idle. On `save_text_file`, the snapshot is
//! cleared. On project open, the frontend asks for any orphan snapshots and
//! offers to restore them.
//!
//! Layout: `<project_root>/.typeward/snapshots/<rel_path>.snap`
//! The `.snap` file is just the raw text — recovery is straight `cp`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fs_ops;
use crate::project::{sidecar_dir, validate_project_relative_path};

const SNAPSHOT_DIR: &str = "snapshots";

#[derive(Debug, Error)]
pub enum AutosaveError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub content: String,
    /// Snapshot mtime as ms-since-epoch.
    #[serde(rename = "snapshotMtime")]
    pub snapshot_mtime: i64,
    /// File mtime as ms-since-epoch (or null if file missing).
    #[serde(rename = "fileMtime")]
    pub file_mtime: Option<i64>,
}

fn snapshot_dir(project_root: &Path) -> PathBuf {
    sidecar_dir(project_root).join(SNAPSHOT_DIR)
}

fn snapshot_path(project_root: &Path, rel_path: &str) -> PathBuf {
    let mut p = snapshot_dir(project_root);
    let rel =
        validate_project_relative_path(rel_path).unwrap_or_else(|_| PathBuf::from("__invalid__"));
    p.push(rel);
    p.set_extension(format!(
        "{}snap",
        p.extension()
            .and_then(|s| s.to_str())
            .map(|s| format!("{s}."))
            .unwrap_or_default()
    ));
    p
}

pub fn write(project_root: &Path, rel_path: &str, content: &str) -> Result<(), AutosaveError> {
    validate_project_relative_path(rel_path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let path = snapshot_path(project_root, rel_path);
    fs_ops::write_text(&path, content)?;
    Ok(())
}

pub fn clear(project_root: &Path, rel_path: &str) -> Result<(), AutosaveError> {
    validate_project_relative_path(rel_path)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let path = snapshot_path(project_root, rel_path);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// List orphan snapshots — those whose snapshot mtime is newer than the
/// underlying file's mtime (meaning unsaved work was buffered before a crash).
pub fn list_orphans(project_root: &Path) -> Result<Vec<Snapshot>, AutosaveError> {
    let dir = snapshot_dir(project_root);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    walk(&dir, &dir, project_root, &mut out)?;
    Ok(out)
}

fn walk(
    dir: &Path,
    snapshot_root: &Path,
    project_root: &Path,
    out: &mut Vec<Snapshot>,
) -> Result<(), AutosaveError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            walk(&path, snapshot_root, project_root, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("snap") {
            continue;
        }
        let rel = path
            .strip_prefix(snapshot_root)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "strip_prefix"))?
            .with_extension("")
            .to_string_lossy()
            .replace('\\', "/");
        let content = fs::read_to_string(&path)?;
        let snapshot_mtime = mtime_ms(&path)?;
        let file_path = project_root.join(&rel);
        let file_mtime = if file_path.exists() {
            Some(mtime_ms(&file_path)?)
        } else {
            None
        };
        // Orphans are snapshots strictly newer than the file (or where the file
        // is missing). Older snapshots are stale and we just clean them up.
        let is_orphan = match file_mtime {
            None => true,
            Some(file_mt) => snapshot_mtime > file_mt + 250, // 250ms grace
        };
        if is_orphan {
            out.push(Snapshot {
                rel_path: rel,
                content,
                snapshot_mtime,
                file_mtime,
            });
        } else {
            // Stale snapshot — file was saved after the snapshot was written.
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

fn mtime_ms(path: &Path) -> std::io::Result<i64> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified()?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    Ok(duration.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "typeward-autosave-test-{}-{}",
            std::process::id(),
            id
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn list_orphans_skips_symlinked_snapshots() {
        let root = temp_dir();
        let snapshots = snapshot_dir(&root);
        fs::create_dir_all(&snapshots).unwrap();
        let outside = root.join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, snapshots.join("main.tex.snap")).unwrap();

        let snapshots = list_orphans(&root).unwrap();

        assert!(snapshots.is_empty());
    }
}
