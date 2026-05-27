use anyhow::Result;
use serde_json::Value;

use crate::ui_sync::UiMutationEvent;
use crate::workspace::ship_actions::WorkspaceShipActionKind;
use crate::workspace::status::WorkspaceStatus;

pub(super) fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Missing required param: {key}"))
}

pub(super) fn bounded_limit(args: &Value, default: usize, max: usize) -> usize {
    args.get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, max))
        .unwrap_or(default)
}

pub(super) fn notify_ui_events(events: impl IntoIterator<Item = UiMutationEvent>) {
    for event in events {
        crate::ui_sync::notify_running_app(event).ok();
    }
}

pub(super) fn workspace_status_matches(status: &WorkspaceStatus, wanted: &str) -> bool {
    status.group_id().eq_ignore_ascii_case(wanted) || status.as_str().eq_ignore_ascii_case(wanted)
}

pub(super) fn parse_workspace_ship_action(action: &str) -> Result<WorkspaceShipActionKind> {
    match action {
        "merge_pr" => Ok(WorkspaceShipActionKind::MergePr),
        "pull_latest" => Ok(WorkspaceShipActionKind::PullLatest),
        "commit_and_push" => Ok(WorkspaceShipActionKind::CommitAndPush),
        "create_pr" => Ok(WorkspaceShipActionKind::CreatePr),
        "fix_errors" => Ok(WorkspaceShipActionKind::FixErrors),
        "resolve_conflicts" => Ok(WorkspaceShipActionKind::ResolveConflicts),
        other => anyhow::bail!(
            "helmor_workspace_run_action: unknown action `{other}`. \
             Valid: merge_pr, pull_latest, commit_and_push, create_pr, \
             fix_errors, resolve_conflicts."
        ),
    }
}
