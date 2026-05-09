use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::{
    bail_coded, db,
    error::{coded, ErrorCode},
    git_ops, helpers,
    models::workspaces as workspace_models,
    repos,
    workspace_state::{WorkspaceMode, WorkspaceState},
    workspace_status::WorkspaceStatus,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreWorkspaceResponse {
    pub restored_workspace_id: String,
    pub restored_state: WorkspaceState,
    pub selected_workspace_id: String,
    /// Set when the originally archived branch name was already taken at
    /// restore time and the workspace had to be checked out on a `-vN`
    /// suffixed branch instead. The frontend uses this to surface an
    /// informational toast so the rename never happens silently.
    pub branch_rename: Option<BranchRename>,
    pub restored_from_target_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRename {
    pub original: String,
    pub actual: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveWorkspaceResponse {
    pub archived_workspace_id: String,
    pub archived_state: WorkspaceState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceResponse {
    pub created_workspace_id: String,
    pub selected_workspace_id: String,
    pub initial_session_id: String,
    pub created_state: WorkspaceState,
    pub directory_name: String,
    pub branch: String,
}

/// Response from the fast Phase 1 of workspace creation. Returned after
/// the DB row has been inserted but before the git worktree has been
/// materialized on disk. Contains everything the frontend needs to paint
/// the final UI state (directory name, branch, repo scripts) without any
/// placeholders. `state` is always `Initializing` at this point.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareWorkspaceResponse {
    pub workspace_id: String,
    pub initial_session_id: String,
    pub repo_id: String,
    pub repo_name: String,
    pub directory_name: String,
    pub branch: String,
    pub default_branch: String,
    pub state: WorkspaceState,
    /// DB-level repo scripts. After Phase 2 (worktree creation) the frontend
    /// may refetch to pick up any `helmor.json` overrides copied into the
    /// worktree, but for a freshly cloned workspace these match exactly.
    pub repo_scripts: repos::RepoScripts,
    /// CWD the agent CLI should run in for the very first turn. Local mode
    /// fills this with `repo.root_path` (on disk already); worktree mode
    /// returns `None` here — the worktree directory doesn't exist until
    /// Phase 2, so callers MUST wait for `FinalizeWorkspaceResponse
    /// .working_directory`. Returning the cwd alongside the row metadata
    /// lets the start-page submit flow skip the workspaceDetail query
    /// round-trip that previously raced finalize and let the first turn
    /// run with cwd=`/`, writing transcripts into the wrong Claude
    /// project bucket and breaking subsequent resume.
    pub working_directory: Option<String>,
}

/// Response from the slow Phase 2 (git worktree + scaffold + setup probe).
/// The workspace row has been upgraded from `Initializing` to whatever
/// `final_state` reports (usually `Ready` or `SetupPending`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeWorkspaceResponse {
    pub workspace_id: String,
    pub final_state: WorkspaceState,
    /// CWD the agent CLI should run in. Always populated when finalize
    /// succeeds — local mode echoes the repo root, worktree mode returns
    /// the freshly-materialised worktree path. The frontend writes this
    /// onto the pending submit payload before flipping `finalized=true`.
    pub working_directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateRestoreResponse {
    /// Set when the workspace's `intended_target_branch` no longer exists
    /// on the repo's current remote. The frontend should confirm before
    /// proceeding, offering `suggested_branch` as the replacement.
    pub target_branch_conflict: Option<TargetBranchConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetBranchConflict {
    pub current_branch: String,
    pub suggested_branch: String,
    pub remote: String,
}

/// Phase 1 of workspace creation: all the fast (<20ms total) preparatory
/// work. Validates the source repo, allocates a unique directory name,
/// computes the branch name, inserts the initializing DB row + initial
/// session, and loads repo-level scripts. Returns the full metadata the
/// frontend needs to paint the final UI state.
///
/// Phase 2 (`finalize_workspace_from_repo_impl`) creates the actual git
/// worktree on disk and flips the workspace row from `Initializing` to
/// `Ready` / `SetupPending`. It can run in the background while the UI
/// already shows the workspace.
pub fn prepare_workspace_from_repo_impl(
    repo_id: &str,
    source_branch: Option<&str>,
    initial_status: WorkspaceStatus,
) -> Result<PrepareWorkspaceResponse> {
    let repository = repos::load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    git_ops::ensure_git_repository(&repo_root)?;

    let remote = repository
        .remote
        .clone()
        .unwrap_or_else(|| "origin".to_string());

    if !git_ops::has_remote(&repo_root, &remote)? {
        bail!(
            "Repository \"{}\" has no remote \"{remote}\". Workspaces require a remote to branch from.",
            repository.name
        );
    }

    let directory_name = helpers::allocate_directory_name_for_repo(repo_id)?;
    let branch_settings = crate::repos::load_repo_branch_prefix_settings(repo_id)?;
    let branch = helpers::branch_name_for_directory(&directory_name, &branch_settings);
    // Picker selection (or repo default). Stored as both
    // `initialization_parent_branch` and `intended_target_branch`
    // (branch from X → merge back to X). Phase 2 uses init_parent as start_ref.
    let base_branch = source_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            repository
                .default_branch
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "main".to_string());
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let timestamp = db::current_timestamp()?;

    workspace_models::insert_initializing_workspace_and_session(
        &repository,
        &workspace_id,
        &session_id,
        &directory_name,
        &branch,
        &base_branch,
        initial_status,
        &timestamp,
    )?;

    // `load_repo_scripts` is the single truth source. The worktree
    // doesn't exist yet, but the function knows to fall back to the
    // source repo root's `helmor.json` when the worktree dir is missing
    // — so the frontend gets the correct "missing script" count from
    // the first paint.
    let repo_scripts = match repos::load_repo_scripts(repo_id, Some(&workspace_id)) {
        Ok(scripts) => scripts,
        Err(error) => {
            tracing::warn!(%error, "Failed to load repo scripts during prepare; defaulting to empty");
            repos::RepoScripts {
                setup_script: None,
                run_script: None,
                archive_script: None,
                setup_from_project: false,
                run_from_project: false,
                archive_from_project: false,
                auto_run_setup: true,
                run_script_mode: "concurrent".to_string(),
            }
        }
    };

    Ok(PrepareWorkspaceResponse {
        workspace_id,
        initial_session_id: session_id,
        repo_id: repository.id,
        repo_name: repository.name,
        directory_name,
        branch,
        // Field name is legacy; value is the effective base branch.
        default_branch: base_branch,
        state: WorkspaceState::Initializing,
        repo_scripts,
        // Worktree dir doesn't exist yet — finalize fills this in.
        working_directory: None,
    })
}

/// One-shot local workspace creation. Skips the prepare/finalize split
/// since there's no worktree to create — the workspace operates
/// directly on `repo.root_path`. If the user picked a `source_branch`
/// different from the repo's current HEAD, switches the local repo to
/// it (requires a clean working tree, errors otherwise).
///
/// Returns a `PrepareWorkspaceResponse` shaped identically to the
/// worktree-mode prepare path so the frontend's create flow can reuse
/// the same optimistic-render code. The row is inserted in
/// `Initializing` state and immediately transitioned to `Ready`; the
/// follow-up `finalize_workspace_from_repo` no-ops gracefully.
pub fn prepare_local_workspace_impl(
    repo_id: &str,
    source_branch: Option<&str>,
    initial_status: WorkspaceStatus,
) -> Result<PrepareWorkspaceResponse> {
    let repository = repos::load_repository_by_id(repo_id)?
        .with_context(|| format!("Repository not found: {repo_id}"))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    git_ops::ensure_git_repository(&repo_root)?;

    // Detached HEAD: surface a specific error.
    let current_branch = git_ops::current_branch_name(&repo_root).map_err(|_| {
        anyhow::anyhow!(
            "Repository is in detached HEAD state. Check out a branch first, then try again."
        )
    })?;
    let target_branch = source_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| current_branch.clone());

    // Tracked-only check — `git checkout` is fine with untracked files.
    if target_branch != current_branch
        && !git_ops::tracked_changes_clean(&repo_root)
            .with_context(|| format!("Failed to read working tree status for {repo_id}"))?
    {
        bail!(
            "Local repo has uncommitted tracked changes; commit or stash before switching to `{target_branch}`."
        );
    }

    // Local shares the repo root; empty directory_name is fine.
    let directory_name = String::new();
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let session_id = uuid::Uuid::new_v4().to_string();
    let timestamp = db::current_timestamp()?;

    // DB insert before any git mutation, so partial failures roll back cleanly.
    workspace_models::insert_initializing_workspace_and_session_with_mode(
        &repository,
        &workspace_id,
        &session_id,
        &directory_name,
        &target_branch,
        &target_branch,
        crate::workspace_state::WorkspaceMode::Local,
        initial_status,
        &timestamp,
    )?;

    if target_branch != current_branch {
        if let Err(error) = git_ops::checkout_branch(&repo_root, &target_branch) {
            let _ = workspace_models::delete_workspace_and_session_rows(&workspace_id);
            return Err(error);
        }
    }

    if let Err(error) =
        workspace_models::update_workspace_state(&workspace_id, WorkspaceState::Ready, &timestamp)
    {
        // Clean DB + restore HEAD if we moved it.
        let _ = workspace_models::delete_workspace_and_session_rows(&workspace_id);
        if target_branch != current_branch {
            let _ = git_ops::checkout_branch(&repo_root, &current_branch);
        }
        return Err(error);
    }

    let repo_scripts =
        repos::load_repo_scripts(repo_id, Some(&workspace_id)).unwrap_or_else(|_| {
            repos::RepoScripts {
                setup_script: None,
                run_script: None,
                archive_script: None,
                setup_from_project: false,
                run_from_project: false,
                archive_from_project: false,
                auto_run_setup: false,
                run_script_mode: "concurrent".to_string(),
            }
        });

    Ok(PrepareWorkspaceResponse {
        workspace_id,
        initial_session_id: session_id,
        repo_id: repository.id,
        repo_name: repository.name,
        directory_name,
        branch: target_branch.clone(),
        default_branch: target_branch,
        state: WorkspaceState::Ready,
        repo_scripts,
        // Local mode operates directly on the repo root — already on disk,
        // safe to return immediately so the caller doesn't need to wait
        // for finalize (which is a no-op for local).
        working_directory: Some(repo_root.display().to_string()),
    })
}

/// Phase 2 of workspace creation: creates the git worktree, probes
/// `helmor.json` for a setup script, and
/// upgrades the workspace row from `Initializing` to `Ready` /
/// `SetupPending`. On failure, cleans up the worktree + DB rows so the
/// caller can surface the error without leaving a broken workspace
/// lingering.
pub fn finalize_workspace_from_repo_impl(workspace_id: &str) -> Result<FinalizeWorkspaceResponse> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    // Local workspaces never need worktree materialisation. Short-circuit
    // unconditionally — even an orphaned `Initializing` local row (left by
    // a partially-failed prepare) must not enter the worktree-creation
    // path below, where a failure would route into
    // `cleanup_failed_created_workspace(repo_root, root_path, ...)`.
    if record.mode == WorkspaceMode::Local {
        let working_directory = helpers::workspace_path(&record)?.display().to_string();
        return Ok(FinalizeWorkspaceResponse {
            workspace_id: workspace_id.to_string(),
            final_state: record.state,
            working_directory,
        });
    }

    match record.state {
        WorkspaceState::Initializing => {}
        WorkspaceState::Ready | WorkspaceState::SetupPending => {
            let working_directory = helpers::workspace_path(&record)?.display().to_string();
            return Ok(FinalizeWorkspaceResponse {
                workspace_id: workspace_id.to_string(),
                final_state: record.state,
                working_directory,
            });
        }
        _ => {
            bail!(
                "Workspace {workspace_id} is not in initializing state (current: {})",
                record.state
            );
        }
    }

    let repository = repos::load_repository_by_id(&record.repo_id)?
        .with_context(|| format!("Repository not found: {}", record.repo_id))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    let remote = repository
        .remote
        .clone()
        .unwrap_or_else(|| "origin".to_string());
    // start_ref source: init_parent (Phase 1's stored pick), with
    // repo default as fallback for legacy rows.
    let base_branch = helpers::non_empty(&record.initialization_parent_branch)
        .map(ToOwned::to_owned)
        .or_else(|| {
            record
                .default_branch
                .clone()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "main".to_string());
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;
    let workspace_dir = helpers::workspace_path(&record)?;
    let timestamp = db::current_timestamp()?;
    let mut created_worktree = false;

    let finalize_result = (|| -> Result<FinalizeWorkspaceResponse> {
        if workspace_dir.exists() {
            bail!(
                "Workspace target already exists at {}",
                workspace_dir.display()
            );
        }

        git_ops::ensure_git_repository(&repo_root)?;
        let start_ref = git_ops::default_branch_ref(&remote, &base_branch);
        git_ops::verify_commitish_exists(
            &repo_root,
            &start_ref,
            &format!("Base branch is missing in source repo: {base_branch}"),
        )?;
        match git_ops::create_worktree_from_start_point(
            &repo_root,
            &workspace_dir,
            &branch,
            &start_ref,
        ) {
            Ok(_) => {
                created_worktree = true;
            }
            Err(error) => {
                return Err(error);
            }
        };

        // Defer setup to the frontend inspector: if a script is configured AND
        // the user opted into auto-run, the workspace starts in "setup_pending"
        // and the UI auto-triggers it. Otherwise we go straight to Ready and
        // the user runs setup manually from the inspector when they want.
        let has_setup = match resolve_setup_hook(&repository, &workspace_dir) {
            Ok(Some(s)) if !s.trim().is_empty() => true,
            Ok(_) => false,
            Err(e) => {
                tracing::warn!("Failed to resolve setup hook, skipping: {e:#}");
                false
            }
        };
        let final_state = if has_setup && repository.auto_run_setup {
            WorkspaceState::SetupPending
        } else {
            WorkspaceState::Ready
        };
        workspace_models::update_workspace_state(workspace_id, final_state, &timestamp)?;

        Ok(FinalizeWorkspaceResponse {
            workspace_id: workspace_id.to_string(),
            final_state,
            // Worktree dir was just materialised — safe to hand back.
            working_directory: workspace_dir.display().to_string(),
        })
    })();

    match finalize_result {
        Ok(response) => Ok(response),
        Err(error) => {
            cleanup_failed_created_workspace(
                workspace_id,
                &repo_root,
                &workspace_dir,
                &branch,
                created_worktree,
            );
            Err(error)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveLocalToWorktreeResponse {
    pub workspace_id: String,
    pub directory_name: String,
    pub branch: String,
    pub state: WorkspaceState,
}

/// Move a local-mode workspace into a fresh worktree. The local repo
/// is left completely untouched: its branch, working tree, and
/// uncommitted state stay exactly as they were. The new worktree
/// gets a fresh auto-named branch off the local's HEAD commit, with
/// all uncommitted state (tracked + untracked) carried over. The
/// workspace row's mode flips Local → Worktree (same workspace_id —
/// it's a relocation, not a clone).
///
/// Failure rolls back any partial state we created (worktree dir +
/// new branch) so the user can retry. The local repo never sees a
/// stash push/pop cycle — we use `git stash create` for tracked
/// changes (which doesn't touch the working tree) and a manual
/// `cp -p` for untracked files.
pub fn move_local_workspace_to_worktree_impl(
    workspace_id: &str,
) -> Result<MoveLocalToWorktreeResponse> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.mode != WorkspaceMode::Local {
        bail!(
            "Workspace {workspace_id} is not a local workspace (mode: {})",
            record.mode
        );
    }
    if !record.state.is_operational() {
        bail!(
            "Workspace {workspace_id} is not operational (state: {})",
            record.state
        );
    }

    let repository = repos::load_repository_by_id(&record.repo_id)?
        .with_context(|| format!("Repository not found: {}", record.repo_id))?;
    let repo_root = PathBuf::from(repository.root_path.trim());
    git_ops::ensure_git_repository(&repo_root)?;

    // 1. Capture the local repo's current state (no working-tree mutation).
    let head_branch =
        git_ops::current_branch_name(&repo_root).context("Failed to read repo HEAD branch")?;
    let head_commit = git_ops::run_git(
        [
            "-C",
            repo_root.to_str().unwrap_or_default(),
            "rev-parse",
            "HEAD",
        ],
        None,
    )
    .context("Failed to resolve HEAD commit")?
    .trim()
    .to_string();

    let stash_sha = git_ops::stash_create(&repo_root)?;
    let untracked = git_ops::list_untracked_files(&repo_root).unwrap_or_default();

    // 2. Allocate the new directory + branch name.
    let directory_name = helpers::allocate_directory_name_for_repo(&record.repo_id)?;
    let branch_settings = repos::load_repo_branch_prefix_settings(&record.repo_id)?;
    let new_branch = helpers::branch_name_for_directory(&directory_name, &branch_settings);
    let workspace_dir = crate::data_dir::workspace_dir(&repository.name, &directory_name)?;

    if workspace_dir.exists() {
        bail!(
            "Workspace target already exists at {}",
            workspace_dir.display()
        );
    }

    let mut created_worktree = false;
    let mut copied_untracked: Vec<PathBuf> = Vec::new();

    let result: Result<()> = (|| {
        // 3. Create the worktree from the captured commit.
        git_ops::create_worktree_from_start_point(
            &repo_root,
            &workspace_dir,
            &new_branch,
            &head_commit,
        )?;
        created_worktree = true;

        // 4. Apply tracked + index changes (if any).
        if let Some(sha) = stash_sha.as_deref() {
            git_ops::stash_apply_sha(&workspace_dir, sha)?;
        }

        // 5. Carry over untracked files via `cp -p`.
        for relative in &untracked {
            let src = repo_root.join(relative);
            let dst = workspace_dir.join(relative);
            if let Some(parent) = dst.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("Failed to mkdir -p {}", parent.display()))?;
                }
            }
            // Skip symlinks / specials silently — `cp -p` would carry
            // them but we keep the surface narrow for v1.
            match fs::metadata(&src) {
                Ok(meta) if meta.is_file() => {
                    fs::copy(&src, &dst).with_context(|| {
                        format!(
                            "Failed to copy untracked {} to {}",
                            src.display(),
                            dst.display()
                        )
                    })?;
                    copied_untracked.push(dst);
                }
                _ => continue,
            }
        }

        Ok(())
    })();

    if let Err(error) = result {
        // Rollback: drop everything we touched in the worktree dir.
        if created_worktree {
            for path in &copied_untracked {
                let _ = fs::remove_file(path);
            }
            let _ = git_ops::remove_worktree(&repo_root, &workspace_dir);
            let _ = fs::remove_dir_all(&workspace_dir);
            let _ = git_ops::remove_branch(&repo_root, &new_branch);
        }
        return Err(error);
    }

    // 6. Flip the DB row from local → worktree.
    let timestamp = db::current_timestamp()?;
    workspace_models::convert_to_worktree(
        workspace_id,
        &directory_name,
        &new_branch,
        // target = source (matches the existing "branch from X, PR back to X" default).
        &head_branch,
        &head_branch,
        &timestamp,
    )?;

    // 7. Carry over Claude Code's per-cwd session jsonls so resume keeps
    // working after the cwd flips from the local repo to the worktree.
    // Best-effort: a copy failure here just degrades to a one-shot
    // "empty resume" error on the next turn — not worth rolling back the
    // whole worktree creation. Codex sessions are cwd-independent so
    // they need no migration.
    match crate::models::sessions::list_claude_provider_session_ids(workspace_id) {
        Ok(ids) if !ids.is_empty() => {
            crate::agents::claude_project_files::migrate_session_files(
                &repo_root,
                &workspace_dir,
                &ids,
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(
                workspace_id,
                %error,
                "Failed to list Claude sessions for cwd migration",
            );
        }
    }

    Ok(MoveLocalToWorktreeResponse {
        workspace_id: workspace_id.to_string(),
        directory_name,
        branch: new_branch,
        state: record.state,
    })
}

/// Legacy combined flow. Runs Phase 1 + Phase 2 back-to-back and returns
/// the old-shape response. Used by CLI, MCP, and `add_repository_from_local_path`
/// — all non-UI callers that do not benefit from the prepare/finalize split.
pub fn create_workspace_from_repo_impl(repo_id: &str) -> Result<CreateWorkspaceResponse> {
    let prepared = prepare_workspace_from_repo_impl(repo_id, None, WorkspaceStatus::default())?;
    let finalized = finalize_workspace_from_repo_impl(&prepared.workspace_id)?;

    Ok(CreateWorkspaceResponse {
        created_workspace_id: prepared.workspace_id.clone(),
        selected_workspace_id: prepared.workspace_id,
        initial_session_id: prepared.initial_session_id,
        created_state: finalized.final_state,
        directory_name: prepared.directory_name,
        branch: prepared.branch,
    })
}

/// Remove workspace rows stuck in the `Initializing` state longer than the
/// supplied cutoff. Called at app startup to clean up rows left behind when
/// the process exited mid-finalize (e.g. the app was force-quit while the
/// git worktree was being created). Best-effort: returns the number of
/// rows purged and logs failures rather than propagating them.
pub fn cleanup_orphaned_initializing_workspaces(max_age_seconds: i64) -> Result<usize> {
    let orphans = workspace_models::list_initializing_workspaces_older_than(max_age_seconds)?;
    let orphan_count = orphans.len();

    for orphan in orphans {
        let record = &orphan.record;
        let repo_root_value = record.root_path.as_deref().unwrap_or("").trim();
        let repo_root = PathBuf::from(repo_root_value);
        // Local-mode orphans: never touch the worktree path (it's the
        // user's actual repo). Just remove the DB row.
        if record.mode == crate::workspace_state::WorkspaceMode::Local {
            let _ = workspace_models::delete_workspace_and_session_rows(&record.id);
            tracing::info!(
                workspace_id = %record.id,
                "Cleaned up orphaned initializing local workspace (DB only)",
            );
            continue;
        }
        let workspace_dir = match helpers::workspace_path(record) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    workspace_id = %record.id,
                    error = %error,
                    "Failed to resolve workspace dir for orphan cleanup",
                );
                continue;
            }
        };
        let branch = record.branch.as_deref().unwrap_or("");

        cleanup_failed_created_workspace(
            &record.id,
            &repo_root,
            &workspace_dir,
            branch,
            workspace_dir.exists(),
        );

        tracing::info!(
            workspace_id = %record.id,
            "Cleaned up orphaned initializing workspace",
        );
    }

    Ok(orphan_count)
}

