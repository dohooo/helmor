//! `helmor scripts` — inspect effective repo scripts (setup / run / archive).
//!
//! Execution (`run`, `stop`, `write-stdin`, `resize`) is GUI-owned because
//! it requires a Tauri `Channel<ScriptEvent>` for streamed output. The
//! CLI sticks to the read path; users who need to run scripts from a
//! terminal can copy the commands and execute them directly.

use anyhow::Result;

use crate::repos;
use crate::service;

use super::args::{Cli, ScriptsAction};
use super::output;

pub fn dispatch(action: &ScriptsAction, cli: &Cli) -> Result<()> {
    match action {
        ScriptsAction::Show {
            repo_ref,
            workspace,
        } => show(repo_ref, workspace.as_deref(), cli),
    }
}

fn show(repo_ref: &str, workspace: Option<&str>, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let workspace_id = match workspace {
        Some(r) => Some(service::resolve_workspace_ref(r)?),
        None => None,
    };
    let scripts = repos::load_repo_scripts(&id, workspace_id.as_deref())?;
    output::print(cli, &scripts, |s| {
        format!(
            "setup    (project={}): {}\nrun      (project={}): {}\narchive  (project={}): {}",
            s.setup_from_project,
            s.setup_script.as_deref().unwrap_or("-"),
            s.run_from_project,
            s.run_actions
                .first()
                .map(|a| a.command.as_str())
                .unwrap_or("-"),
            s.archive_from_project,
            s.archive_script.as_deref().unwrap_or("-"),
        )
    })
}
