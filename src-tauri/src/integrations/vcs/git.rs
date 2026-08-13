//! Local git via libgit2 (the `git2` crate).
//!
//! libgit2 is fully synchronous; every operation here runs inside
//! `tokio::task::spawn_blocking` so we don't park the tokio runtime
//! during long fetches or pushes. HTTPS credentials come from the
//! user's own git setup: the configured `credential.helper` (Git
//! Credential Manager on Windows, osxkeychain on macOS, etc.) resolved
//! via `Cred::credential_helper`. Commit identity likewise comes from
//! `user.name`/`user.email` in the user's gitconfig — the app stores
//! no git identity or credentials of its own.
//!
//! SSH transport is intentionally out of scope for Phase 3: keypair
//! management is a separate surface (agent forwarding, host
//! verification, sometimes hardware keys) that we don't need yet for
//! the integration-driven workflows we're after.

use std::path::{Path, PathBuf};

use git2::{
    BranchType, Config, Cred, CredentialType, ErrorCode, FetchOptions, IndexAddOption,
    PushOptions, RemoteCallbacks, Repository, Signature, Sort, StatusOptions,
};
use serde::Serialize;
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum GitError {
    #[error("repository at {0} could not be opened")]
    OpenFailed(String),
    #[error("git error: {0}")]
    Git(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("background task failed: {0}")]
    Join(String),
    #[error("no git identity configured — set user.name and user.email in your git config")]
    NoSignature,
    #[error("working tree has uncommitted changes; commit or stash before pulling")]
    DirtyWorktree,
}

impl From<git2::Error> for GitError {
    fn from(value: git2::Error) -> Self {
        Self::Git(value.message().to_string())
    }
}

impl From<std::io::Error> for GitError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

// ----- Wire types --------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    /// "added" | "modified" | "deleted" | "renamed" | "typechange" | "none".
    pub staged: &'static str,
    pub unstaged: &'static str,
    /// `true` if `unstaged` is `"none"` and `staged` is also `"none"` (file is
    /// not tracked in HEAD); used by the UI to render the "U" badge.
    pub untracked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub oid: String,
    pub short_oid: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// Unix epoch seconds.
    pub timestamp: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSummary {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub files: Vec<GitFileStatus>,
}

// ----- Helpers -----------------------------------------------------------

fn open_repo(path: &Path) -> Result<Repository, GitError> {
    let repo = Repository::open(path)
        .map_err(|_| GitError::OpenFailed(path.to_string_lossy().into_owned()))?;
    // Any git operation on a repo is also our chance to guarantee the sidecar
    // is excluded — covers repos opened/initialized outside Typeward too.
    crate::project::ensure_sidecar_git_excluded(path);
    Ok(repo)
}

/// Git-relative path check: is this path inside Typeward's `.typeward/` sidecar?
/// Matches the first path segment case-insensitively, mirroring the cloud
/// engine's `normalizeRemoteRelPath` guard. Used to keep snapshots / build
/// output / review comments / project.json out of status, the clean-worktree
/// check, and stage-all.
fn is_sidecar_path(rel: &str) -> bool {
    rel.replace('\\', "/")
        .split('/')
        .next()
        .map(|seg| seg.eq_ignore_ascii_case(".typeward"))
        .unwrap_or(false)
}

/// Existing-repo operations: the repo must be a project the user opened.
/// Webview XSS == arbitrary IPC, so a bare "absolute path" check would let a
/// compromised renderer run git against any repo on disk. Routes through the
/// canonical `project::require_registered_root` gate.
fn validate_repo_path(repo_path: &str) -> Result<PathBuf, GitError> {
    let path = PathBuf::from(repo_path);
    if !path.is_absolute() {
        return Err(GitError::InvalidPath(repo_path.to_string()));
    }
    crate::project::require_registered_root(&path)
        .map_err(|_| GitError::InvalidPath(repo_path.to_string()))?;
    Ok(path)
}

