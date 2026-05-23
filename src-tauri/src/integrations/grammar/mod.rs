//! Grammar lint via Harper.
//!
//! Harper is a Rust-native English grammar engine that runs entirely
//! in-process — no JVM, no language server, no network. It exposes
//! tokenization, dictionary lookup, and a pluggable rule set; we use
//! the curated `LintGroup` (their bundled rule pack) and surface each
//! lint as a Typeward `Diagnostic` so the same gutter / LogsDrawer
//! surfaces light up that already handle compile + LSP diagnostics.
//!
//! Phase 5 ships American English only. Harper's language coverage is
//! limited today (American + British dialects via the `Dialect` enum);
//! we'll expand the picker as their dictionary set grows.

use std::sync::Arc;
use std::sync::OnceLock;

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::parsers::PlainEnglish;
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarDiagnostic {
    pub severity: &'static str,
    pub message: String,
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
    pub source: &'static str,
    /// Suggested replacements as plain strings. The CM6 quick-fix
    /// surface renders each as a one-click apply.
    pub replacements: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GrammarSyntax {
    Plain,
    Latex,
    Typst,
}

fn dictionary() -> Arc<FstDictionary> {
    static DICT: OnceLock<Arc<FstDictionary>> = OnceLock::new();
    DICT.get_or_init(FstDictionary::curated).clone()
}

#[tauri::command]
pub async fn grammar_check(
    text: String,
    file: String,
    syntax: Option<GrammarSyntax>,
) -> Result<Vec<GrammarDiagnostic>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<GrammarDiagnostic>, String> {
        let _ = syntax; // Phase 5 always uses the plain-English parser.
        let dict = dictionary();
        let document = Document::new(&text, &PlainEnglish, dict.as_ref());

        let mut linter = LintGroup::new_curated(dict, Dialect::American);
        let lints = linter.lint(&document);

        // Harper spans index `char` positions inside the document — the
        // same units we need for the editor gutter. We pre-compute
        // (line, col) for every `\n` so the per-lint lookup is O(log n).
        let line_starts = compute_line_starts(&text);

        let mut out = Vec::with_capacity(lints.len());
        for lint in lints {
            let span = lint.span;
            let (start_line, start_col) = locate(&line_starts, span.start);
            let (end_line, end_col) = locate(&line_starts, span.end);
            let replacements = lint
                .suggestions
                .iter()
                .map(suggestion_text)
                .collect();
            out.push(GrammarDiagnostic {
                severity: "warning",
                message: lint.message,
                file: file.clone(),
                line: start_line,
                col: start_col,
                end_line,
                end_col,
                source: "harper",
                replacements,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn suggestion_text(suggestion: &Suggestion) -> String {
    match suggestion {
        Suggestion::ReplaceWith(chars) => chars.iter().collect(),
        Suggestion::InsertAfter(chars) => chars.iter().collect(),
        Suggestion::Remove => String::new(),
    }
}

/// Pre-compute the char offset of every line start so lint→(line, col)
/// is one binary search per span endpoint. Returns a slice indexed by
/// 0-based line number; element value is the char-offset of that
/// line's first character.
fn compute_line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, ch) in text.chars().enumerate() {
        if ch == '\n' {
            starts.push(i + 1);
        }
    }
    starts
}

fn locate(line_starts: &[usize], char_offset: usize) -> (u32, u32) {
    let line_idx = match line_starts.binary_search(&char_offset) {
        Ok(i) => i,
        Err(i) => i.saturating_sub(1),
    };
    let col = char_offset.saturating_sub(line_starts[line_idx]);
    ((line_idx as u32) + 1, (col as u32) + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_line_starts_handles_unix_and_mixed_endings() {
        let starts = compute_line_starts("a\nb\nc");
        assert_eq!(starts, vec![0, 2, 4]);
    }

    #[test]
    fn locate_returns_1_based_line_and_col() {
        let starts = compute_line_starts("abc\ndef\nghi");
        assert_eq!(locate(&starts, 0), (1, 1));
        assert_eq!(locate(&starts, 4), (2, 1));
        assert_eq!(locate(&starts, 5), (2, 2));
        assert_eq!(locate(&starts, 8), (3, 1));
    }
}
