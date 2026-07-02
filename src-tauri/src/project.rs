use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fs_ops;

/// Mirrors the TypeScript `Project` type in src/adapters/types.ts. Persisted
/// at `<rootPath>/.typeward/project.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Absolute folder path.
    pub root_path: String,
    /// Entry file relative to rootPath, e.g. "main.tex".
    pub root_file: String,
    pub format: ProjectFormat,
    pub name: String,
    /// Optional user-set deadline, ISO date (`YYYY-MM-DD`). Additive — older
    /// project.json files load with `deadline = None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    /// Per-project integration state (cloud origin, git binding, reference
    /// library binding). Optional / additive — older project.json files
    /// without this block load with `ProjectIntegrations::default()`.
    #[serde(default)]
    pub integrations: ProjectIntegrations,
}

/// Listing view of a project: the persisted `Project` plus filesystem
/// timestamps computed at read time (epoch millis). The timestamps are NOT
/// part of project.json — they're derived from the folder/root-file metadata
/// each time the library is enumerated, so they can't go stale on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListing {
    #[serde(flatten)]
    pub project: Project,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntegrations {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_origin: Option<CloudOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<ReferenceBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOrigin {
    pub provider: String,
    pub account_id: String,
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub remote: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceBinding {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectFormat {
    Latex,
    Typst,
}

impl ProjectFormat {
    pub fn default_root_file(self) -> &'static str {
        match self {
            Self::Latex => "main.tex",
            Self::Typst => "main.typ",
        }
    }

    /// Minimal starter content for a new project's root file.
    pub fn starter_content(self, name: &str) -> String {
        match self {
            Self::Latex => format!(
                "\\documentclass{{article}}\n\\title{{{name}}}\n\\author{{}}\n\\date{{\\today}}\n\n\\begin{{document}}\n\\maketitle\n\nWelcome to {name}.\n\\end{{document}}\n"
            ),
            Self::Typst => format!("= {name}\n\nWelcome to {name}.\n"),
        }
    }
}

/// Current schema version stamped into `.typeward/project.json` (written by
/// `write_project`, checked tolerantly by `read_project`). The version lives in
/// the JSON artifact, not the in-memory `Project` struct, so additive fields
/// never ripple into every `Project { .. }` literal. Bump only for a
/// non-additive change that needs a migration. See CLAUDE.md's
/// persisted-artifact note; mirrors the sync-state.json versioning convention.
pub const CURRENT_PROJECT_SCHEMA: u64 = 1;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("project already exists at {0}")]
    AlreadyExists(String),
    #[error("path is not a directory: {0}")]
    NotADirectory(String),
    #[error("invalid project-relative path: {0}")]
    InvalidRelativePath(String),
    #[error("invalid project name: {0}")]
    InvalidProjectName(String),
    #[error("project path escapes root: {0}")]
    PathEscapesRoot(String),
    #[error("no .tex or .typ entry file found in folder")]
    NoRootFile,
    #[error("project root is not registered: {0}")]
    UnregisteredRoot(String),
}

const SIDECAR_DIR: &str = ".typeward";
const PROJECT_JSON: &str = "project.json";

pub fn sidecar_dir(root: &Path) -> PathBuf {
    root.join(SIDECAR_DIR)
}

pub fn project_json_path(root: &Path) -> PathBuf {
    sidecar_dir(root).join(PROJECT_JSON)
}

/// Ensure `.typeward/` is listed in `<root>/.git/info/exclude` so Typeward's
/// sidecar (snapshots, build output, review comments, project.json) never
/// registers as untracked churn. We touch `.git/info/exclude`, never the user's
/// tracked `.gitignore`. Idempotent and best-effort: a non-git folder or an
/// unwritable exclude file is silently a no-op. Mirrors the cloud engine's
/// `.typeward` guard — without this chokepoint every Typeward-opened repo is
/// permanently pull-blocked (dirty worktree) and stage-all sweeps snapshots
/// into commits.
pub fn ensure_sidecar_git_excluded(root: &Path) {
    let info = root.join(".git").join("info");
    if !info.is_dir() {
        return;
    }
    let exclude = info.join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    let already = existing.lines().any(|line| {
        let t = line.trim();
        t == ".typeward" || t == ".typeward/"
    });
    if already {
        return;
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(".typeward/\n");
    let _ = fs::write(&exclude, updated);
}

/// Read project metadata from `<root>/.typeward/project.json`.
pub fn read_project(root: &Path) -> Result<Project, ProjectError> {
    let path = project_json_path(root);
    let bytes = fs::read(path)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes)?;
    // Schema evolution degrades gracefully: older files (no `schemaVersion`)
    // are treated as the current schema, and a newer version than we understand
    // is still loaded best-effort so an older app never bricks a newer
    // project.json (fields are additive; serde ignores unknown keys). A
    // non-additive change must bump CURRENT_PROJECT_SCHEMA and migrate here.
    let _schema = value
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(CURRENT_PROJECT_SCHEMA);
    let mut project: Project = serde_json::from_value(value)?;
    validate_project_relative_path(&project.root_file)?;
    // Heal a stale rootPath if the project folder was moved.
    project.root_path = root.to_string_lossy().to_string();
    Ok(project)
}

