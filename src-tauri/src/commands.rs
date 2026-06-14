use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

use crate::autosave::{self, Snapshot};
use crate::detect::{self, EngineProbe};
use crate::fs_ops;
use crate::project::{self, Project, ProjectFormat};
use crate::settings::{self, Settings};

/// Convert any error into a String at the command boundary so Tauri's bridge
/// can serialize it cleanly. Domain modules keep their own typed errors.
type CmdResult<T> = Result<T, String>;

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

fn checked_project_root_and_file(project: &Project) -> CmdResult<(PathBuf, String)> {
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

#[tauri::command]
pub fn detect_tex() -> EngineProbe {
    detect::probe()
}

#[tauri::command]
pub fn list_projects(root: Option<String>) -> CmdResult<Vec<Project>> {
    let root = root
        .map(PathBuf::from)
        .unwrap_or_else(settings::default_projects_root);
    let projects = project::list_projects(&root).map_err(err)?;
    for p in &projects {
        project::register_root(Path::new(&p.root_path));
    }
    Ok(projects)
}

#[tauri::command]
pub fn create_project(
    name: String,
    format: ProjectFormat,
    parent: Option<String>,
) -> CmdResult<Project> {
    let parent = parent
        .map(PathBuf::from)
        .unwrap_or_else(settings::default_projects_root);
    if !parent.exists() {
        std::fs::create_dir_all(&parent).map_err(err)?;
    }
    let project = project::create_project(&parent, &name, format).map_err(err)?;
    project::register_root(Path::new(&project.root_path));
    Ok(project)
}

#[tauri::command]
pub fn open_project(path: String) -> CmdResult<Project> {
    let project = project::read_project(Path::new(&path)).map_err(err)?;
    project::register_root(Path::new(&project.root_path));
    Ok(project)
}

/// Write `.typeward/project.json` for an existing folder (e.g. a just-cloned
/// repo) so it shows up in the library and can be opened. Gated to the projects
/// area like `git_clone`. Returns the detected project.
#[tauri::command]
pub fn import_project_folder(path: String) -> CmdResult<Project> {
    let root = PathBuf::from(&path);
    if !(project::is_registered_root(&root) || project::is_new_path_under_projects_root(&root)) {
        return Err(format!("path is outside the projects root: {path}"));
    }
    let project = project::import_folder_as_project(&root, None).map_err(err)?;
    project::register_root(Path::new(&project.root_path));
    Ok(project)
}

/// Replace the project's `integrations` block. Caller passes the
/// already-built struct; the file is read, the block is swapped, and
/// the file is rewritten atomically. No partial mutation API — keeping
/// the seam narrow makes it harder to land a half-updated project.json.
#[tauri::command]
pub fn set_project_integrations(
    project_root: String,
    integrations: project::ProjectIntegrations,
) -> CmdResult<Project> {
    ensure_registered(&project_root)?;
    project::update_project_integrations(Path::new(&project_root), integrations).map_err(err)
}

#[tauri::command]
pub fn read_project_text_file(project_root: String, rel_path: String) -> CmdResult<String> {
    ensure_registered(&project_root)?;
    let path =
        project::resolve_existing_project_path(Path::new(&project_root), &rel_path).map_err(err)?;
    fs_ops::read_text(&path).map_err(err)
}

/// Read raw bytes for a project-relative file. Used by the WASM
/// CompileProvider to pull binary figure assets (.png/.jpg/.pdf) into
/// the WASM in-memory FS so `\includegraphics{...}` resolves.
#[tauri::command]
pub fn read_project_binary_file(project_root: String, rel_path: String) -> CmdResult<Vec<u8>> {
    ensure_registered(&project_root)?;
    let path =
        project::resolve_existing_project_path(Path::new(&project_root), &rel_path).map_err(err)?;
    std::fs::read(&path).map_err(err)
}

#[tauri::command]
pub fn write_project_text_file(
    project_root: String,
    rel_path: String,
    content: String,
) -> CmdResult<()> {
    ensure_registered(&project_root)?;
    let path =
        project::resolve_project_write_path(Path::new(&project_root), &rel_path).map_err(err)?;
    fs_ops::write_text(&path, &content).map_err(err)
}

/// Persist binary bytes (e.g. a PDF emitted by the WASM engine)
/// to the given absolute path. Bypasses the fs plugin scope like the
/// rest of our project-internal IO. Parent directories are created on
/// demand so callers don't need a separate mkdir step.
#[tauri::command]
pub fn write_project_binary_file(
    project_root: String,
    rel_path: String,
    bytes: Vec<u8>,
) -> CmdResult<()> {
    ensure_registered(&project_root)?;
    let path =
        project::resolve_project_write_path(Path::new(&project_root), &rel_path).map_err(err)?;
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
}

/// Exposes the existing `parse_latex_log` diagnostic extractor over IPC
/// so the WASM CompileProvider can produce diagnostics in the same
/// shape as the desktop path without duplicating the parser in TS.
#[tauri::command]
pub fn parse_latex_log_cmd(log: String, entry: String) -> Vec<Diagnostic> {
    parse_latex_log(&log, &entry)
}

#[derive(Debug, Clone, Serialize)]
pub struct CompileResult {
    pub ok: bool,
    #[serde(rename = "outputPath")]
    pub output_path: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub log: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub file: String,
    pub line: u32,
    pub source: String,
}

/// Phase 1 baseline LaTeX compile.
///
/// `system-tex` path: invokes the user's `latexmk` (preferred) or `pdflatex`
/// from PATH.
/// `tectonic` path: tries the bundled sidecar binary first
/// (`binaries/tectonic-<target-triple>`, declared in tauri.conf.json's
/// externalBin). Falls back to `tectonic` from PATH if the sidecar isn't
/// shipped — useful during development before running `npm run fetch:tectonic`.
///
/// Diagnostic parsing is intentionally minimal; a richer `.log` parser lands
/// later. Same for incremental builds.
#[tauri::command]
pub async fn compile_latex(
    app: tauri::AppHandle,
    project: Project,
    engine: Option<String>,
    halt_on_error: Option<bool>,
) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;

    let engine = engine.unwrap_or_else(|| "system-tex".into());
    // Halting was historically hardcoded — keep it the default. Turning it
    // off lets the engine push past errors and collect every diagnostic in
    // one pass (often with a partial PDF). Tectonic always halts; the flag
    // only applies to the system-tex path.
    let halt = halt_on_error.unwrap_or(true);
    let (log, success) = match engine.as_str() {
        "tectonic" => run_tectonic(&app, &root_file, &root).await?,
        _ => {
            let root_for_cmd = root.clone();
            let root_file_for_cmd = root_file.clone();
            tokio::task::spawn_blocking(move || {
                run_system_tex(&root_file_for_cmd, &root_for_cmd, halt)
            })
            .await
            .map_err(err)??
        }
    };

    let pdf_path = root.join(replace_ext(&root_file, "pdf"));
    let ok = success && pdf_path.exists();
    let diagnostics = parse_latex_log(&log, &root_file);

    Ok(CompileResult {
        ok,
        output_path: if ok {
            Some(pdf_path.to_string_lossy().into())
        } else {
            None
        },
        diagnostics,
        log,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

fn run_system_tex(root_file: &str, root: &Path, halt_on_error: bool) -> Result<(String, bool), String> {
    let mut accumulated_log = String::new();

    // Prefer latexmk (handles multiple passes, bibliography). If it isn't on
    // PATH, or it spawns but exits non-zero with no useful diagnostics, fall
    // back to a direct pdflatex invocation. MiKTeX on Windows sometimes ships
    // latexmk without a usable Perl, so the fallback is important.
    // Spawn the absolute path resolved against PATH, never the bare name:
    // `current_dir(root)` would otherwise let Windows' CreateProcess execute a
    // `latexmk`/`pdflatex` planted in a malicious project directory.
    if let Ok(latexmk) = which::which("latexmk") {
        let mut latexmk_args = vec!["-pdf", "-synctex=1", "-interaction=nonstopmode"];
        if halt_on_error {
            latexmk_args.push("-halt-on-error");
        }
        latexmk_args.push(root_file);
        accumulated_log.push_str(&format!("$ latexmk {}\n", latexmk_args.join(" ")));
        match Command::new(&latexmk)
            .args(&latexmk_args)
            .current_dir(root)
            .output()
        {
            Ok(out) => {
                accumulated_log.push_str(&merge_io(&out.stdout, &out.stderr));
                if out.status.success() {
                    return Ok((accumulated_log, true));
                }
                accumulated_log.push_str(&format!(
                    "\n[latexmk exit: {}]\n\n--- falling back to pdflatex ---\n",
                    out.status,
                ));
            }
            Err(e) => {
                accumulated_log.push_str(&format!(
                    "[latexmk spawn failed: {}]\n\n--- falling back to pdflatex ---\n",
                    e,
                ));
            }
        }
    }

    let pdflatex = match which::which("pdflatex") {
        Ok(path) => path,
        Err(_) => {
            accumulated_log
                .push_str("\nNo LaTeX engine on PATH. Install MiKTeX/TeX Live or pick the Tectonic engine in Settings.");
            return Ok((accumulated_log, false));
        }
    };

    let mut pdflatex_args = vec!["-synctex=1", "-interaction=nonstopmode"];
    if halt_on_error {
        pdflatex_args.push("-halt-on-error");
    }
    pdflatex_args.push(root_file);
    accumulated_log.push_str(&format!("\n$ pdflatex {}\n", pdflatex_args.join(" ")));
    let output = Command::new(&pdflatex)
        .args(&pdflatex_args)
        .current_dir(root)
        .output()
        .map_err(|e| {
            accumulated_log.push_str(&format!("[pdflatex spawn failed: {}]\n", e));
            // Return the accumulated log so the user can see what we tried.
            format!("compile failed:\n{}", accumulated_log)
        })?;
    accumulated_log.push_str(&merge_io(&output.stdout, &output.stderr));
    Ok((accumulated_log, output.status.success()))
}

async fn run_tectonic(
    app: &tauri::AppHandle,
    root_file: &str,
    root: &Path,
) -> Result<(String, bool), String> {
    // --synctex emits the .synctex.gz alongside the PDF; harmless when the
    // user doesn't have the synctex CLI installed (forward/inverse just
    // return None then).
    let tectonic_args = ["-X", "compile", root_file, "--keep-logs", "--synctex"];
    // Try the bundled sidecar first.
    let sidecar_result = app.shell().sidecar("binaries/tectonic");
    if let Ok(cmd) = sidecar_result {
        let output = cmd
            .args(tectonic_args)
            .current_dir(root)
            .output()
            .await
            .map_err(|e| format!("sidecar tectonic failed: {}", e))?;
        let ok = output.status.success();
        return Ok((merge_io(&output.stdout, &output.stderr), ok));
    }
    // Fall back to PATH — resolve the absolute path and spawn that, not the
    // bare name, so `current_dir(root)` can't redirect to a planted binary.
    let tectonic = match which::which("tectonic") {
        Ok(path) => path,
        Err(_) => {
            return Err(
                "tectonic is not bundled (run `npm run fetch:tectonic`) and not on PATH".into(),
            )
        }
    };
    let root_for_cmd = root.to_path_buf();
    let root_file_for_cmd = root_file.to_string();
    tokio::task::spawn_blocking(move || {
        let output = Command::new(&tectonic)
            .args([
                "-X",
                "compile",
                root_file_for_cmd.as_str(),
                "--keep-logs",
                "--synctex",
            ])
            .current_dir(root_for_cmd)
            .output()
            .map_err(|e| format!("failed to spawn tectonic: {}", e))?;
        Ok((
            merge_io(&output.stdout, &output.stderr),
            output.status.success(),
        ))
    })
    .await
    .map_err(err)?
}

fn merge_io(stdout: &[u8], stderr: &[u8]) -> String {
    let out = String::from_utf8_lossy(stdout);
    let err = String::from_utf8_lossy(stderr);
    if err.is_empty() {
        out.into_owned()
    } else {
        format!("{out}\n{err}")
    }
}

/// Minimal LaTeX log scanner: flags lines starting with `! ` (TeX errors) and
/// `Warning:` patterns. A real implementation would track file pushes/pops to
/// resolve the source file; this v0 just attributes everything to the entry.
fn parse_latex_log(log: &str, entry: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (i, line) in log.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("! ") {
            out.push(Diagnostic {
                severity: "error".into(),
                message: trimmed.trim_start_matches("! ").to_string(),
                file: entry.to_string(),
                line: (i + 1) as u32,
                source: "compile".into(),
            });
        } else if trimmed.contains("Warning:") {
            out.push(Diagnostic {
                severity: "warning".into(),
                message: trimmed.to_string(),
                file: entry.to_string(),
                line: (i + 1) as u32,
                source: "compile".into(),
            });
        }
    }
    out
}

// ---------- Typst compile -------------------------------------------------

/// Compile a Typst project by invoking `typst compile <root_file>`. Output
/// defaults to `<base>.pdf` alongside the entry; we don't pass an explicit
/// output path so the user's filesystem layout stays in their control.
///
/// Diagnostics are parsed out of stderr — Typst prints `error:` and
/// `warning:` lines with optional file:line:col context. The parser is
/// intentionally minimal for now; a real impl would walk the structured
/// `--diagnostic-format=json` output once it stabilizes.
#[tauri::command]
pub async fn compile_typst(project: Project) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;
    let root_for_cmd = root.clone();
    let root_file_for_cmd = root_file.clone();
    let (log, success) = tokio::task::spawn_blocking(move || -> CmdResult<(String, bool)> {
        // Resolve the absolute path on PATH and spawn THAT, not the bare name.
        // Bare `Command::new("typst")` + `current_dir(project)` lets Windows'
        // CreateProcess search the project dir first, so a planted `typst.exe`
        // in a malicious project would run (argument/binary planting). `which`
        // resolves against the app's CWD/PATH, never the project.
        let typst = which::which("typst").map_err(|_| {
            "typst is not on PATH — install it from https://typst.app/download or `cargo install typst-cli`"
                .to_string()
        })?;

        let mut log = String::new();
        log.push_str(&format!("$ typst compile {}\n", root_file_for_cmd));
        let output = Command::new(&typst)
            .args(["compile", root_file_for_cmd.as_str()])
            .current_dir(&root_for_cmd)
            .output()
            .map_err(|e| format!("failed to spawn typst: {}", e))?;
        log.push_str(&merge_io(&output.stdout, &output.stderr));
        Ok((log, output.status.success()))
    })
    .await
    .map_err(err)??;

    let pdf_path = root.join(replace_ext(&root_file, "pdf"));
    let ok = success && pdf_path.exists();
    let diagnostics = parse_typst_log(&log, &root_file);

    Ok(CompileResult {
        ok,
        output_path: if ok {
            Some(pdf_path.to_string_lossy().into())
        } else {
            None
        },
        diagnostics,
        log,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Lines like `error: ...` and `warning: ...` are surfaced as Diagnostics.
/// Typst also prints follow-up location hints; we attach them to the
/// previous diagnostic via message concatenation.
fn parse_typst_log(log: &str, entry: &str) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    for (i, line) in log.lines().enumerate() {
        let trimmed = line.trim();
        let (severity, rest) = if let Some(rest) = trimmed.strip_prefix("error:") {
            ("error", rest.trim())
        } else if let Some(rest) = trimmed.strip_prefix("warning:") {
            ("warning", rest.trim())
        } else {
            continue;
        };
        out.push(Diagnostic {
            severity: severity.into(),
            message: rest.to_string(),
            file: entry.to_string(),
            line: (i + 1) as u32,
            source: "typst".into(),
        });
    }
    out
}

/// Strip the trailing extension and append `new_ext`. Idempotent for files
/// that already end in `.<new_ext>`. Falls back to appending when the
/// source has no extension.
fn replace_ext(rel_path: &str, new_ext: &str) -> String {
    match rel_path.rfind('.') {
        Some(idx) => format!("{}.{}", &rel_path[..idx], new_ext),
        None => format!("{}.{}", rel_path, new_ext),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_ext_swaps_trailing_extension() {
        assert_eq!(replace_ext("main.typ", "pdf"), "main.pdf");
        assert_eq!(replace_ext("paper.md", "pdf"), "paper.pdf");
        assert_eq!(replace_ext("notes", "pdf"), "notes.pdf");
        assert_eq!(replace_ext("a.b.tex", "pdf"), "a.b.pdf");
    }

    #[test]
    fn parse_typst_log_picks_up_error_and_warning_lines() {
        let log = "  error: undefined variable `x`\nnote: at main.typ:3:1\nwarning: unused parameter\nrandom line\n";
        let diags = parse_typst_log(log, "main.typ");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].severity, "error");
        assert!(diags[0].message.contains("undefined variable"));
        assert_eq!(diags[1].severity, "warning");
        assert_eq!(diags[0].source, "typst");
    }
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> CmdResult<Settings> {
    settings::load(&app).map_err(err)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> CmdResult<()> {
    settings::save(&app, &settings).map_err(err)?;
    // Keep the clone-destination boundary in sync when the user moves their
    // projects root. (File IO is gated by the opened-project registry, which
    // this does not affect.)
    let root = PathBuf::from(&settings.projects_root);
    let _ = std::fs::create_dir_all(&root);
    project::set_projects_root(&root);
    Ok(())
}

/// Settings → Security → "Reset local app data". Overwrites settings.json
/// with the defaults; the frontend clears localStorage and reloads. Project
/// files on disk are untouched.
#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> CmdResult<()> {
    settings::save(&app, &Settings::default()).map_err(err)?;
    project::set_projects_root(&settings::default_projects_root());
    Ok(())
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
            let bytes = std::fs::read(&abs).map_err(err)?;
            use std::io::Write;
            zip.write_all(&bytes).map_err(err)?;
        }
        zip.finish().map_err(err)?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(err)?
}

// ---------- Autosave / crash recovery -------------------------------------

#[tauri::command]
pub fn write_snapshot(project_root: String, rel_path: String, content: String) -> CmdResult<()> {
    ensure_registered(&project_root)?;
    autosave::write(Path::new(&project_root), &rel_path, &content).map_err(err)
}

#[tauri::command]
pub fn clear_snapshot(project_root: String, rel_path: String) -> CmdResult<()> {
    ensure_registered(&project_root)?;
    autosave::clear(Path::new(&project_root), &rel_path).map_err(err)
}

#[tauri::command]
pub fn list_orphan_snapshots(project_root: String) -> CmdResult<Vec<Snapshot>> {
    ensure_registered(&project_root)?;
    autosave::list_orphans(Path::new(&project_root)).map_err(err)
}
