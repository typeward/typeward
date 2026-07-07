//! Opt-in crash-report submission + system info for the Diagnostics screen.
//!
//! Everything here is EXPLICIT egress: `submit_error_report` fires only from
//! the per-event "Report this error" confirm flow (the preview command shows
//! the exact scrubbed payload first), and `scan_and_submit_crashes` — the
//! crash-on-previous-run path — checks the persisted
//! `privacy.shareCrashReports` opt-in (default OFF) before touching the
//! network. Payloads are scrubbed in Rust before send: the home directory
//! collapses to `~`, any remaining absolute path collapses to its basename,
//! no files are attached, `send_default_pii` stays false, and `server_name`
//! is never set. Identity is a random per-install UUID (never the Supabase
//! account id), minted lazily on the first submission.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::AppHandle;

use crate::settings;
use crate::telemetry::{self, Event};

/// Same public-by-design DSN as the frontend SDK — keep in sync with
/// `src/lib/sentry.ts`. It is a routing identifier, not a secret.
const DSN: &str =
    "https://20ad6af910fa6634a2a400656db18be1@o4511688473640960.ingest.de.sentry.io/4511688490418256";

/// Bound on events pushed by one crash scan so a panic loop on a previous run
/// can't turn the next launch into a burst of egress.
const SCAN_CAP: usize = 5;

const FLUSH_TIMEOUT: Duration = Duration::from_secs(10);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ----- scrubbing ------------------------------------------------------------

/// Replace every occurrence of the user's home directory (either slash style,
/// ASCII-case-insensitive — Windows paths round-trip through both cases) with
/// `~`. Byte-safe: only ASCII case is folded, so indices line up.
fn replace_home(text: &str, home: &Path) -> String {
    let home = home.to_string_lossy();
    let variants = [home.replace('\\', "/"), home.replace('/', "\\")];
    let hay_lower = text.to_ascii_lowercase();
    let needles: Vec<String> = variants
        .iter()
        .filter(|v| !v.is_empty())
        .map(|v| v.to_ascii_lowercase())
        .collect();

    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'outer: while i < text.len() {
        for needle in &needles {
            if hay_lower[i..].starts_with(needle.as_str()) {
                out.push('~');
                i += needle.len();
                continue 'outer;
            }
        }
        // Advance one char (not one byte) to stay on UTF-8 boundaries.
        let ch = text[i..].chars().next().expect("in-bounds char");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_path_terminator(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '|' | ',' | ';')
}

/// Collapse any absolute path still present after home replacement down to its
/// basename. Matches Windows drive paths (`C:\...`, `C:/...`), UNC prefixes
/// (`\\server\...`) and POSIX paths (`/usr/...`). URLs survive because the
/// slashes in `scheme://host/path` are preceded by `:` / `/` / alphanumerics,
/// and `~/...` stays untouched (already relative to the scrubbed home).
fn collapse_abs_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut prev: Option<char> = None;
    while i < chars.len() {
        let c = chars[i];
        let prev_blocks = |p: Option<char>| p.is_some_and(|p| p.is_alphanumeric());
        let is_win = c.is_ascii_alphabetic()
            && i + 2 < chars.len()
            && chars[i + 1] == ':'
            && (chars[i + 2] == '/' || chars[i + 2] == '\\')
            && !prev_blocks(prev);
        let is_unc = c == '\\'
            && i + 2 < chars.len()
            && chars[i + 1] == '\\'
            && (chars[i + 2].is_alphanumeric() || chars[i + 2] == '_')
            && !prev_blocks(prev);
        let is_posix = c == '/'
            && i + 1 < chars.len()
            && (chars[i + 1].is_alphanumeric() || chars[i + 1] == '_' || chars[i + 1] == '.')
            && !prev.is_some_and(|p| {
                p.is_alphanumeric() || matches!(p, ':' | '/' | '~' | '.' | '-' | '_')
            });
        if is_win || is_unc || is_posix {
            let mut j = i;
            while j < chars.len() && !is_path_terminator(chars[j]) {
                j += 1;
            }
            let path: String = chars[i..j].iter().collect();
            let trimmed = path.trim_end_matches(['/', '\\']);
            let base = trimmed
                .rsplit(['/', '\\'])
                .find(|s| !s.is_empty())
                .unwrap_or("");
            if base.is_empty() {
                out.push_str(&path);
            } else {
                out.push_str(base);
            }
            prev = chars[j - 1].into();
            i = j;
            continue;
        }
        out.push(c);
        prev = Some(c);
        i += 1;
    }
    out
}

