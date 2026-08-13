//! Shared outbound HTTP. All third-party network traffic flows through
//! [`http_request`]; the frontend never has a `reqwest::Client` or an open
//! socket, which keeps tokens unreachable from the webview process.
//!
//! Every outbound `reqwest::Client` in the app — the shared static one here,
//! the AI stream client, the OAuth token-exchange client, and the WebDAV
//! per-host client — is constructed through [`outbound_client_builder`], the
//! single choke point that installs a redirect policy by construction. There
//! is no builder variant that follows redirects without re-screening the hop,
//! so a new outbound path cannot silently become an SSRF primitive.
//!
//! Per-request:
//!   - a bearer header is added by name only; the actual token is fetched
//!     from the keyring inside Rust so it never crosses the IPC bridge
//!   - for OAuth token-bundle services (Mendeley) the access token is
//!     refreshed *pre-emptively* when it is within 60s of expiry
//!     ([`oauth_bundle_access_token`]); static API keys attach verbatim. There
//!     is no 401-triggered refresh/replay here (see [`http_request`]).
//!   - retryable network errors (timeout, connection reset) get one
//!     automatic retry with a 250ms delay; everything else surfaces as-is

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::integrations::credentials;

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        outbound_client_builder(OutboundRedirect::Allowlist)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Some(Duration::from_secs(90)))
            .build()
            .expect("reqwest client init")
    })
}

/// A no-redirect client for OAuth token POSTs. A token endpoint must never
/// bounce our request — following a 3xx would re-send the client secret /
/// refresh token (and the Basic auth header) to the redirect target, even one
/// on an allowlisted host. The initial code exchange already refuses redirects
/// (`OutboundRedirect::None`); the refresh POST must match, not ride the shared
/// allowlist client.
fn token_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        outbound_client_builder(OutboundRedirect::None)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .expect("reqwest token client init")
    })
}

/// Redirect handling for an outbound client. There is intentionally no
/// "unscreened" variant — every constructible client either re-validates each
/// hop against the allowlist, refuses redirects outright, or follows only a
/// pinned same-host hop, so no outbound path can regress into an open SSRF
/// primitive.
pub(crate) enum OutboundRedirect {
    /// Re-run the outbound host/scheme allowlist on every hop (fixed-host funnels).
    Allowlist,
    /// Follow no redirects at all — token POSTs must not bounce the auth code
    /// or a bearer to another host.
    None,
    /// Follow only same-host https hops. For WebDAV, whose host is
    /// user-supplied and pinned to an SSRF-vetted address by the caller.
    SameHost(String),
}

/// The one constructor for every outbound `reqwest` client in the app. It
/// installs the redirect policy by construction (see [`OutboundRedirect`]) plus
/// the shared user agent; callers layer on timeouts and, for WebDAV, address
/// pinning. Routing all four outbound clients through here makes the redirect
/// guard structural rather than a per-site convention that a fifth builder
/// could forget.
pub(crate) fn outbound_client_builder(redirect: OutboundRedirect) -> reqwest::ClientBuilder {
    let policy = match redirect {
        OutboundRedirect::Allowlist => allowlist_redirect_policy(),
        OutboundRedirect::None => reqwest::redirect::Policy::none(),
        OutboundRedirect::SameHost(host) => same_host_https_redirect_policy(&host),
    };
    Client::builder()
        .user_agent(concat!("Typeward/", env!("CARGO_PKG_VERSION")))
        .redirect(policy)
}

/// Redirect policy for user-supplied-host clients (WebDAV): follow only
/// same-host https hops so a redirect can never escape the pinned, SSRF-vetted
/// address. Bounded to 5 hops.
fn same_host_https_redirect_policy(host: &str) -> reqwest::redirect::Policy {
    let expected = host.to_ascii_lowercase();
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("too many redirects");
        }
        let same_host = attempt.url().host_str().map(|h| h.to_ascii_lowercase());
        if attempt.url().scheme() == "https" && same_host.as_deref() == Some(expected.as_str()) {
            attempt.follow()
        } else {
            attempt.error("redirect to a different host blocked")
        }
    })
}

