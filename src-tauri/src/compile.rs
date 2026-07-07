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

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;

use crate::commands::checked_project_root_and_file;
use crate::project::Project;

type CmdResult<T> = Result<T, String>;

/// The concrete LaTeX engine to invoke. A strict enum (never a free-form
/// string) so the flags below are compile-time constants selected by match —
/// the argument-injection invariant. `tectonic` is XeLaTeX-based and takes its
/// own path; the other three run via latexmk (or a direct-binary fallback).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LatexEngine {
    #[default]
    Pdflatex,
    Xelatex,
    Lualatex,
    Tectonic,
}

/// Curated multi-pass build recipe. A strict kebab-case enum (never a free-form
/// string) so each recipe maps to a fixed, compile-time-constant pass sequence —
/// the argument-injection invariant. `latexmk` defers to latexmk's own auto
/// build; the three `engine-*` recipes invoke the raw engine directly (which
/// helps MiKTeX installs that ship no working Perl/latexmk) with an optional
/// bibliography pass in between. Mirrors `project::VALID_BUILD_RECIPES`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildRecipe {
    #[default]
    #[serde(rename = "latexmk")]
    LatexmkAuto,
    EngineOnly,
    EngineBibtex,
    EngineBiber,
}

/// The bibliography tool a recipe runs between engine passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BibTool {
    Bibtex,
    Biber,
}

impl BibTool {
    fn binary(self) -> &'static str {
        match self {
            BibTool::Bibtex => "bibtex",
            BibTool::Biber => "biber",
        }
    }
}

/// Structured, validated build options resolved by the frontend from the global
/// compile settings + the project's `build` override. Every arg the compiler
/// receives is derived from these fields by a fixed match, never passed through.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOptions {
    #[serde(default)]
    pub engine: LatexEngine,
    #[serde(default)]
    pub recipe: BuildRecipe,
    #[serde(default)]
    pub shell_escape: bool,
    #[serde(default = "default_true")]
    pub synctex: bool,
    #[serde(default = "default_true")]
    pub halt_on_error: bool,
}

fn default_true() -> bool {
    true
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self {
            engine: LatexEngine::Pdflatex,
            recipe: BuildRecipe::LatexmkAuto,
            shell_escape: false,
            synctex: true,
            halt_on_error: true,
        }
    }
}

fn engine_latexmk_flag(engine: LatexEngine) -> &'static str {
    match engine {
        LatexEngine::Xelatex => "-xelatex",
        LatexEngine::Lualatex => "-lualatex",
        // pdflatex (tectonic never reaches the latexmk path).
        _ => "-pdf",
    }
}

