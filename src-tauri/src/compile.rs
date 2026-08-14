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

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

use crate::commands::checked_project_root_and_file;
use crate::project::Project;

type CmdResult<T> = Result<T, String>;

/// Hard ceiling per compiler subprocess. Generous — real multi-pass LaTeX
/// builds run minutes — but finite, so a malicious project (e.g. an infinite
/// `\loop` that `-halt-on-error` never trips) can't wedge the compile IPC.
const COMPILE_TIMEOUT: Duration = Duration::from_secs(600);
/// Per-stream cap on the leading capture. The merged log crosses the IPC
/// bridge as one string; unbounded capture is an OOM primitive for a
/// `\typeout` flood.
const COMPILE_OUTPUT_CAP: usize = 4 * 1024 * 1024;
/// Rolling window of the most recent output kept alongside the head: TeX puts
/// its fatal `! ...` lines at the END of a run, so a head-only cap would
/// discard exactly the bytes the Issues tab needs.
const COMPILE_TAIL_CAP: usize = 256 * 1024;
/// How long to keep draining pipes after the child exits or is killed — a
/// straggling grandchild holding the write end open must not become a hang.
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(5);

/// Stable marker string `compile_latex`/`compile_typst` reject with when the
/// run was cancelled via `compile_cancel`. The frontend keys on it verbatim
/// (commands reject with the plain Display string) to return the UI to idle
/// instead of surfacing an error. Mirrored by `COMPILE_CANCELLED` in
/// `src/commands/compile-runner.ts` — keep the two in sync.
pub const COMPILE_CANCELLED: &str = "compile-cancelled";

/// Caller-supplied compile ids key a process-global map, so bound them like
/// AI stream ids: short ASCII only, no metacharacters, no unbounded growth.
const MAX_COMPILE_ID_LEN: usize = 64;

fn validate_compile_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_COMPILE_ID_LEN
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("invalid compile id".into());
    }
    Ok(())
}

/// In-flight compiles keyed by the caller-supplied compile id. The watch
/// sender fans the cancel flag out to every subprocess pass of that compile;
/// removing it (deregistration) makes any pending wait pend forever, which is
/// fine — the compile is already over.
fn active_compiles() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static MAP: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deregisters the compile id on drop, so every exit path (success, error,
/// early `?`) releases the handle and a cancel for a finished compile stays a
/// quiet no-op instead of poking a stale entry.
struct CancelRegistration(Option<String>);

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        if let Some(id) = self.0.take()
            && let Ok(mut map) = active_compiles().lock()
        {
            map.remove(&id);
        }
    }
}

/// Register an optional caller-supplied compile id and hand back the receiver
/// its subprocess passes select on. `None` id = a legacy caller that never
/// cancels; the run proceeds with no handle.
fn register_compile(
    compile_id: Option<String>,
) -> Result<(Option<watch::Receiver<bool>>, CancelRegistration), String> {
    let Some(id) = compile_id else {
        return Ok((None, CancelRegistration(None)));
    };
    validate_compile_id(&id)?;
    let (tx, rx) = watch::channel(false);
    let mut map = active_compiles().lock().unwrap();
    // A duplicate would orphan the first registration's cancel handle.
    if map.contains_key(&id) {
        return Err("a compile with this id is already running".into());
    }
    map.insert(id.clone(), tx);
    drop(map);
    Ok((Some(rx), CancelRegistration(Some(id))))
}

/// Resolves when the compile's cancel flag fires; pends forever when the run
/// has no cancel handle (no compileId supplied, or the sender already gone).
async fn wait_cancelled(rx: &mut Option<watch::Receiver<bool>>) {
    let Some(rx) = rx else {
        return std::future::pending().await;
    };
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

/// Cancel an in-flight compile by id. Quietly succeeds when the id is not
/// registered — the compile finishing just before the click is a normal race,
/// not an error.
#[tauri::command]
pub async fn compile_cancel(compile_id: String) -> CmdResult<()> {
    validate_compile_id(&compile_id)?;
    if let Some(tx) = active_compiles().lock().unwrap().get(&compile_id) {
        let _ = tx.send(true);
    }
    Ok(())
}

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
    /// Tectonic `--only-cached`. `None` = not stated by the caller; the
    /// persisted `compile.strictOffline` setting then decides (default off).
    #[serde(default)]
    pub strict_offline: Option<bool>,
    /// Chapter-draft build: only the named `\include` targets are typeset
    /// (`\includeonly{...}`), reusing the full build's `.aux` set for the rest.
    /// Names are project-relative include stems (`chapters/ch010`), validated
    /// against a strict grammar before they reach the engine command line.
    /// `None`/empty = a normal full build.
    #[serde(default, rename = "includeOnly")]
    pub include_only: Option<Vec<String>>,
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
            strict_offline: None,
            include_only: None,
        }
    }
}

/// The non-empty, validated `\includeonly` targets, or None. Every name must be
/// a project-relative include stem made of the SAME safe characters as a
/// project-relative path AND free of any TeX-special byte — the names are
/// spliced into `\includeonly{...}` TeX code on the command line, so a stray
/// `\`, `{`, `}`, `$`, `%`, `#`, `~`, `^`, `&`, or a leading `-` would be code
/// injection or argument injection, not a filename. (Mirrors the leading-dash
/// rule in the security invariants; documented there.)
fn validated_include_only(opts: &BuildOptions) -> Result<Option<Vec<String>>, String> {
    let Some(raw) = &opts.include_only else {
        return Ok(None);
    };
    let names: Vec<&String> = raw.iter().filter(|n| !n.trim().is_empty()).collect();
    if names.is_empty() {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let n = name.trim();
        if n.starts_with('-')
            || n.starts_with('/')
            || n.contains("..")
            || n.bytes().any(|b| {
                matches!(
                    b,
                    b'\\' | b'{' | b'}' | b'$' | b'%' | b'#' | b'~' | b'^' | b'&' | b'"'
                ) || b.is_ascii_control()
            })
            || n.contains(':')
        {
            return Err(format!("unsafe \\includeonly target: {n}"));
        }
        out.push(n.to_string());
    }
    Ok(Some(out))
}

