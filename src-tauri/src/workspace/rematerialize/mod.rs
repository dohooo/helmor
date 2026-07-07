//! Lazy rematerialization of derived filesystem state (R4-A).
//!
//! Backup boundary invariant: the team-cloud backup only persists
//! source-of-truth state (helmor.db + small config + provider state).
//! Repo source clones and worktrees are DERIVED state — they evaporate
//! across container generations and must be rebuildable from the DB row
//! plus the remote. This module is that rebuild path:
//!
//! - [`ensure_repo_source`]     — re-clone `repos.root_path` from
//!   `repos.remote_url` when the directory is missing (R2-F1).
//! - [`ensure_workspace_materialized`] — rebuild a workspace's worktree
//!   from the repo source (R2-F5).
//!
//! Only WAKE-level entry points call these (workspace create, agent turn).
//! PASSIVE reads (`get_workspace` etc.) never trigger a rebuild.
//!
//! Credentials are injected per-process (`git -c http.extraheader=…`) and
//! NEVER written to any on-disk git config; the resulting `origin` URL is
//! the clean (userinfo-free) `repos.remote_url`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::json;

use crate::error::{coded, ErrorCode};
use crate::git_ops;
use crate::models::workspaces as workspace_models;
use crate::workspace::helpers;
use crate::workspace_state::WorkspaceMode;
use crate::{db, repos};

#[cfg(test)]
mod tests;

/// Ensure the repo's source clone exists at `repos.root_path`, re-cloning
/// from `repos.remote_url` if it's gone. Returns the repo root.
///
/// Blocking (git subprocesses + `blocking_lock`) — call from a blocking
/// context, never directly on an async runtime thread.
pub fn ensure_repo_source(repo_id: &str) -> Result<PathBuf> {
    let repository = repos::load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let root = PathBuf::from(repository.root_path.trim());
    // Fast path: directory present and is a git repo.
    if root.is_dir() && git_ops::ensure_git_repository(&root).is_ok() {
        return Ok(root);
    }

    // Lock ordering: the repo lock is always INNERMOST (acquired under a
    // workspace lock in the worktree-rebuild path, never the other way
    // around) — see `db::repo_fs_mutation_lock`.
    let lock = db::repo_fs_mutation_lock(repo_id);
    let _guard = lock.blocking_lock();
    // Double-check under the lock: a concurrent caller may have re-cloned.
    if root.is_dir() && git_ops::ensure_git_repository(&root).is_ok() {
        return Ok(root);
    }

    let remote_url = load_repo_remote_url(repo_id)?
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| {
            coded(ErrorCode::RepoSourceUnavailable).context(format!(
                "Repository \"{}\" is missing on disk and has no remote URL to re-clone from. \
                 Re-add the repository from Settings.",
                repository.name
            ))
        })?;

    tracing::info!(repo_id, root = %root.display(), "Repo source missing; re-cloning");
    reclone_into(&remote_url, &root).map_err(|error| {
        coded(ErrorCode::RepoSourceUnavailable).context(format!(
            "Repository \"{}\" re-clone failed: {:#}. Check repo access or re-authorize \
             your forge identity in Settings.",
            repository.name,
            redacted_chain(&error),
        ))
    })?;
    Ok(root)
}

/// Ensure the workspace's working directory exists, rebuilding the worktree
/// (and, transitively, the repo source) if it's gone. Returns the path.
///
/// Blocking — same constraints as [`ensure_repo_source`].
pub fn ensure_workspace_materialized(workspace_id: &str) -> Result<PathBuf> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    let path = helpers::workspace_path(&record)?;
    // Fast path.
    if path.is_dir() {
        return Ok(path);
    }

    match record.mode {
        // Chat workspaces are plain directories under the data dir.
        WorkspaceMode::Chat => {
            fs::create_dir_all(&path)
                .with_context(|| format!("Failed to create chat dir {}", path.display()))?;
            Ok(path)
        }
        // Local/NonGit operate directly on the repo source.
        WorkspaceMode::Local | WorkspaceMode::NonGit => ensure_repo_source(&record.repo_id),
        WorkspaceMode::Worktree => {
            // Lock ordering: workspace lock FIRST, repo lock (inside
            // ensure_repo_source) second — fixed single direction.
            let ws_lock = db::workspace_fs_mutation_lock(workspace_id);
            let _guard = ws_lock.blocking_lock();
            if path.is_dir() {
                return Ok(path);
            }
            rebuild_worktree(&record, &path).map_err(|error| {
                if crate::error::extract_code(&error) != ErrorCode::Unknown {
                    return error; // keep RepoSourceUnavailable from the inner ensure
                }
                coded(ErrorCode::WorkspaceRematerializeFailed).context(format!(
                    "Failed to rebuild workspace \"{}\": {:#}. Check repo access or \
                     re-authorize your forge identity in Settings.",
                    helpers::display_title(&record),
                    redacted_chain(&error),
                ))
            })
        }
    }
}