fn engine_binary(engine: LatexEngine) -> &'static str {
    match engine {
        LatexEngine::Xelatex => "xelatex",
        LatexEngine::Lualatex => "lualatex",
        _ => "pdflatex",
    }
}

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
    options: Option<BuildOptions>,
) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;
    let opts = options.unwrap_or_default();

    // Shell-escape lets the document run arbitrary programs during compile, so
    // it's gated on a per-machine trust grant stored OUTSIDE the project (a
    // cloned project.json can't pre-grant itself). Requested-but-untrusted is a
    // hard error rather than a silent drop.
    let shell_escape = opts.shell_escape && crate::trust::is_shell_escape_granted(&app, &root);
    if opts.shell_escape && !shell_escape {
        return Err("shell-escape requested but this project is not trusted on this machine — approve it in the build menu".into());
    }

    let (log, success) = match opts.engine {
        // Tectonic runs its own bibliography passes, so the recipe is ignored
        // (the UI states this) — it always takes its own path.
        LatexEngine::Tectonic => {
            run_tectonic(&app, &root_file, &root, opts.synctex, shell_escape).await?
        }
        engine => {
            let root_for_cmd = root.clone();
            let root_file_for_cmd = root_file.clone();
            let recipe = opts.recipe;
            let halt = opts.halt_on_error;
            let synctex = opts.synctex;
            tokio::task::spawn_blocking(move || match recipe {
                BuildRecipe::LatexmkAuto => run_system_tex(
                    &root_file_for_cmd,
                    &root_for_cmd,
                    engine,
                    halt,
                    synctex,
                    shell_escape,
                ),
                BuildRecipe::EngineOnly => run_engine_recipe(
                    &root_file_for_cmd,
                    &root_for_cmd,
                    engine,
                    halt,
                    synctex,
                    shell_escape,
                    None,
                ),
                BuildRecipe::EngineBibtex => run_engine_recipe(
                    &root_file_for_cmd,
                    &root_for_cmd,
                    engine,
                    halt,
                    synctex,
                    shell_escape,
                    Some(BibTool::Bibtex),
                ),
                BuildRecipe::EngineBiber => run_engine_recipe(
                    &root_file_for_cmd,
                    &root_for_cmd,
                    engine,
                    halt,
                    synctex,
                    shell_escape,
                    Some(BibTool::Biber),
                ),
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

/// Build the shared flag list for a latexmk / direct-binary invocation. Every
/// entry is a compile-time constant; the engine only selects which are present.
fn system_tex_flags(
    engine_flag: Option<&'static str>,
    synctex: bool,
    halt_on_error: bool,
    shell_escape: bool,
) -> Vec<&'static str> {
    let mut args = Vec::new();
    if let Some(f) = engine_flag {
        args.push(f); // latexmk engine selector (-pdf / -xelatex / -lualatex)
    }
    if synctex {
        args.push("-synctex=1");
    }
    args.push("-interaction=nonstopmode");
    if halt_on_error {
        args.push("-halt-on-error");
    }
    if shell_escape {
        args.push("-shell-escape");
    }
    args
}

fn run_system_tex(
    root_file: &str,
    root: &Path,
    engine: LatexEngine,
    halt_on_error: bool,
    synctex: bool,
    shell_escape: bool,
) -> Result<(String, bool), String> {
    let mut accumulated_log = String::new();

    // Prefer latexmk (handles multiple passes, bibliography). If it isn't on
    // PATH, or it spawns but exits non-zero, fall back to the engine's direct
    // binary. MiKTeX on Windows sometimes ships latexmk without a usable Perl.
    // Spawn the absolute path resolved against PATH, never the bare name:
    // `current_dir(root)` would otherwise let Windows' CreateProcess execute a
    // planted `latexmk`/engine binary in a malicious project directory.
    if let Ok(latexmk) = which::which("latexmk") {
        let mut latexmk_args = system_tex_flags(
            Some(engine_latexmk_flag(engine)),
            synctex,
            halt_on_error,
            shell_escape,
        );
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
                    "\n[latexmk exit: {}]\n\n--- falling back to {} ---\n",
                    out.status,
                    engine_binary(engine),
                ));
            }
            Err(e) => {
                accumulated_log.push_str(&format!(
                    "[latexmk spawn failed: {}]\n\n--- falling back to {} ---\n",
                    e,
                    engine_binary(engine),
                ));
            }
        }
    }

    let bin_name = engine_binary(engine);
    let bin = match which::which(bin_name) {
        Ok(path) => path,
        Err(_) => {
            accumulated_log.push_str(&format!(
                "\nNo LaTeX engine on PATH ({bin_name} not found). Install MiKTeX/TeX Live or pick the Tectonic engine in the build menu."
            ));
            return Ok((accumulated_log, false));
        }
    };

    // Direct binary: same flags minus latexmk's engine selector.
    let mut bin_args = system_tex_flags(None, synctex, halt_on_error, shell_escape);
    bin_args.push(root_file);
    accumulated_log.push_str(&format!("\n$ {bin_name} {}\n", bin_args.join(" ")));
    let output = Command::new(&bin)
        .args(&bin_args)
        .current_dir(root)
        .output()
        .map_err(|e| {
            accumulated_log.push_str(&format!("[{bin_name} spawn failed: {}]\n", e));
            format!("compile failed:\n{}", accumulated_log)
        })?;
    accumulated_log.push_str(&merge_io(&output.stdout, &output.stderr));
    Ok((accumulated_log, output.status.success()))
}

