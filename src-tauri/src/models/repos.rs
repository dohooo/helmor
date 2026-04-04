use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use super::{db, git_ops, helpers};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCreateOption {
    pub id: String,
    pub name: String,
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
              root_path
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
            SELECT id, name, default_branch, root_path, setup_script
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
                default_branch: row.get(2)?,
                root_path: row.get(3)?,
                setup_script: row.get(4)?,
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
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, default_branch, root_path, setup_script
            FROM repos
            ORDER BY created_at ASC
            "#,
        )
        .context("Failed to prepare repository root lookup")?;

    let rows = statement
        .query_map([], |row| {
            Ok(RepositoryRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                default_branch: row.get(2)?,
                root_path: row.get(3)?,
                setup_script: row.get(4)?,
            })
        })
        .with_context(|| format!("Failed to query repository rows for {root_path}"))?;

    let rows = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("Failed to deserialize repository for {root_path}"))?;
    let normalized_requested_root =
        normalize_filesystem_path(Path::new(root_path)).unwrap_or_else(|| root_path.to_string());

    for repository in rows {
        if repository.root_path == root_path {
            return Ok(Some(repository));
        }

        let normalized_repository_root =
            normalize_filesystem_path(Path::new(&repository.root_path))
                .unwrap_or_else(|| repository.root_path.clone());

        if normalized_repository_root == normalized_requested_root {
            return Ok(Some(repository));
        }
    }

    Ok(None)
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
        super::settings::upsert_setting_value("last_clone_directory", last_clone_directory)
            .map_err(|e| anyhow::anyhow!(e))?;
    }

    if let Some(repository) = existing_repository {
        if let Some((selected_workspace_id, selected_workspace_state)) =
            super::workspaces::select_visible_workspace_for_repo(&repository.id)
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

        let create_response = super::workspaces::create_workspace_from_repo_impl(&repository.id)
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
    let create_result = super::workspaces::create_workspace_from_repo_impl(&repository_id);

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
    let remotes = output
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    if remotes.iter().any(|remote| remote == "origin") {
        return Ok(Some("origin".to_string()));
    }

    if remotes.len() == 1 {
        return Ok(remotes.first().cloned());
    }

    Ok(None)
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
    if let Some(remote) = remote {
        if let Ok(symbolic_ref) = resolve_default_branch_from_remote_head(repo_root, remote) {
            return Some(symbolic_ref);
        }
    }

    resolve_current_branch(repo_root)
}

fn resolve_default_branch_from_remote_head(repo_root: &Path, remote: &str) -> Result<String> {
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

fn resolve_current_branch(repo_root: &Path) -> Option<String> {
    let repo_root_arg = repo_root.display().to_string();
    let branch = git_ops::run_git(
        ["-C", repo_root_arg.as_str(), "branch", "--show-current"],
        None,
    )
    .ok()?;
    let branch = branch.trim();

    if branch.is_empty() || branch == "HEAD" {
        None
    } else {
        Some(branch.to_string())
    }
}

pub(crate) fn normalize_filesystem_path(path: &Path) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|canonicalized| canonicalized.display().to_string())
}
