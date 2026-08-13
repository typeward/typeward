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
//! read channel outside the app's outbound allowlist. Portability of the single
//! file is traded away for keeping untrusted project content off that channel.
//!
//! Pandoc runs over attacker-influenceable input (its LaTeX reader expands
//! macros and follows `\input`), so the spawn goes through the compile crate's
//! bounded runner — deadline, process-tree kill, capped capture — rather than
//! a raw `Command::output()`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::project::{Project, ProjectFormat};

/// Cap captured stderr so a runaway pandoc log can't bloat the error string
/// surfaced to the frontend.
const MAX_STDERR_BYTES: usize = 4096;

/// A large book -> docx can take minutes, but an unbounded pandoc on adversarial
/// project content (a Lua filter, pathological input recursion) must never park
/// a blocking-pool worker forever.
const EXPORT_TIMEOUT: Duration = Duration::from_secs(600);

/// Head cap per captured stream so pandoc's stderr stays bounded DURING capture,
/// not merely truncated after it has already been buffered whole.
const EXPORT_OUTPUT_CAP: usize = 256 * 1024;

struct PandocPlan {
    pandoc: PathBuf,
    args: Vec<String>,
    root: PathBuf,
    out: String,
}

#[tauri::command]
pub async fn export_pandoc(project: Project, format: String) -> Result<String, String> {
    // The `which` PATH-scan, version probe, and dir creation run off the event
    // loop; the pandoc spawn itself goes through the shared bounded runner.
    let plan = tokio::task::spawn_blocking(move || plan_export(project, &format))
        .await
        .map_err(|e| e.to_string())??;

    // Bounded spawn: deadline + process-tree kill + capped capture + stdin=null,
    // matching the compile-subprocess invariant (pandoc runs current_dir(root)
    // on attacker-controlled project content). Without this an adversarial or
    // hanging pandoc would park the blocking worker indefinitely.
    let out = crate::compile::run_bounded(
        &plan.pandoc,
        &plan.args,
        &plan.root,
        EXPORT_TIMEOUT,
        EXPORT_OUTPUT_CAP,
        None,
        None,
    )
    .await?;

    if out.timed_out {
        return Err(format!(
            "pandoc export timed out after {} minutes — aborted",
            EXPORT_TIMEOUT.as_secs() / 60
        ));
    }
    match out.status {
        Some(s) if s.success() => Ok(plan.out),
        _ => {
            let stderr = cap(&String::from_utf8_lossy(&out.stderr), MAX_STDERR_BYTES);
            Err(format!("pandoc export failed: {stderr}"))
        }
    }
}

fn plan_export(project: Project, format: &str) -> Result<PandocPlan, String> {
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
            require_pandoc_typst(&pandoc)?;
            "typst"
        }
    };

    let out_dir = root.join(".typeward").join("build");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let out = out_dir.join(format!("export.{to}"));

    // The spawn (run_bounded) uses current_dir(root) so relative
    // `\input`/`\includegraphics`/image paths resolve, while the program itself
    // is the `which`-resolved absolute path — never resolved from the (untrusted)
    // project dir. The root file is validated (leading-dash guard) so it can't
    // inject a flag.
    let out_str = out.to_string_lossy().into_owned();
    let args = build_pandoc_args(from, to, &out_str, root_file);

    Ok(PandocPlan {
        pandoc,
        args,
        root,
        out: out_str,
    })
}

/// Build the pandoc argument vector. `root_file` is the validated (leading-dash-
/// guarded) project-relative input path and is placed LAST — after `-o <out>` —
/// so it is always the positional input, never mistaken for a flag.
///
/// HTML export intentionally omits `--embed-resources` (see the module doc): on
/// untrusted project content that flag is an egress + local-file-read channel
/// outside the outbound allowlist. The exported HTML references its assets by
/// relative path instead.
fn build_pandoc_args(from: &str, to: &str, out: &str, root_file: String) -> Vec<String> {
    vec![
        "-f".to_string(),
        from.to_string(),
        "-t".to_string(),
        to.to_string(),
        "--standalone".to_string(),
        "-o".to_string(),
        out.to_string(),
        root_file,
    ]
}

/// Pandoc gained the Typst reader in 3.1.12. Reject older builds with an
/// actionable message rather than letting pandoc emit an opaque
/// "unknown input format typst". This probes `pandoc --version` (a trusted
/// binary, no project input) so a raw `Command` is fine — the untrusted-input
/// spawn is the export itself, which is bounded.
fn require_pandoc_typst(pandoc: &Path) -> Result<(), String> {
    let mut cmd = Command::new(pandoc);
    cmd.arg("--version");
    crate::detect::hide_console(&mut cmd);
    let output = cmd
        .output()
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
    fn pandoc_args_place_input_last_and_omit_embed_resources() {
        let docx = build_pandoc_args("latex", "docx", "/b/export.docx", "main.tex".to_string());
        assert_eq!(
            docx,
            vec![
                "-f",
                "latex",
                "-t",
                "docx",
                "--standalone",
                "-o",
                "/b/export.docx",
                "main.tex",
            ]
        );
        // The validated input is always the final positional arg (never a flag),
        // and -o immediately precedes the output path.
        assert_eq!(docx.last().unwrap(), "main.tex");
        let oi = docx.iter().position(|s| s == "-o").unwrap();
        assert_eq!(docx[oi + 1], "/b/export.docx");

        // --embed-resources is never passed: on untrusted input it is an egress +
        // local-file-read channel outside the outbound allowlist (module doc).
        let html = build_pandoc_args("typst", "html", "/b/e.html", "m.typ".to_string());
        assert!(!html.iter().any(|s| s == "--embed-resources"));
        assert!(!docx.iter().any(|s| s == "--embed-resources"));
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
