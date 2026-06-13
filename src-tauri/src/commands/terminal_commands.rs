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
#[allow(clippy::too_many_arguments)] // Tauri IPC command — args mirror the frontend call.
pub async fn spawn_terminal(
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    instance_id: String,
    agent_kind: Option<String>,
    boot_command: Option<String>,
    fast_mode: Option<bool>,
    initial_cols: Option<u16>,
    initial_rows: Option<u16>,
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
    // Spawn the PTY at the renderer's real size. An inline TUI paints its first
    // frame against this; a stale default leaves ghost rows after fit/SIGWINCH.
    let initial_size = match (initial_cols, initial_rows) {
        (Some(c), Some(r)) if c > 0 && r > 0 => Some((c, r)),
        _ => None,
    };

    tauri::async_runtime::spawn_blocking(move || {
        // Wrap the preset command: export the hook env (so the agent hook can
        // report its real session id via `helmor terminal-hook`) and, for
        // Claude, inject a `--settings` file carrying the hook.
        let boot_input = build_terminal_boot(
            &instance_id,
            agent_kind.as_deref(),
            boot_command.as_deref(),
            fast_mode.unwrap_or(false),
        );
        if let Err(e) = crate::workspace::scripts::run_terminal_session(
            &mgr,
            &repo_id,
            &script_type,
            Some(&workspace_id),
            &working_dir,
            &context,
            channel.clone(),
            boot_input.as_deref(),
            initial_size,
        ) {
            let _ = channel.send(ScriptEvent::Error {
                message: e.to_string(),
            });
        }
    });

    Ok(())
}

/// Single-quote a string for safe inclusion in a `/bin/sh` command line.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Insert `--settings <path>` right after the executable token of `cmd`.
/// Our preset commands always start with the agent executable, so the flag
/// lands between it and the rest of the args.
fn inject_settings_flag(cmd: &str, hooks_path: &str) -> String {
    let settings = format!("--settings {}", sh_quote(hooks_path));
    match cmd.split_once(char::is_whitespace) {
        Some((head, rest)) => format!("{head} {settings} {rest}"),
        None => format!("{cmd} {settings}"),
    }
}

/// Write (idempotently) the settings file Claude loads via `--settings`.
/// Registers the `helmor terminal-hook` lifecycle hooks (real session id for
/// resume, busy state, prompt capture) and, when the composer requested it,
/// `fastMode` — Claude has no fast-mode flag, only this settings key, and a
/// second `--settings` would risk clobbering the first, so both ride one
/// file. Content is static per (agent, fastMode) pair; the session
/// association rides the HELMOR_TERMINAL_SESSION_ID env, not the file.
fn ensure_agent_hooks_file(
    cli_path: &str,
    agent: &str,
    fast_mode: bool,
) -> anyhow::Result<std::path::PathBuf> {
    let suffix = if fast_mode { "-fast" } else { "" };
    let path = crate::data_dir::run_dir()?.join(format!("terminal-hooks-{agent}{suffix}.json"));
    let command = format!("{} terminal-hook --agent {}", sh_quote(cli_path), agent);
    let mut json = serde_json::json!({
        "hooks": {
            "SessionStart": [{ "hooks": [{ "type": "command", "command": command }] }],
            "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": command }] }],
            "PreToolUse": [{ "hooks": [{ "type": "command", "command": command }] }],
            "Stop": [{ "hooks": [{ "type": "command", "command": command }] }],
            // Stop does NOT fire on a user interrupt; SessionEnd is the only
            // signal when the user quits claude mid-turn (the shell stays
            // alive, so the PTY-exit fallback never sees it either).
            "SessionEnd": [{ "hooks": [{ "type": "command", "command": command }] }]
        }
    });
    if fast_mode {
        json["fastMode"] = serde_json::Value::Bool(true);
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&json)?)?;
    Ok(path)
}

/// Surgically merge our hook into the user's global `~/.codex/hooks.json`
/// (Codex has no per-run `--settings`). Only adds our own command to each event
/// group, preserving any hooks the user already configured. The hook is a no-op
/// outside Helmor terminals (it checks HELMOR_TERMINAL_SESSION_ID), so a global
/// install never interferes with the user's own codex runs.
fn ensure_codex_hooks(cli_path: &str) -> anyhow::Result<()> {
    let home = std::env::var("HOME").map_err(|_| anyhow::anyhow!("HOME not set"))?;
    let path = std::path::Path::new(&home)
        .join(".codex")
        .join("hooks.json");
    let command = format!("{} terminal-hook --agent codex", sh_quote(cli_path));

    let existing = if path.exists() {
        Some(std::fs::read_to_string(&path)?)
    } else {
        None
    };
    let root = merge_codex_hooks(existing.as_deref(), &command)?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&root)?)?;
    Ok(())
}