/// Pure scrub applied to every outbound text field: home → `~` first, then
/// leftover absolute paths → basename.
fn scrub_text(text: &str, home: Option<&Path>) -> String {
    let replaced = match home {
        Some(h) => replace_home(text, h),
        None => text.to_string(),
    };
    collapse_abs_paths(&replaced)
}

fn scrub_event(event: &Event) -> Event {
    let home = dirs::home_dir();
    let home = home.as_deref();
    Event {
        at: event.at.clone(),
        kind: telemetry::cap_kind(event.kind.clone()),
        summary: telemetry::cap_summary(scrub_text(&event.summary, home)),
        detail: event
            .detail
            .as_ref()
            .map(|d| telemetry::cap_detail(scrub_text(d, home))),
    }
}

// ----- watermark (crash-on-previous-run scan) --------------------------------

fn parse_watermark(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn watermark_path() -> Option<PathBuf> {
    telemetry::log_path().map(|p| p.with_file_name("telemetry.submitted"))
}

fn read_watermark() -> Option<DateTime<Utc>> {
    let path = watermark_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    parse_watermark(&raw)
}

fn write_watermark(at: DateTime<Utc>) -> Result<(), String> {
    let path = watermark_path().ok_or("telemetry not initialized")?;
    crate::fs_ops::atomic_write(&path, at.to_rfc3339().as_bytes()).map_err(err)
}

fn parse_at(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Panic events newer than the watermark, oldest first, capped. Events with an
/// unparseable timestamp are skipped — they can't be ordered against the
/// watermark, so submitting them could loop forever across launches.
fn select_unsubmitted_panics(
    events: &[Event],
    watermark: Option<DateTime<Utc>>,
    cap: usize,
) -> Vec<Event> {
    events
        .iter()
        .filter(|e| e.kind == "panic")
        .filter(|e| match (parse_at(&e.at), watermark) {
            (Some(at), Some(w)) => at > w,
            (Some(_), None) => true,
            (None, _) => false,
        })
        .take(cap)
        .cloned()
        .collect()
}

// ----- report metadata -------------------------------------------------------

struct ReportMeta {
    app_version: String,
    os: String,
    os_version: String,
    arch: String,
    environment: &'static str,
}

fn report_meta(app: &AppHandle) -> ReportMeta {
    let info = os_info::get();
    ReportMeta {
        app_version: app.package_info().version.to_string(),
        os: info.os_type().to_string(),
        os_version: info.version().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        environment: if cfg!(debug_assertions) {
            "development"
        } else {
            "production"
        },
    }
}

/// Mint (and persist) the random install id on first use. Rust owns this
/// field; the frontend only mirrors it so settings roundtrips don't drop it.
fn ensure_install_id(app: &AppHandle) -> Result<String, String> {
    let mut s = settings::load(app).map_err(err)?;
    if let Some(id) = s.privacy.install_id.clone() {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    s.privacy.install_id = Some(id.clone());
    settings::save(app, &s).map_err(err)?;
    Ok(id)
}

// ----- Sentry one-shot client -------------------------------------------------

fn build_sentry_event(scrubbed: &Event, meta: &ReportMeta, install_id: &str) -> sentry::protocol::Event<'static> {
    use sentry::protocol::{Event as SentryEvent, Level, User};

    let mut ev = SentryEvent {
        level: if scrubbed.kind == "panic" {
            Level::Fatal
        } else {
            Level::Error
        },
        message: Some(scrubbed.summary.clone()),
        platform: "native".into(),
        release: Some(format!("typeward@{}", meta.app_version).into()),
        environment: Some(meta.environment.into()),
        // Explicitly no host identity — the random install id is the only one.
        server_name: None,
        user: Some(User {
            id: Some(install_id.to_string()),
            ..Default::default()
        }),
        ..Default::default()
    };
    if let Some(at) = parse_at(&scrubbed.at) {
        ev.timestamp = at.into();
    }
    ev.tags.insert("event.kind".into(), scrubbed.kind.clone());
    ev.tags.insert("os".into(), meta.os.clone());
    ev.tags.insert("os.version".into(), meta.os_version.clone());
    ev.tags.insert("arch".into(), meta.arch.clone());
    ev.extra
        .insert("captured_at".into(), scrubbed.at.clone().into());
    if let Some(detail) = &scrubbed.detail {
        ev.extra.insert("detail".into(), detail.clone().into());
    }
    ev
}

/// One-shot Sentry delivery: init a throwaway client (no integrations, no
/// session tracking), capture, flush with a timeout, drop the guard. The lock
/// serializes senders because `sentry::init` swaps process-global hub state.
fn send_events_one_shot(events: Vec<sentry::protocol::Event<'static>>) -> Result<(), String> {
    static SEND_LOCK: Mutex<()> = Mutex::new(());
    let _serialize = SEND_LOCK.lock().map_err(|_| "report lock poisoned")?;

    let dsn: sentry::types::Dsn = DSN.parse().map_err(err)?;
    let guard = sentry::init(sentry::ClientOptions {
        dsn: Some(dsn),
        default_integrations: false,
        send_default_pii: false,
        server_name: None,
        attach_stacktrace: false,
        ..Default::default()
    });
    for ev in events {
        sentry::capture_event(ev);
    }
    let delivered = guard.flush(Some(FLUSH_TIMEOUT));
    drop(guard);
    if delivered {
        Ok(())
    } else {
        Err("could not deliver the report (offline, or Sentry unreachable) — it stays in the local log".into())
    }
}

// ----- IPC surface -------------------------------------------------------------

/// The exact payload a submission would send, plus the metadata attached to it.
/// Returned WITHOUT sending so the confirm dialog can show it verbatim.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPreview {
    pub kind: String,
    pub at: String,
    pub summary: String,
    pub detail: Option<String>,
    pub app_version: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    /// None until the first submission mints one — the UI says so.
    pub install_id: Option<String>,
}

#[tauri::command]
pub async fn preview_error_report(app: AppHandle, event: Event) -> Result<ReportPreview, String> {
    tokio::task::spawn_blocking(move || -> Result<ReportPreview, String> {
        let scrubbed = scrub_event(&event);
        let meta = report_meta(&app);
        let install_id = settings::load(&app).map_err(err)?.privacy.install_id;
        Ok(ReportPreview {
            kind: scrubbed.kind,
            at: scrubbed.at,
            summary: scrubbed.summary,
            detail: scrubbed.detail,
            app_version: meta.app_version,
            os: meta.os,
            os_version: meta.os_version,
            arch: meta.arch,
            install_id,
        })
    })
    .await
    .map_err(err)?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    /// Echoed so the frontend settings mirror can preserve a just-minted id.
    pub install_id: String,
}

/// Send ONE event the user explicitly confirmed. Deliberately not gated on
/// `privacy.shareCrashReports` — the confirm dialog IS the consent for this
/// single event; the setting only governs the automatic scan.
#[tauri::command]
pub async fn submit_error_report(app: AppHandle, event: Event) -> Result<SubmitResult, String> {
    tokio::task::spawn_blocking(move || -> Result<SubmitResult, String> {
        let scrubbed = scrub_event(&event);
        let meta = report_meta(&app);
        let install_id = ensure_install_id(&app)?;
        let ev = build_sentry_event(&scrubbed, &meta, &install_id);
        send_events_one_shot(vec![ev])?;
        Ok(SubmitResult { install_id })
    })
    .await
    .map_err(err)?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub submitted: usize,
    pub install_id: Option<String>,
}

/// Crash-on-previous-run reporting: submit `panic` events newer than the
/// persisted watermark (`<app_data>/telemetry.submitted`), at most SCAN_CAP per
/// launch. Runs once per process; re-checks the opt-in on the Rust side so a
/// spoofed frontend call can't bypass it. The watermark advances only after a
/// successful flush, so undelivered panics retry next launch.
#[tauri::command]
pub async fn scan_and_submit_crashes(app: AppHandle) -> Result<ScanResult, String> {
    static SCAN_RAN: AtomicBool = AtomicBool::new(false);

    tokio::task::spawn_blocking(move || -> Result<ScanResult, String> {
        let none = ScanResult {
            submitted: 0,
            install_id: None,
        };
        if SCAN_RAN.swap(true, Ordering::SeqCst) {
            return Ok(none);
        }
        if !settings::load(&app).map_err(err)?.privacy.share_crash_reports {
            return Ok(none);
        }
        let events = telemetry::read_all_events()?;
        let picked = select_unsubmitted_panics(&events, read_watermark(), SCAN_CAP);
        if picked.is_empty() {
            return Ok(none);
        }
        let meta = report_meta(&app);
        let install_id = ensure_install_id(&app)?;
        let outbound: Vec<_> = picked
            .iter()
            .map(|e| build_sentry_event(&scrub_event(e), &meta, &install_id))
            .collect();
        send_events_one_shot(outbound)?;
        if let Some(max_at) = picked.iter().filter_map(|e| parse_at(&e.at)).max() {
            write_watermark(max_at)?;
        }
        Ok(ScanResult {
            submitted: picked.len(),
            install_id: Some(install_id),
        })
    })
    .await
    .map_err(err)?
}

// ----- system info (bug reports / Diagnostics header) ---------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolProbe {
    pub name: String,
    pub found: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub app_version: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
    pub compile_engine: String,
    pub tools: Vec<ToolProbe>,
}

