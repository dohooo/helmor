use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{git_ops, helpers, workspace::sidebar_order, workspace_state};

use super::db;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCreateOption {
    pub id: String,
    pub name: String,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    pub default_branch: Option<String>,
    /// Per-repo branch prefix mode. Serialized as the lowercase enum
    /// variant ("username" / "custom" / "none"). NULL is treated as
    /// `Username` by the resolver, matching the explicit default.
    pub branch_prefix_type: Option<crate::settings::BranchPrefixType>,
    pub branch_prefix_custom: Option<String>,
    pub forge_provider: Option<String>,
    /// gh/glab account login bound to this repo. NULL when no logged-in
    /// account had access at add-repo time; UI surfaces a "Connect"
    /// affordance.
    pub forge_login: Option<String>,
    pub repo_icon_src: Option<String>,
    pub repo_initials: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryDefaults {
    pub last_clone_directory: Option<String>,
}

/// Response from `add_repository_from_local_path` / `clone_repository_from_url`.
///
/// `selected_workspace_id`:
/// - `Some(id)` only when the repo was already in the DB AND has a visible
///   (non-archived) workspace — the UI focuses that workspace.
/// - `None` for newly-added repos and for re-adds where every workspace is
///   archived. The UI lands on the start page with the new repo selected
///   so the user can pick the source branch + workspace mode themselves.
///
/// We deliberately no longer auto-create a workspace at add-repo time —
/// the start page replaced that flow.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryResponse {
    pub repository_id: String,
    pub created_repository: bool,
    pub selected_workspace_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedRepositoryInput {
    pub name: String,
    pub normalized_root_path: String,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    pub default_branch: String,
    /// Forge classification cached on the repo record. Set at repo-creation
    /// time by `crate::forge::detect_provider_for_repo_offline`.
    pub forge_provider: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RepositoryRecord {
    pub id: String,
    pub name: String,
    pub remote: Option<String>,
    pub default_branch: Option<String>,
    pub root_path: String,
    pub setup_script: Option<String>,
    #[allow(dead_code)] // Queried separately via RepoScripts; kept here for completeness.
    pub run_script: Option<String>,
    /// Auto-run the setup script when a workspace is created.
    /// Defaults to true; users disable it from repo settings.
    pub auto_run_setup: bool,
    /// Cached forge classification ("github" / "gitlab" / "unknown").
    /// NULL for repos created before the detection feature — the loader
    /// re-runs detection on demand in that case.
    #[allow(dead_code)]
    pub forge_provider: Option<String>,
    /// gh/glab account login bound to this repo. NULL when no logged-in
    /// account had access (auto-detect failed) or the repo predates the
    /// feature. See `crate::forge::accounts`.
    #[allow(dead_code)]
    pub forge_login: Option<String>,
}

pub fn list_repositories() -> Result<Vec<RepositoryCreateOption>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              id,
              name,
              default_branch,
              root_path,
              remote,
              remote_url,
              forge_provider,
              forge_login,
              branch_prefix_type,
              branch_prefix_custom
            FROM repos
            WHERE COALESCE(hidden, 0) = 0
            ORDER BY COALESCE(display_order, 0) ASC, LOWER(name) ASC
            "#,
        )
        .context("Failed to prepare repository list query")?;

    let rows = statement
        .query_map([], |row| {
            use std::str::FromStr;
            let name: String = row.get(1)?;
            let root_path: Option<String> = row.get(3)?;
            let initials = helpers::repo_initials_for_name(&name);
            let icon_src = helpers::repo_icon_src_for_root_path(root_path.as_deref());
            // Storage-string → enum (silently drops unrecognised values).
            let branch_prefix_type_raw: Option<String> = row.get(8)?;
            let branch_prefix_type = branch_prefix_type_raw
                .as_deref()
                .and_then(|value| crate::settings::BranchPrefixType::from_str(value).ok());

            Ok(RepositoryCreateOption {
                id: row.get(0)?,
                name,
                remote: row.get(4)?,
                remote_url: row.get(5)?,
                forge_provider: row.get(6)?,
                forge_login: row.get(7)?,
                branch_prefix_type,
                branch_prefix_custom: row.get(9)?,
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
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, remote, default_branch, root_path, setup_script, run_script, auto_run_setup, forge_provider, forge_login
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
                run_script: row.get(6)?,
                auto_run_setup: row.get::<_, Option<i64>>(7)?.unwrap_or(1) != 0,
                forge_provider: row.get(8)?,
                forge_login: row.get(9)?,
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
    let connection = db::read_conn()?;
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
            SELECT id, name, remote, default_branch, root_path, setup_script, run_script, auto_run_setup, forge_provider, forge_login
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
                run_script: row.get(6)?,
                auto_run_setup: row.get::<_, Option<i64>>(7)?.unwrap_or(1) != 0,
                forge_provider: row.get(8)?,
                forge_login: row.get(9)?,
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
            SELECT id, name, remote, default_branch, root_path, setup_script, run_script, auto_run_setup, forge_provider, forge_login
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
                run_script: row.get(6)?,
                auto_run_setup: row.get::<_, Option<i64>>(7)?.unwrap_or(1) != 0,
                forge_provider: row.get(8)?,
                forge_login: row.get(9)?,
            })
        })
        .with_context(|| format!("Failed to query repository candidates for {repository_name}"))?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| {
            format!("Failed to deserialize repository candidates for {repository_name}")
        })
}

