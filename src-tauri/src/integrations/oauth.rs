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
//!
//! Flow ownership is split across two IPCs, so cleanup does not rely on
//! [`oauth_wait`] ever being called: [`oauth_cancel`] lets an abandoned sign-in
//! release its loopback listener(s) immediately, and [`oauth_begin`] also arms
//! a Rust-side expiry task that removes and shuts down the flow after
//! [`CALLBACK_TIMEOUT`] regardless. Without this, a flow whose caller never
//! reaches `oauth_wait` would park its port until process exit — fatal for a
//! fixed registered port (Mendeley), where the next attempt cannot rebind.

use std::collections::HashMap;
use std::net::{Ipv6Addr, SocketAddr};
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
use tokio::sync::{broadcast, oneshot, Mutex};

use tauri::Manager;

use crate::integrations::credentials;
use crate::integrations::http::{blocking, outbound_client_builder, OutboundRedirect};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_TOKEN_RESPONSE_BYTES: usize = 1024 * 1024;
const CALLBACK_HTML_SUCCESS: &str = "<!doctype html><html><head><title>Typeward</title>\
<style>body{font-family:system-ui;background:#0A0B0F;color:#E5E7EB;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style>\
</head><body><div><h1>Signed in.</h1><p>You can close this tab and return to Typeward.</p></div></body></html>";
const CALLBACK_HTML_ERROR: &str = "<!doctype html><html><head><title>Typeward</title>\
<style>body{font-family:system-ui;background:#0A0B0F;color:#F87171;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}</style>\
</head><body><div><h1>Sign-in failed.</h1><p>Return to Typeward and try again.</p></div></body></html>";
// Returned for stray requests that aren't an OAuth callback (e.g. a probe or a
// manually opened loopback root), so they don't consume the result channel.
const CALLBACK_HTML_WAITING: &str =
    "<!doctype html><html><head><title>Typeward</title></head><body></body></html>";

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
    #[error("credential lookup failed: {0}")]
    Credential(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRef {
    pub service: String,
    pub account: String,
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
    /// Exact, pre-registered loopback redirect URI for providers that don't
    /// support dynamic ports (e.g. Mendeley). Must be an `http://` loopback URL
    /// with an explicit port. `None` => OS-assigned `127.0.0.1` random port.
    #[serde(default)]
    pub redirect_uri: Option<String>,
    /// When set, the token exchange authenticates as a *confidential* client
    /// via HTTP Basic (`client_id:secret`) instead of PKCE. Required for
    /// providers like Mendeley that don't support PKCE.
    #[serde(default)]
    pub client_secret: Option<String>,
    /// Preferred confidential-client path: Rust reads the client secret from
    /// the keyring instead of receiving it from the renderer.
    #[serde(rename = "clientSecretRef", default)]
    pub client_secret_ref: Option<CredentialRef>,
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
    /// Present only for confidential clients — drives HTTP Basic token exchange.
    client_secret: Option<String>,
    /// Broadcast so every bound loopback listener (IPv4 + IPv6) shuts down on
    /// timeout / channel-close, instead of leaking its port until process exit.
    shutdown: broadcast::Sender<()>,
}

impl PendingFlow {
    fn shutdown_server(&self) {
        let _ = self.shutdown.send(());
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
    shutdown: broadcast::Sender<()>,
}

fn generate_state() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
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

/// Parse a user-registered loopback redirect URI into (port, path). Enforces
/// http + loopback host + explicit port so the renderer can't point the
/// redirect at an external host (which would exfiltrate the auth code).
fn parse_loopback_redirect(uri: &str) -> Result<(u16, String), OauthError> {
    let parsed = url::Url::parse(uri).map_err(|e| OauthError::InvalidAuthUrl(e.to_string()))?;
    if parsed.scheme() != "http" {
        return Err(OauthError::InvalidAuthUrl(
            "redirect URL must be http:// on a loopback host".into(),
        ));
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err(OauthError::InvalidAuthUrl(format!(
            "redirect host must be loopback (localhost / 127.0.0.1), got: {host}"
        )));
    }
    let port = parsed
        .port()
        .ok_or_else(|| OauthError::InvalidAuthUrl("redirect URL must include a port".into()))?;
    let mut path = parsed.path().to_string();
    if path.is_empty() {
        path = "/".into();
    }
    Ok((port, path))
}

/// Bind the loopback callback server. With an explicit `redirect_uri` (a
/// confidential provider's exact registered URL) it binds both IPv4 and IPv6
/// loopback on that URL's port so `localhost` resolves either way, and returns
/// the URL verbatim. Without one it picks a random `127.0.0.1` port (the PKCE
/// default). Returns `(listeners, redirect_uri, callback_path)`.
async fn build_listeners(
    redirect_uri: Option<&str>,
) -> Result<(Vec<TcpListener>, String, String), OauthError> {
    match redirect_uri {
        Some(uri) => {
            let (port, path) = parse_loopback_redirect(uri)?;
            let mut listeners = Vec::new();
            if let Ok(l) = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
                listeners.push(l);
            }
            if let Ok(l) = TcpListener::bind(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).await {
                listeners.push(l);
            }
            if listeners.is_empty() {
                return Err(OauthError::BindFailed(format!(
                    "port {port} is already in use — close whatever is using it and retry, or \
                     register a redirect URL on a free port (on macOS, AirPlay Receiver uses 5000)"
                )));
            }
            Ok((listeners, uri.to_string(), path))
        }
        None => {
            let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
                .await
                .map_err(|e| OauthError::BindFailed(e.to_string()))?;
            let port = listener
                .local_addr()
                .map_err(|e| OauthError::BindFailed(e.to_string()))?
                .port();
            Ok((
                vec![listener],
                format!("http://127.0.0.1:{port}/callback"),
                "/callback".to_string(),
            ))
        }
    }
}

async fn callback_handler(
    State(state): State<CallbackState>,
    Query(params): Query<CallbackQuery>,
) -> Html<&'static str> {
    // A bare-root redirect (no path) makes "/" the callback route, so stray
    // GETs (probes, prefetches, a manually opened loopback URL) would otherwise
    // resolve the channel as an error and tear both listeners down before the
    // real redirect lands. Ignore anything without OAuth params.
    if params.code.is_none() && params.error.is_none() {
        return Html(CALLBACK_HTML_WAITING);
    }

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
    let _ = state.shutdown.send(());

    if is_ok {
        Html(CALLBACK_HTML_SUCCESS)
    } else {
        Html(CALLBACK_HTML_ERROR)
    }
}

