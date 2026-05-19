//! Per-cell notebook execution via a persistent R kernel per project.
//!
//! Each project gets one long-lived `R --slave --no-save --no-restore` child
//! process. Cell runs are serialized through a per-kernel mutex, so variables
//! defined in cell 1 survive into cell 2 (the main reason we moved off the
//! previous stateless `Rscript` model).
//!
//! Protocol: user code is written to `.typeward/cache/cell_<nonce>.R` and
//! sourced from there (so multi-line code parses cleanly and the kernel
//! doesn't have to chew through escaped string literals). The wrapper sent
//! over stdin is one line:
//!
//!   tryCatch(source("<path>", local=FALSE, echo=FALSE),
//!     error = function(e) { .tw_ok <<- FALSE
//!                            cat(sprintf("Error: %s\n",
//!                                        conditionMessage(e)),
//!                                file = stderr()) })
//!   flush(stdout()); flush(stderr())
//!   cat("\n<<<__TYPEWARD_END__:<nonce>:<status>>>>\n", file = stdout())
//!   cat("\n<<<__TYPEWARD_END__:<nonce>>>>\n", file = stderr())
//!
//! The sentinel carries the nonce so we never confuse leftover output from a
//! previous run; the status (`ok`/`fail`) tells us whether `source()` threw.
//! Two background tasks read stdout and stderr line-by-line into mpsc
//! channels; the runner waits for the matching sentinel on each.
//!
//! Kernel lifecycle:
//! - First `run_r_chunk` for a project lazily spawns the kernel.
//! - `stop_r_kernel` kills it (variables lost — that's the point).
//! - `kill_on_drop` makes app shutdown safe.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time::timeout;

const SENTINEL_PREFIX: &str = "<<<__TYPEWARD_END__";
const RUN_TIMEOUT_SECS: u64 = 300;
const STDERR_DRAIN_SECS: u64 = 5;

#[derive(Debug, Serialize)]
pub struct RunResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct RunRChunkArgs {
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct KernelArgs {
    #[serde(rename = "projectRoot")]
    pub project_root: String,
}

enum ReaderEvent {
    Line(String),
    Eof,
}

struct KernelHandle {
    _child: tokio::process::Child,
    stdin: ChildStdin,
    stdout_rx: mpsc::UnboundedReceiver<ReaderEvent>,
    stderr_rx: mpsc::UnboundedReceiver<ReaderEvent>,
    nonce_counter: u64,
}

#[derive(Default)]
pub struct KernelManager {
    kernels: Mutex<HashMap<PathBuf, Arc<Mutex<KernelHandle>>>>,
}

async fn drain_lines<R>(reader: BufReader<R>, tx: mpsc::UnboundedSender<ReaderEvent>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if tx.send(ReaderEvent::Line(line)).is_err() {
                    break;
                }
            }
            Ok(None) | Err(_) => {
                let _ = tx.send(ReaderEvent::Eof);
                break;
            }
        }
    }
}

async fn spawn_kernel(root: &Path) -> Result<KernelHandle, String> {
    if which::which("R").is_err() {
        return Err(
            "R is not on PATH \u{2014} install R (https://cran.r-project.org) and retry".into(),
        );
    }
    let mut child = Command::new("R")
        .args([
            "--slave",
            "--no-save",
            "--no-restore",
            "--no-echo",
            "--no-readline",
        ])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn R: {e}"))?;

    let stdin = child.stdin.take().ok_or("kernel: no stdin")?;
    let stdout = child.stdout.take().ok_or("kernel: no stdout")?;
    let stderr = child.stderr.take().ok_or("kernel: no stderr")?;

    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let (err_tx, err_rx) = mpsc::unbounded_channel();
    tokio::spawn(drain_lines(BufReader::new(stdout), out_tx));
    tokio::spawn(drain_lines(BufReader::new(stderr), err_tx));

    Ok(KernelHandle {
        _child: child,
        stdin,
        stdout_rx: out_rx,
        stderr_rx: err_rx,
        nonce_counter: 0,
    })
}