/// The positional/input arguments an engine pass takes. Normally just the root
/// file. For a chapter draft, `-jobname=<stem>` plus a code argument that
/// declares `\includeonly{...}` before `\input`ing the root — so the source is
/// never edited and the jobname (hence `.aux`/`.pdf` names) stays the root's.
fn engine_input_args(root_file: &str, include_only: &Option<Vec<String>>) -> Vec<String> {
    match include_only {
        Some(names) if !names.is_empty() => {
            let stem = Path::new(root_file)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_file.to_string());
            let list = names.join(",");
            vec![
                format!("-jobname={stem}"),
                format!("\\includeonly{{{list}}}\\input{{{stem}}}"),
            ]
        }
        _ => vec![root_file.to_string()],
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

/// Strict-offline compiles: the caller may state it per build, otherwise the
/// persisted `compile.strictOffline` setting decides. Unset anywhere = OFF, so
/// a cold Tectonic cache can still fetch the packages a document asks for.
fn strict_offline(app: &tauri::AppHandle, opts: &BuildOptions) -> bool {
    opts.strict_offline.unwrap_or_else(|| {
        crate::settings::load(app)
            .ok()
            .and_then(|s| s.compile.strict_offline)
            .unwrap_or(false)
    })
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
    /// True when the build succeeded but left the output PDF byte-identical
    /// (a no-op recompile). The frontend then skips the viewer reload.
    #[serde(rename = "pdfUnchanged", default)]
    pub pdf_unchanged: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub file: String,
    pub line: u32,
    pub source: String,
    /// How `file` was attributed, which decides whether it is a jump target:
    /// - "project": validated project-relative path — jumpable.
    /// - "root-fallback": attribution unknown, `file` is the entry file.
    /// - "external": a distro/package file outside the project (`file` is its
    ///   basename); no jump target, collapsed by default in the UI.
    pub scope: String,
}

/// Auxiliary-artifact extensions latexmk/pdflatex regenerate freely. A stale
/// `.aux` from a bibliography-backend switch is the classic wedge: it carries
/// macros (`\abx@aux@...`) the new preamble no longer defines, every rerun
/// fails at `\begin{document}`, and latexmk exits 12 with "gave an error in
/// previous invocation" while claiming everything is up to date.
const CLEANABLE_EXTS: &[&str] = &[
    "aux",
    "bbl",
    "bcf",
    "blg",
    "fls",
    "fdb_latexmk",
    "log",
    "out",
    "toc",
    "lof",
    "lot",
    "nav",
    "snm",
    "vrb",
    "idx",
    "ilg",
    "ind",
    "run.xml",
    "synctex",
    "synctex.gz",
];

/// Deletes LaTeX auxiliary build files: the root file's artifact set plus
/// every `.aux` in the project tree (multi-file documents leave one per
/// `\include`d chapter). The compiled PDF is left alone. Registered-root
/// gated via `checked_project_root_and_file`; symlinks are not followed.
#[tauri::command]
pub async fn compile_clean(project: Project) -> CmdResult<u32> {
    let (root, root_file) = checked_project_root_and_file(&project)?;
    tokio::task::spawn_blocking(move || {
        let mut removed = 0u32;
        // Two artifact locations, because the engines disagree: latexmk and the
        // raw engines write `<jobname>.ext` into the CWD (the project root)
        // while Tectonic writes beside the source. For a root file at the top
        // level these are the same path; for a nested one they differ, and
        // cleaning only the source-adjacent set left the real artifacts behind.
        let mut bases = vec![root.join(&root_file)];
        let root_level = root.join(latex_output_rel(&root_file, LatexEngine::Pdflatex));
        if !bases.contains(&root_level) {
            bases.push(root_level);
        }
        for base in &bases {
            for ext in CLEANABLE_EXTS {
                let p = base.with_extension(ext);
                if p.is_file() && std::fs::remove_file(&p).is_ok() {
                    removed += 1;
                }
            }
        }
        remove_aux_recursive(&root, 0, &mut removed);
        Ok::<u32, String>(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn remove_aux_recursive(dir: &std::path::Path, depth: u32, removed: &mut u32) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            remove_aux_recursive(&path, depth + 1, removed);
        } else if meta.is_file()
            && path.extension().is_some_and(|e| e == "aux")
            && std::fs::remove_file(&path).is_ok()
        {
            *removed += 1;
        }
    }
}

/// Finds the PDF a previous build left on disk without compiling anything.
/// The engines disagree on where output lands — latexmk and the raw engines
/// write `<stem>.pdf` into the project root, Tectonic (and typst) beside the
/// source file, texlive-wasm under `.typeward/build/` — so all three spots
/// are probed and the newest regular file wins. Registered-root gated via
/// `checked_project_root_and_file`; symlinks are rejected. Lets a freshly
/// opened project seed its preview from the last build instead of showing an
/// empty pane until a full recompile.
#[tauri::command]
pub async fn probe_last_build_output(project: Project) -> CmdResult<Option<String>> {
    let (root, root_file) = checked_project_root_and_file(&project)?;
    tokio::task::spawn_blocking(move || {
        let stem = Path::new(&root_file)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| root_file.clone());
        let mut candidates = vec![
            root.join(latex_output_rel(&root_file, LatexEngine::Pdflatex)),
            root.join(replace_ext(&root_file, "pdf")),
            root.join(".typeward")
                .join("build")
                .join(format!("{stem}.pdf")),
        ];
        candidates.dedup();
        let newest = candidates
            .into_iter()
            .filter_map(|p| {
                let meta = std::fs::symlink_metadata(&p).ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((p, meta.modified().ok()?))
            })
            .max_by_key(|(_, mtime)| *mtime);
        Ok::<Option<String>, String>(newest.map(|(p, _)| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Exposes the existing `parse_latex_log` diagnostic extractor over IPC
/// so the WASM CompileProvider can produce diagnostics in the same
/// shape as the desktop path without duplicating the parser in TS.
/// `project_root` enables path validation for file attribution, but only
/// when it names a root the user actually opened — an unregistered root is
/// ignored rather than handing the renderer an existence-probe primitive.
#[tauri::command]
pub async fn parse_latex_log_cmd(
    log: String,
    entry: String,
    project_root: Option<String>,
) -> Vec<Diagnostic> {
    let root = project_root
        .map(std::path::PathBuf::from)
        .filter(|r| crate::project::is_registered_root(r));
    // A full texlive-wasm log can run to megabytes; scan it off the event loop.
    tokio::task::spawn_blocking(move || parse_latex_log(&log, &entry, root.as_deref()))
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
    compile_id: Option<String>,
) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;
    let opts = options.unwrap_or_default();
    // Registered for the whole command; the guard deregisters on every exit
    // path so `compile_cancel` on a finished id stays a quiet no-op.
    let (cancel, _cancel_registration) = register_compile(compile_id)?;

    // Shell-escape lets the document run arbitrary programs during compile, so
    // it's gated on a per-machine trust grant stored OUTSIDE the project (a
    // cloned project.json can't pre-grant itself). Requested-but-untrusted is a
    // hard error rather than a silent drop.
    let shell_escape = opts.shell_escape && crate::trust::is_shell_escape_granted(&app, &root);
    if opts.shell_escape && !shell_escape {
        return Err("shell-escape requested but this project is not trusted on this machine — approve it in the build menu".into());
    }

    // Validate any chapter-draft `\includeonly` targets before they can reach
    // the engine command line (argument/code injection guard).
    let include_only = validated_include_only(&opts)?;

    // Live log streaming to the LogsDrawer while the build runs. One event
    // name is enough: the frontend serializes compiles (compileState guard),
    // and the listener is scoped to the active attempt.
    let sink = Some(LogSink::tauri(app.clone(), "compile:log"));

    // Snapshot the output PDF's identity before the build so a no-op recompile
    // (latexmk "Nothing to do") can be detected: an unchanged PDF must not
    // trigger a viewer reload, which is otherwise most of a no-op's wall time.
    let pdf_path_pre = root.join(latex_output_rel(&root_file, opts.engine));
    let pdf_sig_before = pdf_signature(&pdf_path_pre);

    let (log, success) = if include_only.is_some() {
        // Chapter draft: always the direct engine (latexmk's fingerprinting and
        // the `\includeonly…\input` code-argument form don't compose), two
        // engine passes, and NO bib pass — the prior full build's `.bbl` is
        // reused (drafts want speed; the plan's fallback documents the
        // "citations may renumber" caveat that the UI badge carries).
        match opts.engine {
            LatexEngine::Tectonic => {
                return Err(
                    "chapter drafts need a latexmk/pdflatex engine (Tectonic has no \\includeonly fast path)"
                        .into(),
                );
            }
            engine => {
                run_engine_recipe(
                    &root_file,
                    &root,
                    engine,
                    opts.halt_on_error,
                    opts.synctex,
                    shell_escape,
                    None,
                    &cancel,
                    sink,
                    &include_only,
                )
                .await?
            }
        }
    } else {
        match opts.engine {
            // Tectonic runs its own bibliography passes, so the recipe is
            // ignored (the UI states this) — it always takes its own path.
            LatexEngine::Tectonic => {
                run_tectonic(
                    &app,
                    &root_file,
                    &root,
                    opts.synctex,
                    shell_escape,
                    strict_offline(&app, &opts),
                    &cancel,
                    sink,
                )
                .await?
            }
            engine => match opts.recipe {
                BuildRecipe::LatexmkAuto => {
                    run_system_tex(
                        &root_file,
                        &root,
                        engine,
                        opts.halt_on_error,
                        opts.synctex,
                        shell_escape,
                        &cancel,
                        sink,
                    )
                    .await?
                }
                BuildRecipe::EngineOnly => {
                    run_engine_recipe(
                        &root_file,
                        &root,
                        engine,
                        opts.halt_on_error,
                        opts.synctex,
                        shell_escape,
                        None,
                        &cancel,
                        sink,
                        &None,
                    )
                    .await?
                }
                BuildRecipe::EngineBibtex => {
                    run_engine_recipe(
                        &root_file,
                        &root,
                        engine,
                        opts.halt_on_error,
                        opts.synctex,
                        shell_escape,
                        Some(BibTool::Bibtex),
                        &cancel,
                        sink,
                        &None,
                    )
                    .await?
                }
                BuildRecipe::EngineBiber => {
                    run_engine_recipe(
                        &root_file,
                        &root,
                        engine,
                        opts.halt_on_error,
                        opts.synctex,
                        shell_escape,
                        Some(BibTool::Biber),
                        &cancel,
                        sink,
                        &None,
                    )
                    .await?
                }
            },
        }
    };

    let pdf_path = root.join(latex_output_rel(&root_file, opts.engine));
    let ok = success && pdf_path.exists();
    let diagnostics = parse_latex_log(&log, &root_file, Some(&root));
    // A successful build whose PDF is byte-for-byte the one already on disk
    // (latexmk decided nothing changed) needs no viewer reload — the frontend
    // skips bumping pdfVersion, which is most of a no-op recompile's cost.
    let pdf_unchanged =
        ok && pdf_signature(&pdf_path) == pdf_sig_before && pdf_sig_before.is_some();

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
        pdf_unchanged,
    })
}

/// A cheap identity for the output PDF (mtime + size) used to detect a no-op
/// recompile. `None` when the file is absent; two equal `Some` values mean the
/// build did not rewrite it. Not a content hash — latexmk rewrites the PDF
/// (new timestamp) whenever it actually recompiles, so mtime+size is a
/// sufficient and O(1) discriminator.
fn pdf_signature(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((meta.len(), mtime))
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

/// What a bounded compiler run produced. `status: None` with `timed_out` set
/// means the deadline killed it; `cancelled` means the user's cancel flag
/// killed it first. Partial output is still captured either way.
pub(crate) struct BoundedOutput {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) status: Option<std::process::ExitStatus>,
    pub(crate) timed_out: bool,
    pub(crate) cancelled: bool,
}

impl BoundedOutput {
    pub(crate) fn success(&self) -> bool {
        self.status.map(|s| s.success()).unwrap_or(false)
    }

    fn exit_display(&self) -> String {
        self.status
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unknown".into())
    }
}

/// Two-ended bounded capture: the first `head_cap` bytes verbatim plus a
/// rolling window of the most recent `tail_cap` bytes, with everything in
/// between counted rather than stored. TeX's fatal `! ...` lines land at the
/// END of a run, so a head-only cap would discard exactly the bytes the
/// Issues tab needs, while the head preserves the command echo and early
/// context. Appends stay accepted past the caps so the child never blocks on
/// a full pipe (which would turn every big-output build into a timeout).
#[derive(Default)]
struct CappedBuffer {
    head: Vec<u8>,
    head_cap: usize,
    tail: VecDeque<u8>,
    tail_cap: usize,
    omitted: u64,
}

impl CappedBuffer {
    fn new(head_cap: usize, tail_cap: usize) -> Self {
        Self {
            head_cap,
            tail_cap,
            ..Self::default()
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        if self.head.len() < self.head_cap {
            let take = rest.len().min(self.head_cap - self.head.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if rest.is_empty() {
            return;
        }
        if rest.len() >= self.tail_cap {
            self.omitted += (self.tail.len() + rest.len() - self.tail_cap) as u64;
            self.tail.clear();
            self.tail.extend(&rest[rest.len() - self.tail_cap..]);
            return;
        }
        let evict = (self.tail.len() + rest.len()).saturating_sub(self.tail_cap);
        if evict > 0 {
            self.tail.drain(..evict);
            self.omitted += evict as u64;
        }
        self.tail.extend(rest);
    }

    /// Merge head and tail into the final log bytes. A contiguous capture
    /// (nothing evicted) concatenates losslessly with no marker; a gap trims
    /// dangling multi-byte UTF-8 fragments at the seam (the log gets
    /// string-ified later) and names the omitted byte count.
    fn finalize(mut self) -> Vec<u8> {
        if self.omitted == 0 {
            self.head.extend(self.tail);
            return self.head;
        }
        self.omitted += trim_partial_utf8_suffix(&mut self.head) as u64;
        while self
            .tail
            .front()
            .is_some_and(|b| (*b & 0b1100_0000) == 0b1000_0000)
        {
            self.tail.pop_front();
            self.omitted += 1;
        }
        let mut out = self.head;
        out.extend_from_slice(
            format!("\n[output truncated — {} bytes omitted]\n", self.omitted).as_bytes(),
        );
        out.extend(self.tail);
        out
    }
}

/// Drop a trailing incomplete UTF-8 sequence (at most 3 bytes) so a hard cap
/// can't leave half a multi-byte char before the seam. Returns the number of
/// bytes removed; invalid bytes elsewhere are left for `from_utf8_lossy`.
fn trim_partial_utf8_suffix(buf: &mut Vec<u8>) -> usize {
    let len = buf.len();
    let start = len.saturating_sub(4);
    let Some(offset) = buf[start..]
        .iter()
        .rposition(|b| (b & 0b1100_0000) != 0b1000_0000)
    else {
        return 0;
    };
    let pos = start + offset;
    let seq_len = match buf[pos] {
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        // ASCII is always complete; invalid leads are left for lossy decode.
        _ => return 0,
    };
    if pos + seq_len > len {
        buf.truncate(pos);
        len - pos
    } else {
        0
    }
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    mut pipe: R,
    buf: Arc<Mutex<CappedBuffer>>,
    sink: Option<Arc<LogSink>>,
) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.lock().unwrap().append(&chunk[..n]);
                if let Some(s) = &sink {
                    s.push(&chunk[..n]);
                }
            }
        }
    }
}

/// Streams compile output to a consumer while the subprocess runs. Shared by
/// both pipe readers; flushes at 64 KiB or 100 ms of accumulation — per-read
/// emission is exactly the event storm the watcher's coalesce window exists
/// to prevent. Chunk boundaries may split a UTF-8 sequence; the lossy
/// conversion only affects the LIVE view — the final log goes through
/// `CappedBuffer`, which trims partial sequences properly.
///
/// Deliberately Tauri-free: it holds an emit closure, not an `AppHandle`, so
/// `run_bounded` (reachable from `synctex`/`export_pandoc` and every test
/// module) never names the window runtime. The Tauri wiring lives in the
/// command entry points, which build the sink via [`LogSink::tauri`].
pub(crate) struct LogSink {
    emit: Box<dyn Fn(String) + Send + Sync>,
    buf: Mutex<(String, Instant)>,
}

impl LogSink {
    pub(crate) fn new(emit: impl Fn(String) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            emit: Box::new(emit),
            buf: Mutex::new((String::new(), Instant::now())),
        })
    }

    /// Builds a sink that emits each chunk to the main window on `event`.
    pub(crate) fn tauri(app: tauri::AppHandle, event: impl Into<String>) -> Arc<Self> {
        let event = event.into();
        Self::new(move |text| {
            use tauri::Emitter;
            let _ = app.emit_to(crate::ipc_guard::MAIN_LABEL, &event, text);
        })
    }

    fn push(&self, chunk: &[u8]) {
        let text = {
            let mut g = self.buf.lock().unwrap();
            g.0.push_str(&String::from_utf8_lossy(chunk));
            if g.0.len() < 64 * 1024 && g.1.elapsed() < Duration::from_millis(100) {
                return;
            }
            g.1 = Instant::now();
            std::mem::take(&mut g.0)
        };
        (self.emit)(text);
    }

    pub(crate) fn flush(&self) {
        let text = {
            let mut g = self.buf.lock().unwrap();
            if g.0.is_empty() {
                return;
            }
            std::mem::take(&mut g.0)
        };
        (self.emit)(text);
    }
}

