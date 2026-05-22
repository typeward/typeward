//! Foundation for third-party integrations (Phase 0).
//!
//! Each sub-module owns one concern:
//!   - [`credentials`] — OS keyring round-trip for OAuth tokens / API keys.
//!     Nothing else in the codebase is allowed to persist secrets to disk;
//!     plain `settings.json` only holds account identifiers.
//!   - [`http`] — shared `reqwest` client with rate-limited, retry-aware
//!     outbound requests. Funnelling all network traffic through one place
//!     lets us add 401-refresh, logging, and offline detection in one spot.
//!   - [`oauth`] — PKCE state machine + a single-shot `axum` callback server
//!     bound to a random loopback port. Browser launch goes through
//!     `tauri-plugin-opener`.
//!
//! Frontend never touches secrets directly; it calls the IPC handlers
//! exported here.

pub mod ai;
pub mod credentials;
pub mod http;
pub mod oauth;
pub mod overleaf;
pub mod vcs;