/// `repos.remote_url` for a repo id. Post-R2-F7 this is stored clean
/// (userinfo redacted at write time).
fn load_repo_remote_url(repo_id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    let connection = db::read_conn()?;
    let url: Option<Option<String>> = connection
        .query_row(
            "SELECT remote_url FROM repos WHERE id = ?1",
            [repo_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(url.flatten())
}

fn rebuild_worktree(
    record: &crate::models::workspaces::WorkspaceRecord,
    path: &Path,
) -> Result<PathBuf> {
    let repo_root = ensure_repo_source(&record.repo_id)?;
    let repo_root_arg = repo_root.display().to_string();
    // Old worktree registrations may linger if the repo dir survived while
    // the worktree dir was deleted.
    let _ = git_ops::run_git(["-C", repo_root_arg.as_str(), "worktree", "prune"], None);

    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {} is missing branch", record.id))?;
    let remote_ref = format!("origin/{branch}");
    let path_arg = path.display().to_string();

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Make sure the remote-tracking ref is current if the repo dir survived
    // (a fresh clone already has full refs). Best-effort; offline is fine.
    if !remote_ref_exists(&repo_root, &branch) {
        let _ = fetch_with_auth(&repo_root, "origin");
    }

    if remote_ref_exists(&repo_root, &branch) {
        // Branch was pushed: rebuild tracking the remote. `-B` handles a
        // stale local branch of the same name (reset to the remote tip).
        git_ops::run_git(
            [
                "-C",
                repo_root_arg.as_str(),
                "worktree",
                "add",
                "-B",
                branch.as_str(),
                path_arg.as_str(),
                remote_ref.as_str(),
            ],
            None,
        )
        .with_context(|| format!("Failed to rebuild worktree for branch {branch}"))?;
        return Ok(path.to_path_buf());
    }

    // Branch was never pushed (or was deleted on the remote): rebuild the
    // same-named branch from the repo default branch, and leave an honest
    // trace in the session — unpushed work is not recoverable.
    let default_branch = record
        .default_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "main".to_string());
    let default_remote_ref = format!("origin/{default_branch}");
    let start_point = if remote_ref_exists(&repo_root, &default_branch) {
        default_remote_ref.clone()
    } else {
        default_branch.clone()
    };
    git_ops::run_git(
        [
            "-C",
            repo_root_arg.as_str(),
            "worktree",
            "add",
            "-B",
            branch.as_str(),
            path_arg.as_str(),
            start_point.as_str(),
        ],
        None,
    )
    .with_context(|| {
        format!("Failed to rebuild worktree for branch {branch} from {start_point}")
    })?;
    // Rebuilt from the default branch, not the remote branch — don't track.
    let _ = git_ops::run_git(
        [
            "-C",
            repo_root_arg.as_str(),
            "branch",
            "--unset-upstream",
            branch.as_str(),
        ],
        None,
    );

    let message = format!(
        "Branch {branch} was never pushed; workspace was rebuilt from origin/{default_branch}. \
         Unpushed work is not recoverable."
    );
    tracing::warn!(workspace_id = %record.id, branch, "{message}");
    if let Err(error) = persist_workspace_rebuilt_notice(&record.id, &message) {
        tracing::warn!(workspace_id = %record.id, "Failed to persist workspace_rebuilt notice: {error:#}");
    }
    Ok(path.to_path_buf())
}

fn remote_ref_exists(repo_root: &Path, branch: &str) -> bool {
    git_ops::verify_commitish_exists(
        repo_root,
        &format!("refs/remotes/origin/{branch}"),
        "remote ref missing",
    )
    .is_ok()
}

// ── Re-clone ─────────────────────────────────────────────────────────────

/// Clone `remote_url` into a temp sibling of `root`, then atomically rename
/// into place. Ensures a full-fidelity refspec + remote-tracking refs and a
/// CLEAN origin URL (credentials are process-injected, never persisted).
fn reclone_into(remote_url: &str, root: &Path) -> Result<()> {
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = root.with_file_name(format!(
        "{}.tmp-{}",
        root.file_name().and_then(|n| n.to_str()).unwrap_or("repo"),
        uuid::Uuid::new_v4()
    ));
    let tmp_arg = tmp.display().to_string();

    let result = (|| -> Result<()> {
        let mut args = auth_config_args(remote_url);
        args.extend([
            "clone".to_string(),
            "--".to_string(),
            remote_url.to_string(),
            tmp_arg.clone(),
        ]);
        git_ops::run_git_with_timeout(&args, None, git_ops::GIT_CLONE_TIMEOUT)?;

        // Full-fidelity refspec + fetch so every remote branch has a
        // remote-tracking ref (worktree rebuild resolves origin/<branch>).
        git_ops::run_git(
            [
                "-C",
                tmp_arg.as_str(),
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
            None,
        )?;
        fetch_with_auth(&tmp, "origin")?;

        fs::rename(&tmp, root)
            .with_context(|| format!("Failed to move re-clone into place at {}", root.display()))?;
        Ok(())
    })();

    if result.is_err() && tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result
}

fn fetch_with_auth(repo_dir: &Path, remote: &str) -> Result<()> {
    let dir = repo_dir.display().to_string();
    let remote_url = git_ops::run_git(["-C", dir.as_str(), "remote", "get-url", remote], None)
        .unwrap_or_default();
    let mut args = auth_config_args(&remote_url);
    args.extend([
        "-C".to_string(),
        dir,
        "fetch".to_string(),
        "--prune".to_string(),
        remote.to_string(),
    ]);
    git_ops::run_git_with_timeout(&args, None, git_ops::GIT_NETWORK_TIMEOUT).map(|_| ())
}

// ── Credential injection ─────────────────────────────────────────────────

/// Process-level auth injection for git network commands against `remote_url`.
/// Returns `["-c", "http.extraheader=Authorization: Basic <b64>"]` when the
/// acting team member has a token for the URL's host, `[]` otherwise
/// (desktop mode / public repos / non-https remotes → zero behavior change).
///
/// The token rides only in the child process's argv — it is never written
/// to any git config and never appears in a remote URL.
pub fn auth_config_args(remote_url: &str) -> Vec<String> {
    let Some(host) = https_host(remote_url) else {
        return Vec::new();
    };
    // Basic userinfo matches the forms the Worker uses for its own clones:
    // GitHub `x-access-token:<token>`, GitLab `oauth2:<token>`.
    let userinfo = if let Some(token) = crate::forge::member_creds::acting_github_token(&host) {
        format!("x-access-token:{token}")
    } else if let Some(token) = crate::forge::member_creds::acting_glab_token(&host) {
        format!("oauth2:{token}")
    } else {
        return Vec::new();
    };
    vec![
        "-c".to_string(),
        format!(
            "http.extraheader=Authorization: Basic {}",
            BASE64.encode(userinfo)
        ),
    ]
}

/// Hostname (lowercased, port stripped) of an http(s) URL; `None` for
/// ssh/scp-style or unparsable URLs.
fn https_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split('/').next()?;
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?.trim().to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Format an error chain with any URL userinfo redacted, so git stderr can
/// ride in user-facing messages without ever leaking a credential.
fn redacted_chain(error: &anyhow::Error) -> String {
    repos::redact_url_userinfo(&format!("{error:#}"))
}

// ── Session trace ────────────────────────────────────────────────────────

/// Persist a `workspace_rebuilt` system row into the workspace's active
/// session (rendered as a Warning notice by `pipeline::adapter::labels`).
/// No-op when the workspace has no active session.
fn persist_workspace_rebuilt_notice(workspace_id: &str, message: &str) -> Result<()> {
    let connection = db::write_conn()?;
    let session_id: Option<String> = connection
        .query_row(
            "SELECT active_session_id FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| row.get(0),
        )
        .unwrap_or(None);
    let Some(session_id) = session_id else {
        return Ok(());
    };
    let payload = json!({
        "type": "system",
        "subtype": "workspace_rebuilt",
        "message": message,
    })
    .to_string();
    let now = db::current_timestamp()?;
    connection.execute(
        r#"
            INSERT INTO session_messages (
              id, session_id, role, content, created_at, sent_at
            ) VALUES (?1, ?2, 'system', ?3, ?4, ?4)
        "#,
        rusqlite::params![uuid::Uuid::new_v4().to_string(), session_id, payload, now],
    )?;
    Ok(())
}
