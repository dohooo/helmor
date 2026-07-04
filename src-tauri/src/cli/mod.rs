//! Command-line interface for Helmor.
//!
//! The binary at `src/bin/helmor-cli.rs` is a thin dispatcher — every
//! command body lives here so it can reach crate-private domain logic
//! (`workspace::*`, `models::*`, `agents::*`, `github::*`, `git::*`).
//!
//! # Architecture
//!
//! Each command domain gets its own sub-module (`repo`, `workspace`,
//! `session`, `files`, `send`, `github`, `settings`, `scripts`, `system`,
//! `data`). Shared helpers live in `output` (JSON
//! / human formatting) and `refs` (UUID / name disambiguation).

pub mod args;
mod data;
mod files;
mod github;
mod output;
mod refs;
mod repo;
mod scripts;
mod send;
mod session;
mod settings;
mod system;
mod terminal_hook;
mod workspace;

use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{CommandFactory, FromArgMatches};

pub use self::args::{Cli, Commands};
use crate::ui_sync::UiMutationEvent;

/// The CLI's user-facing binary name for this build.
///
/// - Release builds: `helmor` (the canonical name; the installer
///   creates `/usr/local/bin/helmor` as a symlink to the bundled
///   `helmor-cli`).
/// - Dev builds: `helmor-dev` (a separate symlink name so a dev
///   install doesn't shadow a release install on the same machine).
///
/// **Important caveat for dev builds**: each worktree builds its own
/// `target/debug/helmor-cli`, but `/usr/local/bin/helmor-dev` (if it
/// exists at all) can only point at one of them. Callers that need a
/// *reliable* dev invocation — in particular code that hands a
/// command string to an agent running inside this Helmor instance —
/// should use [`agent_invocation_path`] instead, which returns the
/// absolute path of THIS process's sibling `helmor-cli`.
///
/// Use this function for terminal-user-visible output (e.g. error
/// messages telling the user which command to run themselves) — the
/// user can be expected to manage their own `/usr/local/bin`
/// state. Don't use it from prompt assembly or other agent-facing
/// code paths.
pub(crate) fn installed_cli_name() -> &'static str {
    if crate::data_dir::is_dev() {
        "helmor-dev"
    } else {
        "helmor"
    }
}

/// The CLI invocation an agent running inside this Helmor instance
/// should use.
///
/// - Release: returns `helmor` (the on-PATH symlink is stable).
/// - Dev: returns the absolute path of the `helmor-cli` binary sitting
///   next to the currently-running Helmor executable. This is the
///   *only* reliable invocation under the worktree-based dev workflow,
///   where multiple Helmor dev instances coexist and a shared
///   `/usr/local/bin/helmor-dev` symlink (if any) can only target one
///   worktree's binary.
///
/// Falls back to `helmor-cli` (bare name, relying on PATH) only if
/// `current_exe()` itself fails — which would already imply Helmor is
/// in a broken state. The fallback exists so prompt assembly never
/// returns an empty / nonsense string.
pub(crate) fn agent_invocation_path() -> String {
    if !crate::data_dir::is_dev() {
        return installed_cli_name().to_string();
    }

    // The compiled CLI is `helmor-cli.exe` on Windows, `helmor-cli` elsewhere.
    let cli_name = if cfg!(windows) {
        "helmor-cli.exe"
    } else {
        "helmor-cli"
    };
    match std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(cli_name)))
    {
        Some(path) => path.display().to_string(),
        None => cli_name.to_string(),
    }
}

pub(crate) fn notify_ui_event(event: UiMutationEvent) {
    let _ = crate::ui_sync::notify_running_app(event);
}

pub(crate) fn notify_ui_events(events: impl IntoIterator<Item = UiMutationEvent>) {
    for event in events {
        notify_ui_event(event);
    }
}

