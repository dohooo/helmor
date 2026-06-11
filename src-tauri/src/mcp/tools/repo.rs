use anyhow::Result;
use serde_json::Value;

use crate::service;
use crate::ui_sync::UiMutationEvent;

use super::super::response::{format_json_response, REPO_COMPACT_FIELDS};
use super::common::{notify_ui_events, required_str};

pub(super) fn tool_repo_list(args: &Value) -> Result<String> {
    let repos = service::list_repositories()?;
    format_json_response(args, &repos, Some(REPO_COMPACT_FIELDS))
}

pub(super) fn tool_repo_add(args: &Value) -> Result<String> {
    let path = required_str(args, "path")?;
    let resp = service::add_repository_from_local_path(path)?;
    let mut events = vec![UiMutationEvent::RepositoryListChanged];
    if let Some(workspace_id) = resp.selected_workspace_id.clone() {
        events.push(UiMutationEvent::WorkspaceChanged { workspace_id });
    }
    notify_ui_events(events);
    format_json_response(args, &resp, None)
}
