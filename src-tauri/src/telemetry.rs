//! Local-only structured event log. Captures crashes (Rust panics + frontend
//! error boundary forwarded events), compile failures, and LSP startup errors.
//! No network — events stay on disk in `<app_data_dir>/telemetry.log` until a
//! later phase wires submission UI.
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

#[tauri::command]
pub fn list_recent_events(limit: Option<usize>) -> Result<Vec<Event>, String> {
    let path = match LOG_PATH.lock().expect("telemetry lock poisoned").clone() {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    if !path.exists() {
        return Ok(vec![]);
    }
    let f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(f);
    let mut events: Vec<Event> = reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<Event>(&l).ok())
        .collect();
    let limit = limit.unwrap_or(100).min(MAX_ENTRIES);
    let start = events.len().saturating_sub(limit);
    events.drain(0..start);
    Ok(events)
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
