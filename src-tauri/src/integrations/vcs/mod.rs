//! Version-control integrations.
//!
//! Local Git via libgit2, riding entirely on the user's own git setup
//! (gitconfig identity, credential helper) — the app manages no git
//! configuration of its own. Overleaf import reuses `git::clone` for
//! users on the premium git bridge and falls back to a zip unpacker
//! (`crate::integrations::overleaf`) for users on the free plan who
//! can only export.

pub mod git;