/// One subprocess pass in a recipe. `program` is the logical tool name (engine
/// binary or `bibtex`/`biber`); the spawn resolves it to an absolute path via
/// `which` and runs THAT with `current_dir(root)` — never the bare name — so a
/// planted binary in a malicious project can't be reached (binary-planting RCE).
#[derive(Debug, Clone, PartialEq, Eq)]
struct CompilePass {
    program: String,
    args: Vec<String>,
    /// Engine passes gate `ok` and hard-fail on a missing binary; bib passes are
    /// best-effort (a missing bibtex/biber logs and continues).
    is_engine: bool,
}

/// The ordered pass list a recipe runs, as a pure function so the exact argument
/// vectors are unit-testable without spawning. Every arg is a compile-time
/// constant selected by a fixed match plus the validated positional file/stem —
/// the argument-injection invariant. `<base>` is the entry file stem (its last
/// component is already leading-dash-guarded by `validate_project_relative_path`).
fn recipe_passes(
    recipe: BuildRecipe,
    root_file: &str,
    engine: LatexEngine,
    halt_on_error: bool,
    synctex: bool,
    shell_escape: bool,
) -> Vec<CompilePass> {
    let base = Path::new(root_file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_file.to_string());
    let engine_pass = || {
        let mut args: Vec<String> = system_tex_flags(None, synctex, halt_on_error, shell_escape)
            .into_iter()
            .map(String::from)
            .collect();
        args.push(root_file.to_string());
        CompilePass {
            program: engine_binary(engine).to_string(),
            args,
            is_engine: true,
        }
    };
    let bib_pass = |tool: BibTool| CompilePass {
        program: tool.binary().to_string(),
        args: vec![base.clone()],
        is_engine: false,
    };
    match recipe {
        // latexmk is handled by run_system_tex, never this path.
        BuildRecipe::LatexmkAuto => vec![],
        BuildRecipe::EngineOnly => vec![engine_pass(), engine_pass()],
        BuildRecipe::EngineBibtex => vec![
            engine_pass(),
            bib_pass(BibTool::Bibtex),
            engine_pass(),
            engine_pass(),
        ],
        BuildRecipe::EngineBiber => vec![
            engine_pass(),
            bib_pass(BibTool::Biber),
            engine_pass(),
            engine_pass(),
        ],
    }
}

/// Run a curated recipe's fixed pass sequence directly against the raw engine
/// (no latexmk). Engine passes hard-fail on a missing engine; the bib pass is
/// best-effort — a missing/failing `bibtex`/`biber` logs a `[<tool> exit: …]`
/// line and continues (citations unresolved but the PDF still builds). `ok`
/// tracks the last engine pass's success (paired with the pdf-exists check in
/// `compile_latex`). Resolves each program to its absolute path via `which`,
/// mirroring `run_system_tex`, and spawns that with `current_dir(root)`.
fn run_engine_recipe(
    root_file: &str,
    root: &Path,
    engine: LatexEngine,
    halt_on_error: bool,
    synctex: bool,
    shell_escape: bool,
    bib: Option<BibTool>,
) -> Result<(String, bool), String> {
    let recipe = match bib {
        None => BuildRecipe::EngineOnly,
        Some(BibTool::Bibtex) => BuildRecipe::EngineBibtex,
        Some(BibTool::Biber) => BuildRecipe::EngineBiber,
    };
    let passes = recipe_passes(recipe, root_file, engine, halt_on_error, synctex, shell_escape);

    let mut log = String::new();
    let mut last_engine_ok = false;
    for pass in passes {
        let resolved = match which::which(&pass.program) {
            Ok(path) => path,
            Err(_) => {
                if pass.is_engine {
                    log.push_str(&format!(
                        "\nNo LaTeX engine on PATH ({} not found). Install MiKTeX/TeX Live or pick the Tectonic engine in the build menu.\n",
                        pass.program
                    ));
                    return Ok((log, false));
                }
                // Missing bib tool: unresolved citations, but keep building.
                log.push_str(&format!(
                    "\n[{} exit: not found on PATH — citations left unresolved]\n",
                    pass.program
                ));
                continue;
            }
        };
        log.push_str(&format!("\n$ {} {}\n", pass.program, pass.args.join(" ")));
        match Command::new(&resolved)
            .args(&pass.args)
            .current_dir(root)
            .output()
        {
            Ok(output) => {
                log.push_str(&merge_io(&output.stdout, &output.stderr));
                if pass.is_engine {
                    last_engine_ok = output.status.success();
                } else if !output.status.success() {
                    log.push_str(&format!("\n[{} exit: {}]\n", pass.program, output.status));
                }
            }
            Err(e) => {
                if pass.is_engine {
                    log.push_str(&format!("[{} spawn failed: {}]\n", pass.program, e));
                    return Err(format!("compile failed:\n{}", log));
                }
                log.push_str(&format!("\n[{} exit: spawn failed: {}]\n", pass.program, e));
            }
        }
    }
    Ok((log, last_engine_ok))
}