#[derive(Debug, Clone)]
pub struct ArchivePreparedPlan {
    pub workspace_id: String,
    repo_root: PathBuf,
    branch: String,
    workspace_dir: PathBuf,
}

fn is_archive_eligible_state(state: WorkspaceState) -> bool {
    matches!(state, WorkspaceState::Ready | WorkspaceState::SetupPending)
}

/// Resolve the interpreter + single-command flag used to run the archive
/// script. Respects `$SHELL` (falling back to `/bin/sh`) and uses `-c`.
fn archive_shell() -> (String, &'static str) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    (shell, "-c")
}

/// Structured outcome of a single archive-hook invocation. Returned by the
/// testable `run_archive_hook_inner` and collapsed to a log line by the public
/// `run_archive_hook`. Phase 2's cross-platform refactor uses the same enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ArchiveHookOutcome {
    /// Workspace record was not found in the DB.
    WorkspaceMissing,
    /// Repo scripts failed to load (DB error).
    ScriptsLoadFailed,
    /// No archive script is configured — nothing to run.
    NoScript,
    /// The shell exited zero.
    Success,
    /// The shell exited non-zero with the given code (if reported).
    ScriptError { code: Option<i32> },
    /// The shell failed to spawn (binary missing, permissions, etc.).
    SpawnError { message: String },
}

