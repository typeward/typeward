//! App-global grammar state: the user's personal dictionary and the set of
//! ignored lints, persisted under `<app_data>/grammar/`.
//!
//! State is *not* project-scoped — a personal dictionary word or an ignored
//! lint applies everywhere. Only plain, `Send + Sync` data lives here (a word
//! list plus Harper's `IgnoredLints`, which is a `HashSet<u64>`); the Harper
//! objects themselves are `!Send` (harper-core's default `Lrc = Rc`) and are
//! built fresh inside each `grammar_check`'s `spawn_blocking`, so nothing
//! non-`Send` ever crosses into Tauri's managed state.
//!
//! Persistence is lazy-loaded on first access and write-through on every
//! mutation via `fs_ops::atomic_write`.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use harper_core::IgnoredLints;
use tauri::{AppHandle, Manager};

use crate::fs_ops;

/// Cloneable (the state is behind an `Arc`) so the commands can move a handle
/// into `spawn_blocking` — the mutations fsync, which must not run on the main
/// thread. Every clone shares the one lock.
#[derive(Default, Clone)]
pub struct GrammarState {
    inner: Arc<RwLock<GrammarData>>,
}

#[derive(Default)]
struct GrammarData {
    loaded: bool,
    words: Vec<String>,
    ignored: IgnoredLints,
}

fn grammar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "could not resolve app data dir".to_string())?;
    Ok(dir.join("grammar"))
}

/// Populate `data` from disk once. A missing file leaves the default empty
/// state; a corrupt `ignored.json` is discarded rather than wedging grammar.
fn ensure_loaded(app: &AppHandle, data: &mut GrammarData) -> Result<(), String> {
    if data.loaded {
        return Ok(());
    }
    let dir = grammar_dir(app)?;

    if let Ok(text) = std::fs::read_to_string(dir.join("dictionary.txt")) {
        let mut words: Vec<String> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        words.sort();
        words.dedup();
        data.words = words;
    }

    if let Ok(bytes) = std::fs::read(dir.join("ignored.json"))
        && let Ok(ignored) = serde_json::from_slice::<IgnoredLints>(&bytes)
    {
        data.ignored = ignored;
    }

    data.loaded = true;
    Ok(())
}

fn write_words(app: &AppHandle, words: &[String]) -> Result<(), String> {
    let path = grammar_dir(app)?.join("dictionary.txt");
    fs_ops::atomic_write(&path, words.join("\n").as_bytes()).map_err(|e| e.to_string())
}

fn write_ignored(app: &AppHandle, ignored: &IgnoredLints) -> Result<(), String> {
    let path = grammar_dir(app)?.join("ignored.json");
    let bytes = serde_json::to_vec(ignored).map_err(|e| e.to_string())?;
    fs_ops::atomic_write(&path, &bytes).map_err(|e| e.to_string())
}

/// A personal-dictionary word must be a single non-empty token of at most 64
/// characters (Harper matches on whole tokens; whitespace/control chars would
/// never resolve against a token anyway and are the obvious injection vector
/// into the newline-delimited `dictionary.txt`).
fn validate_word(raw: &str) -> Result<String, String> {
    let word = raw.trim();
    if word.is_empty() {
        return Err("word cannot be empty".to_string());
    }
    if word.chars().count() > 64 {
        return Err("word too long (max 64 characters)".to_string());
    }
    if word.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("word must be a single token with no whitespace".to_string());
    }
    Ok(word.to_string())
}

impl GrammarState {
    fn write(&self) -> Result<std::sync::RwLockWriteGuard<'_, GrammarData>, String> {
        self.inner
            .write()
            .map_err(|_| "grammar state lock poisoned".to_string())
    }

    /// Snapshot the plain state needed for a lint pass. Cloned out so the lock
    /// is never held across the `spawn_blocking` that does the actual linting.
    pub fn snapshot(&self, app: &AppHandle) -> Result<(Vec<String>, IgnoredLints), String> {
        let mut data = self.write()?;
        ensure_loaded(app, &mut data)?;
        Ok((data.words.clone(), data.ignored.clone()))
    }

    pub fn list_words(&self, app: &AppHandle) -> Result<Vec<String>, String> {
        let mut data = self.write()?;
        ensure_loaded(app, &mut data)?;
        Ok(data.words.clone())
    }

    pub fn add_word(&self, app: &AppHandle, word: String) -> Result<(), String> {
        let word = validate_word(&word)?;
        let mut data = self.write()?;
        ensure_loaded(app, &mut data)?;
        if !data.words.iter().any(|w| w == &word) {
            data.words.push(word);
            data.words.sort();
            write_words(app, &data.words)?;
        }
        Ok(())
    }

    pub fn remove_word(&self, app: &AppHandle, word: String) -> Result<(), String> {
        let mut data = self.write()?;
        ensure_loaded(app, &mut data)?;
        let before = data.words.len();
        data.words.retain(|w| w != &word);
        if data.words.len() != before {
            write_words(app, &data.words)?;
        }
        Ok(())
    }

    pub fn ignore_hash(&self, app: &AppHandle, hash: u64) -> Result<(), String> {
        let mut data = self.write()?;
        ensure_loaded(app, &mut data)?;
        data.ignored.ignore_hash(hash);
        write_ignored(app, &data.ignored)?;
        Ok(())
    }

    pub fn clear_ignored(&self, app: &AppHandle) -> Result<(), String> {
        let mut data = self.write()?;
        data.ignored = IgnoredLints::new();
        data.loaded = true;
        write_ignored(app, &data.ignored)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_word;

    #[test]
    fn validate_word_accepts_hyphen_and_apostrophe() {
        assert_eq!(validate_word("  well-known  ").unwrap(), "well-known");
        assert_eq!(validate_word("O'Brien").unwrap(), "O'Brien");
    }

    #[test]
    fn validate_word_rejects_empty_multiword_and_overlong() {
        assert!(validate_word("   ").is_err());
        assert!(validate_word("two words").is_err());
        assert!(validate_word(&"x".repeat(65)).is_err());
        assert!(validate_word("bad\nword").is_err());
    }
}
