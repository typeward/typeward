use std::path::{Path, PathBuf};

use crate::autosave::{self, Snapshot};
#[cfg(desktop)]
use crate::detect::{self, EngineProbe};
use crate::fs_ops;
use crate::project::{self, Project, ProjectBuild, ProjectFormat};
use crate::settings::{self, Settings};

/// Convert any error into a String at the command boundary so Tauri's bridge
/// can serialize it cleanly. Domain modules keep their own typed errors.
type CmdResult<T> = Result<T, String>;

const MAX_PROJECT_TEXT_READ_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PROJECT_BINARY_READ_BYTES: u64 = 128 * 1024 * 1024;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Gate a renderer-supplied project root against the registry of opened
/// projects (see `project.rs`). Threat model: webview XSS == arbitrary IPC, so
/// every file/compile/snapshot/watch command that takes a root must prove it's
/// a project the user actually opened — not an arbitrary path like `~/.ssh`.
fn ensure_registered(project_root: &str) -> CmdResult<()> {
    if project::is_registered_root(Path::new(project_root)) {
        Ok(())
    } else {
        Err(format!("not an opened project root: {project_root}"))
    }
}

fn ensure_under_projects_root(path: &Path) -> CmdResult<()> {
    if project::is_path_under_projects_root(path) {
        Ok(())
    } else {
        Err(format!(
            "path is outside the configured projects root: {}",
            path.display()
        ))
    }
}

fn ensure_registered_or_under_projects_root(path: &Path) -> CmdResult<()> {
    if project::is_registered_root(path) || project::is_path_under_projects_root(path) {
        Ok(())
    } else {
        Err(format!(
            "path is outside the configured projects root: {}",
            path.display()
        ))
    }
}

pub(crate) fn checked_project_root_and_file(project: &Project) -> CmdResult<(PathBuf, String)> {
    ensure_registered(&project.root_path)?;
    let root = PathBuf::from(&project.root_path)
        .canonicalize()
        .map_err(err)?;
    let rel = project::validate_project_relative_path(&project.root_file).map_err(err)?;
    let rel = rel.to_string_lossy().into_owned();
    let entry = project::resolve_existing_project_path(&root, &rel).map_err(err)?;
    if !entry.exists() {
        return Err(format!("entry file not found: {}", entry.display()));
    }
    Ok((root, rel))
}

fn ensure_read_size(path: &Path, max_bytes: u64) -> CmdResult<()> {
    let len = std::fs::metadata(path).map_err(err)?.len();
    if len > max_bytes {
        Err(format!(
            "file is too large to read through IPC: {} bytes exceeds {}",
            len, max_bytes
        ))
    } else {
        Ok(())
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn detect_tex() -> EngineProbe {
    // Off the event-loop thread: probe() does up to seven blocking `which` +
    // `<engine> --version` spawns in series, which would otherwise freeze the
    // window during onboarding.
    tokio::task::spawn_blocking(detect::probe)
        .await
        .unwrap_or(EngineProbe {
            engines: Vec::new(),
            any_latex_available: false,
        })
}

#[tauri::command]
pub async fn list_projects(root: Option<String>) -> CmdResult<Vec<project::ProjectListing>> {
    let root = root
        .map(PathBuf::from)
        .unwrap_or_else(settings::default_projects_root);
    tokio::task::spawn_blocking(move || -> CmdResult<Vec<project::ProjectListing>> {
        ensure_under_projects_root(&root)?;
        let listings = project::list_project_listings(&root).map_err(err)?;
        for l in &listings {
            project::register_root(Path::new(&l.project.root_path));
        }
        Ok(listings)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn create_project(
    name: String,
    format: ProjectFormat,
    parent: Option<String>,
) -> CmdResult<Project> {
    let parent = parent
        .map(PathBuf::from)
        .unwrap_or_else(settings::default_projects_root);
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_under_projects_root(&parent)?;
        if !parent.exists() {
            std::fs::create_dir_all(&parent).map_err(err)?;
        }
        let project = project::create_project(&parent, &name, format).map_err(err)?;
        project::register_root(Path::new(&project.root_path));
        Ok(project)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn open_project(path: String) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered_or_under_projects_root(Path::new(&path))?;
        let project = project::read_project(Path::new(&path)).map_err(err)?;
        project::register_root(Path::new(&project.root_path));
        Ok(project)
    })
    .await
    .map_err(err)?
}

/// Write `.typeward/project.json` for an existing folder (e.g. a just-cloned
/// repo) so it shows up in the library and can be opened. Gated to the projects
/// area like `git_clone`. Returns the detected project.
#[tauri::command]
pub async fn import_project_folder(path: String) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        let root = PathBuf::from(&path);
        ensure_registered_or_under_projects_root(&root)?;
        let project = project::import_folder_as_project(&root, None).map_err(err)?;
        project::register_root(Path::new(&project.root_path));
        Ok(project)
    })
    .await
    .map_err(err)?
}

