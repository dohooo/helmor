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
        "get_app_settings" => {
            // Redact credential-bearing keys before handing settings to a
            // paired phone: it can't configure them and they'd otherwise land
            // in the browser's localStorage / query cache in plaintext.
            let mut settings = cmd::settings_commands::get_app_settings().await?;
            settings.retain(|key, _| !is_secret_setting_key(key));
            to_value(settings)
        }
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

        // Operate reads — opening a workspace / session (all state-free).
        "get_workspace" => to_value(
            cmd::workspace_commands::get_workspace(arg_string(&args, "workspaceId")?).await?,
        ),
        "list_workspace_sessions" => to_value(
            cmd::session_commands::list_workspace_sessions(arg_string(&args, "workspaceId")?)
                .await?,
        ),
        "list_session_thread_messages" => to_value(
            cmd::session_commands::list_session_thread_messages(
                arg_string(&args, "sessionId")?,
                arg_opt_usize(&args, "tailLimit"),
            )
            .await?,
        ),
        "get_session_context_usage" => to_value(
            cmd::session_commands::get_session_context_usage(arg_string(&args, "sessionId")?)
                .await?,
        ),
        "get_session_codex_goal" => to_value(
            cmd::session_commands::get_session_codex_goal(arg_string(&args, "sessionId")?).await?,
        ),
        "get_session_plan_state" => to_value(
            cmd::session_commands::get_session_plan_state(arg_string(&args, "sessionId")?).await?,
        ),
        "list_session_drafts" => to_value(cmd::session_commands::list_session_drafts().await?),
        "list_workspace_files" => to_value(
            cmd::editor_commands::list_workspace_files(arg_string(&args, "workspaceRootPath")?)
                .await?,
        ),
        "list_editor_files" => to_value(
            cmd::editor_commands::list_editor_files(arg_string(&args, "workspaceRootPath")?)
                .await?,
        ),
        "list_workspace_changes" => to_value(
            cmd::editor_commands::list_workspace_changes(
                arg_string(&args, "workspaceRootPath")?,
                arg_opt_string(&args, "workspaceId"),
            )
            .await?,
        ),
        "read_editor_file" => {
            to_value(cmd::editor_commands::read_editor_file(arg_string(&args, "path")?).await?)
        }
        "stat_editor_file" => {
            to_value(cmd::editor_commands::stat_editor_file(arg_string(&args, "path")?).await?)
        }
        "get_workspace_git_action_status" => to_value(
            cmd::editor_commands::get_workspace_git_action_status(arg_string(
                &args,
                "workspaceId",
            )?)
            .await?,
        ),

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

/// Extract an optional string argument (absent or JSON `null` → `None`).
fn arg_opt_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Extract an optional `usize` argument.
fn arg_opt_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

/// Whether a `settings` key carries a credential we must never hand to a paired
/// device. Matches an explicit list (keys whose JSON *value* embeds a secret)
/// plus a name pattern catching future `*api_key*` / `*token*` / `*secret*`
/// keys. Errs toward over-redaction — a paired phone configures none of these.
fn is_secret_setting_key(key: &str) -> bool {
    const EXPLICIT: &[&str] = &[
        "app.cursor_provider",         // { apiKey, ... }
        "app.claude_custom_providers", // [{ apiKey, ... }]
        "app.agent_proxy",             // proxy credentials
        "app.companion_stable_url",    // registry revocation secret
    ];
    if EXPLICIT.contains(&key) {
        return true;
    }
    let lower = key.to_ascii_lowercase();
    lower.contains("api_key") || lower.contains("token") || lower.contains("secret")
}

#[cfg(test)]
mod tests {
    use super::is_secret_setting_key;

    #[test]
    fn redacts_credential_keys() {
        for key in [
            "app.openai_realtime_api_key",
            "app.cursor_provider",
            "app.claude_custom_providers",
            "app.agent_proxy",
            "app.companion_stable_url",
            "app.some_future_token",
            "app.x_secret",
        ] {
            assert!(is_secret_setting_key(key), "{key} should be redacted");
        }
    }

    #[test]
    fn keeps_non_secret_keys() {
        for key in [
            "app.default_model_id",
            "app.onboarding_completed",
            "app.theme",
            "app.claude_rate_limits",
            "app.codex_rate_limits",
        ] {
            assert!(!is_secret_setting_key(key), "{key} should be kept");
        }
    }
}