pub(crate) fn insert_repository(repository: &ResolvedRepositoryInput) -> Result<String> {
    let connection = db::write_conn()?;
    // Append to the sparse 1024-step grid so drag-reorder later only has
    // to write the moving row's `display_order`, not the whole table.
    let next_display_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(display_order), 0) + ?1 FROM repos",
            [sidebar_order::ORDER_STEP],
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
              forge_provider,
              created_at,
              updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL, NULL, ?8, datetime('now'), datetime('now'))
            "#,
            (
                repo_id.as_str(),
                repository.name.as_str(),
                repository.normalized_root_path.as_str(),
                repository.remote.as_deref(),
                repository.remote_url.as_deref(),
                repository.default_branch.as_str(),
                next_display_order,
                repository.forge_provider.as_deref(),
            ),
        )
        .with_context(|| format!("Failed to insert repository {}", repository.name))?;

    Ok(repo_id)
}

/// Reorder a repository inside the sidebar's repo bucket list. Common case
/// is a single-row UPDATE — falls back to a full rebalance when the sparse
/// gap between neighbours has run out.
pub fn move_repository_in_sidebar(repo_id: &str, before_repo_id: Option<&str>) -> Result<()> {
    if before_repo_id == Some(repo_id) {
        bail!("Repository cannot be moved before itself");
    }
    let mut connection = db::write_conn()?;
    let transaction = connection
        .transaction()
        .context("Failed to start repo move transaction")?;

    let neighbours = load_repo_orders(&transaction, repo_id)?;
    let (prev, next) = resolve_repo_neighbour_orders(&neighbours, before_repo_id)?;

    let new_order = match sidebar_order::compute_midpoint(prev, next) {
        Some(order) => order,
        None => rebalance_repo_orders(&transaction, repo_id, before_repo_id)?,
    };

    let updated = transaction
        .execute(
            "UPDATE repos SET display_order = ?2, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![repo_id, new_order],
        )
        .with_context(|| format!("Failed to update display order for repo {repo_id}"))?;
    if updated != 1 {
        bail!("Repo move affected {updated} rows for {repo_id}");
    }

    transaction
        .commit()
        .context("Failed to commit repo move transaction")
}

fn load_repo_orders(
    transaction: &rusqlite::Transaction<'_>,
    exclude_repo_id: &str,
) -> Result<Vec<(String, i64)>> {
    let rows: Vec<(String, i64)> = transaction
        .prepare(
            r#"
            SELECT id, COALESCE(display_order, 0)
            FROM repos
            WHERE COALESCE(hidden, 0) = 0
            ORDER BY COALESCE(display_order, 0) ASC, LOWER(name) ASC
            "#,
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows
        .into_iter()
        .filter(|(id, _)| id != exclude_repo_id)
        .collect())
}

fn resolve_repo_neighbour_orders(
    neighbours: &[(String, i64)],
    before_repo_id: Option<&str>,
) -> Result<(Option<i64>, Option<i64>)> {
    let Some(before_id) = before_repo_id else {
        return Ok((neighbours.last().map(|(_, order)| *order), None));
    };
    let position = neighbours
        .iter()
        .position(|(id, _)| id == before_id)
        .with_context(|| format!("Before-repo is not in sidebar repo list: {before_id}"))?;
    let next = Some(neighbours[position].1);
    let prev = if position == 0 {
        None
    } else {
        Some(neighbours[position - 1].1)
    };
    Ok((prev, next))
}

