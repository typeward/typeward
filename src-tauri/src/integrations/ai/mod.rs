//! AI provider streaming.
//!
//! Phase 4 ships one generic streaming primitive plus a per-format
//! parser so every provider (Anthropic, OpenAI, Gemini, Ollama) reuses
//! the same backbone. Each provider supplies a method + URL + headers +
//! a body, names its on-the-wire format, and starts a stream — the
//! Rust task takes care of the long-lived HTTP request, byte buffering,
//! line/event splitting, and parsing into the uniform `ChatChunk`
//! shape the frontend consumes via an AsyncIterable.

pub mod streaming;