/// Best-effort archive hook. Public wrapper that logs the outcome and discards it.
fn run_archive_hook(workspace_id: &str, workspace_dir: &Path, repo_root: &Path) {
    let outcome = run_archive_hook_inner(workspace_id, workspace_dir, repo_root);
    match outcome {
        ArchiveHookOutcome::Success => {
            tracing::info!(workspace_id, "Archive hook succeeded");
        }
        ArchiveHookOutcome::ScriptError { code } => {
            tracing::warn!(workspace_id, code = ?code, "Archive hook exited with error");
        }
        ArchiveHookOutcome::SpawnError { message } => {
            tracing::warn!(workspace_id, error = %message, "Archive hook failed to spawn");
        }
        ArchiveHookOutcome::NoScript
        | ArchiveHookOutcome::WorkspaceMissing
        | ArchiveHookOutcome::ScriptsLoadFailed => {
            // Silent no-ops by design.
        }
    }
}

/// Testable inner implementation. Returns a typed outcome without logging so
/// tests can assert on it deterministically.
pub(crate) fn run_archive_hook_inner(
    workspace_id: &str,
    workspace_dir: &Path,
    repo_root: &Path,
) -> ArchiveHookOutcome {
    let record = match workspace_models::load_workspace_record_by_id(workspace_id) {
        Ok(Some(r)) => r,
        _ => return ArchiveHookOutcome::WorkspaceMissing,
    };
    let scripts = match repos::load_repo_scripts(&record.repo_id, Some(workspace_id)) {
        Ok(s) => s,
        Err(_) => return ArchiveHookOutcome::ScriptsLoadFailed,
    };
    let script = match scripts.archive_script.filter(|s| !s.trim().is_empty()) {
        Some(s) => s,
        None => return ArchiveHookOutcome::NoScript,
    };

    let (shell, shell_flag) = archive_shell();
    tracing::info!(workspace_id, script = %script, shell = %shell, "Running archive hook");

    let status = Command::new(&shell)
        .arg(shell_flag)
        .arg(&script)
        .current_dir(workspace_dir)
        .env("HELMOR_ROOT_PATH", repo_root.display().to_string())
        .env("HELMOR_WORKSPACE_PATH", workspace_dir.display().to_string())
        .env("HELMOR_WORKSPACE_NAME", &record.directory_name)
        .env(
            "HELMOR_DEFAULT_BRANCH",
            record.default_branch.as_deref().unwrap_or("main"),
        )
        .status();

    match status {
        Ok(s) if s.success() => ArchiveHookOutcome::Success,
        Ok(s) => ArchiveHookOutcome::ScriptError { code: s.code() },
        Err(e) => ArchiveHookOutcome::SpawnError {
            message: e.to_string(),
        },
    }
}