/// `taskkill /T` takes the whole tree down — latexmk's spawned engine would
/// survive a plain kill of latexmk itself and keep the pipes (and CPU) alive.
#[cfg(windows)]
async fn kill_tree_windows(pid: u32) {
    let Ok(system_root) = std::env::var("SystemRoot") else {
        return;
    };
    let taskkill = Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let mut cmd = tokio::process::Command::new(taskkill);
    cmd.args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::detect::hide_console_async(&mut cmd);
    let _ = cmd.status().await;
}

async fn kill_compile_child(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        kill_tree_windows(pid).await;
    }
    // The child was made a group leader at spawn (pre_exec setsid), so
    // signalling the negative pid takes the whole group down — latexmk's
    // engine grandchild included — before the single-process fallback kill.
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Spawn a compiler subprocess with piped, head+tail cap-bounded output and a
/// hard deadline. `Err` is a spawn failure (callers treat it exactly like the
/// old `Command::output()` spawn error); a timeout comes back as `Ok` with
/// `timed_out` set so the partial log still reaches the LogsDrawer. A fired
/// `cancel` flag reuses the exact same kill machinery and comes back as `Ok`
/// with `cancelled` set; the timeout semantics are untouched.
pub(crate) async fn run_bounded(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    cap: usize,
    mut cancel: Option<watch::Receiver<bool>>,
    sink: Option<Arc<LogSink>>,
) -> Result<BoundedOutput, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::detect::hide_console_async(&mut cmd);
    // Own process group per compiler child: latexmk's real work happens in an
    // engine grandchild that would survive a kill of latexmk alone, spinning
    // at full CPU forever. setsid cannot fail here (a freshly forked child is
    // never already a group leader); if it somehow did, the timeout degrades
    // to the single-process kill. Windows gets the same via taskkill /T.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(err)?;

    // Readers run as detached tasks over shared buffers so a timeout can
    // still harvest whatever was captured before the kill. The tail window
    // never exceeds the head budget so test-sized caps stay meaningful.
    let tail_cap = cap.min(COMPILE_TAIL_CAP);
    let stdout_buf = Arc::new(Mutex::new(CappedBuffer::new(cap, tail_cap)));
    let stderr_buf = Arc::new(Mutex::new(CappedBuffer::new(cap, tail_cap)));
    let stdout_task = child
        .stdout
        .take()
        .map(|pipe| tokio::spawn(read_capped(pipe, Arc::clone(&stdout_buf), sink.clone())));
    let stderr_task = child
        .stderr
        .take()
        .map(|pipe| tokio::spawn(read_capped(pipe, Arc::clone(&stderr_buf), sink.clone())));

    // The select handlers only classify the outcome — `child.wait()` holds a
    // mutable borrow of `child` for as long as the select's futures live, so
    // the kill (which needs `&mut child` again) must run after the select.
    enum WaitOutcome {
        Exited(std::io::Result<std::process::ExitStatus>),
        TimedOut,
        Cancelled,
    }
    let outcome = tokio::select! {
        waited = tokio::time::timeout(timeout, child.wait()) => match waited {
            Ok(result) => WaitOutcome::Exited(result),
            Err(_) => WaitOutcome::TimedOut,
        },
        _ = wait_cancelled(&mut cancel) => WaitOutcome::Cancelled,
    };
    let (status, timed_out, was_cancelled) = match outcome {
        WaitOutcome::Exited(Ok(status)) => (Some(status), false, false),
        WaitOutcome::Exited(Err(e)) => {
            kill_compile_child(&mut child).await;
            return Err(format!("failed to wait on {}: {}", program.display(), e));
        }
        WaitOutcome::TimedOut => {
            kill_compile_child(&mut child).await;
            (None, true, false)
        }
        WaitOutcome::Cancelled => {
            kill_compile_child(&mut child).await;
            (None, false, true)
        }
    };

    let drain = async {
        if let Some(task) = stdout_task {
            let _ = task.await;
        }
        if let Some(task) = stderr_task {
            let _ = task.await;
        }
    };
    let _ = tokio::time::timeout(PIPE_DRAIN_GRACE, drain).await;

    // A lingering reader past the drain grace appends into the zero-cap
    // default left behind by `take`, so its writes stay bounded and ignored.
    let stdout = std::mem::take(&mut *stdout_buf.lock().unwrap()).finalize();
    let stderr = std::mem::take(&mut *stderr_buf.lock().unwrap()).finalize();
    if let Some(s) = &sink {
        s.flush();
    }
    Ok(BoundedOutput {
        stdout,
        stderr,
        status,
        timed_out,
        cancelled: was_cancelled,
    })
}

/// `! `-prefixed so `parse_latex_log` lifts the timeout into an error
/// diagnostic in the Issues tab.
fn latex_timeout_line(tool: &str) -> String {
    format!(
        "\n! {tool} timed out after {} minutes — build aborted.\n",
        COMPILE_TIMEOUT.as_secs() / 60
    )
}

