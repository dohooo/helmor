use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{git_ops, helpers};

use super::db;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCreateOption {
    pub id: String,
    pub name: String,
    pub remote: Option<String>,
    pub default_branch: Option<String>,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryDefaults {
    pub last_clone_directory: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryResponse {
    pub repository_id: String,
    pub created_repository: bool,
    pub selected_workspace_id: String,
    pub created_workspace_id: Option<String>,
    pub created_workspace_state: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedRepositoryInput {
    pub name: String,
    pub normalized_root_path: String,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    pub default_branch: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RepositoryRecord {
    pub id: String,
    pub name: String,
    pub remote: Option<String>,
    pub default_branch: Option<String>,
    pub root_path: String,
    pub setup_script: Option<String>,
}

pub fn list_repositories() -> Result<Vec<RepositoryCreateOption>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              id,
              name,
              default_branch,
              root_path,
              remote
            FROM repos
            WHERE COALESCE(hidden, 0) = 0
            ORDER BY COALESCE(display_order, 0) ASC, LOWER(name) ASC
            "#,
        )
        .context("Failed to prepare repository list query")?;

    let rows = statement
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let root_path: Option<String> = row.get(3)?;
            let initials = helpers::repo_initials_for_name(&name);
            let icon_src = helpers::repo_icon_src_for_root_path(root_path.as_deref());

            Ok(RepositoryCreateOption {
                id: row.get(0)?,
                name,
                remote: row.get(4)?,
                default_branch: row.get(2)?,
                repo_icon_src: icon_src,
                repo_initials: initials,
            })
        })
        .context("Failed to load repositories")?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("Failed to deserialize repositories")
}

pub(crate) fn load_repository_by_id(repo_id: &str) -> Result<Option<RepositoryRecord>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, remote, default_branch, root_path, setup_script
            FROM repos
            WHERE id = ?1
            "#,
        )
        .with_context(|| format!("Failed to prepare repository lookup for {repo_id}"))?;

    let mut rows = statement
        .query_map([repo_id], |row| {
            Ok(RepositoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                remote: row.get(2)?,
                default_branch: row.get(3)?,
                root_path: row.get(4)?,
                setup_script: row.get(5)?,
            })
        })
        .with_context(|| format!("Failed to query repository {repo_id}"))?;

    match rows.next() {
        Some(result) => result
            .map(Some)
            .with_context(|| format!("Failed to deserialize repository {repo_id}")),
        None => Ok(None),
    }
}

pub(crate) fn load_repository_by_root_path(root_path: &str) -> Result<Option<RepositoryRecord>> {
    let connection = db::open_connection(false)?;
    if let Some(repository) = query_repository_by_root_path(&connection, root_path)? {
        return Ok(Some(repository));
    }

    if let Some(normalized_root) = normalize_filesystem_path(Path::new(root_path)) {
        if normalized_root != root_path {
            if let Some(repository) = query_repository_by_root_path(&connection, &normalized_root)?
            {
                return Ok(Some(repository));
            }
        }

        if let Some(repository_name) = Path::new(root_path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            for repository in query_repository_candidates_by_name(&connection, repository_name)? {
                let normalized_repository_root =
                    normalize_filesystem_path(Path::new(&repository.root_path))
                        .unwrap_or_else(|| repository.root_path.clone());
                if normalized_repository_root == normalized_root {
                    return Ok(Some(repository));
                }
            }
        }
    }

    Ok(None)
}

fn query_repository_by_root_path(
    connection: &rusqlite::Connection,
    root_path: &str,
) -> Result<Option<RepositoryRecord>> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, remote, default_branch, root_path, setup_script
            FROM repos
            WHERE root_path = ?1
            ORDER BY created_at ASC
            LIMIT 1
            "#,
        )
        .with_context(|| format!("Failed to prepare repository root lookup for {root_path}"))?;

    let mut rows = statement
        .query_map([root_path], |row| {
            Ok(RepositoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                remote: row.get(2)?,
                default_branch: row.get(3)?,
                root_path: row.get(4)?,
                setup_script: row.get(5)?,
            })
        })
        .with_context(|| format!("Failed to query repository row for {root_path}"))?;

    match rows.next() {
        Some(result) => result
            .map(Some)
            .with_context(|| format!("Failed to deserialize repository for {root_path}")),
        None => Ok(None),
    }
}