async fn resolve_client_secret_ref(reference: CredentialRef) -> Result<String, OauthError> {
    if reference.service != "mendeley" || reference.account != "app-secret" {
        return Err(OauthError::Credential(format!(
            "client secret ref is not allowed: {}/{}",
            reference.service, reference.account
        )));
    }
    blocking(move || credentials::get_secret(&reference.service, &reference.account))
        .await
        .map_err(OauthError::Credential)?
        .map_err(|e| OauthError::Credential(e.to_string()))?
        .ok_or_else(|| OauthError::Credential("missing Mendeley client secret".into()))
}

#[tauri::command]
pub async fn oauth_begin(
    req: OauthBeginRequest,
    app: tauri::AppHandle,
    manager: tauri::State<'_, OauthManager>,
) -> Result<OauthBeginResponse, String> {
    oauth_begin_inner(req, app, manager)
        .await
        .map_err(|e| e.to_string())
}

async fn oauth_begin_inner(
    req: OauthBeginRequest,
    app: tauri::AppHandle,
    manager: tauri::State<'_, OauthManager>,
) -> Result<OauthBeginResponse, OauthError> {
    validate_oauth_endpoint(&req.auth_url, OauthEndpointKind::Authorization)?;
    validate_oauth_endpoint(&req.token_url, OauthEndpointKind::Token)?;
    validate_extra_auth_params(&req.extra_auth_params)?;

    let state = generate_state();
    let (code_verifier, code_challenge) = generate_pkce();

    if req.client_secret.is_some() && req.client_secret_ref.is_some() {
        return Err(OauthError::Credential(
            "clientSecret and clientSecretRef are mutually exclusive".into(),
        ));
    }
    let client_secret = match req.client_secret_ref.clone() {
        Some(reference) => Some(resolve_client_secret_ref(reference).await?),
        None => req.client_secret.clone(),
    };

    let (listeners, redirect_uri, callback_path) =
        build_listeners(req.redirect_uri.as_deref()).await?;

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
    let (shutdown_tx, _) = broadcast::channel::<()>(4);

    let callback_state = CallbackState {
        expected_state: state.clone(),
        tx: Arc::new(std::sync::Mutex::new(Some(cb_tx))),
        shutdown: shutdown_tx.clone(),
    };

    let router = Router::new()
        .route(&callback_path, get(callback_handler))
        .with_state(callback_state);

    // One server task per bound loopback address (IPv4 and, when available,
    // IPv6) so `localhost` resolves to whichever the browser picks. Each parks
    // until the broadcast fires — on callback (success/error) or wait timeout.
    for listener in listeners {
        let router = router.clone();
        let mut shutdown_rx = shutdown_tx.subscribe();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.recv().await;
                })
                .await;
        });
    }

    let flow = Arc::new(PendingFlow {
        rx: Mutex::new(Some(cb_rx)),
        code_verifier,
        token_url: req.token_url,
        client_id: req.client_id,
        redirect_uri,
        client_secret,
        shutdown: shutdown_tx,
    });
    manager.insert(state.clone(), flow);

    // Backstop against a flow that never reaches oauth_wait (the caller throws
    // between begin and wait, or the user closes the sign-in dialog with no
    // cancel). oauth_wait's own timeout only runs while someone is waiting;
    // this reclaims the port + map entry after the same deadline unconditionally.
    let cleanup_app = app.clone();
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(CALLBACK_TIMEOUT).await;
        if let Some(flow) = cleanup_app.state::<OauthManager>().take(&cleanup_state) {
            flow.shutdown_server();
        }
    });

    Ok(OauthBeginResponse {
        url: auth_url,
        state,
    })
}

