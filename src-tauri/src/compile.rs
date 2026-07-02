//! LaTeX/Typst compile pipeline. Extracted from the IPC facade so the
//! multi-pass engine fallback chains and the log parsers live in a domain
//! module (like every other concern in the crate), leaving `commands.rs` as
//! thin handlers.
//!
//! Engine fallbacks:
//! - `system-tex`: user's `latexmk` (preferred) → `pdflatex` from PATH.
//! - `tectonic`: bundled sidecar (`binaries/tectonic-<triple>`, tauri.conf.json
//!   externalBin) → `tectonic` from PATH.
//!
//! Diagnostics are surfaced by minimal `.log`/stderr scanners. `Diagnostic` is
//! also mirrored by the grammar path (`GrammarDiagnostic`) and consumed by the
//! mobile texlive-wasm provider via `parse_latex_log_cmd`.

use std::path::Path;
use std::process::Command;
use std::time::Instant;

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

use crate::commands::checked_project_root_and_file;
use crate::project::Project;

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
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

/// Exposes the existing `parse_latex_log` diagnostic extractor over IPC
/// so the WASM CompileProvider can produce diagnostics in the same
/// shape as the desktop path without duplicating the parser in TS.
#[tauri::command]
pub async fn parse_latex_log_cmd(log: String, entry: String) -> Vec<Diagnostic> {
    // A full texlive-wasm log can run to megabytes; scan it off the event loop.
    tokio::task::spawn_blocking(move || parse_latex_log(&log, &entry))
        .await
        .unwrap_or_default()
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

fn run_system_tex(
    root_file: &str,
    root: &Path,
    halt_on_error: bool,
) -> Result<(String, bool), String> {
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
pub fn parse_latex_log(log: &str, entry: &str) -> Vec<Diagnostic> {
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

    #[test]
    fn parse_latex_log_flags_errors_and_warnings() {
        let log = "ok line\n! Undefined control sequence.\nPackage hyperref Warning: token\nplain\n";
        let diags = parse_latex_log(log, "main.tex");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].severity, "error");
        assert_eq!(diags[0].message, "Undefined control sequence.");
        assert_eq!(diags[0].file, "main.tex");
        assert_eq!(diags[1].severity, "warning");
        assert_eq!(diags[0].source, "compile");
    }

    #[test]
    fn parse_latex_log_handles_representative_latexmk_output() {
        // A trimmed-down but representative latexmk/pdflatex run: the command
        // echo, engine banner, a citation warning, a real TeX error with its
        // line-context follow-up, a package warning, and a LaTeX Error line.
        let log = "\
$ latexmk -pdf -synctex=1 -interaction=nonstopmode -halt-on-error main.tex
Latexmk: Run number 1 of rule 'pdflatex'
This is pdfTeX, Version 3.14159265
(./main.tex
LaTeX Warning: Citation `foo' on page 1 undefined on input line 12.
! Undefined control sequence.
l.15 \\badcommand
Package hyperref Warning: Draft mode on.
! LaTeX Error: File `missing.sty' not found.
";
        let diags = parse_latex_log(log, "main.tex");
        let errors: Vec<_> = diags.iter().filter(|d| d.severity == "error").collect();
        let warnings: Vec<_> = diags.iter().filter(|d| d.severity == "warning").collect();
        assert_eq!(errors.len(), 2, "expected two `! ` error lines");
        assert_eq!(warnings.len(), 2, "expected two Warning: lines");
        assert_eq!(errors[0].message, "Undefined control sequence.");
        assert!(errors[1].message.contains("File `missing.sty' not found."));
        // Everything is attributed to the entry file with the compile source.
        assert!(diags
            .iter()
            .all(|d| d.file == "main.tex" && d.source == "compile"));
        // Line numbers are 1-based positions within the log.
        assert!(diags.iter().all(|d| d.line >= 1));
    }
}
