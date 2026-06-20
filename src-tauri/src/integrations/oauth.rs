//! PKCE-based OAuth 2.0 flow with a loopback redirect.
//!
//! Each [`oauth_begin`] call:
//!   1. Generates a fresh `state` and PKCE verifier/challenge pair.
//!   2. Binds an axum server to a random `127.0.0.1` port.
//!   3. Builds the auth URL with that loopback as `redirect_uri` and
//!      `code_challenge_method=S256`.
//!   4. Parks the server task waiting for one `/callback?code=…&state=…` hit.
//!   5. Returns `{ url, state }` to the frontend, which opens the URL via
//!      `tauri-plugin-opener`.
//!
//! [`oauth_wait`] then blocks (with timeout) on the matching state until the
//! callback fires, exchanges the code for tokens against the provider's token
//! endpoint, and returns the token payload to the frontend. Token persistence
//! into the keyring is a *separate* step the caller drives once it knows the
//! account identifier (typically via a follow-up userinfo call).
//!
//! Multiple concurrent OAuth flows are supported — each begins on its own
//! port and is keyed by state in [`OauthManager`].

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Query, State},
    response::Html,
    routing::get,
    Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_TOKEN_RESPONSE_BYTES: usize = 1024 * 1024;
const CALLBACK_HTML_SUCCESS: &str = "<!doctype html><html><head><title>Typeward</title>\
<style>body{font-family:system-ui;background:#0A0B0F;color:#E5E7EB;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style>\
</head><body><div><h1>Signed in.</h1><p>You can close this tab and return to Typeward.</p></div></body></html>";
const CALLBACK_HTML_ERROR: &str = "<!doctype html><html><head><title>Typeward</title>\
<style>body{font-family:system-ui;background:#0A0B0F;color:#F87171;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style>\
</head><body><div><h1>Sign-in failed.</h1><p>Return to Typeward and try again.</p></div></body></html>";

