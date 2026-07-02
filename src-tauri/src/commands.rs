use std::path::{Path, PathBuf};

use crate::autosave::{self, Snapshot};
#[cfg(desktop)]
use crate::detect::{self, EngineProbe};
use crate::fs_ops;
use crate::project::{self, Project, ProjectFormat};
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
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
        }
        // Refuse to write through an existing symlink: a malicious cloned repo or
        // extracted zip can plant a symlink at a project-relative path so a later
        // binary write (e.g. the WASM engine's PDF) lands outside the project root.
        // `resolve_project_write_path` only canonicalizes the parent, so the leaf
        // is checked here. The text path is already safe via atomic temp+rename.
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if meta.file_type().is_symlink() {
                return Err("refusing to write through a symlink".to_string());
            }
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
        settings::save(&app, &settings).map_err(err)?;
        // Keep the clone-destination boundary in sync when the user moves their
        // projects root. (File IO is gated by the opened-project registry, which
        // this does not affect.)
        let root = PathBuf::from(&settings.projects_root);
        let _ = std::fs::create_dir_all(&root);
        project::set_projects_root(&root);
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