pub fn write_project(project: &Project) -> Result<(), ProjectError> {
    validate_project_relative_path(&project.root_file)?;
    let root = Path::new(&project.root_path);
    let sidecar = sidecar_dir(root);
    fs::create_dir_all(&sidecar)?;
    let path = sidecar.join(PROJECT_JSON);
    // Stamp the schema version into the artifact (not the struct — see
    // CURRENT_PROJECT_SCHEMA) so future evolution has a discriminator.
    let mut value = serde_json::to_value(project)?;
    if let serde_json::Value::Object(map) = &mut value {
        map.insert(
            "schemaVersion".into(),
            serde_json::Value::from(CURRENT_PROJECT_SCHEMA),
        );
    }
    let json = serde_json::to_vec_pretty(&value)?;
    fs_ops::atomic_write(&path, &json)?;
    Ok(())
}

/// Read-modify-write update of the integrations block. Used after
/// `create_project` to attach a cloudOrigin / git binding without
/// shipping a separate setter for every field. Keeps the rest of the
/// project shape (rootFile, format, name) untouched.
pub fn update_project_integrations(
    root: &Path,
    integrations: ProjectIntegrations,
) -> Result<Project, ProjectError> {
    let mut project = read_project(root)?;
    project.integrations = integrations;
    write_project(&project)?;
    Ok(project)
}

/// Enumerate Typeward projects under `root` (one folder per project).
pub fn list_projects(root: &Path) -> Result<Vec<Project>, ProjectError> {
    if !root.exists() {
        return Ok(vec![]);
    }
    if !root.is_dir() {
        return Err(ProjectError::NotADirectory(root.to_string_lossy().into()));
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !project_json_path(&path).exists() {
            continue;
        }
        if let Ok(project) = read_project(&path) {
            out.push(project);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Like `list_projects` but attaches filesystem timestamps (created/modified)
/// so the Projects screen can offer date-based sorts and activity cards
/// without persisting volatile mtimes into project.json.
pub fn list_project_listings(root: &Path) -> Result<Vec<ProjectListing>, ProjectError> {
    let projects = list_projects(root)?;
    Ok(projects
        .into_iter()
        .map(|project| {
            let (created_at, modified_at) = project_fs_times(&project);
            ProjectListing {
                project,
                created_at,
                modified_at,
            }
        })
        .collect())
}

/// (created, modified) epoch-millis for a project. "Modified" is the newest of
/// the folder and root-file mtimes (a content edit bumps the root file; adding
/// a file bumps the folder). "Created" falls back to the modified time on
/// filesystems that don't record a birth time (e.g. some Linux setups).
fn project_fs_times(project: &Project) -> (Option<i64>, Option<i64>) {
    let root = Path::new(&project.root_path);
    let folder_meta = fs::metadata(root).ok();
    let file_meta = fs::metadata(root.join(&project.root_file)).ok();

    let to_ms = |t: std::time::SystemTime| -> Option<i64> {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64)
    };

    let folder_mtime = folder_meta.as_ref().and_then(|m| m.modified().ok());
    let file_mtime = file_meta.as_ref().and_then(|m| m.modified().ok());
    let modified = match (folder_mtime, file_mtime) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };

    let created = folder_meta
        .as_ref()
        .and_then(|m| m.created().ok())
        .or(modified);

    (created.and_then(to_ms), modified.and_then(to_ms))
}

/// Read-modify-write the project's deadline (`None` clears it). Returns the
/// updated project. Deadlines are plain ISO dates; the caller validates shape.
pub fn set_deadline(root: &Path, deadline: Option<String>) -> Result<Project, ProjectError> {
    let mut project = read_project(root)?;
    project.deadline = deadline;
    write_project(&project)?;
    Ok(project)
}

/// Turn an existing folder (e.g. a freshly cloned git repo) into a Typeward
/// project: if it already carries `.typeward/project.json` read it unchanged,
/// otherwise detect the root file and write the metadata. Without this a normal
/// repo clone never appears in the library (`list_projects` requires the
/// sidecar). Errors when no LaTeX/Typst entry is present.
pub fn import_folder_as_project(root: &Path, name: Option<&str>) -> Result<Project, ProjectError> {
    if !root.is_dir() {
        return Err(ProjectError::NotADirectory(root.to_string_lossy().into()));
    }
    ensure_sidecar_git_excluded(root);
    if project_json_path(root).exists() {
        return read_project(root);
    }
    let (root_file, format) = discover_root_file(root)?;
    let name = name
        .map(str::to_string)
        .or_else(|| {
            root.file_name()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Imported project".to_string());
    let project = Project {
        root_path: root.to_string_lossy().to_string(),
        root_file,
        format,
        name,
        deadline: None,
        integrations: ProjectIntegrations::default(),
    };
    write_project(&project)?;
    Ok(project)
}

/// Pick a root file: `main.tex`, then the first `.tex`, then the first `.typ`.
/// LaTeX-biased, mirroring the Overleaf import heuristic.
fn discover_root_file(root: &Path) -> Result<(String, ProjectFormat), ProjectError> {
    if root.join("main.tex").exists() {
        return Ok(("main.tex".into(), ProjectFormat::Latex));
    }
    if let Some(found) = find_first_by_ext(root, "tex")? {
        return Ok((found, ProjectFormat::Latex));
    }
    if let Some(found) = find_first_by_ext(root, "typ")? {
        return Ok((found, ProjectFormat::Typst));
    }
    Err(ProjectError::NoRootFile)
}

fn find_first_by_ext(dir: &Path, ext: &str) -> Result<Option<String>, ProjectError> {
    let mut matches: Vec<String> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) == Some(ext) {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                matches.push(name.to_string());
            }
        }
    }
    matches.sort();
    Ok(matches.into_iter().next())
}

