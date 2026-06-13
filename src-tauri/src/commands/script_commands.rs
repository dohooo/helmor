use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::repos::{self, RunAction};
use crate::workspace::scripts::{ScriptContext, ScriptEvent, ScriptProcessManager, ScriptStop};

use super::common::CmdResult;

/// Internal `script_type` namespace for the run script after the multi-action
/// refactor. Process keys for run scripts are `"run:<action_id>"` so the
/// process manager can distinguish per-action lifecycles within the same
/// workspace, and so `kill_others_in_repo` naturally implements per-action
/// exclusive mode by filtering on the full `"run:<id>"` string.
fn run_script_type(action_id: &str) -> String {
    format!("run:{action_id}")
}

struct ResolvedScriptTarget {
    context: ScriptContext,
    working_dir: String,
}

/// Resolve which `RunAction` the caller is targeting.
///
///   - If `action_id` is supplied, look it up by id; error if it's gone.
///   - If `action_id` is None, fall back to the first action in display order
///     (legacy callers that haven't been updated yet).
///
/// Returns the action plus the process key to use for it.
fn resolve_run_target(
    repo_id: &str,
    workspace_id: Option<&str>,
    action_id: Option<&str>,
) -> anyhow::Result<RunAction> {
    let scripts = repos::load_repo_scripts(repo_id, workspace_id)?;
    let action = match action_id {
        Some(id) => scripts
            .run_actions
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| anyhow::anyhow!("Run action not found: {id}"))?,
        None => scripts
            .run_actions
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No run actions configured for repo {repo_id}"))?,
    };
    Ok(action)
}

fn resolve_script_target(
    repo_id: &str,
    workspace_id: Option<&str>,
) -> anyhow::Result<ResolvedScriptTarget> {
    let repo = repos::load_repository_by_id(repo_id)?
        .ok_or_else(|| anyhow::anyhow!("Repository not found: {repo_id}"))?;
    let workspace = match workspace_id {
        Some(id) => crate::models::workspaces::load_workspace_record_by_id(id)?,
        None => None,
    };

    // Run in the workspace directory when available, otherwise repo root.
    let workspace_root = workspace
        .as_ref()
        .and_then(|ws| crate::workspace::helpers::workspace_path(ws).ok());
    let working_dir = workspace_root
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| repo.root_path.clone());

    // Allocate a stable per-workspace port range so HELMOR_PORT /
    // HELMOR_PORT_COUNT can be injected below. Lazy: only allocates if
    // the workspace has no range yet. Best-effort — a DB error here
    // must not block the script run, scripts that don't read
    // HELMOR_PORT continue to work exactly as before.
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

    Ok(ResolvedScriptTarget {
        context: ScriptContext {
            root_path: repo.root_path.clone(),
            workspace_path: Some(working_dir.clone()),
            workspace_name: workspace.as_ref().map(|ws| ws.directory_name.clone()),
            default_branch: repo.default_branch.clone(),
            port_base: port_range.map(|r| r.base),
            port_count: port_range.map(|r| r.count),
        },
        working_dir,
    })
}

fn stop_orphaned_runtime_process(
    repo_id: &str,
    workspace_id: Option<&str>,
    script_type: &str,
    stop_command: Option<&str>,
    channel: Option<&Channel<ScriptEvent>>,
) -> anyhow::Result<Option<bool>> {
    let Some(process) = crate::workspace::runtime_registry::live_process_for_identity(
        repo_id,
        workspace_id,
        script_type,
    )?
    else {
        return Ok(None);
    };

    tracing::warn!(
        repo_id,
        workspace_id = ?workspace_id,
        script_type,
        pid = process.pid,
        pgid = process.pgid,
        "Runtime registry: stopping live process not owned by the in-memory script manager"
    );

    if let Some(command) = stop_command
        .map(str::trim)
        .filter(|command| !command.is_empty())
    {
        let target = resolve_script_target(repo_id, workspace_id)?;
        let sink = Channel::<ScriptEvent>::new(|_| Ok(()));
        let tx = channel.unwrap_or(&sink);
        crate::workspace::scripts::run_configured_stop_command(
            command,
            &target.working_dir,
            &target.context,
            tx,
        );
    }

    let gone = crate::workspace::scripts::kill_registered_runtime_process(&process);
    if gone {
        crate::workspace::runtime_registry::record_processes_ended(std::slice::from_ref(&process))?;
    }
    tracing::info!(
        repo_id,
        workspace_id = ?workspace_id,
        script_type,
        pid = process.pid,
        pgid = process.pgid,
        gone,
        "Runtime registry: orphaned process stop attempt finished"
    );
    Ok(Some(gone))
}

