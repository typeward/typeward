//! OS keyring wrapper. Stores OAuth tokens, API keys, and any other secret
//! that must not land in `settings.json`.
//!
//! Service name convention: `typeward.<provider>` (e.g. `typeward.zotero`,
//! `typeward.supabase.session`). Account identifies the user/key slot within
//! the provider (e.g. email, library ID, "default").
//!
//! The keyring crate's blocking API is fine to call from async handlers via
//! `tokio::task::spawn_blocking`, which is what the IPC commands do — the
//! Linux Secret Service backend can stall on D-Bus operations.

use keyring::Entry;
use thiserror::Error;

const SERVICE_PREFIX: &str = "typeward";

// The Supabase session bundle is written by the frontend chunked-credential
// helper (auth/chunked.ts): values over ~1024 chars split across
// `<account>.part<i>` slots with a marker in the main slot. supabase-js needs
// the session value in the webview, so it is read back through the dedicated
// `supabase_session_read` command rather than the generic, allowlist-gated
// `credential_get` (which stays locked to non-session services).
const SESSION_SERVICE: &str = "supabase.session";
const CHUNK_MARKER: &str = "__typeward_chunks__:";

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("invalid service name (empty or contains '/'): {0}")]
    InvalidService(String),
    #[error("invalid account name (empty or contains '/'): {0}")]
    InvalidAccount(String),
    #[error("secret is empty")]
    EmptySecret,
    #[error("frontend reads are not allowed for service: {0}")]
    ReadForbidden(String),
    /// Only constructed on targets with no keyring backend (see
    /// `ensure_secure_storage`), so it is dead code on the supported ones.
    #[allow(dead_code)]
    #[error("secure storage is not available on this platform — secrets cannot be stored or read")]
    SecureStorageUnavailable,
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("background task failed: {0}")]
    Join(String),
}

impl From<keyring::Error> for CredentialError {
    fn from(value: keyring::Error) -> Self {
        Self::Keyring(value.to_string())
    }
}

fn validate(service: &str, account: &str) -> Result<String, CredentialError> {
    let service = service.trim();
    let account = account.trim();
    if service.is_empty() || service.contains('/') {
        return Err(CredentialError::InvalidService(service.to_string()));
    }
    if account.is_empty() || account.contains('/') {
        return Err(CredentialError::InvalidAccount(account.to_string()));
    }
    Ok(format!("{SERVICE_PREFIX}.{service}"))
}

/// `keyring` 3.x selects its backend by target: Apple (macOS/iOS), Windows
/// Credential Manager, or Secret Service (Linux/BSD). Every other target —
/// Android today — falls through to the crate's `mock` store, which is
/// per-`Entry` and in-memory: `set_secret` would report success, and the next
/// IPC call's fresh `Entry` would read back `None`. A silent write-to-nowhere
/// for OAuth tokens and API keys is worse than no support, so a target with no
/// real keystore is a hard, explicit failure at the boundary. Shipping Android
/// means implementing a Keystore-backed store here first.
#[cfg(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd"
))]
fn ensure_secure_storage() -> Result<(), CredentialError> {
    Ok(())
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd"
)))]
fn ensure_secure_storage() -> Result<(), CredentialError> {
    Err(CredentialError::SecureStorageUnavailable)
}

fn entry(service: &str, account: &str) -> Result<Entry, CredentialError> {
    let scoped = validate(service, account)?;
    ensure_secure_storage()?;
    Ok(Entry::new(&scoped, account)?)
}

/// Persist a secret. Overwrites any existing value at the same slot.
pub fn set_secret(service: &str, account: &str, secret: &str) -> Result<(), CredentialError> {
    if secret.is_empty() {
        return Err(CredentialError::EmptySecret);
    }
    let entry = entry(service, account)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Read a secret. Returns `Ok(None)` when no entry exists; reserves `Err`
/// for backend failures so callers can distinguish "never set" from
/// "keyring is broken".
pub fn get_secret(service: &str, account: &str) -> Result<Option<String>, CredentialError> {
    let entry = entry(service, account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.into()),
    }
}

pub fn secret_exists(service: &str, account: &str) -> Result<bool, CredentialError> {
    Ok(get_secret(service, account)?.is_some())
}

