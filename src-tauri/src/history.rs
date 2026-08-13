//! Local per-file version history. Every successful save records at most one
//! version per file per five minutes into a content-addressed store under
//! `<app_data>/history/<project-id>/` — gzip-compressed blobs named by the
//! SHA-256 of their *uncompressed* content plus one small `index.json` mapping
//! relative paths to ordered version entries. Restore always force-records the
//! state it is about to overwrite, so a restore is never destructive.
//!
//! The store lives in app-data — NOT the `.typeward/` sidecar — on purpose:
//! history survives the scenario it exists for (project folder deleted or
//! clobbered), never shows up in `git status` or cloud sync or the zip
//! export, and generates zero file-watcher churn.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use thiserror::Error;

use crate::fs_ops;
use crate::project;
use crate::settings;

/// Stamped into `index.json` like `CURRENT_PROJECT_SCHEMA`; bump only for a
/// non-additive change that needs a migration.
pub const CURRENT_HISTORY_SCHEMA: u64 = 1;

/// Per-file size cap. Bigger files are silently skipped on ordinary records
/// (binaries and generated artifacts, not "your work"); the forced pre-restore
/// snapshot raises it to `MAX_FORCED_SNAPSHOT_BYTES` so a restore can never
/// drop the current state.
const MAX_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024;

/// Ceiling for the forced pre-restore snapshot. The capture reads the whole
/// file into memory (plus its hash and gzip buffers), so "no limit" makes a
/// restore of a file that has since grown huge — a multi-GB log renamed to a
/// tracked extension is still valid UTF-8 — a memory spike that can take the
/// app down. Generous enough that no real source file reaches it.
const MAX_FORCED_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

/// At most one version per file per this window of continuous editing.
const MIN_INTERVAL_MS: i64 = 5 * 60 * 1000;

/// Text project sources worth versioning: the texlive-wasm walker's text set
/// plus `typ`/`md`/`txt`, minus build artifacts like `.aux`.
const TRACKED_EXTS: &[&str] = &[
    "tex", "typ", "bib", "cls", "sty", "bst", "def", "ldf", "fd", "clo", "cnf", "md", "txt",
];

const BLOBS_DIR: &str = "blobs";
const INDEX_JSON: &str = "index.json";

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Project(#[from] project::ProjectError),
    #[error("history does not cover this path: {0}")]
    NotTracked(String),
    #[error("version {hash} not found for {rel}")]
    UnknownVersion { rel: String, hash: String },
    #[error(
        "did not restore {0}: its current content could not be captured to history first (not valid UTF-8?) — fix or delete the file, then restore again"
    )]
    SafetySnapshotSkipped(String),
}

/// One recorded version of one file. `ts` is epoch ms and `size` uncompressed
/// bytes (both conventions match `project.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub hash: String,
    pub ts: i64,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryIndex {
    #[serde(default)]
    schema_version: u64,
    /// Carried only so an orphaned history dir stays identifiable after its
    /// project folder moves or is deleted — never used for lookups.
    #[serde(default)]
    root_path: String,
    #[serde(default)]
    name: String,
    /// Relative path (forward slashes) → version entries, oldest first.
    #[serde(default)]
    files: BTreeMap<String, Vec<VersionEntry>>,
}

// ----- identity + gates ------------------------------------------------------

/// Stable project identity: first 16 hex chars of SHA-256 over the
/// canonicalized root path. There is no persisted project id in the registry
/// (`project.rs` keys everything off the healed root path), and in-app rename
/// is display-name-only, so this is stable across renames. A folder moved
/// outside the app gets a fresh id; the old dir stays identifiable via the
/// index's `rootPath`/`name`.
pub fn project_id(root: &Path) -> String {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canon.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..16].to_string()
}

fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Blob names come back from the renderer on read/restore; only ever join a
/// value that looks like one of our own SHA-256 hex digests onto the store dir.
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Shared project-relative validation (traversal / absolute / leading-dash)
/// plus a case-insensitive `.typeward` rejection at any depth — sidecar
/// contents (snapshots, build output, sync state) are not "your work" and
/// versioning them would double every crash-recovery write. Returns the
/// normalized forward-slash form used as the index key.
fn checked_rel(rel_path: &str) -> Result<String, HistoryError> {
    let rel = project::validate_project_relative_path(rel_path)?;
    let normalized = rel.to_string_lossy().replace('\\', "/");
    if normalized
        .split('/')
        .any(|seg| seg.eq_ignore_ascii_case(".typeward"))
    {
        return Err(HistoryError::NotTracked(rel_path.to_string()));
    }
    Ok(normalized)
}

fn tracked_ext(rel: &str) -> bool {
    Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| TRACKED_EXTS.iter().any(|t| ext.eq_ignore_ascii_case(t)))
}

/// Stateless record gate: skip when the content matches the newest recorded
/// version (hash dedupe), otherwise skip when the newest version is younger
/// than the throttle window. Comparing against the index's newest entry (not
/// in-memory clock bookkeeping) keeps this a pure function. `forced` — used
/// exactly once, by restore — bypasses both.
fn should_record(entries: &[VersionEntry], hash: &str, now_ms: i64, forced: bool) -> bool {
    if forced {
        return true;
    }
    match entries.last() {
        None => true,
        Some(latest) => {
            if latest.hash == hash {
                return false;
            }
            now_ms.saturating_sub(latest.ts) >= MIN_INTERVAL_MS
        }
    }
}

// ----- store IO ---------------------------------------------------------------

