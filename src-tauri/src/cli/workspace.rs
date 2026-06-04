//! `helmor workspace` — workspace CRUD, git, archive, linked dirs.

use anyhow::{bail, Context, Result};

use crate::git_ops;
use crate::models::workspaces as workspace_models;
use crate::service;
use crate::ui_sync::UiMutationEvent;
use crate::workspace::ship_actions::{
    run_workspace_ship_action, WorkspaceShipActionKind, WorkspaceShipActionResult,
};
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
        WorkspaceAction::Stack { workspace_ref } => stack(workspace_ref, cli),
        WorkspaceAction::New { repo, parent } => new(repo.as_deref(), parent.as_deref(), cli),
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

fn run_action(workspace_ref: &str, action: WorkspaceShipAction, cli: &Cli) -> Result<()> {
    let result = run_workspace_ship_action(workspace_ref, action.into())?;
    notify_ui_events(result.ui_events());

    match result {
        WorkspaceShipActionResult::Direct {
            action,
            workspace_id,
            result,
        } => {
            let action_label = action.cli_label();
            let verb = match action {
                WorkspaceShipActionKind::MergePr => "Merged change request for",
                WorkspaceShipActionKind::PullLatest => "Pulled latest into",
                _ => unreachable!("agent action returned as direct action"),
            };
            output::print(
                cli,
                &serde_json::json!({
                    "ok": true,
                    "action": action_label,
                    "workspaceId": workspace_id,
                    "result": result,
                }),
                |_| format!("{verb} workspace {workspace_id}"),
            )
        }
        WorkspaceShipActionResult::Dispatched {
            action,
            workspace_id,
            dispatch,
        } => {
            let action_label = action.cli_label();
            output::print(
                cli,
                &serde_json::json!({
                    "ok": true,
                    "action": action_label,
                    "workspaceId": workspace_id,
                    "sessionId": dispatch.session_id,
                    "dispatched": true,
                    "provider": dispatch.provider,
                    "model": dispatch.model,
                }),
                |_| {
                    format!(
                        "Dispatched `{action_label}` to workspace {ws_id} (session {})",
                        dispatch.session_id,
                        ws_id = workspace_id,
                    )
                },
            )
        }
    }
}

