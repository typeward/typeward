//! Grammar lint via Harper (2.x).
//!
//! Harper is a Rust-native English grammar engine that runs entirely
//! in-process — no JVM, no language server, no network. We route the source
//! through a format-aware parser (plain / Markdown / `harper-tex` /
//! `harper-typst`) so LaTeX commands and Typst code are masked out instead of
//! being flagged as prose, then surface each lint as a Typeward diagnostic in
//! the same shape as compile / LSP diagnostics so the existing gutter and Logs
//! surfaces light up unchanged.
//!
//! App-global personal-dictionary words and ignored lints live in
//! [`GrammarState`] (see `config.rs`) and are folded into every lint pass: the
//! dictionary as a `MergedDictionary` layer, the ignored set via
//! `IgnoredLints::remove_ignored`. Harper's own objects are `!Send`, so the
//! whole lint pass runs inside `spawn_blocking` and only plain data crosses the
//! managed-state boundary.

mod config;

pub use config::GrammarState;

use std::sync::Arc;

use harper_core::linting::{LintGroup, LintKind, Linter, Suggestion};
use harper_core::parsers::{Markdown, MarkdownOptions, PlainEnglish};
use harper_core::spell::{FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{Dialect, DictWordMetadata, Document, IgnoredLints, LintContext};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

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
    /// Suggested replacements as plain strings. The CM6 quick-fix surface
    /// renders each as a one-click apply.
    pub replacements: Vec<String>,
    /// Harper `LintKind` key (e.g. `Spelling`, `WordChoice`) — drives per-kind
    /// underline styling and the "Add to dictionary" gate on the frontend.
    pub kind: String,
    /// Stable, position-agnostic hash of this lint's context, as a decimal
    /// string. Passed back to `grammar_ignore_lint` to suppress this exact
    /// lint everywhere it recurs.
    pub context_hash: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GrammarSyntax {
    Plain,
    Markdown,
    Latex,
    Typst,
}

/// Warning-grade kinds are outright correctness issues (drives the Logs
/// warning count); everything else — style, readability, redundancy — is
/// advisory and surfaces as info.
fn severity_for(kind: LintKind) -> &'static str {
    match kind {
        LintKind::Spelling
        | LintKind::Typo
        | LintKind::Grammar
        | LintKind::Agreement
        | LintKind::BoundaryError
        | LintKind::Malapropism
        | LintKind::Eggcorn
        | LintKind::Capitalization
        | LintKind::Punctuation => "warning",
        _ => "info",
    }
}

fn parse_dialect(raw: Option<&str>) -> Dialect {
    raw.and_then(Dialect::try_from_bcp47)
        .unwrap_or(Dialect::American)
}

fn build_document(text: &str, syntax: GrammarSyntax, dict: &MergedDictionary) -> Document {
    match syntax {
        GrammarSyntax::Plain => Document::new(text, &PlainEnglish, dict),
        GrammarSyntax::Markdown => {
            Document::new(text, &Markdown::new(MarkdownOptions::default()), dict)
        }
        GrammarSyntax::Latex => Document::new(text, &harper_tex::TeX::default(), dict),
        GrammarSyntax::Typst => Document::new(text, &harper_typst::Typst, dict),
    }
}

fn build_dictionary(words: &[String]) -> Arc<MergedDictionary> {
    let mut merged = MergedDictionary::new();
    merged.add_dictionary(FstDictionary::curated());
    if !words.is_empty() {
        let mut mutable = MutableDictionary::new();
        for word in words {
            mutable.append_word_str(word, DictWordMetadata::default());
        }
        merged.add_dictionary(Arc::new(mutable));
    }
    Arc::new(merged)
}

/// The whole Harper pass, isolated so it stays inside one thread (Harper's
/// `Rc`-based types never leave it) and is directly unit-testable.
fn run_check(
    text: &str,
    file: &str,
    syntax: GrammarSyntax,
    dialect: Dialect,
    words: &[String],
    ignored: &IgnoredLints,
) -> Vec<GrammarDiagnostic> {
    let dict = build_dictionary(words);
    let document = build_document(text, syntax, dict.as_ref());

    let mut linter = LintGroup::new_curated(dict.clone(), dialect);
    let mut lints = linter.lint(&document);
    ignored.remove_ignored(&mut lints, &document);

    // Harper spans index `char` positions; pre-compute line starts so each
    // per-lint (line, col) lookup is a single binary search.
    let line_starts = compute_line_starts(text);

    lints
        .iter()
        .map(|lint| {
            let (start_line, start_col) = locate(&line_starts, lint.span.start);
            let (end_line, end_col) = locate(&line_starts, lint.span.end);
            GrammarDiagnostic {
                severity: severity_for(lint.lint_kind),
                message: lint.message.clone(),
                file: file.to_string(),
                line: start_line,
                col: start_col,
                end_line,
                end_col,
                source: "harper",
                replacements: lint.suggestions.iter().map(suggestion_text).collect(),
                kind: lint.lint_kind.to_string_key(),
                context_hash: LintContext::from_lint(lint, &document)
                    .default_hash()
                    .to_string(),
            }
        })
        .collect()
}

