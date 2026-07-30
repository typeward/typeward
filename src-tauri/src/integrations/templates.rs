//! Project templates (built-in + user custom).
//!
//! Built-in templates live under `src-tauri/resources/templates/`
//! (declared in `tauri.conf.json` so they ship with the bundle).
//! User custom templates live under `<app_data>/templates/custom/`.
//!
//! Each template is a directory with:
//!   - `template.json` (the manifest below)
//!   - the actual project files (LaTeX / Typst sources, .bib, etc.)
//!
//! At instantiate time, files marked `template: true` go through
//! Handlebars-subset `{{varname}}` substitution. Everything else is
//! copied verbatim — keeps `.cls` files and binary assets safe from
//! accidental token expansion.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use thiserror::Error;

use crate::project::{self, Project, ProjectFormat};

#[derive(Debug, Error, Serialize)]
pub enum TemplateError {
    #[error("io error: {0}")]
    Io(String),
    #[error("json error: {0}")]
    Json(String),
    #[error("template '{0}' not found")]
    NotFound(String),
    #[error("destination already exists: {0}")]
    AlreadyExists(String),
    #[error("template entry path escapes destination: {0}")]
    UnsafePath(String),
    #[error("could not resolve {0}")]
    BadPath(String),
    #[error("project metadata write failed: {0}")]
    ProjectError(String),
}

