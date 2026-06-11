//! Shared outbound HTTP. All third-party network traffic flows through
//! [`http_request`]; the frontend never has a `reqwest::Client` or an open
//! socket, which keeps tokens unreachable from the webview process.
//!
//! Built on a single static `reqwest::Client` (HTTP/2, connection pool,
//! sensible timeouts). Per-request:
//!   - bearer header is added by name only; the actual token is fetched
//!     from the keyring inside Rust so it never crosses the IPC bridge
//!   - a single 401 retry kicks in when an `auth_ref` is supplied: the
//!     caller's `refresh_endpoint` is hit, the new bearer is persisted,
//!     and the original request is replayed once
//!   - retryable network errors (timeout, connection reset) get one
//!     automatic retry with a 250ms delay; everything else surfaces as-is

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::integrations::credentials;

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("Typeward/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Some(Duration::from_secs(90)))
            .redirect(allowlist_redirect_policy())
            .build()
            .expect("reqwest client init")
    })
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
pub(crate) fn allowlist_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        let url = attempt.url();
        let host = url.host_str().map(|h| h.to_ascii_lowercase());
        let allowed = match (url.scheme(), host.as_deref()) {
            ("https", Some(h)) => allowed_https_host(h),
            ("http", Some(h)) => is_loopback_host(h),
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

fn allowed_https_host(host: &str) -> bool {
    matches!(
        host,
        "api.zotero.org"
            | "doi.org"
            | "export.arxiv.org"
            | "api.mendeley.com"
            | "api.dropboxapi.com"
            | "content.dropboxapi.com"
            | "notify.dropboxapi.com"
            | "login.microsoftonline.com"
            | "graph.microsoft.com"
            | "accounts.google.com"
            | "oauth2.googleapis.com"
            | "www.googleapis.com"
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
        "api.mendeley.com"
            | "api.dropboxapi.com"
            | "content.dropboxapi.com"
            | "notify.dropboxapi.com"
            | "graph.microsoft.com"
            | "www.googleapis.com"
            | "generativelanguage.googleapis.com"
    )
}

fn is_sensitive_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("authorization")
        || name.eq_ignore_ascii_case("x-api-key")
        || name.eq_ignore_ascii_case("api-key")
}

pub fn validate_auth_ref_for_host(auth: &AuthRef, host: &str) -> Result<(), HttpError> {
    let allowed = matches!(
        (auth.service.as_str(), host),
        ("zotero-web", "api.zotero.org")
            | ("git.github.com", "api.github.com")
            | ("openai", "api.openai.com")
            | ("anthropic", "api.anthropic.com")
            | ("gemini", "generativelanguage.googleapis.com")
    );

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
        "http" if is_loopback_host(&host) => {}
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

pub(crate) async fn read_body_capped(
    mut res: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, HttpError> {
    if let Some(len) = res.content_length() {
        if len > cap as u64 {
            return Err(HttpError::Body(format!(
                "response too large: {len} bytes exceeds cap of {cap}"
            )));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| HttpError::Body(e.to_string()))?
    {
        if buf.len() + chunk.len() > cap {
            return Err(HttpError::Body(format!(
                "response exceeded cap of {cap} bytes"
            )));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

async fn perform_once(
    req: &HttpRequest,
    auth: Option<&AuthRef>,
) -> Result<HttpResponse, HttpError> {
    let method = parse_method(&req.method)?;
    validate_outbound_request(&req.url, &req.headers, auth)?;
    let mut builder = client().request(method, &req.url);

    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }

    if let Some(auth) = auth {
        let secret = tokio::task::spawn_blocking({
            let service = auth.service.clone();
            let account = auth.account.clone();
            move || credentials::get_secret(&service, &account)
        })
        .await
        .map_err(|e| HttpError::Credential(e.to_string()))?
        .map_err(|e| HttpError::Credential(e.to_string()))?;

        if let Some(secret) = secret {
            let value = format!("{}{}", auth.prefix, secret);
            builder = builder.header(&auth.header, value);
        }
    }

    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }

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
pub async fn http_request(req: HttpRequest) -> Result<HttpResponse, HttpError> {
    match perform_once(&req, req.auth_ref.as_ref()).await {
        Ok(res) => Ok(res),
        Err(HttpError::Network(_)) => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            perform_once(&req, req.auth_ref.as_ref()).await
        }
        Err(other) => Err(other),
    }
}

/// Binary-safe variant of [`http_request`] — body in and body out are
/// raw bytes. Used for cloud-provider file upload / download where the
/// payload is arbitrary binary content that can't survive a UTF-8 round
/// trip.
#[tauri::command]
pub async fn http_request_bytes(req: BinaryHttpRequest) -> Result<BinaryHttpResponse, HttpError> {
    match perform_once_bytes(&req, req.auth_ref.as_ref()).await {
        Ok(res) => Ok(res),
        Err(HttpError::Network(_)) => {
            tokio::time::sleep(Duration::from_millis(250)).await;
            perform_once_bytes(&req, req.auth_ref.as_ref()).await
        }
        Err(other) => Err(other),
    }
}

async fn perform_once_bytes(
    req: &BinaryHttpRequest,
    auth: Option<&AuthRef>,
) -> Result<BinaryHttpResponse, HttpError> {
    let method = parse_method(&req.method)?;
    validate_outbound_request(&req.url, &req.headers, auth)?;
    let mut builder = client().request(method, &req.url);

    for (name, value) in &req.headers {
        builder = builder.header(name, value);
    }

    if let Some(auth) = auth {
        let secret = tokio::task::spawn_blocking({
            let service = auth.service.clone();
            let account = auth.account.clone();
            move || credentials::get_secret(&service, &account)
        })
        .await
        .map_err(|e| HttpError::Credential(e.to_string()))?
        .map_err(|e| HttpError::Credential(e.to_string()))?;

        if let Some(secret) = secret {
            let value = format!("{}{}", auth.prefix, secret);
            builder = builder.header(&auth.header, value);
        }
    }

    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }

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
    fn auth_ref_is_bound_to_expected_host() {
        let auth = AuthRef {
            service: "openai".into(),
            account: "default".into(),
            header: "Authorization".into(),
            prefix: "Bearer ".into(),
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
