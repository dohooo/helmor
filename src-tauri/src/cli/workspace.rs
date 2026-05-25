//! `helmor workspace` — workspace CRUD, git, archive, linked dirs.

use anyhow::{bail, Context, Result};

use crate::git_ops;
use crate::models::workspaces as workspace_models;
use crate::service;
use crate::ui_sync::UiMutationEvent;
use crate::workspace_state::WorkspaceState;
use crate::workspace_status::WorkspaceStatus;
use crate::workspaces;

use super::args::{
    BranchAction, Cli, LinkedDirsAction, ReadState, TargetBranchAction, WorkspaceAction,
    WorkspaceShipAction, WorkspaceStatusAction, WorkspaceStatusValue,
};
use super::{notify_ui_event, notify_ui_events, output};

pub fn dispatch(action: &WorkspaceAction, cli: &Cli) -> Result<()> {
    match action {
        WorkspaceAction::List {
            archived,
            status,
            repo_ref,
            pinned,
        } => list(
            *archived,
            status.as_deref(),
            repo_ref.as_deref(),
            *pinned,
            cli,
        ),
        WorkspaceAction::Show { workspace_ref } => show(workspace_ref, cli),
        WorkspaceAction::New { repo } => new(repo, cli),
        WorkspaceAction::Delete { workspace_ref } => delete(workspace_ref, cli),
        WorkspaceAction::Archive { workspace_ref } => archive(workspace_ref, cli),
        WorkspaceAction::Restore {
            workspace_ref,
            target_branch,
        } => restore(workspace_ref, target_branch.as_deref(), cli),
        WorkspaceAction::Status { workspace_ref } => status(workspace_ref, cli),
        WorkspaceAction::Pin { workspace_ref } => pin(workspace_ref, cli),
        WorkspaceAction::Unpin { workspace_ref } => unpin(workspace_ref, cli),
        WorkspaceAction::Mark {
            state,
            workspace_ref,
        } => mark(*state, workspace_ref, cli),
        WorkspaceAction::SetStatus { action } => workspace_status(action, cli),
        WorkspaceAction::Branch { action } => branch(action, cli),
        WorkspaceAction::TargetBranch { action } => target_branch(action, cli),
        WorkspaceAction::Sync { workspace_ref } => sync(workspace_ref, cli),
        WorkspaceAction::Push { workspace_ref } => push(workspace_ref, cli),
        WorkspaceAction::Fetch { workspace_ref } => fetch(workspace_ref, cli),
        WorkspaceAction::LinkedDirs { action } => linked_dirs(action, cli),
        WorkspaceAction::RunAction {
            workspace_ref,
            action,
        } => run_action(workspace_ref, *action, cli),
    }
}

/// Canned prompt that gets dispatched to the workspace agent for the
/// four "agent-driven" ship actions. Identical wording to the GUI's
/// inspector commit-action buttons so the agent sees the same
/// instructions regardless of entry point.
fn canned_ship_prompt(action: WorkspaceShipAction) -> Option<&'static str> {
    match action {
        WorkspaceShipAction::CommitAndPush => Some(
            "Please commit the pending changes and push the branch. Use a concise commit \
             message that describes what changed and why.",
        ),
        WorkspaceShipAction::CreatePr => Some(
            "Please open a pull request for this workspace's branch. Use the existing \
             commit messages to draft a short PR title + description.",
        ),
        WorkspaceShipAction::FixErrors => Some(
            "Please investigate the latest errors and propose a fix. Surface any \
             ambiguity that needs my input before changing code.",
        ),
        WorkspaceShipAction::ResolveConflicts => Some(
            "Please resolve the merge conflicts in this workspace. Walk me through \
             non-trivial decisions before committing.",
        ),
        _ => None,
    }
}