pub fn prepare_archive_plan(workspace_id: &str) -> Result<ArchivePreparedPlan> {
    let timing = std::time::Instant::now();
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if !is_archive_eligible_state(record.state) {
        bail!(
            "Workspace is not archive-ready: {workspace_id} (state: {})",
            record.state
        );
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;
    if !repo_root.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Archive source repository is missing at {}",
            repo_root.display()
        );
    }

    let workspace_dir = helpers::workspace_path(&record)?;
    if !workspace_dir.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Archive source workspace is missing at {}",
            workspace_dir.display()
        );
    }

    tracing::debug!(
        workspace_id,
        elapsed_ms = timing.elapsed().as_millis(),
        "Archive: prepare_archive_plan finished"
    );
    Ok(ArchivePreparedPlan {
        workspace_id: workspace_id.to_string(),
        repo_root,
        branch,
        workspace_dir,
    })
}

pub fn validate_archive_workspace(workspace_id: &str) -> Result<()> {
    prepare_archive_plan(workspace_id).map(|_| ())
}

pub fn archive_workspace_impl(workspace_id: &str) -> Result<ArchiveWorkspaceResponse> {
    // Local workspaces: archive is purely a DB state flip. We MUST NOT
    // touch the worktree (it's the user's repo) or delete the branch
    // (the user / other local workspaces may still be using it).
    if let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? {
        if record.mode == WorkspaceMode::Local {
            if !is_archive_eligible_state(record.state) {
                bail!(
                    "Workspace is not archive-ready: {workspace_id} (state: {})",
                    record.state
                );
            }
            // Pass an empty archive_commit; the column is informational
            // for the worktree restore flow which doesn't apply to local.
            workspace_models::update_archived_workspace_state(workspace_id, "")?;
            return Ok(ArchiveWorkspaceResponse {
                archived_workspace_id: workspace_id.to_string(),
                archived_state: WorkspaceState::Archived,
            });
        }
    }
    let plan = prepare_archive_plan(workspace_id)?;
    execute_archive_plan(&plan)
}

