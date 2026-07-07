use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fs_ops;

/// Mirrors the TypeScript `Project` type in src/adapters/types.ts. Persisted
/// at `<rootPath>/.typeward/project.json`.
///
/// `Default` is derived so additive fields land in one place — the creation
/// paths spread `..Default::default()` instead of respelling every field.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Free-form tags for library filtering. Additive; older files load empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Space id (from the workspace spaces catalog in settings.json) this
    /// project belongs to, if any. The catalog is not cross-checked here — the
    /// frontend renders an unknown id as unassigned. Additive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<String>,
    /// Whether the project is archived (hidden from the default library view).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    /// In-app soft-trash stamp (epoch ms). `Some` hides the project from every
    /// library view except Trashed and blocks opening; cleared on restore.
    /// Epoch ms rather than bool so a future auto-purge can age entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<i64>,
    /// Last time the project was opened, epoch millis. Unlike created/modified
    /// (derived from filesystem metadata at listing time) this IS persisted —
    /// stamped on open via `touch_opened`. Additive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<i64>,
    /// Per-project integration state (cloud origin, git binding, reference
    /// library binding). Optional / additive — older project.json files
    /// without this block load with `ProjectIntegrations::default()`.
    #[serde(default)]
    pub integrations: ProjectIntegrations,
    /// Per-project LaTeX build overrides (engine, flags). `None` falls back to
    /// the global compile settings. Additive; validated on write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<ProjectBuild>,
}

/// Per-project LaTeX build configuration. Every field is optional so an
/// unset entry defers to the global compile settings; a missing block defers
/// entirely. The `engine` string is tolerated on read (an unknown value is
/// treated as unset by the frontend resolver) and validated on write.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBuild {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Curated multi-pass recipe (`latexmk` | `engine-only` | `engine-bibtex` |
    /// `engine-biber`). `None` defers to `latexmk`. Tolerated on read (an unknown
    /// value is treated as unset by the frontend resolver) and validated on write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_escape: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synctex: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_on_first_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_compile: Option<bool>,
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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectFormat {
    #[default]
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
    #[error("invalid tag: {0}")]
    InvalidTag(String),
    #[error("too many tags (max 32)")]
    TooManyTags,
    #[error("invalid space id: {0}")]
    InvalidSpace(String),
    #[error("could not move project to trash: {0}")]
    Trash(String),
    #[error("invalid build engine: {0}")]
    InvalidBuildEngine(String),
    #[error("invalid build recipe: {0}")]
    InvalidBuildRecipe(String),
    #[error("root file extension does not match project format: {0}")]
    InvalidRootFileExtension(String),
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

const MAX_TAGS: usize = 32;
const MAX_TAG_LEN: usize = 48;
const MAX_SPACE_ID_LEN: usize = 64;
const MAX_PROJECT_NAME_LEN: usize = 128;

/// Trim, reject control chars / empty / over-long, dedupe case-insensitively
/// (keeping first casing), and cap the count. Enforced at the data layer so the
/// invariant holds regardless of caller.
pub fn normalize_tags(tags: Vec<String>) -> Result<Vec<String>, ProjectError> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().any(|c| c.is_control()) || t.chars().count() > MAX_TAG_LEN {
            return Err(ProjectError::InvalidTag(raw));
        }
        if out.iter().any(|e| e.eq_ignore_ascii_case(t)) {
            continue;
        }
        if out.len() >= MAX_TAGS {
            return Err(ProjectError::TooManyTags);
        }
        out.push(t.to_string());
    }
    Ok(out)
}

fn validate_space_id(space: &str) -> Result<(), ProjectError> {
    if space.is_empty()
        || space.chars().count() > MAX_SPACE_ID_LEN
        || space.chars().any(|c| c.is_control())
    {
        return Err(ProjectError::InvalidSpace(space.to_string()));
    }
    Ok(())
}

/// Trim + validate a user-supplied display name.
pub fn normalize_project_name(name: &str) -> Result<String, ProjectError> {
    let t = name.trim();
    if t.is_empty() || t.chars().count() > MAX_PROJECT_NAME_LEN || t.chars().any(|c| c.is_control()) {
        return Err(ProjectError::InvalidProjectName(name.to_string()));
    }
    Ok(t.to_string())
}

pub fn set_tags(root: &Path, tags: Vec<String>) -> Result<Project, ProjectError> {
    let tags = normalize_tags(tags)?;
    let mut project = read_project(root)?;
    project.tags = tags;
    write_project(&project)?;
    Ok(project)
}

pub fn set_space(root: &Path, space: Option<String>) -> Result<Project, ProjectError> {
    let space = match space {
        Some(s) => {
            let t = s.trim().to_string();
            validate_space_id(&t)?;
            Some(t)
        }
        None => None,
    };
    let mut project = read_project(root)?;
    project.space = space;
    write_project(&project)?;
    Ok(project)
}

