use anyhow::Result;
use serde_json::Value;

mod common;
mod data;
mod repo;
mod send;
mod session;
mod workspace;

pub(super) fn dispatch_tool(name: &str, args: &Value) -> Result<String> {
    match name {
        "helmor_data_info" => data::tool_data_info(args),
        "helmor_repo_list" => repo::tool_repo_list(args),
        "helmor_repo_add" => repo::tool_repo_add(args),
        "helmor_workspace_list" => workspace::tool_workspace_list(args),
        "helmor_workspace_show" => workspace::tool_workspace_show(args),
        "helmor_workspace_create" => workspace::tool_workspace_create(args),
        "helmor_workspace_set_status" => workspace::tool_workspace_set_status(args),
        "helmor_workspace_archive" => workspace::tool_workspace_archive(args),
        "helmor_workspace_permanently_delete" => workspace::tool_workspace_permanently_delete(args),
        "helmor_workspace_run_action" => workspace::tool_workspace_run_action(args),
        "helmor_session_get_messages" => session::tool_session_get_messages(args),
        "helmor_session_list" => session::tool_session_list(args),
        "helmor_session_create" => session::tool_session_create(args),
        "helmor_session_search" => session::tool_session_search(args),
        "helmor_send" => send::tool_send(args),
        _ => anyhow::bail!("Unknown tool: {name}"),
    }
}

#[cfg(test)]
mod tests;