/// Clone / init destinations don't exist as projects yet, so accept either an
/// already-opened root or a brand-new path under the configured projects root.
/// This stops `git_clone` / `git_init` from writing a repo anywhere on disk.
fn validate_new_repo_path(repo_path: &str) -> Result<PathBuf, GitError> {
    let path = PathBuf::from(repo_path);
    if !path.is_absolute() {
        return Err(GitError::InvalidPath(repo_path.to_string()));
    }
    crate::project::require_new_or_registered_root(&path)
        .map_err(|_| GitError::InvalidPath(repo_path.to_string()))?;
    Ok(path)
}

fn classify(status: git2::Status) -> (&'static str, &'static str, bool) {
    let untracked =
        status.contains(git2::Status::WT_NEW) && !status.contains(git2::Status::INDEX_NEW);

    let staged = if status.contains(git2::Status::INDEX_NEW) {
        "added"
    } else if status.contains(git2::Status::INDEX_MODIFIED) {
        "modified"
    } else if status.contains(git2::Status::INDEX_DELETED) {
        "deleted"
    } else if status.contains(git2::Status::INDEX_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::INDEX_TYPECHANGE) {
        "typechange"
    } else {
        "none"
    };

    let unstaged = if status.contains(git2::Status::WT_NEW) {
        "added"
    } else if status.contains(git2::Status::WT_MODIFIED) {
        "modified"
    } else if status.contains(git2::Status::WT_DELETED) {
        "deleted"
    } else if status.contains(git2::Status::WT_RENAMED) {
        "renamed"
    } else if status.contains(git2::Status::WT_TYPECHANGE) {
        "typechange"
    } else {
        "none"
    };

    (staged, unstaged, untracked)
}

/// Commit identity comes from the repo / global gitconfig
/// (`user.name` + `user.email`) — the app never supplies one.
fn signature(repo: &Repository) -> Result<Signature<'_>, GitError> {
    repo.signature().map_err(|_| GitError::NoSignature)
}

fn ensure_clean_worktree(repo: &Repository) -> Result<(), GitError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let dirty = statuses.iter().any(|entry| {
        if entry.status() == git2::Status::CURRENT {
            return false;
        }
        // Typeward's own sidecar must never block a pull.
        !entry.path().map(is_sidecar_path).unwrap_or(false)
    });
    if dirty {
        return Err(GitError::DirtyWorktree);
    }
    Ok(())
}

fn branch_ahead_behind(
    repo: &Repository,
    local: &git2::Branch,
) -> Result<(Option<String>, usize, usize), GitError> {
    let upstream = match local.upstream() {
        Ok(u) => u,
        Err(e) if e.code() == ErrorCode::NotFound => return Ok((None, 0, 0)),
        Err(e) => return Err(e.into()),
    };
    let upstream_name = upstream.name().ok().flatten().map(|s| s.to_string());

    let local_oid = local.get().target().unwrap_or_else(git2::Oid::zero);
    let upstream_oid = upstream.get().target().unwrap_or_else(git2::Oid::zero);
    let (ahead, behind) = repo.graph_ahead_behind(local_oid, upstream_oid)?;
    Ok((upstream_name, ahead, behind))
}

fn host_of(remote_url: &str) -> Option<String> {
    Url::parse(remote_url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
}

fn validate_remote_url(remote_url: &str) -> Result<(), GitError> {
    // Static message on purpose: the URL may embed a token (the documented
    // credential fallback), and error strings reach toasts and the console.
    let parsed = Url::parse(remote_url).map_err(|_| {
        GitError::InvalidPath(
            "remote URL could not be parsed — use an https:// URL (scp-style user@host:path \
             remotes are not supported)"
                .into(),
        )
    })?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(GitError::InvalidPath(
            "only HTTPS git remotes are supported".into(),
        ));
    }
    Ok(())
}

