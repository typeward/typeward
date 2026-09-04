//! Review-comment shard discovery.
//!
//! Comments live in `<project>/.typeward/reviews/<local_id>.json`, one file per
//! install. Sharding is what makes a project shared through a folder-sync client
//! (OneDrive, Dropbox, Syncthing) usable by more than one person: two installs
//! never write the same file, so the sync client never has a conflict to
//! resolve and no one's threads are clobbered by whoever saved last. The
//! frontend merges the shards it finds; this module only enumerates them, and
//! folds the pre-shard single-file sidecar into this install's shard the first
//! time it sees one.
//!
//! Shard names arrive off the filesystem (a collaborator's shard is delivered by
//! the sync client, not by us), so every name is re-validated against the id
//! shape before it is handed back as something the renderer may read.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::fs_ops;
use crate::project;
use crate::settings;

/// A pre-shard sidecar far larger than this is not review comments; refuse to
/// parse it rather than pulling an arbitrary project file into memory.
const MAX_LEGACY_SIDECAR_BYTES: u64 = 16 * 1024 * 1024;

const LEGACY_STEM: &str = "comments";
const LEGACY_NAME: &str = "comments.json";
/// The retired legacy sidecar keeps its bytes under a name nothing reads, so a
/// migration that turns out to have gone wrong is still recoverable by hand.
const LEGACY_RETIRED_NAME: &str = "comments.json.pre-shard";

fn reviews_dir(root: &Path) -> PathBuf {
    project::sidecar_dir(root).join("reviews")
}

/// Enumerate the review shards in a project, as bare ids.
///
/// Migrates the legacy single-file sidecar into this install's shard first, so
/// the caller sees one uniform world.
#[tauri::command]
pub async fn list_review_shards(
    app: tauri::AppHandle,
    project_root: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        if !project::is_registered_root(Path::new(&project_root)) {
            return Err(format!("not an opened project root: {project_root}"));
        }
        let dir = reviews_dir(Path::new(&project_root));
        migrate_legacy_sidecar(&app, &dir);
        Ok(shard_ids(&dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shard ids present on disk. A directory that does not exist yet (no comments
/// in this project) is an empty list, not an error, and anything that is not a
/// plain `<valid id>.json` file is ignored — which is also what discards the
/// `comments (DESKTOP-A1B2).json` copies a sync client leaves behind when it
/// cannot merge something itself.
fn shard_ids(dir: &Path) -> Vec<String> {
    // A symlinked sidecar directory would turn shard discovery into a
    // directory-listing primitive aimed anywhere on disk. Malicious project
    // content is in the threat model, so refuse rather than follow.
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_dir() => {}
        _ => return Vec::new(),
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let stem = name.strip_suffix(".json")?;
            // `comments` is itself a legal id shape, so the legacy sidecar would
            // otherwise enumerate as a collaborator's shard and then fail to
            // parse (it is a bare array, not a shard envelope).
            if stem == LEGACY_STEM {
                return None;
            }
            settings::is_valid_local_id(stem).then(|| stem.to_string())
        })
        .collect();
    // Stable order so a merge that has to break a tie breaks it the same way on
    // every machine.
    ids.sort();
    ids
}

/// Fold `comments.json` (the single-file sidecar that predates sharding) into
/// this install's shard, then retire it. Best-effort: every failure leaves the
/// legacy file untouched, so the next launch tries again rather than losing it.
fn migrate_legacy_sidecar(app: &tauri::AppHandle, dir: &Path) {
    let legacy = dir.join(LEGACY_NAME);
    match fs::symlink_metadata(&legacy) {
        Ok(meta) if meta.file_type().is_file() => {}
        _ => return,
    }
    let Ok(loaded) = settings::load(app) else {
        return;
    };
    let Some(local_id) = loaded
        .profile
        .local_id
        .filter(|id| settings::is_valid_local_id(id))
    else {
        // Identity has not settled yet. Leave the sidecar for a later run
        // rather than minting a shard under an id that will not be reused.
        return;
    };

    let target = dir.join(format!("{local_id}.json"));
    if target.exists() {
        // Already migrated: this install's shard is authoritative, and the
        // legacy bytes would only be re-imported as duplicates.
        let _ = fs::rename(&legacy, dir.join(LEGACY_RETIRED_NAME));
        return;
    }

    if fs::metadata(&legacy).map(|m| m.len()).unwrap_or(u64::MAX) > MAX_LEGACY_SIDECAR_BYTES {
        eprintln!("[reviews] {} is too large to migrate", legacy.display());
        return;
    }
    let Ok(raw) = fs::read_to_string(&legacy) else {
        return;
    };
    let threads: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v @ serde_json::Value::Array(_)) => v,
        _ => {
            // Not the shape we wrote. Do not touch it: a corrupt sidecar that
            // someone can still hand-repair beats one we renamed away.
            eprintln!("[reviews] {} is not a thread array", legacy.display());
            return;
        }
    };

    // Everything in the legacy file was written by this machine, so it becomes
    // this install's shard wholesale. Per-comment ids are left absent on
    // purpose: the merge treats an unattributed comment as the shard owner's,
    // which is exactly what these are.
    let shard = json!({
        "schema": 1,
        "authorId": local_id,
        "authorName": loaded.profile.display_name,
        "threads": threads,
        "replies": {},
        "patches": {},
    });
    let Ok(bytes) = serde_json::to_vec_pretty(&shard) else {
        return;
    };
    if let Err(e) = fs_ops::atomic_write(&target, &bytes) {
        eprintln!("[reviews] could not write {}: {e}", target.display());
        return;
    }
    let _ = fs::rename(&legacy, dir.join(LEGACY_RETIRED_NAME));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "typeward-reviews-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_reviews_dir_lists_nothing() {
        let dir = temp_dir();
        assert!(shard_ids(&dir.join("reviews")).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_well_formed_shard_names_are_listed() {
        let dir = temp_dir();
        for name in [
            "V1StGXR8Z5jdHi6BmyT8x.json",
            "aBcDeF.json",
            // Everything below must be ignored.
            "comments.json.pre-shard",
            "comments (DESKTOP-A1B2).json",
            "notes.txt",
            "..json",
        ] {
            fs::write(dir.join(name), b"{}").unwrap();
        }
        fs::create_dir_all(dir.join("nested.json")).unwrap();

        let ids = shard_ids(&dir);
        assert_eq!(ids, vec!["V1StGXR8Z5jdHi6BmyT8x", "aBcDeF"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_legacy_sidecar_is_never_listed_as_a_shard() {
        let dir = temp_dir();
        fs::write(dir.join(LEGACY_NAME), b"[]").unwrap();
        assert!(shard_ids(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
