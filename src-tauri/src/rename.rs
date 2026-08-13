//! Cross-file `\label` rename and find-references.
//!
//! A label is defined by `\label{key}` and referenced by the `\ref` family
//! (`\ref`, `\eqref`, `\cref`, `\pageref`, ...). Renaming one by hand across a
//! book-length project is error-prone; this walks every source file and
//! rewrites the key inside those commands ONLY — never as a substring, never in
//! prose, never in an unrelated command — so the operation is safe to run over
//! the whole project. The pure rewrite (`rename_key_in_content`) is
//! exhaustively unit-tested because it edits the user's source.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::project;

/// Matches a label-defining / label-referencing command and its brace argument
/// in three groups: (1) `\cmd*[opt]{` up to and including the opening brace,
/// (2) the argument text (a comma-separated key list, no nested braces),
/// (3) the closing `}`. Longer command names precede their prefixes
/// (`crefrange` before `cref`, `labelcref` before `label`) so the alternation
/// binds the whole name.
/// Single-argument label commands: `\cmd*[opt]{arg}` in three groups
/// (opening through `{`, the arg, the closing `}`). Excludes the two-argument
/// range commands, handled by [`range_re`].
fn single_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(\\(?:labelcref|namecref|cpageref|Cpageref|vpageref|autoref|nameref|pageref|eqref|label|cref|Cref|vref|Vref|ref)\*?(?:\[[^\]]*\])?\{)([^{}]*)(\})",
        )
        .expect("single label command regex")
    })
}

/// Two-argument range commands `\crefrange{start}{end}` (and `\Crefrange`) —
/// both brace groups are label keys. Group 1 is the command, groups 2 and 3 are
/// the two `{...}` args.
fn range_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(\\(?:crefrange|Crefrange)\*?(?:\[[^\]]*\])?)(\{[^{}]*\})(\{[^{}]*\})",
        )
        .expect("range label command regex")
    })
}

/// Whether the captured opening is the label DEFINITION command `\label`
/// (not `\labelcref`, which references one).
fn is_label_def(open: &str) -> bool {
    open.strip_prefix("\\label").is_some_and(|rest| {
        rest.starts_with('{') || rest.starts_with('*') || rest.starts_with('[')
    })
}

/// The single key `key` occupies its own comma segment in `arg`.
fn arg_contains_key(arg: &str, key: &str) -> bool {
    arg.split(',').any(|seg| seg.trim() == key)
}