fn run_action(workspace_ref: &str, action: WorkspaceShipAction, cli: &Cli) -> Result<()> {
    let ws_id = service::resolve_workspace_ref(workspace_ref)?;
    match action {
        WorkspaceShipAction::MergePr => {
            let info = crate::forge::merge_workspace_change_request(&ws_id)?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged {
                workspace_id: ws_id.clone(),
            });
            output::print(
                cli,
                &serde_json::json!({
                    "ok": true,
                    "action": "merge-pr",
                    "workspaceId": ws_id,
                    "result": info,
                }),
                |_| format!("Merged change request for workspace {ws_id}"),
            )
        }
        WorkspaceShipAction::PullLatest => {
            let result = workspaces::sync_workspace_with_target_branch(&ws_id)?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged {
                workspace_id: ws_id.clone(),
            });
            output::print(
                cli,
                &serde_json::json!({
                    "ok": true,
                    "action": "pull-latest",
                    "workspaceId": ws_id,
                    "result": result,
                }),
                |_| format!("Pulled latest into workspace {ws_id}"),
            )
        }
        agent_action @ (WorkspaceShipAction::CommitAndPush
        | WorkspaceShipAction::CreatePr
        | WorkspaceShipAction::FixErrors
        | WorkspaceShipAction::ResolveConflicts) => {
            // Dispatch a canned prompt to the workspace's active agent.
            // Mirrors the GUI inspector's commit-action buttons — the
            // user sees the prompt land in the chat history just like
            // a manually-typed message.
            let prompt = canned_ship_prompt(agent_action)
                .context("missing canned prompt for agent ship action")?;
            let params = service::SendMessageParams {
                workspace_ref: ws_id.clone(),
                session_id: None,
                prompt: prompt.to_string(),
                model: None,
                permission_mode: Some("auto".to_string()),
                linked_directories: Vec::new(),
            };
            // Fire-and-forget: we don't stream the agent's reply to the
            // CLI. Just dispatch and return the session id.
            let response = service::send_message(params, &mut |_event| {})?;
            let action_label = match agent_action {
                WorkspaceShipAction::CommitAndPush => "commit-and-push",
                WorkspaceShipAction::CreatePr => "create-pr",
                WorkspaceShipAction::FixErrors => "fix-errors",
                WorkspaceShipAction::ResolveConflicts => "resolve-conflicts",
                _ => unreachable!("guarded by outer match"),
            };
            output::print(
                cli,
                &serde_json::json!({
                    "ok": true,
                    "action": action_label,
                    "workspaceId": ws_id,
                    "sessionId": response.session_id,
                    "dispatched": true,
                }),
                |_| {
                    format!(
                        "Dispatched `{action_label}` to workspace {ws_id} (session {})",
                        response.session_id
                    )
                },
            )
        }
    }
}

fn list(
    archived: bool,
    status: Option<&str>,
    repo_ref: Option<&str>,
    pinned: bool,
    cli: &Cli,
) -> Result<()> {
    if archived {
        let archived = workspaces::list_archived_workspaces()?;
        return output::print(cli, &archived, |rows| {
            if rows.is_empty() {
                "No archived workspaces.".to_string()
            } else {
                rows.iter()
                    .map(|r| {
                        format!(
                            "{}/{}\t{}\t{}",
                            r.repo_name, r.directory_name, r.id, r.title
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        });
    }

    let groups = workspaces::list_workspace_groups()?;
    let repo_filter = match repo_ref {
        Some(r) => Some(service::resolve_repo_ref(r)?),
        None => None,
    };
    let repo_name_filter = match repo_filter.as_ref() {
        Some(id) => service::list_repositories()?
            .into_iter()
            .find(|r| r.id == *id)
            .map(|r| r.name.to_lowercase()),
        None => None,
    };

    // Flatten with a filter pass so the output is a simple, greppable list.
    #[derive(serde::Serialize)]
    struct Row<'a> {
        group: &'a str,
        id: &'a str,
        repo: &'a str,
        directory: &'a str,
        title: &'a str,
        status: String,
        branch: Option<&'a str>,
        pinned: bool,
    }

    let mut rows: Vec<Row> = Vec::new();
    for group in &groups {
        if pinned && group.id != "pinned" {
            continue;
        }
        if let Some(wanted) = status {
            if !group.id.eq_ignore_ascii_case(wanted) {
                continue;
            }
        }
        for r in &group.rows {
            if let Some(name) = &repo_name_filter {
                if r.repo_name.to_lowercase() != *name {
                    continue;
                }
            }
            rows.push(Row {
                group: &group.label,
                id: &r.id,
                repo: &r.repo_name,
                directory: &r.directory_name,
                title: &r.title,
                status: format!("{:?}", r.status),
                branch: r.branch.as_deref(),
                pinned: r.pinned_at.is_some(),
            });
        }
    }

    output::print(cli, &rows, |items| {
        if items.is_empty() {
            "No workspaces.".to_string()
        } else {
            items
                .iter()
                .map(|r| {
                    format!(
                        "{}\t{}/{}\t{}\t{}\t{}",
                        r.id,
                        r.repo,
                        r.directory,
                        r.status,
                        r.branch.unwrap_or("-"),
                        r.title,
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    })
}

fn show(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let detail = service::get_workspace(&id)?;
    output::print(cli, &detail, |d| {
        format!(
            "ID:        {}\n\
             Title:     {}\n\
             Repo:      {}\n\
             Directory: {}\n\
             State:     {:?}\n\
             Branch:    {}\n\
             Target:    {}\n\
             Status:    {:?}\n\
             Remote:    {}\n\
             Sessions:  {}\n\
             Messages:  {}\n\
             PR:        {}",
            d.id,
            d.title,
            d.repo_name,
            d.directory_name,
            d.state,
            d.branch.as_deref().unwrap_or("-"),
            d.intended_target_branch.as_deref().unwrap_or("-"),
            d.status,
            d.remote.as_deref().unwrap_or("-"),
            d.session_count,
            d.message_count,
            d.pr_title.as_deref().unwrap_or("-"),
        )
    })
}

fn new(repo_ref: &str, cli: &Cli) -> Result<()> {
    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let response = service::create_workspace_from_repo_impl(&repo_id)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: response.created_workspace_id.clone(),
        },
    ]);
    if cli.quiet && !cli.json {
        println!("{}", response.created_workspace_id);
        return Ok(());
    }
    output::print(cli, &response, |r| {
        format!(
            "Created workspace: {}\nDirectory:         {}\nBranch:            {}\nState:             {:?}",
            r.created_workspace_id, r.directory_name, r.branch, r.created_state
        )
    })
}

fn delete(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    workspaces::permanently_delete_workspace(&id)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: id.clone(),
        },
    ]);
    output::print_ok(cli, &format!("Deleted workspace {id}"));
    Ok(())
}

fn archive(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let response = workspaces::archive_workspace_impl(&id)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: id.clone(),
        },
    ]);
    output::print(cli, &response, |_| format!("Archived workspace {id}"))
}

