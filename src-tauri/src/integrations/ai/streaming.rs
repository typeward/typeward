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
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tokio::sync::oneshot;

use crate::integrations::credentials;
use crate::integrations::http::{validate_outbound_request, AuthRef};

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
    #[error("network error: {0}")]
    Network(String),
    #[error("credential lookup failed: {0}")]
    Credential(String),
    #[error("unknown stream id: {0}")]
    UnknownStream(String),
}

/// Active streams keyed by `stream_id`. Drops the sender → the task's
/// `select!` arm fires and the request is aborted. Held by Tauri's
/// `manage`d state so it survives across IPC invocations.
#[derive(Default)]
pub struct AiStreamManager {
    handles: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[tauri::command]
pub async fn ai_stream_start(
    req: AiStreamRequest,
    app: AppHandle,
    manager: tauri::State<'_, Arc<AiStreamManager>>,
) -> Result<(), AiError> {
    let method = req
        .method
        .parse::<reqwest::Method>()
        .map_err(|_| AiError::InvalidMethod(req.method.clone()))?;
    validate_outbound_request(&req.url, &req.headers, req.auth_ref.as_ref())
        .map_err(|e| AiError::BlockedRequest(e.to_string()))?;

    let client = reqwest::Client::builder()
        .user_agent(concat!("Typeward/", env!("CARGO_PKG_VERSION")))
        .redirect(crate::integrations::http::allowlist_redirect_policy())
        .build()
        .map_err(|e| AiError::Network(e.to_string()))?;

    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    if let Some(auth) = &req.auth_ref {
        let secret = tokio::task::spawn_blocking({
            let service = auth.service.clone();
            let account = auth.account.clone();
            move || credentials::get_secret(&service, &account)
        })
        .await
        .map_err(|e| AiError::Credential(e.to_string()))?
        .map_err(|e| AiError::Credential(e.to_string()))?;
        if let Some(secret) = secret {
            builder = builder.header(&auth.header, format!("{}{}", auth.prefix, secret));
        }
    }
    builder = builder.body(req.body.clone());

    let (abort_tx, abort_rx) = oneshot::channel::<()>();
    manager
        .handles
        .lock()
        .expect("ai stream lock")
        .insert(req.stream_id.clone(), abort_tx);

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
            Ok(()) => ChunkEvent {
                stream_id: stream_id.clone(),
                kind: "done",
                delta: None,
                error: None,
            },
            Err(err) => ChunkEvent {
                stream_id: stream_id.clone(),
                kind: "error",
                delta: None,
                error: Some(err),
            },
        };
        let _ = app_for_task.emit(&event_name(&stream_id), final_event);
    });

    Ok(())
}

#[tauri::command]
pub fn ai_stream_abort(
    stream_id: String,
    manager: tauri::State<'_, Arc<AiStreamManager>>,
) -> Result<(), AiError> {
    if let Some(tx) = manager
        .handles
        .lock()
        .expect("ai stream lock")
        .remove(&stream_id)
    {
        let _ = tx.send(());
        Ok(())
    } else {
        Err(AiError::UnknownStream(stream_id))
    }
}

fn event_name(stream_id: &str) -> String {
    format!("ai-stream:{stream_id}")
}

/// Pump bytes through the right parser, emit deltas as Tauri events.
/// Returns `Err` on terminal failure; ok on graceful end.
async fn run_stream(
    builder: reqwest::RequestBuilder,
    mut abort_rx: oneshot::Receiver<()>,
    format: AiStreamFormat,
    stream_id: &str,
    app: &AppHandle,
) -> Result<(), String> {
    let response = builder
        .send()
        .await
        .map_err(|e| format!("send failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("status {} body {}", status.as_u16(), body));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    loop {
        tokio::select! {
            _ = &mut abort_rx => return Ok(()),
            chunk = stream.next() => {
                let chunk = match chunk {
                    Some(Ok(bytes)) => bytes,
                    Some(Err(e)) => return Err(format!("stream read: {e}")),
                    None => {
                        // Drain remainder of buffer (any final event without trailing newline).
                        let rest = std::mem::take(&mut buffer);
                        for event in extract_remaining(&rest, format) {
                            emit_delta(app, stream_id, &event);
                        }
                        return Ok(());
                    }
                };
                if let Ok(text) = std::str::from_utf8(&chunk) {
                    buffer.push_str(text);
                }
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

fn emit_delta(app: &AppHandle, stream_id: &str, delta: &str) {
    let payload = ChunkEvent {
        stream_id: stream_id.to_string(),
        kind: "delta",
        delta: Some(delta.to_string()),
        error: None,
    };
    let _ = app.emit(&event_name(stream_id), payload);
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
}
