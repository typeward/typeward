//! Overleaf import — zip + git-bridge.
//!
//! Two paths:
//!   1. **Zip**: free-tier Overleaf users export their project as `.zip`.
//!      We unzip into the projects root and create a Typeward project
//!      shell pointing at the discovered root file. This is the only
//!      path that needs a dedicated IPC here.
//!   2. **Git bridge** (premium): users clone
//!      `https://git.overleaf.com/<projectId>` via the existing
//!      `git_clone` command, supplying their Overleaf email + a
//!      project-specific token via the standard keyring slot
//!      `git.git.overleaf.com`. No extra Rust code needed.
//!
//! The unzipper rejects entries whose normalized path escapes the
//! destination (zip-slip guard) so a malicious zip can't write outside
//! its target folder.

use std::fs;
use std::io;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use thiserror::Error;
use zip::ZipArchive;

use crate::project::{self, Project, ProjectFormat, ProjectIntegrations};

#[derive(Debug, Error, Serialize)]
pub enum OverleafError {
    #[error("io error: {0}")]
    Io(String),
    #[error("zip error: {0}")]
    Zip(String),
    #[error("destination already exists: {0}")]
    AlreadyExists(String),
    #[error("zip entry path is unsafe (escapes dest): {0}")]
    UnsafeEntry(String),
    #[error("no .tex or .typ file found in the zip — is this an Overleaf export?")]
    NoRootFile,
    #[error("zip archive exceeds the import limit (decompression bomb guard)")]
    TooLarge,
    #[error("project metadata write failed: {0}")]
    ProjectError(String),
}

impl From<io::Error> for OverleafError {
    fn from(value: io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<zip::result::ZipError> for OverleafError {
    fn from(value: zip::result::ZipError) -> Self {
        Self::Zip(value.to_string())
    }
}

impl From<project::ProjectError> for OverleafError {
    fn from(value: project::ProjectError) -> Self {
        Self::ProjectError(value.to_string())
    }
}

#[tauri::command]
pub async fn overleaf_import_zip(
    zip_path: String,
    parent_dir: String,
    name: String,
) -> Result<Project, OverleafError> {
    tokio::task::spawn_blocking(move || -> Result<Project, OverleafError> {
        let parent = PathBuf::from(&parent_dir);
        let safe_name = sanitize(&name);
        let dest = parent.join(&safe_name);
        if dest.exists() {
            return Err(OverleafError::AlreadyExists(dest.to_string_lossy().into()));
        }
        fs::create_dir_all(&dest)?;

        extract_zip(Path::new(&zip_path), &dest)?;

        let (root_file, format) = discover_root_file(&dest)?;

        let project = Project {
            root_path: dest.to_string_lossy().to_string(),
            root_file,
            format,
            name,
            integrations: ProjectIntegrations::default(),
        };
        project::write_project(&project)?;
        Ok(project)
    })
    .await
    .map_err(|e| OverleafError::Io(format!("background task failed: {e}")))?
}

// Decompression-bomb guards: a malicious Overleaf export can claim a small
// compressed size while expanding to gigabytes. Cap total entries and total
// uncompressed bytes written.
const MAX_ZIP_ENTRIES: usize = 5_000;
const MAX_ZIP_TOTAL_BYTES: u64 = 500 * 1024 * 1024;

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), OverleafError> {
    let file = fs::File::open(zip_path)?;
    let mut archive = ZipArchive::new(file)?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(OverleafError::TooLarge);
    }

    let mut total_written: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let raw_name = entry
            .enclosed_name()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| OverleafError::UnsafeEntry(entry.name().to_string()))?;
        let safe = sanitize_relative(&raw_name)
            .ok_or_else(|| OverleafError::UnsafeEntry(entry.name().to_string()))?;
        let out_path = dest.join(&safe);

        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Bound the copy by the remaining byte budget so `io::copy` can't be
        // tricked into writing the whole bomb before we notice.
        let remaining = MAX_ZIP_TOTAL_BYTES.saturating_sub(total_written);
        let mut out_file = fs::File::create(&out_path)?;
        let written = io::copy(&mut entry.by_ref().take(remaining + 1), &mut out_file)?;
        total_written = total_written.saturating_add(written);
        if total_written > MAX_ZIP_TOTAL_BYTES {
            return Err(OverleafError::TooLarge);
        }
    }
    Ok(())
}

/// Reject `..`, absolute paths, drive prefixes, and root components.
/// Returns the normalized relative path on success.
fn sanitize_relative(input: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in input.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return None;
            }
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn sanitize(name: &str) -> String {
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

fn discover_root_file(dest: &Path) -> Result<(String, ProjectFormat), OverleafError> {
    // Prefer `main.tex` at the project root; then any `.tex`; then
    // any `.typ`. Overleaf projects are almost always LaTeX so the
    // search is heavily TeX-biased.
    if dest.join("main.tex").exists() {
        return Ok(("main.tex".into(), ProjectFormat::Latex));
    }
    if let Some(found) = find_by_ext(dest, "tex")? {
        return Ok((found, ProjectFormat::Latex));
    }
    if let Some(found) = find_by_ext(dest, "typ")? {
        return Ok((found, ProjectFormat::Typst));
    }
    Err(OverleafError::NoRootFile)
}

fn find_by_ext(dir: &Path, ext: &str) -> Result<Option<String>, OverleafError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) == Some(ext) {
            if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                return Ok(Some(name.to_string()));
            }
        }
    }
    Ok(None)
}