pub fn set_trashed(root: &Path, trashed_at: Option<i64>) -> Result<Project, ProjectError> {
    let mut project = read_project(root)?;
    project.trashed_at = trashed_at;
    write_project(&project)?;
    Ok(project)
}

pub fn set_archived(root: &Path, archived: bool) -> Result<Project, ProjectError> {
    let mut project = read_project(root)?;
    project.archived = archived;
    write_project(&project)?;
    Ok(project)
}

/// Stamp the last-opened time (epoch millis). Writing into `.typeward/` bumps
/// only the sidecar dir's mtime, not the project folder / root-file mtimes that
/// drive the modified-sort — so this is safe to call on every open.
pub fn touch_opened(root: &Path, at_ms: i64) -> Result<(), ProjectError> {
    let mut project = read_project(root)?;
    project.last_opened_at = Some(at_ms);
    write_project(&project)?;
    Ok(())
}

const VALID_BUILD_ENGINES: &[&str] = &["pdflatex", "xelatex", "lualatex", "tectonic"];

/// The curated recipe values, mirroring the strict `BuildRecipe` enum in
/// `compile.rs`. Kept in sync by a two-sided drift test there, exactly like
/// `VALID_BUILD_ENGINES` mirrors `LatexEngine`.
pub const VALID_BUILD_RECIPES: &[&str] =
    &["latexmk", "engine-only", "engine-bibtex", "engine-biber"];

/// Set (or clear with `None`) the per-project build config. The engine and
/// recipe strings are validated against their fixed sets so an unknown value
/// never reaches the compile command (which maps each to a strict enum).
pub fn set_build(root: &Path, build: Option<ProjectBuild>) -> Result<Project, ProjectError> {
    if let Some(b) = &build {
        if let Some(engine) = &b.engine {
            if !VALID_BUILD_ENGINES.contains(&engine.as_str()) {
                return Err(ProjectError::InvalidBuildEngine(engine.clone()));
            }
        }
        if let Some(recipe) = &b.recipe {
            if !VALID_BUILD_RECIPES.contains(&recipe.as_str()) {
                return Err(ProjectError::InvalidBuildRecipe(recipe.clone()));
            }
        }
    }
    let mut project = read_project(root)?;
    project.build = build;
    write_project(&project)?;
    Ok(project)
}

/// Point the project at a different entry file. The path must be a validated,
/// existing project-relative file whose extension matches the project format
/// (`tex` for LaTeX, `typ` for Typst) so the picker can't retarget compile at an
/// unrelated file. `write_project` re-validates `rootFile` (leading-dash guard).
pub fn set_root_file(root: &Path, rel_path: &str) -> Result<Project, ProjectError> {
    let rel = validate_project_relative_path(rel_path)?;
    let resolved = resolve_existing_project_path(root, rel_path)?;
    if !resolved.is_file() {
        return Err(ProjectError::NoRootFile);
    }
    let mut project = read_project(root)?;
    let expected_ext = match project.format {
        ProjectFormat::Latex => "tex",
        ProjectFormat::Typst => "typ",
    };
    let ext_ok = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(expected_ext))
        .unwrap_or(false);
    if !ext_ok {
        return Err(ProjectError::InvalidRootFileExtension(rel_path.to_string()));
    }
    project.root_file = rel.to_string_lossy().into_owned();
    write_project(&project)?;
    Ok(project)
}

/// Rewrite the display name only. Folder rename is deliberately out of scope
/// (it would invalidate the registered-root registry, the watcher, open-editor
/// URLs, and the cloud/git bindings) — the folder name only surfaces in the
/// import picker.
pub fn rename(root: &Path, name: String) -> Result<Project, ProjectError> {
    let name = normalize_project_name(&name)?;
    let mut project = read_project(root)?;
    project.name = name;
    write_project(&project)?;
    Ok(project)
}

/// Move a project folder to the OS trash (Recycle Bin / Trash / freedesktop).
/// Recoverable, so the UI confirms with a plain dialog rather than a typed
/// confirmation. Mobile has no trash concept — fall back to a hard delete.
pub fn delete_project(root: &Path) -> Result<(), ProjectError> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        trash::delete(root).map_err(|e| ProjectError::Trash(e.to_string()))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        fs::remove_dir_all(root)?;
        Ok(())
    }
}

/// Directories dropped wholesale when duplicating (VCS + dependency dirs). The
/// sidecar `.typeward` is handled specially — only its `citations/` survives.
const DUPLICATE_SKIP_DIRS: &[&str] = &[".git", ".svn", ".hg", "node_modules"];