fn query_repository_candidates_by_name(
    connection: &rusqlite::Connection,
    repository_name: &str,
) -> Result<Vec<RepositoryRecord>> {
    let root_suffix = format!("%/{repository_name}");
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, remote, default_branch, root_path, setup_script
            FROM repos
            WHERE name = ?1 OR root_path LIKE ?2
            ORDER BY created_at ASC
            "#,
        )
        .with_context(|| {
            format!("Failed to prepare repository candidate lookup for {repository_name}")
        })?;

    let rows = statement
        .query_map([repository_name, root_suffix.as_str()], |row| {
            Ok(RepositoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                remote: row.get(2)?,
                default_branch: row.get(3)?,
                root_path: row.get(4)?,
                setup_script: row.get(5)?,
            })
        })
        .with_context(|| format!("Failed to query repository candidates for {repository_name}"))?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| {
            format!("Failed to deserialize repository candidates for {repository_name}")
        })
}

pub(crate) fn insert_repository(repository: &ResolvedRepositoryInput) -> Result<String> {
    let connection = db::open_connection(true)?;
    let next_display_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(display_order), 0) + 1 FROM repos",
            [],
            |row| row.get(0),
        )
        .context("Failed to resolve next repository display order")?;
    let repo_id = uuid::Uuid::new_v4().to_string();

    connection
        .execute(
            r#"
            INSERT INTO repos (
              id,
              name,
              root_path,
              remote,
              remote_url,
              default_branch,
              display_order,
              hidden,
              setup_script,
              run_script,
              archive_script,
              conductor_config,
              icon,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))
            "#,
            (
                repo_id.as_str(),
                repository.name.as_str(),
                repository.normalized_root_path.as_str(),
                repository.remote.as_deref(),
                repository.remote_url.as_deref(),
                repository.default_branch.as_str(),
                next_display_order,
            ),
        )
        .with_context(|| format!("Failed to insert repository {}", repository.name))?;

    Ok(repo_id)
}

/// Atomically update the remote and re-resolve default_branch from the new
/// remote's HEAD. Falls back to "main" if the remote HEAD can't be resolved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRepositoryRemoteResponse {
    /// Number of ready workspaces whose `intended_target_branch` does not
    /// exist on the new remote. Zero means everything lines up.
    pub orphaned_workspace_count: u64,
}

