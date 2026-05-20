use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

use crate::autosave::{self, Snapshot};
use crate::detect::{self, EngineProbe};
use crate::fs_ops;
use crate::project::{self, DocumentExperience, Project, ProjectFormat};
use crate::settings::{self, Settings};

/// Convert any error into a String at the command boundary so Tauri's bridge
/// can serialize it cleanly. Domain modules keep their own typed errors.
type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn checked_project_root_and_file(project: &Project) -> CmdResult<(PathBuf, String)> {
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
    project::list_projects(&root).map_err(err)
}

#[tauri::command]
pub fn create_project(
    name: String,
    format: ProjectFormat,
    experience: Option<DocumentExperience>,
    parent: Option<String>,
) -> CmdResult<Project> {
    let parent = parent
        .map(PathBuf::from)
        .unwrap_or_else(settings::default_projects_root);
    if !parent.exists() {
        std::fs::create_dir_all(&parent).map_err(err)?;
    }
    project::create_project(&parent, &name, format, experience).map_err(err)
}

#[tauri::command]
pub fn open_project(path: String) -> CmdResult<Project> {
    project::read_project(Path::new(&path)).map_err(err)
}

#[tauri::command]
pub fn read_project_text_file(project_root: String, rel_path: String) -> CmdResult<String> {
    let path = project::resolve_existing_project_path(Path::new(&project_root), &rel_path)
        .map_err(err)?;
    fs_ops::read_text(&path).map_err(err)
}

/// Read raw bytes for a project-relative file. Used by the busytex
/// CompileProvider to pull binary figure assets (.png/.jpg/.pdf) into
/// the WASM in-memory FS so `\includegraphics{...}` resolves.
#[tauri::command]
pub fn read_project_binary_file(project_root: String, rel_path: String) -> CmdResult<Vec<u8>> {
    let path = project::resolve_existing_project_path(Path::new(&project_root), &rel_path)
        .map_err(err)?;
    std::fs::read(&path).map_err(err)
}

#[tauri::command]
pub fn write_project_text_file(
    project_root: String,
    rel_path: String,
    content: String,
) -> CmdResult<()> {
    let path = project::resolve_project_write_path(Path::new(&project_root), &rel_path)
        .map_err(err)?;
    fs_ops::write_text(&path, &content).map_err(err)
}

/// Persist binary bytes (e.g. a PDF emitted by the busytex WASM engine)
/// to the given absolute path. Bypasses the fs plugin scope like the
/// rest of our project-internal IO. Parent directories are created on
/// demand so callers don't need a separate mkdir step.
#[tauri::command]
pub fn write_project_binary_file(
    project_root: String,
    rel_path: String,
    bytes: Vec<u8>,
) -> CmdResult<()> {
    let path = project::resolve_project_write_path(Path::new(&project_root), &rel_path)
        .map_err(err)?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(err)?;
        }
    }
    std::fs::write(path, &bytes).map_err(err)
}