/// Copy a project into a fresh sibling folder, skipping VCS/dependency dirs and
/// most of the sidecar (only `.typeward/citations/` is carried so `\cite`
/// completions stay instant). Returns the new folder and its persisted Project.
/// The copy drops cloud-origin and git bindings (two projects can't push one
/// remote, and the copy has no `.git`) but keeps the reference-library binding.
pub fn duplicate_project(
    source_root: &Path,
    new_name: Option<String>,
) -> Result<(PathBuf, Project), ProjectError> {
    let source = read_project(source_root)?;
    let parent = source_root
        .parent()
        .ok_or_else(|| ProjectError::InvalidRelativePath(source_root.to_string_lossy().into()))?;

    let display_name = match new_name {
        Some(n) => normalize_project_name(&n)?,
        // The auto-generated name bypasses the interactive rename validator, so
        // apply the same length cap here rather than persisting an over-long name.
        None => format!("{} copy", source.name)
            .chars()
            .take(MAX_PROJECT_NAME_LEN)
            .collect(),
    };
    let mut base = sanitize_folder_name(&display_name);
    if base.is_empty() {
        base = sanitize_folder_name(&source.name);
    }
    if base.is_empty() {
        return Err(ProjectError::InvalidProjectName(display_name));
    }

    let mut dest = parent.join(&base);
    let mut n = 2;
    while dest.exists() {
        dest = parent.join(format!("{base}-{n}"));
        n += 1;
    }

    copy_project_tree(source_root, &dest)?;

    let mut integrations = source.integrations.clone();
    integrations.cloud_origin = None;
    integrations.git = None;

    let project = Project {
        root_path: dest.to_string_lossy().to_string(),
        root_file: source.root_file.clone(),
        format: source.format,
        name: display_name,
        deadline: source.deadline.clone(),
        tags: source.tags.clone(),
        space: source.space.clone(),
        archived: false,
        trashed_at: None,
        last_opened_at: None,
        integrations,
        build: source.build.clone(),
    };
    write_project(&project)?;
    Ok((dest, project))
}