pub fn execute_archive_plan(plan: &ArchivePreparedPlan) -> Result<ArchiveWorkspaceResponse> {
    let repo_root = &plan.repo_root;
    let branch = &plan.branch;
    let workspace_dir = &plan.workspace_dir;
    let workspace_id = &plan.workspace_id;

    // CRITICAL safety check: for local-mode workspaces, `workspace_dir`
    // IS the user's repo root. The downstream `remove_worktree` would
    // rename + delete the user's repo. Short-circuit to a DB-only flip
    // here BEFORE we touch anything on disk. The frontend's
    // `archive_workspace_impl` already does this; this is a second
    // line of defence for the kanban / queue path that goes through
    // `prepare_archive_plan` + this function.
    if let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? {
        if record.mode == WorkspaceMode::Local {
            workspace_models::update_archived_workspace_state(workspace_id, "")?;
            return Ok(ArchiveWorkspaceResponse {
                archived_workspace_id: workspace_id.clone(),
                archived_state: WorkspaceState::Archived,
            });
        }
    }

    let timing = std::time::Instant::now();
    if !repo_root.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Archive source repository is missing at {}",
            repo_root.display()
        );
    }
    let git_started = std::time::Instant::now();
    let archive_commit = git_ops::current_workspace_head_commit(workspace_dir)?;
    git_ops::verify_commit_exists(repo_root, &archive_commit)?;
    tracing::debug!(
        workspace_id,
        elapsed_ms = git_started.elapsed().as_millis(),
        "Archive: HEAD resolve + verify finished"
    );

    // Run archive script (best-effort, don't block archive on script failure).
    let hook_started = std::time::Instant::now();
    run_archive_hook(workspace_id, workspace_dir, repo_root);
    tracing::info!(
        workspace_id,
        elapsed_ms = hook_started.elapsed().as_millis(),
        "Archive hook finished"
    );

    let remove_worktree_started = std::time::Instant::now();
    git_ops::remove_worktree(repo_root, workspace_dir)?;
    tracing::info!(
        workspace_id,
        elapsed_ms = remove_worktree_started.elapsed().as_millis(),
        "Archive worktree removal finished"
    );

    let branch_delete_started = std::time::Instant::now();
    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            "-D",
            branch,
        ],
        None,
    )
    .ok();
    tracing::debug!(
        workspace_id,
        elapsed_ms = branch_delete_started.elapsed().as_millis(),
        "Archive: branch delete finished"
    );

    let db_started = std::time::Instant::now();
    if let Err(error) =
        workspace_models::update_archived_workspace_state(workspace_id, &archive_commit)
    {
        cleanup_failed_archive(repo_root, workspace_dir, branch, &archive_commit);
        return Err(error);
    }

    tracing::debug!(
        workspace_id,
        elapsed_ms = db_started.elapsed().as_millis(),
        "Archive: DB state update finished"
    );
    tracing::info!(
        workspace_id,
        elapsed_ms = timing.elapsed().as_millis(),
        "Archive execution finished"
    );

    Ok(ArchiveWorkspaceResponse {
        archived_workspace_id: workspace_id.to_string(),
        archived_state: WorkspaceState::Archived,
    })
}