/// Replace the project's `integrations` block. Caller passes the
/// already-built struct; the file is read, the block is swapped, and
/// the file is rewritten atomically. No partial mutation API — keeping
/// the seam narrow makes it harder to land a half-updated project.json.
#[tauri::command]
pub async fn set_project_integrations(
    project_root: String,
    integrations: project::ProjectIntegrations,
) -> CmdResult<Project> {
    // Reads + atomically rewrites project.json (fs_ops::atomic_write fsyncs);
    // on the cloud-project bind path, so keep the fsync off the event-loop thread.
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::update_project_integrations(Path::new(&project_root), integrations).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Set or clear a project's deadline. `deadline` is a plain ISO date
/// (`YYYY-MM-DD`); `None` clears it. Shape is validated here so a malformed
/// value never lands in project.json.
#[tauri::command]
pub async fn set_project_deadline(
    project_root: String,
    deadline: Option<String>,
) -> CmdResult<Project> {
    let deadline = match deadline {
        Some(d) if is_iso_date(&d) => Some(d),
        Some(_) => return Err("deadline must be an ISO date (YYYY-MM-DD)".into()),
        None => None,
    };
    // Atomically rewrites project.json (fsync); keep it off the event-loop thread.
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_deadline(Path::new(&project_root), deadline).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Set a project's tags. Normalization (trim, dedupe, caps) is enforced in
/// `project::set_tags` so the invariant holds regardless of caller.
#[tauri::command]
pub async fn set_project_tags(project_root: String, tags: Vec<String>) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_tags(Path::new(&project_root), tags).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Assign the project to a space (`None` clears it). The space id references the
/// workspace spaces catalog in settings.json; it is not cross-checked here.
#[tauri::command]
pub async fn set_project_space(project_root: String, space: Option<String>) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_space(Path::new(&project_root), space).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Move a project to (or out of) the in-app soft-trash. `trashed = true` stamps
/// the current time (epoch ms); `false` clears it. The folder on disk is left
/// untouched — permanent removal goes through `delete_project`.
#[tauri::command]
pub async fn set_project_trashed(project_root: String, trashed: bool) -> CmdResult<Project> {
    let trashed_at = trashed.then(|| chrono::Utc::now().timestamp_millis());
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_trashed(Path::new(&project_root), trashed_at).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn set_project_archived(project_root: String, archived: bool) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_archived(Path::new(&project_root), archived).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Stamp the project's last-opened time (server-side clock). Fire-and-forget
/// from the frontend on every project open.
#[tauri::command]
pub async fn touch_project_opened(project_root: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        let now = chrono::Utc::now().timestamp_millis();
        project::touch_opened(Path::new(&project_root), now).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Rename a project's display name (folder path unchanged; see `project::rename`).
#[tauri::command]
pub async fn rename_project(project_root: String, name: String) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::rename(Path::new(&project_root), name).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Move a project to the OS trash. Recoverable, so the UI confirms with a plain
/// dialog. No registry unregister is needed — a trashed folder fails to
/// canonicalize and drops out of `is_registered_root` naturally.
#[tauri::command]
pub async fn delete_project(project_root: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        project::delete_project(Path::new(&project_root)).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Duplicate a project into a fresh sibling folder under the projects root.
#[tauri::command]
pub async fn duplicate_project(
    project_root: String,
    new_name: Option<String>,
) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        let source = Path::new(&project_root);
        // The copy lands as a child of the source's parent; validate that
        // parent is under the projects root *before* copying so the new folder
        // can't escape the projects area.
        let parent = source
            .parent()
            .ok_or_else(|| "project has no parent directory".to_string())?;
        ensure_under_projects_root(parent)?;
        let (dest, project) = project::duplicate_project(source, new_name).map_err(err)?;
        project::register_root(&dest);
        Ok(project)
    })
    .await
    .map_err(err)?
}

/// Set (or clear) the per-project LaTeX build config. Engine validation lives
/// in `project::set_build`.
#[tauri::command]
pub async fn set_project_build(
    project_root: String,
    build: Option<ProjectBuild>,
) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_build(Path::new(&project_root), build).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Repoint the project's entry file (root-file picker / rename-the-root-file
/// flow). Existence + extension-match + `write_project` revalidation live in
/// `project::set_root_file`.
#[tauri::command]
pub async fn set_project_root_file(project_root: String, rel_path: String) -> CmdResult<Project> {
    tokio::task::spawn_blocking(move || -> CmdResult<Project> {
        ensure_registered(&project_root)?;
        project::set_root_file(Path::new(&project_root), &rel_path).map_err(err)
    })
    .await
    .map_err(err)?
}

// ---------- File-tree operations (context menus) --------------------------
//
// Renderer-driven file ops (rename / delete / new dir / duplicate). Each gates
// on the opened-project registry, validates the project-relative path (the
// leading-dash guard included), and refuses the `.typeward` sidecar and `.git`
// repo as a first component so the renderer can't rewrite snapshots, the sync
// cursor, review comments, or VCS internals. The watcher picks the changes up
// automatically (fsVersion bump → FileTree + TODO scan refresh).

/// Reject a rel path whose first component is a protected sidecar/VCS dir.
/// Case-insensitive (Windows/macOS fold case) at the first segment — matching
/// the cloud engine's `.typeward` guard.
fn reject_protected_first_component(rel_path: &str) -> CmdResult<()> {
    let first = Path::new(rel_path).components().find_map(|c| match c {
        std::path::Component::Normal(p) => Some(p.to_string_lossy().to_ascii_lowercase()),
        _ => None,
    });
    if let Some(first) = first
        && (first == ".typeward" || first == ".git")
    {
        return Err(format!("cannot modify protected path: {rel_path}"));
    }
    Ok(())
}

/// Move `from_rel` to `to_rel` within the project. The source must exist and NOT
/// be a symlink (never follow a planted link); the destination must not already
/// exist (no silent overwrite). Pure/testable: the command wrapper adds the
/// registry gate.
fn rename_project_file_op(root: &Path, from_rel: &str, to_rel: &str) -> CmdResult<()> {
    reject_protected_first_component(from_rel)?;
    reject_protected_first_component(to_rel)?;
    // resolve_project_write_path canonicalizes only the parent, leaving the leaf
    // un-canonicalized so symlink_metadata below sees the link itself.
    let from = project::resolve_project_write_path(root, from_rel).map_err(err)?;
    let meta = std::fs::symlink_metadata(&from)
        .map_err(|_| format!("source does not exist: {from_rel}"))?;
    if meta.file_type().is_symlink() {
        return Err("refusing to rename a symlink".to_string());
    }
    let to = project::resolve_project_write_path(root, to_rel).map_err(err)?;
    if to.symlink_metadata().is_ok() {
        return Err(format!("destination already exists: {to_rel}"));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::rename(&from, &to).map_err(err)
}

#[tauri::command]
pub async fn rename_project_file(
    project_root: String,
    from_rel: String,
    to_rel: String,
) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        rename_project_file_op(Path::new(&project_root), &from_rel, &to_rel)
    })
    .await
    .map_err(err)?
}

