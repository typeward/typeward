//! Local-only structured event log. Captures crashes (Rust panics + frontend
//! error boundary forwarded events), compile failures, and LSP startup errors.
//! Capture itself never touches the network — events stay on disk in
//! `<app_data_dir>/telemetry.log`; submission is a separate, explicit path
//! (see `diagnostics.rs`).
//!
//! Format: one JSON object per line (JSONL) for easy tailing. Bounded to the
//! last 1000 entries so the log doesn't grow without limit.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const MAX_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    /// ISO 8601 UTC timestamp.
    pub at: String,
    /// "panic" | "compile-failed" | "lsp-failed" | "frontend-error"
    pub kind: String,
    /// Free-form short label (e.g. "latexmk exit 1").
    pub summary: String,
    /// Optional structured detail (stderr tail, stack trace, etc.).
    pub detail: Option<String>,
}

static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Wire up the Rust panic hook + cache the log file location. Call from
/// `lib::run` once we have an AppHandle.
pub fn install(app: &AppHandle) {
    let dir = app
        .path()
        .app_data_dir()
        .ok()
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("telemetry.log");

    {
        let mut slot = LOG_PATH.lock().expect("telemetry lock poisoned");
        *slot = Some(path.clone());
    }

    let panic_path = path.clone();
    std::panic::set_hook(Box::new(move |info| {
        let summary = format!("{}", info);
        let detail = std::backtrace::Backtrace::force_capture().to_string();
        let event = Event {
            at: Utc::now().to_rfc3339(),
            kind: "panic".into(),
            summary,
            detail: Some(detail),
        };
        if let Ok(line) = serde_json::to_string(&event) {
            if let Ok(mut f) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&panic_path)
            {
                let _ = writeln!(f, "{}", line);
            }
        }
    }));
}

/// Per-field caps so a single record can't bloat the JSONL log. `detail`
/// often carries compile-log tails, so it gets the largest budget.
const MAX_KIND_LEN: usize = 64;
const MAX_SUMMARY_LEN: usize = 2_000;
const MAX_DETAIL_LEN: usize = 16_000;

fn truncate_on_char_boundary(mut s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("…[truncated]");
    s
}

// Field caps re-exposed for the submission path (diagnostics.rs), which accepts
// event payloads over IPC and must bound them the same way capture does.
pub fn cap_kind(s: String) -> String {
    truncate_on_char_boundary(s, MAX_KIND_LEN)
}
pub fn cap_summary(s: String) -> String {
    truncate_on_char_boundary(s, MAX_SUMMARY_LEN)
}
pub fn cap_detail(s: String) -> String {
    truncate_on_char_boundary(s, MAX_DETAIL_LEN)
}

#[tauri::command]
pub async fn record_event(
    kind: String,
    summary: String,
    detail: Option<String>,
) -> Result<(), String> {
    let event = Event {
        at: Utc::now().to_rfc3339(),
        kind: truncate_on_char_boundary(kind, MAX_KIND_LEN),
        summary: truncate_on_char_boundary(summary, MAX_SUMMARY_LEN),
        detail: detail.map(|d| truncate_on_char_boundary(d, MAX_DETAIL_LEN)),
    };
    // Off the event-loop thread: append does file IO and (occasionally) a trim
    // with fsync, and the frontend telemetry hook can fire bursts.
    tokio::task::spawn_blocking(move || append(&event))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Cached location of telemetry.log (None before `install` runs).
pub fn log_path() -> Option<PathBuf> {
    LOG_PATH.lock().expect("telemetry lock poisoned").clone()
}

/// Every parseable event in log order (oldest first). Shared by the recent-events
/// listing and the crash-scan submission path in `diagnostics.rs`.
pub fn read_all_events() -> Result<Vec<Event>, String> {
    let path = match log_path() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    if !path.exists() {
        return Ok(vec![]);
    }
    let f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(f);
    Ok(reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<Event>(&l).ok())
        .collect())
}

