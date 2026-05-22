//! Version-control integrations.
//!
//! Phase 3 ships local Git via libgit2 plus a GitHub OAuth surface that
//! piggybacks on the existing keyring + http modules. Overleaf import
//! reuses `git::clone` for users on the premium git bridge and falls
//! back to a zip unpacker (`crate::integrations::overleaf`) for users
//! on the free plan who can only export.

pub mod git;