fn copy_project_tree(src: &Path, dest: &Path) -> Result<(), ProjectError> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let src_path = entry.path();
        let dest_path = dest.join(&name);
        if file_type.is_dir() {
            if name_str == SIDECAR_DIR {
                // Carry only the citations library; project.json is rewritten
                // fresh and snapshots/build/reviews must not travel.
                let citations = src_path.join("citations");
                if citations.is_dir() {
                    copy_dir_recursive(&citations, &dest_path.join("citations"))?;
                }
                continue;
            }
            if DUPLICATE_SKIP_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            copy_dir_recursive(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), ProjectError> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
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
        ..Default::default()
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
        ..Default::default()
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
    fn read_project_drops_legacy_starred_key_on_next_write() {
        // The `starred` field was removed; legacy project.json files carrying it
        // must still deserialize (serde ignores unknown keys) and the stale key
        // must not survive the next metadata write.
        let dir = temp_dir();
        fs::create_dir_all(dir.join(SIDECAR_DIR)).unwrap();
        fs::write(
            project_json_path(&dir),
            r#"{
  "rootPath": "ignored",
  "rootFile": "main.tex",
  "format": "latex",
  "name": "Starry",
  "starred": true
}"#,
        )
        .unwrap();
        let read = read_project(&dir).unwrap();
        assert_eq!(read.name, "Starry");

        write_project(&read).unwrap();
        let raw = fs::read_to_string(project_json_path(&dir)).unwrap();
        assert!(!raw.contains("starred"));
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
            ..Default::default()
        };
        let err = write_project(&project).unwrap_err();
        assert!(matches!(err, ProjectError::InvalidRelativePath(_)));
    }

    #[test]
    fn library_metadata_round_trips_and_defaults_empty() {
        let dir = temp_dir();
        let project = create_project(&dir, "Meta", ProjectFormat::Latex).unwrap();
        // Fresh projects default to empty/false/none.
        assert!(project.tags.is_empty());
        assert!(project.space.is_none());
        assert!(!project.archived);
        assert!(project.trashed_at.is_none());
        assert!(project.last_opened_at.is_none());

        let root = Path::new(&project.root_path);
        set_tags(root, vec!["ML".into(), "  ml  ".into(), "Draft".into()]).unwrap();
        set_space(root, Some("space-1".into())).unwrap();
        set_archived(root, true).unwrap();
        set_trashed(root, Some(1_720_000_000_001)).unwrap();
        touch_opened(root, 1_720_000_000_000).unwrap();

        let read = read_project(root).unwrap();
        assert_eq!(read.tags, vec!["ML".to_string(), "Draft".to_string()]); // deduped
        assert_eq!(read.space.as_deref(), Some("space-1"));
        assert!(read.archived);
        assert_eq!(read.trashed_at, Some(1_720_000_000_001));
        assert_eq!(read.last_opened_at, Some(1_720_000_000_000));

        // Clearing trash works.
        let untrashed = set_trashed(root, None).unwrap();
        assert!(untrashed.trashed_at.is_none());
        assert!(read_project(root).unwrap().trashed_at.is_none());

        // Clearing space works.
        let cleared = set_space(root, None).unwrap();
        assert!(cleared.space.is_none());
    }

    #[test]
    fn normalize_tags_enforces_limits() {
        assert!(normalize_tags(vec!["\u{0007}bad".into()]).is_err());
        let long = "x".repeat(49);
        assert!(normalize_tags(vec![long]).is_err());
        let many: Vec<String> = (0..40).map(|i| format!("t{i}")).collect();
        assert!(matches!(
            normalize_tags(many).unwrap_err(),
            ProjectError::TooManyTags
        ));
        assert_eq!(
            normalize_tags(vec!["  a ".into(), "".into(), "A".into()]).unwrap(),
            vec!["a".to_string()]
        );
    }

    #[test]
    fn rename_updates_display_name_only() {
        let dir = temp_dir();
        let project = create_project(&dir, "Original", ProjectFormat::Latex).unwrap();
        let root = Path::new(&project.root_path);
        let renamed = rename(root, "  Renamed Paper  ".into()).unwrap();
        assert_eq!(renamed.name, "Renamed Paper");
        // Folder path is unchanged.
        assert_eq!(renamed.root_path, project.root_path);
        assert!(rename(root, "   ".into()).is_err());
    }

    #[test]
    fn duplicate_copies_sources_and_resets_state() {
        let dir = temp_dir();
        let project = create_project(&dir, "Source", ProjectFormat::Latex).unwrap();
        let root = Path::new(&project.root_path);
        set_trashed(root, Some(1)).unwrap();
        set_tags(root, vec!["keep".into()]).unwrap();
        // Plant a citations file and a snapshot; only the former should copy.
        let cite_dir = sidecar_dir(root).join("citations");
        fs::create_dir_all(&cite_dir).unwrap();
        fs::write(cite_dir.join("local.bib"), "@book{k, title={T}}").unwrap();
        let snap_dir = sidecar_dir(root).join("snapshots");
        fs::create_dir_all(&snap_dir).unwrap();
        fs::write(snap_dir.join("x.snap"), "junk").unwrap();

        let (dest, copy) = duplicate_project(root, None).unwrap();
        assert_eq!(copy.name, "Source copy");
        assert_eq!(copy.tags, vec!["keep".to_string()]);
        assert!(copy.trashed_at.is_none()); // reset
        assert!(dest.join("main.tex").exists());
        assert!(dest.join(".typeward").join("citations").join("local.bib").exists());
        assert!(!dest.join(".typeward").join("snapshots").exists());
    }

    #[test]
    fn set_root_file_requires_existing_matching_extension() {
        let dir = temp_dir();
        let project = create_project(&dir, "Roots", ProjectFormat::Latex).unwrap();
        let root = Path::new(&project.root_path);

        // A second .tex entry that exists and matches the format switches cleanly.
        fs::write(root.join("chapter.tex"), "\\section{X}").unwrap();
        let updated = set_root_file(root, "chapter.tex").unwrap();
        assert_eq!(updated.root_file, "chapter.tex");
        assert_eq!(read_project(root).unwrap().root_file, "chapter.tex");

        // Wrong extension for a LaTeX project is rejected even when the file exists.
        fs::write(root.join("notes.typ"), "= Notes").unwrap();
        let err = set_root_file(root, "notes.typ").unwrap_err();
        assert!(matches!(err, ProjectError::InvalidRootFileExtension(_)));

        // A non-existent file is rejected (canonicalize fails before the ext check).
        assert!(set_root_file(root, "ghost.tex").is_err());

        // Traversal / dash-flag names are rejected by the shared validator.
        assert!(set_root_file(root, "../outside.tex").is_err());
    }

    #[test]
    fn set_build_validates_recipe_and_engine() {
        let dir = temp_dir();
        let project = create_project(&dir, "Recipe", ProjectFormat::Latex).unwrap();
        let root = Path::new(&project.root_path);

        for recipe in VALID_BUILD_RECIPES {
            let build = ProjectBuild {
                recipe: Some((*recipe).to_string()),
                ..Default::default()
            };
            assert!(set_build(root, Some(build)).is_ok(), "recipe {recipe} should be accepted");
        }

        let bad = ProjectBuild {
            recipe: Some("engine-nonsense".into()),
            ..Default::default()
        };
        assert!(matches!(
            set_build(root, Some(bad)).unwrap_err(),
            ProjectError::InvalidBuildRecipe(_)
        ));

        let bad_engine = ProjectBuild {
            engine: Some("ghostscript".into()),
            ..Default::default()
        };
        assert!(matches!(
            set_build(root, Some(bad_engine)).unwrap_err(),
            ProjectError::InvalidBuildEngine(_)
        ));
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
