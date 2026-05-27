//! `helmor` / `helmor-dev` meta / system commands.
//!
//! `install_cli` is intentionally omitted: the installer copies the
//! currently-running binary to `/usr/local/bin/helmor` (or `helmor-dev` in
//! debug builds), which is how the
//! desktop Settings UI already handles it. From the CLI, the analogous
//! operation is just `cp "$(command -v helmor)" /usr/local/bin/<name>`
//! and we shouldn't invite accidental privilege escalation.

use std::io::Write;

use anyhow::Result;
use serde::Serialize;

use crate::service;

use super::args::{Cli, CompletionShell};
use super::output;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliStatusPayload {
    installed: bool,
    install_path: Option<String>,
    current_binary: Option<String>,
    build_mode: String,
    app_running: bool,
}

pub fn cli_status(cli: &Cli) -> Result<()> {
    let install_path =
        std::path::PathBuf::from(format!("/usr/local/bin/{}", super::installed_cli_name()));
    let installed = install_path.exists();
    let current = std::env::current_exe()
        .ok()
        .map(|p| p.display().to_string());
    let payload = CliStatusPayload {
        installed,
        install_path: if installed {
            Some(install_path.display().to_string())
        } else {
            None
        },
        current_binary: current,
        build_mode: crate::data_dir::data_mode_label().to_string(),
        app_running: service::is_app_running(),
    };
    output::print(cli, &payload, |p| {
        format!(
            "Installed:     {}\n\
             Install path:  {}\n\
             Current bin:   {}\n\
             Mode:          {}\n\
             App running:   {}",
            p.installed,
            p.install_path.as_deref().unwrap_or("-"),
            p.current_binary.as_deref().unwrap_or("-"),
            p.build_mode,
            p.app_running,
        )
    })
}

pub fn completions(shell: CompletionShell) -> Result<()> {
    use clap::CommandFactory;
    use clap_complete::Shell;

    let mut cmd = super::args::Cli::command();
    let clap_shell = match shell {
        CompletionShell::Bash => Shell::Bash,
        CompletionShell::Zsh => Shell::Zsh,
        CompletionShell::Fish => Shell::Fish,
        CompletionShell::Powershell => Shell::PowerShell,
        CompletionShell::Elvish => Shell::Elvish,
    };
    let mut stdout = std::io::stdout();
    clap_complete::generate(
        clap_shell,
        &mut cmd,
        super::installed_cli_name(),
        &mut stdout,
    );
    stdout.flush()?;
    Ok(())
}

/// Tell the running app to shut down.
///
/// Without a daemon / HTTP bridge, CLI-driven shutdown isn't possible:
/// the Tauri `request_quit` command lives inside the app event loop and
/// can only be invoked from an in-process context. We emit a helpful
/// message instead of silently no-oping.
pub fn quit() -> Result<()> {
    if service::is_app_running() {
        anyhow::bail!(
            "Helmor is running but the CLI cannot stop it remotely yet. \
             Close the app from the menu bar (Helmor → Quit) or press ⌘Q."
        );
    }
    println!("Helmor is not running.");
    Ok(())
}