/// Toolchain names worth knowing about in a bug report. Probed as
/// found/not-found ONLY — never paths (a path can carry the username).
const PROBED_TOOLS: &[&str] = &["latexmk", "pdflatex", "tectonic", "typst", "texlab", "tinymist"];

#[tauri::command]
pub async fn collect_system_info(app: AppHandle) -> Result<SystemInfo, String> {
    tokio::task::spawn_blocking(move || -> Result<SystemInfo, String> {
        let meta = report_meta(&app);
        let compile_engine = settings::load(&app).map_err(err)?.compile_engine;
        let tools = PROBED_TOOLS
            .iter()
            .map(|name| ToolProbe {
                name: (*name).into(),
                found: which::which(name).is_ok(),
            })
            .collect();
        Ok(SystemInfo {
            app_version: meta.app_version,
            os: meta.os,
            os_version: meta.os_version,
            arch: meta.arch,
            compile_engine,
            tools,
        })
    })
    .await
    .map_err(err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, at: &str) -> Event {
        Event {
            at: at.into(),
            kind: kind.into(),
            summary: "s".into(),
            detail: None,
        }
    }

    // --- scrub_text ---

    #[test]
    fn home_dir_collapses_to_tilde_windows() {
        let home = Path::new("C:\\Users\\marek");
        let out = scrub_text(
            "panicked at C:\\Users\\marek\\Documents\\Typeward\\thesis\\main.tex",
            Some(home),
        );
        assert_eq!(out, "panicked at ~\\Documents\\Typeward\\thesis\\main.tex");
    }

    #[test]
    fn home_dir_matches_case_insensitively_and_both_slash_styles() {
        let home = Path::new("C:\\Users\\marek");
        let out = scrub_text("saw c:/users/MAREK/proj and C:\\USERS\\Marek\\x", Some(home));
        assert_eq!(out, "saw ~/proj and ~\\x");
    }

    #[test]
    fn posix_home_collapses_to_tilde() {
        let home = Path::new("/home/marek");
        let out = scrub_text("io error at /home/marek/projects/a.tex", Some(home));
        assert_eq!(out, "io error at ~/projects/a.tex");
    }

    #[test]
    fn non_home_windows_path_collapses_to_basename() {
        let out = scrub_text(
            "spawn failed: C:\\Program-Files\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe exited",
            Some(Path::new("C:\\Users\\marek")),
        );
        assert_eq!(out, "spawn failed: pdflatex.exe exited");
    }

    #[test]
    fn non_home_posix_path_collapses_to_basename_keeping_line_numbers() {
        let out = scrub_text(
            "at /usr/lib/rustlib/src/rust/library/core/src/panicking.rs:75:14",
            Some(Path::new("/home/marek")),
        );
        assert_eq!(out, "at panicking.rs:75:14");
    }

    #[test]
    fn unc_path_collapses_to_basename() {
        let out = scrub_text("read \\\\fileserver\\share\\doc.tex failed", None);
        assert_eq!(out, "read doc.tex failed");
    }

    #[test]
    fn urls_survive_scrubbing() {
        let url = "https://o451.ingest.de.sentry.io/451?x=1";
        assert_eq!(scrub_text(url, Some(Path::new("/home/marek"))), url);
    }

    #[test]
    fn tilde_paths_and_relative_paths_survive() {
        let text = "wrote ~/notes/a.md and src\\telemetry.rs:53:9";
        assert_eq!(scrub_text(text, Some(Path::new("C:\\Users\\marek"))), text);
    }

    #[test]
    fn no_home_dir_still_collapses_absolute_paths() {
        assert_eq!(scrub_text("open /etc/passwd failed", None), "open passwd failed");
    }

    #[test]
    fn scrub_preserves_non_path_text_verbatim() {
        let text = "latexmk exit 1: Undefined control sequence \\foo (ratio 3/4)";
        assert_eq!(scrub_text(text, Some(Path::new("/home/marek"))), text);
    }

    // --- watermark ---

    #[test]
    fn parse_watermark_accepts_rfc3339_and_normalizes_to_utc() {
        let w = parse_watermark("2026-07-07T10:00:00+02:00\n").expect("parses");
        assert_eq!(w.to_rfc3339(), "2026-07-07T08:00:00+00:00");
    }

    #[test]
    fn parse_watermark_rejects_garbage() {
        assert!(parse_watermark("").is_none());
        assert!(parse_watermark("yesterday").is_none());
        assert!(parse_watermark("2026-07-07").is_none());
    }

    // --- scan selection ---

    #[test]
    fn scan_selects_only_panics_newer_than_watermark() {
        let events = vec![
            ev("panic", "2026-07-01T00:00:00Z"),
            ev("compile-failed", "2026-07-03T00:00:00Z"),
            ev("panic", "2026-07-04T00:00:00Z"),
            ev("frontend-error", "2026-07-05T00:00:00Z"),
        ];
        let watermark = parse_watermark("2026-07-02T00:00:00Z");
        let picked = select_unsubmitted_panics(&events, watermark, 5);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].at, "2026-07-04T00:00:00Z");
    }

    #[test]
    fn scan_without_watermark_takes_all_panics_capped() {
        let events: Vec<Event> = (0..9)
            .map(|i| ev("panic", &format!("2026-07-0{}T00:00:00Z", i + 1)))
            .collect();
        let picked = select_unsubmitted_panics(&events, None, 5);
        assert_eq!(picked.len(), 5);
        // Oldest first, so the watermark advances monotonically across launches.
        assert_eq!(picked[0].at, "2026-07-01T00:00:00Z");
        assert_eq!(picked[4].at, "2026-07-05T00:00:00Z");
    }

    #[test]
    fn scan_skips_events_with_unparseable_timestamps() {
        let events = vec![ev("panic", "not-a-time"), ev("panic", "2026-07-04T00:00:00Z")];
        let picked = select_unsubmitted_panics(&events, None, 5);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].at, "2026-07-04T00:00:00Z");
    }
}