/// Entry point. Parses arguments, initialises the data directory and
/// schema, then dispatches. Returns a process exit code.
pub fn run() -> ExitCode {
    let cli = {
        let command_name = installed_cli_name();
        let matches = Cli::command()
            .name(command_name)
            .bin_name(command_name)
            .get_matches();
        Cli::from_arg_matches(&matches).expect("command matches should parse into Cli")
    };

    if let Some(ref dir) = cli.data_dir {
        // SAFETY: called in main() before any threads are spawned.
        unsafe { std::env::set_var("HELMOR_DATA_DIR", dir) };
    }

    match dispatch(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            if cli.json {
                let body = serde_json::json!({ "error": format!("{error:#}") });
                eprintln!("{body}");
            } else {
                eprintln!("error: {error:#}");
            }
            ExitCode::FAILURE
        }
    }
}

fn dispatch(cli: &Cli) -> Result<()> {
    ensure_ready()?;

    use args::Commands as C;
    match &cli.command {
        C::Data { action } => data::dispatch(action, cli),
        C::Completions { shell } => system::completions(*shell),
        C::CliStatus => system::cli_status(cli),
        C::Quit => system::quit(),
        C::Settings { action } => settings::dispatch(action, cli),
        C::Repo { action } => repo::dispatch(action, cli),
        C::Workspace { action } => workspace::dispatch(action, cli),
        C::Session { action } => session::dispatch(action, cli),
        C::Files { action } => files::dispatch(action, cli),
        C::Send(opts) => send::send(opts, cli),
        C::Models { action } => send::dispatch_models(action, cli),
        C::Github { action } => github::dispatch(action, cli),
        C::Scripts { action } => scripts::dispatch(action, cli),
        C::Mcp => crate::mcp::run_mcp_server(),
        C::TerminalHook { agent } => terminal_hook::run(agent, cli),
    }
}

/// Make sure the data directory and schema are ready. Shared across all
/// commands — a typo in one dispatcher arm shouldn't leave the DB
/// half-initialised, so this runs unconditionally.
fn ensure_ready() -> Result<()> {
    crate::data_dir::ensure_directory_structure()?;
    let db_path = crate::data_dir::db_path()?;
    let conn = rusqlite::Connection::open(&db_path)
        .with_context(|| format!("Failed to open database at {db_path:?}"))?;
    crate::schema_init(&conn);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cargo test` always runs as a debug build, so `is_dev()` is
    /// `true` here — this exercises the dev branch end-to-end.
    /// Pinning the *shape* of the returned path (absolute, ends with
    /// `/helmor-cli`) protects against a future refactor that
    /// accidentally drops back to the bare `helmor-dev` name, which
    /// would silently misroute agents to the wrong worktree's CLI.
    #[test]
    fn agent_invocation_path_returns_absolute_helmor_cli_in_dev() {
        let path = agent_invocation_path();
        // Either an absolute path ending in the platform CLI file name
        // (`helmor-cli` on Unix, `helmor-cli.exe` on Windows), or that bare
        // name as the fallback when `current_exe()` is unavailable.
        let cli_name = if cfg!(windows) {
            "helmor-cli.exe"
        } else {
            "helmor-cli"
        };
        assert!(
            path.ends_with(cli_name),
            "unexpected dev invocation path: {path}"
        );
        // Never the bare `helmor-dev` symlink name — that's the
        // ambiguous-under-worktree case this helper exists to avoid.
        assert_ne!(path, "helmor-dev", "must not emit bare `helmor-dev`");
        assert_ne!(path, "helmor", "must not emit release name in dev");
    }

    /// `installed_cli_name` is the terminal-user-facing name and
    /// must stay aligned with what `cli_status` reports / what the
    /// installer creates as a symlink. Debug builds = `helmor-dev`.
    #[test]
    fn installed_cli_name_uses_dev_suffix_in_debug_builds() {
        assert_eq!(installed_cli_name(), "helmor-dev");
    }
}