/// Remove a secret. `Ok(())` when the entry didn't exist — deletion is
/// idempotent so frontends can call this on sign-out without checking
/// existence first.
pub fn delete_secret(service: &str, account: &str) -> Result<(), CredentialError> {
    let entry = entry(service, account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// Parse the chunk-count marker the frontend writes for oversized values
/// (`__typeward_chunks__:<n>`). Returns None for inline (un-chunked) values.
fn parse_chunk_count(main: &str) -> Option<usize> {
    let n: usize = main.strip_prefix(CHUNK_MARKER)?.parse().ok()?;
    (n > 0).then_some(n)
}

/// Reassemble the chunked Supabase session bundle written by the frontend
/// (auth/chunked.ts). Mirrors `getChunkedCredential`: a missing part is a torn
/// write and yields `None` rather than corrupt JSON.
fn read_chunked_session(account: &str) -> Result<Option<String>, CredentialError> {
    let Some(main) = get_secret(SESSION_SERVICE, account)? else {
        return Ok(None);
    };
    let Some(count) = parse_chunk_count(&main) else {
        return Ok(Some(main));
    };
    let mut joined = String::new();
    for i in 0..count {
        match get_secret(SESSION_SERVICE, &format!("{account}.part{i}"))? {
            Some(part) => joined.push_str(&part),
            None => return Ok(None),
        }
    }
    Ok(Some(joined))
}

// ----- IPC commands ------------------------------------------------------
//
// `spawn_blocking` because the secret-service backend on Linux can stall
// for hundreds of milliseconds on first call (it triggers a D-Bus prompt).
// Off-thread also keeps any UI keyring prompt from blocking the tokio
// runtime that LSP/watcher/autosave share.

#[tauri::command]
pub async fn credential_set(
    service: String,
    account: String,
    secret: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_secret(&service, &account, &secret))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()).to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn credential_get(service: String, account: String) -> Result<Option<String>, String> {
    if !frontend_read_allowed(&service) {
        return Err(CredentialError::ReadForbidden(service).to_string());
    }
    tokio::task::spawn_blocking(move || get_secret(&service, &account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()).to_string())?
        .map_err(|e| e.to_string())
}

/// Dedicated reader for the Supabase auth session. supabase-js runs in the
/// webview and must receive the session JWT, so this one secret is readable by
/// the renderer — but only through this purpose-specific command, keeping the
/// generic `credential_get` locked (see `frontend_read_allowed`).
#[tauri::command]
pub async fn supabase_session_read(account: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || read_chunked_session(&account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()).to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn credential_exists(service: String, account: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || secret_exists(&service, &account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()).to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn credential_delete(service: String, account: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_secret(&service, &account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()).to_string())?
        .map_err(|e| e.to_string())
}

fn frontend_read_allowed(service: &str) -> bool {
    matches!(service, "supabase.entitlements")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_empty_service() {
        let err = validate("", "alice").unwrap_err();
        assert!(matches!(err, CredentialError::InvalidService(_)));
    }

    #[test]
    fn validate_rejects_slash_in_account() {
        let err = validate("zotero", "alice/bob").unwrap_err();
        assert!(matches!(err, CredentialError::InvalidAccount(_)));
    }

    #[test]
    fn validate_produces_scoped_service() {
        let scoped = validate("zotero", "alice@example.com").unwrap();
        assert_eq!(scoped, "typeward.zotero");
    }

    #[test]
    fn frontend_read_policy_blocks_api_key_services() {
        assert!(!frontend_read_allowed("openai"));
        assert!(!frontend_read_allowed("anthropic"));
        assert!(!frontend_read_allowed("gemini"));
        assert!(!frontend_read_allowed("dropbox"));
        assert!(!frontend_read_allowed("microsoft"));
        assert!(!frontend_read_allowed("google"));
        assert!(!frontend_read_allowed("mendeley"));
        assert!(!frontend_read_allowed("supabase.session"));
        assert!(frontend_read_allowed("supabase.entitlements"));
    }

    /// A target without a real keystore must fail loudly at the boundary rather
    /// than resolve to keyring's in-memory mock (a secret that vanishes between
    /// IPC calls). On a supported host this asserts the inverse — the guard is
    /// open and every credential command still reaches the OS keyring.
    #[test]
    fn secure_storage_guard_matches_the_platform_backend() {
        #[cfg(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "ios",
            target_os = "linux",
            target_os = "freebsd",
            target_os = "openbsd"
        ))]
        assert!(ensure_secure_storage().is_ok());

        #[cfg(not(any(
            target_os = "windows",
            target_os = "macos",
            target_os = "ios",
            target_os = "linux",
            target_os = "freebsd",
            target_os = "openbsd"
        )))]
        {
            assert!(matches!(
                ensure_secure_storage(),
                Err(CredentialError::SecureStorageUnavailable)
            ));
            // Nothing may report success: a write that silently goes nowhere is
            // the failure mode this guard exists to prevent.
            assert!(matches!(
                set_secret("openai", "default", "sk-test"),
                Err(CredentialError::SecureStorageUnavailable)
            ));
            assert!(matches!(
                get_secret("openai", "default"),
                Err(CredentialError::SecureStorageUnavailable)
            ));
            assert!(matches!(
                secret_exists("openai", "default"),
                Err(CredentialError::SecureStorageUnavailable)
            ));
            assert!(matches!(
                delete_secret("openai", "default"),
                Err(CredentialError::SecureStorageUnavailable)
            ));
        }
    }

    #[test]
    fn secure_storage_error_is_explicit_about_the_platform() {
        assert!(
            CredentialError::SecureStorageUnavailable
                .to_string()
                .contains("secure storage is not available")
        );
    }

    #[test]
    fn parse_chunk_count_handles_inline_and_marker() {
        assert_eq!(parse_chunk_count("eyJhbGciOi.jwt.value"), None);
        assert_eq!(parse_chunk_count("__typeward_chunks__:3"), Some(3));
        assert_eq!(parse_chunk_count("__typeward_chunks__:0"), None);
        assert_eq!(parse_chunk_count("__typeward_chunks__:notanumber"), None);
    }

    // Round-trip tests against the real OS keyring are skipped in CI because
    // the Secret Service backend isn't reachable in a sandbox/container.
    // Run them locally with `cargo test --features keyring-roundtrip -- --ignored`.
    #[test]
    #[ignore]
    fn set_get_delete_roundtrip() {
        let svc = "test-roundtrip";
        let acct = "ci-bot";
        let secret = "hunter2";
        set_secret(svc, acct, secret).unwrap();
        let got = get_secret(svc, acct).unwrap();
        assert_eq!(got.as_deref(), Some(secret));
        delete_secret(svc, acct).unwrap();
        assert_eq!(get_secret(svc, acct).unwrap(), None);
    }
}