impl From<WorkspaceShipAction> for WorkspaceShipActionKind {
    fn from(value: WorkspaceShipAction) -> Self {
        match value {
            WorkspaceShipAction::MergePr => Self::MergePr,
            WorkspaceShipAction::PullLatest => Self::PullLatest,
            WorkspaceShipAction::CommitAndPush => Self::CommitAndPush,
            WorkspaceShipAction::CreatePr => Self::CreatePr,
            WorkspaceShipAction::FixErrors => Self::FixErrors,
            WorkspaceShipAction::ResolveConflicts => Self::ResolveConflicts,
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

#[derive(serde::Serialize)]
struct StackSpecLayer {
    pr: String,
    title: String,
    state: String,
    ws: String,
}

/// JSON shape matching the stacked-pr renderer's input (layers tip → root),
/// so `helmor workspace stack <ws> --json | render_stack.py -` draws the
/// canonical diagram with no second source of truth.
#[derive(serde::Serialize)]
struct StackSpec {
    name: String,
    repo: String,
    base: String,
    layers: Vec<StackSpecLayer>,
}

/// Build the render spec from a root→tip stack chain. `None` for an empty
/// chain (workspace not found). Pure — unit-tested below.
fn build_stack_spec(chain: &[workspace_models::StackLayer]) -> Option<StackSpec> {
    let root = chain.first()?;
    Some(StackSpec {
        name: root.directory_name.clone(),
        repo: root.repo_name.clone(),
        base: root
            .intended_target_branch
            .clone()
            .unwrap_or_else(|| "main".to_string()),
        layers: chain
            .iter()
            .rev() // tip → root, matching the render spec
            .map(|layer| StackSpecLayer {
                pr: layer
                    .pr_url
                    .as_deref()
                    .and_then(|url| url.rsplit('/').next())
                    .filter(|segment| !segment.is_empty())
                    .unwrap_or_default()
                    .to_string(),
                title: layer
                    .title
                    .clone()
                    .unwrap_or_else(|| layer.directory_name.clone()),
                state: layer.pr_sync_state.as_str().to_string(),
                ws: layer.directory_name.clone(),
            })
            .collect(),
    })
}

fn stack(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let chain = workspace_models::load_workspace_stack(&id)?; // root → tip
    let Some(spec) = build_stack_spec(&chain) else {
        bail!("Workspace not found: {workspace_ref}");
    };

    output::print(cli, &spec, |s| {
        let mut out = format!(
            "stack: {} · {} · {} PR{}\n",
            s.name,
            s.repo,
            s.layers.len(),
            if s.layers.len() == 1 { "" } else { "s" },
        );
        for (index, layer) in s.layers.iter().enumerate() {
            let pr = if layer.pr.is_empty() {
                "—".to_string()
            } else {
                format!("#{}", layer.pr)
            };
            let head = if index == 0 { "    ← HEAD" } else { "" };
            out.push_str(&format!(
                "  {pr}  {ws}  [{state}]  {title}{head}\n",
                ws = layer.ws,
                state = layer.state,
                title = layer.title,
            ));
        }
        out.push_str(&format!("  └ base: {}", s.base));
        out
    })
}

fn new(repo: Option<&str>, parent: Option<&str>, cli: &Cli) -> Result<()> {
    let response = match parent {
        Some(parent_ref) => {
            let parent_id = service::resolve_workspace_ref(parent_ref)?;
            service::create_stacked_workspace_impl(&parent_id)?
        }
        None => {
            let repo_ref = repo.ok_or_else(|| {
                anyhow::anyhow!(
                    "Provide --repo <repo> or --parent <workspace> to create a workspace"
                )
            })?;
            let repo_id = service::resolve_repo_ref(repo_ref)?;
            service::create_workspace_from_repo_impl(&repo_id)?
        }
    };
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

    #[test]
    fn workspace_ship_action_maps_to_shared_action_kind() {
        let cases = [
            (
                WorkspaceShipAction::MergePr,
                WorkspaceShipActionKind::MergePr,
            ),
            (
                WorkspaceShipAction::PullLatest,
                WorkspaceShipActionKind::PullLatest,
            ),
            (
                WorkspaceShipAction::CommitAndPush,
                WorkspaceShipActionKind::CommitAndPush,
            ),
            (
                WorkspaceShipAction::CreatePr,
                WorkspaceShipActionKind::CreatePr,
            ),
            (
                WorkspaceShipAction::FixErrors,
                WorkspaceShipActionKind::FixErrors,
            ),
            (
                WorkspaceShipAction::ResolveConflicts,
                WorkspaceShipActionKind::ResolveConflicts,
            ),
        ];

        for (cli_action, shared_action) in cases {
            assert_eq!(WorkspaceShipActionKind::from(cli_action), shared_action);
        }
    }

    #[test]
    fn build_stack_spec_orders_tip_to_root_and_parses_pr() {
        use crate::workspace_pr_sync::PrSyncState;
        use crate::workspace_status::WorkspaceStatus;

        let layer =
            |id: &str, ws: &str, parent: Option<&str>, pr_url: Option<&str>, state: PrSyncState| {
                workspace_models::StackLayer {
                    id: id.to_string(),
                    repo_name: "helmor".to_string(),
                    directory_name: ws.to_string(),
                    title: None,
                    branch: Some(format!("demo/{ws}")),
                    intended_target_branch: Some("main".to_string()),
                    pr_sync_state: state,
                    pr_url: pr_url.map(str::to_string),
                    status: WorkspaceStatus::InProgress,
                    parent_workspace_id: parent.map(str::to_string),
                }
            };

        // chain is root -> tip
        let chain = vec![
            layer(
                "a",
                "theme-schema",
                None,
                Some("https://github.com/o/r/pull/481"),
                PrSyncState::Merged,
            ),
            layer(
                "b",
                "theme-api",
                Some("a"),
                Some("https://github.com/o/r/pull/482"),
                PrSyncState::Open,
            ),
            layer("c", "theme-ui", Some("b"), None, PrSyncState::None),
        ];
        let spec = build_stack_spec(&chain).expect("non-empty chain");

        assert_eq!(spec.name, "theme-schema");
        assert_eq!(spec.repo, "helmor");
        assert_eq!(spec.base, "main");
        // Rendered tip -> root.
        let ws: Vec<&str> = spec.layers.iter().map(|layer| layer.ws.as_str()).collect();
        assert_eq!(ws, vec!["theme-ui", "theme-api", "theme-schema"]);
        // Tip has no PR yet; title falls back to the directory name.
        assert_eq!(spec.layers[0].pr, "");
        assert_eq!(spec.layers[0].state, "none");
        assert_eq!(spec.layers[0].title, "theme-ui");
        // PR number parsed from the URL tail; state from pr_sync_state.
        assert_eq!(spec.layers[1].pr, "482");
        assert_eq!(spec.layers[1].state, "open");
        assert_eq!(spec.layers[2].pr, "481");
        assert_eq!(spec.layers[2].state, "merged");

        assert!(build_stack_spec(&[]).is_none());
    }
}