struct RestorePreflightData {
    repo_root: PathBuf,
    branch: String,
    archive_commit: Option<String>,
    target_branch: String,
    remote: String,
    workspace_dir: PathBuf,
}

fn restore_workspace_preflight(workspace_id: &str) -> Result<RestorePreflightData> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;

    if record.state != WorkspaceState::Archived {
        bail!("Workspace is not archived: {workspace_id}");
    }

    let repo_root = helpers::non_empty(&record.root_path)
        .map(PathBuf::from)
        .with_context(|| format!("Workspace {workspace_id} is missing repo root_path"))?;
    let branch = helpers::non_empty(&record.branch)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Workspace {workspace_id} is missing branch"))?;
    let archive_commit = helpers::non_empty(&record.archive_commit).map(ToOwned::to_owned);
    let target_branch = helpers::non_empty(&record.intended_target_branch)
        .or_else(|| helpers::non_empty(&record.default_branch))
        .unwrap_or("main")
        .to_string();

    let workspace_dir = helpers::workspace_path(&record)?;
    let remote = record.remote.unwrap_or_else(|| "origin".to_string());
    git_ops::ensure_git_repository(&repo_root)?;
    if let Some(archive_commit) = archive_commit.as_deref() {
        git_ops::verify_commit_exists(&repo_root, archive_commit)?;
    }

    Ok(RestorePreflightData {
        repo_root,
        branch,
        archive_commit,
        target_branch,
        remote,
        workspace_dir,
    })
}