#[tauri::command]
pub async fn grammar_check(
    app: AppHandle,
    state: State<'_, GrammarState>,
    text: String,
    file: String,
    syntax: Option<GrammarSyntax>,
    dialect: Option<String>,
) -> Result<Vec<GrammarDiagnostic>, String> {
    let (words, ignored) = state.snapshot(&app)?;
    let syntax = syntax.unwrap_or(GrammarSyntax::Plain);
    let dialect = parse_dialect(dialect.as_deref());

    tokio::task::spawn_blocking(move || run_check(&text, &file, syntax, dialect, &words, &ignored))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn grammar_add_word(
    app: AppHandle,
    state: State<'_, GrammarState>,
    word: String,
) -> Result<(), String> {
    state.add_word(&app, word)
}

#[tauri::command]
pub fn grammar_remove_word(
    app: AppHandle,
    state: State<'_, GrammarState>,
    word: String,
) -> Result<(), String> {
    state.remove_word(&app, word)
}

#[tauri::command]
pub fn grammar_list_words(
    app: AppHandle,
    state: State<'_, GrammarState>,
) -> Result<Vec<String>, String> {
    state.list_words(&app)
}

#[tauri::command]
pub fn grammar_ignore_lint(
    app: AppHandle,
    state: State<'_, GrammarState>,
    context_hash: String,
) -> Result<(), String> {
    let hash: u64 = context_hash
        .parse()
        .map_err(|_| "invalid context hash".to_string())?;
    state.ignore_hash(&app, hash)
}

#[tauri::command]
pub fn grammar_clear_ignored(
    app: AppHandle,
    state: State<'_, GrammarState>,
) -> Result<(), String> {
    state.clear_ignored(&app)
}

fn suggestion_text(suggestion: &Suggestion) -> String {
    match suggestion {
        Suggestion::ReplaceWith(chars) => chars.iter().collect(),
        Suggestion::InsertAfter(chars) => chars.iter().collect(),
        Suggestion::Remove => String::new(),
    }
}

/// Pre-compute the char offset of every line start so lint→(line, col) is one
/// binary search per span endpoint. Element `i` is the char-offset of line
/// `i`'s first character (0-based index).
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

    fn run(text: &str, syntax: GrammarSyntax, words: &[String]) -> Vec<GrammarDiagnostic> {
        run_check(
            text,
            "test.txt",
            syntax,
            Dialect::American,
            words,
            &IgnoredLints::new(),
        )
    }

    #[test]
    fn compute_line_starts_handles_unix_and_mixed_endings() {
        assert_eq!(compute_line_starts("a\nb\nc"), vec![0, 2, 4]);
    }

    #[test]
    fn locate_returns_1_based_line_and_col() {
        let starts = compute_line_starts("abc\ndef\nghi");
        assert_eq!(locate(&starts, 0), (1, 1));
        assert_eq!(locate(&starts, 4), (2, 1));
        assert_eq!(locate(&starts, 5), (2, 2));
        assert_eq!(locate(&starts, 8), (3, 1));
    }

    #[test]
    fn dialect_parses_bcp47_tags() {
        assert!(matches!(parse_dialect(Some("en-GB")), Dialect::British));
        assert!(matches!(parse_dialect(Some("en-IN")), Dialect::Indian));
        assert!(matches!(parse_dialect(Some("garbage")), Dialect::American));
        assert!(matches!(parse_dialect(None), Dialect::American));
    }

    #[test]
    fn plain_flags_a_misspelling() {
        let diags = run("I have a flarnquix here.", GrammarSyntax::Plain, &[]);
        assert!(
            diags.iter().any(|d| d.kind == "Spelling"),
            "expected a spelling lint on the nonsense word, got {diags:?}"
        );
    }

    #[test]
    fn latex_does_not_lint_pure_commands() {
        // A run of masked LaTeX commands has no prose, so nothing to flag.
        let diags = run(
            "\\documentclass{article}\\usepackage{amsmath}\\alpha\\beta",
            GrammarSyntax::Latex,
            &[],
        );
        assert!(
            diags.is_empty(),
            "LaTeX command names should be masked, not linted: {diags:?}"
        );
    }

    #[test]
    fn latex_math_is_not_flagged_as_prose() {
        // Inline math is masked; a nonsense identifier in math must not spell-check.
        let diags = run("The value $\\flarnquix$ holds.", GrammarSyntax::Latex, &[]);
        assert!(
            !diags.iter().any(|d| d.kind == "Spelling"),
            "math content should not spell-check: {diags:?}"
        );
    }

    #[test]
    fn typst_code_is_skipped() {
        // Pure Typst code (a `#let` binding) carries no prose to lint.
        let diags = run("#let flarnquix = 1", GrammarSyntax::Typst, &[]);
        assert!(
            diags.is_empty(),
            "Typst code should be skipped, not linted: {diags:?}"
        );
    }

    #[test]
    fn personal_dictionary_word_suppresses_its_spelling_lint() {
        let text = "The flarnquix appeared.";
        let without = run(text, GrammarSyntax::Plain, &[]);
        assert!(
            without.iter().any(|d| d.kind == "Spelling"),
            "baseline should flag the nonsense word: {without:?}"
        );
        let with = run(text, GrammarSyntax::Plain, &["flarnquix".to_string()]);
        assert!(
            !with.iter().any(|d| d.kind == "Spelling"),
            "dictionary word should not be flagged: {with:?}"
        );
    }

    /// True if any lint touches a masked-argument key (would be a false positive).
    fn flags_key(diags: &[GrammarDiagnostic], needle: &str) -> bool {
        diags
            .iter()
            .any(|d| d.kind == "Spelling" && d.message.contains(needle))
    }

    #[test]
    fn latex_cite_ref_label_keys_are_not_flagged() {
        // Citation / cross-reference keys are identifiers, not prose.
        let text =
            "We build on \\cite{smith_2020} and revisit \\ref{fig:overview} near \\label{sec:intro}.";
        let diags = run(text, GrammarSyntax::Latex, &[]);
        assert!(
            !diags.iter().any(|d| d.kind == "Spelling"),
            "cite/ref/label keys should be masked, got {diags:?}"
        );
    }

    #[test]
    fn latex_url_and_href_mask_the_url_argument() {
        // The URL argument (with underscores/dots) must not spell-check; \href's
        // display text is ordinary prose and may lint, but the URL must not.
        let text = "See \\url{https://foo_bar.example.com/baz_qux} and \\href{https://zap_zop.io}{the site}.";
        let diags = run(text, GrammarSyntax::Latex, &[]);
        assert!(
            !flags_key(&diags, "foo_bar")
                && !flags_key(&diags, "baz_qux")
                && !flags_key(&diags, "zap_zop"),
            "URL arguments should be masked, got {diags:?}"
        );
    }

    #[test]
    fn latex_includegraphics_path_is_not_flagged() {
        let text = "Here is the plot:\n\\includegraphics{figures/my_figure_path}\n";
        let diags = run(text, GrammarSyntax::Latex, &[]);
        assert!(
            !flags_key(&diags, "my_figure_path") && !flags_key(&diags, "figures"),
            "includegraphics path should be masked, got {diags:?}"
        );
    }

    #[test]
    fn typst_cite_and_raw_blocks_are_masked() {
        // #cite(<key>) label + raw/code content should carry no prose lints.
        let text = "Per @smith_2020 and #cite(<jones_2019>).\n```\nmisspeld_kode_here\n```\n";
        let diags = run(text, GrammarSyntax::Typst, &[]);
        assert!(
            !flags_key(&diags, "smith_2020")
                && !flags_key(&diags, "jones_2019")
                && !flags_key(&diags, "misspeld_kode_here"),
            "Typst cite keys and raw blocks should be masked, got {diags:?}"
        );
    }

    #[test]
    fn markdown_fenced_code_is_not_linted() {
        let text = "A sentence.\n\n```rust\nlet misspeld_var = teh_value;\n```\n";
        let diags = run(text, GrammarSyntax::Markdown, &[]);
        assert!(
            !flags_key(&diags, "misspeld_var") && !flags_key(&diags, "teh_value"),
            "Markdown fenced code should be masked, got {diags:?}"
        );
    }

    #[test]
    fn ignore_round_trip_suppresses_the_lint() {
        let text = "I have a flarnquix here.";
        let baseline = run_check(
            text,
            "t.txt",
            GrammarSyntax::Plain,
            Dialect::American,
            &[],
            &IgnoredLints::new(),
        );
        let target = baseline
            .iter()
            .find(|d| d.kind == "Spelling")
            .expect("a spelling lint to ignore");
        let hash: u64 = target.context_hash.parse().expect("decimal context hash");

        let mut ignored = IgnoredLints::new();
        ignored.ignore_hash(hash);

        let after = run_check(
            text,
            "t.txt",
            GrammarSyntax::Plain,
            Dialect::American,
            &[],
            &ignored,
        );
        assert!(
            !after.iter().any(|d| d.context_hash == target.context_hash),
            "ignored lint should no longer appear: {after:?}"
        );
    }
}