/// Merge our terminal-hook command into a codex `hooks.json` document.
/// `existing` is the current file text (`None` = no file yet). Errors on invalid
/// JSON so the caller never overwrites a config it couldn't parse. Idempotent —
/// re-running never duplicates our command, and user-configured hooks are kept.
fn merge_codex_hooks(existing: Option<&str>, command: &str) -> anyhow::Result<serde_json::Value> {
    let mut root: serde_json::Value = match existing {
        Some(text) => serde_json::from_str(text)
            .map_err(|e| anyhow::anyhow!("codex hooks.json is not valid JSON: {e}"))?,
        None => serde_json::json!({ "hooks": {} }),
    };
    // Valid-JSON-but-not-an-object roots (array, string, …) would panic on
    // the index assignment below; refuse like the invalid-JSON case so the
    // user's file is never touched.
    if !root.is_object() {
        anyhow::bail!("codex hooks.json root is not a JSON object");
    }
    if !root
        .get("hooks")
        .map(serde_json::Value::is_object)
        .unwrap_or(false)
    {
        root["hooks"] = serde_json::json!({});
    }

    let group = serde_json::json!({ "hooks": [{ "type": "command", "command": command }] });
    let hooks = root["hooks"]
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("codex hooks is not an object"))?;
    for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"] {
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]));
        let Some(list) = arr.as_array_mut() else {
            continue;
        };
        // Find OUR entry by marker, then compare the full group — the CLI
        // path inside the command changes across dev worktrees / upgrades,
        // and a stale absolute path must be replaced, not kept forever.
        let ours = list.iter().position(|g| {
            serde_json::to_string(g)
                .map(|s| s.contains("terminal-hook --agent codex"))
                .unwrap_or(false)
        });
        match ours {
            Some(index) => {
                if list[index] != group {
                    list[index] = group.clone();
                }
            }
            None => list.push(group.clone()),
        }
    }
    Ok(root)
}

/// Build the PTY boot command for a Terminal-Mode agent. `None` (bare shell /
/// no preset) returns `None`. Otherwise prefixes the hook env exports and, for
/// Claude, injects the `--settings` hooks file.
fn build_terminal_boot(
    instance_id: &str,
    agent_kind: Option<&str>,
    boot_command: Option<&str>,
    fast_mode: bool,
) -> Option<String> {
    let cmd = boot_command?;
    let cli_path = crate::cli::agent_invocation_path();
    // Prefer the bundled agent CLIs (pinned + checksum-verified) over
    // whatever the user has on PATH. Empty in dev — resolve_bundled_agent_paths
    // intentionally returns none there, so dev keeps using the local install.
    let mut bundled_dirs: Vec<String> = Vec::new();
    if cfg!(debug_assertions) {
        // Dev: use ONLY the sidecar's npm-pinned CLIs. Never the
        // target/debug/vendor staging leftovers — those copies can be stale
        // or broken (a resident one was SIGKILLed on launch), and
        // resolve_bundled_agent_paths happily finds them next to the dev exe.
        if let Some(bin_dir) = std::env::current_exe().ok().and_then(|exe| {
            exe.ancestors()
                .map(|root| root.join("sidecar").join("node_modules").join(".bin"))
                .find(|path| path.join("claude").is_file())
        }) {
            bundled_dirs.push(bin_dir.display().to_string());
        }
    } else {
        let bundled = crate::sidecar::resolve_bundled_agent_paths();
        for bin in [&bundled.claude_bin, &bundled.codex_bin] {
            if let Some(dir) = bin.as_deref().and_then(|p| p.parent()) {
                let dir = dir.display().to_string();
                if !bundled_dirs.contains(&dir) {
                    bundled_dirs.push(dir);
                }
            }
        }
    }
    let path_prefix = if bundled_dirs.is_empty() {
        String::new()
    } else {
        format!(
            "export PATH={}\":$PATH\"; ",
            sh_quote(&bundled_dirs.join(":"))
        )
    };
    let prefix = format!(
        "{path_prefix}export HELMOR_TERMINAL_SESSION_ID={}; export HELMOR_CLI_PATH={}; ",
        sh_quote(instance_id),
        sh_quote(&cli_path),
    );
    let final_cmd = match agent_kind {
        Some(kind @ "claude") => match ensure_agent_hooks_file(&cli_path, kind, fast_mode) {
            Ok(hooks_path) => inject_settings_flag(cmd, &hooks_path.display().to_string()),
            Err(error) => {
                tracing::warn!(%error, "terminal: hooks file write failed; spawning without resume hook");
                cmd.to_string()
            }
        },
        Some("codex") => {
            // Codex reads hooks from its global ~/.codex/hooks.json (no per-run
            // --settings); merge ours in. The env export above ties the hook
            // callback to this terminal session.
            if let Err(error) = ensure_codex_hooks(&cli_path) {
                tracing::warn!(%error, "terminal: codex hooks merge failed; resume may not work");
            }
            cmd.to_string()
        }
        _ => cmd.to_string(),
    };
    Some(format!("{prefix}{final_cmd}"))
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
    app: tauri::AppHandle,
    manager: State<'_, ScriptProcessManager>,
    repo_id: String,
    workspace_id: String,
    instance_id: String,
    data: String,
) -> CmdResult<bool> {
    let key = (
        repo_id,
        make_script_type(&instance_id),
        Some(workspace_id.clone()),
    );
    let written = manager.write_stdin(&key, data.as_bytes())?;
    if written {
        // instance_id == the helmor session id (it rides into the agent as
        // HELMOR_TERMINAL_SESSION_ID); see terminal::observe_stdin for why
        // interrupt inference hangs off this write path.
        crate::terminal::observe_stdin(&app, &instance_id, &workspace_id, &data);
    }
    Ok(written)
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

/// Convert a freshly-prepared GUI session into a Terminal session (start-surface
/// terminal flow). See `models::sessions::convert_session_to_terminal`.
#[tauri::command]
pub async fn convert_session_to_terminal(session_id: String, agent_type: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::models::sessions::convert_session_to_terminal(&session_id, &agent_type)
    })
    .await
    .map_err(|e| anyhow::anyhow!("spawn_blocking join failed: {e}"))??;
    Ok(())
}