fn rebalance_repo_orders(
    transaction: &rusqlite::Transaction<'_>,
    repo_id: &str,
    before_repo_id: Option<&str>,
) -> Result<i64> {
    let neighbours = load_repo_orders(transaction, repo_id)?;
    let insert_position = match before_repo_id {
        None => neighbours.len(),
        Some(id) => neighbours
            .iter()
            .position(|(rid, _)| rid == id)
            .with_context(|| format!("Before-repo is not in sidebar repo list: {id}"))?,
    };

    let mut ordered_ids: Vec<&str> = neighbours.iter().map(|(s, _)| s.as_str()).collect();
    ordered_ids.insert(insert_position, repo_id);

    let mut moving_order = sidebar_order::ORDER_STEP;
    for (index, id) in ordered_ids.iter().enumerate() {
        let order = sidebar_order::order_for_index(index)?;
        if *id == repo_id {
            moving_order = order;
            continue;
        }
        transaction
            .execute(
                "UPDATE repos SET display_order = ?2 WHERE id = ?1",
                rusqlite::params![id, order],
            )
            .with_context(|| format!("Failed to rebalance display order for repo {id}"))?;
    }
    Ok(moving_order)
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

    // Re-classify locally when the remote swaps; no network or CLI probes
    // on this settings path.
    let (new_provider, _) = crate::forge::detect_provider_for_repo_offline(
        new_remote_url.as_deref(),
        Some(repo_root.as_path()),
    );
    let new_forge_provider = new_provider.as_storage_str().to_string();

    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE repos SET remote = ?1, default_branch = ?2, remote_url = ?3, forge_provider = ?4, updated_at = datetime('now') WHERE id = ?5",
            rusqlite::params![remote, new_default_branch, new_remote_url, new_forge_provider, repo_id],
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

    let sql = format!(
        "SELECT intended_target_branch FROM workspaces WHERE repository_id = ?1 AND state {}",
        workspace_state::OPERATIONAL_FILTER,
    );
    let mut stmt = connection
        .prepare(&sql)
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

/// Write the forge_provider cache for a repo. Called on the legacy path
/// where `get_workspace_forge` ran detection because the row predates this
/// feature — persisting avoids re-detecting on every subsequent query.
pub fn update_repository_forge_provider(repo_id: &str, provider: &str) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE repos SET forge_provider = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![provider, repo_id],
        )
        .with_context(|| format!("Failed to update forge_provider for {repo_id}"))?;
    Ok(())
}

/// IDs of repos that look like a forge repo (provider is github/gitlab)
/// but haven't been bound to an account yet. Drives the startup backfill
/// in `forge::accounts::backfill_unbound_repos` and the post-login retry
/// triggered after Settings → Account adds a fresh CLI login.
pub fn list_repos_needing_forge_binding() -> Result<Vec<String>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM repos
            WHERE forge_login IS NULL
              AND forge_provider IN ('github', 'gitlab')
              AND COALESCE(hidden, 0) = 0
            ORDER BY created_at ASC
            "#,
        )
        .context("Failed to prepare list_repos_needing_forge_binding query")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .context("Failed to query repos needing forge binding")?
        .collect::<rusqlite::Result<Vec<String>>>()
        .context("Failed to collect repo ids needing forge binding")?;
    Ok(ids)
}

/// Snapshot of a forge-bound repo: id + provider + bound login. Used by
/// the backfill sweep to detect bindings that have gone stale (login
/// no longer present in `gh / glab auth status`) and re-run auto-bind
/// against whatever fresh logins do exist.
#[derive(Debug, Clone)]
pub struct ForgeBoundRepo {
    pub id: String,
    pub provider: String,
    pub login: String,
}

/// Repos with a non-NULL `forge_login` and a known forge provider.
/// Companion to [`list_repos_needing_forge_binding`] for the second
/// pass of the backfill — a binding can rot if the user runs
/// `gh auth logout octocat` outside of Helmor; this query surfaces
/// those rows so the sweep can re-evaluate them.
pub fn list_forge_bound_repos() -> Result<Vec<ForgeBoundRepo>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, forge_provider, forge_login
            FROM repos
            WHERE forge_login IS NOT NULL
              AND forge_provider IN ('github', 'gitlab')
              AND COALESCE(hidden, 0) = 0
            ORDER BY created_at ASC
            "#,
        )
        .context("Failed to prepare list_forge_bound_repos query")?;
    let rows = statement
        .query_map([], |row| {
            Ok(ForgeBoundRepo {
                id: row.get(0)?,
                provider: row.get(1)?,
                login: row.get(2)?,
            })
        })
        .context("Failed to query forge-bound repos")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("Failed to collect forge-bound repo rows")?;
    Ok(rows)
}

/// Bind / unbind the gh/glab account login for a repo. Pass `None` to
/// clear the binding (e.g. when auto-detect found no account with access).
pub fn update_repository_forge_login(repo_id: &str, login: Option<&str>) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "UPDATE repos SET forge_login = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![login, repo_id],
        )
        .with_context(|| format!("Failed to update forge_login for {repo_id}"))?;
    Ok(())
}