pub fn update_repository_remote(
    repo_id: &str,
    remote: &str,
) -> Result<UpdateRepositoryRemoteResponse> {
    let repository = load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = std::path::PathBuf::from(repository.root_path.trim());

    let new_default_branch = resolve_default_branch_from_remote_head(&repo_root, remote)
        .with_context(|| {
            format!("Remote \"{remote}\" has no HEAD — cannot determine default branch")
        })?;
    let new_remote_url = resolve_repository_remote_url(&repo_root, remote).ok();

    let connection = db::open_connection(true)?;
    let updated = connection
        .execute(
            "UPDATE repos SET remote = ?1, default_branch = ?2, remote_url = ?3, updated_at = datetime('now') WHERE id = ?4",
            rusqlite::params![remote, new_default_branch, new_remote_url, repo_id],
        )
        .with_context(|| format!("Failed to update remote for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    // Fetch refs so the branch picker and workspace creation have local
    // remote-tracking refs. This must succeed — without it,
    // create_workspace_from_repo_impl will fail to resolve the start ref.
    git_ops::fetch_all_remote(&repo_root, remote)
        .with_context(|| format!("Failed to fetch from remote \"{remote}\""))?;

    // Check how many ready workspaces have a target branch that doesn't
    // exist on the new remote. We don't auto-overwrite — let the user
    // decide via the header branch picker.
    let remote_branches = git_ops::list_remote_branches(&repo_root, remote).unwrap_or_default();

    let mut stmt = connection
        .prepare(
            "SELECT intended_target_branch FROM workspaces WHERE repository_id = ?1 AND state = 'ready'",
        )
        .context("Failed to query workspace target branches")?;
    let targets: Vec<String> = stmt
        .query_map([repo_id], |row| row.get::<_, Option<String>>(0))
        .context("Failed to read workspace target branches")?
        .filter_map(|r| r.ok().flatten())
        .filter(|t| !t.trim().is_empty())
        .collect();

    let orphaned = targets
        .iter()
        .filter(|t| !remote_branches.contains(t))
        .count() as u64;

    Ok(UpdateRepositoryRemoteResponse {
        orphaned_workspace_count: orphaned,
    })
}

pub fn list_repo_remotes(repo_id: &str) -> Result<Vec<String>> {
    let repository = load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = std::path::PathBuf::from(repository.root_path.trim());
    git_ops::ensure_git_repository(&repo_root)?;
    git_ops::list_remotes(&repo_root)
}

pub fn update_repository_default_branch(repo_id: &str, default_branch: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    let updated = connection
        .execute(
            "UPDATE repos SET default_branch = ?1, updated_at = datetime('now') WHERE id = ?2",
            [default_branch, repo_id],
        )
        .with_context(|| format!("Failed to update default branch for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

pub(crate) fn delete_repository(repo_id: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    let deleted_rows = connection
        .execute("DELETE FROM repos WHERE id = ?1", [repo_id])
        .with_context(|| format!("Failed to delete repository {repo_id}"))?;

    if deleted_rows != 1 {
        bail!("Repository delete affected {deleted_rows} rows for {repo_id}");
    }

    Ok(())
}

pub fn resolve_repository_from_local_path(folder_path: &str) -> Result<ResolvedRepositoryInput> {
    let selected_path = PathBuf::from(folder_path.trim());

    if folder_path.trim().is_empty() {
        bail!("No repository folder was selected.");
    }

    if !selected_path.exists() {
        bail!("Selected path does not exist: {}", selected_path.display());
    }

    if !selected_path.is_dir() {
        bail!(
            "Selected path is not a directory: {}",
            selected_path.display()
        );
    }

    let selected_path_arg = selected_path.display().to_string();
    let inside_work_tree = git_ops::run_git(
        [
            "-C",
            selected_path_arg.as_str(),
            "rev-parse",
            "--is-inside-work-tree",
        ],
        None,
    )
    .map_err(|error| anyhow::anyhow!("Selected directory is not a Git working tree: {error}"))?;

    if inside_work_tree.trim() != "true" {
        bail!(
            "Selected directory is not a Git working tree: {}",
            selected_path.display()
        );
    }

    let normalized_root_path = git_ops::run_git(
        [
            "-C",
            selected_path_arg.as_str(),
            "rev-parse",
            "--show-toplevel",
        ],
        None,
    )
    .map_err(|error| anyhow::anyhow!("Failed to resolve Git repository root: {error}"))?;
    let normalized_root_path = normalized_root_path.trim().to_string();
    let normalized_root = Path::new(&normalized_root_path);
    let name = normalized_root
        .file_name()
        .and_then(|value| value.to_str())
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| {
            format!(
                "Failed to derive repository name from {}",
                normalized_root.display()
            )
        })?;

    let remote = resolve_repository_remote(normalized_root)?;
    let remote_url = match remote.as_deref() {
        Some(remote_name) => Some(resolve_repository_remote_url(normalized_root, remote_name)?),
        None => None,
    };
    let default_branch = resolve_repository_default_branch(normalized_root, remote.as_deref())
        .with_context(|| {
            format!(
                "Unable to resolve a default branch for repository {}",
                normalized_root.display()
            )
        })?;

    Ok(ResolvedRepositoryInput {
        name,
        normalized_root_path,
        remote,
        remote_url,
        default_branch,
    })
}

pub fn add_repository_from_local_path(folder_path: &str) -> Result<AddRepositoryResponse> {
    let resolved_repository = resolve_repository_from_local_path(folder_path)?;
    let last_clone_directory = Path::new(&resolved_repository.normalized_root_path)
        .parent()
        .map(|parent| parent.display().to_string());

    let existing_repository =
        load_repository_by_root_path(&resolved_repository.normalized_root_path)?;

    if let Some(last_clone_directory) = last_clone_directory.as_deref() {
        crate::settings::upsert_setting_value("last_clone_directory", last_clone_directory)
            .map_err(|e| anyhow::anyhow!(e))?;
    }

    if let Some(repository) = existing_repository {
        if let Some((selected_workspace_id, selected_workspace_state)) =
            crate::workspaces::select_visible_workspace_for_repo(&repository.id)
                .map_err(|e| anyhow::anyhow!(e))?
        {
            return Ok(AddRepositoryResponse {
                repository_id: repository.id,
                created_repository: false,
                selected_workspace_id,
                created_workspace_id: None,
                created_workspace_state: selected_workspace_state,
            });
        }

        let create_response = crate::workspaces::create_workspace_from_repo_impl(&repository.id)
            .map_err(|error| {
                anyhow::anyhow!("Repository already exists, but workspace create failed: {error}")
            })?;

        return Ok(AddRepositoryResponse {
            repository_id: repository.id,
            created_repository: false,
            selected_workspace_id: create_response.selected_workspace_id.clone(),
            created_workspace_id: Some(create_response.created_workspace_id),
            created_workspace_state: create_response.created_state,
        });
    }

    let repository_id = insert_repository(&resolved_repository)
        .with_context(|| format!("Failed to persist repository {}", resolved_repository.name))?;
    let create_result = crate::workspaces::create_workspace_from_repo_impl(&repository_id);

    match create_result {
        Ok(create_response) => Ok(AddRepositoryResponse {
            repository_id,
            created_repository: true,
            selected_workspace_id: create_response.selected_workspace_id.clone(),
            created_workspace_id: Some(create_response.created_workspace_id),
            created_workspace_state: create_response.created_state,
        }),
        Err(error) => {
            let _ = delete_repository(&repository_id);
            bail!("First workspace create failed: {error}");
        }
    }
}

// ---- Git remote / branch resolution helpers ----

fn resolve_repository_remote(repo_root: &Path) -> Result<Option<String>> {
    let repo_root_arg = repo_root.display().to_string();
    let output = git_ops::run_git(["-C", repo_root_arg.as_str(), "remote"], None)
        .map_err(|error| anyhow::anyhow!("Failed to read repository remotes: {error}"))?;
    let mut remotes = output
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if remotes.is_empty() {
        return Ok(None);
    }

    // Prefer "origin" if it exists.
    if remotes.iter().any(|remote| remote == "origin") {
        return Ok(Some("origin".to_string()));
    }

    // Multiple remotes, no origin — pick the first alphabetically.
    // User can change it later in repo settings.
    remotes.sort();
    Ok(remotes.into_iter().next())
}

fn resolve_repository_remote_url(repo_root: &Path, remote: &str) -> Result<String> {
    let repo_root_arg = repo_root.display().to_string();
    git_ops::run_git(
        ["-C", repo_root_arg.as_str(), "remote", "get-url", remote],
        None,
    )
    .map(|value| value.trim().to_string())
    .map_err(|error| anyhow::anyhow!("Failed to resolve remote URL for {remote}: {error}"))
}

fn resolve_repository_default_branch(repo_root: &Path, remote: Option<&str>) -> Option<String> {
    let remote = remote?;
    resolve_default_branch_from_remote_head(repo_root, remote).ok()
}

fn resolve_default_branch_from_remote_head(repo_root: &Path, remote: &str) -> Result<String> {
    // Authoritative: query the remote directly (lightweight network call).
    if let Ok(branch) = resolve_head_from_ls_remote(repo_root, remote) {
        return Ok(branch);
    }
    // Offline fallback: local symbolic ref (may be stale).
    resolve_head_from_local_symbolic_ref(repo_root, remote)
}

fn resolve_head_from_local_symbolic_ref(repo_root: &Path, remote: &str) -> Result<String> {
    let repo_root_arg = repo_root.display().to_string();
    let output = git_ops::run_git(
        [
            "-C",
            repo_root_arg.as_str(),
            "symbolic-ref",
            "--quiet",
            "--short",
            &format!("refs/remotes/{remote}/HEAD"),
        ],
        None,
    )
    .map_err(|error| anyhow::anyhow!("Failed to resolve remote HEAD for {remote}: {error}"))?;

    let prefix = format!("{remote}/");
    output
        .trim()
        .strip_prefix(prefix.as_str())
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("Remote HEAD for {remote} did not include a branch name"))
}

/// Query the remote via `git ls-remote --symref <remote> HEAD` to discover
/// the default branch. Only transfers a few bytes — much cheaper than a fetch.
fn resolve_head_from_ls_remote(repo_root: &Path, remote: &str) -> Result<String> {
    let output = git_ops::run_git_with_timeout(
        [
            "-C",
            &repo_root.display().to_string(),
            "ls-remote",
            "--symref",
            remote,
            "HEAD",
        ],
        None,
        git_ops::GIT_NETWORK_TIMEOUT,
    )
    .with_context(|| format!("Failed to query HEAD from remote \"{remote}\""))?;

    // Output format: "ref: refs/heads/main\tHEAD\n<sha>\tHEAD\n"
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("ref: refs/heads/") {
            if let Some(branch) = rest.split('\t').next() {
                let branch = branch.trim();
                if !branch.is_empty() {
                    return Ok(branch.to_string());
                }
            }
        }
    }

    bail!("Remote \"{remote}\" did not advertise a HEAD branch")
}

pub(crate) fn normalize_filesystem_path(path: &Path) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|canonicalized| canonicalized.display().to_string())
}