/// Mirror a Terminal session's working/idle state into the shared active-stream
/// registry so the sidebar spinner treats it like a GUI session. Used to clear
/// busy when the PTY exits; the working state itself comes from the agent hook.
#[tauri::command]
pub async fn set_terminal_session_busy(
    app: tauri::AppHandle,
    session_id: String,
    workspace_id: String,
    provider: Option<String>,
    busy: bool,
) -> CmdResult<()> {
    crate::terminal::set_busy(&app, &session_id, &workspace_id, provider.as_deref(), busy).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "/path/helmor terminal-hook --agent codex";

    #[test]
    fn merge_codex_hooks_rejects_invalid_json() {
        // A user's unparseable hooks.json must NOT be silently overwritten.
        assert!(merge_codex_hooks(Some("{ not json"), CMD).is_err());
    }

    #[test]
    fn merge_codex_hooks_seeds_when_absent() {
        let root = merge_codex_hooks(None, CMD).unwrap();
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(serde_json::to_string(&root).unwrap().contains(CMD));
    }

    #[test]
    fn merge_codex_hooks_preserves_user_hooks() {
        let existing =
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-thing"}]}]}}"#;
        let root = merge_codex_hooks(Some(existing), CMD).unwrap();
        assert_eq!(
            root["hooks"]["Stop"].as_array().unwrap().len(),
            2,
            "user hook kept + ours appended"
        );
        let dump = serde_json::to_string(&root).unwrap();
        assert!(dump.contains("user-thing"));
        assert!(dump.contains("terminal-hook --agent codex"));
    }

    #[test]
    fn merge_codex_hooks_replaces_stale_cli_path() {
        // A dev build wrote its worktree-absolute CLI path; a later run from
        // a different install must replace it, not keep the dead command.
        let stale = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/old/worktree/helmor terminal-hook --agent codex"}]}]}}"#;
        let root = merge_codex_hooks(Some(stale), CMD).unwrap();
        let list = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(list.len(), 1, "replaced in place, not appended");
        let dump = serde_json::to_string(&root).unwrap();
        assert!(dump.contains(CMD));
        assert!(!dump.contains("/old/worktree/"));
    }

    #[test]
    fn merge_codex_hooks_rejects_non_object_root() {
        // Valid JSON, wrong shape — must error instead of panicking on the
        // index assignment (and never overwrite the user's file).
        assert!(merge_codex_hooks(Some("[1,2,3]"), CMD).is_err());
        assert!(merge_codex_hooks(Some(r#""text""#), CMD).is_err());
    }

    #[test]
    fn merge_codex_hooks_is_idempotent() {
        let first = merge_codex_hooks(None, CMD).unwrap();
        let again = merge_codex_hooks(Some(&first.to_string()), CMD).unwrap();
        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"] {
            assert_eq!(
                again["hooks"][event].as_array().unwrap().len(),
                1,
                "{event} not duplicated"
            );
        }
    }
}