/// Exposes the existing `parse_latex_log` diagnostic extractor over IPC
/// so the busytex CompileProvider can produce diagnostics in the same
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
) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;

    let engine = engine.unwrap_or_else(|| "system-tex".into());
    let (log, success) = match engine.as_str() {
        "tectonic" => run_tectonic(&app, &root_file, &root).await?,
        _ => run_system_tex(&root_file, &root)?,
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

fn run_system_tex(root_file: &str, root: &Path) -> Result<(String, bool), String> {
    let mut accumulated_log = String::new();

    // Prefer latexmk (handles multiple passes, bibliography). If it isn't on
    // PATH, or it spawns but exits non-zero with no useful diagnostics, fall
    // back to a direct pdflatex invocation. MiKTeX on Windows sometimes ships
    // latexmk without a usable Perl, so the fallback is important.
    if which::which("latexmk").is_ok() {
        let latexmk_args = [
            "-pdf",
            "-synctex=1",
            "-interaction=nonstopmode",
            "-halt-on-error",
            root_file,
        ];
        accumulated_log.push_str(&format!("$ latexmk {}\n", latexmk_args.join(" ")));
        match Command::new("latexmk")
            .args(latexmk_args)
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

    if which::which("pdflatex").is_err() {
        accumulated_log
            .push_str("\nNo LaTeX engine on PATH. Install MiKTeX/TeX Live or pick the Tectonic engine in Settings.");
        return Ok((accumulated_log, false));
    }

    let pdflatex_args = [
        "-synctex=1",
        "-interaction=nonstopmode",
        "-halt-on-error",
        root_file,
    ];
    accumulated_log.push_str(&format!("\n$ pdflatex {}\n", pdflatex_args.join(" ")));
    let output = Command::new("pdflatex")
        .args(pdflatex_args)
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
    let tectonic_args = [
        "-X",
        "compile",
        root_file,
        "--keep-logs",
        "--synctex",
    ];
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
    // Fall back to PATH.
    if which::which("tectonic").is_err() {
        return Err(
            "tectonic is not bundled (run `npm run fetch:tectonic`) and not on PATH".into(),
        );
    }
    let output = Command::new("tectonic")
        .args(tectonic_args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to spawn tectonic: {}", e))?;
    Ok((merge_io(&output.stdout, &output.stderr), output.status.success()))
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
    if which::which("typst").is_err() {
        return Err(
            "typst is not on PATH — install it from https://typst.app/download or `cargo install typst-cli`"
                .into(),
        );
    }

    let mut log = String::new();
    log.push_str(&format!("$ typst compile {}\n", root_file));
    let output = Command::new("typst")
        .args(["compile", root_file.as_str()])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to spawn typst: {}", e))?;
    log.push_str(&merge_io(&output.stdout, &output.stderr));

    let pdf_path = root.join(replace_ext(&root_file, "pdf"));
    let ok = output.status.success() && pdf_path.exists();
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

// ---------- Markdown compile (pandoc) -------------------------------------

/// Compile Markdown to PDF via pandoc. Pandoc itself delegates PDF
/// generation to a LaTeX engine (pdflatex by default), so the user needs
/// at least one of pdflatex/xelatex/lualatex installed for this to
/// succeed. We surface that constraint clearly in the log when the spawn
/// fails because of a missing engine.
#[tauri::command]
pub async fn compile_markdown(project: Project) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;
    if which::which("pandoc").is_err() {
        return Err(
            "pandoc is not on PATH — install it from https://pandoc.org/installing.html".into(),
        );
    }

    let output_name = replace_ext(&root_file, "pdf");
    let mut log = String::new();
    log.push_str(&format!(
        "$ pandoc {} -o {}\n",
        root_file, output_name
    ));
    let output = Command::new("pandoc")
        .args([root_file.as_str(), "-o", output_name.as_str()])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to spawn pandoc: {}", e))?;
    log.push_str(&merge_io(&output.stdout, &output.stderr));

    let pdf_path = root.join(&output_name);
    let ok = output.status.success() && pdf_path.exists();
    let diagnostics = parse_pandoc_log(&log, &root_file);

    if !ok && !log.contains("error") {
        // Pandoc often fails silently when the LaTeX engine is missing —
        // make that visible in the log tail so the user has somewhere to
        // start.
        log.push_str(
            "\n[pandoc] compile failed. PDF generation requires a LaTeX engine (pdflatex/xelatex/lualatex). Install one and retry.\n",
        );
    }

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

/// Pandoc emits "Error: ..." and "Error producing PDF" lines on stderr
/// when something goes wrong; LaTeX-engine errors get embedded inside.
fn parse_pandoc_log(log: &str, entry: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (i, line) in log.lines().enumerate() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if lower.starts_with("error") || lower.starts_with("[error]") {
            out.push(Diagnostic {
                severity: "error".into(),
                message: trimmed.to_string(),
                file: entry.to_string(),
                line: (i + 1) as u32,
                source: "pandoc".into(),
            });
        } else if lower.starts_with("warning") || lower.starts_with("[warning]") {
            out.push(Diagnostic {
                severity: "warning".into(),
                message: trimmed.to_string(),
                file: entry.to_string(),
                line: (i + 1) as u32,
                source: "pandoc".into(),
            });
        }
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

    #[test]
    fn parse_pandoc_log_classifies_error_warning_prefixes() {
        let log = "Error: failed to find a working LaTeX engine\n[WARNING] deprecated option\nok line\n";
        let diags = parse_pandoc_log(log, "main.md");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].severity, "error");
        assert_eq!(diags[1].severity, "warning");
        assert_eq!(diags[0].source, "pandoc");
    }

}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> CmdResult<Settings> {
    settings::load(&app).map_err(err)
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Settings) -> CmdResult<()> {
    settings::save(&app, &settings).map_err(err)
}

// ---------- Autosave / crash recovery -------------------------------------

#[tauri::command]
pub fn write_snapshot(
    project_root: String,
    rel_path: String,
    content: String,
) -> CmdResult<()> {
    autosave::write(Path::new(&project_root), &rel_path, &content).map_err(err)
}

#[tauri::command]
pub fn clear_snapshot(project_root: String, rel_path: String) -> CmdResult<()> {
    autosave::clear(Path::new(&project_root), &rel_path).map_err(err)
}

#[tauri::command]
pub fn list_orphan_snapshots(project_root: String) -> CmdResult<Vec<Snapshot>> {
    autosave::list_orphans(Path::new(&project_root)).map_err(err)
}