fn build_callbacks(remote_url: String) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    let host = host_of(&remote_url);
    // libgit2 re-invokes the callback after a rejected attempt; the helper
    // would hand back the same credentials forever, so cap the retries.
    let mut attempts = 0u32;
    cb.credentials(move |url, username_from_url, allowed| {
        if !allowed.intersects(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::from_str(
                "only HTTPS user/password credentials are supported",
            ));
        }
        let host = host
            .clone()
            .ok_or_else(|| git2::Error::from_str("could not parse host from remote URL"))?;
        // Only authenticate against the host we validated up front. A
        // repository's `.git/config` is attacker-controlled content (cloned
        // repo, imported Overleaf zip), and libgit2 connects to `pushurl`
        // when one is set — so a config naming a benign `url` and a hostile
        // `pushurl` would otherwise coax the user's credential helper into
        // handing that host the credentials stored for the benign one.
        match host_of(url) {
            Some(actual) if actual == host => {}
            _ => {
                return Err(git2::Error::from_str(&format!(
                    "refusing to send credentials for {host} to a different host ({url})"
                )));
            }
        }
        attempts += 1;
        if attempts > 3 {
            return Err(git2::Error::from_str(&format!(
                "authentication failed for {host} — check the credentials in your git credential helper"
            )));
        }
        // The user's own git setup is the only credential source: whatever
        // `credential.helper` their gitconfig names (Git Credential Manager,
        // osxkeychain, store, …). GCM can even prompt interactively.
        //
        // open_default() reads ONLY the trusted global/XDG/system gitconfig —
        // never the repo-local `.git/config`, which is attacker-controlled for
        // cloned/imported projects (same threat as the pushurl check above).
        // git2 EXECUTES `credential.helper` values (`!cmd` via `sh -c`,
        // absolute paths spawned directly), so switching to `repo.config()`
        // to honor repo-specific helpers would hand project content arbitrary
        // code execution. Don't.
        let config = Config::open_default()
            .map_err(|e| git2::Error::from_str(&format!("could not open git config: {e}")))?;
        Cred::credential_helper(&config, url, username_from_url).map_err(|_| {
            git2::Error::from_str(&format!(
                "no credentials for {host} — configure a git credential helper (e.g. Git \
                 Credential Manager) or embed a token in the remote URL"
            ))
        })
    });
    cb
}

// ----- IPC commands ------------------------------------------------------