pub fn create_project(
    parent: &Path,
    name: &str,
    format: ProjectFormat,
) -> Result<Project, ProjectError> {
    let safe_name = sanitize_folder_name(name);
    if safe_name.is_empty() {
        return Err(ProjectError::InvalidProjectName(name.to_string()));
    }
    let root = parent.join(&safe_name);
    if root.exists() {
        return Err(ProjectError::AlreadyExists(root.to_string_lossy().into()));
    }
    fs::create_dir_all(&root)?;

    let root_file = format.default_root_file();
    let root_file_path = root.join(root_file);
    fs::write(&root_file_path, format.starter_content(name))?;

    let project = Project {
        root_path: root.to_string_lossy().to_string(),
        root_file: root_file.to_string(),
        format,
        name: name.to_string(),
        deadline: None,
        integrations: ProjectIntegrations::default(),
    };
    write_project(&project)?;
    Ok(project)
}

fn sanitize_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

pub fn validate_project_relative_path(rel_path: &str) -> Result<PathBuf, ProjectError> {
    if rel_path.trim().is_empty() {
        return Err(ProjectError::InvalidRelativePath(rel_path.to_string()));
    }

    let path = Path::new(rel_path);
    if path.is_absolute() {
        return Err(ProjectError::InvalidRelativePath(rel_path.to_string()));
    }

    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                // Reject components that a downstream CLI would parse as an
                // option flag. project.rootFile flows straight into latexmk /
                // pdflatex / tectonic / typst as a positional argument; a file
                // named `-shell-escape` or `-output-directory=...` would
                // otherwise be interpreted as a flag (argument injection).
                if part.to_string_lossy().starts_with('-') {
                    return Err(ProjectError::InvalidRelativePath(rel_path.to_string()));
                }
                out.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ProjectError::InvalidRelativePath(rel_path.to_string()));
            }
        }
    }

    if out.as_os_str().is_empty() {
        return Err(ProjectError::InvalidRelativePath(rel_path.to_string()));
    }
    Ok(out)
}

pub fn resolve_existing_project_path(root: &Path, rel_path: &str) -> Result<PathBuf, ProjectError> {
    let rel = validate_project_relative_path(rel_path)?;
    let root = root.canonicalize()?;
    let resolved = root.join(rel).canonicalize()?;
    if !resolved.starts_with(&root) {
        return Err(ProjectError::PathEscapesRoot(
            resolved.to_string_lossy().into_owned(),
        ));
    }
    Ok(resolved)
}