impl From<std::io::Error> for TemplateError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}
impl From<serde_json::Error> for TemplateError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value.to_string())
    }
}
impl From<project::ProjectError> for TemplateError {
    fn from(value: project::ProjectError) -> Self {
        Self::ProjectError(value.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVariable {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub multiline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateFile {
    pub path: String,
    /// Whether to run `{{var}}` substitution. Defaults to false.
    #[serde(default)]
    pub template: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateManifestDoc {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub format: ProjectFormat,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    pub root_file: String,
    #[serde(default)]
    pub variables: Vec<TemplateVariable>,
    #[serde(default)]
    pub files: Vec<TemplateFile>,
    /// Optional entitlement key (Phase 0 stub approves everything).
    #[serde(default)]
    pub entitlement: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateSource {
    Builtin,
    Custom,
}

/// What the IPC returns — manifest doc plus where it came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateManifest {
    #[serde(flatten)]
    pub doc: TemplateManifestDoc,
    pub source: TemplateSource,
}

#[tauri::command]
pub async fn templates_list(app: AppHandle) -> Result<Vec<TemplateManifest>, String> {
    let builtin_root = builtin_root(&app).map_err(|e| e.to_string())?;
    let custom_root = custom_root(&app).map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || -> Result<Vec<TemplateManifest>, TemplateError> {
        let mut out = Vec::new();
        scan_root(&builtin_root, TemplateSource::Builtin, &mut out)?;
        if custom_root.exists() {
            scan_root(&custom_root, TemplateSource::Custom, &mut out)?;
        }
        out.sort_by_key(|a| a.doc.name.to_lowercase());
        Ok(out)
    })
    .await
    // Commands reject with a plain Display string (the IPC error contract); a
    // serialized enum would surface as a variant name or raw JSON in the UI.
    .map_err(|e| format!("background task failed: {e}"))?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn template_instantiate(
    app: AppHandle,
    template_id: String,
    dest_parent: String,
    name: String,
    vars: HashMap<String, String>,
) -> Result<Project, String> {
    let builtin_root = builtin_root(&app).map_err(|e| e.to_string())?;
    let custom_root = custom_root(&app).map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || -> Result<Project, TemplateError> {
        let source = locate_template(&template_id, &builtin_root, &custom_root)?;
        let manifest = read_manifest(&source.dir)?;

        let parent = PathBuf::from(&dest_parent);
        let safe_name = sanitize(&name);
        if safe_name.is_empty() {
            return Err(TemplateError::BadPath(
                "project name produced an empty folder name".into(),
            ));
        }
        let dest = parent.join(&safe_name);
        // Gate the renderer-supplied destination to the projects root, as
        // create_project does — keeps template materialization inside the
        // sandbox even if the webview is compromised.
        if !project::is_new_path_under_projects_root(&dest) {
            return Err(TemplateError::BadPath(format!(
                "destination is outside the configured projects root: {}",
                dest.display()
            )));
        }
        if dest.exists() {
            return Err(TemplateError::AlreadyExists(dest.to_string_lossy().into()));
        }
        fs::create_dir_all(&dest)?;

        // Files explicitly enumerated in the manifest are processed
        // with their `template` flag honored. Anything else in the
        // directory (except the manifest itself) is copied verbatim —
        // gives template authors a quick path to ship `.cls`, images,
        // and other static assets without listing each one.
        let explicit_paths: std::collections::HashSet<String> =
            manifest.files.iter().map(|f| f.path.clone()).collect();

        for file in &manifest.files {
            let safe = sanitize_relative(&file.path)
                .ok_or_else(|| TemplateError::UnsafePath(file.path.clone()))?;
            copy_or_render(&source.dir, &dest, &safe, file.template, &vars)?;
        }

        for entry in walkdir(&source.dir)? {
            let rel = entry
                .strip_prefix(&source.dir)
                .map_err(|_| TemplateError::BadPath(entry.to_string_lossy().into()))?
                .to_path_buf();
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if rel_str == "template.json" {
                continue;
            }
            if explicit_paths.contains(&rel_str) {
                continue;
            }
            copy_or_render(&source.dir, &dest, &rel, false, &vars)?;
        }

        let project = Project {
            root_path: dest.to_string_lossy().to_string(),
            root_file: manifest.root_file.clone(),
            format: manifest.format,
            name: name.clone(),
            ..Default::default()
        };
        project::write_project(&project)?;
        Ok(project)
    })
    .await
    // Commands reject with a plain Display string (the IPC error contract); a
    // serialized enum would surface as a variant name or raw JSON in the UI.
    .map_err(|e| format!("background task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Directories never captured into a saved template: our own sidecar, VCS
/// metadata, and dependency dirs.
const TEMPLATE_SKIP_DIRS: &[&str] = &[".typeward", ".git", ".svn", ".hg", "node_modules"];

/// Capture the currently-open project as a reusable custom template under
/// `<app_data>/templates/custom/<id>`. Files are copied verbatim (no `{{var}}`
/// extraction — a captured project has concrete content); the author can add
/// `variables`/`files[*].template` to the generated `template.json` by hand.
#[tauri::command]
pub async fn template_save(
    app: AppHandle,
    project: Project,
    name: String,
    description: String,
) -> Result<TemplateManifest, String> {
    let custom_root = custom_root(&app).map_err(|e| e.to_string())?;

    tokio::task::spawn_blocking(move || -> Result<TemplateManifest, TemplateError> {
        let src_root = PathBuf::from(&project.root_path).canonicalize()?;
        // Only capture from a project root the user actually opened — mirrors
        // export_project_zip's gate. Without this an XSS-driven call could copy
        // ~/.ssh, .env, etc. into app-data and read them back via a template.
        if !project::is_registered_root(&src_root) {
            return Err(TemplateError::BadPath(
                "project root is not an opened project".into(),
            ));
        }
        // root_file must be a sane project-relative path (it becomes the
        // template's entry point and is re-validated on instantiate).
        project::validate_project_relative_path(&project.root_file)?;

        let raw_id = sanitize(&name);
        if raw_id.is_empty() {
            return Err(TemplateError::BadPath(
                "template name produced an empty id".into(),
            ));
        }

        fs::create_dir_all(&custom_root)?;
        let dest = custom_root.join(&raw_id);
        if dest.exists() {
            return Err(TemplateError::AlreadyExists(dest.to_string_lossy().into()));
        }
        fs::create_dir_all(&dest)?;

        let mut copied_any = false;
        for entry in collect_project_files(&src_root)? {
            let rel = entry
                .strip_prefix(&src_root)
                .map_err(|_| TemplateError::BadPath(entry.to_string_lossy().into()))?;
            let dest_path = dest.join(rel);
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&entry, &dest_path)?;
            copied_any = true;
        }
        if !copied_any {
            let _ = fs::remove_dir_all(&dest);
            return Err(TemplateError::BadPath(
                "project has no files to capture".into(),
            ));
        }

        let doc = TemplateManifestDoc {
            id: raw_id.clone(),
            name: name.clone(),
            description,
            format: project.format,
            tags: Vec::new(),
            thumbnail: None,
            root_file: project.root_file.clone(),
            variables: Vec::new(),
            files: Vec::new(),
            entitlement: None,
        };
        // The on-disk manifest carries the bare id (source is implied by the
        // directory it lives in). serialize before qualifying the returned id.
        fs::write(
            dest.join("template.json"),
            serde_json::to_string_pretty(&doc)?,
        )?;

        let mut returned = doc;
        returned.id = qualify_id(TemplateSource::Custom, &returned.id);
        Ok(TemplateManifest {
            doc: returned,
            source: TemplateSource::Custom,
        })
    })
    .await
    // Commands reject with a plain Display string (the IPC error contract); a
    // serialized enum would surface as a variant name or raw JSON in the UI.
    .map_err(|e| format!("background task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Walk a project root collecting regular files to capture, skipping
/// sidecar/VCS dirs, symlinks, and LaTeX build artifacts. Shared with the
/// source-bundle zip export, which wants exactly the same "just the
/// sources" view of a project.
pub(crate) fn collect_project_files(root: &Path) -> Result<Vec<PathBuf>, TemplateError> {
    let mut out = Vec::new();
    collect_template_walk(root, &mut out, 0)?;
    Ok(out)
}

/// Recursion ceiling for the project walk. A hostile clone can materialize an
/// arbitrarily deep tree, and this walk backs template capture, the source-zip
/// export, and the TODO scan — an unbounded recursion there overflows the
/// blocking pool's small stack, which aborts the process rather than unwinding.
/// No real project nests anywhere near this.
const MAX_WALK_DEPTH: usize = 64;

fn collect_template_walk(
    dir: &Path,
    out: &mut Vec<PathBuf>,
    depth: usize,
) -> Result<(), TemplateError> {
    if depth >= MAX_WALK_DEPTH {
        return Ok(()); // skip the subtree, keep everything found so far
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue; // never copy through a symlink into a template
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if file_type.is_dir() {
            if TEMPLATE_SKIP_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            collect_template_walk(&entry.path(), out, depth + 1)?;
        } else if file_type.is_file() && !is_build_artifact(&name_str) {
            out.push(entry.path());
        }
    }
    Ok(())
}

/// LaTeX/compile leftovers that shouldn't pollute a captured template.
fn is_build_artifact(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if lower.contains(".synctex") {
        return true; // .synctex, .synctex.gz, .synctex(busy)
    }
    Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            matches!(
                ext,
                "aux"
                    | "log"
                    | "out"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "fls"
                    | "fdb_latexmk"
                    | "bbl"
                    | "blg"
                    | "bcf"
                    | "nav"
                    | "snm"
                    | "vrb"
            )
        })
        .unwrap_or(false)
}

struct LocatedTemplate {
    dir: PathBuf,
}

fn locate_template(
    template_id: &str,
    builtin_root: &Path,
    custom_root: &Path,
) -> Result<LocatedTemplate, TemplateError> {
    let (prefix, id) = template_id
        .split_once(':')
        .ok_or_else(|| TemplateError::NotFound(template_id.to_string()))?;
    let root = match prefix {
        "builtin" => builtin_root,
        "custom" => custom_root,
        _ => return Err(TemplateError::NotFound(template_id.to_string())),
    };

    // The id is joined onto the templates root, so a value like
    // `../../../../some/dir` would escape it. Reject any separators or
    // parent-dir tokens before touching the filesystem.
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.split(['/', '\\']).any(|seg| seg == "..")
    {
        return Err(TemplateError::NotFound(template_id.to_string()));
    }

    // template paths are always `<format>/<id>` for builtins and just
    // `<id>` for customs. Try both shapes — keeps the manifest's id
    // field decoupled from the on-disk layout convention.
    let direct = root.join(id);
    if direct.join("template.json").exists() {
        return Ok(LocatedTemplate { dir: direct });
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let candidate = entry.path().join(id);
        if candidate.join("template.json").exists() {
            return Ok(LocatedTemplate { dir: candidate });
        }
    }
    Err(TemplateError::NotFound(template_id.to_string()))
}

fn scan_root(
    root: &Path,
    source: TemplateSource,
    out: &mut Vec<TemplateManifest>,
) -> Result<(), TemplateError> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let manifest_path = path.join("template.json");
        if manifest_path.exists() {
            if let Ok(mut doc) = read_manifest(&path) {
                // Prefix the id so different sources can share short names.
                doc.id = qualify_id(source, &doc.id);
                out.push(TemplateManifest { doc, source });
            }
        } else {
            // Built-in directory is grouped by format (latex/, typst/);
            // descend one level.
            for inner in fs::read_dir(&path)? {
                let inner = inner?;
                if !inner.file_type()?.is_dir() {
                    continue;
                }
                if inner.path().join("template.json").exists()
                    && let Ok(mut doc) = read_manifest(&inner.path())
                {
                    doc.id = qualify_id(source, &doc.id);
                    out.push(TemplateManifest { doc, source });
                }
            }
        }
    }
    Ok(())
}

fn qualify_id(source: TemplateSource, raw: &str) -> String {
    let prefix = match source {
        TemplateSource::Builtin => "builtin",
        TemplateSource::Custom => "custom",
    };
    format!("{prefix}:{raw}")
}

fn read_manifest(template_dir: &Path) -> Result<TemplateManifestDoc, TemplateError> {
    let raw = fs::read_to_string(template_dir.join("template.json"))?;
    let doc: TemplateManifestDoc = serde_json::from_str(&raw)?;
    project::validate_project_relative_path(&doc.root_file)?;
    for file in &doc.files {
        sanitize_relative(&file.path)
            .ok_or_else(|| TemplateError::UnsafePath(file.path.clone()))?;
    }
    Ok(doc)
}

fn copy_or_render(
    src_root: &Path,
    dest_root: &Path,
    rel: &Path,
    do_template: bool,
    vars: &HashMap<String, String>,
) -> Result<(), TemplateError> {
    let src_path = src_root.join(rel);
    let dest_path = dest_root.join(rel);
    let meta = fs::symlink_metadata(&src_path)?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(TemplateError::UnsafePath(
            rel.to_string_lossy().into_owned(),
        ));
    }
    if let Some(parent) = dest_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if do_template {
        let raw = fs::read_to_string(&src_path)?;
        let rendered = render(&raw, vars);
        fs::write(&dest_path, rendered)?;
    } else {
        fs::copy(&src_path, &dest_path)?;
    }
    Ok(())
}

/// Handlebars-subset `{{var}}` substitution. Unknown vars resolve to
/// the empty string — template authors shouldn't crash a new-project
/// flow because the user left a field blank.
fn render(input: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        if ch == '{'
            && input[i..].starts_with("{{")
            && let Some(close) = input[i..].find("}}")
        {
            let key = input[i + 2..i + close].trim();
            if !key.is_empty() && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                out.push_str(vars.get(key).map(|s| s.as_str()).unwrap_or(""));
                // Skip past the closing braces.
                while let Some((j, _)) = chars.peek() {
                    if *j < i + close + 2 {
                        chars.next();
                    } else {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

fn walkdir(root: &Path) -> Result<Vec<PathBuf>, TemplateError> {
    let mut out = Vec::new();
    walk(root, &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), TemplateError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let name = entry.file_name();
            if is_template_internal_segment(&name) {
                continue;
            }
            walk(&path, out)?;
        } else if file_type.is_file() {
            out.push(path);
        }
    }
    Ok(())
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

fn sanitize_relative(input: &str) -> Option<PathBuf> {
    let out = project::validate_project_relative_path(input).ok()?;
    for component in out.components() {
        if let Component::Normal(part) = component
            && is_template_internal_segment(part)
        {
            return None;
        }
    }
    Some(out)
}

fn is_template_internal_segment(part: &std::ffi::OsStr) -> bool {
    let value = part.to_string_lossy();
    TEMPLATE_SKIP_DIRS
        .iter()
        .any(|skip| value.eq_ignore_ascii_case(skip))
}

fn builtin_root(app: &AppHandle) -> Result<PathBuf, TemplateError> {
    app.path()
        .resolve("templates", BaseDirectory::Resource)
        .map_err(|e| TemplateError::BadPath(e.to_string()))
}

fn custom_root(app: &AppHandle) -> Result<PathBuf, TemplateError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| TemplateError::BadPath(e.to_string()))?;
    Ok(dir.join("templates").join("custom"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_substitutes_known_vars() {
        let vars = HashMap::from([
            ("title".to_string(), "Hello".to_string()),
            ("author".to_string(), "Marek".to_string()),
        ]);
        assert_eq!(
            render("title={{title}}, by {{author}}", &vars),
            "title=Hello, by Marek"
        );
    }

    #[test]
    fn render_treats_unknown_vars_as_empty() {
        let vars = HashMap::new();
        assert_eq!(render("hi {{name}}", &vars), "hi ");
    }

    #[test]
    fn render_leaves_invalid_braces_alone() {
        let vars = HashMap::new();
        assert_eq!(render("{{ not-a-key }}", &vars), "{{ not-a-key }}");
        assert_eq!(render("{ single }", &vars), "{ single }");
    }

    #[test]
    fn build_artifacts_are_filtered_from_captured_templates() {
        for junk in [
            "main.aux",
            "main.log",
            "main.fdb_latexmk",
            "main.synctex.gz",
            "refs.bbl",
            "slides.nav",
        ] {
            assert!(is_build_artifact(junk), "{junk} should be skipped");
        }
        for keep in [
            "main.tex",
            "refs.bib",
            "figure.pdf",
            "logo.png",
            "thesis.cls",
        ] {
            assert!(!is_build_artifact(keep), "{keep} should be kept");
        }
    }

    #[test]
    fn sanitize_relative_rejects_parent_escape() {
        assert!(sanitize_relative("../outside.tex").is_none());
        assert!(sanitize_relative("/abs/path").is_none());
        assert!(sanitize_relative("ok/sub.tex").is_some());
    }

    #[test]
    fn sanitize_relative_rejects_project_internal_and_cli_flag_paths() {
        assert!(sanitize_relative(".typeward/project.json").is_none());
        assert!(sanitize_relative("nested/.TypeWard/cursor").is_none());
        assert!(sanitize_relative("-shell-escape.tex").is_none());
    }
}
