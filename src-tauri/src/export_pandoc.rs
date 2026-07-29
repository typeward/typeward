//! Pandoc-backed document export (Word `.docx` + standalone HTML).
//!
//! The compiled artifact lands inside the project's `.typeward/build/` sidecar
//! (same convention as `export_project_zip`); the frontend copies the bytes to
//! the user's chosen destination through the dialog-scoped fs plugin, so no new
//! arbitrary-destination write primitive is introduced.
//!
//! The HTML export is deliberately NOT self-contained: `--embed-resources`
//! would let an untrusted document have pandoc fetch and inline arbitrary
//! remote URLs and local files at export time, which is an egress + local-file
//! read channel outside the app's outbound allowlist. Portability of the
//! single file is traded away for not handing project content that reach.
//!
//! Pandoc runs over attacker-influenceable input (its LaTeX reader expands
//! macros and follows `\input`), so the spawn goes through the compile crate's
//! bounded runner — deadline, process-tree kill, capped capture — rather than
//! a raw `Command::output()`.

use std::path::Path;
use std::time::Duration;

use crate::project::{Project, ProjectFormat};

/// Cap captured stderr so a runaway pandoc log can't bloat the error string
/// (which is also what lands in telemetry).
const MAX_STDERR_BYTES: usize = 4096;

/// Generous but finite: a book-length conversion is minutes, an expansion loop
/// is forever.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(300);

/// The `--version` probe answers immediately or something is wrong.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

#[tauri::command]
pub async fn export_pandoc(project: Project, format: String) -> Result<String, String> {
    run(project, &format).await
}

async fn run(project: Project, format: &str) -> Result<String, String> {
    let to = match format {
        "docx" => "docx",
        "html" => "html",
        other => return Err(format!("unsupported export format: {other}")),
    };

    let (root, root_file) = crate::commands::checked_project_root_and_file(&project)?;

    let pandoc = crate::detect::resolve_program("pandoc").map_err(|_| {
        "pandoc was not found on PATH — install it from pandoc.org to export Word/HTML".to_string()
    })?;

    let from = match project.format {
        ProjectFormat::Latex => "latex",
        ProjectFormat::Typst => {
            require_pandoc_typst(&pandoc).await?;
            "typst"
        }
    };

    let out_dir = root.join(".typeward").join("build");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out = out_dir.join(format!("export.{to}"));

    // Spawn the `which`-resolved absolute path with `current_dir(root)` so
    // relative `\input`/`\includegraphics`/image paths resolve, while the
    // program itself is never resolved from the (untrusted) project dir. The
    // root file is validated (leading-dash guard) so it can't inject a flag.
    let args: Vec<String> = vec![
        "-f".into(),
        from.into(),
        "-t".into(),
        to.into(),
        "--standalone".into(),
        "-o".into(),
        out.to_string_lossy().into_owned(),
        root_file.clone(),
    ];

    let output = crate::compile::run_bounded_external(&pandoc, &args, &root, EXPORT_TIMEOUT)
        .await
        .map_err(|e| format!("pandoc spawn failed: {e}"))?;
    if output.timed_out {
        return Err(format!(
            "pandoc export timed out after {} minutes — the document may expand without end",
            EXPORT_TIMEOUT.as_secs() / 60
        ));
    }
    if !output.success() {
        let stderr = cap(&String::from_utf8_lossy(&output.stderr), MAX_STDERR_BYTES);
        return Err(format!("pandoc export failed: {stderr}"));
    }

    Ok(out.to_string_lossy().into_owned())
}

/// Pandoc gained the Typst reader in 3.1.12. Reject older builds with an
/// actionable message rather than letting pandoc emit an opaque
/// "unknown input format typst".
async fn require_pandoc_typst(pandoc: &Path) -> Result<(), String> {
    let cwd = pandoc.parent().unwrap_or(Path::new("."));
    let output = crate::compile::run_bounded_external(
        pandoc,
        &["--version".to_string()],
        cwd,
        VERSION_PROBE_TIMEOUT,
    )
    .await
    .map_err(|e| format!("pandoc spawn failed: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let ver = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or_else(|| "could not determine pandoc version".to_string())?;
    if !version_at_least(ver, (3, 1, 12)) {
        return Err(format!(
            "pandoc {ver} is too old for Typst input; 3.1.12+ required"
        ));
    }
    Ok(())
}

/// Compare a dotted version string (e.g. `3.1.11.1`) against a minimum on its
/// first three components. Extra components and non-numeric junk degrade to 0.
fn version_at_least(ver: &str, min: (u32, u32, u32)) -> bool {
    let mut parts = ver.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    let got = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    got >= min
}

/// Truncate on a UTF-8 char boundary so `String::truncate` never panics.
fn cap(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_gate_accepts_new_and_rejects_old() {
        assert!(version_at_least("3.1.12", (3, 1, 12)));
        assert!(version_at_least("3.2", (3, 1, 12)));
        assert!(version_at_least("3.1.13", (3, 1, 12)));
        assert!(version_at_least("4.0.0", (3, 1, 12)));
        assert!(!version_at_least("3.1.11.1", (3, 1, 12)));
        assert!(!version_at_least("3.1.11", (3, 1, 12)));
        assert!(!version_at_least("2.19", (3, 1, 12)));
    }

    #[test]
    fn cap_truncates_on_char_boundary() {
        let s = "aéb".repeat(4000);
        let capped = cap(&s, 4096);
        assert!(capped.len() <= 4096);
        // Must still be valid UTF-8 (no panic, no split codepoint).
        assert!(std::str::from_utf8(capped.as_bytes()).is_ok());
    }
}