/// Run a blocking closure on Tokio's blocking pool, flattening the `JoinError`
/// (only produced when the task panics or is cancelled — a bug, not an expected
/// runtime error) into its `Display` string. Callers map that string into their
/// own domain error at the boundary. Centralizes the otherwise-repeated
/// `spawn_blocking(...).await.map_err(Join)?` dance around keyring / blocking-fs
/// / git calls.
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Error, Serialize)]
pub enum HttpError {
    #[error("invalid method: {0}")]
    InvalidMethod(String),
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
    #[error("blocked outbound URL: {0}")]
    BlockedUrl(String),
    #[error("blocked outbound auth header for host: {0}")]
    BlockedAuthHeader(String),
    #[error("credential {service}/{account} is not allowed for host {host}")]
    BlockedAuthRef {
        service: String,
        account: String,
        host: String,
    },
    #[error("network error: {0}")]
    Network(String),
    #[error("response body read failed: {0}")]
    Body(String),
    #[error("credential lookup failed: {0}")]
    Credential(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRef {
    /// Keyring service key, e.g. `"zotero"`.
    pub service: String,
    /// Keyring account id, e.g. user email or library id.
    pub account: String,
    /// Header name to attach the secret on. Default: `Authorization`.
    #[serde(default = "default_header")]
    pub header: String,
    /// Value prefix; e.g. `"Bearer "` (note trailing space). Empty by default.
    #[serde(default)]
    pub prefix: String,
    /// Public OAuth client id for token-bundle services that Rust may refresh
    /// before attaching the bearer (Mendeley).
    #[serde(rename = "clientId", default)]
    pub client_id: Option<String>,
}

fn default_header() -> String {
    "Authorization".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub auth_ref: Option<AuthRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryHttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// Optional body bytes. Tauri serializes `Vec<u8>` as a JSON number
    /// array on the wire — callers pass `Array.from(bytes)` from JS.
    #[serde(default)]
    pub body: Option<Vec<u8>>,
    #[serde(default)]
    pub auth_ref: Option<AuthRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Re-runs the outbound host/scheme allowlist on every redirect hop.
/// `validate_outbound_*` only sees the initial URL; without this a
/// compromised or open-redirect-prone allowlisted host could 3xx the
/// request to loopback / private / arbitrary external hosts (SSRF),
/// defeating the entire allowlist.
fn allowlist_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        let url = attempt.url();
        let host = url.host_str().map(|h| h.to_ascii_lowercase());
        let allowed = match (url.scheme(), host.as_deref()) {
            ("https", Some(h)) => allowed_https_host(h),
            ("http", Some(_)) => is_allowed_loopback_url(url),
            _ => false,
        };
        if allowed {
            attempt.follow()
        } else {
            let msg = format!("redirect to non-allowlisted host blocked: {}", url.as_str());
            attempt.error(msg)
        }
    })
}

fn parse_method(method: &str) -> Result<Method, HttpError> {
    method
        .parse::<Method>()
        .map_err(|_| HttpError::InvalidMethod(method.to_string()))
}

fn parse_url(url: &str) -> Result<Url, HttpError> {
    Url::parse(url).map_err(|e| HttpError::InvalidUrl(e.to_string()))
}

