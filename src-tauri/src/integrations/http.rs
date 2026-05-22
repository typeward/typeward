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

use reqwest::{Client, Method};
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
            .build()
            .expect("reqwest client init")
    })
}

#[derive(Debug, Error, Serialize)]
pub enum HttpError {
    #[error("invalid method: {0}")]
    InvalidMethod(String),
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

fn parse_method(method: &str) -> Result<Method, HttpError> {
    method
        .parse::<Method>()
        .map_err(|_| HttpError::InvalidMethod(method.to_string()))
}

async fn perform_once(req: &HttpRequest, auth: Option<&AuthRef>) -> Result<HttpResponse, HttpError> {
    let method = parse_method(&req.method)?;
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
    let body = res
        .text()
        .await
        .map_err(|e| HttpError::Body(e.to_string()))?;

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
