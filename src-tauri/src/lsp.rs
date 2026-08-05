//! LSP transport — Rust owns the child process; the frontend talks to it
//! over Tauri event channels (`emit`/`listen`). This avoids the latency
//! jitter of streaming JSON-RPC traffic through `invoke` request/response.
//!
//! Wire shape:
//!   start_lsp { language_id, project_root } -> { server_id }   (invoke)
//!   send_lsp_message { server_id, message }                   (invoke)
//!   stop_lsp { server_id }                                    (invoke)
//!   `lsp:<server_id>:message` events                          (emit -> frontend listen)
//!
//! Phase 1 v0 delivers the framing + lifecycle. The codemirror-languageserver
//! adapter that consumes this is wired in a follow-up; the channel works end-
//! to-end today.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

const MAX_LSP_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct LspManager {
    servers: Mutex<HashMap<String, ServerHandle>>,
}

struct ServerHandle {
    /// Sender for outbound messages (frontend → LSP).
    tx: mpsc::Sender<String>,
    /// Keep the child alive; dropping it kills the process.
    _child: Child,
}

#[derive(Debug, Error)]
pub enum LspError {
    #[error("language not supported: {0}")]
    UnsupportedLanguage(String),
    #[error("language server binary not on PATH: {0}")]
    BinaryMissing(String),
    #[error("server not running: {0}")]
    NotRunning(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<std::io::Error> for LspError {
    fn from(e: std::io::Error) -> Self {
        LspError::Io(e.to_string())
    }
}

#[derive(Debug, Deserialize)]
pub struct StartArgs {
    #[serde(rename = "languageId")]
    pub language_id: String,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
}

#[derive(Debug, Serialize)]
pub struct StartResult {
    #[serde(rename = "serverId")]
    pub server_id: String,
}

fn binary_for_language(language_id: &str) -> Result<&'static str, LspError> {
    match language_id {
        "latex" => Ok("texlab"),
        "typst" => Ok("tinymist"),
        other => Err(LspError::UnsupportedLanguage(other.to_string())),
    }
}

/// Mark a server dead from any death path (reader EOF, reader/writer IO
/// error, process exit): drop its handle so further `send_lsp_message` calls
/// fail fast, and emit `lsp:<id>:closed` so the frontend evicts the session
/// and rejects in-flight requests instead of waiting out the request timeout.
/// Idempotent — safe to call from multiple death paths for the same server.
fn signal_server_closed(app: &AppHandle, server_id: &str) {
    if let Some(manager) = app.try_state::<LspManager>() {
        manager
            .servers
            .lock()
            .expect("lsp lock poisoned")
            .remove(server_id);
    }
    let _ = app.emit(&format!("lsp:{}:closed", server_id), ());
}

#[tauri::command]
pub async fn start_lsp(
    app: AppHandle,
    manager: State<'_, LspManager>,
    args: StartArgs,
) -> Result<StartResult, String> {
    start_lsp_impl(&app, &manager, args)
        .await
        .map_err(|e| e.to_string())
}

async fn start_lsp_impl(
    app: &AppHandle,
    manager: &LspManager,
    args: StartArgs,
) -> Result<StartResult, LspError> {
    // Gate the renderer-supplied cwd to an opened project root, matching
    // compile/synctex/watch_project. On Windows the child's cwd is in the
    // default DLL search path, so an ungated cwd is a planted-DLL vector.
    if !crate::project::is_registered_root(std::path::Path::new(&args.project_root)) {
        return Err(LspError::Io(format!(
            "project root is not an opened project: {}",
            args.project_root
        )));
    }
    let bin = binary_for_language(&args.language_id)?;
    // Resolve to an absolute path and spawn that. A bare `Command::new("texlab")`
    // with `current_dir(project)` lets Windows execute a `texlab.exe`/`tinymist.exe`
    // planted in a malicious project; `which` resolves against PATH, not the project.
    let bin_path = crate::detect::resolve_program(bin)
        .map_err(|_| LspError::BinaryMissing(bin.to_string()))?;

    let server_id = format!(
        "{}-{}",
        args.language_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let mut cmd = Command::new(&bin_path);
    cmd.current_dir(&args.project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::detect::hide_console_async(&mut cmd);
    let mut child = cmd.spawn()?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| LspError::Io("missing stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| LspError::Io("missing stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| LspError::Io("missing stderr".into()))?;

    let (tx, mut rx) = mpsc::channel::<String>(64);

    // Writer task: pump frontend messages into stdin with Content-Length framing.
    let writer_id = server_id.clone();
    let writer_app = app.clone();
    tokio::spawn(async move {
        let mut stdin: ChildStdin = stdin;
        while let Some(msg) = rx.recv().await {
            if let Err(e) = write_framed(&mut stdin, &msg).await {
                // A write failure means the pipe is gone — the server has died.
                // Signal death here too; don't rely solely on the reader's EOF,
                // which may lag or (if stdout stays open) never arrive.
                eprintln!("[lsp:{}] write failed: {}", writer_id, e);
                signal_server_closed(&writer_app, &writer_id);
                break;
            }
        }
    });

    // Reader task: parse Content-Length-framed messages from stdout, emit events.
    let reader_app = app.clone();
    let reader_id = server_id.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_framed(&mut reader).await {
                Ok(Some(payload)) => {
                    let event = format!("lsp:{}:message", reader_id);
                    if let Err(e) =
                        reader_app.emit_to(crate::ipc_guard::MAIN_LABEL, &event, payload)
                    {
                        eprintln!("[lsp:{}] emit failed: {}", reader_id, e);
                    }
                }
                Ok(None) => break, // EOF
                Err(e) => {
                    eprintln!("[lsp:{}] read failed: {}", reader_id, e);
                    break;
                }
            }
        }
        // The server exited (crash or clean EOF). Drop its handle and notify the
        // frontend so it can reject in-flight requests and evict the session
        // instead of waiting out the request timeout.
        signal_server_closed(&reader_app, &reader_id);
    });

