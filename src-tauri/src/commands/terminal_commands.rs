use tauri::ipc::Channel;
use tauri::State;

use crate::repos;
use crate::workspace::scripts::{ScriptContext, ScriptEvent, ScriptProcessManager};

use super::common::CmdResult;

/// Internal `script_type` namespace for Terminal-tab PTY sessions.
///
/// The `ScriptProcessManager` keys processes by `(repo_id, script_type,
/// workspace_id)`. To support multiple concurrent terminals per workspace
/// (each Terminal sub-tab is one) without changing the manager's key shape,
/// we encode the per-instance UUID into the script_type as
/// `"terminal:<instance_id>"`. Setup/Run still use the bare `"setup"` and
/// `"run"` strings, so they're unaffected.
fn make_script_type(instance_id: &str) -> String {
    format!("terminal:{instance_id}")
}

/// Spawn a blank interactive shell ($SHELL -i -l) on a fresh PTY in the
/// workspace directory and stream its output to the frontend over `channel`.
///
/// The shell stays alive until the user types `exit`, the process tree dies,
/// or the frontend invokes `stop_terminal`. Nothing is persisted to disk —
/// closing the app discards the session entirely.
#[tauri::command]
pub async fn spawn_terminal(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    instance_id: String,
    channel: Channel<ScriptEvent>,
) -> CmdResult<()> {
    let (repo, workspace) = tauri::async_runtime::spawn_blocking({
        let repo_id = repo_id.clone();
        let ws_id = workspace_id.clone();
        move || -> anyhow::Result<(
            repos::RepositoryRecord,
            Option<crate::models::workspaces::WorkspaceRecord>,
        )> {
            let repo = repos::load_repository_by_id(&repo_id)?
                .ok_or_else(|| anyhow::anyhow!("Repository not found: {repo_id}"))?;
            let ws = crate::models::workspaces::load_workspace_record_by_id(&ws_id)?;
            Ok((repo, ws))
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    // Workspace path is required — Terminal tabs only ever spawn inside an
    // active workspace. Fall back to the repo root only if, for some reason,
    // we couldn't resolve the workspace directory.
    let workspace_root = workspace
        .as_ref()
        .and_then(|ws| crate::workspace::helpers::workspace_path(ws).ok());
    let working_dir = workspace_root
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo.root_path.clone());

    // See script_commands.rs for the rationale — embedded terminals
    // share the same per-workspace HELMOR_PORT range as the run/setup
    // scripts so a `npm run dev` typed into the terminal binds the
    // same ports the script docs reference.
    let port_range = workspace.as_ref().and_then(|ws| {
        match crate::workspace::port_allocation::ensure_workspace_port_range(&ws.id) {
            Ok(range) => range,
            Err(error) => {
                tracing::warn!(
                    workspace_id = %ws.id,
                    %error,
                    "Failed to allocate workspace port range; skipping HELMOR_PORT env vars"
                );
                None
            }
        }
    });

    let context = ScriptContext {
        root_path: repo.root_path.clone(),
        workspace_path: Some(working_dir.clone()),
        workspace_name: workspace.as_ref().map(|ws| ws.directory_name.clone()),
        default_branch: repo.default_branch.clone(),
        port_base: port_range.map(|r| r.base),
        port_count: port_range.map(|r| r.count),
    };
    let mgr = manager.inner().clone();
    let script_type = make_script_type(&instance_id);

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = crate::workspace::scripts::run_terminal_session(
            &mgr,
            &repo_id,
            &script_type,
            Some(&workspace_id),
            &working_dir,
            &context,
            channel.clone(),
            None,
        ) {
            let _ = channel.send(ScriptEvent::Error {
                message: e.to_string(),
            });
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_terminal(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    instance_id: String,
) -> CmdResult<bool> {
    let key = (repo_id, make_script_type(&instance_id), Some(workspace_id));
    Ok(manager.kill(&key))
}

#[tauri::command]
pub async fn write_terminal_stdin(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    instance_id: String,
    data: String,
) -> CmdResult<bool> {
    let key = (repo_id, make_script_type(&instance_id), Some(workspace_id));
    Ok(manager.write_stdin(&key, data.as_bytes())?)
}

#[tauri::command]
pub async fn resize_terminal(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<bool> {
    let key = (repo_id, make_script_type(&instance_id), Some(workspace_id));
    Ok(manager.resize(&key, cols, rows)?)
}