#[derive(Debug, Error, Serialize)]
pub enum OauthError {
    #[error("invalid auth url: {0}")]
    InvalidAuthUrl(String),
    #[error("bind loopback failed: {0}")]
    BindFailed(String),
    #[error("unknown state (begin call missing or already consumed)")]
    UnknownState,
    #[error("callback timed out after {0}s")]
    Timeout(u64),
    #[error("callback returned error: {0}")]
    CallbackError(String),
    #[error("token exchange failed: {0}")]
    TokenExchange(String),
    #[error("response parse failed: {0}")]
    ResponseParse(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthBeginRequest {
    /// Provider's authorization endpoint, e.g. `https://www.dropbox.com/oauth2/authorize`.
    pub auth_url: String,
    /// Provider's token endpoint, e.g. `https://api.dropboxapi.com/oauth2/token`.
    pub token_url: String,
    pub client_id: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Provider-specific extra params on the authorization URL (e.g.
    /// `token_access_type=offline` for Dropbox).
    #[serde(default)]
    pub extra_auth_params: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthBeginResponse {
    pub url: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthTokens {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix-epoch seconds at which the access token expires, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    pub token_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(default)]
    scope: Option<String>,
}

fn default_token_type() -> String {
    "Bearer".into()
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

type CallbackResult = Result<String, OauthError>;
type CallbackReceiver = oneshot::Receiver<CallbackResult>;
type CallbackSender = oneshot::Sender<CallbackResult>;
type SharedCallbackSender = Arc<std::sync::Mutex<Option<CallbackSender>>>;
type ShutdownSender = oneshot::Sender<()>;
type SharedShutdownSender = Arc<std::sync::Mutex<Option<ShutdownSender>>>;

/// One pending OAuth flow. Held by [`OauthManager`] until either the
/// callback fires (success/error) or the wait times out, at which point
/// the entry is removed and the server task drops.
struct PendingFlow {
    /// Set once on the callback. `oauth_wait` takes it and consumes the result.
    rx: Mutex<Option<CallbackReceiver>>,
    code_verifier: String,
    token_url: String,
    client_id: String,
    redirect_uri: String,
    /// Same handle the callback holds (shared `Arc`). Lets `oauth_wait` shut
    /// the loopback server down on timeout / channel-close, instead of leaking
    /// the bound port until process exit.
    shutdown: SharedShutdownSender,
}

impl PendingFlow {
    fn shutdown_server(&self) {
        if let Some(tx) = self.shutdown.lock().expect("oauth shutdown lock").take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Default)]
pub struct OauthManager {
    flows: std::sync::Mutex<HashMap<String, Arc<PendingFlow>>>,
}

impl OauthManager {
    fn insert(&self, state: String, flow: Arc<PendingFlow>) {
        self.flows
            .lock()
            .expect("oauth flows lock")
            .insert(state, flow);
    }

    fn take(&self, state: &str) -> Option<Arc<PendingFlow>> {
        self.flows.lock().expect("oauth flows lock").remove(state)
    }

    fn peek(&self, state: &str) -> Option<Arc<PendingFlow>> {
        self.flows
            .lock()
            .expect("oauth flows lock")
            .get(state)
            .cloned()
    }
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    /// Held in an Arc<Mutex<Option<…>>> so the first callback consumes it.
    tx: SharedCallbackSender,
    shutdown: SharedShutdownSender,
}

fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(digest);
    (verifier, challenge)
}

fn build_auth_url(
    auth_url: &str,
    client_id: &str,
    redirect_uri: &str,
    scopes: &[String],
    state: &str,
    challenge: &str,
    extras: &HashMap<String, String>,
) -> Result<String, OauthError> {
    let mut url =
        url::Url::parse(auth_url).map_err(|e| OauthError::InvalidAuthUrl(e.to_string()))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("redirect_uri", redirect_uri);
        q.append_pair("state", state);
        q.append_pair("code_challenge", challenge);
        q.append_pair("code_challenge_method", "S256");
        if !scopes.is_empty() {
            q.append_pair("scope", &scopes.join(" "));
        }
        for (k, v) in extras {
            q.append_pair(k, v);
        }
    }
    Ok(url.to_string())
}

#[derive(Clone, Copy)]
enum OauthEndpointKind {
    Authorization,
    Token,
}

fn validate_oauth_endpoint(raw: &str, kind: OauthEndpointKind) -> Result<(), OauthError> {
    let parsed = url::Url::parse(raw).map_err(|e| match kind {
        OauthEndpointKind::Authorization => OauthError::InvalidAuthUrl(e.to_string()),
        OauthEndpointKind::Token => OauthError::TokenExchange(e.to_string()),
    })?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let path = parsed.path();
    let allowed = match kind {
        OauthEndpointKind::Authorization => {
            matches!(
                (host.as_str(), path),
                ("www.dropbox.com", "/oauth2/authorize") | ("api.mendeley.com", "/oauth/authorize")
            )
        }
        OauthEndpointKind::Token => {
            matches!(
                (host.as_str(), path),
                ("api.dropboxapi.com", "/oauth2/token") | ("api.mendeley.com", "/oauth/token")
            )
        }
    };

    if parsed.scheme() == "https" && allowed {
        Ok(())
    } else {
        let msg = format!("blocked OAuth endpoint: {raw}");
        Err(match kind {
            OauthEndpointKind::Authorization => OauthError::InvalidAuthUrl(msg),
            OauthEndpointKind::Token => OauthError::TokenExchange(msg),
        })
    }
}

fn validate_extra_auth_params(params: &HashMap<String, String>) -> Result<(), OauthError> {
    const RESERVED: &[&str] = &[
        "response_type",
        "client_id",
        "redirect_uri",
        "state",
        "code_challenge",
        "code_challenge_method",
        "scope",
    ];
    for key in params.keys() {
        let normalized = key.trim().to_ascii_lowercase();
        if normalized.is_empty() || normalized.len() > 80 || RESERVED.contains(&normalized.as_str())
        {
            return Err(OauthError::InvalidAuthUrl(format!(
                "reserved or invalid OAuth parameter: {key}"
            )));
        }
    }
    Ok(())
}

async fn callback_handler(
    State(state): State<CallbackState>,
    Query(params): Query<CallbackQuery>,
) -> Html<&'static str> {
    let result: Result<String, OauthError> = if let Some(error) = params.error {
        let desc = params
            .error_description
            .map(|d| format!("{error}: {d}"))
            .unwrap_or(error);
        Err(OauthError::CallbackError(desc))
    } else if params.state.as_deref() != Some(state.expected_state.as_str()) {
        Err(OauthError::CallbackError(
            "state mismatch (CSRF guard)".into(),
        ))
    } else if let Some(code) = params.code {
        Ok(code)
    } else {
        Err(OauthError::CallbackError("missing code".into()))
    };

    let is_ok = result.is_ok();

    if let Some(tx) = state.tx.lock().expect("oauth tx lock").take() {
        let _ = tx.send(result);
    }
    if let Some(shutdown) = state.shutdown.lock().expect("oauth shutdown lock").take() {
        let _ = shutdown.send(());
    }

    if is_ok {
        Html(CALLBACK_HTML_SUCCESS)
    } else {
        Html(CALLBACK_HTML_ERROR)
    }
}

#[tauri::command]
pub async fn oauth_begin(
    req: OauthBeginRequest,
    manager: tauri::State<'_, OauthManager>,
) -> Result<OauthBeginResponse, OauthError> {
    validate_oauth_endpoint(&req.auth_url, OauthEndpointKind::Authorization)?;
    validate_oauth_endpoint(&req.token_url, OauthEndpointKind::Token)?;
    validate_extra_auth_params(&req.extra_auth_params)?;

    let state = generate_state();
    let (code_verifier, code_challenge) = generate_pkce();

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|e| OauthError::BindFailed(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| OauthError::BindFailed(e.to_string()))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = build_auth_url(
        &req.auth_url,
        &req.client_id,
        &redirect_uri,
        &req.scopes,
        &state,
        &code_challenge,
        &req.extra_auth_params,
    )?;

    let (cb_tx, cb_rx) = oneshot::channel::<Result<String, OauthError>>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let shutdown = Arc::new(std::sync::Mutex::new(Some(shutdown_tx)));

    let callback_state = CallbackState {
        expected_state: state.clone(),
        tx: Arc::new(std::sync::Mutex::new(Some(cb_tx))),
        shutdown: shutdown.clone(),
    };

    let app = Router::new()
        .route("/callback", get(callback_handler))
        .with_state(callback_state);

    // Park the server until either the callback fires (which signals
    // shutdown_tx) or the wait times out (which drops the flow entry; the
    // server then exits when the next graceful-shutdown poll runs).
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    let flow = Arc::new(PendingFlow {
        rx: Mutex::new(Some(cb_rx)),
        code_verifier,
        token_url: req.token_url,
        client_id: req.client_id,
        redirect_uri,
        shutdown,
    });
    manager.insert(state.clone(), flow);

    Ok(OauthBeginResponse {
        url: auth_url,
        state,
    })
}

#[tauri::command]
pub async fn oauth_wait(
    state: String,
    manager: tauri::State<'_, OauthManager>,
) -> Result<OauthTokens, OauthError> {
    let flow = manager.peek(&state).ok_or(OauthError::UnknownState)?;

    let rx = flow
        .rx
        .lock()
        .await
        .take()
        .ok_or(OauthError::UnknownState)?;

    let code = match tokio::time::timeout(CALLBACK_TIMEOUT, rx).await {
        Ok(Ok(Ok(code))) => code,
        Ok(Ok(Err(e))) => {
            // Callback reported an error (e.g. state mismatch). The handler
            // already fired shutdown; just drop the flow entry.
            manager.take(&state);
            return Err(e);
        }
        Ok(Err(_)) => {
            flow.shutdown_server();
            manager.take(&state);
            return Err(OauthError::CallbackError("callback channel closed".into()));
        }
        Err(_) => {
            // Timed out: the callback never fired, so the server is still
            // parked on its bound port. Shut it down before dropping the flow.
            flow.shutdown_server();
            manager.take(&state);
            return Err(OauthError::Timeout(CALLBACK_TIMEOUT.as_secs()));
        }
    };

    let tokens = exchange_code(&flow, &code).await;
    manager.take(&state);
    tokens
}

async fn exchange_code(flow: &PendingFlow, code: &str) -> Result<OauthTokens, OauthError> {
    // Redirects are disabled: a token POST must not be bounced to an attacker
    // host carrying the auth code + verifier.
    validate_oauth_endpoint(&flow.token_url, OauthEndpointKind::Token)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| OauthError::TokenExchange(e.to_string()))?;
    let response = client
        .post(&flow.token_url)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", flow.redirect_uri.as_str()),
            ("client_id", flow.client_id.as_str()),
            ("code_verifier", flow.code_verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| OauthError::TokenExchange(e.to_string()))?;

    let status = response.status();

    if !status.is_success() {
        return Err(OauthError::TokenExchange(format!(
            "token endpoint returned status {}",
            status.as_u16()
        )));
    }

    // Don't embed the raw body in the error: a 2xx token response that fails
    // to deserialize contains access/refresh tokens, which would otherwise
    // leak into the frontend error path and telemetry.log.
    let body = crate::integrations::http::read_body_capped(response, MAX_TOKEN_RESPONSE_BYTES)
        .await
        .map_err(|e| OauthError::TokenExchange(e.to_string()))?;
    let body = String::from_utf8(body).map_err(|e| OauthError::ResponseParse(e.to_string()))?;
    let parsed: TokenResponse =
        serde_json::from_str(&body).map_err(|e| OauthError::ResponseParse(e.to_string()))?;

    let expires_at = parsed.expires_in.and_then(|secs| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|now| now.as_secs() as i64 + secs)
    });

    Ok(OauthTokens {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at,
        token_type: parsed.token_type,
        scope: parsed.scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_and_challenge_have_expected_shape() {
        let (verifier, challenge) = generate_pkce();
        assert!(
            verifier.len() >= 43,
            "verifier too short: {}",
            verifier.len()
        );
        assert!(
            verifier.len() <= 128,
            "verifier too long: {}",
            verifier.len()
        );
        assert_eq!(challenge.len(), 43, "S256 challenge is always 43 chars");
        assert!(
            !verifier.contains('=') && !challenge.contains('='),
            "PKCE values must be base64url without padding"
        );
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert!(challenge
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn state_is_distinct_per_call() {
        let a = generate_state();
        let b = generate_state();
        assert_ne!(a, b);
        assert!(a.len() >= 32);
    }

    #[test]
    fn build_auth_url_includes_required_params() {
        let url = build_auth_url(
            "https://example.com/oauth/authorize",
            "client-xyz",
            "http://127.0.0.1:12345/callback",
            &["read".into(), "write".into()],
            "state-abc",
            "challenge-def",
            &HashMap::from([("prompt".into(), "consent".into())]),
        )
        .unwrap();

        assert!(url.starts_with("https://example.com/oauth/authorize?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("client_id=client-xyz"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback"));
        assert!(url.contains("state=state-abc"));
        assert!(url.contains("code_challenge=challenge-def"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("scope=read+write"));
        assert!(url.contains("prompt=consent"));
    }

    #[test]
    fn build_auth_url_rejects_garbage() {
        let err = build_auth_url(
            "not a url",
            "x",
            "http://127.0.0.1:1/callback",
            &[],
            "s",
            "c",
            &HashMap::new(),
        )
        .unwrap_err();
        assert!(matches!(err, OauthError::InvalidAuthUrl(_)));
    }

    #[test]
    fn oauth_endpoint_allowlist_accepts_known_providers() {
        assert!(validate_oauth_endpoint(
            "https://www.dropbox.com/oauth2/authorize",
            OauthEndpointKind::Authorization,
        )
        .is_ok());
        assert!(validate_oauth_endpoint(
            "https://api.dropboxapi.com/oauth2/token",
            OauthEndpointKind::Token,
        )
        .is_ok());
    }

    #[test]
    fn oauth_endpoint_allowlist_blocks_unknown_hosts_and_plain_http() {
        assert!(validate_oauth_endpoint(
            "https://example.com/oauth2/authorize",
            OauthEndpointKind::Authorization,
        )
        .is_err());
        assert!(validate_oauth_endpoint(
            "http://api.dropboxapi.com/oauth2/token",
            OauthEndpointKind::Token,
        )
        .is_err());
    }

    #[test]
    fn extra_auth_params_cannot_override_pkce_core_fields() {
        let params = HashMap::from([("redirect_uri".into(), "https://evil.test".into())]);
        assert!(validate_extra_auth_params(&params).is_err());
        let params = HashMap::from([("prompt".into(), "consent".into())]);
        assert!(validate_extra_auth_params(&params).is_ok());
    }

    #[test]
    fn token_response_parses_minimal_body() {
        let json = r#"{"access_token":"abc","expires_in":3600}"#;
        let parsed: TokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.access_token, "abc");
        assert_eq!(parsed.expires_in, Some(3600));
        assert_eq!(parsed.token_type, "Bearer");
    }
}