fn restore(workspace_ref: &str, target_branch: Option<&str>, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let response = workspaces::restore_workspace_impl(&id, target_branch)?;
    notify_ui_events([
        UiMutationEvent::WorkspaceListChanged,
        UiMutationEvent::WorkspaceChanged {
            workspace_id: id.clone(),
        },
    ]);
    output::print(cli, &response, |_| format!("Restored workspace {id}"))
}

fn status(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let record = workspace_models::load_workspace_record_by_id(&id)?
        .with_context(|| format!("Workspace not found: {id}"))?;
    if record.state == WorkspaceState::Initializing {
        let status = git_ops::WorkspaceGitActionStatus {
            uncommitted_count: 0,
            conflict_count: 0,
            sync_target_branch: record
                .intended_target_branch
                .clone()
                .or_else(|| record.default_branch.clone()),
            sync_status: git_ops::WorkspaceSyncStatus::UpToDate,
            behind_target_count: 0,
            remote_tracking_ref: None,
            ahead_of_remote_count: 0,
            ahead_of_target_count: 0,
            push_status: git_ops::WorkspacePushStatus::Unpublished,
        };
        return output::print(cli, &status, format_status);
    }
    let workspace_dir = crate::workspace::helpers::workspace_path(&record)?;
    let status = git_ops::workspace_action_status(
        &workspace_dir,
        record.remote.as_deref(),
        record
            .intended_target_branch
            .as_deref()
            .or(record.default_branch.as_deref()),
    )?;
    output::print(cli, &status, format_status)
}

fn format_status(s: &git_ops::WorkspaceGitActionStatus) -> String {
    format!(
        "Uncommitted:  {}\n\
         Conflicts:    {}\n\
         Target:       {}\n\
         Behind:       {}\n\
         Ahead remote: {}\n\
         Sync:         {:?}\n\
         Push:         {:?}",
        s.uncommitted_count,
        s.conflict_count,
        s.sync_target_branch.as_deref().unwrap_or("-"),
        s.behind_target_count,
        s.ahead_of_remote_count,
        s.sync_status,
        s.push_status,
    )
}

fn pin(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    workspaces::pin_workspace(&id)?;
    notify_ui_event(UiMutationEvent::WorkspaceChanged {
        workspace_id: id.clone(),
    });
    output::print_ok(cli, &format!("Pinned {id}"));
    Ok(())
}

fn unpin(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    workspaces::unpin_workspace(&id)?;
    notify_ui_event(UiMutationEvent::WorkspaceChanged {
        workspace_id: id.clone(),
    });
    output::print_ok(cli, &format!("Unpinned {id}"));
    Ok(())
}