fn normalized_host(url: &Url) -> Result<String, HttpError> {
    url.host_str()
        .map(|host| host.to_ascii_lowercase())
        .ok_or_else(|| HttpError::BlockedUrl(url.as_str().to_string()))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

/// Zotero's local HTTP server (Better BibTeX + Zotero 7's built-in local API).
const ZOTERO_LOCAL_PORT: u16 = 23119;
/// `ollama serve`'s default port.
const OLLAMA_DEFAULT_PORT: u16 = 11434;

/// The Ollama port from `integrations.ai.ollamaBaseUrl`, when the user pointed
/// the local AI daemon at a non-default port. Seeded at startup and refreshed on
/// `save_settings` — settings are not reachable from this module (nor from the
/// redirect policy, which has no `AppHandle`), so the one value the loopback
/// allowlist needs is mirrored here.
static LOCAL_AI_PORT: AtomicU32 = AtomicU32::new(0);

/// Record the configured Ollama base URL. A non-loopback or unparseable value
/// clears the extra port: only the two known local integrations may be reached
/// over plaintext loopback, and a LAN/remote Ollama is already blocked by the
/// scheme+host allowlist.
pub fn set_local_ai_base_url(base_url: Option<&str>) {
    let port = base_url
        .and_then(|raw| Url::parse(raw.trim()).ok())
        .filter(|url| url.scheme() == "http" || url.scheme() == "https")
        .filter(|url| {
            url.host_str()
                .map(|h| is_loopback_host(&h.to_ascii_lowercase()))
                .unwrap_or(false)
        })
        .and_then(|url| url.port())
        .unwrap_or(0);
    LOCAL_AI_PORT.store(u32::from(port), Ordering::Relaxed);
}

fn local_ai_port() -> Option<u16> {
    match LOCAL_AI_PORT.load(Ordering::Relaxed) {
        0 => None,
        port => u16::try_from(port).ok(),
    }
}

/// Loopback HTTP is NOT a general egress channel. It exists for exactly two
/// supported local integrations — Zotero (Better BibTeX / Zotero 7 local API)
/// and Ollama — so it is pinned to their ports and API path prefixes. Without
/// this, an injected renderer could sweep every service listening on localhost
/// (dev servers, admin consoles, other apps' IPC) through `http_request`.
/// No credential is ever bound to a loopback host (`validate_auth_ref_for_host`).
fn is_allowed_loopback_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if !is_loopback_host(&host.to_ascii_lowercase()) {
        return false;
    }
    // An explicit port only: the local integrations both publish one, and a
    // default-port (80) loopback URL is never one of them.
    let Some(port) = url.port() else {
        return false;
    };
    let path = url.path();
    if port == ZOTERO_LOCAL_PORT {
        return path.starts_with("/better-bibtex") || path.starts_with("/api/");
    }
    if port == OLLAMA_DEFAULT_PORT || Some(port) == local_ai_port() {
        return path.starts_with("/api/");
    }
    false
}

fn allowed_https_host(host: &str) -> bool {
    matches!(
        host,
        "api.zotero.org"
            | "doi.org"
            // doi.org never serves BibTeX itself: a content-negotiated request
            // 302s to the registration agency that holds the record, and
            // `allowlist_redirect_policy` re-validates every hop — so without
            // these four the whole DOI lookup feature fails with a
            // redirect-blocked error. Metadata-only hosts: no credential binds
            // to them and they are absent from
            // `allowed_raw_auth_header_host`, so nothing else widens.
            | "api.crossref.org"
            | "data.crossref.org"
            | "data.crosscite.org"
            | "data.datacite.org"
            | "export.arxiv.org"
            | "api.mendeley.com"
            | "generativelanguage.googleapis.com"
            | "github.com"
            | "api.github.com"
            | "api.openai.com"
            | "api.anthropic.com"
    )
}

fn allowed_raw_auth_header_host(host: &str) -> bool {
    matches!(
        host,
        "api.mendeley.com" | "generativelanguage.googleapis.com"
    )
}

fn is_sensitive_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization")
        || name.eq_ignore_ascii_case("x-api-key")
        || name.eq_ignore_ascii_case("api-key")
}

pub fn validate_auth_ref_for_host(auth: &AuthRef, host: &str) -> Result<(), HttpError> {
    let allowed = match (auth.service.as_str(), host) {
        ("zotero-web", "api.zotero.org")
        | ("git.github.com", "api.github.com")
        | ("openai", "api.openai.com")
        | ("anthropic", "api.anthropic.com")
        | ("gemini", "generativelanguage.googleapis.com") => true,
        ("mendeley", "api.mendeley.com") if auth.account != "app-secret" => true,
        _ => false,
    };

    if allowed {
        Ok(())
    } else {
        Err(HttpError::BlockedAuthRef {
            service: auth.service.clone(),
            account: auth.account.clone(),
            host: host.to_string(),
        })
    }
}

pub fn validate_outbound_url(url: &str, auth_ref: Option<&AuthRef>) -> Result<Url, HttpError> {
    let parsed = parse_url(url)?;
    let host = normalized_host(&parsed)?;
    match parsed.scheme() {
        "https" if allowed_https_host(&host) => {}
        "http" if is_allowed_loopback_url(&parsed) => {}
        _ => return Err(HttpError::BlockedUrl(url.to_string())),
    }
    if let Some(auth) = auth_ref {
        validate_auth_ref_for_host(auth, &host)?;
    }
    Ok(parsed)
}

