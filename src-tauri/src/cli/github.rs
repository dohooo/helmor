//! `helmor github pr` — workspace-scoped PR operations. Auth lives in the
//! bundled `gh` CLI auth state; Helmor binds the right account
//! per-repo automatically.

use anyhow::Result;

use crate::github_pr;
use crate::service;
use crate::ui_sync::UiMutationEvent;

use super::args::{Cli, GithubAction, GithubPrAction};
use super::{notify_ui_event, output};

pub fn dispatch(action: &GithubAction, cli: &Cli) -> Result<()> {
    match action {
        GithubAction::Pr { action } => pr_dispatch(action, cli),
    }
}

fn pr_dispatch(action: &GithubPrAction, cli: &Cli) -> Result<()> {
    match action {
        GithubPrAction::Show { workspace_ref } => pr_show(workspace_ref, cli),
        GithubPrAction::Status { workspace_ref } => pr_status(workspace_ref, cli),
        GithubPrAction::Merge { workspace_ref } => pr_merge(workspace_ref, cli),
        GithubPrAction::Close { workspace_ref } => pr_close(workspace_ref, cli),
    }
}

fn pr_show(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let pr = github_pr::lookup_workspace_pr(&id)?;
    output::print(cli, &pr, |value| match value {
        Some(pr) => format!(
            "#{} {}\nURL:    {}\nState:  {}{}",
            pr.number,
            pr.title,
            pr.url,
            pr.state,
            if pr.is_merged { " (merged)" } else { "" },
        ),
        None => "No PR linked to this workspace.".to_string(),
    })
}

fn pr_status(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let status = github_pr::lookup_workspace_pr_action_status(&id)?;
    output::print(cli, &status, |s| format!("{s:?}"))
}

fn pr_merge(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let pr = github_pr::merge_workspace_pr(&id)?;
    notify_ui_event(UiMutationEvent::WorkspaceChangeRequestChanged {
        workspace_id: id.clone(),
    });
    output::print(cli, &pr, |value| match value {
        Some(pr) => format!("Merged PR #{}: {}", pr.number, pr.url),
        None => "No PR to merge.".to_string(),
    })
}

fn pr_close(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let pr = github_pr::close_workspace_pr(&id)?;
    notify_ui_event(UiMutationEvent::WorkspaceChangeRequestChanged {
        workspace_id: id.clone(),
    });
    output::print(cli, &pr, |value| match value {
        Some(pr) => format!("Closed PR #{}: {}", pr.number, pr.url),
        None => "No PR to close.".to_string(),
    })
}