fn mark(state: ReadState, workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    match state {
        ReadState::Read => workspaces::mark_workspace_read(&id)?,
        ReadState::Unread => workspaces::mark_workspace_unread(&id)?,
    };
    notify_ui_event(UiMutationEvent::WorkspaceChanged {
        workspace_id: id.clone(),
    });
    output::print_ok(cli, &format!("Marked {id} as {state:?}"));
    Ok(())
}

fn workspace_status(action: &WorkspaceStatusAction, cli: &Cli) -> Result<()> {
    match action {
        WorkspaceStatusAction::Set {
            status,
            workspace_ref,
        } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let workspace_status = match status {
                WorkspaceStatusValue::Done => WorkspaceStatus::Done,
                WorkspaceStatusValue::Review => WorkspaceStatus::Review,
                WorkspaceStatusValue::Progress => WorkspaceStatus::InProgress,
                WorkspaceStatusValue::Backlog => WorkspaceStatus::Backlog,
                WorkspaceStatusValue::Canceled => WorkspaceStatus::Canceled,
            };
            workspaces::set_workspace_status(&id, workspace_status)?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged {
                workspace_id: id.clone(),
            });
            output::print_ok(cli, &format!("Workspace status set to {status:?}"));
        }
        WorkspaceStatusAction::Clear { workspace_ref } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            workspaces::set_workspace_status(&id, WorkspaceStatus::InProgress)?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged { workspace_id: id });
            output::print_ok(cli, "Workspace status reset to Progress");
        }
    }
    Ok(())
}

fn branch(action: &BranchAction, cli: &Cli) -> Result<()> {
    match action {
        BranchAction::List { workspace_ref } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let branches = workspaces::list_remote_branches(Some(&id), None)?;
            output::print(cli, &branches, |items| {
                if items.is_empty() {
                    "No remote branches.".to_string()
                } else {
                    items.join("\n")
                }
            })
        }
        BranchAction::Rename {
            workspace_ref,
            new_branch,
        } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            workspaces::rename_workspace_branch(&id, new_branch)?;
            notify_ui_event(UiMutationEvent::WorkspaceGitStateChanged { workspace_id: id });
            output::print_ok(cli, &format!("Renamed branch to {new_branch}"));
            Ok(())
        }
    }
}

fn target_branch(action: &TargetBranchAction, cli: &Cli) -> Result<()> {
    match action {
        TargetBranchAction::Get { workspace_ref } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let detail = service::get_workspace(&id)?;
            let value = detail
                .intended_target_branch
                .or(detail.default_branch)
                .unwrap_or_else(|| "-".to_string());
            output::print(cli, &value, |v| v.clone())
        }
        TargetBranchAction::Set {
            workspace_ref,
            branch,
        } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let response = workspaces::update_intended_target_branch(&id, branch)?;
            notify_ui_event(UiMutationEvent::WorkspaceGitStateChanged { workspace_id: id });
            output::print(cli, &response, |_| format!("Target branch set to {branch}"))
        }
    }
}

fn sync(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let response = workspaces::sync_workspace_with_target_branch(&id)?;
    notify_ui_event(UiMutationEvent::WorkspaceGitStateChanged { workspace_id: id });
    output::print(cli, &response, |r| format!("Sync outcome: {:?}", r.outcome))
}

fn push(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let response = workspaces::push_workspace_to_remote(&id)?;
    notify_ui_event(UiMutationEvent::WorkspaceGitStateChanged {
        workspace_id: id.clone(),
    });
    notify_ui_event(UiMutationEvent::WorkspaceChangeRequestChanged {
        workspace_id: id.clone(),
    });
    output::print(cli, &response, |_| format!("Pushed {id}"))
}

fn fetch(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let response = workspaces::prefetch_remote_refs(Some(&id), None)?;
    notify_ui_event(UiMutationEvent::WorkspaceGitStateChanged { workspace_id: id });
    output::print(cli, &response, |_| "Fetched remote refs".to_string())
}

