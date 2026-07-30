//! Scans a project's source files for TODO/FIXME/NOTE markers so the editor's
//! TODO tab can list them. Runs on the blocking pool, gated to registered
//! roots, and bounded (file count / per-file size / total items) so a large or
//! adversarial project can't wedge the scan.

use std::path::Path;

use serde::Serialize;

use crate::project;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// Project-relative path, forward slashes.
    pub file: String,
    /// 1-based line number.
    pub line: u32,
    pub kind: String, // "todo" | "fixme" | "note"
    /// Trimmed text following the marker, capped.
    pub text: String,
}

const MAX_FILES: usize = 500;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ITEMS: usize = 1000;
const MAX_TEXT_CHARS: usize = 200;
const SCAN_EXTS: &[&str] = &["tex", "typ", "md", "bib", "txt"];
const KEYWORDS: &[(&str, &str)] = &[("TODO", "todo"), ("FIXME", "fixme"), ("NOTE", "note")];

#[tauri::command]
pub async fn scan_project_todos(project_root: String) -> Result<Vec<TodoItem>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<TodoItem>, String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        Ok(scan(root))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn scan(root: &Path) -> Vec<TodoItem> {
    let files = match crate::integrations::templates::collect_project_files(root) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    let mut scanned = 0usize;
    for path in files {
        if scanned >= MAX_FILES || out.len() >= MAX_ITEMS {
            break;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !SCAN_EXTS.contains(&ext.as_str()) {
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() <= MAX_FILE_BYTES => {}
            _ => continue,
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        scanned += 1;
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        for (idx, raw_line) in content.lines().enumerate() {
            if out.len() >= MAX_ITEMS {
                break;
            }
            if let Some((kind, text)) = scan_line(&ext, raw_line) {
                out.push(TodoItem {
                    file: rel.clone(),
                    line: (idx + 1) as u32,
                    kind: kind.to_string(),
                    text: cap_text(text),
                });
            }
        }
    }
    out
}

fn scan_line(ext: &str, line: &str) -> Option<(&'static str, String)> {
    match ext {
        "tex" | "bib" => {
            // `\todo{...}` (todonotes) anywhere on the line.
            if let Some(pos) = line.find("\\todo{") {
                let inner_start = pos + "\\todo{".len();
                if let Some(end) = line[inner_start..].find('}') {
                    return Some((
                        "todo",
                        line[inner_start..inner_start + end].trim().to_string(),
                    ));
                }
            }
            keyword_in(tex_comment(line)?)
        }
        "typ" => keyword_in(line.split_once("//").map(|(_, c)| c)?),
        "md" => {
            let after = line.split_once("<!--").map(|(_, c)| c)?;
            let body = after.split_once("-->").map(|(b, _)| b).unwrap_or(after);
            keyword_in(body)
        }
        _ => None,
    }
}

/// The text after the first *unescaped* `%` (a LaTeX line comment), or None.
fn tex_comment(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'%' {
            let mut backslashes = 0;
            let mut j = i;
            while j > 0 && bytes[j - 1] == b'\\' {
                backslashes += 1;
                j -= 1;
            }
            if backslashes % 2 == 0 {
                return Some(&line[i + 1..]);
            }
        }
    }
    None
}

/// Find the earliest TODO/FIXME/NOTE (word-boundary, case-sensitive) in `text`
/// and return its kind plus the trimmed remainder (a leading `:`/`!` dropped).
fn keyword_in(text: &str) -> Option<(&'static str, String)> {
    let mut best: Option<(usize, &'static str, usize)> = None;
    for &(kw, kind) in KEYWORDS {
        if let Some(pos) = find_keyword(text, kw)
            && best.is_none_or(|(bp, _, _)| pos < bp)
        {
            best = Some((pos, kind, kw.len()));
        }
    }
    let (pos, kind, kwlen) = best?;
    let after = text[pos + kwlen..].trim_start();
    let after = after
        .strip_prefix(':')
        .or_else(|| after.strip_prefix('!'))
        .unwrap_or(after);
    Some((kind, after.trim().to_string()))
}

/// A byte that counts as part of a word for keyword-boundary detection:
/// ASCII alphanumerics, underscore (standard word char), and any non-ASCII byte
/// (a UTF-8 lead/continuation byte of a letter like `é`). Without the latter two,
/// `TODO_LIST` and `éTODO` would spuriously match.
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

fn find_keyword(text: &str, kw: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let kb = kw.as_bytes();
    if kb.len() > bytes.len() {
        return None;
    }
    for i in 0..=(bytes.len() - kb.len()) {
        if &bytes[i..i + kb.len()] == kb {
            let before_ok = i == 0 || !is_word_byte(bytes[i - 1]);
            let after_idx = i + kb.len();
            let after_ok = after_idx >= bytes.len() || !is_word_byte(bytes[after_idx]);
            if before_ok && after_ok {
                return Some(i);
            }
        }
    }
    None
}

fn cap_text(s: String) -> String {
    if s.chars().count() <= MAX_TEXT_CHARS {
        return s;
    }
    s.chars().take(MAX_TEXT_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tex_comment_respects_escaped_percent() {
        assert_eq!(tex_comment(r"50\% done % TODO: fix"), Some(" TODO: fix"));
        assert_eq!(tex_comment(r"no comment here"), None);
    }

    #[test]
    fn scans_tex_comment_and_todonotes() {
        assert_eq!(
            scan_line("tex", "  % TODO: write intro"),
            Some(("todo", "write intro".to_string()))
        );
        assert_eq!(
            scan_line("tex", r"text \todo{expand this} more"),
            Some(("todo", "expand this".to_string()))
        );
        // Code before an unescaped % is ignored; the keyword must be in-comment.
        assert_eq!(scan_line("tex", "\\section{TODO list}"), None);
    }

    #[test]
    fn scans_typst_and_markdown() {
        assert_eq!(
            scan_line("typ", "  // FIXME broken"),
            Some(("fixme", "broken".to_string()))
        );
        assert_eq!(
            scan_line("md", "text <!-- NOTE: check later --> more"),
            Some(("note", "check later".to_string()))
        );
    }

    #[test]
    fn word_boundary_avoids_false_positives() {
        // "TODOLIST" should not match TODO (no boundary after).
        assert_eq!(scan_line("typ", "// TODOLIST"), None);
        assert_eq!(
            scan_line("typ", "// x-NOTE-y"),
            Some(("note", "-y".to_string()))
        );
        // Underscore is a word char — TODO_LIST is a single identifier.
        assert_eq!(scan_line("typ", "// TODO_LIST placeholder"), None);
        // A non-ASCII letter glued to the keyword is not a boundary.
        assert_eq!(scan_line("typ", "// éTODO"), None);
    }
}
