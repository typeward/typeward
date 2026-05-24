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
use serde::Serialize;
use thiserror::Error;

const SERVICE_PREFIX: &str = "typeward";

#[derive(Debug, Error, Serialize)]
pub enum CredentialError {
    #[error("invalid service name (empty or contains '/'): {0}")]
    InvalidService(String),
    #[error("invalid account name (empty or contains '/'): {0}")]
    InvalidAccount(String),
    #[error("secret is empty")]
    EmptySecret,
    #[error("frontend reads are not allowed for service: {0}")]
    ReadForbidden(String),
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

fn entry(service: &str, account: &str) -> Result<Entry, CredentialError> {
    let scoped = validate(service, account)?;
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
) -> Result<(), CredentialError> {
    tokio::task::spawn_blocking(move || set_secret(&service, &account, &secret))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()))?
}

#[tauri::command]
pub async fn credential_get(
    service: String,
    account: String,
) -> Result<Option<String>, CredentialError> {
    if !frontend_read_allowed(&service) {
        return Err(CredentialError::ReadForbidden(service));
    }
    tokio::task::spawn_blocking(move || get_secret(&service, &account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()))?
}

#[tauri::command]
pub async fn credential_exists(service: String, account: String) -> Result<bool, CredentialError> {
    tokio::task::spawn_blocking(move || secret_exists(&service, &account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()))?
}

#[tauri::command]
pub async fn credential_delete(service: String, account: String) -> Result<(), CredentialError> {
    tokio::task::spawn_blocking(move || delete_secret(&service, &account))
        .await
        .map_err(|e| CredentialError::Join(e.to_string()))?
}

fn frontend_read_allowed(service: &str) -> bool {
    matches!(
        service,
        "dropbox"
            | "microsoft"
            | "google"
            | "mendeley"
            | "supabase.session"
            | "supabase.entitlements"
    )
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
        assert!(frontend_read_allowed("supabase.session"));
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