    // Stderr drain — useful for surfacing engine warnings into telemetry later.
    let stderr_id = server_id.clone();
    tokio::spawn(async move {
        let mut stderr = stderr;
        let mut chunk = [0u8; 1024];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let line = String::from_utf8_lossy(&chunk[..n]);
                    eprintln!("[lsp:{}:stderr] {}", stderr_id, line.trim_end());
                }
            }
        }
    });

    let mut servers = manager.servers.lock().expect("lsp lock poisoned");
    servers.insert(server_id.clone(), ServerHandle { tx, _child: child });

    Ok(StartResult { server_id })
}

#[tauri::command]
pub async fn send_lsp_message(
    manager: State<'_, LspManager>,
    server_id: String,
    message: String,
) -> Result<(), String> {
    let tx = {
        let servers = manager.servers.lock().expect("lsp lock poisoned");
        servers
            .get(&server_id)
            .map(|h| h.tx.clone())
            .ok_or_else(|| LspError::NotRunning(server_id.clone()).to_string())?
    };
    tx.send(message)
        .await
        .map_err(|_| LspError::NotRunning(server_id).to_string())
}

#[tauri::command]
pub fn stop_lsp(manager: State<'_, LspManager>, server_id: String) -> Result<(), String> {
    let mut servers = manager.servers.lock().expect("lsp lock poisoned");
    if servers.remove(&server_id).is_some() {
        // Dropping the ServerHandle drops the Child (kill_on_drop=true) and
        // the Sender (which closes the writer task's recv loop).
        Ok(())
    } else {
        Err(LspError::NotRunning(server_id).to_string())
    }
}

// ---------- JSON-RPC framing helpers --------------------------------------

async fn write_framed(stdin: &mut ChildStdin, payload: &str) -> std::io::Result<()> {
    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    stdin.write_all(header.as_bytes()).await?;
    stdin.write_all(payload.as_bytes()).await?;
    stdin.flush().await?;
    Ok(())
}

/// Reads one Content-Length-framed JSON-RPC payload. Returns Ok(None) on EOF.
async fn read_framed<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;
    let mut header_line = String::new();

    // Header phase: line-by-line until empty line.
    loop {
        header_line.clear();
        let n = reader.read_line(&mut header_line).await?;
        if n == 0 {
            return Ok(None); // EOF
        }
        let line = header_line.trim_end_matches(&['\r', '\n'][..]);
        if line.is_empty() {
            break; // end of headers
        }
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse::<usize>().ok();
        }
        // Other headers (Content-Type) are ignored.
    }

    let len = content_length.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "LSP message missing Content-Length",
        )
    })?;
    if len > MAX_LSP_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("LSP message exceeds {MAX_LSP_MESSAGE_BYTES} byte cap"),
        ));
    }

    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    String::from_utf8(buf)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_framed_parses_a_valid_frame() {
        let msg = "{\"jsonrpc\":\"2.0\",\"id\":1}";
        let framed = format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg);
        let mut reader = BufReader::new(framed.as_bytes());
        let out = read_framed(&mut reader).await.unwrap();
        assert_eq!(out.as_deref(), Some(msg));
    }

    #[tokio::test]
    async fn read_framed_ignores_other_headers() {
        let msg = "{}";
        let framed = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{}",
            msg.len(),
            msg
        );
        let mut reader = BufReader::new(framed.as_bytes());
        let out = read_framed(&mut reader).await.unwrap();
        assert_eq!(out.as_deref(), Some(msg));
    }

    #[tokio::test]
    async fn read_framed_rejects_oversized_content_length() {
        // The cap is checked before allocation, so no body is needed to trip it.
        let framed = format!("Content-Length: {}\r\n\r\n", MAX_LSP_MESSAGE_BYTES + 1);
        let mut reader = BufReader::new(framed.as_bytes());
        let err = read_framed(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("cap"));
    }

    #[tokio::test]
    async fn read_framed_errors_on_missing_content_length() {
        let framed = "Content-Type: application/vscode-jsonrpc\r\n\r\n";
        let mut reader = BufReader::new(framed.as_bytes());
        let err = read_framed(&mut reader).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("Content-Length"));
    }

    #[tokio::test]
    async fn read_framed_returns_none_on_eof() {
        let empty: &[u8] = b"";
        let mut reader = BufReader::new(empty);
        let out = read_framed(&mut reader).await.unwrap();
        assert!(out.is_none());
    }

    #[test]
    fn binary_for_language_maps_known_and_rejects_unknown() {
        assert_eq!(binary_for_language("latex").unwrap(), "texlab");
        assert_eq!(binary_for_language("typst").unwrap(), "tinymist");
        assert!(binary_for_language("cobol").is_err());
    }
}