pub fn validate_restore_workspace(workspace_id: &str) -> Result<ValidateRestoreResponse> {
    let record = workspace_models::load_workspace_record_by_id(workspace_id)?
        .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
        .with_context(|| format!("Workspace not found: {workspace_id}"))?;
    // Local restore is a pure DB state flip — no git involved, so no
    // target-branch conflict is ever possible.
    if record.mode == WorkspaceMode::Local {
        return Ok(ValidateRestoreResponse {
            target_branch_conflict: None,
        });
    }

    let preflight = restore_workspace_preflight(workspace_id)?;

    let remote = record.remote.unwrap_or_else(|| "origin".to_string());
    let intended = record
        .intended_target_branch
        .filter(|value| !value.trim().is_empty());

    let conflict = if let Some(ref target) = intended {
        let has_any_refs = !git_ops::list_remote_branches(&preflight.repo_root, &remote)
            .unwrap_or_default()
            .is_empty();

        let exists = git_ops::verify_remote_ref_exists(&preflight.repo_root, &remote, target)
            .unwrap_or(false);

        if exists || !has_any_refs {
            None
        } else {
            let repo = crate::repos::load_repository_by_id(&record.repo_id)?
                .with_context(|| format!("Repository not found: {}", record.repo_id))?;
            let suggested = repo.default_branch.unwrap_or_else(|| "main".to_string());
            Some(TargetBranchConflict {
                current_branch: target.clone(),
                suggested_branch: suggested,
                remote,
            })
        }
    } else {
        None
    };

    Ok(ValidateRestoreResponse {
        target_branch_conflict: conflict,
    })
}

pub fn restore_workspace_impl(
    workspace_id: &str,
    target_branch_override: Option<&str>,
) -> Result<RestoreWorkspaceResponse> {
    // Local workspaces aren't materialised as a worktree — restoring
    // one is purely a DB state flip. Skip every git operation (branch
    // creation, worktree creation, archive_commit verification, …)
    // that the worktree path performs.
    {
        let record = workspace_models::load_workspace_record_by_id(workspace_id)?
            .ok_or_else(|| coded(ErrorCode::WorkspaceNotFound))
            .with_context(|| format!("Workspace not found: {workspace_id}"))?;
        if record.state != WorkspaceState::Archived {
            bail!("Workspace is not archived: {workspace_id}");
        }
        if record.mode == WorkspaceMode::Local {
            workspace_models::update_restored_workspace_state(
                workspace_id,
                target_branch_override,
            )?;
            return Ok(RestoreWorkspaceResponse {
                restored_workspace_id: workspace_id.to_string(),
                restored_state: WorkspaceState::Ready,
                selected_workspace_id: workspace_id.to_string(),
                branch_rename: None,
                restored_from_target_branch: None,
            });
        }
    }

    let RestorePreflightData {
        repo_root,
        branch,
        archive_commit,
        target_branch: stored_target_branch,
        remote,
        workspace_dir,
    } = restore_workspace_preflight(workspace_id)?;
    let target_branch = target_branch_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(stored_target_branch.as_str());

    if workspace_dir.exists() {
        // Belt + suspenders against local-mode mis-routing.
        if git_ops::paths_resolve_equal(&repo_root, &workspace_dir) {
            bail!(
                "Refusing to wipe restore target {} — equals repo_root",
                workspace_dir.display()
            );
        }
        std::fs::remove_dir_all(&workspace_dir).with_context(|| {
            format!(
                "Failed to remove existing workspace directory: {}",
                workspace_dir.display()
            )
        })?;
    }

    fs::create_dir_all(workspace_dir.parent().with_context(|| {
        format!(
            "Workspace restore target has no parent: {}",
            workspace_dir.display()
        )
    })?)
    .with_context(|| {
        format!(
            "Failed to create workspace parent directory for {}",
            workspace_dir.display()
        )
    })?;

    let actual_branch = helpers::next_available_branch_name(&repo_root, &branch)?;

    let (start_point, restored_from_target_branch) = match archive_commit.as_deref() {
        Some(commit) => {
            git_ops::verify_commit_exists(&repo_root, commit).with_context(|| {
                format!(
                    "Archive commit {commit} no longer exists in {} \
                     (likely garbage-collected). Cannot restore.",
                    repo_root.display()
                )
            })?;
            (commit.to_string(), None)
        }
        None => (
            resolve_restore_target_start_point(&repo_root, &remote, target_branch)?,
            Some(target_branch.to_string()),
        ),
    };

    git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            &actual_branch,
            &start_point,
        ],
        None,
    )
    .with_context(|| format!("Failed to create branch {actual_branch} from {start_point}"))?;
    let _ = git_ops::run_git(
        [
            "-C",
            &repo_root.display().to_string(),
            "branch",
            "--unset-upstream",
            &actual_branch,
        ],
        None,
    );

    git_ops::create_worktree(&repo_root, &workspace_dir, &actual_branch)?;

    if actual_branch != branch {
        let conn = db::write_conn().map_err(|error| {
            cleanup_failed_restore(&repo_root, &workspace_dir, &actual_branch);
            error.context("Failed to open DB to persist restored branch name")
        })?;
        conn.execute(
            "UPDATE workspaces SET branch = ?1 WHERE id = ?2",
            rusqlite::params![actual_branch, workspace_id],
        )
        .map_err(|error| {
            cleanup_failed_restore(&repo_root, &workspace_dir, &actual_branch);
            anyhow::anyhow!("Failed to persist restored branch name in DB: {error}")
        })?;
    }

    if let Err(error) =
        workspace_models::update_restored_workspace_state(workspace_id, target_branch_override)
    {
        cleanup_failed_restore(&repo_root, &workspace_dir, &actual_branch);
        return Err(error);
    }

    let branch_rename = if actual_branch != branch {
        Some(BranchRename {
            original: branch,
            actual: actual_branch,
        })
    } else {
        None
    };

    Ok(RestoreWorkspaceResponse {
        restored_workspace_id: workspace_id.to_string(),
        restored_state: WorkspaceState::Ready,
        selected_workspace_id: workspace_id.to_string(),
        branch_rename,
        restored_from_target_branch,
    })
}