pub fn resolve_project_write_path(root: &Path, rel_path: &str) -> Result<PathBuf, ProjectError> {
    let rel = validate_project_relative_path(rel_path)?;
    let root = root.canonicalize()?;
    let path = root.join(rel);
    let parent = path
        .parent()
        .ok_or_else(|| ProjectError::InvalidRelativePath(rel_path.to_string()))?;
    let existing_parent = canonical_existing_ancestor(parent)?;
    if !existing_parent.starts_with(&root) {
        return Err(ProjectError::PathEscapesRoot(
            existing_parent.to_string_lossy().into_owned(),
        ));
    }
    Ok(path)
}

fn canonical_existing_ancestor(path: &Path) -> Result<PathBuf, ProjectError> {
    let mut current = path;
    loop {
        if current.exists() {
            return Ok(current.canonicalize()?);
        }
        current = current.parent().ok_or_else(|| {
            ProjectError::InvalidRelativePath(path.to_string_lossy().into_owned())
        })?;
    }
}

// ----- Runtime trust boundary --------------------------------------------
//
// Threat model: webview XSS == arbitrary IPC. The custom file IPC, compile,
// snapshot, synctex, watcher, and git commands all validate paths relative to
// a *renderer-supplied* root — on their own they'd let a compromised webview
// read/write/compile anywhere the OS user can reach (e.g. ~/.ssh). Two gates
// bound that surface:
//
//   - the registry of project roots the user actually opened this session
//     (`register_root` is called only from the trusted open/list/create/import
//     paths, never from an unproven renderer path). File IO, compile,
//     snapshots, synctex, the watcher, and existing-repo git ops require the
//     root to be registered.
//   - the configured projects root, for validating brand-new destinations
//     (git clone) that aren't projects yet.

static OPENED_ROOTS: OnceLock<RwLock<HashSet<PathBuf>>> = OnceLock::new();
static PROJECTS_ROOT: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn opened_roots() -> &'static RwLock<HashSet<PathBuf>> {
    OPENED_ROOTS.get_or_init(|| RwLock::new(HashSet::new()))
}

fn projects_root_cell() -> &'static RwLock<Option<PathBuf>> {
    PROJECTS_ROOT.get_or_init(|| RwLock::new(None))
}

/// Record a project root the user opened. Call ONLY from trusted command paths
/// (open/list/create/import) that have proven the path is a real project.
pub fn register_root(root: &Path) {
    if let Ok(canon) = root.canonicalize() {
        if let Ok(mut set) = opened_roots().write() {
            set.insert(canon);
        }
    }
}

/// True if `root` canonicalizes to a project root opened this session.
pub fn is_registered_root(root: &Path) -> bool {
    let Ok(canon) = root.canonicalize() else {
        return false;
    };
    opened_roots()
        .read()
        .map(|set| set.contains(&canon))
        .unwrap_or(false)
}

/// Canonical registered-root gate. Every command taking a renderer-supplied
/// project root must route through this: on its own the custom file IPC,
/// compile, snapshots, synctex, the watcher, and existing-repo git ops validate
/// paths relative to whatever root the webview hands them, so a compromised
/// renderer could reach `~/.ssh` without it. Returns `Err` for any root the
/// user did not open this session. (Prefer this to raw `is_registered_root` in
/// new callers so the gate stays a single chokepoint.)
pub fn require_registered_root(root: &Path) -> Result<(), ProjectError> {
    if is_registered_root(root) {
        Ok(())
    } else {
        Err(ProjectError::UnregisteredRoot(
            root.to_string_lossy().into_owned(),
        ))
    }
}

/// Like `require_registered_root` but also accepts a brand-new destination
/// under the configured projects root (clone/init/template targets that aren't
/// projects yet). Route new-destination commands through this.
pub fn require_new_or_registered_root(root: &Path) -> Result<(), ProjectError> {
    if is_registered_root(root) || is_new_path_under_projects_root(root) {
        Ok(())
    } else {
        Err(ProjectError::UnregisteredRoot(
            root.to_string_lossy().into_owned(),
        ))
    }
}

/// Record the configured projects root (persisted-settings value, read at
/// startup and on settings save).
pub fn set_projects_root(root: &Path) {
    let canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if let Ok(mut cur) = projects_root_cell().write() {
        *cur = Some(canon);
    }
}