/// Delete a project-relative file or directory. Uses the OS trash on desktop
/// (recoverable, so the UI confirms with a plain dialog) and a hard remove on
/// mobile — mirroring `project::delete_project`'s cfg split. A symlink leaf is
/// deleted as the link, never followed to its target.
fn delete_project_path_op(root: &Path, rel_path: &str) -> CmdResult<()> {
    reject_protected_first_component(rel_path)?;
    let target = project::resolve_project_write_path(root, rel_path).map_err(err)?;
    let meta = std::fs::symlink_metadata(&target)
        .map_err(|_| format!("path does not exist: {rel_path}"))?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = meta;
        trash::delete(&target).map_err(|e| e.to_string())
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        if meta.file_type().is_dir() {
            std::fs::remove_dir_all(&target).map_err(err)
        } else {
            std::fs::remove_file(&target).map_err(err)
        }
    }
}

#[tauri::command]
pub async fn delete_project_path(project_root: String, rel_path: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        delete_project_path_op(Path::new(&project_root), &rel_path)
    })
    .await
    .map_err(err)?
}

fn create_project_dir_op(root: &Path, rel_path: &str) -> CmdResult<()> {
    reject_protected_first_component(rel_path)?;
    let dir = project::resolve_project_write_path(root, rel_path).map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)
}

#[tauri::command]
pub async fn create_project_dir(project_root: String, rel_path: String) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        create_project_dir_op(Path::new(&project_root), &rel_path)
    })
    .await
    .map_err(err)?
}

/// Compute a "<stem> copy[.ext]" sibling rel path that doesn't yet exist,
/// escalating to "<stem> copy 2", "<stem> copy 3"… on collision. The existence
/// probe uses `symlink_metadata` so a planted symlink at the candidate name
/// still counts as taken.
fn duplicate_rel_name(root: &Path, rel_path: &str) -> CmdResult<String> {
    let rel = Path::new(rel_path);
    let stem = rel
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| format!("cannot duplicate: {rel_path}"))?;
    let ext = rel.extension().map(|s| s.to_string_lossy().into_owned());
    let parent = rel.parent();

    let make = |suffix: &str| -> String {
        let name = match &ext {
            Some(e) => format!("{stem}{suffix}.{e}"),
            None => format!("{stem}{suffix}"),
        };
        match parent {
            Some(p) if !p.as_os_str().is_empty() => {
                p.join(name).to_string_lossy().replace('\\', "/")
            }
            _ => name,
        }
    };

    let taken = |candidate: &str| root.join(candidate).symlink_metadata().is_ok();

    let first = make(" copy");
    if !taken(&first) {
        return Ok(first);
    }
    let mut n = 2;
    loop {
        let candidate = make(&format!(" copy {n}"));
        if !taken(&candidate) {
            return Ok(candidate);
        }
        n += 1;
    }
}

/// Duplicate a project-relative FILE (directories rejected in v1). Copies disk
/// content to a fresh "<name> copy.ext" sibling and returns the new rel path.
fn duplicate_project_file_op(root: &Path, rel_path: &str) -> CmdResult<String> {
    reject_protected_first_component(rel_path)?;
    let source = project::resolve_project_write_path(root, rel_path).map_err(err)?;
    let meta = std::fs::symlink_metadata(&source)
        .map_err(|_| format!("source does not exist: {rel_path}"))?;
    if meta.file_type().is_symlink() {
        return Err("refusing to duplicate a symlink".to_string());
    }
    if !meta.file_type().is_file() {
        return Err("only files can be duplicated".to_string());
    }
    let dest_rel = duplicate_rel_name(root, rel_path)?;
    let dest = project::resolve_project_write_path(root, &dest_rel).map_err(err)?;
    std::fs::copy(&source, &dest).map_err(err)?;
    Ok(dest_rel)
}

#[tauri::command]
pub async fn duplicate_project_file(project_root: String, rel_path: String) -> CmdResult<String> {
    tokio::task::spawn_blocking(move || -> CmdResult<String> {
        ensure_registered(&project_root)?;
        duplicate_project_file_op(Path::new(&project_root), &rel_path)
    })
    .await
    .map_err(err)?
}

const MAX_IMPORT_FILE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_IMPORT_FILES: usize = 100;

