//! Project-wide symbol index: cross-reference labels and citation keys scanned
//! from a LaTeX project's source files, so `\ref`/`\cite` completion can be
//! served locally — uncapped and without a language-server round trip.
//!
//! This is the saved-files half of the Phase 4 ownership split: Rust indexes
//! what is on disk; the frontend overlays the active buffer's own labels. The
//! walk reuses `templates::collect_project_files` (symlink / sidecar / VCS /
//! build-artifact skipping, depth cap) and is bounded like the TODO scan so a
//! large or adversarial project can't wedge it. Results are cached per
//! canonical root in [`IndexManager`] and reused until the frontend asks for a
//! refresh (driven by watcher events, same as the TODO scan).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::Serialize;

use crate::project;

/// A cross-reference label (`\label{key}`) or citation key with where it is
/// defined, so completion can show a location hint and jump to the source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    /// The label or citation key itself.
    pub key: String,
    /// Project-relative path of the defining file, forward slashes.
    pub file: String,
    /// 1-based line of the definition.
    pub line: u32,
    /// A short human hint: the section a label sits under, or the bib entry
    /// title. Empty when none was found nearby.
    pub context: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIndex {
    pub labels: Vec<IndexEntry>,
    pub citations: Vec<IndexEntry>,
    /// True when a cap was hit and the index is partial — the completion UI
    /// can note it (still far more than texlab's 50).
    pub truncated: bool,
}

const MAX_FILES: usize = 2000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const MAX_CONTEXT_CHARS: usize = 120;
const TEX_EXTS: &[&str] = &["tex", "ltx", "cls", "sty", "def", "clo"];

/// Cloneable (state is behind an `Arc`) so commands can move a handle into
/// `spawn_blocking`; every clone shares the one lock. Keyed by canonical root.
#[derive(Default, Clone)]
pub struct IndexManager {
    inner: Arc<RwLock<HashMap<PathBuf, ProjectIndex>>>,
}

impl IndexManager {
    fn cache_key(root: &Path) -> PathBuf {
        root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
    }

    fn get(&self, root: &Path) -> Option<ProjectIndex> {
        let key = Self::cache_key(root);
        self.inner.read().ok()?.get(&key).cloned()
    }

    fn put(&self, root: &Path, index: ProjectIndex) {
        let key = Self::cache_key(root);
        if let Ok(mut map) = self.inner.write() {
            map.insert(key, index);
        }
    }

    fn evict(&self, root: &Path) {
        let key = Self::cache_key(root);
        if let Ok(mut map) = self.inner.write() {
            map.remove(&key);
        }
    }
}

/// Return the project's label + citation index, scanning from disk unless a
/// cached result exists and `refresh` is false. The frontend passes
/// `refresh = true` on watcher events for the project.
#[tauri::command]
pub async fn index_project(
    manager: tauri::State<'_, IndexManager>,
    project_root: String,
    refresh: bool,
) -> Result<ProjectIndex, String> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<ProjectIndex, String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        if !refresh
            && let Some(cached) = manager.get(root)
        {
            return Ok(cached);
        }
        let index = scan(root);
        manager.put(root, index.clone());
        Ok(index)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop a project's cached index (called when the project closes).
#[tauri::command]
pub async fn unindex_project(
    manager: tauri::State<'_, IndexManager>,
    project_root: String,
) -> Result<(), String> {
    manager.evict(Path::new(&project_root));
    Ok(())
}