/// Release an abandoned OAuth flow: take it out of the manager and shut down its
/// loopback listener(s). Idempotent — an unknown or already-consumed `state` is
/// a no-op success, so the frontend can call it unconditionally from a
/// `finally`/abort path when it did not reach `oauth_wait`.
#[tauri::command]
pub fn oauth_cancel(state: String, manager: tauri::State<'_, OauthManager>) -> Result<(), String> {
    if let Some(flow) = manager.take(&state) {
        flow.shutdown_server();
    }
    Ok(())
}

#[tauri::command]
pub async fn oauth_wait(
    state: String,
    manager: tauri::State<'_, OauthManager>,
) -> Result<OauthTokens, String> {
    oauth_wait_inner(state, manager)
        .await
        .map_err(|e| e.to_string())
}

async fn oauth_wait_inner(
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
    // Redirects are disabled (OutboundRedirect::None): a token POST must not be
    // bounced to an attacker host carrying the auth code + verifier.
    validate_oauth_endpoint(&flow.token_url, OauthEndpointKind::Token)?;
    let client = outbound_client_builder(OutboundRedirect::None)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| OauthError::TokenExchange(e.to_string()))?;
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", flow.redirect_uri.as_str()),
    ];
    let mut builder = client
        .post(&flow.token_url)
        .header("Accept", "application/json");
    match flow.client_secret.as_deref() {
        // Confidential client (e.g. Mendeley): authenticate with HTTP Basic.
        // The provider doesn't support PKCE, so no code_verifier is sent.
        Some(secret) => builder = builder.basic_auth(&flow.client_id, Some(secret)),
        None => {
            form.push(("client_id", flow.client_id.as_str()));
            form.push(("code_verifier", flow.code_verifier.as_str()));
        }
    }
    let response = builder
        .form(&form)
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
    fn parse_loopback_redirect_accepts_loopback_with_port() {
        assert_eq!(
            parse_loopback_redirect("http://localhost:5000/callback").unwrap(),
            (5000, "/callback".to_string())
        );
        assert_eq!(
            parse_loopback_redirect("http://127.0.0.1:5000").unwrap(),
            (5000, "/".to_string())
        );
    }

    #[test]
    fn parse_loopback_redirect_rejects_non_loopback_and_missing_port() {
        assert!(parse_loopback_redirect("http://evil.example.com:5000/cb").is_err());
        assert!(parse_loopback_redirect("https://localhost:5000/cb").is_err());
        assert!(parse_loopback_redirect("http://localhost/cb").is_err());
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