pub fn update_repository_default_branch(repo_id: &str, default_branch: &str) -> Result<()> {
    let connection = db::write_conn()?;
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

pub fn load_repo_branch_prefix_settings(
    repo_id: &str,
) -> Result<crate::settings::EffectiveBranchPrefixSettings> {
    use std::str::FromStr;

    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            "SELECT branch_prefix_type, branch_prefix_custom, forge_provider, remote_url, forge_login \
             FROM repos WHERE id = ?1",
        )
        .with_context(|| format!("Failed to prepare branch prefix lookup for {repo_id}"))?;

    statement
        .query_row([repo_id], |row| {
            // Parse the storage string into the enum here so the rest of
            // the codebase only ever sees the typed form. Unknown /
            // legacy values land as `None` and the resolver falls back
            // to the default.
            let prefix_type_raw: Option<String> = row.get(0)?;
            let prefix_type = prefix_type_raw
                .as_deref()
                .and_then(|value| crate::settings::BranchPrefixType::from_str(value).ok());
            Ok(crate::settings::EffectiveBranchPrefixSettings {
                branch_prefix_type: prefix_type,
                branch_prefix_custom: row.get(1)?,
                forge_provider: row.get(2)?,
                remote_url: row.get(3)?,
                forge_login: row.get(4)?,
            })
        })
        .with_context(|| format!("Repository not found: {repo_id}"))
}

/// Persist a repo's branch-prefix preferences. The enum guarantees only
/// `Username` / `Custom` / `None` reach storage. When `prefix_type` is
/// anything other than `Custom`, `prefix_custom` is cleared so the
/// column doesn't keep stale data.
pub fn update_repository_branch_prefix(
    repo_id: &str,
    prefix_type: Option<crate::settings::BranchPrefixType>,
    prefix_custom: Option<&str>,
) -> Result<()> {
    use crate::settings::BranchPrefixType;

    let stored_type = prefix_type.map(|t| t.as_storage_str());
    let stored_custom = if prefix_type == Some(BranchPrefixType::Custom) {
        prefix_custom
            .map(str::trim)
            .filter(|value| !value.is_empty())
    } else {
        None
    };

    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE repos SET branch_prefix_type = ?1, branch_prefix_custom = ?2, \
             updated_at = datetime('now') WHERE id = ?3",
            rusqlite::params![stored_type, stored_custom, repo_id],
        )
        .with_context(|| format!("Failed to update branch prefix for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoScripts {
    pub setup_script: Option<String>,
    pub run_script: Option<String>,
    pub archive_script: Option<String>,
    pub setup_from_project: bool,
    pub run_from_project: bool,
    pub archive_from_project: bool,
    /// Auto-run setup on workspace creation. DB-only — not configurable
    /// from `helmor.json`. Defaults to true.
    pub auto_run_setup: bool,
    /// "concurrent" (default) lets the run script run in many workspaces
    /// at once. "non-concurrent" makes a new run stop any other live run
    /// in the same repo first — useful when the script binds a fixed port.
    pub run_script_mode: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPreferences {
    pub create_pr: Option<String>,
    pub review: Option<String>,
    pub fix_errors: Option<String>,
    pub resolve_conflicts: Option<String>,
    pub branch_rename: Option<String>,
    pub general: Option<String>,
}

/// Resolve repo scripts using a fixed priority:
///
///   1. The workspace's worktree `helmor.json` — highest priority, only
///      consulted when `workspace_id` is supplied AND the worktree dir
///      exists on disk.
///   2. The source repo root's `helmor.json` — used whenever (1) can't
///      apply: no `workspace_id`, unknown workspace, or worktree missing
///      (archived / broken / pre-Phase-2 creation).
///   3. DB-level config (`repos.setup_script/run_script/archive_script`) —
///      the per-user override set via the Settings UI, used as a final
///      fallback when neither `helmor.json` source provides a value.
///
/// The same rule applies regardless of caller (runtime panel, settings
/// page, script execution, archive hook) — there is no special-case
/// branch for "creation in flight" or "no workspace context".
pub fn load_repo_scripts(repo_id: &str, workspace_id: Option<&str>) -> Result<RepoScripts> {
    // Priority 1: workspace worktree helmor.json.
    let worktree_project = workspace_id.and_then(|ws_id| {
        crate::models::workspaces::load_workspace_record_by_id(ws_id)
            .ok()
            .flatten()
            .and_then(|ws| crate::workspace::helpers::workspace_path(&ws).ok())
            .filter(|dir| dir.is_dir())
            .and_then(|dir| load_helmor_json_scripts(&dir))
    });

    // Priority 2: source repo root helmor.json (worktree missing or no
    // workspace context at all).
    let project = worktree_project.or_else(|| {
        load_repository_by_id(repo_id)
            .ok()
            .flatten()
            .and_then(|repo| load_helmor_json_scripts(&PathBuf::from(repo.root_path.trim())))
    });

    // Priority 3: DB values — picked up by `pick_script` when the project
    // config doesn't provide a value.
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            "SELECT setup_script, run_script, archive_script, auto_run_setup, run_script_mode FROM repos WHERE id = ?1",
        )
        .with_context(|| format!("Failed to prepare script lookup for {repo_id}"))?;

    let (db_setup, db_run, db_archive, auto_run_setup, run_script_mode) = statement
        .query_row([repo_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i64>>(3)?.unwrap_or(1) != 0,
                row.get::<_, Option<String>>(4)?
                    .unwrap_or_else(|| "concurrent".to_string()),
            ))
        })
        .with_context(|| format!("Repository not found: {repo_id}"))?;

    let (setup_script, setup_from_project) =
        pick_script(project.as_ref().and_then(|p| p.setup.as_deref()), db_setup);
    let (run_script, run_from_project) =
        pick_script(project.as_ref().and_then(|p| p.run.as_deref()), db_run);
    let (archive_script, archive_from_project) = pick_script(
        project.as_ref().and_then(|p| p.archive.as_deref()),
        db_archive,
    );

    Ok(RepoScripts {
        setup_script,
        run_script,
        archive_script,
        setup_from_project,
        run_from_project,
        archive_from_project,
        auto_run_setup,
        run_script_mode,
    })
}