fn scan(root: &Path) -> ProjectIndex {
    let files = match crate::integrations::templates::collect_project_files(root) {
        Ok(f) => f,
        Err(_) => return ProjectIndex::default(),
    };
    let mut index = ProjectIndex::default();
    let mut scanned = 0usize;
    for path in files {
        if scanned >= MAX_FILES
            || index.labels.len() + index.citations.len() >= MAX_ENTRIES
        {
            index.truncated = true;
            break;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_tex = TEX_EXTS.contains(&ext.as_str());
        let is_bib = ext == "bib";
        if !is_tex && !is_bib {
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
        if is_tex {
            scan_tex(&content, &rel, &mut index);
        } else {
            scan_bib(&content, &rel, &mut index);
        }
    }
    index
}

/// Extract `\label{key}` definitions from a `.tex` file, tagging each with the
/// nearest preceding sectioning command as context. Skips commented-out lines
/// (a `%` before the `\label`, outside a `\%` escape).
fn scan_tex(content: &str, rel: &str, index: &mut ProjectIndex) {
    let mut section = String::new();
    for (idx, raw_line) in content.lines().enumerate() {
        if index.labels.len() + index.citations.len() >= MAX_ENTRIES {
            index.truncated = true;
            return;
        }
        let line = strip_comment(raw_line);
        if let Some(title) = section_title(line) {
            section = cap(title, MAX_CONTEXT_CHARS);
        }
        let mut rest = line;
        while let Some(pos) = rest.find("\\label{") {
            let after = &rest[pos + "\\label{".len()..];
            let Some(end) = after.find('}') else { break };
            let key = after[..end].trim();
            if !key.is_empty() {
                index.labels.push(IndexEntry {
                    key: key.to_string(),
                    file: rel.to_string(),
                    line: (idx + 1) as u32,
                    context: section.clone(),
                });
            }
            rest = &after[end + 1..];
        }
    }
}

/// Extract citation keys from a `.bib` file: `@type{key,` at an entry head.
/// The key is everything between `{` and the first `,` (or `}`), trimmed;
/// `@comment`/`@string`/`@preamble` are not citeable and are skipped.
fn scan_bib(content: &str, rel: &str, index: &mut ProjectIndex) {
    let mut title = String::new();
    let mut pending: Option<(String, u32)> = None;
    for (idx, raw_line) in content.lines().enumerate() {
        if index.labels.len() + index.citations.len() >= MAX_ENTRIES {
            index.truncated = true;
            break;
        }
        let line = raw_line.trim_start();
        if let Some(at) = line.strip_prefix('@') {
            // Flush the previous entry with whatever title we gathered.
            if let Some((key, line_no)) = pending.take() {
                index.citations.push(IndexEntry {
                    key,
                    file: rel.to_string(),
                    line: line_no,
                    context: std::mem::take(&mut title),
                });
            }
            let Some(brace) = at.find('{') else { continue };
            let ty = at[..brace].trim().to_ascii_lowercase();
            if matches!(ty.as_str(), "comment" | "string" | "preamble") {
                continue;
            }
            let after = &at[brace + 1..];
            let end = after.find(',').unwrap_or(after.len());
            let key = after[..end].trim().trim_end_matches('}').trim();
            if !key.is_empty() {
                pending = Some((key.to_string(), (idx + 1) as u32));
                // A single-line entry carries its title on this same line,
                // after the key — pick it up so compact `.bib` files still get
                // context hints.
                if let Some(t) = bib_field(&after[end..], "title") {
                    title = cap(&t, MAX_CONTEXT_CHARS);
                }
            }
        } else if pending.is_some()
            && title.is_empty()
            && let Some(t) = bib_field(line, "title")
        {
            title = cap(&t, MAX_CONTEXT_CHARS);
        }
    }
    if let Some((key, line_no)) = pending.take() {
        index.citations.push(IndexEntry {
            key,
            file: rel.to_string(),
            line: line_no,
            context: title,
        });
    }
}

/// Everything before an unescaped `%` (a real LaTeX comment). `\%` is a
/// literal percent and does not start a comment.
fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && (i == 0 || bytes[i - 1] != b'\\') {
            return &line[..i];
        }
        i += 1;
    }
    line
}

