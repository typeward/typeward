//! SyncTeX bridge.
//!
//! We invoke the system `synctex` CLI rather than hand-parsing `.synctex.gz`.
//! Every TeX Live / MiKTeX / MacTeX install ships it, and shelling out
//! avoids pulling in `synctex-sys` (which requires linking against the
//! distro's C runtime — painful for Windows builds and irrelevant for
//! Tectonic users, who don't get SyncTeX features anyway).
//!
//! When the CLI isn't on PATH we return `Ok(None)` so the frontend can
//! quietly disable sync features instead of erroring.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::project;

/// SyncTeX lookups are fast; a hung CLI — e.g. gunzipping a malformed or
/// decompression-bomb `.synctex.gz` shipped inside a malicious project — must
/// not park the blocking worker. Bounds each spawn; export_annotated calls
/// `forward` up to 500× per export.
const SYNCTEX_TIMEOUT: Duration = Duration::from_secs(30);
/// synctex emits small text; cap the capture defensively.
const SYNCTEX_OUTPUT_CAP: usize = 1024 * 1024;

/// Run the `which`-resolved synctex CLI through the shared bounded runner
/// (deadline + process-tree kill + capped capture + stdin=null). Returns the
/// stdout text on success, or `None` on timeout / non-zero exit — the same
/// graceful "no sync" the callers already expect. Called from `spawn_blocking`
/// contexts, so it drives the async runner via the current runtime handle.
fn run_synctex_bounded(
    synctex: &Path,
    args: &[String],
    cwd: &Path,
) -> Result<Option<String>, String> {
    let out = tokio::runtime::Handle::current().block_on(crate::compile::run_bounded(
        synctex,
        args,
        cwd,
        SYNCTEX_TIMEOUT,
        SYNCTEX_OUTPUT_CAP,
        None,
    ))?;
    if out.timed_out || !out.status.map(|s| s.success()).unwrap_or(false) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

#[derive(Debug, Clone, Serialize)]
pub struct ForwardLocation {
    pub page: u32,
    /// PDF point coordinates (1pt = 1/72 inch), origin at top-left.
    pub x: f64,
    pub y: f64,
    pub h: f64,
    pub v: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct InverseLocation {
    /// Absolute source file path (synctex CLI returns absolutes).
    pub file: String,
    pub line: u32,
}

/// Forward search: source position → PDF location. `source_file` should be
/// an absolute path; `line` is 1-based.
///
/// Returns the FIRST result block (synctex CLI may emit several for a
/// single query — they typically represent close-by hbox/vbox candidates).
pub fn forward(
    pdf_path: &Path,
    source_file: &Path,
    line: u32,
) -> Result<Option<ForwardLocation>, String> {
    let Ok(synctex) = crate::detect::resolve_program("synctex") else {
        return Ok(None);
    };
    forward_with(&synctex, pdf_path, source_file, line)
}

/// `forward` with a pre-resolved synctex path — lets a caller that runs many
/// lookups (annotated export, up to 500) resolve the binary once instead of
/// PATH-scanning per call.
pub(crate) fn forward_with(
    synctex: &Path,
    pdf_path: &Path,
    source_file: &Path,
    line: u32,
) -> Result<Option<ForwardLocation>, String> {
    if !pdf_path.exists() {
        return Ok(None);
    }

    // synctex view -i <line>:<col>:<file> -o <pdf>. Spawn the absolute path,
    // not the bare name, so the binary is never resolved from a current dir.
    let input = format!("{line}:1:{}", source_file.display());
    let args = [
        "view".to_string(),
        "-i".to_string(),
        input,
        "-o".to_string(),
        pdf_path.to_string_lossy().into_owned(),
    ];
    let cwd = pdf_path.parent().unwrap_or_else(|| Path::new("."));
    let Some(text) = run_synctex_bounded(synctex, &args, cwd)? else {
        return Ok(None);
    };
    Ok(parse_forward_result(&text))
}

/// Inverse search: PDF page+coordinates → source position. `x` and `y`
/// are in PDF points (top-left origin).
pub fn inverse(
    pdf_path: &Path,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<InverseLocation>, String> {
    let Ok(synctex) = crate::detect::resolve_program("synctex") else {
        return Ok(None);
    };
    if !pdf_path.exists() {
        return Ok(None);
    }

    // synctex edit -o <page>:<x>:<y>:<pdf>. Spawn the absolute path, not the
    // bare name, so the binary is never resolved from a current dir.
    let arg = format!("{page}:{x}:{y}:{}", pdf_path.display());
    let args = ["edit".to_string(), "-o".to_string(), arg];
    let cwd = pdf_path.parent().unwrap_or_else(|| Path::new("."));
    let Some(text) = run_synctex_bounded(&synctex, &args, cwd)? else {
        return Ok(None);
    };
    Ok(parse_inverse_result(&text))
}

/// Parse `synctex view` output. Looks for the first SyncTeX result block
/// and pulls out Page, x, y, h, v.
fn parse_forward_result(text: &str) -> Option<ForwardLocation> {
    let mut in_block = false;
    let mut page: Option<u32> = None;
    let mut x: Option<f64> = None;
    let mut y: Option<f64> = None;
    let mut h: Option<f64> = None;
    let mut v: Option<f64> = None;

    for line in text.lines() {
        let line = line.trim();
        if line == "SyncTeX result begin" {
            in_block = true;
            continue;
        }
        if line == "SyncTeX result end" {
            break;
        }
        if !in_block {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Page:") {
            // Take only the first page entry; subsequent rows are alternates.
            if page.is_none() {
                page = rest.trim().parse().ok();
            }
        } else if let Some(rest) = line.strip_prefix("x:") {
            if x.is_none() {
                x = rest.trim().parse().ok();
            }
        } else if let Some(rest) = line.strip_prefix("y:") {
            if y.is_none() {
                y = rest.trim().parse().ok();
            }
        } else if let Some(rest) = line.strip_prefix("h:") {
            if h.is_none() {
                h = rest.trim().parse().ok();
            }
        } else if let Some(rest) = line.strip_prefix("v:") {
            if v.is_none() {
                v = rest.trim().parse().ok();
            }
        }
    }

    Some(ForwardLocation {
        page: page?,
        x: x?,
        y: y?,
        h: h.unwrap_or(0.0),
        v: v.unwrap_or(0.0),
    })
}

/// Parse `synctex edit` output. Pulls Input (source file) and Line.
fn parse_inverse_result(text: &str) -> Option<InverseLocation> {
    let mut in_block = false;
    let mut file: Option<String> = None;
    let mut line_no: Option<u32> = None;

    for line in text.lines() {
        let line = line.trim();
        if line == "SyncTeX result begin" {
            in_block = true;
            continue;
        }
        if line == "SyncTeX result end" {
            break;
        }
        if !in_block {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Input:") {
            if file.is_none() {
                file = Some(rest.trim().to_string());
            }
        } else if let Some(rest) = line.strip_prefix("Line:") {
            if line_no.is_none() {
                line_no = rest.trim().parse().ok();
            }
        }
    }

    Some(InverseLocation {
        file: file?,
        line: line_no?,
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct ForwardArgs {
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    /// PDF path, absolute. Frontend has this from the last compile result.
    #[serde(rename = "pdfPath")]
    pub pdf_path: String,
    /// Source file relative to project_root.
    #[serde(rename = "sourceFile")]
    pub source_file: String,
    pub line: u32,
}

#[tauri::command]
pub async fn synctex_forward(args: ForwardArgs) -> Result<Option<ForwardLocation>, String> {
    // Off the event-loop thread: `which` PATH-scans and the synctex CLI
    // blocks while gunzipping/parsing a potentially multi-MB .synctex.gz.
    tokio::task::spawn_blocking(move || -> Result<Option<ForwardLocation>, String> {
        if !project::is_registered_root(Path::new(&args.project_root)) {
            return Err(format!("not an opened project root: {}", args.project_root));
        }
        let root = PathBuf::from(&args.project_root)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let source = project::resolve_existing_project_path(&root, &args.source_file)
            .map_err(|e| e.to_string())?;
        let Some(pdf) = resolve_pdf_under_root(&root, &args.pdf_path)? else {
            return Ok(None);
        };
        forward(&pdf, &source, args.line)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, serde::Deserialize)]
pub struct InverseArgs {
    #[serde(rename = "projectRoot")]
    pub project_root: String,
    #[serde(rename = "pdfPath")]
    pub pdf_path: String,
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

#[tauri::command]
pub async fn synctex_inverse(args: InverseArgs) -> Result<Option<InverseLocation>, String> {
    tokio::task::spawn_blocking(move || -> Result<Option<InverseLocation>, String> {
        if !project::is_registered_root(Path::new(&args.project_root)) {
            return Err(format!("not an opened project root: {}", args.project_root));
        }
        let root = PathBuf::from(&args.project_root)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let Some(pdf) = resolve_pdf_under_root(&root, &args.pdf_path)? else {
            return Ok(None);
        };
        inverse(&pdf, args.page, args.x, args.y)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn resolve_pdf_under_root(
    root: &Path,
    pdf_path: &str,
) -> Result<Option<PathBuf>, String> {
    let pdf = PathBuf::from(pdf_path);
    if !pdf.exists() {
        return Ok(None);
    }
    let pdf = pdf.canonicalize().map_err(|e| e.to_string())?;
    if !pdf.starts_with(root) {
        return Err(format!("PDF path escapes project root: {}", pdf.display()));
    }
    if pdf.extension().and_then(|s| s.to_str()) != Some("pdf") {
        return Err(format!("SyncTeX target is not a PDF: {}", pdf.display()));
    }
    Ok(Some(pdf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_synctex_view_output() {
        let text = "This is SyncTeX command line utility, version 1.6\nSyncTeX result begin\nOutput:/tmp/main.pdf\nPage:3\nx:69.493\ny:131.964\nh:71.554\nv:135.000\nW:469.957\nH:9.741\nbefore:\noffset:0\nmiddle:\nlength:0\nafter:\nSyncTeX result end\n";
        let loc = parse_forward_result(text).expect("should parse");
        assert_eq!(loc.page, 3);
        assert!((loc.x - 69.493).abs() < 1e-6);
        assert!((loc.y - 131.964).abs() < 1e-6);
        assert!((loc.h - 71.554).abs() < 1e-6);
        assert!((loc.v - 135.0).abs() < 1e-6);
    }

    #[test]
    fn forward_parser_takes_first_block_only() {
        // synctex may emit multiple alternates within a single result block;
        // we want the first Page/x/y triple, not the last.
        let text = "SyncTeX result begin\nOutput:/tmp/main.pdf\nPage:2\nx:10.0\ny:20.0\nPage:5\nx:99.0\ny:88.0\nSyncTeX result end\n";
        let loc = parse_forward_result(text).expect("should parse");
        assert_eq!(loc.page, 2);
        assert!((loc.x - 10.0).abs() < 1e-6);
    }

    #[test]
    fn returns_none_when_no_block() {
        let text = "synctex: nothing found\n";
        assert!(parse_forward_result(text).is_none());
    }

    #[test]
    fn parses_synctex_edit_output() {
        let text = "SyncTeX result begin\nOutput:/tmp/main.pdf\nInput:/abs/path/main.tex\nLine:42\nColumn:-1\nOffset:0\nContext:\nSyncTeX result end\n";
        let loc = parse_inverse_result(text).expect("should parse");
        assert_eq!(loc.file, "/abs/path/main.tex");
        assert_eq!(loc.line, 42);
    }

    #[test]
    fn inverse_missing_input_returns_none() {
        let text = "SyncTeX result begin\nLine:42\nSyncTeX result end\n";
        assert!(parse_inverse_result(text).is_none());
    }

    #[test]
    fn resolve_pdf_under_root_rejects_non_pdf_targets() {
        let mut root = std::env::temp_dir();
        root.push(format!("typeward-synctex-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let not_pdf = root.join("main.txt");
        std::fs::write(&not_pdf, "not a pdf").unwrap();
        let root = root.canonicalize().unwrap();

        let err = resolve_pdf_under_root(&root, &not_pdf.to_string_lossy()).unwrap_err();

        assert!(err.contains("not a PDF"));
    }
}