pub fn validate_outbound_request(
    url: &str,
    headers: &HashMap<String, String>,
    auth_ref: Option<&AuthRef>,
) -> Result<(), HttpError> {
    let parsed = validate_outbound_url(url, auth_ref)?;
    let host = normalized_host(&parsed)?;
    if headers.keys().any(|name| is_sensitive_header(name))
        && auth_ref.is_none()
        && !allowed_raw_auth_header_host(&host)
    {
        return Err(HttpError::BlockedAuthHeader(host));
    }
    Ok(())
}

// Bound how much we buffer from a response. The whole body is held in memory
// and crosses the IPC bridge, so an unbounded read of a malicious/buggy server
// (or an F1-style redirect target) is an OOM vector. Text responses are API
// JSON; binary is cloud file content, so it gets a larger budget.
const MAX_TEXT_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_BINARY_RESPONSE_BYTES: usize = 128 * 1024 * 1024;

/// Split from [`HttpError`] so callers that own their own error domain
/// (WebDAV) can map an over-cap body and a plain read failure separately.
#[derive(Debug)]
pub(crate) enum BodyCapError {
    TooLarge(String),
    Read(String),
}

/// Streams the body and aborts as soon as the accumulated bytes would exceed
/// `cap` — a chunked (or Content-Length-lying) response never gets buffered
/// whole before the check. The declared length is only a fast pre-fail.
pub(crate) async fn read_body_capped_raw(
    mut res: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, BodyCapError> {
    if let Some(len) = res.content_length()
        && len > cap as u64
    {
        return Err(BodyCapError::TooLarge(format!(
            "response too large: {len} bytes exceeds cap of {cap}"
        )));
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| BodyCapError::Read(e.to_string()))?
    {
        if buf.len() + chunk.len() > cap {
            return Err(BodyCapError::TooLarge(format!(
                "response exceeded cap of {cap} bytes"
            )));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

pub(crate) async fn read_body_capped(
    res: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, HttpError> {
    read_body_capped_raw(res, cap).await.map_err(|e| match e {
        BodyCapError::TooLarge(msg) | BodyCapError::Read(msg) => HttpError::Body(msg),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOAuthTokens {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct OAuthRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

async fn keyring_get(service: &str, account: &str) -> Result<Option<String>, HttpError> {
    let service = service.to_string();
    let account = account.to_string();
    blocking(move || credentials::get_secret(&service, &account))
        .await
        .map_err(HttpError::Credential)?
        .map_err(|e| HttpError::Credential(e.to_string()))
}

async fn keyring_set(service: &str, account: &str, secret: String) -> Result<(), HttpError> {
    let service = service.to_string();
    let account = account.to_string();
    blocking(move || credentials::set_secret(&service, &account, &secret))
        .await
        .map_err(HttpError::Credential)?
        .map_err(|e| HttpError::Credential(e.to_string()))
}

fn now_unix_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn is_expiring_soon(expires_at: Option<i64>) -> bool {
    expires_at.is_some_and(|ts| ts - 60 < now_unix_seconds())
}

fn is_oauth_bundle_auth(auth: &AuthRef, host: &str) -> bool {
    matches!(
        (auth.service.as_str(), host),
        ("mendeley", "api.mendeley.com")
    )
}

/// One refresh at a time per stored token bundle.
///
/// The Mendeley provider issues up to 6 concurrent requests, each carrying the
/// same `authRef`. Around the expiry boundary every one of them independently
/// read the bundle, saw it expiring, and fired its own `grant_type=refresh_token`
/// POST with the *same* refresh token; the writes then raced last-writer-wins.
/// Against a provider that rotates refresh tokens (and detects reuse), the
/// losers fail with `invalid_grant` mid-listing, a superseded token can be the
/// one persisted, and reuse detection can revoke the whole grant — leaving the
/// account dead until the user redoes the sign-in flow.
static OAUTH_REFRESH_LOCKS: std::sync::Mutex<Option<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    std::sync::Mutex::new(None);

fn oauth_refresh_lock(service: &str, account: &str) -> Arc<tokio::sync::Mutex<()>> {
    let key = format!("{service}\u{0}{account}");
    let mut guard = OAUTH_REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .entry(key)
        .or_default()
        .clone()
}

async fn oauth_bundle_access_token(auth: &AuthRef) -> Result<String, HttpError> {
    let raw = keyring_get(&auth.service, &auth.account)
        .await?
        .ok_or_else(|| HttpError::Credential("missing OAuth token bundle".into()))?;
    let mut stored: StoredOAuthTokens = serde_json::from_str(&raw)
        .map_err(|e| HttpError::Credential(format!("invalid OAuth token bundle: {e}")))?;

    if !is_expiring_soon(stored.expires_at) {
        return Ok(stored.access_token);
    }

    // Serialize the refresh, then re-read: a concurrent caller that got here
    // first has already stored a fresh bundle, and reusing its access token is
    // both correct and one round trip cheaper than refreshing again.
    let lock = oauth_refresh_lock(&auth.service, &auth.account);
    let _refresh_guard = lock.lock().await;
    if let Some(raw) = keyring_get(&auth.service, &auth.account).await?
        && let Ok(fresh) = serde_json::from_str::<StoredOAuthTokens>(&raw)
    {
        if !is_expiring_soon(fresh.expires_at) {
            return Ok(fresh.access_token);
        }
        stored = fresh;
    }

    let refresh_token = stored.refresh_token.clone().ok_or_else(|| {
        HttpError::Credential("OAuth access token expired without refresh token".into())
    })?;
    let client_id = auth
        .client_id
        .as_deref()
        .ok_or_else(|| HttpError::Credential("missing OAuth client id for refresh".into()))?;
    let refreshed = refresh_oauth_token(&auth.service, client_id, &refresh_token).await?;

    stored.access_token = refreshed.access_token;
    stored.refresh_token = refreshed.refresh_token.or(stored.refresh_token);
    stored.expires_at = refreshed
        .expires_in
        .map(|expires_in| now_unix_seconds() + expires_in)
        .or(stored.expires_at);

    let serialized = serde_json::to_string(&stored)
        .map_err(|e| HttpError::Credential(format!("OAuth token serialize failed: {e}")))?;
    keyring_set(&auth.service, &auth.account, serialized).await?;

    Ok(stored.access_token)
}

async fn refresh_oauth_token(
    service: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<OAuthRefreshResponse, HttpError> {
    let token_url = match service {
        "mendeley" => "https://api.mendeley.com/oauth/token",
        _ => {
            return Err(HttpError::Credential(format!(
                "unsupported OAuth service: {service}"
            )));
        }
    };

    let body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("grant_type", "refresh_token");
        form.append_pair("refresh_token", refresh_token);
        form.finish()
    };

    let mut builder = token_client()
        .post(token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(body);

    if service == "mendeley" {
        let secret = keyring_get("mendeley", "app-secret")
            .await?
            .ok_or_else(|| HttpError::Credential("missing Mendeley client secret".into()))?;
        let basic = BASE64_STANDARD.encode(format!("{client_id}:{secret}"));
        builder = builder.header("Authorization", format!("Basic {basic}"));
    }

    let res = builder
        .send()
        .await
        .map_err(|e| HttpError::Network(e.to_string()))?;
    let status = res.status().as_u16();
    let bytes = read_body_capped(res, MAX_TEXT_RESPONSE_BYTES).await?;
    if !(200..300).contains(&status) {
        return Err(HttpError::Credential(format!(
            "OAuth refresh failed with status {status}"
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| HttpError::Credential(format!("OAuth refresh parse failed: {e}")))
}

async fn auth_header_value(auth: &AuthRef, host: &str) -> Result<Option<String>, HttpError> {
    let secret = if is_oauth_bundle_auth(auth, host) {
        Some(oauth_bundle_access_token(auth).await?)
    } else {
        keyring_get(&auth.service, &auth.account).await?
    };

    Ok(secret.map(|secret| format!("{}{}", auth.prefix, secret)))
}

/// Request body variant for [`build_outbound_request`]. Text and bytes share
/// the whole validate/headers/auth path; only the payload type differs.
pub(crate) enum OutboundBody<'a> {
    None,
    Text(&'a str),
    Bytes(&'a [u8]),
}

/// The single place that turns request parts into a `reqwest::RequestBuilder`:
/// validates the outbound URL + headers against the allowlist, attaches the
/// caller headers, resolves the auth secret through [`auth_header_value`] (so
/// OAuth token-bundle refresh happens uniformly), and sets the body. Every
/// outbound path — `http_request`, `http_request_bytes`, and the AI stream —
/// composes this so auth handling never diverges per call site.
pub(crate) async fn build_outbound_request(
    client: &Client,
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    auth: Option<&AuthRef>,
    body: OutboundBody<'_>,
) -> Result<reqwest::RequestBuilder, HttpError> {
    let method = parse_method(method)?;
    validate_outbound_request(url, headers, auth)?;
    let mut builder = client.request(method, url);

    for (name, value) in headers {
        builder = builder.header(name, value);
    }

    if let Some(auth) = auth {
        let host = normalized_host(&parse_url(url)?)?;
        if let Some(value) = auth_header_value(auth, &host).await? {
            builder = builder.header(&auth.header, value);
        }
    }

    builder = match body {
        OutboundBody::None => builder,
        OutboundBody::Text(text) => builder.body(text.to_owned()),
        OutboundBody::Bytes(bytes) => builder.body(bytes.to_vec()),
    };

    Ok(builder)
}

async fn perform_once(
    req: &HttpRequest,
    auth: Option<&AuthRef>,
) -> Result<HttpResponse, HttpError> {
    let body = req
        .body
        .as_deref()
        .map_or(OutboundBody::None, OutboundBody::Text);
    let builder =
        build_outbound_request(client(), &req.method, &req.url, &req.headers, auth, body).await?;

    let res = builder
        .send()
        .await
        .map_err(|e| HttpError::Network(e.to_string()))?;

    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let bytes = read_body_capped(res, MAX_TEXT_RESPONSE_BYTES).await?;
    let body = String::from_utf8_lossy(&bytes).into_owned();

    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

/// Issue an outbound HTTP request. Auth tokens are resolved from the
/// keyring inside this process; the frontend never sees them.
///
/// A single transparent retry happens for transient network errors. 401
/// responses are NOT retried automatically here — refresh-and-retry
/// belongs in the per-provider OAuth adapter, which knows how to mint a
/// new access token and which keyring entry to overwrite.
#[tauri::command]
pub async fn http_request(req: HttpRequest) -> Result<HttpResponse, String> {
    http_request_inner(req).await.map_err(|e| e.to_string())
}

async fn http_request_inner(req: HttpRequest) -> Result<HttpResponse, HttpError> {
    match perform_once(&req, req.auth_ref.as_ref()).await {
        Ok(res) => Ok(res),
        Err(HttpError::Network(_)) => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            perform_once(&req, req.auth_ref.as_ref()).await
        }
        Err(other) => Err(other),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryRespMeta<'a> {
    status: u16,
    headers: &'a HashMap<String, String>,
}

/// Binary-safe variant of [`http_request`] — the upload body is raw bytes and
/// the response body comes back through the raw IPC channel.
///
/// The response is returned as a framed [`tauri::ipc::Response`]
/// (`[u32 LE meta_len][meta JSON][body]`, see [`crate::integrations::ipc`])
/// instead of a `{status, headers, body: Vec<u8>}` struct: a serde `Vec<u8>`
/// crosses the bridge as a JSON number array (~3-4x bloat, triple-buffered),
/// which every cloud download/upload would pay. The status + headers ride in
/// the small JSON prefix; the bytes stay raw. (The request body is still a JSON
/// array for now — the upload-side raw-request conversion is the remaining
/// half of this change.)
#[tauri::command]
pub async fn http_request_bytes(req: BinaryHttpRequest) -> Result<tauri::ipc::Response, String> {
    http_request_bytes_inner(req)
        .await
        .map_err(|e| e.to_string())
}

async fn http_request_bytes_inner(
    req: BinaryHttpRequest,
) -> Result<tauri::ipc::Response, HttpError> {
    let res = match perform_once_bytes(&req, req.auth_ref.as_ref()).await {
        Ok(res) => res,
        Err(HttpError::Network(_)) => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            perform_once_bytes(&req, req.auth_ref.as_ref()).await?
        }
        Err(other) => return Err(other),
    };
    let meta = BinaryRespMeta {
        status: res.status,
        headers: &res.headers,
    };
    let meta_json = serde_json::to_vec(&meta)
        .map_err(|e| HttpError::Network(format!("response meta encode: {e}")))?;
    Ok(tauri::ipc::Response::new(
        crate::integrations::ipc::frame_meta_body(&meta_json, &res.body),
    ))
}

async fn perform_once_bytes(
    req: &BinaryHttpRequest,
    auth: Option<&AuthRef>,
) -> Result<BinaryHttpResponse, HttpError> {
    let body = req
        .body
        .as_deref()
        .map_or(OutboundBody::None, OutboundBody::Bytes);
    let builder =
        build_outbound_request(client(), &req.method, &req.url, &req.headers, auth, body).await?;

    let res = builder
        .send()
        .await
        .map_err(|e| HttpError::Network(e.to_string()))?;

    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let bytes = read_body_capped(res, MAX_BINARY_RESPONSE_BYTES).await?;

    Ok(BinaryHttpResponse {
        status,
        headers,
        body: bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_method_accepts_common_verbs() {
        for verb in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            parse_method(verb).expect(verb);
        }
    }

    #[test]
    fn parse_method_rejects_garbage() {
        assert!(parse_method("not a method").is_err());
        assert!(parse_method("").is_err());
    }

    #[test]
    fn auth_ref_defaults_header_to_authorization() {
        let json = r#"{"service":"zotero","account":"alice"}"#;
        let auth: AuthRef = serde_json::from_str(json).unwrap();
        assert_eq!(auth.header, "Authorization");
        assert_eq!(auth.prefix, "");
    }

    #[test]
    fn outbound_allowlist_accepts_known_https_hosts() {
        assert!(validate_outbound_url("https://api.zotero.org/users/1/items", None).is_ok());
        assert!(validate_outbound_url("https://api.openai.com/v1/models", None).is_ok());
    }

    /// doi.org never serves BibTeX itself — a content-negotiated request 302s to
    /// the registration agency, and the redirect policy re-validates every hop.
    /// Without these hosts every DOI lookup failed as redirect-blocked.
    #[test]
    fn outbound_allowlist_covers_the_doi_content_negotiation_targets() {
        for url in [
            "https://doi.org/10.1145/3290605.3300479",
            "https://api.crossref.org/v1/works/10.1145%2F3290605.3300479/transform",
            "https://data.crosscite.org/10.48550%2FarXiv.2403.04132",
            "https://data.crossref.org/10.1145%2F3290605.3300479",
            "https://data.datacite.org/10.5281%2Fzenodo.1234567",
        ] {
            assert!(validate_outbound_url(url, None).is_ok(), "{url}");
        }
    }

    /// They are metadata-only: no credential may be bound to them, so adding
    /// them to the host allowlist widens nothing else.
    #[test]
    fn doi_agency_hosts_accept_no_credentials() {
        for host in [
            "api.crossref.org",
            "data.crossref.org",
            "data.crosscite.org",
            "data.datacite.org",
        ] {
            assert!(!allowed_raw_auth_header_host(host), "{host}");
            let auth = AuthRef {
                service: "mendeley".into(),
                account: "alice".into(),
                header: "Authorization".into(),
                prefix: "Bearer ".into(),
                client_id: None,
            };
            assert!(validate_auth_ref_for_host(&auth, host).is_err(), "{host}");
        }
    }

    #[test]
    fn outbound_allowlist_blocks_unknown_hosts() {
        let err = validate_outbound_url("https://example.com/leak", None).unwrap_err();
        assert!(matches!(err, HttpError::BlockedUrl(_)));
    }

    #[test]
    fn outbound_allowlist_allows_http_only_for_loopback() {
        assert!(validate_outbound_url("http://127.0.0.1:23119/better-bibtex", None).is_ok());
        let err = validate_outbound_url("http://api.zotero.org/users/1/items", None).unwrap_err();
        assert!(matches!(err, HttpError::BlockedUrl(_)));
    }

    #[test]
    fn loopback_allows_the_supported_local_integration_endpoints() {
        for url in [
            "http://127.0.0.1:23119/better-bibtex/library?/1/library.bib",
            "http://127.0.0.1:23119/api/users/0/items?format=bibtex",
            "http://localhost:23119/api/users/0/groups?format=json",
            "http://localhost:11434/api/tags",
            "http://127.0.0.1:11434/api/chat",
            "http://[::1]:11434/api/show",
        ] {
            assert!(validate_outbound_url(url, None).is_ok(), "{url}");
        }
    }

    #[test]
    fn loopback_blocks_other_ports_and_paths() {
        for url in [
            // Arbitrary local services: dev servers, admin consoles, other apps.
            "http://127.0.0.1:8080/admin",
            "http://localhost:5000/callback",
            "http://127.0.0.1:1420/",
            // No explicit port at all.
            "http://localhost/api/tags",
            // Right port, wrong surface — Zotero's local server also serves
            // non-API routes, and Ollama's port must not become a file fetcher.
            "http://127.0.0.1:23119/debug-bridge/execute",
            "http://127.0.0.1:11434/../etc/passwd",
        ] {
            let err = validate_outbound_url(url, None).unwrap_err();
            assert!(matches!(err, HttpError::BlockedUrl(_)), "{url}");
        }
    }

    #[test]
    fn configured_ollama_port_is_allowed_and_revocable() {
        let url = "http://127.0.0.1:31434/api/tags";
        assert!(validate_outbound_url(url, None).is_err());

        set_local_ai_base_url(Some("http://127.0.0.1:31434"));
        assert!(validate_outbound_url(url, None).is_ok());
        // Still only the API surface on that port.
        assert!(validate_outbound_url("http://127.0.0.1:31434/", None).is_err());

        // A non-loopback (or absent) base URL clears the extra port.
        set_local_ai_base_url(Some("http://192.168.1.9:31434"));
        assert!(validate_outbound_url(url, None).is_err());
        set_local_ai_base_url(None);
        assert!(validate_outbound_url(url, None).is_err());
    }

    #[test]
    fn no_credential_is_bound_to_a_loopback_host() {
        for service in ["zotero-web", "openai", "anthropic", "gemini", "mendeley"] {
            let auth = AuthRef {
                service: service.into(),
                account: "default".into(),
                header: "Authorization".into(),
                prefix: "Bearer ".into(),
                client_id: None,
            };
            for host in ["localhost", "127.0.0.1"] {
                assert!(
                    validate_auth_ref_for_host(&auth, host).is_err(),
                    "{service}"
                );
            }
        }
    }

    #[test]
    fn auth_ref_is_bound_to_expected_host() {
        let auth = AuthRef {
            service: "openai".into(),
            account: "default".into(),
            header: "Authorization".into(),
            prefix: "Bearer ".into(),
            client_id: None,
        };
        assert!(validate_outbound_url("https://api.openai.com/v1/models", Some(&auth)).is_ok());
        let err = validate_outbound_url("https://api.github.com/user", Some(&auth)).unwrap_err();
        assert!(matches!(err, HttpError::BlockedAuthRef { .. }));
    }

    #[test]
    fn raw_auth_headers_are_rejected_for_public_metadata_hosts() {
        let mut headers = HashMap::new();
        headers.insert("Authorization".into(), "Bearer secret".into());
        let err =
            validate_outbound_request("https://doi.org/10.1000/test", &headers, None).unwrap_err();
        assert!(matches!(err, HttpError::BlockedAuthHeader(_)));
    }

    fn stream_response(chunks: Vec<Vec<u8>>) -> reqwest::Response {
        let items: Vec<Result<Vec<u8>, std::io::Error>> = chunks.into_iter().map(Ok).collect();
        let body = reqwest::Body::wrap_stream(futures_util::stream::iter(items));
        reqwest::Response::from(axum::http::Response::new(body))
    }

    #[tokio::test]
    async fn capped_read_aborts_chunked_body_without_content_length() {
        let res = stream_response((0..8).map(|_| vec![0u8; 1024]).collect());
        assert_eq!(res.content_length(), None);
        let err = read_body_capped_raw(res, 4096).await.unwrap_err();
        assert!(matches!(err, BodyCapError::TooLarge(_)));
    }

    #[tokio::test]
    async fn capped_read_rejects_declared_oversize_content_length() {
        let res = reqwest::Response::from(axum::http::Response::new(reqwest::Body::from(vec![
            0u8;
            8192
        ])));
        let err = read_body_capped_raw(res, 4096).await.unwrap_err();
        assert!(matches!(err, BodyCapError::TooLarge(_)));
    }

    #[tokio::test]
    async fn capped_read_returns_streamed_body_under_cap() {
        let res = stream_response(vec![vec![1u8; 3], vec![2u8; 2]]);
        let body = read_body_capped_raw(res, 4096).await.unwrap();
        assert_eq!(body, [1, 1, 1, 2, 2]);
    }

    #[test]
    fn http_response_serializes_as_camel_case() {
        let res = HttpResponse {
            status: 200,
            headers: Default::default(),
            body: "ok".into(),
        };
        let json = serde_json::to_string(&res).unwrap();
        // status / headers / body — no rename needed but assert shape stays stable.
        assert!(json.contains("\"status\":200"));
        assert!(json.contains("\"body\":\"ok\""));
    }
}
