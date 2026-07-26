//! Long-lived HTTP streaming for AI providers.
//!
//! One Tauri command (`ai_stream_start`) opens a streaming request and
//! emits parsed `ChatChunk` events to the frontend over a dedicated
//! channel per stream id. A companion command (`ai_stream_abort`)
//! tears down the in-flight task.
//!
//! Frontend builds an AsyncIterable around the event channel; from the
//! caller's perspective the API is `for await (const chunk of
//! aiStream(req))` — same shape across all providers.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::sync::oneshot;

use crate::integrations::http::{
    build_outbound_request, outbound_client_builder, AuthRef, HttpError, OutboundBody,
    OutboundRedirect,
};

const MAX_AI_ERROR_BODY_BYTES: usize = 64 * 1024;
const MAX_STREAM_BUFFER_BYTES: usize = 2 * 1024 * 1024;
const MAX_STREAM_ID_LEN: usize = 80;

/// What flavor of stream encoding the provider speaks. Each variant
/// gets its own line/event parser in [`parse_event`].
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AiStreamFormat {
    /// Anthropic Messages API SSE — `event: <name>\ndata: <json>\n\n`,
    /// content lives under `delta.text` in `content_block_delta` events.
    AnthropicSse,
    /// OpenAI Chat Completions SSE — `data: <json>\n\n`, content under
    /// `choices[0].delta.content`. Terminates with `data: [DONE]`.
    OpenAiSse,
    /// Gemini's `streamGenerateContent` — JSON array streamed as
    /// length-delimited events. We parse each top-level object's
    /// `candidates[0].content.parts[0].text`.
    GeminiSse,
    /// Ollama's `/api/chat` — NDJSON, one object per line, content
    /// under `message.content`, final object carries `done: true`.
    OllamaNdjson,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamRequest {
    /// Caller-generated id used to route chunk events back. Must be
    /// unique among in-flight streams.
    pub stream_id: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body: String,
    pub format: AiStreamFormat,
    #[serde(default)]
    pub auth_ref: Option<AuthRef>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChunkEvent {
    pub stream_id: String,
    /// One of "delta" (text increment), "done" (stream finished), or
    /// "error" (terminal failure — frontend should stop iterating).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Error, Serialize)]
pub enum AiError {
    #[error("invalid method: {0}")]
    InvalidMethod(String),
    #[error("blocked outbound request: {0}")]
    BlockedRequest(String),
    #[error("invalid stream id: {0}")]
    InvalidStreamId(String),
    #[error("stream already running: {0}")]
    DuplicateStream(String),
    #[error("credential lookup failed: {0}")]
    Credential(String),
}

fn ai_error_from_http(e: HttpError) -> AiError {
    match e {
        HttpError::InvalidMethod(m) => AiError::InvalidMethod(m),
        HttpError::Credential(m) => AiError::Credential(m),
        other => AiError::BlockedRequest(other.to_string()),
    }
}

/// How a stream task ended, so the completion arm knows whether to emit a
/// terminal event. An aborted stream stays silent — the consumer tore down
/// first, so emitting into a dead channel is noise.
enum StreamEnd {
    Completed,
    Aborted,
}

/// Active streams keyed by `stream_id`. Drops the sender → the task's
/// `select!` arm fires and the request is aborted. Held by Tauri's
/// `manage`d state so it survives across IPC invocations.
#[derive(Default)]
pub struct AiStreamManager {
    handles: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

/// Shared streaming client, mirroring `integrations::http`'s static client so
/// consecutive chat messages reuse the pooled TLS connection instead of paying
/// a fresh TCP+TLS handshake per stream. The allowlist redirect policy MUST
/// stay installed here — it re-validates every redirect hop (SSRF guard).
fn stream_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        outbound_client_builder(OutboundRedirect::Allowlist)
            .connect_timeout(std::time::Duration::from_secs(10))
            .pool_idle_timeout(Some(std::time::Duration::from_secs(90)))
            // Deliberately no total `.timeout()`: streams are long-lived and a
            // whole-request deadline would kill slow chat completions mid-flight.
            // A per-read (idle) timeout instead bounds the gap BETWEEN chunks, so
            // an allowlisted-but-misbehaving endpoint that completes the TLS
            // handshake then withholds/trickles bytes can't pin the spawned task
            // and pooled connection open indefinitely. reqwest's read_timeout
            // also covers time-to-first-byte, so this must clear a reasoning
            // model's pre-first-token silence (o-series high-effort, a slow local
            // Ollama on CPU) — 300s is generous for that while still bounding a
            // full stall. Providers that emit keep-alive/ping events reset it.
            .read_timeout(std::time::Duration::from_secs(300))
            .build()
            .expect("ai stream client init")
    })
}

#[tauri::command]
pub async fn ai_stream_start(
    req: AiStreamRequest,
    app: AppHandle,
    manager: tauri::State<'_, Arc<AiStreamManager>>,
) -> Result<(), String> {
    ai_stream_start_inner(req, app, manager)
        .await
        .map_err(|e| e.to_string())
}

async fn ai_stream_start_inner(
    req: AiStreamRequest,
    app: AppHandle,
    manager: tauri::State<'_, Arc<AiStreamManager>>,
) -> Result<(), AiError> {
    validate_stream_id(&req.stream_id)?;

    // Routes auth through the shared outbound builder, so keyring resolution
    // and (for OAuth-bundle services) pre-emptive refresh match `http_request`.
    let builder = build_outbound_request(
        stream_client(),
        &req.method,
        &req.url,
        &req.headers,
        req.auth_ref.as_ref(),
        OutboundBody::Text(&req.body),
    )
    .await
    .map_err(ai_error_from_http)?;

    let (abort_tx, abort_rx) = oneshot::channel::<()>();
    {
        let mut handles = manager.handles.lock().expect("ai stream lock");
        if handles.contains_key(&req.stream_id) {
            return Err(AiError::DuplicateStream(req.stream_id));
        }
        handles.insert(req.stream_id.clone(), abort_tx);
    }

    let stream_id = req.stream_id.clone();
    let format = req.format;
    let app_for_task = app.clone();
    let manager_arc: Arc<AiStreamManager> = manager.inner().clone();

    tokio::spawn(async move {
        let outcome = run_stream(builder, abort_rx, format, &stream_id, &app_for_task).await;
        manager_arc
            .handles
            .lock()
            .expect("ai stream lock")
            .remove(&stream_id);

        let final_event = match outcome {
            Ok(StreamEnd::Completed) => Some(ChunkEvent {
                stream_id: stream_id.clone(),
                kind: "done",
                delta: None,
                error: None,
            }),
            Ok(StreamEnd::Aborted) => None,
            Err(err) => Some(ChunkEvent {
                stream_id: stream_id.clone(),
                kind: "error",
                delta: None,
                error: Some(err),
            }),
        };
        if let Some(event) = final_event {
            let _ = app_for_task.emit_to(crate::ipc_guard::MAIN_LABEL, &event_name(&stream_id), event);
        }
    });

    Ok(())
}

/// Tear down an in-flight stream. Idempotent: an unknown id (already finished or
/// torn down) is a no-op success, so a consumer can abort on every generator
/// disposal without racing the task's own completion.
#[tauri::command]
pub fn ai_stream_abort(
    stream_id: String,
    manager: tauri::State<'_, Arc<AiStreamManager>>,
) -> Result<(), String> {
    if let Some(tx) = manager
        .handles
        .lock()
        .expect("ai stream lock")
        .remove(&stream_id)
    {
        // Dropping the sender alone would fire the task's abort arm; the send is
        // the fast path. Either way the `select!` resolves and the request is
        // dropped, aborting the upstream connection.
        let _ = tx.send(());
    }
    Ok(())
}

fn event_name(stream_id: &str) -> String {
    format!("ai-stream:{stream_id}")
}

fn validate_stream_id(stream_id: &str) -> Result<(), AiError> {
    if stream_id.is_empty()
        || stream_id.len() > MAX_STREAM_ID_LEN
        || !stream_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err(AiError::InvalidStreamId(stream_id.to_string()));
    }
    Ok(())
}