/// Rewrite an argument's comma segments, replacing those exactly equal to `old`
/// with `new` while preserving each segment's surrounding whitespace. Bumps
/// `count` per replaced segment.
fn rewrite_arg(arg: &str, old: &str, new: &str, count: &mut usize) -> String {
    arg.split(',')
        .map(|seg| {
            if seg.trim() == old {
                *count += 1;
                let lead = &seg[..seg.len() - seg.trim_start().len()];
                let trail = &seg[seg.trim_end().len()..];
                format!("{lead}{new}{trail}")
            } else {
                seg.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Rewrite a whole `{arg}` brace group, replacing exact-match segments.
fn rewrite_brace(brace: &str, old: &str, new: &str, count: &mut usize) -> String {
    let inner = &brace[1..brace.len() - 1];
    format!("{{{}}}", rewrite_arg(inner, old, new, count))
}

/// Replace `old` with `new` inside every `\label`/`\ref`-family argument in
/// `content`. Returns the rewritten content and the number of segments changed.
pub fn rename_key_in_content(content: &str, old: &str, new: &str) -> (String, usize) {
    let mut count = 0usize;
    let step1 = single_re()
        .replace_all(content, |caps: &regex::Captures| {
            format!(
                "{}{}{}",
                &caps[1],
                rewrite_arg(&caps[2], old, new, &mut count),
                &caps[3]
            )
        })
        .into_owned();
    let step2 = range_re()
        .replace_all(&step1, |caps: &regex::Captures| {
            format!(
                "{}{}{}",
                &caps[1],
                rewrite_brace(&caps[2], old, new, &mut count),
                rewrite_brace(&caps[3], old, new, &mut count)
            )
        })
        .into_owned();
    (step2, count)
}

/// A single occurrence of a key, for find-references.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub file: String,
    pub line: u32,
    /// "label" (the definition) or "ref" (a use).
    pub kind: String,
    /// The trimmed source line, capped, for the results list.
    pub context: String,
}

const MAX_CONTEXT: usize = 160;

fn line_and_context(content: &str, byte_offset: usize) -> (u32, String) {
    let start = content[..byte_offset].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end = content[byte_offset..]
        .find('\n')
        .map(|i| byte_offset + i)
        .unwrap_or(content.len());
    let line = content[..byte_offset].bytes().filter(|&b| b == b'\n').count() as u32 + 1;
    let mut ctx: String = content[start..end].trim().chars().take(MAX_CONTEXT).collect();
    if ctx.len() > MAX_CONTEXT {
        ctx.truncate(MAX_CONTEXT);
    }
    (line, ctx)
}

/// Every occurrence of `key` in a `\label`/`\ref`-family command in `content`.
pub fn find_uses_in_content(content: &str, key: &str, rel: &str, out: &mut Vec<Reference>) {
    for caps in single_re().captures_iter(content) {
        if !arg_contains_key(&caps[2], key) {
            continue;
        }
        let whole = caps.get(0).unwrap();
        let (line, context) = line_and_context(content, whole.start());
        out.push(Reference {
            file: rel.to_string(),
            line,
            kind: if is_label_def(&caps[1]) { "label" } else { "ref" }.to_string(),
            context,
        });
    }
    for caps in range_re().captures_iter(content) {
        let a = &caps[2];
        let b = &caps[3];
        if !arg_contains_key(&a[1..a.len() - 1], key)
            && !arg_contains_key(&b[1..b.len() - 1], key)
        {
            continue;
        }
        let whole = caps.get(0).unwrap();
        let (line, context) = line_and_context(content, whole.start());
        out.push(Reference {
            file: rel.to_string(),
            line,
            kind: "ref".to_string(),
            context,
        });
    }
}

/// A valid label key for rename: non-empty and free of the bytes that would
/// break out of the brace argument or split the comma list (or inject TeX).
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && !key.bytes().any(|b| {
            matches!(b, b'{' | b'}' | b',' | b'\\' | b'%' | b'#' | b'~' | b'^' | b'$' | b'&')
                || b.is_ascii_whitespace()
        })
}

const MAX_FILES: usize = 2000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const TEX_EXTS: &[&str] = &["tex", "ltx", "cls", "sty", "def", "clo"];

fn is_tex(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| TEX_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    /// Project-relative paths of the files that were rewritten.
    pub files_changed: Vec<String>,
    pub total_occurrences: usize,
}

/// Rename a `\label` and every reference to it across the project's `.tex`
/// files. Read-then-write per file; only files that actually change are
/// rewritten (atomically). The caller saves dirty buffers first and reloads the
/// affected open files afterward.
#[tauri::command]
pub async fn rename_project_label(
    project_root: String,
    old_key: String,
    new_key: String,
) -> Result<RenameResult, String> {
    tokio::task::spawn_blocking(move || -> Result<RenameResult, String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        if !valid_key(&old_key) || !valid_key(&new_key) {
            return Err("invalid label key".into());
        }
        if old_key == new_key {
            return Ok(RenameResult { files_changed: vec![], total_occurrences: 0 });
        }
        let files = crate::integrations::templates::collect_project_files(root)
            .map_err(|e| e.to_string())?;
        let mut changed = Vec::new();
        let mut total = 0usize;
        for (n, path) in files.into_iter().enumerate() {
            if n >= MAX_FILES {
                break;
            }
            if !is_tex(&path) {
                continue;
            }
            match std::fs::metadata(&path) {
                Ok(m) if m.len() <= MAX_FILE_BYTES => {}
                _ => continue,
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (rewritten, count) = rename_key_in_content(&content, &old_key, &new_key);
            if count == 0 {
                continue;
            }
            crate::fs_ops::atomic_write(&path, rewritten.as_bytes())
                .map_err(|e| e.to_string())?;
            if let Ok(rel) = path.strip_prefix(root) {
                changed.push(rel.to_string_lossy().replace('\\', "/"));
            }
            total += count;
        }
        Ok(RenameResult { files_changed: changed, total_occurrences: total })
    })
    .await
    .map_err(|e| e.to_string())?
}

const MAX_REFERENCES: usize = 5000;

/// Every occurrence of `key` (as a label definition or reference) across the
/// project. Read-only — powers a find-references list and the pre-rename count.
#[tauri::command]
pub async fn find_project_references(
    project_root: String,
    key: String,
) -> Result<Vec<Reference>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<Reference>, String> {
        let root = Path::new(&project_root);
        project::require_registered_root(root).map_err(|e| e.to_string())?;
        let files = crate::integrations::templates::collect_project_files(root)
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (n, path) in files.into_iter().enumerate() {
            if n >= MAX_FILES || out.len() >= MAX_REFERENCES {
                break;
            }
            if !is_tex(&path) {
                continue;
            }
            match std::fs::metadata(&path) {
                Ok(m) if m.len() <= MAX_FILE_BYTES => {}
                _ => continue,
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let rel = match path.strip_prefix(root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            find_uses_in_content(&content, &key, &rel, &mut out);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rn(content: &str, old: &str, new: &str) -> (String, usize) {
        rename_key_in_content(content, old, new)
    }

    #[test]
    fn renames_label_definition_and_ref() {
        let (out, n) = rn("\\label{fig:a}\nSee \\ref{fig:a}.", "fig:a", "fig:b");
        assert_eq!(out, "\\label{fig:b}\nSee \\ref{fig:b}.");
        assert_eq!(n, 2);
    }

    #[test]
    fn renames_across_ref_families() {
        let (out, n) = rn(
            "\\eqref{e}\\cref{e}\\Cref{e}\\pageref{e}\\autoref{e}\\crefrange{e}{e}",
            "e",
            "E",
        );
        assert_eq!(
            out,
            "\\eqref{E}\\cref{E}\\Cref{E}\\pageref{E}\\autoref{E}\\crefrange{E}{E}"
        );
        // 5 single-arg commands + 2 keys in \crefrange{E}{E}.
        assert_eq!(n, 7);
    }

    #[test]
    fn replaces_only_the_matching_segment_in_a_list() {
        let (out, n) = rn("\\cref{a, old, b}", "old", "new");
        assert_eq!(out, "\\cref{a, new, b}");
        assert_eq!(n, 1);
    }

    #[test]
    fn never_touches_a_substring_or_prose() {
        // `old` is a substring of `oldish` and appears in prose — neither changes.
        let (out, n) = rn("\\ref{oldish} the word old \\ref{old}", "old", "X");
        assert_eq!(out, "\\ref{oldish} the word old \\ref{X}");
        assert_eq!(n, 1);
    }

    #[test]
    fn does_not_touch_cite_or_unrelated_commands() {
        let (out, n) = rn("\\cite{k}\\href{k}{t}\\section{k}", "k", "Z");
        assert_eq!(out, "\\cite{k}\\href{k}{t}\\section{k}");
        assert_eq!(n, 0);
    }

    #[test]
    fn labelcref_and_crefrange_bind_the_whole_name() {
        let (out, n) = rn("\\labelcref{k} \\crefrange{k}{k}", "k", "Q");
        assert_eq!(out, "\\labelcref{Q} \\crefrange{Q}{Q}");
        assert_eq!(n, 3);
    }

    #[test]
    fn find_uses_reports_line_and_kind() {
        let mut out = Vec::new();
        find_uses_in_content("x\n\\label{k}\n\\ref{k}", "k", "a.tex", &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].line, 2);
        assert_eq!(out[0].kind, "label");
        assert_eq!(out[1].line, 3);
        assert_eq!(out[1].kind, "ref");
    }

    #[test]
    fn rejects_invalid_keys() {
        assert!(!valid_key(""));
        assert!(!valid_key("a b"));
        assert!(!valid_key("a,b"));
        assert!(!valid_key("a}b"));
        assert!(!valid_key("a\\b"));
        assert!(valid_key("fig:sub-1_a.2"));
    }
}