fn read_index(store: &Path) -> Result<HistoryIndex, HistoryError> {
    let path = store.join(INDEX_JSON);
    if !path.exists() {
        return Ok(HistoryIndex::default());
    }
    let bytes = fs::read(path)?;
    // A corrupt index degrades to empty rather than wedging history forever;
    // writes are atomic so this is a crash-mid-rename edge, not an expected
    // path.
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

fn write_index(store: &Path, index: &HistoryIndex) -> Result<(), HistoryError> {
    let json = serde_json::to_vec_pretty(index)?;
    fs_ops::atomic_write(&store.join(INDEX_JSON), &json)?;
    Ok(())
}

fn blob_path(store: &Path, hash: &str) -> PathBuf {
    store.join(BLOBS_DIR).join(hash)
}

/// Hashing the *uncompressed* content keeps addressing independent of
/// compression settings and dedupes identical content across versions AND
/// across files within a project — an existing blob never needs rewriting.
fn write_blob(store: &Path, hash: &str, content: &str) -> Result<(), HistoryError> {
    let path = blob_path(store, hash);
    if path.exists() {
        return Ok(());
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(content.as_bytes())?;
    let compressed = encoder.finish()?;
    fs_ops::atomic_write(&path, &compressed)?;
    Ok(())
}

fn read_blob(store: &Path, hash: &str) -> Result<String, HistoryError> {
    let bytes = fs::read(blob_path(store, hash))?;
    let mut out = String::new();
    GzDecoder::new(bytes.as_slice()).read_to_string(&mut out)?;
    Ok(out)
}

/// Keep each file's newest `max` entries (entries are oldest first).
fn prune_entries(entries: &mut Vec<VersionEntry>, max: usize) {
    if entries.len() > max {
        let excess = entries.len() - max;
        entries.drain(..excess);
    }
}

/// Sweep blobs no index entry references. Content-addressing is scoped per
/// project dir, so GC is a local mark-and-sweep over one index — never a
/// global scan. Leftover `.tmp` files from a crashed atomic write are
/// unreferenced by construction and get swept too.
fn gc_blobs(store: &Path, index: &HistoryIndex) -> Result<(), HistoryError> {
    let blobs = store.join(BLOBS_DIR);
    if !blobs.is_dir() {
        return Ok(());
    }
    let referenced: HashSet<&str> = index
        .files
        .values()
        .flatten()
        .map(|e| e.hash.as_str())
        .collect();
    for entry in fs::read_dir(&blobs)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !referenced.contains(name) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

// ----- core operations (pure of Tauri, unit-tested below) ----------------------

fn clamped_max(max_versions: u32) -> usize {
    max_versions.clamp(
        settings::HISTORY_MIN_VERSIONS_PER_FILE,
        settings::HISTORY_MAX_VERSIONS_PER_FILE,
    ) as usize
}

/// Record the file's current on-disk state. Returns `Ok(true)` when a version
/// was written, `Ok(false)` on the normal skips: untracked extension,
/// oversize (unless forced), non-UTF-8 content, hash dedupe, or the throttle
/// window. Only path-gate violations and real store failures error.
fn record_in_store(
    store: &Path,
    root: &Path,
    rel_path: &str,
    max_versions: u32,
    forced: bool,
    now_ms: i64,
    project_name: &str,
) -> Result<bool, HistoryError> {
    let rel = checked_rel(rel_path)?;
    if !tracked_ext(&rel) {
        return Ok(false);
    }
    let mut index = read_index(store)?;
    let entries = index.files.entry(rel.clone()).or_default();
    // Pure optimization in front of the authoritative `should_record` gate:
    // inside the throttle window every outcome is a skip (identical content
    // dedupes, changed content throttles), so the ~500ms-debounced autosave
    // burst decides from the index alone instead of reading + hashing the
    // whole file on each save.
    if !forced
        && entries
            .last()
            .is_some_and(|latest| now_ms.saturating_sub(latest.ts) < MIN_INTERVAL_MS)
    {
        return Ok(false);
    }
    let abs = project::resolve_existing_project_path(root, &rel)?;
    // A forced record (the pre-restore safety snapshot) deliberately bypasses
    // the normal size gate so a restore is never destructive — but the read
    // below pulls the whole file into memory, so the bypass still needs a
    // ceiling. Past it, refusing the restore is the safe outcome: the caller
    // turns Ok(false) into SafetySnapshotSkipped rather than overwriting a file
    // it could not capture.
    let len = fs::metadata(&abs)?.len();
    let ceiling = if forced {
        MAX_FORCED_SNAPSHOT_BYTES
    } else {
        MAX_SNAPSHOT_BYTES
    };
    if len > ceiling {
        return Ok(false);
    }
    // Not valid UTF-8 = a binary wearing a text extension; skip, not error.
    let Ok(content) = fs::read_to_string(&abs) else {
        return Ok(false);
    };
    let hash = content_hash(&content);
    if !should_record(entries, &hash, now_ms, forced) {
        return Ok(false);
    }
    write_blob(store, &hash, &content)?;
    entries.push(VersionEntry {
        hash,
        ts: now_ms,
        size: content.len() as u64,
    });
    prune_entries(entries, clamped_max(max_versions));
    index.schema_version = CURRENT_HISTORY_SCHEMA;
    index.root_path = root.to_string_lossy().into_owned();
    if !project_name.is_empty() {
        index.name = project_name.to_string();
    }
    write_index(store, &index)?;
    gc_blobs(store, &index)?;
    Ok(true)
}

/// One file's versions, newest first (UI order; the index stores oldest
/// first).
fn list_in_store(store: &Path, rel_path: &str) -> Result<Vec<VersionEntry>, HistoryError> {
    let rel = checked_rel(rel_path)?;
    let index = read_index(store)?;
    let mut entries = index.files.get(&rel).cloned().unwrap_or_default();
    entries.reverse();
    Ok(entries)
}

fn read_version_in_store(store: &Path, rel_path: &str, hash: &str) -> Result<String, HistoryError> {
    let rel = checked_rel(rel_path)?;
    let index = read_index(store)?;
    // The hash must be one of THIS file's recorded versions — membership also
    // guarantees the name is a digest we minted, so the path join is safe.
    let known = valid_hash(hash)
        && index
            .files
            .get(&rel)
            .is_some_and(|es| es.iter().any(|e| e.hash == hash));
    if !known {
        return Err(HistoryError::UnknownVersion {
            rel,
            hash: hash.to_string(),
        });
    }
    read_blob(store, hash)
}

/// Restore one recorded version over the working file. The current on-disk
/// state is ALWAYS force-recorded first (bypassing every record gate), so the
/// overwritten state ends up one entry up in the same list — restore is never
/// destructive. Returns the restored content so the frontend can refresh the
/// open buffer without a second read.
fn restore_in_store(
    store: &Path,
    root: &Path,
    rel_path: &str,
    hash: &str,
    max_versions: u32,
    now_ms: i64,
    project_name: &str,
) -> Result<String, HistoryError> {
    let rel = checked_rel(rel_path)?;
    let content = read_version_in_store(store, &rel, hash)?;
    // A missing current file has nothing to capture (the restore recreates
    // it); any other safety-snapshot failure must abort the overwrite. That
    // includes a *skipped* forced record — Ok(false) here means the current
    // content is unrecordable (non-UTF-8 behind a tracked extension), and
    // proceeding would make the restore destructive.
    if root.join(Path::new(&rel)).is_file()
        && !record_in_store(store, root, &rel, max_versions, true, now_ms, project_name)?
    {
        return Err(HistoryError::SafetySnapshotSkipped(rel));
    }
    let dest = project::resolve_project_write_path(root, &rel)?;
    fs_ops::atomic_write(&dest, content.as_bytes())?;
    Ok(content)
}

fn clear_store(store: &Path) -> Result<(), HistoryError> {
    if store.exists() {
        fs::remove_dir_all(store)?;
    }
    Ok(())
}

// ----- command wrappers ---------------------------------------------------------

/// Serialize history mutations per project: the TS side serializes saves per
/// file (`chainOnPath`), but different files save concurrently and every
/// record/restore read-modify-writes the one `index.json`.
fn project_mutex(id: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn store_dir(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "could not resolve app data dir".to_string())?;
    Ok(dir.join("history").join(project_id(root)))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Best-effort display name for the index (orphan identification only).
fn project_name(root: &Path) -> String {
    project::read_project(root)
        .map(|p| p.name)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn history_record(
    app: AppHandle,
    project_root: String,
    rel_path: String,
    forced: bool,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let root = PathBuf::from(&project_root);
        project::require_registered_root(&root).map_err(err)?;
        let max = settings::load(&app)
            .map_err(err)?
            .history
            .max_versions_per_file;
        let store = store_dir(&app, &root)?;
        let name = project_name(&root);
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        record_in_store(&store, &root, &rel_path, max, forced, now_ms(), &name).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn history_list(
    app: AppHandle,
    project_root: String,
    rel_path: String,
) -> Result<Vec<VersionEntry>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<VersionEntry>, String> {
        let root = PathBuf::from(&project_root);
        project::require_registered_root(&root).map_err(err)?;
        let store = store_dir(&app, &root)?;
        // Readers take the same per-project lock as the writers: a concurrent
        // record's prune + blob GC can delete the blob between an unlocked
        // index read and the blob read, surfacing as a raw "file not found"
        // for a version the list just showed.
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        list_in_store(&store, &rel_path).map_err(err)
    })
    .await
    .map_err(err)?
}

/// One recorded version anywhere in the project — a file's VersionEntry
/// plus the relative path it belongs to. Powers the project-wide history
/// popover (newest first across every tracked file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVersionEntry {
    pub rel_path: String,
    pub hash: String,
    pub ts: i64,
    pub size: u64,
}

#[tauri::command]
pub async fn history_list_project(
    app: AppHandle,
    project_root: String,
) -> Result<Vec<ProjectVersionEntry>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<ProjectVersionEntry>, String> {
        let root = PathBuf::from(&project_root);
        project::require_registered_root(&root).map_err(err)?;
        let store = store_dir(&app, &root)?;
        // Serialize against writers (record/restore/clear hold the same lock)
        // so a read can't observe the store mid-prune. index.json itself is
        // written atomically, so this is defense-in-depth for the content-blob
        // read paths and a consistent project-wide snapshot.
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        let index = read_index(&store).map_err(err)?;
        let mut out: Vec<ProjectVersionEntry> = index
            .files
            .iter()
            .flat_map(|(rel, entries)| {
                entries.iter().map(|e| ProjectVersionEntry {
                    rel_path: rel.clone(),
                    hash: e.hash.clone(),
                    ts: e.ts,
                    size: e.size,
                })
            })
            .collect();
        out.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| a.rel_path.cmp(&b.rel_path)));
        Ok(out)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn history_read_version(
    app: AppHandle,
    project_root: String,
    rel_path: String,
    hash: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let root = PathBuf::from(&project_root);
        project::require_registered_root(&root).map_err(err)?;
        let store = store_dir(&app, &root)?;
        // Guard against a concurrent prune (record/restore) deleting the blob
        // mid-read; those writers hold the same per-project lock.
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        read_version_in_store(&store, &rel_path, &hash).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn history_restore(
    app: AppHandle,
    project_root: String,
    rel_path: String,
    hash: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let root = PathBuf::from(&project_root);
        project::require_registered_root(&root).map_err(err)?;
        let max = settings::load(&app)
            .map_err(err)?
            .history
            .max_versions_per_file;
        let store = store_dir(&app, &root)?;
        let name = project_name(&root);
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        restore_in_store(&store, &root, &rel_path, &hash, max, now_ms(), &name).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn history_clear(app: AppHandle, project_root: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let root = PathBuf::from(&project_root);
        project::require_registered_root(&root).map_err(err)?;
        let store = store_dir(&app, &root)?;
        let lock = project_mutex(&project_id(&root));
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        clear_store(&store).map_err(err)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    const MAX: u32 = 50;
    const T0: i64 = 1_720_000_000_000;
    const FIVE_MIN: i64 = MIN_INTERVAL_MS;

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "typeward-history-test-{}-{}",
            std::process::id(),
            id
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// (project root, store dir) — separate siblings, like app-data vs project.
    fn setup() -> (PathBuf, PathBuf) {
        let base = temp_dir();
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        (root, base.join("store"))
    }

    fn write_file(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn record(store: &Path, root: &Path, rel: &str, at: i64) -> bool {
        record_in_store(store, root, rel, MAX, false, at, "Test").unwrap()
    }

    fn blob_names(store: &Path) -> Vec<String> {
        let blobs = store.join(BLOBS_DIR);
        if !blobs.is_dir() {
            return vec![];
        }
        let mut names: Vec<String> = fs::read_dir(blobs)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn record_list_read_round_trips() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "\\documentclass{article}");

        assert!(record(&store, &root, "main.tex", T0));

        let versions = list_in_store(&store, "main.tex").unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].ts, T0);
        assert_eq!(versions[0].size, "\\documentclass{article}".len() as u64);

        let content = read_version_in_store(&store, "main.tex", &versions[0].hash).unwrap();
        assert_eq!(content, "\\documentclass{article}");
    }

    #[test]
    fn skips_when_content_matches_latest_version() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "same");
        assert!(record(&store, &root, "main.tex", T0));
        // Unchanged content skips even far outside the throttle window.
        assert!(!record(&store, &root, "main.tex", T0 + 10 * FIVE_MIN));
        assert_eq!(list_in_store(&store, "main.tex").unwrap().len(), 1);
    }

    #[test]
    fn throttles_changed_content_within_five_minutes() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));

        write_file(&root, "main.tex", "v2");
        assert!(!record(&store, &root, "main.tex", T0 + FIVE_MIN - 1));
        assert!(record(&store, &root, "main.tex", T0 + FIVE_MIN));

        let versions = list_in_store(&store, "main.tex").unwrap();
        assert_eq!(versions.len(), 2);
        // Newest first.
        assert_eq!(versions[0].ts, T0 + FIVE_MIN);
    }

    #[test]
    fn forced_bypasses_dedupe_and_throttle() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "same");
        assert!(record(&store, &root, "main.tex", T0));
        // Identical content, one ms later — both gates would skip.
        assert!(record_in_store(&store, &root, "main.tex", MAX, true, T0 + 1, "Test").unwrap());
        assert_eq!(list_in_store(&store, "main.tex").unwrap().len(), 2);
        // Content-addressed: two entries, one blob.
        assert_eq!(blob_names(&store).len(), 1);
    }

    #[test]
    fn prunes_to_max_and_gc_sweeps_unreferenced_blobs() {
        let (root, store) = setup();
        for i in 0..5 {
            write_file(&root, "main.tex", &format!("version {i}"));
            assert!(
                record_in_store(
                    &store,
                    &root,
                    "main.tex",
                    10, // clamped floor — the smallest legal retention
                    true,
                    T0 + i,
                    "Test"
                )
                .unwrap()
            );
        }
        // 5 recorded with max 10: nothing pruned yet.
        assert_eq!(list_in_store(&store, "main.tex").unwrap().len(), 5);

        // Drop retention to the floor and keep recording; the oldest fall off
        // and their blobs are swept. (10 is the clamp floor, so exercise the
        // prune path by recording past it.)
        for i in 5..15 {
            write_file(&root, "main.tex", &format!("version {i}"));
            assert!(record_in_store(&store, &root, "main.tex", 10, true, T0 + i, "Test").unwrap());
        }
        let versions = list_in_store(&store, "main.tex").unwrap();
        assert_eq!(versions.len(), 10);
        assert_eq!(versions[0].ts, T0 + 14); // newest kept
        assert_eq!(versions[9].ts, T0 + 5); // oldest survivor
        assert_eq!(blob_names(&store).len(), 10);

        // Every surviving entry still resolves to its content.
        assert_eq!(
            read_version_in_store(&store, "main.tex", &versions[9].hash).unwrap(),
            "version 5"
        );
    }

    #[test]
    fn retention_below_floor_is_clamped() {
        let (root, store) = setup();
        for i in 0..12 {
            write_file(&root, "main.tex", &format!("v{i}"));
            assert!(record_in_store(&store, &root, "main.tex", 1, true, T0 + i, "Test").unwrap());
        }
        // max_versions=1 clamps to the floor of 10.
        assert_eq!(list_in_store(&store, "main.tex").unwrap().len(), 10);
    }

    #[test]
    fn restore_force_records_current_state_then_writes_version() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));
        let v1_hash = list_in_store(&store, "main.tex").unwrap()[0].hash.clone();

        // The state about to be overwritten was never recorded (younger than
        // the throttle window) — restore must capture it anyway.
        write_file(&root, "main.tex", "unsaved current");
        let restored =
            restore_in_store(&store, &root, "main.tex", &v1_hash, MAX, T0 + 1, "Test").unwrap();

        assert_eq!(restored, "v1");
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "v1");

        // Overwritten state is one entry up in the same list.
        let versions = list_in_store(&store, "main.tex").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            read_version_in_store(&store, "main.tex", &versions[0].hash).unwrap(),
            "unsaved current"
        );
    }

    #[test]
    fn restore_aborts_when_current_state_cannot_be_captured() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));
        let v1_hash = list_in_store(&store, "main.tex").unwrap()[0].hash.clone();

        // Externally re-encoded to non-UTF-8: the forced safety snapshot
        // cannot capture this state, so the restore must leave it untouched.
        fs::write(root.join("main.tex"), [0xff, 0xfe, 0x00, 0x42]).unwrap();
        assert!(matches!(
            restore_in_store(&store, &root, "main.tex", &v1_hash, MAX, T0 + 1, "Test"),
            Err(HistoryError::SafetySnapshotSkipped(_))
        ));
        assert_eq!(
            fs::read(root.join("main.tex")).unwrap(),
            [0xff, 0xfe, 0x00, 0x42]
        );
        assert_eq!(list_in_store(&store, "main.tex").unwrap().len(), 1);
    }

    #[test]
    fn throttle_window_skips_before_touching_the_file() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));

        // Within the window the gate decides from the index alone — the file
        // is never read (deleting it would otherwise error the record).
        fs::remove_file(root.join("main.tex")).unwrap();
        assert!(!record(&store, &root, "main.tex", T0 + 1));
    }

    #[test]
    fn restore_recreates_a_deleted_file() {
        let (root, store) = setup();
        write_file(&root, "chapters/intro.tex", "content");
        assert!(record(&store, &root, "chapters/intro.tex", T0));
        let hash = list_in_store(&store, "chapters/intro.tex").unwrap()[0]
            .hash
            .clone();

        fs::remove_file(root.join("chapters/intro.tex")).unwrap();
        fs::remove_dir(root.join("chapters")).unwrap();

        restore_in_store(
            &store,
            &root,
            "chapters/intro.tex",
            &hash,
            MAX,
            T0 + 1,
            "Test",
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("chapters/intro.tex")).unwrap(),
            "content"
        );
    }

    #[test]
    fn skips_untracked_extensions_and_oversize_files() {
        let (root, store) = setup();

        write_file(&root, "figure.png", "not really a png");
        assert!(!record(&store, &root, "figure.png", T0));

        write_file(&root, "build.aux", "aux junk");
        assert!(!record(&store, &root, "build.aux", T0));

        let big = "x".repeat((MAX_SNAPSHOT_BYTES + 1) as usize);
        write_file(&root, "huge.tex", &big);
        assert!(!record(&store, &root, "huge.tex", T0));

        assert!(list_in_store(&store, "figure.png").unwrap().is_empty());
        assert!(list_in_store(&store, "huge.tex").unwrap().is_empty());
        assert!(blob_names(&store).is_empty());
    }

    #[test]
    fn skips_non_utf8_content_without_error() {
        let (root, store) = setup();
        fs::write(root.join("binary.tex"), [0xff, 0xfe, 0x00, 0x42]).unwrap();
        assert!(!record(&store, &root, "binary.tex", T0));
    }

    #[test]
    fn rejects_traversal_and_typeward_paths() {
        let (root, store) = setup();
        for bad in [
            "../outside.tex",
            "/abs/outside.tex",
            "-shell-escape.tex",
            ".typeward/snapshots/main.tex.snap",
            "sub/.TypeWard/x.tex",
        ] {
            assert!(
                record_in_store(&store, &root, bad, MAX, false, T0, "Test").is_err(),
                "{bad} should be rejected"
            );
            assert!(
                list_in_store(&store, bad).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn read_version_rejects_unknown_or_malformed_hashes() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));
        write_file(&root, "other.tex", "other");
        assert!(record(&store, &root, "other.tex", T0));

        // Never recorded for THIS file, even though the blob exists (it
        // belongs to other.tex).
        let other_hash = list_in_store(&store, "other.tex").unwrap()[0].hash.clone();
        assert!(matches!(
            read_version_in_store(&store, "main.tex", &other_hash),
            Err(HistoryError::UnknownVersion { .. })
        ));

        // Path-shaped "hashes" never reach the blob join.
        for bad in ["../../settings.json", "abc", ""] {
            assert!(read_version_in_store(&store, "main.tex", bad).is_err());
        }
    }

    #[test]
    fn clear_store_removes_everything() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));
        assert!(store.exists());

        clear_store(&store).unwrap();
        assert!(!store.exists());
        assert!(list_in_store(&store, "main.tex").unwrap().is_empty());
    }

    #[test]
    fn project_id_is_stable_and_distinct() {
        let a = temp_dir();
        let b = temp_dir();
        assert_eq!(project_id(&a), project_id(&a));
        assert_ne!(project_id(&a), project_id(&b));
        assert_eq!(project_id(&a).len(), 16);
        assert!(project_id(&a).bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn corrupt_index_degrades_to_empty() {
        let (root, store) = setup();
        write_file(&root, "main.tex", "v1");
        assert!(record(&store, &root, "main.tex", T0));
        fs::write(store.join(INDEX_JSON), "{ not json").unwrap();
        assert!(list_in_store(&store, "main.tex").unwrap().is_empty());
        // Recording keeps working from the fresh slate.
        write_file(&root, "main.tex", "v2");
        assert!(record(&store, &root, "main.tex", T0 + FIVE_MIN));
        assert_eq!(list_in_store(&store, "main.tex").unwrap().len(), 1);
    }
}