/// Join a (possibly empty = project root) rel dir with a leaf name using the
/// forward-slash convention the frontend uses for rel paths.
fn join_rel(dir_rel: &str, name: &str) -> String {
    if dir_rel.is_empty() {
        name.to_string()
    } else {
        format!("{dir_rel}/{name}")
    }
}

/// Normalize a renderer-supplied target directory: empty means the project
/// root; anything else passes the shared rel-path validator plus the
/// sidecar/VCS guard, and comes back slash-normalized for prefix comparisons.
fn normalize_target_dir(target_rel_dir: &str) -> CmdResult<String> {
    if target_rel_dir.trim().is_empty() {
        return Ok(String::new());
    }
    reject_protected_first_component(target_rel_dir)?;
    let rel = project::validate_project_relative_path(target_rel_dir).map_err(err)?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// First name that doesn't collide in `dir_rel`: "figure.png", then
/// "figure (2).png", "figure (3).png"… Existence probes use `symlink_metadata`
/// so a planted symlink at a candidate name still counts as taken.
fn collision_free_rel(root: &Path, dir_rel: &str, file_name: &str) -> String {
    let taken = |candidate: &str| root.join(candidate).symlink_metadata().is_ok();
    let first = join_rel(dir_rel, file_name);
    if !taken(&first) {
        return first;
    }
    let p = Path::new(file_name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| file_name.to_string());
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned());
    let mut n = 2;
    loop {
        let name = match &ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = join_rel(dir_rel, &name);
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Copy OS-absolute files (drag-drop / file picker) into a project directory.
/// This is the one place absolute source paths are legitimate: dropped/picked
/// paths live outside the fs plugin's runtime scope, so the copy must happen
/// here in Rust. Sources must be regular files (no symlinks, no directories —
/// never follow a planted link), size-capped; name collisions auto-suffix
/// " (2)" style. Returns the created rel paths.
fn import_files_op(
    root: &Path,
    target_rel_dir: &str,
    source_paths: &[String],
    source_allowed: &dyn Fn(&Path) -> bool,
) -> CmdResult<Vec<String>> {
    if source_paths.is_empty() {
        return Ok(Vec::new());
    }
    if source_paths.len() > MAX_IMPORT_FILES {
        return Err(format!(
            "too many files in one import (max {MAX_IMPORT_FILES})"
        ));
    }
    let dir_rel = normalize_target_dir(target_rel_dir)?;
    if !dir_rel.is_empty() {
        let dir = project::resolve_project_write_path(root, &dir_rel).map_err(err)?;
        if let Ok(meta) = dir.symlink_metadata() {
            if !meta.file_type().is_dir() {
                return Err(format!("target is not a directory: {dir_rel}"));
            }
        } else {
            std::fs::create_dir_all(&dir).map_err(err)?;
        }
    }
    // Two passes so the batch is all-or-nothing: a bad entry rejected AFTER
    // earlier copies would leave orphans in the project while the command —
    // and the toast built from it — reports total failure.
    let mut planned: Vec<(&Path, String, std::path::PathBuf)> =
        Vec::with_capacity(source_paths.len());
    for source in source_paths {
        let src = Path::new(source);
        if !src.is_absolute() {
            return Err(format!("import source must be an absolute path: {source}"));
        }
        let meta = std::fs::symlink_metadata(src)
            .map_err(|_| format!("source does not exist: {source}"))?;
        if meta.file_type().is_symlink() {
            return Err(format!("refusing to import a symlink: {source}"));
        }
        if !meta.file_type().is_file() {
            return Err(format!(
                "only files can be imported (drop files, not folders): {source}"
            ));
        }
        if meta.len() > MAX_IMPORT_FILE_BYTES {
            return Err(format!(
                "file is too large to import (over {} MB): {source}",
                MAX_IMPORT_FILE_BYTES / (1024 * 1024)
            ));
        }
        // The user must have designated this exact file, either by dropping it
        // on the window (recorded backend-side) or by picking it in a dialog
        // (which adds it to the fs runtime scope). Without this the command is
        // an arbitrary-read primitive: a compromised webview could name any
        // path, have it copied into the project, and read it back through the
        // project IPC.
        if !source_allowed(src) {
            return Err(format!(
                "import source was not drag-dropped or picked in a dialog: {source}"
            ));
        }
        let name = src
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| format!("source has no usable file name: {source}"))?;
        // Re-validate the composed rel path: a dropped file literally named
        // like a CLI flag ("-shell-escape.tex") or a sidecar dir must not land
        // in the project, where it could later flow into a compile command line.
        let rel = collision_free_rel(root, &dir_rel, name);
        // collision_free_rel consults the disk, so two same-named sources in
        // ONE batch would both claim the same destination.
        if planned.iter().any(|(_, r, _)| r == &rel) {
            return Err(format!(
                "two files in this import share the name {name} — add them separately"
            ));
        }
        reject_protected_first_component(&rel)?;
        project::validate_project_relative_path(&rel).map_err(err)?;
        let dest = project::resolve_project_write_path(root, &rel).map_err(err)?;
        planned.push((src, rel, dest));
    }
    let mut created = Vec::with_capacity(planned.len());
    for (src, rel, dest) in planned {
        std::fs::copy(src, &dest).map_err(err)?;
        created.push(rel);
    }
    Ok(created)
}

/// A source path the user designated: dropped on the window (recorded in
/// `drop_allow` from the backend's own drag-drop event) or picked in a file
/// dialog (the dialog plugin adds each picked path to plugin-fs's runtime
/// scope). Either proves a real user gesture the renderer cannot fabricate.
fn user_designated_source(app: &tauri::AppHandle, path: &Path) -> bool {
    use tauri_plugin_fs::FsExt;
    crate::drop_allow::is_allowed(path)
        || app
            .try_fs_scope()
            .map(|scope| scope.is_allowed(path))
            .unwrap_or(false)
}

#[tauri::command]
pub async fn import_files_into_project(
    app: tauri::AppHandle,
    project_root: String,
    target_rel_dir: String,
    source_paths: Vec<String>,
) -> CmdResult<Vec<String>> {
    tokio::task::spawn_blocking(move || -> CmdResult<Vec<String>> {
        ensure_registered(&project_root)?;
        import_files_op(
            Path::new(&project_root),
            &target_rel_dir,
            &source_paths,
            &|path| user_designated_source(&app, path),
        )
    })
    .await
    .map_err(err)?
}

/// Move a project-relative file OR directory into another project directory
/// (`""` = the project root), keeping the leaf name. Refuses to overwrite an
/// existing target, never follows a symlink leaf, and rejects moving a
/// directory into its own subtree. Returns the new rel path.
fn move_project_path_op(root: &Path, from_rel: &str, to_rel_dir: &str) -> CmdResult<String> {
    reject_protected_first_component(from_rel)?;
    let from_norm = project::validate_project_relative_path(from_rel)
        .map_err(err)?
        .to_string_lossy()
        .replace('\\', "/");
    let dir_rel = normalize_target_dir(to_rel_dir)?;
    let from = project::resolve_project_write_path(root, &from_norm).map_err(err)?;
    let meta = std::fs::symlink_metadata(&from)
        .map_err(|_| format!("source does not exist: {from_rel}"))?;
    if meta.file_type().is_symlink() {
        return Err("refusing to move a symlink".to_string());
    }
    if meta.file_type().is_dir()
        && (dir_rel == from_norm || dir_rel.starts_with(&format!("{from_norm}/")))
    {
        return Err("cannot move a folder into itself".to_string());
    }
    let name = Path::new(&from_norm)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("cannot move: {from_rel}"))?;
    let to_rel = join_rel(&dir_rel, name);
    if to_rel == from_norm {
        return Err("source is already in that folder".to_string());
    }
    let to = project::resolve_project_write_path(root, &to_rel).map_err(err)?;
    if to.symlink_metadata().is_ok() {
        return Err(format!("destination already exists: {to_rel}"));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    std::fs::rename(&from, &to).map_err(err)?;
    Ok(to_rel)
}

#[tauri::command]
pub async fn move_project_path(
    project_root: String,
    from_rel: String,
    to_rel_dir: String,
) -> CmdResult<String> {
    tokio::task::spawn_blocking(move || -> CmdResult<String> {
        ensure_registered(&project_root)?;
        move_project_path_op(Path::new(&project_root), &from_rel, &to_rel_dir)
    })
    .await
    .map_err(err)?
}

/// Reveal a project-relative file in the OS file manager (Finder/Explorer).
/// Unlike the raw `opener` plugin's reveal command — which took an unscoped
/// absolute path straight from the renderer — this gates on the opened-project
/// registry and resolves the path under the canonical root, so webview XSS
/// can't reveal `~/.ssh` or any path outside an opened project.
#[tauri::command]
pub async fn reveal_project_path(
    app: tauri::AppHandle,
    project_root: String,
    rel_path: String,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        reject_protected_first_component(&rel_path)?;
        let abs = project::resolve_existing_project_path(Path::new(&project_root), &rel_path)
            .map_err(err)?;
        app.opener().reveal_item_in_dir(abs).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Cheap `YYYY-MM-DD` shape check (digits + dashes, plausible ranges). Not a
/// full calendar validation — just enough to keep junk out of project.json.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| b[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let month: u8 = s[5..7].parse().unwrap_or(0);
    let day: u8 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

#[tauri::command]
pub async fn read_project_text_file(project_root: String, rel_path: String) -> CmdResult<String> {
    tokio::task::spawn_blocking(move || -> CmdResult<String> {
        ensure_registered(&project_root)?;
        let path = project::resolve_existing_project_path(Path::new(&project_root), &rel_path)
            .map_err(err)?;
        ensure_read_size(&path, MAX_PROJECT_TEXT_READ_BYTES)?;
        fs_ops::read_text(&path).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Read raw bytes for a project-relative file. Used by the WASM
/// CompileProvider to pull binary figure assets (.png/.jpg/.pdf) into
/// the WASM in-memory FS so `\includegraphics{...}` resolves.
///
/// Returns a raw [`tauri::ipc::Response`] (ArrayBuffer on the JS side) rather
/// than `Vec<u8>`: a serde `Vec<u8>` crosses the bridge as a JSON number array
/// (~3-4 ASCII chars/byte, held simultaneously as Rust Vec + JSON + JS array),
/// which the mobile compile asset walk pays per figure. The raw body skips JSON
/// entirely.
#[tauri::command]
pub async fn read_project_binary_file(
    project_root: String,
    rel_path: String,
) -> CmdResult<tauri::ipc::Response> {
    let bytes = tokio::task::spawn_blocking(move || -> CmdResult<Vec<u8>> {
        ensure_registered(&project_root)?;
        let path = project::resolve_existing_project_path(Path::new(&project_root), &rel_path)
            .map_err(err)?;
        ensure_read_size(&path, MAX_PROJECT_BINARY_READ_BYTES)?;
        std::fs::read(&path).map_err(err)
    })
    .await
    .map_err(err)??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn write_project_text_file(
    project_root: String,
    rel_path: String,
    content: String,
) -> CmdResult<()> {
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        let path = project::resolve_project_write_path(Path::new(&project_root), &rel_path)
            .map_err(err)?;
        fs_ops::write_text(&path, &content).map_err(err)
    })
    .await
    .map_err(err)?
}

/// Persist binary bytes (e.g. a PDF emitted by the WASM engine)
/// to the given absolute path. Bypasses the fs plugin scope like the
/// rest of our project-internal IO. Parent directories are created on
/// demand so callers don't need a separate mkdir step.
///
/// Takes a raw [`tauri::ipc::Request`] (the bytes arrive as the ArrayBuffer
/// body, not a JSON number array — see `read_project_binary_file`); the project
/// root and relative path ride along as percent-encoded headers.
#[tauri::command]
pub async fn write_project_binary_file(request: tauri::ipc::Request<'_>) -> CmdResult<()> {
    use crate::integrations::ipc;
    let bytes = ipc::raw_body_required(&request)?;
    let project_root = ipc::decode_header(&request, "x-project-root")?;
    let rel_path = ipc::decode_header(&request, "x-rel-path")?;
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        let path = project::resolve_project_write_path(Path::new(&project_root), &rel_path)
            .map_err(err)?;
        if let Some(parent) = path.parent()
            && !parent.exists()
        {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
        // Refuse to write through an existing symlink: a malicious cloned repo or
        // extracted zip can plant a symlink at a project-relative path so a later
        // binary write (e.g. the WASM engine's PDF) lands outside the project root.
        // `resolve_project_write_path` only canonicalizes the parent, so the leaf
        // is checked here. The text path is already safe via atomic temp+rename.
        if let Ok(meta) = std::fs::symlink_metadata(&path)
            && meta.file_type().is_symlink()
        {
            return Err("refusing to write through a symlink".to_string());
        }
        std::fs::write(path, &bytes).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> CmdResult<Settings> {
    tokio::task::spawn_blocking(move || settings::load(&app).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, settings: Settings) -> CmdResult<()> {
    // Runs on a debounce while the user drags sliders/toggles — the write plus
    // create_dir_all must not hitch the event-loop thread.
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        // The renderer's payload has no `compile` key, so backend-owned values
        // are carried forward rather than reset on every settings write. The
        // carry-forward read and the write share one lock, so a concurrent
        // backend write (e.g. the avatar IPC) can't land in between and be lost.
        let mut settings = settings;
        settings::save_preserving_backend_owned(&app, &mut settings).map_err(err)?;
        // Keep the clone-destination boundary in sync when the user moves their
        // projects root. (File IO is gated by the opened-project registry, which
        // this does not affect.)
        let root = PathBuf::from(&settings.projects_root);
        let _ = std::fs::create_dir_all(&root);
        project::set_projects_root(&root);
        // ...and the two boundaries seeded from settings at startup: plugin-fs's
        // runtime path scope and the loopback port the local AI daemon is on.
        crate::grant_projects_root_fs_scope(&app, &root);
        crate::integrations::http::set_local_ai_base_url(
            settings.integrations.ai.ollama_base_url.as_deref(),
        );
        Ok(())
    })
    .await
    .map_err(err)?
}

/// Settings → Security → "Reset local app data". Overwrites settings.json
/// with the defaults; the frontend clears localStorage and reloads. Project
/// files on disk are untouched.
#[tauri::command]
pub async fn reset_settings(app: tauri::AppHandle) -> CmdResult<()> {
    // Writes settings.json (fsync); keep it off the event-loop thread like save_settings.
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        settings::save(&app, &Settings::default()).map_err(err)?;
        // The defaults clear `profile.avatarPath`, which leaves the copied image
        // itself unreferenced in app data — reset has to drop the file too.
        crate::profile::clear_stored_avatar_files(&app)?;
        project::set_projects_root(&settings::default_projects_root());
        Ok(())
    })
    .await
    .map_err(err)?
}

/// Zip the project sources for sharing. Reuses the template-capture walk
/// (skips `.git`/`.typeward`/`node_modules`, symlinks, LaTeX build junk) and
/// writes into the project's own sidecar so no new arbitrary-destination
/// write primitive is added — the frontend copies the bundle to the user's
/// chosen location through the dialog-scoped fs plugin.
#[tauri::command]
pub async fn export_project_zip(project: Project) -> CmdResult<String> {
    let (root, _) = checked_project_root_and_file(&project)?;
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let files = crate::integrations::templates::collect_project_files(&root)
            .map_err(|e| e.to_string())?;
        let dest_dir = root.join(".typeward").join("build");
        std::fs::create_dir_all(&dest_dir).map_err(err)?;
        let dest = dest_dir.join("source-bundle.zip");
        let file = std::fs::File::create(&dest).map_err(err)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for abs in files {
            let rel = abs
                .strip_prefix(&root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(rel, options).map_err(err)?;
            let mut input = std::fs::File::open(&abs).map_err(err)?;
            std::io::copy(&mut input, &mut zip).map_err(err)?;
        }
        zip.finish().map_err(err)?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(err)?
}

// ---------- Autosave / crash recovery -------------------------------------

#[tauri::command]
pub async fn write_snapshot(
    project_root: String,
    rel_path: String,
    content: String,
) -> CmdResult<()> {
    // Autosave fires on a 500ms debounce while typing and atomic_write does a
    // full fsync; keep that off the event-loop thread so it never hitches typing.
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        autosave::write(Path::new(&project_root), &rel_path, &content).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn clear_snapshot(project_root: String, rel_path: String) -> CmdResult<()> {
    // Fires on every save; the unlink must not run on the event-loop thread.
    tokio::task::spawn_blocking(move || -> CmdResult<()> {
        ensure_registered(&project_root)?;
        autosave::clear(Path::new(&project_root), &rel_path).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn list_orphan_snapshots(project_root: String) -> CmdResult<Vec<Snapshot>> {
    // Walks the snapshots dir and reads every .snap on project open.
    tokio::task::spawn_blocking(move || -> CmdResult<Vec<Snapshot>> {
        ensure_registered(&project_root)?;
        autosave::list_orphans(Path::new(&project_root)).map_err(err)
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut dir = std::env::temp_dir();
        dir.push(format!("typeward-cmd-test-{}-{}", std::process::id(), id));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reject_protected_first_component_matrix() {
        // First-component sidecar/VCS dirs are rejected, case-insensitively.
        for bad in [
            ".typeward/project.json",
            ".git/config",
            ".Typeward/x",
            ".GIT/hooks/pre-commit",
        ] {
            assert!(
                reject_protected_first_component(bad).is_err(),
                "{bad} should be rejected"
            );
        }
        // A nested `.typeward` beyond the first segment is not this guard's job
        // (validate_project_relative_path handles traversal); ordinary paths pass.
        for ok in ["sections/intro.tex", "figures/plot.png", "notes.md"] {
            assert!(
                reject_protected_first_component(ok).is_ok(),
                "{ok} should pass"
            );
        }
    }

    #[test]
    fn file_ops_reject_traversal_absolute_and_dash_paths() {
        let root = temp_dir();
        for bad in [
            "../outside.tex",
            "sections/../../evil.tex",
            "-shell-escape.tex",
        ] {
            assert!(
                create_project_dir_op(&root, bad).is_err(),
                "{bad} rejected by mkdir"
            );
            assert!(
                rename_project_file_op(&root, "main.tex", bad).is_err(),
                "{bad} rejected as rename dest"
            );
        }
    }

    #[test]
    fn rename_rejects_missing_source_and_existing_dest() {
        let root = temp_dir();
        std::fs::write(root.join("a.tex"), "A").unwrap();
        std::fs::write(root.join("b.tex"), "B").unwrap();

        // Missing source.
        assert!(rename_project_file_op(&root, "ghost.tex", "c.tex").is_err());
        // Dest already exists — no silent overwrite.
        assert!(rename_project_file_op(&root, "a.tex", "b.tex").is_err());
        // Clean rename into a fresh nested dir works (parent created).
        rename_project_file_op(&root, "a.tex", "chapters/a.tex").unwrap();
        assert!(root.join("chapters").join("a.tex").exists());
        assert!(!root.join("a.tex").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rename_and_duplicate_reject_symlink_source() {
        use std::os::unix::fs::symlink;
        let root = temp_dir();
        std::fs::write(root.join("real.tex"), "R").unwrap();
        symlink(root.join("real.tex"), root.join("link.tex")).unwrap();

        assert!(
            rename_project_file_op(&root, "link.tex", "moved.tex")
                .unwrap_err()
                .contains("symlink")
        );
        assert!(
            duplicate_project_file_op(&root, "link.tex")
                .unwrap_err()
                .contains("symlink")
        );
        // The real file behind the link is untouched.
        assert!(root.join("real.tex").exists());
        assert!(root.join("link.tex").exists());
    }

    #[test]
    fn duplicate_naming_escalates_on_collision() {
        let root = temp_dir();
        std::fs::write(root.join("note.tex"), "N").unwrap();
        assert_eq!(
            duplicate_rel_name(&root, "note.tex").unwrap(),
            "note copy.tex"
        );

        // End-to-end duplicate, then a second duplicate escalates the suffix.
        let first = duplicate_project_file_op(&root, "note.tex").unwrap();
        assert_eq!(first, "note copy.tex");
        assert!(root.join("note copy.tex").exists());
        let second = duplicate_project_file_op(&root, "note.tex").unwrap();
        assert_eq!(second, "note copy 2.tex");

        // Nested path keeps its directory and handles an extension-less file.
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("d").join("README"), "x").unwrap();
        assert_eq!(
            duplicate_rel_name(&root, "d/README").unwrap(),
            "d/README copy"
        );
    }

    #[test]
    fn duplicate_rejects_directories() {
        let root = temp_dir();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        assert!(
            duplicate_project_file_op(&root, "sub")
                .unwrap_err()
                .contains("only files")
        );
    }

    #[test]
    fn delete_rejects_protected_and_missing_before_trashing() {
        let root = temp_dir();
        // Protected first component is refused before any filesystem action.
        assert!(delete_project_path_op(&root, ".typeward/snapshots/x.snap").is_err());
        // A non-existent leaf errors rather than reaching the trash call.
        assert!(delete_project_path_op(&root, "ghost.tex").is_err());
    }

    #[test]
    fn create_project_dir_op_makes_nested_dirs() {
        let root = temp_dir();
        create_project_dir_op(&root, "chapters/appendix").unwrap();
        assert!(root.join("chapters").join("appendix").is_dir());
    }

    #[test]
    fn rename_moves_directories_too() {
        // The frontend rename flow now offers directories; lock the op's
        // directory support so a future file-only guard can't regress it.
        let root = temp_dir();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("chapters").join("a.tex"), "A").unwrap();
        rename_project_file_op(&root, "chapters", "parts").unwrap();
        assert!(root.join("parts").join("a.tex").exists());
        assert!(!root.join("chapters").exists());
    }

    /// Stands in for the drop-allowlist / fs-scope check in tests that are
    /// exercising the path handling rather than the designation gate.
    fn any_source(_: &Path) -> bool {
        true
    }

    #[test]
    fn import_copies_and_suffixes_collisions() {
        let root = temp_dir();
        let outside = temp_dir();
        std::fs::write(outside.join("fig.png"), b"png").unwrap();
        let src = outside.join("fig.png").to_string_lossy().into_owned();

        let first = import_files_op(&root, "", std::slice::from_ref(&src), &any_source).unwrap();
        assert_eq!(first, vec!["fig.png".to_string()]);
        // Into a not-yet-existing subdir (created on demand).
        let second =
            import_files_op(&root, "assets", std::slice::from_ref(&src), &any_source).unwrap();
        assert_eq!(second, vec!["assets/fig.png".to_string()]);
        // Collision auto-suffixes " (2)" before the extension.
        let third = import_files_op(&root, "assets", &[src], &any_source).unwrap();
        assert_eq!(third, vec!["assets/fig (2).png".to_string()]);
        assert!(root.join("assets").join("fig (2).png").exists());
    }

    #[test]
    fn import_rejects_a_source_the_user_never_designated() {
        // The arbitrary-read primitive: a compromised renderer names a path
        // the user never dropped or picked, has it copied into the project,
        // then reads it back through the project IPC.
        let root = temp_dir();
        let outside = temp_dir();
        std::fs::write(outside.join("id_rsa"), b"PRIVATE KEY").unwrap();
        let src = outside.join("id_rsa").to_string_lossy().into_owned();

        let err = import_files_op(&root, "", &[src], &|_| false).unwrap_err();

        assert!(err.contains("was not drag-dropped"), "got: {err}");
        assert!(!root.join("id_rsa").exists());
    }

    #[test]
    fn import_rejects_dirs_relative_sources_and_unsafe_names() {
        let root = temp_dir();
        let outside = temp_dir();
        // A directory source is refused.
        assert!(
            import_files_op(
                &root,
                "",
                &[outside.to_string_lossy().into_owned()],
                &any_source
            )
            .unwrap_err()
            .contains("only files")
        );
        // Relative source paths never come from the drop/dialog surfaces.
        assert!(import_files_op(&root, "", &["fig.png".into()], &any_source).is_err());
        // A file literally named like a CLI flag can't land in the project.
        std::fs::write(outside.join("-flag.tex"), "x").unwrap();
        assert!(
            import_files_op(
                &root,
                "",
                &[outside.join("-flag.tex").to_string_lossy().into_owned()],
                &any_source
            )
            .is_err()
        );
        // Protected target dirs are refused.
        std::fs::write(outside.join("ok.tex"), "x").unwrap();
        let ok_src = outside.join("ok.tex").to_string_lossy().into_owned();
        assert!(
            import_files_op(
                &root,
                ".typeward",
                std::slice::from_ref(&ok_src),
                &any_source
            )
            .is_err()
        );
        // Traversal in the target dir is refused.
        assert!(import_files_op(&root, "../outside", &[ok_src], &any_source).is_err());
    }

    #[test]
    fn move_relocates_files_and_dirs_with_guards() {
        let root = temp_dir();
        std::fs::create_dir_all(root.join("chapters").join("sub")).unwrap();
        std::fs::write(root.join("a.tex"), "A").unwrap();
        std::fs::write(root.join("chapters").join("b.tex"), "B").unwrap();

        // File into a dir keeps the leaf name.
        assert_eq!(
            move_project_path_op(&root, "a.tex", "chapters").unwrap(),
            "chapters/a.tex"
        );
        assert!(root.join("chapters").join("a.tex").exists());
        assert!(!root.join("a.tex").exists());
        // Moving into the folder it's already in is refused.
        assert!(move_project_path_op(&root, "chapters/a.tex", "chapters").is_err());
        // An existing target is never overwritten.
        std::fs::write(root.join("b.tex"), "B2").unwrap();
        assert!(
            move_project_path_op(&root, "b.tex", "chapters")
                .unwrap_err()
                .contains("already exists")
        );
        // A directory can't move into its own subtree.
        assert!(
            move_project_path_op(&root, "chapters", "chapters/sub")
                .unwrap_err()
                .contains("into itself")
        );
        // A directory move works and carries its contents.
        std::fs::create_dir_all(root.join("dest")).unwrap();
        assert_eq!(
            move_project_path_op(&root, "chapters", "dest").unwrap(),
            "dest/chapters"
        );
        assert!(root.join("dest").join("chapters").join("b.tex").exists());
        // Protected paths are refused on either side.
        assert!(move_project_path_op(&root, ".typeward/project.json", "dest").is_err());
        assert!(move_project_path_op(&root, "b.tex", ".git").is_err());
    }
}