fn linked_dirs(action: &LinkedDirsAction, cli: &Cli) -> Result<()> {
    match action {
        LinkedDirsAction::List { workspace_ref } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let dirs = workspaces::get_workspace_linked_directories(&id)?;
            output::print(cli, &dirs, |items| {
                if items.is_empty() {
                    "No linked directories.".to_string()
                } else {
                    items.join("\n")
                }
            })
        }
        LinkedDirsAction::Set {
            workspace_ref,
            directories,
        } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let normalized =
                workspaces::set_workspace_linked_directories(&id, directories.clone())?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged { workspace_id: id });
            output::print(cli, &normalized, |items| {
                format!("Linked directories:\n{}", items.join("\n"))
            })
        }
        LinkedDirsAction::Add {
            workspace_ref,
            directory,
        } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let mut existing = workspaces::get_workspace_linked_directories(&id)?;
            if !existing.iter().any(|d| d == directory) {
                existing.push(directory.clone());
            }
            let normalized = workspaces::set_workspace_linked_directories(&id, existing)?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged { workspace_id: id });
            output::print(cli, &normalized, |items| items.join("\n"))
        }
        LinkedDirsAction::Remove {
            workspace_ref,
            directory,
        } => {
            let id = service::resolve_workspace_ref(workspace_ref)?;
            let existing = workspaces::get_workspace_linked_directories(&id)?;
            let before = existing.len();
            let filtered: Vec<String> = existing.into_iter().filter(|d| d != directory).collect();
            if filtered.len() == before {
                bail!("Directory '{directory}' was not linked");
            }
            let normalized = workspaces::set_workspace_linked_directories(&id, filtered)?;
            notify_ui_event(UiMutationEvent::WorkspaceChanged { workspace_id: id });
            output::print(cli, &normalized, |items| items.join("\n"))
        }
        LinkedDirsAction::Candidates { exclude } => {
            let exclude_id = match exclude {
                Some(r) => Some(service::resolve_workspace_ref(r)?),
                None => None,
            };
            let candidates = workspaces::list_candidate_directories(exclude_id.as_deref())?;
            output::print(cli, &candidates, |items| {
                items
                    .iter()
                    .map(|c| format!("{}\t{}\t{}", c.workspace_id, c.title, c.absolute_path))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `canned_ship_prompt` is the canonical wording the agent sees when
    /// the user (or another agent) dispatches a ship-flow action through
    /// the CLI. The exact phrases are part of the surface contract — if
    /// they drift, the GUI's inspector buttons and the CLI / future MCP /
    /// future skill-injection invocations stop saying the same thing.
    /// This test pins the variant mapping AND the load-bearing phrases.

    #[test]
    fn canned_ship_prompt_returns_none_for_inline_actions() {
        // merge-pr and pull-latest execute inline (forge::* / workspaces::*)
        // — they must never produce a canned prompt, otherwise the dispatch
        // path would try to send the prompt to an agent AS WELL as run the
        // inline operation.
        assert!(canned_ship_prompt(WorkspaceShipAction::MergePr).is_none());
        assert!(canned_ship_prompt(WorkspaceShipAction::PullLatest).is_none());
    }

    #[test]
    fn canned_ship_prompt_returns_non_empty_for_agent_actions() {
        for action in [
            WorkspaceShipAction::CommitAndPush,
            WorkspaceShipAction::CreatePr,
            WorkspaceShipAction::FixErrors,
            WorkspaceShipAction::ResolveConflicts,
        ] {
            let prompt = canned_ship_prompt(action)
                .unwrap_or_else(|| panic!("agent action {action:?} missing canned prompt"));
            assert!(
                !prompt.trim().is_empty(),
                "agent action {action:?} has empty canned prompt"
            );
        }
    }

    #[test]
    fn canned_ship_prompt_wording_is_pinned() {
        // Lock the load-bearing phrases so a typo / drift shows up
        // immediately. We don't pin the full string (that would make
        // small editorial tweaks too painful) — just the verbs each
        // action MUST mention.
        let cap = canned_ship_prompt(WorkspaceShipAction::CommitAndPush).unwrap();
        assert!(
            cap.contains("commit"),
            "commit-and-push must mention 'commit': {cap}"
        );
        assert!(
            cap.contains("push"),
            "commit-and-push must mention 'push': {cap}"
        );

        let pr = canned_ship_prompt(WorkspaceShipAction::CreatePr).unwrap();
        assert!(
            pr.to_lowercase().contains("pull request"),
            "create-pr must mention 'pull request': {pr}"
        );

        let fix = canned_ship_prompt(WorkspaceShipAction::FixErrors).unwrap();
        assert!(
            fix.to_lowercase().contains("error"),
            "fix-errors must mention 'error': {fix}"
        );

        let conflicts = canned_ship_prompt(WorkspaceShipAction::ResolveConflicts).unwrap();
        assert!(
            conflicts.to_lowercase().contains("conflict"),
            "resolve-conflicts must mention 'conflict': {conflicts}"
        );
    }
}