#[tauri::command]
pub async fn execute_repo_script(
    app: AppHandle,
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    script_type: String,
    workspace_id: Option<String>,
    action_id: Option<String>,
    channel: Channel<ScriptEvent>,
) -> CmdResult<()> {
    // Run scripts are dispatched per `action_id` against the multi-action
    // model. Setup / archive remain single per repo.
    if script_type == "run" {
        let ws = workspace_id.clone();
        let rid = repo_id.clone();
        let aid = action_id.clone();
        let action = match tauri::async_runtime::spawn_blocking(move || {
            resolve_run_target(&rid, ws.as_deref(), aid.as_deref())
        })
        .await
        .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))?
        {
            Ok(a) => a,
            Err(e) => {
                let _ = channel.send(ScriptEvent::Error {
                    message: e.to_string(),
                });
                return Ok(());
            }
        };

        let process_type = run_script_type(&action.id);
        // Per-action exclusive: same `script_type` ("run:<id>") across
        // workspaces in the repo gets killed; different action ids are
        // independent because the filter compares the full string.
        if action.mode == "non-concurrent" {
            manager.kill_others_in_repo(&repo_id, &process_type, workspace_id.as_deref());
        }

        // Only fall back to the runtime registry when this exact action is NOT
        // already owned by the in-memory manager. If it is live in-memory, the
        // normal spawn path's register() collision handles the restart — running
        // the registry orphan path here would re-run stop.command and kill the
        // manager's own live process by PID.
        let run_key = (repo_id.clone(), process_type.clone(), workspace_id.clone());
        let orphan_stop: anyhow::Result<Option<bool>> = if manager.has_live_handle(&run_key) {
            Ok(None)
        } else {
            tauri::async_runtime::spawn_blocking({
                let repo_id = repo_id.clone();
                let workspace_id = workspace_id.clone();
                let process_type = process_type.clone();
                let stop_command = action.stop_command.clone();
                let channel = channel.clone();
                move || {
                    stop_orphaned_runtime_process(
                        &repo_id,
                        workspace_id.as_deref(),
                        &process_type,
                        stop_command.as_deref(),
                        Some(&channel),
                    )
                }
            })
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))?
        };

        match orphan_stop {
            Ok(Some(true)) | Ok(None) => {}
            Ok(Some(false)) => {
                let _ = channel.send(ScriptEvent::Error {
                    message: format!(
                        "Cannot start {}; Helmor found a live process from a prior launch and could not stop it. Try Stop again.",
                        action.name
                    ),
                });
                return Ok(());
            }
            Err(error) => {
                let _ = channel.send(ScriptEvent::Error {
                    message: format!(
                        "Failed to clean up prior {} process: {error:#}",
                        action.name
                    ),
                });
                return Ok(());
            }
        }

        return spawn_script(
            app,
            manager,
            repo_id,
            process_type,
            workspace_id,
            action.command,
            channel,
            action.stop_command,
        )
        .await;
    }

    let scripts = tauri::async_runtime::spawn_blocking({
        let repo_id = repo_id.clone();
        let ws_id = workspace_id.clone();
        move || repos::load_repo_scripts(&repo_id, ws_id.as_deref())
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    let script = match script_type.as_str() {
        "setup" => scripts.setup_script.clone(),
        "archive" => scripts.archive_script.clone(),
        _ => None,
    };

    let Some(script) = script.filter(|s| !s.trim().is_empty()) else {
        let _ = channel.send(ScriptEvent::Error {
            message: format!("No {script_type} script configured"),
        });
        return Ok(());
    };

    spawn_script(
        app,
        manager,
        repo_id,
        script_type,
        workspace_id,
        script,
        channel,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn spawn_script(
    app: AppHandle,
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    script_type: String,
    workspace_id: Option<String>,
    script: String,
    channel: Channel<ScriptEvent>,
    stop_command: Option<String>,
) -> CmdResult<()> {
    let target = tauri::async_runtime::spawn_blocking({
        let repo_id = repo_id.clone();
        let workspace_id = workspace_id.clone();
        move || resolve_script_target(&repo_id, workspace_id.as_deref())
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;
    let working_dir = target.working_dir;
    let context = target.context;
    let mgr = manager.inner().clone();

    // Build the graceful-stop bundle now (while we still own `context` /
    // `working_dir` / `channel`). `None` keeps the pre-feature kill path
    // exactly as it was: SIGTERM → 200ms → SIGKILL with no detour.
    let script_stop = stop_command.map(|cmd| ScriptStop {
        command: cmd,
        event_tx: channel.clone(),
        ctx: context.clone(),
        working_dir: working_dir.clone(),
    });

    // Setup-completion hook keys on the literal `"setup"` script_type — run
    // actions (which carry a `"run:<id>"` script_type now) never trigger it.
    let is_setup = script_type == "setup";
    tauri::async_runtime::spawn_blocking(move || {
        match crate::workspace::scripts::run_script(
            &mgr,
            &repo_id,
            &script_type,
            workspace_id.as_deref(),
            &script,
            &working_dir,
            &context,
            channel.clone(),
            script_stop,
        ) {
            Ok(Some(0)) if is_setup => {
                if let Some(ws_id) = &workspace_id {
                    if let Ok(ts) = crate::models::db::current_timestamp() {
                        let _ = crate::models::workspaces::mark_setup_completed(ws_id, &ts);
                    }
                    crate::git::watcher::notify_workspace_changed(&app);
                }
            }
            Ok(_) => {}
            Err(e) => {
                let _ = channel.send(ScriptEvent::Error {
                    message: e.to_string(),
                });
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_repo_script(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    script_type: String,
    workspace_id: Option<String>,
    action_id: Option<String>,
) -> CmdResult<bool> {
    let process_type = process_type_for(&script_type, action_id.as_deref());
    let key = (repo_id.clone(), process_type.clone(), workspace_id.clone());
    if manager.kill(&key) {
        return Ok(true);
    }

    let stop_command = if script_type == "run" {
        let ws = workspace_id.clone();
        let rid = repo_id.clone();
        let aid = action_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            resolve_run_target(&rid, ws.as_deref(), aid.as_deref())
                .map(|action| action.stop_command)
        })
        .await
        .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??
    } else {
        None
    };

    let stopped = tauri::async_runtime::spawn_blocking(move || {
        stop_orphaned_runtime_process(
            &repo_id,
            workspace_id.as_deref(),
            &process_type,
            stop_command.as_deref(),
            None,
        )
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    // `Some(false)` means we found an orphan but could not confirm it died —
    // report that as "not stopped" instead of a false success.
    Ok(matches!(stopped, Some(true)))
}

/// Run a run action's configured `stop_command` as a standalone script
/// (no preceding main process to terminate). The state machine for the
/// frontend Run tab treats `exited` as "clean slate", but commands like
/// `supabase start` / `docker compose up` leave side effects (containers,
/// daemons) that outlive the spawned process. The Cleanup button surfaces
/// the user-configured stop command after exit so they can tear down those
/// side effects without re-running the failed start.
///
/// Reuses the same process slot (`"run:<id>"`) as the start script, so the
/// frontend's terminal output buffer and per-action status indicator
/// naturally reflect the cleanup run. We deliberately do NOT call
/// `kill_others_in_repo` — for concurrent-mode actions, another workspace
/// may legitimately be running the same action and that run is independent
/// of this workspace's cleanup. Same-key replacement within this workspace
/// is handled atomically by `register()` inside `spawn_script`.
#[tauri::command]
pub async fn execute_repo_stop_command(
    app: AppHandle,
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    action_id: String,
    channel: Channel<ScriptEvent>,
) -> CmdResult<()> {
    let ws = Some(workspace_id.clone());
    let rid = repo_id.clone();
    let aid = Some(action_id.clone());
    let action = match tauri::async_runtime::spawn_blocking(move || {
        resolve_run_target(&rid, ws.as_deref(), aid.as_deref())
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))?
    {
        Ok(a) => a,
        Err(e) => {
            let _ = channel.send(ScriptEvent::Error {
                message: e.to_string(),
            });
            return Ok(());
        }
    };

    let Some(stop_command) = action
        .stop_command
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        let _ = channel.send(ScriptEvent::Error {
            message: format!("No stop command configured for action: {}", action.name),
        });
        return Ok(());
    };

    let process_type = run_script_type(&action.id);
    let key = (
        repo_id.clone(),
        process_type.clone(),
        Some(workspace_id.clone()),
    );

    if manager.has_live_handle(&key) {
        let _ = channel.send(ScriptEvent::Error {
            message: format!(
                "{} is still running; click Stop instead of Cleanup.",
                action.name
            ),
        });
        return Ok(());
    }

    let orphan_stop = tauri::async_runtime::spawn_blocking({
        let repo_id = repo_id.clone();
        let workspace_id = workspace_id.clone();
        let process_type = process_type.clone();
        let stop_command = stop_command.clone();
        let channel = channel.clone();
        move || {
            stop_orphaned_runtime_process(
                &repo_id,
                Some(&workspace_id),
                &process_type,
                Some(&stop_command),
                Some(&channel),
            )
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))?;

    match orphan_stop {
        Ok(Some(true)) => {
            let _ = channel.send(ScriptEvent::Exited { code: None });
            return Ok(());
        }
        Ok(Some(false)) => {
            let _ = channel.send(ScriptEvent::Error {
                message: format!(
                    "Cannot clean up {}; Helmor found a live process from a prior launch and could not stop it. Try Stop again.",
                    action.name
                ),
            });
            return Ok(());
        }
        Ok(None) => {}
        Err(error) => {
            let _ = channel.send(ScriptEvent::Error {
                message: format!(
                    "Failed to clean up prior {} process: {error:#}",
                    action.name
                ),
            });
            return Ok(());
        }
    }

    spawn_script(
        app,
        manager,
        repo_id,
        process_type,
        Some(workspace_id),
        stop_command,
        channel,
        // Cleanup itself has no further cleanup — None preserves the
        // pre-feature SIGTERM→SIGKILL path if the user stops it mid-flight.
        None,
    )
    .await
}

/// Write raw bytes to the PTY master of a running script. The kernel's tty
/// line discipline turns `\x03` into SIGINT for the foreground process group,
/// so this is what makes Ctrl+C inside the terminal tab actually work.
#[tauri::command]
pub async fn write_repo_script_stdin(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    script_type: String,
    workspace_id: Option<String>,
    action_id: Option<String>,
    data: String,
) -> CmdResult<bool> {
    let process_type = process_type_for(&script_type, action_id.as_deref());
    let key = (repo_id, process_type, workspace_id);
    Ok(manager.write_stdin(&key, data.as_bytes())?)
}

/// Update the PTY's window size. The kernel delivers SIGWINCH to the
/// foreground process group so interactive tools (vim, htop, less) re-layout.
#[tauri::command]
pub async fn resize_repo_script(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    script_type: String,
    workspace_id: Option<String>,
    action_id: Option<String>,
    cols: u16,
    rows: u16,
) -> CmdResult<bool> {
    let process_type = process_type_for(&script_type, action_id.as_deref());
    let key = (repo_id, process_type, workspace_id);
    Ok(manager.resize(&key, cols, rows)?)
}

/// Stop / write / resize need the SAME process-key shape `execute_repo_script`
/// registered with. For "run" that means `"run:<id>"`; for any other
/// script_type the original literal is used (`"setup"`, `"archive"`, or the
/// terminal/agent-login UUID-namespaced strings).
fn process_type_for(script_type: &str, action_id: Option<&str>) -> String {
    if script_type == "run" {
        if let Some(id) = action_id {
            return run_script_type(id);
        }
    }
    script_type.to_string()
}

#[tauri::command]
pub async fn create_repo_run_action(
    app: AppHandle,
    repo_id: String,
    name: String,
    command: String,
    mode: String,
    stop_command: Option<String>,
) -> CmdResult<repos::RunAction> {
    let result = tauri::async_runtime::spawn_blocking({
        let repo_id = repo_id.clone();
        move || {
            repos::create_repo_run_action(
                &repo_id,
                name.trim(),
                command.trim(),
                &mode,
                stop_command,
            )
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    crate::ui_sync::publish(
        &app,
        crate::ui_sync::UiMutationEvent::RepoRunActionsChanged {
            repo_id: repo_id.clone(),
        },
    );
    Ok(result)
}

#[tauri::command]
pub async fn update_repo_run_action(
    app: AppHandle,
    repo_id: String,
    action_id: String,
    name: String,
    command: String,
    mode: String,
    stop_command: Option<String>,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking({
        let action_id = action_id.clone();
        move || {
            repos::update_repo_run_action(
                &action_id,
                name.trim(),
                command.trim(),
                &mode,
                stop_command,
            )
        }
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    crate::ui_sync::publish(
        &app,
        crate::ui_sync::UiMutationEvent::RepoRunActionsChanged { repo_id },
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_repo_run_action(
    app: AppHandle,
    repo_id: String,
    action_id: String,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking({
        let action_id = action_id.clone();
        move || repos::delete_repo_run_action(&action_id)
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    crate::ui_sync::publish(
        &app,
        crate::ui_sync::UiMutationEvent::RepoRunActionsChanged { repo_id },
    );
    Ok(())
}

#[tauri::command]
pub async fn reorder_repo_run_actions(
    app: AppHandle,
    repo_id: String,
    ordered_ids: Vec<String>,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking({
        let repo_id = repo_id.clone();
        move || repos::reorder_repo_run_actions(&repo_id, &ordered_ids)
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;

    crate::ui_sync::publish(
        &app,
        crate::ui_sync::UiMutationEvent::RepoRunActionsChanged { repo_id },
    );
    Ok(())
}

#[tauri::command]
pub async fn set_workspace_active_run_action(
    workspace_id: String,
    action_id: Option<String>,
) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::models::workspaces::update_workspace_active_run_action(
            &workspace_id,
            action_id.as_deref(),
        )
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;
    Ok(())
}