/// Pump bytes through the right parser, emit deltas as Tauri events.
/// Returns `Err` on terminal failure; ok on graceful end.
async fn run_stream(
    builder: reqwest::RequestBuilder,
    mut abort_rx: oneshot::Receiver<()>,
    format: AiStreamFormat,
    stream_id: &str,
    app: &AppHandle,
) -> Result<StreamEnd, String> {
    let response = builder
        .send()
        .await
        .map_err(|e| format!("send failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = read_text_capped(response, MAX_AI_ERROR_BODY_BYTES)
            .await
            .unwrap_or_else(|e| format!("failed to read error body: {e}"));
        return Err(format!("status {} body {}", status.as_u16(), body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut carry: Vec<u8> = Vec::new();

    loop {
        tokio::select! {
            _ = &mut abort_rx => return Ok(StreamEnd::Aborted),
            chunk = stream.next() => {
                let chunk = match chunk {
                    Some(Ok(bytes)) => bytes,
                    Some(Err(e)) => return Err(format!("stream read: {e}")),
                    None => {
                        // A leftover carry at EOF is a genuinely truncated
                        // sequence — surface it as a replacement char rather
                        // than dropping it silently.
                        if !carry.is_empty() {
                            buffer.push_str(&String::from_utf8_lossy(&carry));
                        }
                        // Drain remainder of buffer (any final event without trailing newline).
                        let rest = std::mem::take(&mut buffer);
                        for event in extract_remaining(&rest, format) {
                            emit_delta(app, stream_id, &event);
                        }
                        return Ok(StreamEnd::Completed);
                    }
                };
                let text = decode_utf8_chunk(&mut carry, &chunk);
                if buffer.len() + text.len() > MAX_STREAM_BUFFER_BYTES {
                    return Err(format!(
                        "stream event exceeded cap of {MAX_STREAM_BUFFER_BYTES} bytes"
                    ));
                }
                buffer.push_str(&text);
                while let Some(end) = next_event_end(&buffer, format) {
                    let raw = buffer[..end].to_string();
                    buffer.drain(..end);
                    for delta in parse_event(&raw, format) {
                        emit_delta(app, stream_id, &delta);
                    }
                }
            }
        }
    }
}

async fn read_text_capped(mut response: reqwest::Response, cap: usize) -> Result<String, String> {
    if let Some(len) = response.content_length() {
        if len > cap as u64 {
            return Err(format!(
                "response too large: {len} bytes exceeds cap of {cap}"
            ));
        }
    }
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > cap {
            return Err(format!("response exceeded cap of {cap} bytes"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn emit_delta(app: &AppHandle, stream_id: &str, delta: &str) {
    let payload = ChunkEvent {
        stream_id: stream_id.to_string(),
        kind: "delta",
        delta: Some(delta.to_string()),
        error: None,
    };
    let _ = app.emit_to(crate::ipc_guard::MAIN_LABEL, &event_name(stream_id), payload);
}

/// Decode a raw transport chunk whose boundaries need not align with
/// UTF-8 character boundaries (TCP segments split multi-byte characters
/// routinely). An incomplete trailing sequence (at most 3 bytes) is
/// stashed in `carry` and prepended to the next chunk; only genuinely
/// invalid bytes become U+FFFD — surrounding valid data is never dropped.
fn decode_utf8_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    let joined: Vec<u8>;
    let mut rest: &[u8] = if carry.is_empty() {
        chunk
    } else {
        let mut bytes = std::mem::take(carry);
        bytes.extend_from_slice(chunk);
        joined = bytes;
        &joined
    };
    let mut out = String::new();
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                out.push_str(s);
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                // The prefix up to `valid_up_to` is proven valid; re-check
                // instead of reaching for `from_utf8_unchecked`.
                out.push_str(std::str::from_utf8(&rest[..valid]).expect("valid utf-8 prefix"));
                match e.error_len() {
                    Some(n) => {
                        out.push('\u{FFFD}');
                        rest = &rest[valid + n..];
                    }
                    None => {
                        carry.extend_from_slice(&rest[valid..]);
                        break;
                    }
                }
            }
        }
    }
    out
}

/// Returns the byte index past the end of the next complete event in
/// `buf`, or `None` if no full event is buffered yet.
fn next_event_end(buf: &str, format: AiStreamFormat) -> Option<usize> {
    match format {
        AiStreamFormat::AnthropicSse | AiStreamFormat::OpenAiSse | AiStreamFormat::GeminiSse => {
            buf.find("\n\n").map(|i| i + 2)
        }
        AiStreamFormat::OllamaNdjson => buf.find('\n').map(|i| i + 1),
    }
}

/// Pull one or more text deltas out of a single buffered event. Returns
/// an empty Vec for keepalives / control events the caller doesn't
/// surface.
fn parse_event(raw: &str, format: AiStreamFormat) -> Vec<String> {
    match format {
        AiStreamFormat::AnthropicSse => parse_anthropic(raw),
        AiStreamFormat::OpenAiSse => parse_openai(raw),
        AiStreamFormat::GeminiSse => parse_gemini(raw),
        AiStreamFormat::OllamaNdjson => parse_ollama(raw),
    }
}

fn extract_remaining(raw: &str, format: AiStreamFormat) -> Vec<String> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    parse_event(raw, format)
}

fn parse_anthropic(raw: &str) -> Vec<String> {
    // Anthropic SSE: `event: <name>\ndata: <json>\n`. We care about
    // `content_block_delta` events whose payload has `delta.text`.
    let mut data = String::new();
    let mut event_kind: Option<&str> = None;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("event: ") {
            event_kind = Some(rest.trim());
        } else if let Some(rest) = line.strip_prefix("data: ") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest);
        }
    }
    if event_kind != Some("content_block_delta") {
        return Vec::new();
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&data) else {
        return Vec::new();
    };
    payload
        .pointer("/delta/text")
        .and_then(|v| v.as_str())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

fn parse_openai(raw: &str) -> Vec<String> {
    let mut deltas = Vec::new();
    for line in raw.lines() {
        let Some(rest) = line.strip_prefix("data: ") else {
            continue;
        };
        let rest = rest.trim();
        if rest == "[DONE]" {
            return deltas;
        }
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(rest) else {
            continue;
        };
        if let Some(text) = payload
            .pointer("/choices/0/delta/content")
            .and_then(|v| v.as_str())
        {
            deltas.push(text.to_string());
        }
    }
    deltas
}

fn parse_gemini(raw: &str) -> Vec<String> {
    // Gemini's stream is JSON objects separated by blank lines (some
    // proxies add `data:` prefixes, some don't). Strip the prefix when
    // present and parse the remainder as JSON.
    let cleaned = raw
        .lines()
        .map(|line| line.strip_prefix("data: ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = cleaned.trim().trim_start_matches(',').trim();
    let trimmed = trimmed.trim_start_matches('[').trim_end_matches(']');
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return Vec::new();
    };
    payload
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(|v| v.as_str())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

fn parse_ollama(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return Vec::new();
    };
    payload
        .pointer("/message/content")
        .and_then(|v| v.as_str())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_parser_extracts_text_delta() {
        let event = "event: content_block_delta\ndata: {\"delta\":{\"text\":\"Hello\"}}\n";
        assert_eq!(parse_anthropic(event), vec!["Hello".to_string()]);
    }

    #[test]
    fn anthropic_parser_ignores_unrelated_events() {
        let event = "event: message_start\ndata: {\"id\":\"x\"}\n";
        assert!(parse_anthropic(event).is_empty());
    }

    #[test]
    fn openai_parser_collects_choice_delta() {
        let event = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n";
        assert_eq!(parse_openai(event), vec!["hi".to_string()]);
    }

    #[test]
    fn openai_parser_handles_done_marker() {
        let event = "data: [DONE]\n";
        assert!(parse_openai(event).is_empty());
    }

    #[test]
    fn ollama_parser_returns_message_content() {
        let line = "{\"message\":{\"content\":\"yo\"},\"done\":false}";
        assert_eq!(parse_ollama(line), vec!["yo".to_string()]);
    }

    #[test]
    fn next_event_end_finds_double_newline_for_sse() {
        assert_eq!(
            next_event_end("event: x\ndata: y\n\nleftover", AiStreamFormat::OpenAiSse),
            Some(18),
        );
    }

    #[test]
    fn next_event_end_finds_single_newline_for_ndjson() {
        assert_eq!(
            next_event_end("{\"a\":1}\n{\"b\":2}", AiStreamFormat::OllamaNdjson),
            Some(8),
        );
    }

    #[test]
    fn stream_id_validation_allows_stable_ascii_ids() {
        assert!(validate_stream_id("chat_123-abc").is_ok());
    }

    #[test]
    fn stream_id_validation_rejects_event_name_metacharacters() {
        assert!(validate_stream_id("").is_err());
        assert!(validate_stream_id("chat:123").is_err());
        assert!(validate_stream_id("chat/123").is_err());
    }

    #[test]
    fn utf8_decode_carries_split_two_byte_char_across_chunks() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_chunk(&mut carry, b"ab\xC5"), "ab");
        assert_eq!(carry, [0xC5]);
        assert_eq!(decode_utf8_chunk(&mut carry, b"\x99cd"), "\u{159}cd");
        assert!(carry.is_empty());
    }

    #[test]
    fn utf8_decode_carries_split_four_byte_char_across_chunks() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_chunk(&mut carry, b"\xF0\x9F"), "");
        assert_eq!(carry, [0xF0, 0x9F]);
        assert_eq!(decode_utf8_chunk(&mut carry, b"\x98\x80!"), "\u{1F600}!");
        assert!(carry.is_empty());
    }

    #[test]
    fn utf8_decode_replaces_invalid_byte_without_dropping_neighbors() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_chunk(&mut carry, b"ok\xFFgo"), "ok\u{FFFD}go");
        assert!(carry.is_empty());
    }

    #[test]
    fn utf8_decode_flags_orphaned_lead_byte_as_replacement() {
        let mut carry = vec![0xC5];
        assert_eq!(decode_utf8_chunk(&mut carry, b"abc"), "\u{FFFD}abc");
        assert!(carry.is_empty());
    }

    #[test]
    fn utf8_decode_keeps_incomplete_tail_out_of_output() {
        let mut carry = Vec::new();
        assert_eq!(
            decode_utf8_chunk(&mut carry, b"data: {\"x\":\"\xE2\x9C"),
            "data: {\"x\":\"",
        );
        assert_eq!(carry, [0xE2, 0x9C]);
    }

    #[test]
    fn http_error_maps_to_matching_ai_error() {
        assert!(matches!(
            ai_error_from_http(HttpError::InvalidMethod("BOGUS".into())),
            AiError::InvalidMethod(_)
        ));
        assert!(matches!(
            ai_error_from_http(HttpError::Credential("nope".into())),
            AiError::Credential(_)
        ));
        assert!(matches!(
            ai_error_from_http(HttpError::BlockedUrl("https://evil.test".into())),
            AiError::BlockedRequest(_)
        ));
    }
}
