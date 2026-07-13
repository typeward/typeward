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

use std::collections::VecDeque;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::AsyncReadExt;

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
            run_tectonic(
                &app,
                &root_file,
                &root,
                opts.synctex,
                shell_escape,
                strict_offline(&app, &opts),
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
                )
                .await?
            }
        },
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

/// What a bounded compiler run produced. `status: None` with `timed_out` set
/// means the deadline killed it; partial output is still captured.
struct BoundedOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<std::process::ExitStatus>,
    timed_out: bool,
}

impl BoundedOutput {
    fn success(&self) -> bool {
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

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut pipe: R, buf: Arc<Mutex<CappedBuffer>>) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.lock().unwrap().append(&chunk[..n]),
        }
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
    let _ = tokio::process::Command::new(taskkill)
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
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
/// `timed_out` set so the partial log still reaches the LogsDrawer.
async fn run_bounded(
    program: &Path,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    cap: usize,
) -> Result<BoundedOutput, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
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
        .map(|pipe| tokio::spawn(read_capped(pipe, Arc::clone(&stdout_buf))));
    let stderr_task = child
        .stderr
        .take()
        .map(|pipe| tokio::spawn(read_capped(pipe, Arc::clone(&stderr_buf))));

    let (status, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => (Some(status), false),
        Ok(Err(e)) => {
            kill_compile_child(&mut child).await;
            return Err(format!("failed to wait on {}: {}", program.display(), e));
        }
        Err(_) => {
            kill_compile_child(&mut child).await;
            (None, true)
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
    Ok(BoundedOutput {
        stdout,
        stderr,
        status,
        timed_out,
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

async fn run_system_tex(
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
        )
        .await
        {
            Ok(out) => {
                accumulated_log.push_str(&merge_io(&out.stdout, &out.stderr));
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
    let mut bin_args: Vec<String> = system_tex_flags(None, synctex, halt_on_error, shell_escape)
        .into_iter()
        .map(String::from)
        .collect();
    bin_args.push(root_file.to_string());
    accumulated_log.push_str(&format!("\n$ {bin_name} {}\n", bin_args.join(" ")));
    let output = match run_bounded(&bin, &bin_args, root, COMPILE_TIMEOUT, COMPILE_OUTPUT_CAP).await
    {
        Ok(out) => out,
        Err(e) => {
            accumulated_log.push_str(&format!("[{bin_name} spawn failed: {}]\n", e));
            return Err(format!("compile failed:\n{}", accumulated_log));
        }
    };
    accumulated_log.push_str(&merge_io(&output.stdout, &output.stderr));
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
async fn run_engine_recipe(
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
    let passes = recipe_passes(
        recipe,
        root_file,
        engine,
        halt_on_error,
        synctex,
        shell_escape,
    );

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
        match run_bounded(
            &resolved,
            &pass.args,
            root,
            COMPILE_TIMEOUT,
            COMPILE_OUTPUT_CAP,
        )
        .await
        {
            Ok(output) => {
                log.push_str(&merge_io(&output.stdout, &output.stderr));
                // A timed-out pass aborts the whole recipe — the best-effort
                // continue is for missing/failed bib tools, not runaway ones.
                if output.timed_out {
                    log.push_str(&latex_timeout_line(&pass.program));
                    return Ok((log, false));
                }
                if pass.is_engine {
                    last_engine_ok = output.success();
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

async fn run_tectonic(
    app: &tauri::AppHandle,
    root_file: &str,
    root: &Path,
    synctex: bool,
    shell_escape: bool,
    strict_offline: bool,
) -> Result<(String, bool), String> {
    let tectonic_args = tectonic_args(root_file, synctex, shell_escape, strict_offline);
    // Try the bundled sidecar first.
    let sidecar_result = app.shell().sidecar("binaries/tectonic");
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
                loop {
                    match tokio::time::timeout_at(deadline, rx.recv()).await {
                        // The plugin emits line-chunked events with the
                        // newline stripped; re-add it so the merged log keeps
                        // its line structure for the parser.
                        Ok(Some(CommandEvent::Stdout(line))) => {
                            stdout.append(&line);
                            stdout.append(b"\n");
                        }
                        Ok(Some(CommandEvent::Stderr(line))) => {
                            stderr.append(&line);
                            stderr.append(b"\n");
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
                let mut log = merge_io(&stdout.finalize(), &stderr.finalize());
                if timed_out {
                    log.push_str(&latex_timeout_line("tectonic"));
                    return Ok((log, false));
                }
                return Ok((log, code == Some(0)));
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
    let owned_args: Vec<String> = tectonic_args.iter().map(|s| s.to_string()).collect();
    let output = run_bounded(
        &tectonic,
        &owned_args,
        root,
        COMPILE_TIMEOUT,
        COMPILE_OUTPUT_CAP,
    )
    .await
    .map_err(|e| format!("failed to spawn tectonic: {}", e))?;
    let mut log = merge_io(&output.stdout, &output.stderr);
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
    log.push_str(&format!("$ typst compile {}\n", root_file));
    let args = vec!["compile".to_string(), root_file.clone()];
    let output = run_bounded(&typst, &args, &root, COMPILE_TIMEOUT, COMPILE_OUTPUT_CAP)
        .await
        .map_err(|e| format!("failed to spawn typst: {}", e))?;
    log.push_str(&merge_io(&output.stdout, &output.stderr));
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
        assert!(passes
            .iter()
            .all(|p| p.is_engine && p.program == "pdflatex"));
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
        assert!(passes
            .iter()
            .filter(|p| p.is_engine)
            .all(|p| p.program == "lualatex"));
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
        )
        .await
        .expect("spawn should succeed");
        assert!(!out.timed_out);
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(text.contains("[output truncated"));
        assert!(text.contains("! boom"), "the tail must keep the fatal line");
        let diags = parse_latex_log(&text, "main.tex");
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
        )
        .await;
        assert!(result.is_err());
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
        let diags = parse_latex_log(&latex_timeout_line("latexmk"), "main.tex");
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