#[tauri::command]
pub async fn list_recent_events(limit: Option<usize>) -> Result<Vec<Event>, String> {
    // Reads (and JSON-parses) the whole JSONL log; keep it off the event loop.
    tokio::task::spawn_blocking(move || -> Result<Vec<Event>, String> {
        let mut events = read_all_events()?;
        let limit = limit.unwrap_or(100).min(MAX_ENTRIES);
        let start = events.len().saturating_sub(limit);
        events.drain(0..start);
        Ok(events)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raw telemetry.log contents for the Diagnostics "Export log" save-as flow.
/// The file is trim-bounded (MAX_ENTRIES lines with per-field caps), so whole-
/// file reads stay small; no path argument — this only ever reads the app-owned
/// log, never an arbitrary file.
#[tauri::command]
pub async fn read_telemetry_log() -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = match log_path() {
            Some(p) => p,
            None => return Ok(String::new()),
        };
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Appends are O(1): the full-file `trim` runs only once every `TRIM_INTERVAL`
/// events (and on the first append of the process, to clear growth accumulated
/// across restarts) instead of rewriting the whole log on every event. This
/// stops a frontend error burst from cascading into O(n^2) full-file rewrites +
/// fsyncs. The log can transiently hold up to MAX_ENTRIES + TRIM_INTERVAL lines.
const TRIM_INTERVAL: usize = 128;
static APPEND_COUNT: AtomicUsize = AtomicUsize::new(0);

fn append(event: &Event) -> std::io::Result<()> {
    let path = LOG_PATH
        .lock()
        .expect("telemetry lock poisoned")
        .clone()
        .ok_or_else(|| std::io::Error::other("telemetry not initialized"))?;
    let line = serde_json::to_string(event)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut f = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(f, "{}", line)?;

    // Bound disk growth lazily; trim() still caps to the last MAX_ENTRIES lines
    // whenever it runs (first append of the process, then every TRIM_INTERVAL).
    if APPEND_COUNT
        .fetch_add(1, Ordering::Relaxed)
        .is_multiple_of(TRIM_INTERVAL)
    {
        trim(&path)?;
    }
    Ok(())
}

fn trim(path: &std::path::Path) -> std::io::Result<()> {
    let f = fs::File::open(path)?;
    let reader = BufReader::new(f);
    let lines: Vec<String> = reader.lines().map_while(Result::ok).collect();
    if lines.len() <= MAX_ENTRIES {
        return Ok(());
    }
    let kept = &lines[lines.len() - MAX_ENTRIES..];
    let tmp = path.with_extension("log.tmp");
    let mut out = fs::File::create(&tmp)?;
    for line in kept {
        writeln!(out, "{}", line)?;
    }
    out.sync_all()?;
    fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "…[truncated]";

    #[test]
    fn short_string_passes_through_unchanged() {
        assert_eq!(truncate_on_char_boundary("hello".into(), 2000), "hello");
        // Exactly at the cap is not truncated (the check is `len() <= max`).
        let exact = "a".repeat(MAX_SUMMARY_LEN);
        assert_eq!(
            truncate_on_char_boundary(exact.clone(), MAX_SUMMARY_LEN),
            exact
        );
    }

    #[test]
    fn summary_is_capped_at_2000_bytes() {
        let s = "a".repeat(MAX_SUMMARY_LEN + 500);
        let out = truncate_on_char_boundary(s, MAX_SUMMARY_LEN);
        assert!(out.ends_with(MARKER));
        let content = out.strip_suffix(MARKER).unwrap();
        assert_eq!(content.len(), MAX_SUMMARY_LEN);
        assert!(content.bytes().all(|b| b == b'a'));
    }

    #[test]
    fn detail_is_capped_at_16000_bytes() {
        let s = "b".repeat(MAX_DETAIL_LEN + 100);
        let out = truncate_on_char_boundary(s, MAX_DETAIL_LEN);
        assert!(out.ends_with(MARKER));
        assert_eq!(out.strip_suffix(MARKER).unwrap().len(), MAX_DETAIL_LEN);
    }

    #[test]
    fn truncation_backs_off_to_a_char_boundary() {
        // Place a 2-byte 'é' straddling the cap: its lead byte sits at MAX-1 and
        // the continuation byte at MAX, so cutting at MAX would split the char.
        let s = format!("{}é", "a".repeat(MAX_SUMMARY_LEN - 1));
        assert_eq!(s.len(), MAX_SUMMARY_LEN + 1);
        let out = truncate_on_char_boundary(s, MAX_SUMMARY_LEN);
        assert!(out.ends_with(MARKER));
        let content = out.strip_suffix(MARKER).unwrap();
        // The 'é' must be dropped whole — content is all ASCII 'a', one shorter.
        assert_eq!(content.len(), MAX_SUMMARY_LEN - 1);
        assert!(content.chars().all(|c| c == 'a'));
        // Result stays valid UTF-8 (would panic here otherwise).
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }
}