/// Project config wins when present; returns (value, is_from_project).
fn pick_script(project_value: Option<&str>, db_value: Option<String>) -> (Option<String>, bool) {
    match project_value {
        Some(v) => (Some(v.to_owned()), true),
        None => (db_value, false),
    }
}

struct HelmorJsonScripts {
    setup: Option<String>,
    run: Option<String>,
    archive: Option<String>,
}

fn load_helmor_json_scripts(root_path: &Path) -> Option<HelmorJsonScripts> {
    parse_project_config_scripts(&root_path.join("helmor.json"))
}

fn parse_project_config_scripts(config_path: &Path) -> Option<HelmorJsonScripts> {
    if !config_path.is_file() {
        return None;
    }
    let contents = match fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Failed to read {}: {e:#}", config_path.display());
            return None;
        }
    };
    let json: Value = match serde_json::from_str(&contents) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("Invalid JSON in {}: {e}", config_path.display());
            return None;
        }
    };
    let scripts = json.get("scripts")?;
    Some(HelmorJsonScripts {
        setup: scripts
            .get("setup")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        run: scripts
            .get("run")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        archive: scripts
            .get("archive")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

pub fn update_repo_scripts(
    repo_id: &str,
    setup_script: Option<&str>,
    run_script: Option<&str>,
    archive_script: Option<&str>,
) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE repos SET setup_script = ?1, run_script = ?2, archive_script = ?3, updated_at = datetime('now') WHERE id = ?4",
            rusqlite::params![setup_script, run_script, archive_script, repo_id],
        )
        .with_context(|| format!("Failed to update scripts for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

/// Persist the user opt-in flag that controls whether the setup script
/// auto-runs on workspace creation.
pub fn update_repo_auto_run_setup(repo_id: &str, enabled: bool) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE repos SET auto_run_setup = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![if enabled { 1 } else { 0 }, repo_id],
        )
        .with_context(|| format!("Failed to update auto_run_setup for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

/// Persist the per-repo run-script mode. Accepts "concurrent" or
/// "non-concurrent"; anything else is rejected so the column never holds
/// an unrecognized value.
pub fn update_repo_run_script_mode(repo_id: &str, mode: &str) -> Result<()> {
    if mode != "concurrent" && mode != "non-concurrent" {
        bail!("Invalid run_script_mode: {mode}");
    }
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            "UPDATE repos SET run_script_mode = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![mode, repo_id],
        )
        .with_context(|| format!("Failed to update run_script_mode for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

pub fn load_repo_preferences(repo_id: &str) -> Result<RepoPreferences> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT
              custom_prompt_create_pr,
              custom_prompt_review,
              custom_prompt_fix_errors,
              custom_prompt_resolve_merge_conflicts,
              custom_prompt_rename_branch,
              custom_prompt_general
            FROM repos
            WHERE id = ?1
            "#,
        )
        .with_context(|| format!("Failed to prepare preferences lookup for {repo_id}"))?;

    statement
        .query_row([repo_id], |row| {
            Ok(RepoPreferences {
                create_pr: row.get(0)?,
                review: row.get(1)?,
                fix_errors: row.get(2)?,
                resolve_conflicts: row.get(3)?,
                branch_rename: row.get(4)?,
                general: row.get(5)?,
            })
        })
        .with_context(|| format!("Repository not found: {repo_id}"))
}

pub fn update_repo_preferences(repo_id: &str, preferences: &RepoPreferences) -> Result<()> {
    let connection = db::write_conn()?;
    let updated = connection
        .execute(
            r#"
            UPDATE repos
            SET
              custom_prompt_create_pr = ?1,
              custom_prompt_review = ?2,
              custom_prompt_fix_errors = ?3,
              custom_prompt_resolve_merge_conflicts = ?4,
              custom_prompt_rename_branch = ?5,
              custom_prompt_general = ?6,
              updated_at = datetime('now')
            WHERE id = ?7
            "#,
            rusqlite::params![
                normalize_repo_preference(preferences.create_pr.as_deref()),
                normalize_repo_preference(preferences.review.as_deref()),
                normalize_repo_preference(preferences.fix_errors.as_deref()),
                normalize_repo_preference(preferences.resolve_conflicts.as_deref()),
                normalize_repo_preference(preferences.branch_rename.as_deref()),
                normalize_repo_preference(preferences.general.as_deref()),
                repo_id
            ],
        )
        .with_context(|| format!("Failed to update preferences for {repo_id}"))?;

    if updated != 1 {
        bail!("Repository not found: {repo_id}");
    }

    Ok(())
}

fn normalize_repo_preference(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Delete a repository and all related data (workspaces, sessions, messages, etc.)
pub fn delete_repository_cascade(repo_id: &str) -> Result<()> {
    let mut connection = db::write_conn()?;
    let tx = connection
        .transaction()
        .context("Failed to start delete repository transaction")?;

    // Delete leaf data first, then parent rows.
    tx.execute(
        "DELETE FROM session_messages WHERE session_id IN (SELECT s.id FROM sessions s JOIN workspaces w ON s.workspace_id = w.id WHERE w.repository_id = ?1)",
        [repo_id],
    ).context("Failed to delete session messages for repository")?;
    tx.execute(
        "DELETE FROM sessions WHERE workspace_id IN (SELECT id FROM workspaces WHERE repository_id = ?1)",
        [repo_id],
    ).context("Failed to delete sessions for repository")?;
    tx.execute(
        "DELETE FROM pending_cli_sends WHERE workspace_id IN (SELECT id FROM workspaces WHERE repository_id = ?1)",
        [repo_id],
    ).context("Failed to delete pending sends for repository")?;
    tx.execute("DELETE FROM workspaces WHERE repository_id = ?1", [repo_id])
        .context("Failed to delete workspaces for repository")?;
    tx.execute("DELETE FROM repos WHERE id = ?1", [repo_id])
        .context("Failed to delete repository row")?;

    tx.commit()
        .context("Failed to commit delete repository transaction")?;

    Ok(())
}

pub fn resolve_repository_from_local_path(folder_path: &str) -> Result<ResolvedRepositoryInput> {
    let normalized_root_path = resolve_git_root_path(folder_path)?;
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
    if remote.is_none() {
        bail!("Local-only repositories are not supported.");
    }
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

    // Keep repo creation local: no network probes or CLI calls here.
    let (provider, _) = crate::forge::detect_provider_for_repo_offline(
        remote_url.as_deref(),
        Some(normalized_root),
    );
    let forge_provider = Some(provider.as_storage_str().to_string());

    Ok(ResolvedRepositoryInput {
        name,
        normalized_root_path,
        remote,
        remote_url,
        default_branch,
        forge_provider,
    })
}

pub fn clone_repository_from_url(
    git_url: &str,
    clone_directory: &str,
) -> Result<AddRepositoryResponse> {
    let url = git_url.trim();
    if url.is_empty() {
        bail!("Git URL is required.");
    }

    let parent = Path::new(clone_directory.trim());
    if !parent.exists() {
        bail!(
            "Clone location does not exist: {}. Please choose an existing directory.",
            parent.display()
        );
    }
    if !parent.is_dir() {
        bail!("Clone location is not a directory: {}", parent.display());
    }

    let repo_name = infer_repo_name_from_url(url)
        .with_context(|| format!("Unable to derive a repository name from URL: {url}"))?;
    let target_dir = parent.join(&repo_name);

    if target_dir.exists() {
        bail!(
            "Target directory already exists: {}. Please remove it or choose a different clone location.",
            target_dir.display()
        );
    }

    let target_arg = target_dir.display().to_string();
    let clone_result = git_ops::run_git_with_timeout(
        ["clone", "--", url, target_arg.as_str()],
        Some(parent),
        git_ops::GIT_CLONE_TIMEOUT,
    );

    if let Err(error) = clone_result {
        // git may have partially created the target directory before failing.
        // Best-effort cleanup so the user can retry without hitting the
        // "target directory already exists" branch above.
        if target_dir.exists() {
            let _ = fs::remove_dir_all(&target_dir);
        }
        return Err(error.context("Failed to clone repository"));
    }

    add_repository_from_local_path(&target_dir.display().to_string())
}

fn infer_repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let without_git = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let last = without_git.rsplit(['/', ':']).next()?;
    let cleaned = last.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

pub fn add_repository_from_local_path(folder_path: &str) -> Result<AddRepositoryResponse> {
    // Fast duplicate check: only needs git root path, no network calls.
    let normalized_root_path = resolve_git_root_path(folder_path)?;

    let last_clone_directory = Path::new(&normalized_root_path)
        .parent()
        .map(|parent| parent.display().to_string());
    if let Some(dir) = last_clone_directory.as_deref() {
        crate::settings::upsert_setting_value("last_clone_directory", dir)
            .map_err(|e| anyhow::anyhow!(e))?;
    }

    // Re-add path: focus an existing visible workspace if one exists,
    // otherwise fall through to the start-page hand-off (None).
    if let Some(repository) = load_repository_by_root_path(&normalized_root_path)? {
        let selected_workspace_id =
            crate::workspaces::select_visible_workspace_for_repo(&repository.id)
                .map_err(|e| anyhow::anyhow!(e))?
                .map(|(workspace_id, _)| workspace_id);
        return Ok(AddRepositoryResponse {
            repository_id: repository.id,
            created_repository: false,
            selected_workspace_id,
        });
    }

    // Only do the expensive remote/branch resolution for truly new repos.
    let resolved_repository = resolve_repository_from_local_path(folder_path)?;

    let repository_id = insert_repository(&resolved_repository)
        .with_context(|| format!("Failed to persist repository {}", resolved_repository.name))?;

    // Auto-bind a gh/glab account to the repo. Best-effort — failures
    // (no CLI installed, no auth, no candidate with access) leave
    // forge_login NULL and the UI prompts the user to Connect when
    // needed. Don't propagate the error: a working bind is a nice-to-
    // have, not a precondition for the repo existing in the database.
    match crate::forge::accounts::auto_bind_repo_account(&repository_id) {
        Ok(Some(login)) => {
            tracing::debug!(
                repo_id = %repository_id,
                login = %login,
                "Auto-bound forge account on repo creation"
            );
        }
        Ok(None) => {
            tracing::debug!(
                repo_id = %repository_id,
                "No forge account auto-bound; user must Connect"
            );
        }
        Err(error) => {
            tracing::warn!(
                repo_id = %repository_id,
                error = %format!("{error:#}"),
                "Forge auto-bind failed during repo creation"
            );
        }
    }

    Ok(AddRepositoryResponse {
        repository_id,
        created_repository: true,
        selected_workspace_id: None,
    })
}

/// Lightweight git root resolution — no network calls, just local git commands.
fn resolve_git_root_path(folder_path: &str) -> Result<String> {
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

    let root = git_ops::run_git(
        [
            "-C",
            selected_path_arg.as_str(),
            "rev-parse",
            "--show-toplevel",
        ],
        None,
    )
    .map_err(|error| anyhow::anyhow!("Failed to resolve Git repository root: {error}"))?;

    Ok(root.trim().to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_load_repository_round_trips_forge_provider() {
        let env = crate::testkit::TestEnv::new("repos-forge-provider");
        let repo = ResolvedRepositoryInput {
            name: "gitlab-repo".to_string(),
            normalized_root_path: env.root.join("repo").display().to_string(),
            remote: Some("origin".to_string()),
            remote_url: Some("git@gitlab.com:acme/gitlab-repo.git".to_string()),
            default_branch: "main".to_string(),
            forge_provider: Some("gitlab".to_string()),
        };

        let repo_id = insert_repository(&repo).unwrap();
        let loaded = load_repository_by_id(&repo_id).unwrap().unwrap();

        assert_eq!(loaded.forge_provider.as_deref(), Some("gitlab"));
        assert_eq!(loaded.remote.as_deref(), Some("origin"));
    }

    #[test]
    fn update_repository_forge_provider_persists_cache() {
        let env = crate::testkit::TestEnv::new("repos-forge-provider-update");
        let repo = ResolvedRepositoryInput {
            name: "legacy-repo".to_string(),
            normalized_root_path: env.root.join("legacy").display().to_string(),
            remote: Some("origin".to_string()),
            remote_url: Some("git@github.com:acme/legacy-repo.git".to_string()),
            default_branch: "main".to_string(),
            forge_provider: None,
        };

        let repo_id = insert_repository(&repo).unwrap();
        assert_eq!(
            load_repository_by_id(&repo_id)
                .unwrap()
                .unwrap()
                .forge_provider,
            None
        );

        update_repository_forge_provider(&repo_id, "github").unwrap();

        let loaded = load_repository_by_id(&repo_id).unwrap().unwrap();
        assert_eq!(loaded.forge_provider.as_deref(), Some("github"));
    }

    #[test]
    fn repository_branch_prefix_round_trips() {
        let env = crate::testkit::TestEnv::new("repos-branch-prefix");

        let repo = ResolvedRepositoryInput {
            name: "prefix-repo".to_string(),
            normalized_root_path: env.root.join("prefix").display().to_string(),
            remote: Some("origin".to_string()),
            remote_url: Some("git@github.com:acme/prefix-repo.git".to_string()),
            default_branch: "main".to_string(),
            forge_provider: Some("github".to_string()),
        };

        use crate::settings::BranchPrefixType;

        // Fresh row defaults to "no per-repo override". Resolver treats
        // a None type as Username, so legacy rows keep the old behavior.
        let repo_id = insert_repository(&repo).unwrap();
        let loaded = load_repo_branch_prefix_settings(&repo_id).unwrap();
        assert_eq!(loaded.branch_prefix_type, None);
        assert_eq!(loaded.branch_prefix_custom, None);

        // Setting Custom persists both type and custom string.
        update_repository_branch_prefix(&repo_id, Some(BranchPrefixType::Custom), Some("repo/"))
            .unwrap();
        let updated = load_repo_branch_prefix_settings(&repo_id).unwrap();
        assert_eq!(updated.branch_prefix_type, Some(BranchPrefixType::Custom));
        assert_eq!(updated.branch_prefix_custom.as_deref(), Some("repo/"));
        let listed = list_repositories().unwrap();
        let listed_repo = listed.iter().find(|r| r.id == repo_id).unwrap();
        assert_eq!(
            listed_repo.branch_prefix_type,
            Some(BranchPrefixType::Custom),
        );
        assert_eq!(listed_repo.branch_prefix_custom.as_deref(), Some("repo/"));

        // Switching back to Username clears the now-stale custom string.
        update_repository_branch_prefix(&repo_id, Some(BranchPrefixType::Username), None).unwrap();
        let username = load_repo_branch_prefix_settings(&repo_id).unwrap();
        assert_eq!(
            username.branch_prefix_type,
            Some(BranchPrefixType::Username)
        );
        assert_eq!(username.branch_prefix_custom, None);

        // None also clears the custom column.
        update_repository_branch_prefix(&repo_id, Some(BranchPrefixType::None), Some("ignored"))
            .unwrap();
        let none = load_repo_branch_prefix_settings(&repo_id).unwrap();
        assert_eq!(none.branch_prefix_type, Some(BranchPrefixType::None));
        assert_eq!(none.branch_prefix_custom, None);

        // Passing None as the type clears the column entirely.
        update_repository_branch_prefix(&repo_id, None, Some("garbage/")).unwrap();
        let cleared = load_repo_branch_prefix_settings(&repo_id).unwrap();
        assert_eq!(cleared.branch_prefix_type, None);
        assert_eq!(cleared.branch_prefix_custom, None);
    }

    #[test]
    fn repo_preferences_round_trips_review() {
        let env = crate::testkit::TestEnv::new("repos-prefs-review");
        let repo = ResolvedRepositoryInput {
            name: "review-repo".to_string(),
            normalized_root_path: env.root.join("review-repo").display().to_string(),
            remote: None,
            remote_url: None,
            default_branch: "main".to_string(),
            forge_provider: None,
        };
        let repo_id = insert_repository(&repo).unwrap();

        // Default load returns None for the new field.
        let initial = load_repo_preferences(&repo_id).unwrap();
        assert_eq!(initial.review, None);

        // Round-trip a non-empty review prompt.
        let prefs = RepoPreferences {
            review: Some("Focus on SQL injections and missing tests.".to_string()),
            ..RepoPreferences::default()
        };
        update_repo_preferences(&repo_id, &prefs).unwrap();

        let loaded = load_repo_preferences(&repo_id).unwrap();
        assert_eq!(
            loaded.review.as_deref(),
            Some("Focus on SQL injections and missing tests.")
        );
        // Other prompt slots remain untouched.
        assert_eq!(loaded.create_pr, None);
        assert_eq!(loaded.fix_errors, None);

        // Whitespace-only override is normalized back to None.
        let blanked = RepoPreferences {
            review: Some("   ".to_string()),
            ..RepoPreferences::default()
        };
        update_repo_preferences(&repo_id, &blanked).unwrap();
        let cleared = load_repo_preferences(&repo_id).unwrap();
        assert_eq!(cleared.review, None);
    }
}
