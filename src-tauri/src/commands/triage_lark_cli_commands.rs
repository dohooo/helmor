//! Lark CLI in-app auth terminal. Mirrors `*_forge_cli_auth_terminal_*` for `lark-cli`. Actions: install / signIn.

use serde::Deserialize;
use tauri::{ipc::Channel, State};

use crate::workspace::scripts::{ScriptContext, ScriptEvent, ScriptProcessManager};

use super::common::CmdResult;

const LARK_AUTH_REPO_ID: &str = "__helmor_triage_lark__";

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LarkAuthAction {
    Install,
    SignIn,
}

impl LarkAuthAction {
    fn script_type(self, instance_id: &str) -> String {
        let key = match self {
            LarkAuthAction::Install => "install",
            LarkAuthAction::SignIn => "signIn",
        };
        format!("lark-cli-auth:{key}:{instance_id}")
    }

    /// PTY boot: clear, banner, then the real command(s). `printf` for bash/zsh portability; raw strings so `\033` reaches the shell.
    fn boot_command(self) -> &'static str {
        match self {
            LarkAuthAction::Install => concat!(
                "clear; ",
                r#"printf '\n\033[1;36m== Connect Lark ==\033[0m\n\n'; "#,
                r#"printf 'Step 1/2  Install lark-cli via npm (requires npm on PATH).\n'; "#,
                r#"printf 'Step 2/2  Sign in via OAuth — your default browser will open.\n\n'; "#,
                "npm install -g @larksuite/cli && lark-cli auth login",
            ),
            LarkAuthAction::SignIn => concat!(
                "clear; ",
                r#"printf '\n\033[1;36m== Connect Lark ==\033[0m\n\n'; "#,
                r#"printf 'Running `lark-cli auth login`. Your default browser will open.\n'; "#,
                r#"printf 'Approve the request in Lark, then come back here.\n\n'; "#,
                "lark-cli auth login",
            ),
        }
    }
}

#[tauri::command]
pub async fn spawn_lark_cli_auth_terminal(
    manager: State<'_, ScriptProcessManager>,
    action: LarkAuthAction,
    instance_id: String,
    channel: Channel<ScriptEvent>,
) -> CmdResult<()> {
    let working_dir = std::env::var("HOME")
        .ok()
        .filter(|home| !home.trim().is_empty())
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.display().to_string())
        })
        .unwrap_or_else(|| "/".to_string());
    let context = ScriptContext {
        root_path: working_dir.clone(),
        workspace_path: None,
        workspace_name: None,
        default_branch: None,
        port_base: None,
        port_count: None,
    };
    let mgr = manager.inner().clone();
    let script_type = action.script_type(&instance_id);
    let boot_input = format!("{}; exit\n", action.boot_command());

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = crate::workspace::scripts::run_terminal_session(
            &mgr,
            LARK_AUTH_REPO_ID,
            &script_type,
            None,
            &working_dir,
            &context,
            channel.clone(),
            Some(&boot_input),
        ) {
            let _ = channel.send(ScriptEvent::Error {
                message: error.to_string(),
            });
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_lark_cli_auth_terminal(
    manager: State<'_, ScriptProcessManager>,
    action: LarkAuthAction,
    instance_id: String,
) -> CmdResult<bool> {
    let key = (
        LARK_AUTH_REPO_ID.to_string(),
        action.script_type(&instance_id),
        None,
    );
    Ok(manager.kill(&key))
}

#[tauri::command]
pub async fn write_lark_cli_auth_terminal_stdin(
    manager: State<'_, ScriptProcessManager>,
    action: LarkAuthAction,
    instance_id: String,
    data: String,
) -> CmdResult<bool> {
    let key = (
        LARK_AUTH_REPO_ID.to_string(),
        action.script_type(&instance_id),
        None,
    );
    Ok(manager.write_stdin(&key, data.as_bytes())?)
}

#[tauri::command]
pub async fn resize_lark_cli_auth_terminal(
    manager: State<'_, ScriptProcessManager>,
    action: LarkAuthAction,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<bool> {
    let key = (
        LARK_AUTH_REPO_ID.to_string(),
        action.script_type(&instance_id),
        None,
    );
    Ok(manager.resize(&key, cols, rows)?)
}
