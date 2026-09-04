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
pub mod grammar;
pub mod http;
pub mod ipc;
pub mod oauth;
pub mod overleaf;
pub mod templates;
// libgit2 is a desktop-only dependency (Cargo.toml): git2's `https` feature
// links openssl-sys on non-Apple unix targets, which includes Android. The
// module — and every git IPC command in lib.rs — is gated to match, so mobile
// builds neither link libgit2 nor expose a git command surface.
#[cfg(desktop)]
pub mod vcs;
pub mod webdav;
