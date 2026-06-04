//! HTTP RPC dispatch.
//!
//! Maps a command name + JSON args to the same `#[tauri::command]` functions
//! the desktop webview calls, returning a JSON value (or the command's
//! `CommandError`, which serialises as `{ code, message }`). Reusing the
//! command functions — not re-implementing them — is what keeps desktop and
//! browser behaviour identical.
//!
//! Scope: the read commands the frontend fires on cold boot to first render of
//! the workspace sidebar (see the companion plan doc). Write/streaming/mutation
//! commands are added in later slices. Every command wired here is free of
//! `tauri::State` / `Channel`, so no Tauri context is needed to call it.

use serde::Serialize;
use serde_json::Value;

use crate::commands as cmd;
use crate::error::CommandError;

/// Dispatch a single RPC call. `args` is the parsed JSON request body (or
/// `Value::Null` when there is no body).
pub async fn dispatch(command: &str, args: Value) -> Result<Value, CommandError> {
    match command {
        // Cold-boot reads (no args).
        "get_app_settings" => to_value(cmd::settings_commands::get_app_settings().await?),
        "list_workspace_groups" => {
            to_value(cmd::workspace_commands::list_workspace_groups().await?)
        }
        "list_archived_workspaces" => {
            to_value(cmd::workspace_commands::list_archived_workspaces().await?)
        }
        "list_repositories" => to_value(cmd::repository_commands::list_repositories().await?),
        "list_agent_model_sections" => to_value(crate::agents::list_agent_model_sections().await?),
        "list_provider_capabilities" => {
            to_value(crate::agents::list_provider_capabilities().await?)
        }
        "detect_installed_editors" => to_value(cmd::editors::detect_installed_editors().await?),
        "get_data_info" => to_value(crate::service::get_data_info().map_err(CommandError::from)?),

        // Query-cache persistence (React Query persister).
        "read_query_cache" => {
            to_value(cmd::system_commands::read_query_cache(arg_string(&args, "key")?).await?)
        }
        "write_query_cache" => to_value(
            cmd::system_commands::write_query_cache(
                arg_string(&args, "key")?,
                arg_string(&args, "value")?,
            )
            .await?,
        ),
        "delete_query_cache" => {
            to_value(cmd::system_commands::delete_query_cache(arg_string(&args, "key")?).await?)
        }

        other => Err(anyhow::anyhow!("Unknown companion command: {other}").into()),
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, CommandError> {
    serde_json::to_value(value).map_err(|e| anyhow::anyhow!(e).into())
}

/// Extract a required string argument from the JSON body.
fn arg_string(args: &Value, key: &str) -> Result<String, CommandError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("Missing required argument: {key}").into())
}