#[tauri::command]
pub async fn git_init(repo_path: String, bare: Option<bool>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_new_repo_path(&repo_path)?;
        std::fs::create_dir_all(&path)?;
        if bare.unwrap_or(false) {
            Repository::init_bare(&path)?;
        } else {
            Repository::init(&path)?;
        }
        crate::project::ensure_sidecar_git_excluded(&path);
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatusSummary, String> {
    tokio::task::spawn_blocking(move || -> Result<GitStatusSummary, GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;

        let mut opts = StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts))?;

        let mut files = Vec::with_capacity(statuses.len());
        for entry in statuses.iter() {
            let rel = entry.path().unwrap_or("").to_string();
            if rel.is_empty() || is_sidecar_path(&rel) {
                continue;
            }
            let (staged, unstaged, untracked) = classify(entry.status());
            files.push(GitFileStatus {
                path: rel,
                staged,
                unstaged,
                untracked,
            });
        }

        let head = repo.head().ok();
        let branch = head
            .as_ref()
            .and_then(|h| h.shorthand().map(|s| s.to_string()));

        let (upstream, ahead, behind) = if let Some(h) = head.as_ref() {
            if let Some(name) = h.shorthand() {
                match repo.find_branch(name, BranchType::Local) {
                    Ok(b) => branch_ahead_behind(&repo, &b)?,
                    Err(_) => (None, 0, 0),
                }
            } else {
                (None, 0, 0)
            }
        } else {
            (None, 0, 0)
        };

        Ok(GitStatusSummary {
            branch,
            upstream,
            ahead,
            behind,
            files,
        })
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_stage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let mut index = repo.index()?;
        // Never stage the sidecar, even when the caller passes an explicit path
        // or the empty-paths stage-all default sweeps the whole tree.
        let mut skip_sidecar = |path: &Path, _matched: &[u8]| -> i32 {
            i32::from(is_sidecar_path(&path.to_string_lossy()))
        };
        if paths.is_empty() {
            index.add_all(
                ["*"].iter(),
                IndexAddOption::DEFAULT,
                Some(&mut skip_sidecar),
            )?;
        } else {
            index.add_all(
                paths.iter(),
                IndexAddOption::DEFAULT,
                Some(&mut skip_sidecar),
            )?;
        }
        index.write()?;
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let head_commit = match repo.head() {
            Ok(r) => Some(r.peel_to_commit()?),
            Err(e) if e.code() == ErrorCode::UnbornBranch => None,
            Err(e) => return Err(e.into()),
        };
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        if let Some(commit) = head_commit {
            repo.reset_default(Some(commit.as_object()), refs)?;
        } else {
            // Pre-first-commit: removing from the index drops the entry.
            let mut index = repo.index()?;
            for p in &paths {
                index.remove_path(Path::new(p)).ok();
            }
            index.write()?;
        }
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let sig = signature(&repo)?;
        let mut index = repo.index()?;
        let tree_oid = index.write_tree()?;
        let tree = repo.find_tree(tree_oid)?;
        let parents: Vec<git2::Commit> = match repo.head() {
            Ok(h) => vec![h.peel_to_commit()?],
            Err(e) if e.code() == ErrorCode::UnbornBranch => vec![],
            Err(e) => return Err(e.into()),
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        let oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)?;
        Ok(oid.to_string())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_log(repo_path: String, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let cap = limit.unwrap_or(50).min(500);
    tokio::task::spawn_blocking(move || -> Result<Vec<GitCommit>, GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let mut walk = repo.revwalk()?;
        walk.set_sorting(Sort::TIME)?;
        walk.push_head().ok();
        let mut out = Vec::with_capacity(cap);
        for oid in walk.take(cap) {
            let oid = oid?;
            let commit = repo.find_commit(oid)?;
            let author = commit.author();
            out.push(GitCommit {
                oid: oid.to_string(),
                short_oid: oid.to_string().chars().take(7).collect(),
                message: commit.summary().unwrap_or("").to_string(),
                author_name: author.name().unwrap_or("").to_string(),
                author_email: author.email().unwrap_or("").to_string(),
                timestamp: commit.time().seconds(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branch_list(repo_path: String) -> Result<Vec<GitBranch>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<GitBranch>, GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let head_name = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()));

        let mut out = Vec::new();
        for entry in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = entry?;
            let name = match branch.name()? {
                Some(n) => n.to_string(),
                None => continue,
            };
            let (upstream, ahead, behind) = branch_ahead_behind(&repo, &branch)?;
            out.push(GitBranch {
                is_head: Some(name.clone()) == head_name,
                name,
                upstream,
                ahead,
                behind,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branch_create(
    repo_path: String,
    name: String,
    checkout: Option<bool>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let head = repo.head()?.peel_to_commit()?;
        repo.branch(&name, &head, false)?;
        if checkout.unwrap_or(false) {
            checkout_branch(&repo, &name)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_branch_checkout(repo_path: String, name: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        checkout_branch(&repo, &name)
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

fn checkout_branch(repo: &Repository, name: &str) -> Result<(), GitError> {
    let refname = format!("refs/heads/{name}");
    let obj = repo.revparse_single(&refname)?;
    repo.checkout_tree(&obj, None)?;
    repo.set_head(&refname)?;
    Ok(())
}

#[tauri::command]
pub async fn git_fetch(repo_path: String, remote: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let remote_name = remote.unwrap_or_else(|| "origin".to_string());
        let mut remote = repo.find_remote(&remote_name)?;
        let url = remote.url().unwrap_or("").to_string();
        validate_remote_url(&url)?;
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(build_callbacks(url));
        remote.fetch::<&str>(&[], Some(&mut fetch_opts), None)?;
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_pull(
    repo_path: String,
    remote: Option<String>,
) -> Result<(), String> {
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let mut remote = repo.find_remote(&remote_name)?;
        let url = remote.url().unwrap_or("").to_string();
        validate_remote_url(&url)?;

        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(build_callbacks(url));
        remote.fetch::<&str>(&[], Some(&mut fetch_opts), None)?;

        // Fast-forward only — merge commits are a deeper UX (conflict
        // resolution surface, message editor) we defer to Phase 3.5 or
        // later. If the local branch can't fast-forward, surface the
        // git error verbatim so the user knows to fetch + merge by hand.
        let fetch_head = repo.find_reference("FETCH_HEAD")?;
        let fetch_commit = repo.reference_to_annotated_commit(&fetch_head)?;
        let analysis = repo.merge_analysis(&[&fetch_commit])?;
        if analysis.0.is_up_to_date() {
            return Ok(());
        }
        if analysis.0.is_fast_forward() {
            ensure_clean_worktree(&repo)?;
            let refname = format!("refs/heads/{}", repo.head()?.shorthand().unwrap_or("main"));
            let mut reference = repo.find_reference(&refname)?;
            reference.set_target(fetch_commit.id(), "fast-forward")?;
            repo.set_head(&refname)?;
            let mut checkout = git2::build::CheckoutBuilder::new();
            checkout.safe();
            repo.checkout_head(Some(&mut checkout))?;
            return Ok(());
        }
        Err(GitError::Git(
            "pull requires a merge; only fast-forward is supported in Phase 3".into(),
        ))
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let path = validate_repo_path(&repo_path)?;
        let repo = open_repo(&path)?;
        let branch_name = match branch {
            Some(b) => b,
            None => repo
                .head()?
                .shorthand()
                .ok_or_else(|| GitError::Git("HEAD has no shorthand".into()))?
                .to_string(),
        };
        let mut remote = repo.find_remote(&remote_name)?;
        // The PUSH url, not the fetch url: libgit2 pushes to `pushurl` when
        // `.git/config` sets one, so validating (and binding credentials to)
        // `remote.url()` would check a destination this push never contacts.
        let url = remote
            .pushurl()
            .or_else(|| remote.url())
            .unwrap_or("")
            .to_string();
        validate_remote_url(&url)?;
        let refspec = format!("refs/heads/{branch_name}:refs/heads/{branch_name}");
        let mut push_opts = PushOptions::new();
        push_opts.remote_callbacks(build_callbacks(url));
        remote.push(&[refspec.as_str()], Some(&mut push_opts))?;
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_clone(url: String, dest_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), GitError> {
        let dest = validate_new_repo_path(&dest_path)?;
        if dest.exists() {
            return Err(GitError::InvalidPath(format!(
                "destination already exists: {}",
                dest.to_string_lossy()
            )));
        }
        std::fs::create_dir_all(dest.parent().unwrap_or(Path::new("/")))?;
        validate_remote_url(&url)?;
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(build_callbacks(url.clone()));
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_opts);
        builder.clone(&url, &dest)?;
        crate::project::ensure_sidecar_git_excluded(&dest);
        Ok(())
    })
    .await
    .map_err(|e| GitError::Join(e.to_string()))
    .and_then(|r| r)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_url_validation_accepts_https() {
        assert!(validate_remote_url("https://github.com/typeward/app.git").is_ok());
    }

    #[test]
    fn remote_url_validation_rejects_file_and_ssh() {
        assert!(validate_remote_url("file:///tmp/repo.git").is_err());
        assert!(validate_remote_url("git@github.com:typeward/app.git").is_err());
        assert!(validate_remote_url("ssh://git@github.com/typeward/app.git").is_err());
    }
}