/// The title argument of a sectioning command on this line, if any.
fn section_title(line: &str) -> Option<&str> {
    const CMDS: &[&str] = &[
        "\\chapter", "\\section", "\\subsection", "\\subsubsection", "\\part",
        "\\paragraph", "\\subparagraph",
    ];
    for cmd in CMDS {
        if let Some(pos) = line.find(cmd) {
            let after = &line[pos + cmd.len()..];
            // Require a `{` or `*{` or `[..]{` right after so `\sectionmark`
            // and friends don't match.
            let brace = after.find('{')?;
            let between = &after[..brace];
            if between.chars().all(|c| c == '*' || c.is_whitespace() || c == '[' || c == ']')
                || between.starts_with('[')
                || between.is_empty()
                || between == "*"
            {
                let body = &after[brace + 1..];
                let end = body.find('}').unwrap_or(body.len());
                return Some(body[..end].trim());
            }
        }
    }
    None
}

/// Value of a `field = {...}`, `field = "..."`, or bare `field = value`
/// occurrence, honoring the value's own delimiter so a following field on the
/// same line isn't swallowed. Brace values track nesting depth.
fn bib_field(line: &str, field: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let fpos = lower.find(field)?;
    // The match must be a field name, not a substring of another word.
    if fpos > 0 && line.as_bytes()[fpos - 1].is_ascii_alphanumeric() {
        return None;
    }
    let after = &line[fpos + field.len()..];
    let eq = after.find('=')?;
    let val = after[eq + 1..].trim_start();
    let out = match val.chars().next() {
        Some('{') => {
            let mut depth = 0i32;
            let mut end = None;
            for (i, c) in val.char_indices() {
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            &val[1..end?]
        }
        Some('"') => {
            let rest = &val[1..];
            let end = rest.find('"')?;
            &rest[..end]
        }
        _ => val.split(',').next().unwrap_or("").trim(),
    };
    let out = out.trim();
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_tex_extracts_labels_with_section_context() {
        let tex = "\\section{Intro}\nSome text \\label{sec:intro} here.\n\
                   \\subsection{Details}\n\\label{sec:details}\n\
                   % \\label{sec:commented}\n";
        let mut idx = ProjectIndex::default();
        scan_tex(tex, "main.tex", &mut idx);
        assert_eq!(idx.labels.len(), 2);
        assert_eq!(idx.labels[0].key, "sec:intro");
        assert_eq!(idx.labels[0].context, "Intro");
        assert_eq!(idx.labels[0].line, 2);
        assert_eq!(idx.labels[1].key, "sec:details");
        assert_eq!(idx.labels[1].context, "Details");
        // The commented-out label is not indexed.
        assert!(!idx.labels.iter().any(|l| l.key == "sec:commented"));
    }

    #[test]
    fn scan_tex_handles_multiple_labels_per_line() {
        let tex = "\\label{a}\\label{b} \\label{c}\n";
        let mut idx = ProjectIndex::default();
        scan_tex(tex, "f.tex", &mut idx);
        let keys: Vec<_> = idx.labels.iter().map(|l| l.key.as_str()).collect();
        assert_eq!(keys, vec!["a", "b", "c"]);
    }

    #[test]
    fn scan_bib_extracts_keys_and_titles() {
        let bib = "@article{smith2020,\n  title = {A Great Paper},\n  year = {2020}\n}\n\
                   @book{jones2019, title=\"Another Work\", author={Jones}}\n\
                   @comment{not a key}\n\
                   @string{foo = \"bar\"}\n";
        let mut idx = ProjectIndex::default();
        scan_bib(bib, "refs.bib", &mut idx);
        let keys: Vec<_> = idx.citations.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, vec!["smith2020", "jones2019"]);
        assert_eq!(idx.citations[0].context, "A Great Paper");
        assert_eq!(idx.citations[0].line, 1);
        assert_eq!(idx.citations[1].context, "Another Work");
    }

    #[test]
    fn strip_comment_respects_escaped_percent() {
        assert_eq!(strip_comment("a \\% b % comment"), "a \\% b ");
        assert_eq!(strip_comment("no comment here"), "no comment here");
        assert_eq!(strip_comment("% whole line"), "");
    }

    #[test]
    fn section_title_ignores_sectionmark() {
        assert_eq!(section_title("\\section{Real}"), Some("Real"));
        assert_eq!(section_title("\\section*{Starred}"), Some("Starred"));
        assert_eq!(section_title("\\sectionmark{running}"), None);
    }
}