fn resolve_restore_target_start_point(
    repo_root: &Path,
    remote: &str,
    target_branch: &str,
) -> Result<String> {
    if git_ops::verify_branch_exists(repo_root, target_branch).is_ok() {
        return Ok(target_branch.to_string());
    }

    if git_ops::verify_remote_ref_exists(repo_root, remote, target_branch)? {
        return Ok(format!("{remote}/{target_branch}"));
    }

    bail!(
        "Cannot restore workspace without an archive commit: target branch {target_branch} was not found"
    );
}

fn cleanup_failed_created_workspace(
    workspace_id: &str,
    repo_root: &Path,
    workspace_dir: &Path,
    branch: &str,
    created_worktree: bool,
) {
    // Refuse to touch the source repo even if a caller mis-routed a
    // local-mode record into this worktree-creation cleanup path.
    if created_worktree
        && workspace_dir.exists()
        && !git_ops::paths_resolve_equal(repo_root, workspace_dir)
    {
        let _ = git_ops::remove_worktree(repo_root, workspace_dir);
        let _ = fs::remove_dir_all(workspace_dir);
    }

    if !branch.is_empty() {
        let _ = git_ops::remove_branch(repo_root, branch);
    }
    let _ = workspace_models::delete_workspace_and_session_rows(workspace_id);
}

fn cleanup_failed_restore(repo_root: &Path, workspace_dir: &Path, branch: &str) {
    if !git_ops::paths_resolve_equal(repo_root, workspace_dir) {
        let _ = git_ops::remove_worktree(repo_root, workspace_dir);
        let _ = fs::remove_dir_all(workspace_dir);
    }
    let _ = git_ops::remove_branch(repo_root, branch);
}

fn cleanup_failed_archive(
    repo_root: &Path,
    workspace_dir: &Path,
    branch: &str,
    archive_commit: &str,
) {
    let _ = git_ops::point_branch_to_commit(repo_root, branch, archive_commit);

    if !workspace_dir.exists() {
        let _ = git_ops::create_worktree(repo_root, workspace_dir, branch);
    }
}

/// Resolve the setup script command string from DB or project config.
fn resolve_setup_hook(
    repository: &repos::RepositoryRecord,
    workspace_dir: &Path,
) -> Result<Option<String>> {
    if let Some(script) = repository
        .setup_script
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
    {
        return Ok(Some(script.to_string()));
    }
    load_setup_script_from_project_config(workspace_dir)
}

fn load_setup_script_from_project_config(workspace_dir: &Path) -> Result<Option<String>> {
    let config_path = workspace_dir.join("helmor.json");
    if !config_path.is_file() {
        return Ok(None);
    }
    let contents = fs::read_to_string(&config_path)
        .with_context(|| format!("Failed to read {}", config_path.display()))?;
    let json: Value = serde_json::from_str(&contents)
        .with_context(|| format!("Failed to parse {}", config_path.display()))?;
    Ok(json
        .get("scripts")
        .and_then(|v| v.get("setup"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

#[cfg(test)]
mod tests {
    //! Baseline archive-hook outcome tests. Exercise the enum without requiring
    //! a real workspace in the database — the WorkspaceMissing path is the
    //! easiest to reach deterministically from a unit test.
    use super::*;

    #[test]
    fn archive_hook_inner_returns_workspace_missing_for_unknown_id() {
        let tmp = std::env::temp_dir();
        let outcome = run_archive_hook_inner("nonexistent-workspace-id", &tmp, &tmp);
        // Whatever the DB state, an unknown workspace id must short-circuit to
        // WorkspaceMissing or ScriptsLoadFailed — never spawn a shell or Success.
        assert!(
            matches!(
                outcome,
                ArchiveHookOutcome::WorkspaceMissing | ArchiveHookOutcome::ScriptsLoadFailed
            ),
            "unexpected outcome for unknown workspace id: {outcome:?}"
        );
    }

    #[test]
    fn archive_hook_outcome_debug_is_stable() {
        // Lock the debug representations that show up in logs/test diagnostics.
        assert_eq!(format!("{:?}", ArchiveHookOutcome::Success), "Success");
        assert_eq!(format!("{:?}", ArchiveHookOutcome::NoScript), "NoScript");
        assert_eq!(
            format!("{:?}", ArchiveHookOutcome::ScriptError { code: Some(7) }),
            "ScriptError { code: Some(7) }"
        );
    }

    #[test]
    fn archive_hook_outcome_equality() {
        assert_eq!(
            ArchiveHookOutcome::ScriptError { code: Some(1) },
            ArchiveHookOutcome::ScriptError { code: Some(1) }
        );
        assert_ne!(
            ArchiveHookOutcome::ScriptError { code: Some(1) },
            ArchiveHookOutcome::ScriptError { code: Some(2) }
        );
        assert_ne!(ArchiveHookOutcome::Success, ArchiveHookOutcome::NoScript);
    }
}