fn make_nonce(counter: u64) -> String {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("{counter}_{micros}")
}

/// Strip a sentinel line and return `Some(status)` if the line matches the
/// expected nonce. The status payload is the trailing segment before the
/// closing `>>>` — `"ok"` or `"fail"` on stdout, empty on stderr.
fn match_sentinel(line: &str, nonce: &str) -> Option<String> {
    let trimmed = line.trim();
    let body = trimmed
        .strip_prefix(SENTINEL_PREFIX)?
        .strip_suffix(">>>")?;
    let body = body.strip_prefix(':')?;
    let mut parts = body.splitn(2, ':');
    if parts.next()? != nonce {
        return None;
    }
    Some(parts.next().unwrap_or("").to_string())
}

async fn run_chunk_locked(
    handle: &mut KernelHandle,
    root: &Path,
    code: &str,
) -> Result<RunResult, String> {
    let started = Instant::now();
    handle.nonce_counter = handle.nonce_counter.wrapping_add(1);
    let nonce = make_nonce(handle.nonce_counter);

    let cache_dir = root.join(".typeward").join("cache");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("cache dir: {e}"))?;
    let chunk_path = cache_dir.join(format!("cell_{nonce}.R"));
    tokio::fs::write(&chunk_path, code)
        .await
        .map_err(|e| format!("write chunk: {e}"))?;
    let chunk_path_r = chunk_path.to_string_lossy().replace('\\', "/");

    // Single-line wrapper, semicolon-separated. The closure captures
    // `.tw_ok` via `<<-` so the status survives source() failures.
    let wrapper = format!(
        ".tw_ok <- TRUE; tryCatch(source(\"{chunk_path_r}\", local=FALSE, echo=FALSE), error=function(e) {{ .tw_ok <<- FALSE; cat(sprintf(\"Error: %s\\n\", conditionMessage(e)), file=stderr()) }}); flush(stdout()); flush(stderr()); cat(sprintf(\"\\n{SENTINEL_PREFIX}:{nonce}:%s>>>\\n\", if (.tw_ok) \"ok\" else \"fail\"), file=stdout()); cat(\"\\n{SENTINEL_PREFIX}:{nonce}:>>>\\n\", file=stderr())\n"
    );

    handle
        .stdin
        .write_all(wrapper.as_bytes())
        .await
        .map_err(|e| format!("kernel write failed: {e}"))?;
    handle
        .stdin
        .flush()
        .await
        .map_err(|e| format!("kernel flush failed: {e}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut status = String::new();
    let mut crashed = false;

    // Stdout: read until sentinel or timeout. Anything past the sentinel
    // belongs to a future run and stays buffered for it.
    let deadline = Duration::from_secs(RUN_TIMEOUT_SECS);
    loop {
        match timeout(deadline, handle.stdout_rx.recv()).await {
            Ok(Some(ReaderEvent::Line(line))) => {
                if let Some(s) = match_sentinel(&line, &nonce) {
                    status = s;
                    break;
                }
                stdout.push_str(&line);
                stdout.push('\n');
            }
            Ok(Some(ReaderEvent::Eof)) | Ok(None) => {
                crashed = true;
                break;
            }
            Err(_) => {
                crashed = true;
                break;
            }
        }
    }

    if !crashed {
        // Stderr may legitimately have zero output for a successful chunk.
        // Drain until we see the sentinel; short overall timeout because
        // R prints the stderr sentinel right after the stdout one.
        let stderr_deadline = Duration::from_secs(STDERR_DRAIN_SECS);
        loop {
            match timeout(stderr_deadline, handle.stderr_rx.recv()).await {
                Ok(Some(ReaderEvent::Line(line))) => {
                    if match_sentinel(&line, &nonce).is_some() {
                        break;
                    }
                    stderr.push_str(&line);
                    stderr.push('\n');
                }
                Ok(Some(ReaderEvent::Eof)) | Ok(None) => break,
                Err(_) => break,
            }
        }
    }

    let _ = tokio::fs::remove_file(&chunk_path).await;

    let duration_ms = started.elapsed().as_millis() as u64;
    if crashed {
        return Err(
            "R kernel crashed or hit the 5-minute timeout \u{2014} stop and re-run to restart"
                .into(),
        );
    }

    Ok(RunResult {
        ok: status == "ok",
        stdout,
        stderr,
        exit_code: if status == "ok" { 0 } else { 1 },
        duration_ms,
    })
}

async fn kernel_for_project(
    manager: &KernelManager,
    root: &Path,
) -> Result<Arc<Mutex<KernelHandle>>, String> {
    {
        let kernels = manager.kernels.lock().await;
        if let Some(handle) = kernels.get(root) {
            return Ok(handle.clone());
        }
    }

    // Spawning the kernel can take ~200ms on first invocation; release the
    // map lock first so concurrent runs against *other* projects aren't
    // blocked. The race where two callers spawn kernels for the same
    // project is benign — the loser's kernel is dropped (kill_on_drop) and
    // the winner's stays in the map.
    let handle = spawn_kernel(root).await?;
    let handle = Arc::new(Mutex::new(handle));
    let mut kernels = manager.kernels.lock().await;
    if let Some(existing) = kernels.get(root) {
        return Ok(existing.clone());
    }
    kernels.insert(root.to_path_buf(), handle.clone());
    Ok(handle)
}

#[tauri::command]
pub async fn run_r_chunk(
    args: RunRChunkArgs,
    manager: State<'_, KernelManager>,
) -> Result<RunResult, String> {
    let root = PathBuf::from(&args.project_root);
    let kernel = kernel_for_project(&manager, &root).await?;
    let mut handle = kernel.lock().await;
    let result = run_chunk_locked(&mut handle, &root, &args.code).await;
    if result.is_err() {
        // Kernel is in an unknown state — drop it so the next run spawns a
        // fresh one. We have to release the per-handle mutex first because
        // remove() doesn't need it; the Arc count drops when this scope ends.
        drop(handle);
        let mut kernels = manager.kernels.lock().await;
        kernels.remove(&root);
    }
    result
}

#[tauri::command]
pub async fn stop_r_kernel(
    args: KernelArgs,
    manager: State<'_, KernelManager>,
) -> Result<(), String> {
    let root = PathBuf::from(&args.project_root);
    manager.kernels.lock().await.remove(&root);
    Ok(())
}

/// `true` if a kernel is currently spawned for this project. Used by the
/// notebook header to surface kernel state.
#[tauri::command]
pub async fn r_kernel_status(
    args: KernelArgs,
    manager: State<'_, KernelManager>,
) -> Result<bool, String> {
    let root = PathBuf::from(&args.project_root);
    let kernels = manager.kernels.lock().await;
    Ok(kernels.contains_key(&root))
}

#[allow(dead_code)]
pub fn cache_dir(root: &Path) -> PathBuf {
    root.join(".typeward").join("cache")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_sentinel_parses_status() {
        let line = "<<<__TYPEWARD_END__:42_99:ok>>>";
        assert_eq!(match_sentinel(line, "42_99"), Some("ok".into()));
        assert_eq!(match_sentinel(line, "1_2"), None);
    }

    #[test]
    fn match_sentinel_handles_trailing_whitespace() {
        let line = "  <<<__TYPEWARD_END__:n:fail>>>  ";
        assert_eq!(match_sentinel(line, "n"), Some("fail".into()));
    }

    #[test]
    fn match_sentinel_handles_empty_status() {
        let line = "<<<__TYPEWARD_END__:n:>>>";
        assert_eq!(match_sentinel(line, "n"), Some("".into()));
    }

    #[test]
    fn match_sentinel_rejects_non_sentinel_lines() {
        assert_eq!(match_sentinel("ordinary output", "n"), None);
        assert_eq!(match_sentinel("<<<__TYPEWARD_END__:>>>", "n"), None);
    }
}