/// True if a not-yet-existing path (e.g. a clone destination) sits under the
/// configured projects root. The leaf doesn't exist yet, so the nearest
/// existing ancestor is canonicalized for the prefix check.
pub fn is_path_under_projects_root(path: &Path) -> bool {
    let Ok(guard) = projects_root_cell().read() else {
        return false;
    };
    let Some(root) = guard.as_ref() else {
        return false;
    };
    match canonical_existing_ancestor(path) {
        Ok(ancestor) => ancestor.starts_with(root),
        Err(_) => false,
    }
}

pub fn is_new_path_under_projects_root(path: &Path) -> bool {
    is_path_under_projects_root(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = env::temp_dir();
        dir.push(format!("typeward-test-{}-{}", std::process::id(), id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trips_project_json() {
        let dir = temp_dir();
        let project = create_project(&dir, "Test", ProjectFormat::Latex).unwrap();
        let read = read_project(Path::new(&project.root_path)).unwrap();
        assert_eq!(read.name, "Test");
        assert_eq!(read.root_file, "main.tex");
        assert!(matches!(read.format, ProjectFormat::Latex));
    }

    #[test]
    fn write_project_stamps_schema_version() {
        let dir = temp_dir();
        let project = create_project(&dir, "Stamped", ProjectFormat::Latex).unwrap();
        let raw = fs::read_to_string(project_json_path(Path::new(&project.root_path))).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value.get("schemaVersion").and_then(|v| v.as_u64()),
            Some(CURRENT_PROJECT_SCHEMA)
        );
    }

    #[test]
    fn read_project_accepts_missing_schema_version() {
        // Older project.json files predate the schemaVersion field; they must
        // still load (treated as the current schema).
        let dir = temp_dir();
        fs::create_dir_all(dir.join(SIDECAR_DIR)).unwrap();
        fs::write(
            project_json_path(&dir),
            r#"{
  "rootPath": "ignored",
  "rootFile": "main.tex",
  "format": "latex",
  "name": "Legacy"
}"#,
        )
        .unwrap();
        let read = read_project(&dir).unwrap();
        assert_eq!(read.name, "Legacy");
    }

    #[test]
    fn read_project_tolerates_unknown_future_schema_version() {
        // A newer app version may have written a higher schema; load it
        // best-effort rather than bricking the project.
        let dir = temp_dir();
        fs::create_dir_all(dir.join(SIDECAR_DIR)).unwrap();
        fs::write(
            project_json_path(&dir),
            r#"{
  "schemaVersion": 999,
  "rootPath": "ignored",
  "rootFile": "main.tex",
  "format": "latex",
  "name": "FromTheFuture"
}"#,
        )
        .unwrap();
        let read = read_project(&dir).unwrap();
        assert_eq!(read.name, "FromTheFuture");
    }

    #[test]
    fn ensure_sidecar_git_excluded_is_idempotent_and_git_only() {
        // No .git → no-op (no file created).
        let plain = temp_dir();
        ensure_sidecar_git_excluded(&plain);
        assert!(!plain.join(".git").exists());

        // With .git/info → writes `.typeward/` once, even across repeat calls
        // and without clobbering existing entries.
        let repo = temp_dir();
        let info = repo.join(".git").join("info");
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("exclude"), "# git ls-files exclude\n*.log\n").unwrap();
        ensure_sidecar_git_excluded(&repo);
        ensure_sidecar_git_excluded(&repo);
        let contents = fs::read_to_string(info.join("exclude")).unwrap();
        assert_eq!(contents.matches(".typeward/").count(), 1);
        assert!(contents.contains("*.log"));
    }

    #[test]
    fn deadline_round_trips_and_clears() {
        let dir = temp_dir();
        let project = create_project(&dir, "Deadline", ProjectFormat::Latex).unwrap();
        assert!(project.deadline.is_none());

        let root = Path::new(&project.root_path);
        let set = set_deadline(root, Some("2026-07-01".into())).unwrap();
        assert_eq!(set.deadline.as_deref(), Some("2026-07-01"));
        assert_eq!(
            read_project(root).unwrap().deadline.as_deref(),
            Some("2026-07-01")
        );

        let cleared = set_deadline(root, None).unwrap();
        assert!(cleared.deadline.is_none());
        assert!(read_project(root).unwrap().deadline.is_none());
    }

    #[test]
    fn listings_attach_filesystem_timestamps() {
        let dir = temp_dir();
        create_project(&dir, "Timed", ProjectFormat::Typst).unwrap();
        let listings = list_project_listings(&dir).unwrap();
        assert_eq!(listings.len(), 1);
        assert!(listings[0].modified_at.is_some());
        // `created` falls back to `modified` when birth time is unavailable, so
        // it should always be populated for a folder we just created.
        assert!(listings[0].created_at.is_some());
    }

    #[test]
    fn list_skips_folders_without_sidecar() {
        let dir = temp_dir();
        create_project(&dir, "Real", ProjectFormat::Typst).unwrap();
        fs::create_dir_all(dir.join("Plain")).unwrap();
        let projects = list_projects(&dir).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Real");
    }

    #[test]
    fn sanitize_folder_name_strips_unsafe_chars() {
        assert_eq!(sanitize_folder_name("My Project!"), "My-Project");
        assert_eq!(sanitize_folder_name("foo/bar"), "foo-bar");
    }

    #[test]
    fn create_project_rejects_empty_sanitized_name() {
        let dir = temp_dir();
        let err = create_project(&dir, " !!! ", ProjectFormat::Latex).unwrap_err();
        assert!(matches!(err, ProjectError::InvalidProjectName(_)));
    }

    #[test]
    fn write_project_rejects_unsafe_root_file() {
        let dir = temp_dir();
        let project = Project {
            root_path: dir.to_string_lossy().to_string(),
            root_file: "-shell-escape.tex".into(),
            format: ProjectFormat::Latex,
            name: "Bad".into(),
            deadline: None,
            integrations: ProjectIntegrations::default(),
        };
        let err = write_project(&project).unwrap_err();
        assert!(matches!(err, ProjectError::InvalidRelativePath(_)));
    }

    #[test]
    fn read_project_rejects_root_file_that_escapes_root() {
        let dir = temp_dir();
        fs::create_dir_all(dir.join(SIDECAR_DIR)).unwrap();
        fs::write(
            project_json_path(&dir),
            r#"{
  "rootPath": "ignored",
  "rootFile": "../outside.tex",
  "format": "latex",
  "name": "Bad"
}"#,
        )
        .unwrap();

        let err = read_project(&dir).expect_err("unsafe rootFile should be rejected");
        assert!(err.to_string().contains("invalid project-relative path"));
    }

    #[test]
    fn project_path_resolution_rejects_parent_and_absolute_paths() {
        let dir = temp_dir();

        for rel in [
            "../outside.tex",
            "/tmp/outside.tex",
            "sections/../../outside.tex",
        ] {
            let err = resolve_existing_project_path(&dir, rel)
                .expect_err("unsafe relative path should be rejected");
            assert!(err.to_string().contains("invalid project-relative path"));
        }
    }

    #[test]
    fn validate_rejects_components_that_look_like_cli_flags() {
        // A root file / project path whose component begins with `-` would be
        // parsed as an option by latexmk/pdflatex/tectonic/typst.
        for rel in [
            "-shell-escape",
            "-output-directory=/tmp",
            "sections/-x.tex",
            "-r.bib",
        ] {
            let err = validate_project_relative_path(rel)
                .expect_err("leading-dash component should be rejected");
            assert!(err.to_string().contains("invalid project-relative path"));
        }
        // Dashes elsewhere in a name remain valid.
        assert!(validate_project_relative_path("my-paper/intro-section.tex").is_ok());
    }

    #[test]
    fn project_write_path_stays_under_canonical_root() {
        let dir = temp_dir();
        let resolved = resolve_project_write_path(&dir, "sections/intro.tex").unwrap();
        assert!(resolved.starts_with(dir.canonicalize().unwrap()));
        assert!(resolved.ends_with(Path::new("sections").join("intro.tex")));
    }

    #[test]
    fn registry_gates_only_registered_roots() {
        let opened = temp_dir();
        let other = temp_dir();
        assert!(!is_registered_root(&opened));
        register_root(&opened);
        assert!(is_registered_root(&opened));
        // A sibling directory we never opened stays out.
        assert!(!is_registered_root(&other));
    }

    #[test]
    fn new_path_under_projects_root_accepts_children_rejects_outside() {
        let root = temp_dir();
        set_projects_root(&root);
        // A brand-new child dir (clone destination) is allowed.
        assert!(is_new_path_under_projects_root(&root.join("cloned-repo")));
        assert!(is_new_path_under_projects_root(
            &root.join("nested").join("repo")
        ));
        // Outside the projects root is rejected (parent escape).
        let outside = temp_dir().join("evil");
        assert!(!is_new_path_under_projects_root(&outside));
    }
}
