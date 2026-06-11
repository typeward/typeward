use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::fs_ops;

/// Mirrors the TypeScript `Project` type in src/adapters/types.ts. Persisted
/// at `<rootPath>/.typeward/project.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Absolute folder path.
    #[serde(rename = "rootPath")]
    pub root_path: String,
    /// Entry file relative to rootPath, e.g. "main.tex".
    #[serde(rename = "rootFile")]
    pub root_file: String,
    pub format: ProjectFormat,
    pub name: String,
    /// Per-project integration state (cloud origin, git binding, reference
    /// library binding). Optional / additive — older project.json files
    /// without this block load with `ProjectIntegrations::default()`.
    #[serde(default)]
    pub integrations: ProjectIntegrations,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectIntegrations {
    #[serde(
        rename = "cloudOrigin",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub cloud_origin: Option<CloudOrigin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git: Option<GitState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<ReferenceBinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudOrigin {
    pub provider: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "remotePath")]
    pub remote_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitState {
    pub remote: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceBinding {
    pub provider: String,
    #[serde(
        rename = "collectionId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
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
}

const SIDECAR_DIR: &str = ".typeward";
const PROJECT_JSON: &str = "project.json";

pub fn sidecar_dir(root: &Path) -> PathBuf {
    root.join(SIDECAR_DIR)
}

pub fn project_json_path(root: &Path) -> PathBuf {
    sidecar_dir(root).join(PROJECT_JSON)
}

/// Read project metadata from `<root>/.typeward/project.json`.
pub fn read_project(root: &Path) -> Result<Project, ProjectError> {
    let path = project_json_path(root);
    let bytes = fs::read(path)?;
    let mut project: Project = serde_json::from_slice(&bytes)?;
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
    let json = serde_json::to_vec_pretty(project)?;
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
}