#[allow(clippy::too_many_arguments)]
async fn run_system_tex(
    root_file: &str,
    root: &Path,
    engine: LatexEngine,
    halt_on_error: bool,
    synctex: bool,
    shell_escape: bool,
    cancel: &Option<watch::Receiver<bool>>,
    sink: Option<Arc<LogSink>>,
) -> Result<(String, bool), String> {
    let mut accumulated_log = String::new();

    // Prefer latexmk (handles multiple passes, bibliography). If it isn't on
    // PATH, or it spawns but exits non-zero, fall back to the engine's direct
    // binary. MiKTeX on Windows sometimes ships latexmk without a usable Perl.
    // Spawn the absolute path resolved against PATH, never the bare name:
    // `current_dir(root)` would otherwise let Windows' CreateProcess execute a
    // planted `latexmk`/engine binary in a malicious project directory.
    if let Ok(latexmk) = crate::detect::resolve_program("latexmk") {
        let mut latexmk_args: Vec<String> = system_tex_flags(
            Some(engine_latexmk_flag(engine)),
            synctex,
            halt_on_error,
            shell_escape,
        )
        .into_iter()
        .map(String::from)
        .collect();
        latexmk_args.push(root_file.to_string());
        accumulated_log.push_str(&format!("$ latexmk {}\n", latexmk_args.join(" ")));
        match run_bounded(
            &latexmk,
            &latexmk_args,
            root,
            COMPILE_TIMEOUT,
            COMPILE_OUTPUT_CAP,
            cancel.clone(),
            sink.clone(),
        )
        .await
        {
            Ok(out) => {
                accumulated_log.push_str(&merge_io(&out.stdout, &out.stderr));
                // The user asked for the whole build to stop — never fall back.
                if out.cancelled {
                    return Err(COMPILE_CANCELLED.into());
                }
                // A timeout must NOT fall back to the direct engine — that
                // would double the worst-case wait for the same document.
                if out.timed_out {
                    accumulated_log.push_str(&latex_timeout_line("latexmk"));
                    return Ok((accumulated_log, false));
                }
                if out.success() {
                    return Ok((accumulated_log, true));
                }
                accumulated_log.push_str(&format!(
                    "\n[latexmk exit: {}]\n\n--- falling back to {} ---\n",
                    out.exit_display(),
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
    let bin = match crate::detect::resolve_program(bin_name) {
        Ok(path) => path,
        Err(_) => {
            accumulated_log.push_str(&format!(
                "\nNo LaTeX engine on PATH ({bin_name} not found). Install MiKTeX/TeX Live or pick the Tectonic engine in the build menu."
            ));
            return Ok((accumulated_log, false));
        }
    };

    // Direct binary: same flags minus latexmk's engine selector.
    let mut bin_args: Vec<String> = system_tex_flags(None, synctex, halt_on_error, shell_escape)
        .into_iter()
        .map(String::from)
        .collect();
    bin_args.push(root_file.to_string());
    accumulated_log.push_str(&format!("\n$ {bin_name} {}\n", bin_args.join(" ")));
    let output = match run_bounded(
        &bin,
        &bin_args,
        root,
        COMPILE_TIMEOUT,
        COMPILE_OUTPUT_CAP,
        cancel.clone(),
        sink.clone(),
    )
    .await
    {
        Ok(out) => out,
        Err(e) => {
            accumulated_log.push_str(&format!("[{bin_name} spawn failed: {}]\n", e));
            return Err(format!("compile failed:\n{}", accumulated_log));
        }
    };
    accumulated_log.push_str(&merge_io(&output.stdout, &output.stderr));
    if output.cancelled {
        return Err(COMPILE_CANCELLED.into());
    }
    if output.timed_out {
        accumulated_log.push_str(&latex_timeout_line(bin_name));
        return Ok((accumulated_log, false));
    }
    Ok((accumulated_log, output.success()))
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
#[allow(clippy::too_many_arguments)]
fn recipe_passes(
    recipe: BuildRecipe,
    root_file: &str,
    engine: LatexEngine,
    halt_on_error: bool,
    synctex: bool,
    shell_escape: bool,
    include_only: &Option<Vec<String>>,
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
        // The positional file, or a chapter-draft `-jobname=<stem>` +
        // `\includeonly{...}\input{stem}` code argument (fixed shape;
        // names pre-validated in `validated_include_only`).
        args.extend(engine_input_args(root_file, include_only));
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
// Recipe assembly threads the build knobs positionally; a params struct here
// would just relocate the same fields without improving the call site.
#[allow(clippy::too_many_arguments)]
async fn run_engine_recipe(
    root_file: &str,
    root: &Path,
    engine: LatexEngine,
    halt_on_error: bool,
    synctex: bool,
    shell_escape: bool,
    bib: Option<BibTool>,
    cancel: &Option<watch::Receiver<bool>>,
    sink: Option<Arc<LogSink>>,
    include_only: &Option<Vec<String>>,
) -> Result<(String, bool), String> {
    let recipe = match bib {
        None => BuildRecipe::EngineOnly,
        Some(BibTool::Bibtex) => BuildRecipe::EngineBibtex,
        Some(BibTool::Biber) => BuildRecipe::EngineBiber,
    };
    let passes = recipe_passes(
        recipe,
        root_file,
        engine,
        halt_on_error,
        synctex,
        shell_escape,
        include_only,
    );

    let mut log = String::new();
    let mut last_engine_ok = false;
    for pass in passes {
        let resolved = match crate::detect::resolve_program(&pass.program) {
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
        match run_bounded(
            &resolved,
            &pass.args,
            root,
            COMPILE_TIMEOUT,
            COMPILE_OUTPUT_CAP,
            cancel.clone(),
            sink.clone(),
        )
        .await
        {
            Ok(output) => {
                let merged = merge_io(&output.stdout, &output.stderr);
                log.push_str(&merged);
                // A cancel aborts the whole recipe, not just the current pass.
                if output.cancelled {
                    return Err(COMPILE_CANCELLED.into());
                }
                // A timed-out pass aborts the whole recipe — the best-effort
                // continue is for missing/failed bib tools, not runaway ones.
                if output.timed_out {
                    log.push_str(&latex_timeout_line(&pass.program));
                    return Ok((log, false));
                }
                if pass.is_engine {
                    last_engine_ok = output.success();
                    // An engine pass that aborted WITHOUT producing a PDF
                    // poisons everything after it: bibtex reads a truncated
                    // .aux, and each rerun re-reports the same errors into the
                    // concatenated log (duplicate cards, broken line
                    // attribution). Later passes exist only to settle
                    // references — there is nothing to settle without a
                    // document. Recoverable nonstopmode errors still emit a
                    // PDF and keep the full sequence, so compile-with-errors
                    // workflows are unaffected.
                    if !last_engine_ok && merged.contains("no output PDF file produced") {
                        return Ok((log, false));
                    }
                } else if !output.success() {
                    log.push_str(&format!(
                        "\n[{} exit: {}]\n",
                        pass.program,
                        output.exit_display()
                    ));
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

/// Tectonic's argv for one compile. Pure so both spawn paths (bundled sidecar,
/// PATH fallback) and the tests share one construction.
///
/// `--untrusted` puts Tectonic in its hardened mode: the document loses the
/// capabilities that reach the machine (shell-escape, writing outside the
/// output dir). It is applied by default — a `.tex` file is attacker-supplied
/// content — but NOT when the user has granted shell-escape for this project
/// (`trust.rs`), because untrusted mode refuses `-Z shell-escape` outright and
/// the two together would silently break a trusted build. Trust is the explicit,
/// per-machine opt-out; everything else compiles untrusted.
///
/// `--only-cached` makes the run strictly offline (no bundle fetches).
fn tectonic_args(
    root_file: &str,
    synctex: bool,
    shell_escape: bool,
    strict_offline: bool,
) -> Vec<&str> {
    let mut args: Vec<&str> = vec!["-X", "compile", root_file, "--keep-logs"];
    // --synctex emits the .synctex.gz alongside the PDF; harmless when the
    // user doesn't have the synctex CLI installed (forward/inverse return None).
    if synctex {
        args.push("--synctex");
    }
    if shell_escape {
        // Tectonic's unstable opt-in; only reachable through a trust grant.
        args.push("-Z");
        args.push("shell-escape");
    } else {
        args.push("--untrusted");
    }
    if strict_offline {
        args.push("--only-cached");
    }
    args
}

#[allow(clippy::too_many_arguments)]
async fn run_tectonic(
    app: &tauri::AppHandle,
    root_file: &str,
    root: &Path,
    synctex: bool,
    shell_escape: bool,
    strict_offline: bool,
    cancel: &Option<watch::Receiver<bool>>,
    sink: Option<Arc<LogSink>>,
) -> Result<(String, bool), String> {
    let tectonic_args = tectonic_args(root_file, synctex, shell_escape, strict_offline);
    // Try the bundled sidecar first. The name must be the bare runtime name,
    // NOT the externalBin-configured "binaries/tectonic": the Rust-side
    // `Shell::sidecar()` joins its argument onto the exe directory verbatim
    // (`relative_command_path`), while the build installs the sidecar flat next
    // to the exe with the triple stripped (`<exe_dir>/tectonic`) — so the
    // configured path resolves to a `binaries/` subdir that never exists and
    // silently fell through to PATH. (Only the plugin's JS-API handler strips
    // the basename.)
    let sidecar_result = app.shell().sidecar("tectonic");
    if let Ok(cmd) = sidecar_result {
        // `sidecar()` builds the Command without stat-ing the file, so a declared-
        // but-missing externalBin only fails at spawn time (e.g. dev before
        // `npm run fetch:tectonic`). Fall THROUGH to the PATH fallback on a spawn
        // error rather than hard-erroring — a `?` here would kill the fallback.
        // (A TIMEOUT does not fall through — rerunning the same document from
        // PATH would just double the wait.)
        match cmd.args(tectonic_args.clone()).current_dir(root).spawn() {
            Ok((mut rx, child)) => {
                let deadline = tokio::time::Instant::now() + COMPILE_TIMEOUT;
                let mut stdout = CappedBuffer::new(COMPILE_OUTPUT_CAP, COMPILE_TAIL_CAP);
                let mut stderr = CappedBuffer::new(COMPILE_OUTPUT_CAP, COMPILE_TAIL_CAP);
                let mut code = None;
                let mut timed_out = false;
                let mut cancel_rx = cancel.clone();
                loop {
                    // Cancellation mirrors the timeout arm's kill exactly, but
                    // rejects with the stable marker instead of logging.
                    let event = tokio::select! {
                        ev = tokio::time::timeout_at(deadline, rx.recv()) => ev,
                        _ = wait_cancelled(&mut cancel_rx) => {
                            #[cfg(windows)]
                            kill_tree_windows(child.pid()).await;
                            let _ = child.kill();
                            return Err(COMPILE_CANCELLED.into());
                        }
                    };
                    match event {
                        // The plugin emits line-chunked events with the
                        // newline stripped; re-add it so the merged log keeps
                        // its line structure for the parser.
                        Ok(Some(CommandEvent::Stdout(line))) => {
                            stdout.append(&line);
                            stdout.append(b"\n");
                            if let Some(s) = &sink {
                                s.push(&line);
                                s.push(b"\n");
                            }
                        }
                        Ok(Some(CommandEvent::Stderr(line))) => {
                            stderr.append(&line);
                            stderr.append(b"\n");
                            if let Some(s) = &sink {
                                s.push(&line);
                                s.push(b"\n");
                            }
                        }
                        Ok(Some(CommandEvent::Error(e))) => {
                            stderr.append(e.as_bytes());
                            stderr.append(b"\n");
                        }
                        Ok(Some(CommandEvent::Terminated(payload))) => {
                            code = payload.code;
                            break;
                        }
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(_) => {
                            timed_out = true;
                            #[cfg(windows)]
                            kill_tree_windows(child.pid()).await;
                            let _ = child.kill();
                            break;
                        }
                    }
                }
                if let Some(s) = &sink {
                    s.flush();
                }
                let mut log = merge_io(&stdout.finalize(), &stderr.finalize());
                if timed_out {
                    log.push_str(&latex_timeout_line("tectonic"));
                    return Ok((log, false));
                }
                return Ok((log, code == Some(0)));
            }
            Err(e) => {
                // Not fatal (PATH fallback below), but never silent: a wrong
                // sidecar path looks identical to "not fetched yet" otherwise.
                eprintln!("[typeward] tectonic sidecar spawn failed, trying PATH: {e}");
            }
        }
    }
    // Fall back to PATH — resolve the absolute path and spawn that, not the
    // bare name, so `current_dir(root)` can't redirect to a planted binary.
    let tectonic = match crate::detect::resolve_program("tectonic") {
        Ok(path) => path,
        Err(_) => {
            return Err(
                "tectonic is not bundled (run `npm run fetch:tectonic`) and not on PATH".into(),
            );
        }
    };
    let owned_args: Vec<String> = tectonic_args.iter().map(|s| s.to_string()).collect();
    let output = run_bounded(
        &tectonic,
        &owned_args,
        root,
        COMPILE_TIMEOUT,
        COMPILE_OUTPUT_CAP,
        cancel.clone(),
        sink.clone(),
    )
    .await
    .map_err(|e| format!("failed to spawn tectonic: {}", e))?;
    let mut log = merge_io(&output.stdout, &output.stderr);
    if output.cancelled {
        return Err(COMPILE_CANCELLED.into());
    }
    if output.timed_out {
        log.push_str(&latex_timeout_line("tectonic"));
        return Ok((log, false));
    }
    Ok((log, output.success()))
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

/// Hard ceiling on diagnostics per parse — a pathological log (an 800-page
/// book can emit thousands of box notices) must not flood the IPC payload or
/// the Issues pane. The tail is summarized in one closing info diagnostic.
const MAX_DIAGNOSTICS: usize = 400;

/// LaTeX log scanner with file attribution: joins `max_print_line`-wrapped
/// lines back together (the wrap splits paths and even line numbers), tracks
/// TeX's `(file` push / `)` pop stream, and resolves each diagnostic to a
/// validated project-relative path, the entry-file fallback, or an external
/// distro file (see [`Diagnostic::scope`]). `root` enables validation; without
/// it relative paths are trusted as project files but never canonicalized.
pub fn parse_latex_log(log: &str, entry: &str, root: Option<&Path>) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    // Stale-aux wedge: biblatex macros in the .aux with no biblatex in the
    // current preamble (backend/package switch), or latexmk refusing to act
    // on a previously-failed run. Both clear the same way — clean aux files.
    if log.contains("\\abx@aux@") || log.contains("gave an error in previous invocation of latexmk")
    {
        out.push(Diagnostic {
            severity: "warning".into(),
            message: "Stale auxiliary files are blocking this build (often after changing \
                      the bibliography setup). Use Engine \u{2192} Clean auxiliary files, \
                      then compile again."
                .into(),
            file: entry.to_string(),
            line: 1,
            source: "compile".into(),
            scope: "root-fallback".into(),
        });
    }
    let lines = join_wrapped_lines(log);
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut cache: HashMap<String, (String, String)> = HashMap::new();
    // Lines still inside an error's source-context block (between `! ` and
    // its `l.<n>` line) — they quote user text whose parens would corrupt
    // the file stack, so they are excluded from stack scanning.
    let mut skip_stack_until = 0usize;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("! ") {
            let message = trimmed.trim_start_matches("! ").trim_start().to_string();
            // TeX's abort summary ("!  ==> Fatal error occurred, no output
            // PDF file produced!") restates the error reported just above it;
            // a second card carrying no independent information is noise, and
            // the failure state is already surfaced by the errors pill.
            if message.starts_with("==> Fatal error occurred") {
                continue;
            }
            // The diagnostic's line must be a SOURCE line, never the log line
            // index: click-to-jump feeds it to the editor. TeX prints the
            // source position as an `l.<n>` context line shortly after the
            // error; without one the position is unknown, and line 1 is the
            // honest fallback.
            let mut src_line = 1u32;
            for (j, follow) in lines.iter().enumerate().skip(i + 1).take(15) {
                let f = follow.trim_start();
                if f.starts_with("! ") {
                    break;
                }
                if f.starts_with("l.")
                    && let Some(n) = digits_after(f, "l.")
                {
                    src_line = n;
                    skip_stack_until = j + 1;
                    break;
                }
            }
            let (file, scope) = resolve_diag_file(&stack, entry, root, &mut cache);
            out.push(Diagnostic {
                severity: "error".into(),
                message,
                file,
                line: src_line,
                source: "compile".into(),
                scope,
            });
        } else if trimmed.contains("Warning:") {
            // The position may sit on the warning line itself or on one of
            // its `(package)`-prefixed continuation lines (Font warnings put
            // "on input line N" on the continuation).
            let mut src_line = digits_after(trimmed, "on input line ");
            if src_line.is_none() {
                for follow in lines.iter().skip(i + 1).take(4) {
                    let f = follow.trim_start();
                    if !f.starts_with('(') {
                        break;
                    }
                    src_line = digits_after(f, "on input line ");
                    if src_line.is_some() {
                        break;
                    }
                }
            }
            let (file, scope) = resolve_diag_file(&stack, entry, root, &mut cache);
            out.push(Diagnostic {
                severity: "warning".into(),
                message: trimmed.to_string(),
                file,
                line: src_line.unwrap_or(1),
                source: "compile".into(),
                scope,
            });
        } else if (trimmed.starts_with("Overfull") || trimmed.starts_with("Underfull"))
            && trimmed.contains("box")
        {
            // Boxes that don't fit — informational, not errors/warnings.
            // Their position reads "in paragraph at lines 5--6".
            let (file, scope) = resolve_diag_file(&stack, entry, root, &mut cache);
            out.push(Diagnostic {
                severity: "info".into(),
                message: trimmed.to_string(),
                file,
                line: digits_after(trimmed, "at lines ").unwrap_or(1),
                source: "compile".into(),
                scope,
            });
        }
        if i >= skip_stack_until {
            scan_parens_into_stack(line, &mut stack);
        }
    }
    if out.len() > MAX_DIAGNOSTICS {
        let dropped = out.len() - MAX_DIAGNOSTICS;
        out.truncate(MAX_DIAGNOSTICS);
        out.push(Diagnostic {
            severity: "info".into(),
            message: format!(
                "{dropped} further diagnostic{} omitted — see the full build log.",
                if dropped == 1 { "" } else { "s" }
            ),
            file: entry.to_string(),
            line: 1,
            source: "compile".into(),
            scope: "root-fallback".into(),
        });
    }
    out
}

/// Re-joins the log's hard-wrapped lines. TeX wraps at `max_print_line`,
/// which MiKTeX configures in miktex.ini — never assume 79. Detection: the
/// modal length among long lines; a wrapped log has hundreds of lines at
/// exactly that width (splitting paths and even digits), an unwrapped log
/// has none, and requiring several occurrences keeps a lone naturally-long
/// line from triggering false joins.
fn join_wrapped_lines(log: &str) -> Vec<String> {
    let raw: Vec<&str> = log.lines().collect();
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for l in &raw {
        if l.len() >= 79 && l.len() <= 2048 {
            *counts.entry(l.len()).or_default() += 1;
        }
    }
    let wrap = counts
        .into_iter()
        .filter(|&(_, c)| c >= 5)
        .max_by_key(|&(_, c)| c)
        .map(|(len, _)| len);
    let Some(wrap) = wrap else {
        return raw.into_iter().map(String::from).collect();
    };
    let mut out = Vec::with_capacity(raw.len());
    let mut cur = String::new();
    for l in raw {
        cur.push_str(l);
        if l.len() == wrap {
            continue;
        }
        out.push(std::mem::take(&mut cur));
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Feeds one (joined) log line into the `(file` push / `)` pop stack. Every
/// `(` pushes — `Some(path)` when the following token looks like a file,
/// `None` for grouping/message parens — and every `)` pops, so message-level
/// pairs like `(Font)` or `(DPC,SPQR)` self-balance. Quoted opens
/// (`("C:/path with spaces/f.tex"`) are consumed as one token. Filenames
/// containing parens defeat any log parser, including this one.
fn scan_parens_into_stack(line: &str, stack: &mut Vec<Option<String>>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => {
                i += 1;
                let token = if i < bytes.len() && bytes[i] == b'"' {
                    let start = i + 1;
                    let end = line[start..]
                        .find('"')
                        .map(|e| start + e)
                        .unwrap_or(bytes.len());
                    i = (end + 1).min(bytes.len());
                    &line[start..end.min(bytes.len())]
                } else {
                    let start = i;
                    while i < bytes.len() && !matches!(bytes[i], b'(' | b')' | b' ' | b'\t' | b'"')
                    {
                        i += 1;
                    }
                    &line[start..i]
                };
                stack.push(file_candidate(token));
            }
            b')' => {
                stack.pop();
                i += 1;
            }
            _ => i += 1,
        }
    }
}

/// Whether a post-`(` token plausibly names a file: it carries a path
/// separator, or a dotted extension that starts with a letter (so `1.2pt`
/// and bare words like `Font` stay out).
fn file_candidate(token: &str) -> Option<String> {
    if token.is_empty() {
        return None;
    }
    let has_sep = token.contains('/') || token.contains('\\');
    let ext_ok = token.contains('.')
        && token
            .rsplit('.')
            .next()
            .map(|e| {
                (2..=12).contains(&e.len())
                    && e.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                    && e.chars().all(|c| c.is_ascii_alphanumeric())
            })
            .unwrap_or(false);
    if has_sep || ext_ok {
        Some(token.to_string())
    } else {
        None
    }
}

/// Resolves the file stack's innermost real file into a `(file, scope)` pair
/// (see [`Diagnostic::scope`]). Relative paths are TeX's own view from the
/// compile CWD (the project root); with a root they are existence+containment
/// validated, without one they are trusted. Absolute paths inside the root
/// become project-relative; outside it they are external (basename only —
/// never leak distro paths into the UI).
fn resolve_diag_file(
    stack: &[Option<String>],
    entry: &str,
    root: Option<&Path>,
    cache: &mut HashMap<String, (String, String)>,
) -> (String, String) {
    let Some(raw) = stack.iter().rev().find_map(|s| s.as_deref()) else {
        return (entry.to_string(), "root-fallback".into());
    };
    if let Some(hit) = cache.get(raw) {
        return hit.clone();
    }
    let norm = raw.replace('\\', "/");
    let norm = norm.strip_prefix("./").unwrap_or(&norm).to_string();
    let is_abs = norm.starts_with('/') || (norm.len() >= 2 && norm.as_bytes()[1] == b':');
    let resolved: (String, String) = if is_abs {
        let external = || -> (String, String) {
            let base = norm.rsplit('/').next().unwrap_or(&norm).to_string();
            (base, "external".into())
        };
        match root {
            Some(r) => {
                let canon_root = r.canonicalize().unwrap_or_else(|_| r.to_path_buf());
                match std::path::Path::new(&norm).canonicalize() {
                    Ok(abs) if abs.starts_with(&canon_root) => {
                        let rel = abs
                            .strip_prefix(&canon_root)
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .unwrap_or_else(|_| norm.clone());
                        (rel, "project".into())
                    }
                    _ => external(),
                }
            }
            None => external(),
        }
    } else {
        match root {
            Some(r) => match crate::project::resolve_existing_project_path(r, &norm) {
                Ok(_) => (norm.clone(), "project".into()),
                Err(_) => (entry.to_string(), "root-fallback".into()),
            },
            // No root to validate against (e.g. the wasm provider running
            // without a registered root): trust TeX's own relative path.
            None => (norm.clone(), "project".into()),
        }
    };
    cache.insert(raw.to_string(), resolved.clone());
    resolved
}

/// First run of ASCII digits directly after `marker` in `s`, if any.
fn digits_after(s: &str, marker: &str) -> Option<u32> {
    let rest = &s[s.find(marker)? + marker.len()..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        None
    } else {
        rest[..end].parse().ok()
    }
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
pub async fn compile_typst(
    app: tauri::AppHandle,
    project: Project,
    compile_id: Option<String>,
) -> CmdResult<CompileResult> {
    let started = Instant::now();
    let (root, root_file) = checked_project_root_and_file(&project)?;
    let (cancel, _cancel_registration) = register_compile(compile_id)?;
    // Resolve the absolute path on PATH and spawn THAT, not the bare name.
    // Bare `Command::new("typst")` + `current_dir(project)` lets Windows'
    // CreateProcess search the project dir first, so a planted `typst.exe`
    // in a malicious project would run (argument/binary planting). `which`
    // resolves against the app's CWD/PATH, never the project.
    let typst = crate::detect::resolve_program("typst").map_err(|_| {
        "typst is not on PATH — install it from https://typst.app/download or `cargo install typst-cli`"
            .to_string()
    })?;

    let mut log = String::new();
    log.push_str(&format!("$ typst compile {}\n", root_file));
    let args = vec!["compile".to_string(), root_file.clone()];
    let output = run_bounded(
        &typst,
        &args,
        &root,
        COMPILE_TIMEOUT,
        COMPILE_OUTPUT_CAP,
        cancel,
        Some(LogSink::tauri(app.clone(), "compile:log")),
    )
    .await
    .map_err(|e| format!("failed to spawn typst: {}", e))?;
    log.push_str(&merge_io(&output.stdout, &output.stderr));
    if output.cancelled {
        return Err(COMPILE_CANCELLED.into());
    }
    let success = if output.timed_out {
        // `error:`-prefixed so parse_typst_log lifts it into a diagnostic.
        log.push_str(&format!(
            "\nerror: typst timed out after {} minutes — build aborted\n",
            COMPILE_TIMEOUT.as_secs() / 60
        ));
        false
    } else {
        output.success()
    };

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
        // `typst compile` always rewrites the PDF, so there is no no-op to skip.
        pdf_unchanged: false,
    })
}

/// Split a codespan location tail (`path:line:col` or `path:line`) into its
/// path and line. Peeled from the right so a Windows drive letter in the path
/// (`C:\work\main.typ:12:5`) doesn't get mistaken for the line number.
fn split_typst_location(s: &str) -> Option<(String, u32)> {
    let (head, last) = s.trim().rsplit_once(':')?;
    let last_num = last.parse::<u32>().ok()?;
    if let Some((head2, mid)) = head.rsplit_once(':')
        && let Ok(line) = mid.parse::<u32>()
    {
        // `path:line:col` — `last_num` was the column.
        return Some((head2.to_string(), line));
    }
    Some((head.to_string(), last_num))
}

/// The `┌─ file:line:col` (or `--> file:line:col`) line codespan prints
/// directly under a Typst diagnostic.
fn parse_typst_location(line: &str) -> Option<(String, u32)> {
    let rest = line
        .split_once("┌─")
        .or_else(|| line.split_once("-->"))
        .map(|(_, r)| r)?;
    split_typst_location(rest)
}

/// Lines like `error: ...` and `warning: ...` are surfaced as Diagnostics.
///
/// The line number must be a SOURCE line, never the log line index — the Issues
/// tab feeds it straight to `requestGotoSource`, so a log index would jump the
/// editor to an unrelated place on every Typst failure. Typst prints the real
/// position on the codespan location line right under each diagnostic; that is
/// what gets attached here, with line 1 as the honest fallback when a
/// diagnostic carries no location (matching the LaTeX parser's convention).
fn parse_typst_log(log: &str, entry: &str) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    // Index of the diagnostic still waiting for its location line, if any.
    let mut pending: Option<usize> = None;
    for line in log.lines() {
        let trimmed = line.trim();
        if let Some(idx) = pending
            && let Some((file, src_line)) = parse_typst_location(trimmed)
        {
            let d = &mut out[idx];
            d.line = src_line;
            // Typst is spawned with `current_dir(root)`, so a relative path it
            // prints is already project-relative and usable for click-to-jump;
            // an absolute one (a package or an out-of-project include) is not,
            // so the entry file stays the anchor there.
            if !Path::new(&file).is_absolute() {
                d.file = file.replace('\\', "/");
                d.scope = "project".into();
            }
            pending = None;
            continue;
        }
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
            line: 1,
            source: "typst".into(),
            scope: "root-fallback".into(),
        });
        pending = Some(out.len() - 1);
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

/// Project-relative path of the PDF a LaTeX build produces.
///
/// latexmk and the raw engines are spawned with `current_dir(root)` and no
/// `-output-directory`, so TeX writes `<jobname>.pdf` into the CWD — the project
/// root — regardless of where the entry file lives. A nested root file such as
/// `chapters/thesis.tex` therefore yields `<root>/thesis.pdf`, not
/// `<root>/chapters/thesis.pdf`; looking beside the source made every otherwise
/// successful nested-entry build report `ok: false` with no PDF. Tectonic writes
/// beside its input instead, so it keeps the source-relative path.
fn latex_output_rel(root_file: &str, engine: LatexEngine) -> String {
    match engine {
        LatexEngine::Tectonic => replace_ext(root_file, "pdf"),
        _ => {
            let stem = Path::new(root_file)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| root_file.to_string());
            format!("{stem}.pdf")
        }
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
    fn nested_root_file_resolves_the_pdf_where_the_engine_actually_writes_it() {
        // latexmk/pdflatex run with current_dir(root) and no -output-directory,
        // so the PDF lands at the ROOT as <jobname>.pdf — not beside the source.
        // Looking beside the source made every nested-entry build report failure.
        assert_eq!(
            latex_output_rel("chapters/thesis.tex", LatexEngine::Pdflatex),
            "thesis.pdf"
        );
        assert_eq!(
            latex_output_rel("main.tex", LatexEngine::Pdflatex),
            "main.pdf"
        );
        // Tectonic writes beside its input, so the source-relative path holds.
        assert_eq!(
            latex_output_rel("chapters/thesis.tex", LatexEngine::Tectonic),
            "chapters/thesis.pdf"
        );
    }

    #[test]
    fn typst_diagnostics_take_the_line_from_the_location_line() {
        // The line must be a SOURCE line: the Issues tab feeds it straight to
        // click-to-jump. Reporting the log line index sent the cursor somewhere
        // unrelated on every Typst failure.
        let log = "\
error: unknown variable: foo
   ┌─ main.typ:42:5
   │
warning: this is deprecated
   ┌─ chapters/intro.typ:7:1
";
        let diags = parse_typst_log(log, "main.typ");
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].line, 42);
        assert_eq!(diags[0].file, "main.typ");
        assert_eq!(diags[1].line, 7);
        assert_eq!(diags[1].file, "chapters/intro.typ");
    }

    #[test]
    fn typst_diagnostic_without_a_location_falls_back_to_line_one() {
        let diags = parse_typst_log("error: failed to load package\n", "main.typ");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].line, 1);
        assert_eq!(diags[0].file, "main.typ");
    }

    #[test]
    fn typst_location_parsing_survives_a_windows_drive_letter() {
        // Peeled from the right, so `C:` is not mistaken for a line number.
        assert_eq!(
            split_typst_location(r"C:\work\main.typ:12:5"),
            Some((r"C:\work\main.typ".to_string(), 12))
        );
        assert_eq!(
            split_typst_location("main.typ:9"),
            Some(("main.typ".to_string(), 9))
        );
        assert_eq!(split_typst_location("no-numbers-here"), None);
    }

    #[test]
    fn tectonic_compiles_untrusted_by_default() {
        let args = tectonic_args("main.tex", true, false, false);
        assert_eq!(
            args,
            [
                "-X",
                "compile",
                "main.tex",
                "--keep-logs",
                "--synctex",
                "--untrusted"
            ]
        );
    }

    #[test]
    fn tectonic_drops_untrusted_only_for_a_trusted_shell_escape_build() {
        let args = tectonic_args("main.tex", false, true, false);
        assert_eq!(
            args,
            [
                "-X",
                "compile",
                "main.tex",
                "--keep-logs",
                "-Z",
                "shell-escape"
            ]
        );
        // Untrusted mode refuses -Z shell-escape, so the two must never coexist.
        assert!(!args.contains(&"--untrusted"));
    }

    #[test]
    fn tectonic_strict_offline_adds_only_cached() {
        let args = tectonic_args("main.tex", false, false, true);
        assert_eq!(
            args,
            [
                "-X",
                "compile",
                "main.tex",
                "--keep-logs",
                "--untrusted",
                "--only-cached"
            ]
        );
        let networked = tectonic_args("main.tex", false, false, false);
        assert!(!networked.contains(&"--only-cached"));
    }

    #[test]
    fn build_options_default_to_networked_and_untrusted() {
        let opts = BuildOptions::default();
        assert_eq!(opts.strict_offline, None);
        assert!(!opts.shell_escape);

        // A frontend payload that predates the flag stays on the default.
        let legacy: BuildOptions =
            serde_json::from_str(r#"{"engine":"tectonic","recipe":"latexmk"}"#).unwrap();
        assert_eq!(legacy.strict_offline, None);
        let explicit: BuildOptions =
            serde_json::from_str(r#"{"engine":"tectonic","strictOffline":true}"#).unwrap();
        assert_eq!(explicit.strict_offline, Some(true));
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
        let log =
            "ok line\n! Undefined control sequence.\nPackage hyperref Warning: token\nplain\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].severity, "error");
        assert_eq!(diags[0].message, "Undefined control sequence.");
        assert_eq!(diags[0].file, "main.tex");
        assert_eq!(diags[0].scope, "root-fallback");
        assert_eq!(diags[1].severity, "warning");
        assert_eq!(diags[0].source, "compile");
    }

    #[test]
    fn parse_latex_log_hints_stale_aux_recovery() {
        // The biblatex-macro-in-aux signature (backend switch wedge).
        let log = "! Undefined control sequence.\nl.7 \\abx@aux@refcontext\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert!(
            diags
                .iter()
                .any(|d| d.severity == "warning" && d.message.contains("Clean auxiliary files"))
        );

        // latexmk exit-12 refusal after a previously failed run.
        let log2 = "Latexmk: Nothing to do for 'main.tex'.\n  pdflatex: gave an error in previous invocation of latexmk.\n";
        let diags2 = parse_latex_log(log2, "main.tex", None);
        assert!(
            diags2
                .iter()
                .any(|d| d.message.contains("Clean auxiliary files"))
        );

        // A clean log gets no hint.
        assert!(
            parse_latex_log("all good\n", "main.tex", None)
                .iter()
                .all(|d| !d.message.contains("Clean auxiliary files"))
        );
    }

    #[test]
    fn parse_latex_log_flags_overfull_boxes_as_info() {
        let log = "Overfull \\hbox (12.3pt too wide) in paragraph at lines 5--6\n\
                   Underfull \\vbox (badness 10000) has occurred\nplain line\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags.iter().filter(|d| d.severity == "info").count(), 2);
    }

    // ---- Log attribution (file stack + wrap joining) -----------------------

    #[test]
    fn parse_latex_log_attributes_to_the_open_file() {
        // Shapes lifted from a real MiKTeX log: root opens as `(main.tex`
        // (no ./), chapters as ` (chapters/chNNN.tex`, package banners carry
        // self-balancing parens like (DPC,SPQR).
        let log = "(main.tex\n\
                   (C:\\MiKTeX\\tex/latex/graphics\\graphicx.sty\n\
                   Package: graphicx 2024/12/31 v1.2e Enhanced (DPC,SPQR)\n\
                   )\n\
                   Chapter 1.\n (chapters/ch001.tex\n\
                   Overfull \\hbox (3.2pt too wide) in paragraph at lines 40--41\n\
                   ) (chapters/ch002.tex\n\
                   LaTeX Warning: Reference `sec:x' on page 9 undefined on input line 12.\n\
                   ! Undefined control sequence.\n\
                   l.77 \\badmacro\n\
                   ))\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags.len(), 3);
        assert_eq!(diags[0].file, "chapters/ch001.tex");
        assert_eq!(diags[0].scope, "project");
        assert_eq!(diags[0].line, 40);
        assert_eq!(diags[1].file, "chapters/ch002.tex");
        assert_eq!(diags[1].line, 12);
        assert_eq!(diags[2].file, "chapters/ch002.tex");
        assert_eq!(diags[2].line, 77);
    }

    #[test]
    fn parse_latex_log_marks_distro_files_external_by_basename() {
        // Absolute distro paths (MiKTeX's mixed separators) must never leak
        // into the UI as jump targets — basename + external scope only.
        let log = "(main.tex\n\
                   (C:\\MiKTeX\\tex/latex/hyperref\\hyperref.sty\n\
                   Package hyperref Warning: Draft mode on. on input line 33.\n\
                   ))\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].file, "hyperref.sty");
        assert_eq!(diags[0].scope, "external");
        assert_eq!(diags[0].line, 33);
    }

    #[test]
    fn parse_latex_log_joins_wrapped_lines_before_parsing() {
        // TeX hard-wraps at max_print_line (79 here); the wrap splits paths
        // mid-token. Pad with enough wrapped filler that the modal width
        // detection (>= 5 occurrences) engages, then check the split path is
        // reassembled before the stack sees it.
        let mut log = String::from("(main.tex\n");
        for _ in 0..6 {
            log.push_str(&"x".repeat(79));
            log.push('\n');
            log.push_str("filler\n");
        }
        let full_open = format!("(chapters/{}.tex", "c".repeat(90));
        log.push_str(&full_open[..79]);
        log.push('\n');
        log.push_str(&full_open[79..]);
        log.push('\n');
        log.push_str("LaTeX Warning: Citation `k' on page 2 undefined on input line 55.\n");
        let diags = parse_latex_log(&log, "main.tex", None);
        let w = diags
            .iter()
            .find(|d| d.message.contains("Citation"))
            .expect("warning parsed");
        assert_eq!(w.file, full_open[1..].to_string());
        assert_eq!(w.line, 55);
    }

    #[test]
    fn parse_latex_log_reads_warning_position_from_continuation_lines() {
        // Font warnings put "on input line N" on the (Font) continuation.
        let log = "(main.tex\n\
                   LaTeX Font Warning: Font shape `T1/psy/m/n' undefined\n\
                   (Font)              using `T1/cmr/m/n' instead on input line 5528.\n\
                   )\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].line, 5528);
        // The (Font) continuation's parens self-balance: the stack must be
        // back at main.tex, not corrupted by the marker.
        assert_eq!(diags[0].file, "main.tex");
    }

    #[test]
    fn parse_latex_log_validates_relative_paths_against_the_root() {
        // With a real root, a relative path that doesn't exist degrades to
        // the entry-file fallback instead of a broken jump target.
        let dir = std::env::temp_dir().join(format!("tw-logattr-{}", std::process::id()));
        let chapters = dir.join("chapters");
        std::fs::create_dir_all(&chapters).unwrap();
        std::fs::write(dir.join("main.tex"), "x").unwrap();
        std::fs::write(chapters.join("ch001.tex"), "x").unwrap();
        let log = "(main.tex\n (chapters/ch001.tex\n\
                   LaTeX Warning: Real file on input line 3.\n\
                   ) (chapters/ghost.tex\n\
                   LaTeX Warning: Ghost file on input line 4.\n\
                   ))\n";
        let diags = parse_latex_log(log, "main.tex", Some(&dir));
        assert_eq!(diags.len(), 2);
        assert_eq!(diags[0].file, "chapters/ch001.tex");
        assert_eq!(diags[0].scope, "project");
        assert_eq!(diags[1].file, "main.tex");
        assert_eq!(diags[1].scope, "root-fallback");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_latex_log_caps_diagnostics_with_a_summary() {
        let mut log = String::from("(main.tex\n");
        for i in 0..(MAX_DIAGNOSTICS + 50) {
            log.push_str(&format!(
                "Overfull \\hbox (1.0pt too wide) in paragraph at lines {}--{}\n",
                i + 1,
                i + 2
            ));
        }
        let diags = parse_latex_log(&log, "main.tex", None);
        assert_eq!(diags.len(), MAX_DIAGNOSTICS + 1);
        let last = diags.last().unwrap();
        assert!(last.message.contains("50 further diagnostics omitted"));
    }

    #[test]
    fn parse_latex_log_skips_error_context_parens() {
        // The quoted source context after an error can contain unbalanced
        // parens; they must not corrupt the file stack.
        let log = "(main.tex\n (chapters/ch001.tex\n\
                   ! Missing $ inserted.\n\
                   <inserted text>\n\
                   l.10 some user text with a stray ( paren\n\
                   ) \n\
                   LaTeX Warning: After context on input line 20.\n\
                   )\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags[0].severity, "error");
        assert_eq!(diags[0].file, "chapters/ch001.tex");
        assert_eq!(diags[0].line, 10);
        // The `)` line after the context closed ch001; the warning belongs
        // to main.tex.
        assert_eq!(diags[1].file, "main.tex");
    }

    #[test]
    fn parse_typst_log_flags_hints_as_info() {
        let log = "error: unknown variable\nhint: did you mean `x`?\n";
        let diags = parse_typst_log(log, "main.typ");
        assert_eq!(diags.iter().filter(|d| d.severity == "info").count(), 1);
        assert_eq!(diags.iter().filter(|d| d.severity == "error").count(), 1);
    }

    #[test]
    fn validated_include_only_accepts_safe_stems_and_rejects_injection() {
        let ok = BuildOptions {
            include_only: Some(vec!["chapters/ch010".into(), "chapters/ch011".into()]),
            ..Default::default()
        };
        assert_eq!(
            validated_include_only(&ok).unwrap(),
            Some(vec!["chapters/ch010".into(), "chapters/ch011".into()])
        );
        // Empty / whitespace-only collapses to None (a full build).
        let empty = BuildOptions {
            include_only: Some(vec!["".into(), "   ".into()]),
            ..Default::default()
        };
        assert_eq!(validated_include_only(&empty).unwrap(), None);
        // Every TeX-special byte, traversal, absolute, colon, and leading dash
        // is rejected — these would be code or argument injection.
        for bad in [
            "ch010}\\input{/etc/passwd",
            "a\\write18",
            "a$b",
            "a%b",
            "a#b",
            "a~b",
            "a^b",
            "a&b",
            "../secret",
            "/abs/path",
            "-shell-escape",
            "c:drive",
        ] {
            let o = BuildOptions {
                include_only: Some(vec![bad.into()]),
                ..Default::default()
            };
            assert!(validated_include_only(&o).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn engine_input_args_injects_includeonly_code_with_a_fixed_shape() {
        // Normal build: just the positional file.
        assert_eq!(
            engine_input_args("main.tex", &None),
            vec!["main.tex".to_string()]
        );
        // Chapter draft: jobname + includeonly-then-input code, jobname is the
        // root stem so the .aux/.pdf keep their names.
        let names = Some(vec![
            "chapters/ch010".to_string(),
            "chapters/ch011".to_string(),
        ]);
        let args = engine_input_args("main.tex", &names);
        assert_eq!(args[0], "-jobname=main");
        assert_eq!(
            args[1],
            "\\includeonly{chapters/ch010,chapters/ch011}\\input{main}"
        );
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
            &None,
        );
        assert_eq!(passes.len(), 2);
        assert!(
            passes
                .iter()
                .all(|p| p.is_engine && p.program == "pdflatex")
        );
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
            &None,
        );
        assert_eq!(passes.len(), 4);
        assert_eq!(passes.iter().filter(|p| p.is_engine).count(), 3);
        assert!(
            passes
                .iter()
                .filter(|p| p.is_engine)
                .all(|p| p.program == "lualatex")
        );
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
            &None,
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
            &None,
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

    #[cfg(windows)]
    fn shell_cmd(script: &str) -> (std::path::PathBuf, Vec<String>) {
        let cmd = which::which("cmd").expect("cmd.exe should be on PATH");
        (cmd, vec!["/C".to_string(), script.to_string()])
    }

    #[cfg(not(windows))]
    fn shell_cmd(script: &str) -> (std::path::PathBuf, Vec<String>) {
        (
            std::path::PathBuf::from("/bin/sh"),
            vec!["-c".to_string(), script.to_string()],
        )
    }

    #[tokio::test]
    async fn run_bounded_passes_short_output_through_untouched() {
        let (prog, args) = shell_cmd("echo hello");
        let out = run_bounded(
            &prog,
            &args,
            &std::env::temp_dir(),
            Duration::from_secs(30),
            COMPILE_OUTPUT_CAP,
            None,
            None,
        )
        .await
        .expect("spawn should succeed");
        assert!(out.success());
        assert!(!out.timed_out);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("hello"));
        assert!(!text.contains("[output truncated"));
    }

    #[tokio::test]
    async fn run_bounded_caps_output_keeping_head_and_tail() {
        let (prog, args) = shell_cmd("echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let out = run_bounded(
            &prog,
            &args,
            &std::env::temp_dir(),
            Duration::from_secs(30),
            8,
            None,
            None,
        )
        .await
        .expect("spawn should succeed");
        assert!(!out.timed_out);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.starts_with("aaaaaaaa"));
        assert!(text.contains("[output truncated"));
        assert!(text.contains("bytes omitted]"));
        // The rolling tail keeps the END of the output (line-ending trimmed:
        // \n vs \r\n differ per platform).
        assert!(text.trim_end().ends_with('a'));
    }

    #[tokio::test]
    async fn fatal_error_line_after_the_cap_survives_in_the_final_log() {
        let filler = "f".repeat(60);
        #[cfg(windows)]
        let script = format!("echo {filler} & echo {filler} & echo ! boom");
        #[cfg(not(windows))]
        let script = format!("echo {filler}; echo {filler}; echo '! boom'");
        let (prog, args) = shell_cmd(&script);
        let out = run_bounded(
            &prog,
            &args,
            &std::env::temp_dir(),
            Duration::from_secs(30),
            32,
            None,
            None,
        )
        .await
        .expect("spawn should succeed");
        assert!(!out.timed_out);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("[output truncated"));
        assert!(text.contains("! boom"), "the tail must keep the fatal line");
        let diags = parse_latex_log(&text, "main.tex", None);
        assert!(
            diags
                .iter()
                .any(|d| d.severity == "error" && d.message.contains("boom")),
            "the post-cap fatal line must still surface as a diagnostic"
        );
    }

    #[tokio::test]
    async fn run_bounded_kills_a_runaway_process_on_timeout() {
        #[cfg(windows)]
        let (prog, args) = shell_cmd("ping -n 30 127.0.0.1 > NUL");
        #[cfg(not(windows))]
        let (prog, args) = shell_cmd("sleep 30");
        let started = std::time::Instant::now();
        let out = run_bounded(
            &prog,
            &args,
            &std::env::temp_dir(),
            Duration::from_millis(400),
            COMPILE_OUTPUT_CAP,
            None,
            None,
        )
        .await
        .expect("spawn should succeed");
        assert!(out.timed_out);
        assert!(!out.success());
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the kill must beat the 30s sleeper"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_bounded_timeout_kills_the_grandchild_too() {
        // Mirrors latexmk: the shell child spawns a long-running grandchild.
        // The group SIGKILL must take the grandchild down, not just the shell.
        let pidfile =
            std::env::temp_dir().join(format!("typeward-group-kill-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let (prog, args) = shell_cmd(&script);
        let out = run_bounded(
            &prog,
            &args,
            &std::env::temp_dir(),
            Duration::from_millis(500),
            COMPILE_OUTPUT_CAP,
            None,
            None,
        )
        .await
        .expect("spawn should succeed");
        assert!(out.timed_out);
        let pid: i32 = std::fs::read_to_string(&pidfile)
            .expect("grandchild pidfile should exist")
            .trim()
            .parse()
            .expect("pidfile should hold a pid");
        let _ = std::fs::remove_file(&pidfile);
        // The SIGKILLed orphan may linger as a zombie until init reaps it.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "grandchild sleeper (pid {pid}) survived the group kill"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn run_bounded_surfaces_spawn_failure_as_err() {
        let missing = std::path::PathBuf::from("definitely-not-a-real-binary-typeward");
        let args: Vec<String> = vec![];
        let result = run_bounded(
            &missing,
            &args,
            &std::env::temp_dir(),
            Duration::from_secs(5),
            COMPILE_OUTPUT_CAP,
            None,
            None,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn run_bounded_cancel_kills_the_process_and_flags_cancelled() {
        #[cfg(windows)]
        let (prog, args) = shell_cmd("ping -n 30 127.0.0.1 > NUL");
        #[cfg(not(windows))]
        let (prog, args) = shell_cmd("sleep 30");
        let (tx, rx) = watch::channel(false);
        let started = std::time::Instant::now();
        let cwd = std::env::temp_dir();
        let task = tokio::spawn(async move {
            run_bounded(
                &prog,
                &args,
                &cwd,
                Duration::from_secs(30),
                COMPILE_OUTPUT_CAP,
                Some(rx),
                None,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        tx.send(true)
            .expect("the run should still hold its receiver");
        let out = task
            .await
            .expect("task should join")
            .expect("spawn should succeed");
        assert!(out.cancelled);
        assert!(!out.timed_out);
        assert!(!out.success());
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the cancel kill must beat the 30s sleeper"
        );
    }

    #[tokio::test]
    async fn run_bounded_with_a_pre_fired_cancel_flag_kills_immediately() {
        #[cfg(windows)]
        let (prog, args) = shell_cmd("ping -n 30 127.0.0.1 > NUL");
        #[cfg(not(windows))]
        let (prog, args) = shell_cmd("sleep 30");
        // Cancel raced ahead of the spawn — the run must still notice it.
        let (tx, rx) = watch::channel(false);
        let _ = tx.send(true);
        let out = run_bounded(
            &prog,
            &args,
            &std::env::temp_dir(),
            Duration::from_secs(30),
            COMPILE_OUTPUT_CAP,
            Some(rx),
            None,
        )
        .await
        .expect("spawn should succeed");
        assert!(out.cancelled);
    }

    #[test]
    fn compile_id_validation_allows_uuid_shaped_ids_only() {
        assert!(validate_compile_id("0f2a4c66-1d2e-4f3a-9b8c-7d6e5f4a3b2c").is_ok());
        assert!(validate_compile_id("build_42").is_ok());
        assert!(validate_compile_id("").is_err());
        assert!(validate_compile_id(&"x".repeat(MAX_COMPILE_ID_LEN + 1)).is_err());
        assert!(validate_compile_id("id with spaces").is_err());
        assert!(validate_compile_id("../escape").is_err());
    }

    #[test]
    fn register_compile_rejects_duplicates_and_deregisters_on_drop() {
        let id = "test-registration-guard".to_string();
        let (rx, guard) = register_compile(Some(id.clone())).expect("first registration");
        assert!(rx.is_some());
        assert!(register_compile(Some(id.clone())).is_err());
        drop(guard);
        // Dropped guard released the slot — the same id registers again.
        let (_, guard2) = register_compile(Some(id)).expect("re-registration after drop");
        drop(guard2);
    }

    #[tokio::test]
    async fn compile_cancel_on_an_unknown_id_is_a_quiet_no_op() {
        assert!(compile_cancel("never-registered".into()).await.is_ok());
        assert!(compile_cancel("bad id!".into()).await.is_err());
    }

    #[test]
    fn capped_buffer_passes_small_output_through_untouched() {
        let mut buf = CappedBuffer::new(8, 8);
        buf.append(b"abc");
        buf.append(b"def");
        assert_eq!(buf.finalize(), b"abcdef");
    }

    #[test]
    fn capped_buffer_contiguous_head_and_tail_merge_without_marker() {
        // Overflow that fits entirely in the tail window loses nothing, so the
        // finalized log is the exact original bytes.
        let mut buf = CappedBuffer::new(4, 4);
        buf.append(b"abcdef");
        assert_eq!(buf.finalize(), b"abcdef");
    }

    #[test]
    fn capped_buffer_keeps_head_and_tail_and_counts_the_gap() {
        let mut buf = CappedBuffer::new(4, 4);
        buf.append(b"abcdefghijkl");
        let text = String::from_utf8_lossy(&buf.finalize()).into_owned();
        assert!(text.starts_with("abcd"));
        assert!(text.ends_with("ijkl"));
        assert!(text.contains("4 bytes omitted"));
    }

    #[test]
    fn capped_buffer_tail_rolls_across_appends() {
        let mut buf = CappedBuffer::new(2, 4);
        buf.append(b"ab");
        buf.append(b"cdef");
        buf.append(b"gh");
        let text = String::from_utf8_lossy(&buf.finalize()).into_owned();
        assert!(text.starts_with("ab"));
        assert!(text.ends_with("efgh"));
        assert!(text.contains("2 bytes omitted"));
    }

    #[test]
    fn capped_buffer_trims_split_utf8_at_the_head_seam() {
        // The head cap lands mid-`é` (0xC3 0xA9); the dangling lead byte must
        // be dropped and counted, not left as a mojibake fragment.
        let mut buf = CappedBuffer::new(5, 2);
        buf.append("abcd\u{e9}xyz".as_bytes());
        let out = buf.finalize();
        assert!(!out.contains(&0xC3));
        let text = String::from_utf8_lossy(&out).into_owned();
        assert!(text.starts_with("abcd\n["));
        assert!(text.ends_with("yz"));
        assert!(text.contains("3 bytes omitted"));
    }

    #[test]
    fn capped_buffer_drops_leading_continuation_bytes_in_the_tail() {
        let mut buf = CappedBuffer::new(1, 2);
        buf.append("a\u{e9}b".as_bytes());
        let out = buf.finalize();
        assert!(!out.contains(&0xA9));
        let text = String::from_utf8_lossy(&out).into_owned();
        assert!(text.starts_with("a\n["));
        assert!(text.ends_with('b'));
        assert!(text.contains("2 bytes omitted"));
    }

    #[test]
    fn latex_timeout_line_parses_as_an_error_diagnostic() {
        let diags = parse_latex_log(&latex_timeout_line("latexmk"), "main.tex", None);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].severity, "error");
        assert!(diags[0].message.contains("timed out"));
    }

    #[test]
    fn typst_timeout_line_parses_as_an_error_diagnostic() {
        let log = format!(
            "\nerror: typst timed out after {} minutes — build aborted\n",
            COMPILE_TIMEOUT.as_secs() / 60
        );
        let diags = parse_typst_log(&log, "main.typ");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].severity, "error");
        assert!(diags[0].message.contains("timed out"));
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
        let diags = parse_latex_log(log, "main.tex", None);
        let errors: Vec<_> = diags.iter().filter(|d| d.severity == "error").collect();
        let warnings: Vec<_> = diags.iter().filter(|d| d.severity == "warning").collect();
        assert_eq!(errors.len(), 2, "expected two `! ` error lines");
        assert_eq!(warnings.len(), 2, "expected two Warning: lines");
        assert_eq!(errors[0].message, "Undefined control sequence.");
        assert!(errors[1].message.contains("File `missing.sty' not found."));
        // Everything is attributed to the entry file with the compile source.
        assert!(
            diags
                .iter()
                .all(|d| d.file == "main.tex" && d.source == "compile")
        );
        // Positions are SOURCE lines: the error takes its `l.15` context
        // line, the citation warning its "on input line 12", and the
        // position-less LaTeX Error falls back to 1.
        assert_eq!(errors[0].line, 15);
        assert_eq!(errors[1].line, 1);
        assert_eq!(warnings[0].line, 12);
    }

    #[test]
    fn parse_latex_log_skips_the_fatal_error_summary() {
        // TeX's abort summary restates the error above it; one error, one card.
        let log = "! Undefined control sequence.\nl.28 \\oops\n\
                   !  ==> Fatal error occurred, no output PDF file produced!\n";
        let diags = parse_latex_log(log, "main.tex", None);
        let errors: Vec<_> = diags.iter().filter(|d| d.severity == "error").collect();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].message, "Undefined control sequence.");
        assert_eq!(errors[0].line, 28);
    }

    #[test]
    fn parse_latex_log_overfull_boxes_carry_paragraph_lines() {
        let log = "Overfull \\hbox (12.3pt too wide) in paragraph at lines 5--6\n";
        let diags = parse_latex_log(log, "main.tex", None);
        assert_eq!(diags[0].severity, "info");
        assert_eq!(diags[0].line, 5);
    }
}