async fn run_tectonic(
    app: &tauri::AppHandle,
    root_file: &str,
    root: &Path,
    synctex: bool,
    shell_escape: bool,
) -> Result<(String, bool), String> {
    // --synctex emits the .synctex.gz alongside the PDF; harmless when the
    // user doesn't have the synctex CLI installed (forward/inverse return None).
    // `-Z shell-escape` is Tectonic's unstable opt-in; only added when granted.
    let mut tectonic_args: Vec<&str> = vec!["-X", "compile", root_file, "--keep-logs"];
    if synctex {
        tectonic_args.push("--synctex");
    }
    if shell_escape {
        tectonic_args.push("-Z");
        tectonic_args.push("shell-escape");
    }
    // Try the bundled sidecar first.
    let sidecar_result = app.shell().sidecar("binaries/tectonic");
    if let Ok(cmd) = sidecar_result {
        // `sidecar()` builds the Command without stat-ing the file, so a declared-
        // but-missing externalBin only fails at spawn time (e.g. dev before
        // `npm run fetch:tectonic`). Fall THROUGH to the PATH fallback on a spawn
        // error rather than hard-erroring — a `?` here would kill the fallback.
        match cmd.args(tectonic_args.clone()).current_dir(root).output().await {
            Ok(output) => {
                let ok = output.status.success();
                return Ok((merge_io(&output.stdout, &output.stderr), ok));
            }
            Err(_) => { /* sidecar binary not runnable — try PATH below */ }
        }
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
    let owned_args: Vec<String> = tectonic_args.iter().map(|s| s.to_string()).collect();
    tokio::task::spawn_blocking(move || {
        let output = Command::new(&tectonic)
            .args(&owned_args)
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
        } else if (trimmed.starts_with("Overfull") || trimmed.starts_with("Underfull"))
            && trimmed.contains("box")
        {
            // Boxes that don't fit — informational, not errors/warnings.
            out.push(Diagnostic {
                severity: "info".into(),
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
        } else if let Some(rest) = trimmed.strip_prefix("hint:") {
            ("info", rest.trim())
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
    fn parse_latex_log_flags_overfull_boxes_as_info() {
        let log = "Overfull \\hbox (12.3pt too wide) in paragraph at lines 5--6\n\
                   Underfull \\vbox (badness 10000) has occurred\nplain line\n";
        let diags = parse_latex_log(log, "main.tex");
        assert_eq!(diags.iter().filter(|d| d.severity == "info").count(), 2);
    }

    #[test]
    fn parse_typst_log_flags_hints_as_info() {
        let log = "error: unknown variable\nhint: did you mean `x`?\n";
        let diags = parse_typst_log(log, "main.typ");
        assert_eq!(diags.iter().filter(|d| d.severity == "info").count(), 1);
        assert_eq!(diags.iter().filter(|d| d.severity == "error").count(), 1);
    }

    #[test]
    fn recipe_passes_engine_only_runs_two_engine_passes() {
        let passes = recipe_passes(
            BuildRecipe::EngineOnly,
            "main.tex",
            LatexEngine::Pdflatex,
            true,
            true,
            false,
        );
        assert_eq!(passes.len(), 2);
        assert!(passes.iter().all(|p| p.is_engine && p.program == "pdflatex"));
        for p in &passes {
            assert_eq!(p.args.last().unwrap(), "main.tex");
            assert!(p.args.contains(&"-synctex=1".to_string()));
            assert!(p.args.contains(&"-halt-on-error".to_string()));
            assert!(!p.args.iter().any(|a| a == "-shell-escape"));
        }
    }

    #[test]
    fn recipe_passes_bibtex_sequence_is_engine_bib_engine_engine() {
        let passes = recipe_passes(
            BuildRecipe::EngineBibtex,
            "main.tex",
            LatexEngine::Lualatex,
            true,
            true,
            false,
        );
        assert_eq!(passes.len(), 4);
        assert_eq!(passes.iter().filter(|p| p.is_engine).count(), 3);
        assert!(passes.iter().filter(|p| p.is_engine).all(|p| p.program == "lualatex"));
        // The single bib pass runs `bibtex <stem>` with no other args.
        assert_eq!(passes[1].program, "bibtex");
        assert!(!passes[1].is_engine);
        assert_eq!(passes[1].args, vec!["main".to_string()]);
    }

    #[test]
    fn recipe_passes_biber_uses_biber_and_file_stem_base() {
        let passes = recipe_passes(
            BuildRecipe::EngineBiber,
            "sections/main.tex",
            LatexEngine::Xelatex,
            false,
            false,
            true,
        );
        assert_eq!(passes.len(), 4);
        assert_eq!(passes[1].program, "biber");
        // <base> is the entry's file stem (jobname), not the full subdir path.
        assert_eq!(passes[1].args, vec!["main".to_string()]);
        // Engine passes carry the full relative entry as the positional arg, and
        // shell-escape flows through from the (already trust-gated) bool.
        assert_eq!(passes[0].args.last().unwrap(), "sections/main.tex");
        assert!(passes[0].args.iter().any(|a| a == "-shell-escape"));
        // synctex=false / halt=false omit their flags.
        assert!(!passes[0].args.iter().any(|a| a == "-synctex=1"));
        assert!(!passes[0].args.iter().any(|a| a == "-halt-on-error"));
    }

    #[test]
    fn recipe_passes_latexmk_auto_has_no_direct_passes() {
        // latexmk defers to run_system_tex; this path must not synthesize passes.
        let passes = recipe_passes(
            BuildRecipe::LatexmkAuto,
            "main.tex",
            LatexEngine::Pdflatex,
            true,
            true,
            false,
        );
        assert!(passes.is_empty());
    }

    #[test]
    fn build_recipe_enum_matches_valid_recipes_list() {
        // Two-sided drift guard: every string in project::VALID_BUILD_RECIPES must
        // deserialize into a BuildRecipe, and the set sizes must match — so the
        // strict enum and the write-time validation list can't drift apart.
        use crate::project::VALID_BUILD_RECIPES;
        assert_eq!(VALID_BUILD_RECIPES.len(), 4);
        for raw in VALID_BUILD_RECIPES {
            let json = format!("\"{raw}\"");
            serde_json::from_str::<BuildRecipe>(&json)
                .unwrap_or_else(|_| panic!("recipe `{raw}` should deserialize into BuildRecipe"));
        }
        // Spot-check the exact mapping so a rename on either side is caught.
        assert_eq!(
            serde_json::from_str::<BuildRecipe>("\"latexmk\"").unwrap(),
            BuildRecipe::LatexmkAuto
        );
        assert_eq!(
            serde_json::from_str::<BuildRecipe>("\"engine-only\"").unwrap(),
            BuildRecipe::EngineOnly
        );
        assert_eq!(
            serde_json::from_str::<BuildRecipe>("\"engine-bibtex\"").unwrap(),
            BuildRecipe::EngineBibtex
        );
        assert_eq!(
            serde_json::from_str::<BuildRecipe>("\"engine-biber\"").unwrap(),
            BuildRecipe::EngineBiber
        );
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
