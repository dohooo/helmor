use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use anyhow::Context;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{
    LogicalSize, LogicalUnit, Manager, PhysicalPosition, PhysicalSize, PixelUnit, Position, Size,
    State, Window, WindowSizeConstraints,
};

use crate::workspace::scripts::{ScriptContext, ScriptEvent, ScriptProcessManager};
use crate::{agents, data_dir, git_watcher, models::db, service, sidecar};

use super::common::{run_blocking, CmdResult};

// Best-fit fixed window size for the current onboarding motion layout.
// Resizing is restored when onboarding exits.
const ONBOARDING_WINDOW_WIDTH: f64 = 1300.0;
const ONBOARDING_WINDOW_HEIGHT: f64 = 810.0;
const MINI_WINDOW_WIDTH: f64 = 430.0;
const MINI_WINDOW_HEIGHT: f64 = 760.0;
const HELMOR_SKILL_NAME: &str = "helmor-cli";
const HELMOR_SKILL_SOURCE: &str = "dohooo/helmor/.agents/skills/helmor-cli";

// --- Per-version startup update check (CLI + Skills) -----------------------
//
// Keys live in the generic KV settings table:
//
//   `app.last_update_check_version`  — last Helmor version we ran the
//                                      startup check for. Cache key — when
//                                      this matches the current app
//                                      version we skip the check entirely.
//   `app.update_check_cli_error`     — last error from the silent CLI
//                                      install attempt. Cleared on success.
//   `app.update_check_skills_error`  — last error from the silent skills
//                                      install attempt. Cleared on success.
//
// The cache key is **only** written when both halves of the check
// finished cleanly (or had nothing to do). A transient failure (e.g. no
// network for skills install) leaves the key untouched so the next
// launch retries automatically.
const LAST_UPDATE_CHECK_VERSION_KEY: &str = "app.last_update_check_version";
const UPDATE_CHECK_CLI_ERROR_KEY: &str = "app.update_check_cli_error";
const UPDATE_CHECK_SKILLS_ERROR_KEY: &str = "app.update_check_skills_error";
const ONBOARDING_COMPLETED_KEY: &str = "app.onboarding_completed";

static ONBOARDING_WINDOW_STATE: LazyLock<Mutex<HashMap<String, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MINI_WINDOW_STATE: LazyLock<Mutex<HashMap<String, MiniWindowRestoreState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy)]
struct MiniWindowRestoreState {
    size: PhysicalSize<u32>,
    resizable: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CliInstallState {
    Missing,
    Managed,
    Stale,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    pub data_mode: String,
    pub data_dir: String,
    pub db_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoginStatus {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
    pub opencode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_auth_method: Option<String>,
}

// `None` when the binary couldn't be resolved or `--version` failed. Cursor is SDK-only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVersions {
    pub claude: Option<String>,
    pub codex: Option<String>,
    pub opencode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub install_path: Option<String>,
    pub build_mode: String,
    pub install_state: CliInstallState,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmorSkillsStatus {
    pub installed: bool,
    pub claude: bool,
    pub codex: bool,
    pub command: String,
}

/// Combined snapshot used by the Settings → General "Helmor components"
/// row. Pure read — never triggers an install. Pairs CLI + Skills status
/// with whatever was cached by the last per-version startup check so the
/// panel can render a single coherent state ("up to date", "needs
/// attention", or per-component error).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentsUpdateCheck {
    pub cli: CliStatus,
    pub skills: HelmorSkillsStatus,
    /// Helmor version (`CARGO_PKG_VERSION`) for which the silent startup
    /// check last completed successfully. `None` means we've never
    /// finished a clean pass — the panel reads that as "first run".
    pub last_checked_version: Option<String>,
    /// Current Helmor version. The panel compares this to
    /// `last_checked_version` to decide whether to nudge the user that a
    /// re-check is pending.
    pub current_version: String,
    /// Last silent-install failure message for the CLI, if any. Cleared
    /// when a subsequent attempt (silent or user-initiated) succeeds.
    pub cli_error: Option<String>,
    /// Last silent-install failure message for the skills, if any.
    /// Cleared on success.
    pub skills_error: Option<String>,
}

/// Where Helmor installs its managed CLI entrypoint on macOS.
fn cli_install_target() -> std::path::PathBuf {
    std::path::PathBuf::from(format!(
        "/usr/local/bin/{}",
        crate::cli::installed_cli_name()
    ))
}

/// Name of the compiled CLI binary produced by `cargo build --bin helmor-cli`.
fn cli_source_binary_name() -> &'static str {
    "helmor-cli"
}

fn bundled_cli_binary(app_exe: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    let target_dir = app_exe
        .parent()
        .context("Cannot determine app binary directory")?;
    Ok(target_dir.join(cli_source_binary_name()))
}

fn cli_install_remediation(cli_binary: &std::path::Path, install_path: &std::path::Path) -> String {
    format!(
        "sudo ln -sfn {} {}",
        shell_quote(cli_binary),
        shell_quote(install_path),
    )
}

fn shell_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

fn shell_quote_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn classify_cli_install(
    install_path: &std::path::Path,
    bundled_cli: &std::path::Path,
) -> CliInstallState {
    let metadata = match std::fs::symlink_metadata(install_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CliInstallState::Missing;
        }
        Err(_) => return CliInstallState::Stale,
    };

    if !metadata.file_type().is_symlink() {
        return CliInstallState::Stale;
    }

    let target = match std::fs::read_link(install_path) {
        Ok(target) => target,
        Err(_) => return CliInstallState::Stale,
    };
    let resolved_target = if target.is_absolute() {
        target
    } else {
        install_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("/"))
            .join(target)
    };

    match (
        std::fs::canonicalize(resolved_target),
        std::fs::canonicalize(bundled_cli),
    ) {
        (Ok(installed), Ok(expected)) if installed == expected => CliInstallState::Managed,
        _ => CliInstallState::Stale,
    }
}

fn cli_status_for_paths(
    install_path: &std::path::Path,
    bundled_cli: &std::path::Path,
) -> CliStatus {
    let install_state = classify_cli_install(install_path, bundled_cli);
    CliStatus {
        installed: install_state != CliInstallState::Missing,
        install_path: (install_state != CliInstallState::Missing)
            .then(|| install_path.display().to_string()),
        build_mode: crate::data_dir::data_mode_label().to_string(),
        install_state,
    }
}

fn install_cli_symlink(
    bundled_cli: &std::path::Path,
    install_path: &std::path::Path,
) -> anyhow::Result<()> {
    if !bundled_cli.is_file() {
        anyhow::bail!(
            "CLI binary not found at {}. Run `cargo build --bin helmor-cli` first.",
            bundled_cli.display()
        );
    }

    // Refuse to clobber a real directory (even with elevation — too destructive).
    if let Ok(metadata) = std::fs::symlink_metadata(install_path) {
        if metadata.file_type().is_dir() {
            anyhow::bail!(
                "Install path {} is a directory. Remove it manually first.",
                install_path.display()
            );
        }
    }

    match try_install_symlink_unprivileged(bundled_cli, install_path) {
        Ok(()) => return Ok(()),
        Err(error) if is_permission_denied(&error) => {
            tracing::info!(
                target: "helmor_lib::commands::system_commands",
                "Direct CLI install hit permission denied; requesting authorization."
            );
        }
        Err(error) => return Err(error),
    }

    #[cfg(target_os = "macos")]
    {
        install_cli_symlink_elevated(bundled_cli, install_path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        anyhow::bail!(
            "Installing the CLI requires elevated privileges. Run:\n  {}",
            cli_install_remediation(bundled_cli, install_path)
        )
    }
}

fn try_install_symlink_unprivileged(
    bundled_cli: &std::path::Path,
    install_path: &std::path::Path,
) -> anyhow::Result<()> {
    if let Some(parent) = install_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to prepare install directory {}", parent.display()))?;
    }

    match std::fs::symlink_metadata(install_path) {
        Ok(_) => {
            std::fs::remove_file(install_path).with_context(|| {
                format!(
                    "Failed to replace existing CLI install at {}",
                    install_path.display()
                )
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "Failed to inspect existing CLI install at {}",
                    install_path.display()
                )
            });
        }
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(bundled_cli, install_path)
            .with_context(|| format!("Failed to install CLI at {}", install_path.display()))?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let _ = bundled_cli;
        anyhow::bail!("CLI installation via symlink is only supported on Unix.")
    }
}

fn is_permission_denied(error: &anyhow::Error) -> bool {
    error.chain().any(|err| {
        err.downcast_ref::<std::io::Error>()
            .map(|io| io.kind() == std::io::ErrorKind::PermissionDenied)
            .unwrap_or(false)
    })
}

#[cfg(target_os = "macos")]
fn install_cli_symlink_elevated(
    bundled_cli: &std::path::Path,
    install_path: &std::path::Path,
) -> anyhow::Result<()> {
    let script = build_elevated_install_script(bundled_cli, install_path);
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .context("Failed to launch osascript for elevated CLI install")?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let trimmed = stderr.trim();
    // -128 = userCanceledErr (cmd-period / dialog Cancel button).
    if trimmed.contains("(-128)") || trimmed.contains("User canceled") {
        anyhow::bail!("Authorization canceled.");
    }
    anyhow::bail!(
        "Elevated CLI install failed.\n{trimmed}\n\nFallback: {fallback}",
        fallback = cli_install_remediation(bundled_cli, install_path),
    )
}

#[cfg(target_os = "macos")]
fn build_elevated_install_script(
    bundled_cli: &std::path::Path,
    install_path: &std::path::Path,
) -> String {
    let parent = install_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("/"));
    // `ln -sfn` atomically replaces an existing symlink/file at the target;
    // running as root via osascript also covers the case where the parent is
    // root-owned (the typical macOS /usr/local/bin situation).
    let inner = format!(
        "/bin/mkdir -p {parent} && /bin/ln -sfn {src} {target}",
        parent = applescript_shell_arg(parent),
        src = applescript_shell_arg(bundled_cli),
        target = applescript_shell_arg(install_path),
    );
    format!(
        "do shell script \"{inner}\" with prompt \"Helmor wants to install the {name} command line tool to {display}.\" with administrator privileges",
        name = crate::cli::installed_cli_name(),
        display = install_path.display(),
    )
}

/// Quote a path so it survives both `do shell script "..."` (AppleScript string
/// literal) and the shell that AppleScript hands the script to.
fn applescript_shell_arg(path: &std::path::Path) -> String {
    let raw = path.display().to_string();
    // 1. Single-quote for the shell, escaping embedded single quotes via `'\''`.
    let shell_quoted = format!("'{}'", raw.replace('\'', "'\\''"));
    // 2. Escape backslashes and double quotes for the AppleScript string literal.
    shell_quoted.replace('\\', "\\\\").replace('"', "\\\"")
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn claude_skills_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".claude"))
        .join("skills")
}

fn codex_skills_dir() -> PathBuf {
    // `skills@1.5.x` installs Codex as a universal agent in the canonical
    // global skills directory.
    home_dir().join(".agents").join("skills")
}

fn skill_exists(base: &Path) -> bool {
    base.join(HELMOR_SKILL_NAME).join("SKILL.md").is_file()
}

fn ready_skill_agents(login: &AgentLoginStatus) -> Vec<&'static str> {
    let mut agents = Vec::new();
    if login.claude {
        agents.push("claude-code");
    }
    if login.codex {
        agents.push("codex");
    }
    agents
}

fn helmor_skills_install_args(agents: &[&str]) -> Vec<String> {
    let mut args = vec![
        "--yes".to_string(),
        "skills".to_string(),
        "add".to_string(),
        HELMOR_SKILL_SOURCE.to_string(),
        "-g".to_string(),
        "-s".to_string(),
        HELMOR_SKILL_NAME.to_string(),
        "-y".to_string(),
        "--copy".to_string(),
    ];
    for agent in agents {
        args.push("-a".to_string());
        args.push((*agent).to_string());
    }
    args
}

fn helmor_skills_install_command(agents: &[&str]) -> String {
    let command_agents = if agents.is_empty() {
        vec!["claude-code", "codex"]
    } else {
        agents.to_vec()
    };
    std::iter::once("npx".to_string())
        .chain(helmor_skills_install_args(&command_agents))
        .map(|arg| shell_quote_arg(&arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn helmor_skills_status() -> anyhow::Result<HelmorSkillsStatus> {
    Ok(helmor_skills_status_for_agents(&ready_skill_agents(
        &AgentLoginStatus {
            claude: claude_login_ready(),
            codex: codex_auth_status().ready,
            cursor: cursor_login_ready(),
            // opencode readiness comes from the login-status path, not here.
            opencode: false,
            codex_provider: None,
            codex_auth_method: None,
        },
    )))
}

fn helmor_skills_status_for_agents(agents: &[&str]) -> HelmorSkillsStatus {
    let claude = skill_exists(&claude_skills_dir());
    let codex = skill_exists(&codex_skills_dir());
    let installed = if agents.is_empty() {
        claude || codex
    } else {
        agents.iter().all(|agent| match *agent {
            "claude-code" => claude,
            "codex" => codex,
            _ => false,
        })
    };
    HelmorSkillsStatus {
        installed,
        claude,
        codex,
        command: helmor_skills_install_command(agents),
    }
}

#[tauri::command]
pub fn get_cli_status() -> CmdResult<CliStatus> {
    let install_path = cli_install_target();
    let source = std::env::current_exe().context("Cannot determine app executable path")?;
    let cli_binary = bundled_cli_binary(&source)?;
    Ok(cli_status_for_paths(&install_path, &cli_binary))
}

/// File-backed React Query persister storage. The cache lives at
/// `<data_dir>/cache/query/` instead of localStorage so it isn't bound
/// by the webview's ~5–10 MB localStorage quota. The frontend addresses
/// each cache key as a distinct file under this dir — only one key is
/// in use today (`helmor-query-cache`), but the namespacing keeps the
/// door open for the persister's optional `entries()` extension.
fn query_cache_dir() -> anyhow::Result<PathBuf> {
    data_dir::query_cache_dir()
}

/// Reject anything that could escape the cache dir (`..`, `/`, etc.) —
/// the key comes from JS and must round-trip cleanly to a flat
/// filename. Allowed chars cover the keys TanStack Query persister uses
/// in practice (alphanumeric, `-`, `_`, `:`, `.`).
fn sanitize_cache_key(key: &str) -> anyhow::Result<String> {
    if key.is_empty() {
        anyhow::bail!("Empty query cache key");
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ':' || c == '.')
    {
        anyhow::bail!("Invalid query cache key: {key:?}");
    }
    Ok(key.to_string())
}

fn query_cache_path(key: &str) -> anyhow::Result<PathBuf> {
    let safe = sanitize_cache_key(key)?;
    Ok(query_cache_dir()?.join(format!("{safe}.json")))
}

#[tauri::command]
pub async fn read_query_cache(key: String) -> CmdResult<Option<String>> {
    run_blocking(move || {
        let path = query_cache_path(&key)?;
        match std::fs::read_to_string(&path) {
            Ok(contents) => Ok(Some(contents)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => {
                Err(anyhow::Error::from(err)
                    .context(format!("Failed to read query cache at {path:?}")))
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn write_query_cache(key: String, value: String) -> CmdResult<()> {
    run_blocking(move || {
        let path = query_cache_path(&key)?;
        // Atomic write: stage to a sibling tmp file then rename. Avoids
        // a half-written cache surviving a crash mid-flush.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &value)
            .with_context(|| format!("Failed to stage query cache at {tmp:?}"))?;
        std::fs::rename(&tmp, &path)
            .with_context(|| format!("Failed to commit query cache to {path:?}"))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_query_cache(key: String) -> CmdResult<()> {
    run_blocking(move || {
        let path = query_cache_path(&key)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(anyhow::Error::from(err)
                .context(format!("Failed to delete query cache at {path:?}"))),
        }
    })
    .await
}

#[tauri::command]
pub async fn install_cli() -> CmdResult<CliStatus> {
    run_blocking(|| {
        let source = std::env::current_exe()?;
        let cli_binary = bundled_cli_binary(&source)?;
        let install_path = cli_install_target();
        install_cli_symlink(&cli_binary, &install_path)?;
        // A successful user-initiated install means the Settings panel's
        // "red dot" for the CLI is no longer accurate — clear it.
        persist_error(UPDATE_CHECK_CLI_ERROR_KEY, None);
        Ok(cli_status_for_paths(&install_path, &cli_binary))
    })
    .await
}

#[tauri::command]
pub async fn get_helmor_skills_status() -> CmdResult<HelmorSkillsStatus> {
    run_blocking(helmor_skills_status).await
}

#[tauri::command]
pub async fn install_helmor_skills() -> CmdResult<HelmorSkillsStatus> {
    run_blocking(|| {
        let login = AgentLoginStatus {
            claude: claude_login_ready(),
            codex: codex_auth_status().ready,
            cursor: cursor_login_ready(),
            // opencode readiness comes from the login-status path, not here.
            opencode: false,
            codex_provider: None,
            codex_auth_method: None,
        };
        let agents = ready_skill_agents(&login);
        let command = helmor_skills_install_command(&agents);

        if agents.is_empty() {
            anyhow::bail!(
                "No ready agent was found. Sign in to Claude Code or Codex first, then run:\n  {}",
                command
            );
        }

        let output = Command::new("npx")
            .args(helmor_skills_install_args(&agents))
            .output()
            .with_context(|| format!("Failed to start skills installer. Try:\n  {command}"))?;

        if !output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "Helmor skills setup failed.\n{}\n{}\nFix the error, then run:\n  {}",
                stdout.trim(),
                stderr.trim(),
                command
            );
        }

        // Clear the panel's "red dot" — a user-initiated install just
        // succeeded, so the cached error from the silent startup pass
        // (if any) is no longer accurate.
        persist_error(UPDATE_CHECK_SKILLS_ERROR_KEY, None);
        Ok(helmor_skills_status_for_agents(&agents))
    })
    .await
}

// ---------------------------------------------------------------------------
// Per-version startup component update check
// ---------------------------------------------------------------------------
//
// The Helmor app ships with two ancillary surfaces:
//
//   1. The `helmor` CLI binary, installed as a symlink at /usr/local/bin/.
//      Because it's a symlink to a binary inside `Helmor.app`, the CLI
//      already auto-tracks app upgrades — but a user who upgraded across
//      the pre-symlink era can still be stuck with a stale file copy at
//      that path, and brand-new users who skipped the "Power up Helmor"
//      onboarding step have nothing at all there.
//
//   2. The "helmor-cli" skill, copied from the dohooo/helmor repo into
//      ~/.claude/skills/ and ~/.agents/skills/ via `npx skills add`.
//      The `--copy` install snapshots the source files locally, so
//      app upgrades **never** refresh the skill content.
//
// This check runs once per Helmor version after onboarding completes.
// Cache key is the app version string itself, so the work is exactly
// "once per upgrade". Both halves are silent: CLI install only attempts
// the unprivileged path (no sudo prompt at startup), and skills install
// is skipped entirely if no agent is signed in. Failures don't update
// the cache, so a transient network blip will be retried on the next
// launch automatically.

/// Read whatever the panel needs to render the components row, without
/// triggering any install. Always safe to call.
fn read_components_update_check() -> anyhow::Result<ComponentsUpdateCheck> {
    let install_path = cli_install_target();
    let source = std::env::current_exe().context("Cannot determine app executable path")?;
    let cli_binary = bundled_cli_binary(&source)?;
    let cli = cli_status_for_paths(&install_path, &cli_binary);
    let skills = helmor_skills_status()?;
    let last_checked_version =
        crate::models::settings::load_setting_value(LAST_UPDATE_CHECK_VERSION_KEY).unwrap_or(None);
    let cli_error =
        crate::models::settings::load_setting_value(UPDATE_CHECK_CLI_ERROR_KEY).unwrap_or(None);
    let skills_error =
        crate::models::settings::load_setting_value(UPDATE_CHECK_SKILLS_ERROR_KEY).unwrap_or(None);
    Ok(ComponentsUpdateCheck {
        cli,
        skills,
        last_checked_version,
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        cli_error,
        skills_error,
    })
}

/// True iff the user has completed onboarding. Onboarding has its own
/// silent install path (`SkillsStep`); the startup check would race with
/// it on a first run, so we gate on the same flag the frontend uses.
fn onboarding_completed() -> bool {
    matches!(
        crate::models::settings::load_setting_value(ONBOARDING_COMPLETED_KEY),
        Ok(Some(ref v)) if v == "true"
    )
}

/// Silent CLI install — only attempts the unprivileged path. If the
/// target needs sudo, we bail with a friendly message instead of
/// surprising the user with a password prompt at app launch. The user
/// can still hit "Retry" in the Settings panel, which routes through
/// `install_cli` and is allowed to escalate.
fn try_install_cli_silent_at(
    bundled_cli: &std::path::Path,
    install_path: &std::path::Path,
) -> anyhow::Result<()> {
    if !bundled_cli.is_file() {
        anyhow::bail!("CLI binary not found at {}.", bundled_cli.display());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(install_path) {
        if metadata.file_type().is_dir() {
            anyhow::bail!(
                "Install path {} is a directory. Remove it manually first.",
                install_path.display()
            );
        }
    }

    match try_install_symlink_unprivileged(bundled_cli, install_path) {
        Ok(()) => Ok(()),
        Err(error) if is_permission_denied(&error) => {
            anyhow::bail!(
                "Helmor needs administrator access to install the CLI at {}. Open Settings → General and click Retry to authorize.",
                install_path.display()
            )
        }
        Err(error) => Err(error),
    }
}

/// Verify the managed CLI symlink and silently re-point it if it is stale
/// or missing. Returns the silent-install error (if any) for the panel.
///
/// This runs on EVERY components check — never gated by the per-version
/// cache — because the symlink is cheap to fix (a stat + an unprivileged
/// symlink rewrite) and can go stale WITHIN a single version whenever the
/// dev build switches worktrees. Caching it behind the version key is
/// exactly what used to leave a dangling `/usr/local/bin/helmor-dev`
/// pointing at a worktree whose binary was rebuilt or removed.
fn check_and_heal_cli_symlink(
    install_path: &std::path::Path,
    bundled_cli: &std::path::Path,
) -> Option<String> {
    match classify_cli_install(install_path, bundled_cli) {
        CliInstallState::Managed => None,
        CliInstallState::Missing | CliInstallState::Stale => {
            match try_install_cli_silent_at(bundled_cli, install_path) {
                Ok(()) => None,
                Err(error) => {
                    let msg = format!("{error:#}");
                    tracing::info!(error = %msg, "Components check: silent CLI install deferred to user");
                    Some(msg)
                }
            }
        }
    }
}

/// One pass of the silent startup check. Returns the post-check snapshot
/// regardless of whether either half failed; failure details are written
/// into `cli_error` / `skills_error` for the panel to surface.
fn run_components_check_inner(force: bool) -> ComponentsUpdateCheck {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    // --- CLI half: ALWAYS run, BEFORE the per-version cache gate ---------
    // Self-heal the managed CLI symlink on every launch (see
    // `check_and_heal_cli_symlink`): it can go stale within a single
    // version when the dev build switches worktrees, and re-pointing it is
    // cheap and (on a user-writable install dir) needs no sudo, so a plain
    // restart fixes it instead of forcing a manual `ln -sfn`.
    let install_path = cli_install_target();
    let cli_error: Option<String> = match std::env::current_exe()
        .context("Cannot determine app executable path")
        .and_then(|exe| bundled_cli_binary(&exe))
    {
        Ok(cli_binary) => check_and_heal_cli_symlink(&install_path, &cli_binary),
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "Components check: bundled CLI lookup failed");
            None
        }
    };
    persist_error(UPDATE_CHECK_CLI_ERROR_KEY, cli_error.as_deref());

    // --- Skills install is expensive (`npx skills add`): gate it behind
    // the per-version cache. The CLI half above is independent of this.
    if !force {
        if let Ok(Some(last)) =
            crate::models::settings::load_setting_value(LAST_UPDATE_CHECK_VERSION_KEY)
        {
            if last == current_version {
                return read_components_update_check()
                    .unwrap_or_else(|_| empty_components_check(current_version));
            }
        }
    }

    // --- Skills half -----------------------------------------------------
    //
    // No-agent → not an error. Treat it as "nothing to install" so we
    // don't keep retrying every launch within the same app version.
    let login = AgentLoginStatus {
        claude: claude_login_ready(),
        codex: codex_auth_status().ready,
        cursor: cursor_login_ready(),
        opencode: false,
        codex_provider: None,
        codex_auth_method: None,
    };
    let agents = ready_skill_agents(&login);
    let skills_error: Option<String> = if agents.is_empty() {
        tracing::debug!("Components check: no signed-in agent, skipping skills install");
        None
    } else {
        match install_skills_silent(&agents) {
            Ok(()) => None,
            Err(error) => {
                let msg = format!("{error:#}");
                tracing::warn!(error = %msg, "Components check: silent skills install failed");
                Some(msg)
            }
        }
    };
    persist_error(UPDATE_CHECK_SKILLS_ERROR_KEY, skills_error.as_deref());

    // Advance the cache key (which gates the expensive skills install) only
    // when the skills half is clean — a transient failure (no network, npx
    // not on PATH yet) auto-retries on the next launch. The CLI half is
    // independent and always runs, so it no longer gates this key.
    if skills_error.is_none() {
        if let Err(error) = crate::models::settings::upsert_setting_value(
            LAST_UPDATE_CHECK_VERSION_KEY,
            &current_version,
        ) {
            tracing::warn!(
                error = %format!("{error:#}"),
                "Components check: failed to persist last-checked version",
            );
        }
    }

    read_components_update_check().unwrap_or_else(|_| empty_components_check(current_version))
}

fn install_skills_silent(agents: &[&str]) -> anyhow::Result<()> {
    let command = helmor_skills_install_command(agents);
    let output = Command::new("npx")
        .args(helmor_skills_install_args(agents))
        .output()
        .with_context(|| format!("Failed to start skills installer. Try:\n  {command}"))?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "Helmor skills setup failed.\n{}\n{}",
            stdout.trim(),
            stderr.trim(),
        );
    }
    Ok(())
}

fn persist_error(key: &str, value: Option<&str>) {
    let result = match value {
        Some(message) => crate::models::settings::upsert_setting_value(key, message),
        None => crate::models::settings::delete_setting_value(key),
    };
    if let Err(error) = result {
        tracing::warn!(
            key = key,
            error = %format!("{error:#}"),
            "Failed to persist components-check error state",
        );
    }
}

fn empty_components_check(current_version: String) -> ComponentsUpdateCheck {
    ComponentsUpdateCheck {
        cli: CliStatus {
            installed: false,
            install_path: None,
            build_mode: crate::data_dir::data_mode_label().to_string(),
            install_state: CliInstallState::Missing,
        },
        skills: HelmorSkillsStatus {
            installed: false,
            claude: false,
            codex: false,
            command: helmor_skills_install_command(&[]),
        },
        last_checked_version: None,
        current_version,
        cli_error: None,
        skills_error: None,
    }
}

/// Fire-and-forget startup hook called from `lib.rs setup()`. Yields
/// immediately; the actual install runs on a blocking task so a slow
/// `npx` invocation can't stall the rest of setup. Gated on
/// `onboarding_completed` so a brand-new install doesn't race the
/// onboarding step's own auto-install.
pub fn spawn_startup_components_check() {
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(|| {
            if !onboarding_completed() {
                tracing::debug!("Components check: skipped (onboarding not completed yet)");
                return;
            }
            let snapshot = run_components_check_inner(false);
            tracing::debug!(
                cli_state = ?snapshot.cli.install_state,
                skills_installed = snapshot.skills.installed,
                cli_error = ?snapshot.cli_error,
                skills_error = ?snapshot.skills_error,
                "Components check: completed"
            );
        })
        .await;
    });
}

#[tauri::command]
pub async fn get_helmor_components_update_check() -> CmdResult<ComponentsUpdateCheck> {
    run_blocking(read_components_update_check).await
}

#[tauri::command]
pub async fn recheck_helmor_components() -> CmdResult<ComponentsUpdateCheck> {
    run_blocking(|| Ok(run_components_check_inner(true))).await
}

#[tauri::command]
pub fn enter_onboarding_window_mode(window: Window) -> CmdResult<()> {
    let label = window.label().to_string();
    let was_resizable = window
        .is_resizable()
        .context("Failed to read window resizable state")?;
    ONBOARDING_WINDOW_STATE
        .lock()
        .expect("onboarding window state mutex poisoned")
        .entry(label)
        .or_insert(was_resizable);

    let size = onboarding_window_size();
    window
        .set_size(size)
        .context("Failed to set onboarding window size")?;
    window
        .center()
        .context("Failed to center onboarding window")?;
    window
        .set_min_size(Some(size))
        .context("Failed to set onboarding minimum window size")?;
    window
        .set_max_size(Some(size))
        .context("Failed to set onboarding maximum window size")?;
    window
        .set_size_constraints(onboarding_window_constraints())
        .context("Failed to set onboarding window size constraints")?;
    window
        .set_resizable(false)
        .context("Failed to disable onboarding window resizing")?;

    Ok(())
}

#[tauri::command]
pub fn exit_onboarding_window_mode(window: Window) -> CmdResult<()> {
    let label = window.label().to_string();
    let restore_resizable = ONBOARDING_WINDOW_STATE
        .lock()
        .expect("onboarding window state mutex poisoned")
        .remove(&label)
        .unwrap_or(true);

    window
        .set_size_constraints(WindowSizeConstraints::default())
        .context("Failed to clear onboarding window size constraints")?;
    window
        .set_min_size(None::<Size>)
        .context("Failed to clear onboarding minimum window size")?;
    window
        .set_max_size(None::<Size>)
        .context("Failed to clear onboarding maximum window size")?;
    window
        .set_resizable(restore_resizable)
        .context("Failed to restore window resizing")?;

    Ok(())
}

#[tauri::command]
pub fn enter_mini_window_mode(window: Window) -> CmdResult<()> {
    let label = window.label().to_string();
    let restore_state = MiniWindowRestoreState {
        size: window
            .outer_size()
            .context("Failed to read current window size")?,
        resizable: window
            .is_resizable()
            .context("Failed to read window resizable state")?,
    };
    MINI_WINDOW_STATE
        .lock()
        .expect("mini window state mutex poisoned")
        .entry(label)
        .or_insert(restore_state);

    let size = mini_window_size();
    window
        .set_size(size)
        .context("Failed to set mini window size")?;
    window.center().context("Failed to center mini window")?;
    window
        .set_min_size(Some(size))
        .context("Failed to set mini minimum window size")?;
    window
        .set_max_size(Some(size))
        .context("Failed to set mini maximum window size")?;
    window
        .set_size_constraints(mini_window_constraints())
        .context("Failed to set mini window size constraints")?;
    window
        .set_resizable(false)
        .context("Failed to disable mini window resizing")?;
    // Resizing/centering drops the webview's keyboard focus on macOS, which
    // kills the JS keydown listener until the user clicks back in. Re-focus
    // so the toggle shortcut keeps working without a manual click.
    let _ = window.set_focus();

    Ok(())
}

#[tauri::command]
pub fn exit_mini_window_mode(window: Window) -> CmdResult<()> {
    let label = window.label().to_string();
    let restore_state = MINI_WINDOW_STATE
        .lock()
        .expect("mini window state mutex poisoned")
        .remove(&label);

    window
        .set_size_constraints(WindowSizeConstraints::default())
        .context("Failed to clear mini window size constraints")?;
    window
        .set_min_size(None::<Size>)
        .context("Failed to clear mini minimum window size")?;
    window
        .set_max_size(None::<Size>)
        .context("Failed to clear mini maximum window size")?;

    if let Some(state) = restore_state {
        window
            .set_size(Size::Physical(state.size))
            .context("Failed to restore window size")?;
        center_window_for_size(&window, state.size).context("Failed to center restored window")?;
        window
            .set_resizable(state.resizable)
            .context("Failed to restore window resizing")?;
    } else {
        window
            .set_resizable(true)
            .context("Failed to restore window resizing")?;
    }
    // See enter_mini_window_mode: restore keyboard focus after resizing so the
    // toggle shortcut stays live.
    let _ = window.set_focus();

    Ok(())
}

#[tauri::command]
pub fn toggle_mini_window_mode(window: Window) -> CmdResult<bool> {
    let label = window.label().to_string();
    let is_mini = MINI_WINDOW_STATE
        .lock()
        .expect("mini window state mutex poisoned")
        .contains_key(&label);

    if is_mini {
        exit_mini_window_mode(window)?;
        Ok(false)
    } else {
        enter_mini_window_mode(window)?;
        Ok(true)
    }
}

fn onboarding_window_size() -> Size {
    Size::Logical(LogicalSize {
        width: ONBOARDING_WINDOW_WIDTH,
        height: ONBOARDING_WINDOW_HEIGHT,
    })
}

fn onboarding_window_constraints() -> WindowSizeConstraints {
    WindowSizeConstraints {
        min_width: Some(PixelUnit::Logical(LogicalUnit::new(
            ONBOARDING_WINDOW_WIDTH,
        ))),
        min_height: Some(PixelUnit::Logical(LogicalUnit::new(
            ONBOARDING_WINDOW_HEIGHT,
        ))),
        max_width: Some(PixelUnit::Logical(LogicalUnit::new(
            ONBOARDING_WINDOW_WIDTH,
        ))),
        max_height: Some(PixelUnit::Logical(LogicalUnit::new(
            ONBOARDING_WINDOW_HEIGHT,
        ))),
    }
}

fn mini_window_size() -> Size {
    Size::Logical(LogicalSize {
        width: MINI_WINDOW_WIDTH,
        height: MINI_WINDOW_HEIGHT,
    })
}

fn mini_window_constraints() -> WindowSizeConstraints {
    WindowSizeConstraints {
        min_width: Some(PixelUnit::Logical(LogicalUnit::new(MINI_WINDOW_WIDTH))),
        min_height: Some(PixelUnit::Logical(LogicalUnit::new(MINI_WINDOW_HEIGHT))),
        max_width: Some(PixelUnit::Logical(LogicalUnit::new(MINI_WINDOW_WIDTH))),
        max_height: Some(PixelUnit::Logical(LogicalUnit::new(MINI_WINDOW_HEIGHT))),
    }
}

fn center_window_for_size(window: &Window, size: PhysicalSize<u32>) -> anyhow::Result<()> {
    let Some(monitor) = window
        .current_monitor()
        .context("Failed to read current monitor")?
    else {
        window.center().context("Failed to center window")?;
        return Ok(());
    };

    let monitor_position = *monitor.position();
    let monitor_size = *monitor.size();
    let x = monitor_position.x + ((monitor_size.width as i32 - size.width as i32) / 2);
    let y = monitor_position.y + ((monitor_size.height as i32 - size.height as i32) / 2);

    window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .context("Failed to set centered window position")?;

    Ok(())
}

#[tauri::command]
pub async fn open_agent_login_terminal(provider: String) -> CmdResult<()> {
    run_blocking(move || open_agent_login_terminal_impl(&provider)).await
}

#[tauri::command]
pub async fn get_agent_login_status() -> CmdResult<AgentLoginStatus> {
    run_blocking(|| {
        let codex = codex_auth_status();
        Ok(AgentLoginStatus {
            claude: claude_login_ready(),
            codex: codex.ready,
            cursor: cursor_login_ready(),
            opencode: opencode_login_ready(),
            codex_provider: codex.provider,
            codex_auth_method: codex.auth_method.map(str::to_string),
        })
    })
    .await
}

#[tauri::command]
pub async fn get_agent_versions() -> CmdResult<AgentVersions> {
    run_blocking(|| {
        Ok(AgentVersions {
            claude: agent_cli_version("claude"),
            codex: agent_cli_version("codex"),
            opencode: agent_cli_version("opencode"),
        })
    })
    .await
}

fn agent_cli_version(provider: &str) -> Option<String> {
    let output = std::process::Command::new(resolve_agent_binary(provider))
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_semver(&text)
}

// Extract the first `MAJOR.MINOR.PATCH(-suffix)?` token; CLI `--version` layouts vary.
fn parse_semver(text: &str) -> Option<String> {
    for token in text.split(|c: char| c.is_whitespace() || c == '(' || c == ')') {
        let trimmed = token.trim_start_matches('v');
        let mut dots = 0;
        let valid = !trimmed.is_empty()
            && trimmed.chars().all(|c| {
                if c == '.' {
                    dots += 1;
                    true
                } else {
                    c.is_ascii_digit() || c == '-' || c.is_ascii_alphabetic()
                }
            })
            && dots >= 2
            && trimmed.chars().next().is_some_and(|c| c.is_ascii_digit());
        if valid {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Cursor "ready" = non-empty `app.cursor_provider.apiKey`.
fn cursor_login_ready() -> bool {
    let raw = match crate::models::settings::load_setting_value("app.cursor_provider") {
        Ok(Some(value)) => value,
        Ok(None) => return false,
        Err(error) => {
            tracing::debug!("Failed to read app.cursor_provider: {error}");
            return false;
        }
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| {
            value
                .get("apiKey")
                .and_then(serde_json::Value::as_str)
                .map(|key| !key.trim().is_empty())
        })
        .unwrap_or(false)
}

/// Resolve the binary to spawn for an agent CLI subcommand.
///
/// Prefers the bundled binary under `Helmor.app/Contents/Resources/vendor/`
/// so onboarding works on machines that don't have `claude` / `codex` on
/// PATH. Falls back to the bare command name (PATH lookup) for dev builds
/// and as a last resort.
fn resolve_agent_binary(provider: &str) -> PathBuf {
    let bundled = sidecar::resolve_bundled_agent_paths();
    let bundled_path = match provider {
        "claude" => bundled.claude_bin,
        "codex" => bundled.codex_bin,
        "opencode" => bundled.opencode_bin,
        _ => None,
    };
    bundled_path.unwrap_or_else(|| PathBuf::from(provider))
}

// Read from the sidecar-computed settings row, NOT `auth.json` (which misses env/config/Zen providers).
fn opencode_login_ready() -> bool {
    let raw = match crate::models::settings::load_setting_value("app.opencode_provider") {
        Ok(Some(value)) => value,
        Ok(None) => return false,
        Err(error) => {
            tracing::debug!("Failed to read app.opencode_provider: {error}");
            return false;
        }
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let status_ready = parsed
        .get("status")
        .and_then(serde_json::Value::as_str)
        .map(|status| status == "ready")
        .unwrap_or(false);
    let connected_nonempty = parsed
        .get("connected")
        .and_then(serde_json::Value::as_array)
        .map(|arr| !arr.is_empty())
        .unwrap_or(false);
    status_ready || connected_nonempty
}

fn claude_login_ready() -> bool {
    match std::process::Command::new(resolve_agent_binary("claude"))
        .args(["auth", "status"])
        .output()
    {
        Ok(output) if output.status.success() => parse_claude_login_status(&output.stdout),
        Ok(output) => {
            // Claude exits non-zero when the user isn't authenticated —
            // that's a normal "false" answer, not an error. Log at trace
            // so it doesn't look like something went wrong.
            tracing::trace!(
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "Claude not logged in (auth status returned non-zero)"
            );
            false
        }
        Err(error) => {
            tracing::debug!("Claude auth status unavailable: {error}");
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexAuthStatus {
    ready: bool,
    provider: Option<String>,
    auth_method: Option<&'static str>,
}

fn codex_auth_status() -> CodexAuthStatus {
    if codex_login_ready() {
        return CodexAuthStatus {
            ready: true,
            provider: None,
            auth_method: Some("login"),
        };
    }

    if let Some(provider) = codex_api_key_provider_ready() {
        return CodexAuthStatus {
            ready: true,
            provider: Some(provider),
            auth_method: Some("apiKey"),
        };
    }

    CodexAuthStatus {
        ready: false,
        provider: None,
        auth_method: None,
    }
}

fn codex_login_ready() -> bool {
    match std::process::Command::new(resolve_agent_binary("codex"))
        .args(["login", "status"])
        .output()
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            parse_codex_login_status(&format!("{stdout}\n{stderr}"))
        }
        Ok(output) => {
            // `codex login status` exits non-zero with stderr "Not
            // logged in" when the user is signed out — that's a
            // routine "no session" answer, not a check failure. Logging
            // it as "failed" makes legitimate aborts (user closes the
            // login terminal mid-flow) look like crashes. Demote to
            // trace.
            tracing::trace!(
                stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                "Codex not logged in (login status returned non-zero)"
            );
            false
        }
        Err(error) => {
            tracing::debug!("Codex login status unavailable: {error}");
            false
        }
    }
}

fn parse_claude_login_status(stdout: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(stdout)
        .ok()
        .and_then(|value| value.get("loggedIn").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

fn parse_codex_login_status(output: &str) -> bool {
    let normalized = output.to_ascii_lowercase();
    normalized.contains("logged in") && !normalized.contains("not logged in")
}

fn codex_api_key_provider_ready() -> Option<String> {
    let config = std::fs::read_to_string(crate::codex_config::config_path()).ok()?;
    let provider = crate::codex_config::active_api_key_provider(&config)?;
    env_var_is_present(&provider.env_key).then_some(provider.name)
}

fn env_var_is_present(key: &str) -> bool {
    std::env::var_os(key)
        .map(|value| !value.to_string_lossy().trim().is_empty())
        .unwrap_or(false)
}

fn agent_login_command(provider: &str) -> anyhow::Result<String> {
    let args = match provider {
        "claude" => "auth login",
        "codex" => "login",
        "opencode" => "auth login",
        _ => anyhow::bail!("Unknown agent provider: {provider}"),
    };
    // Quote the resolved binary path so spaces in `Helmor.app` survive
    // both the embedded PTY shell and AppleScript's `do shell script`.
    Ok(format!(
        "{} {}",
        shell_quote(&resolve_agent_binary(provider)),
        args
    ))
}

fn agent_login_script_type(provider: &str, instance_id: &str) -> String {
    format!("agent-login:{provider}:{instance_id}")
}

const AGENT_LOGIN_REPO_ID: &str = "__helmor_onboarding__";

#[tauri::command]
pub async fn spawn_agent_login_terminal(
    app: tauri::AppHandle,
    manager: State<'_, ScriptProcessManager>,
    provider: String,
    instance_id: String,
    channel: Channel<ScriptEvent>,
) -> CmdResult<()> {
    let command = agent_login_command(&provider)?;
    tracing::info!(
        provider = %provider,
        instance_id = %instance_id,
        command = %command,
        "spawn_agent_login_terminal: dispatching"
    );

    // Defensive: some agent CLIs (codex login in particular) shell out
    // to the system `open` command for OAuth. On macOS that can let the
    // browser steal foreground, and in some configurations the calling
    // app gets implicitly hidden. Force the window back to front before
    // we spawn so the embedded terminal stays visible regardless.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }

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
    let script_type = agent_login_script_type(&provider, &instance_id);

    tauri::async_runtime::spawn_blocking(move || {
        tracing::debug!(
            provider = %provider,
            instance_id = %instance_id,
            "spawn_agent_login_terminal: entering run_terminal_session"
        );
        // Auto-type the login command via the run_terminal_session boot
        // input — written synchronously to the PTY master right after
        // the shell registers, so a frontend re-render-driven
        // cleanup→respawn can't drop the bytes.
        let boot_input = format!("{command}; exit\n");
        if let Err(error) = crate::workspace::scripts::run_terminal_session(
            &mgr,
            AGENT_LOGIN_REPO_ID,
            &script_type,
            None,
            &working_dir,
            &context,
            channel.clone(),
            Some(&boot_input),
        ) {
            tracing::warn!(
                provider = %provider,
                instance_id = %instance_id,
                error = %format!("{error:#}"),
                "spawn_agent_login_terminal: run_terminal_session failed"
            );
            let _ = channel.send(ScriptEvent::Error {
                message: error.to_string(),
            });
        } else {
            tracing::debug!(
                provider = %provider,
                instance_id = %instance_id,
                "spawn_agent_login_terminal: run_terminal_session returned"
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_agent_login_terminal(
    manager: State<'_, ScriptProcessManager>,
    provider: String,
    instance_id: String,
) -> CmdResult<bool> {
    let key = (
        AGENT_LOGIN_REPO_ID.to_string(),
        agent_login_script_type(&provider, &instance_id),
        None,
    );
    Ok(manager.kill(&key))
}

#[tauri::command]
pub async fn write_agent_login_terminal_stdin(
    manager: State<'_, ScriptProcessManager>,
    provider: String,
    instance_id: String,
    data: String,
) -> CmdResult<bool> {
    let key = (
        AGENT_LOGIN_REPO_ID.to_string(),
        agent_login_script_type(&provider, &instance_id),
        None,
    );
    Ok(manager.write_stdin(&key, data.as_bytes())?)
}

#[tauri::command]
pub async fn resize_agent_login_terminal(
    manager: State<'_, ScriptProcessManager>,
    provider: String,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<bool> {
    let key = (
        AGENT_LOGIN_REPO_ID.to_string(),
        agent_login_script_type(&provider, &instance_id),
        None,
    );
    Ok(manager.resize(&key, cols, rows)?)
}

#[cfg(target_os = "macos")]
fn open_agent_login_terminal_impl(provider: &str) -> anyhow::Result<()> {
    let command = agent_login_command(provider)?;
    let script_command = applescript_string(&command);
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"Terminal\" to activate")
        .arg("-e")
        .arg(format!(
            "tell application \"Terminal\" to do script {script_command}"
        ))
        .output()
        .context("Failed to open Terminal for agent login")?;

    if !output.status.success() {
        anyhow::bail!(
            "Terminal login command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_agent_login_terminal_impl(provider: &str) -> anyhow::Result<()> {
    let _ = agent_login_command(provider)?;
    anyhow::bail!("Opening agent login in a terminal is currently supported on macOS only.")
}

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[tauri::command]
pub fn get_data_info() -> CmdResult<DataInfo> {
    let data_dir = crate::data_dir::data_dir()?;
    let db_path = crate::data_dir::db_path()?;

    Ok(DataInfo {
        data_mode: crate::data_dir::data_mode_label().to_string(),
        data_dir: data_dir.display().to_string(),
        db_path: db_path.display().to_string(),
    })
}

#[tauri::command]
pub async fn drain_pending_cli_sends() -> CmdResult<Vec<service::PendingCliSend>> {
    run_blocking(service::drain_pending_cli_sends).await
}

/// `session_id` is the composer's bound `sessions.id` or its provisional
/// UUID. Required — paste-cache GC keys on it (see
/// `maintenance::paste_cache`).
#[tauri::command]
pub async fn save_pasted_image(
    data: String,
    media_type: String,
    session_id: String,
) -> CmdResult<String> {
    run_blocking(move || {
        use std::fs;
        use uuid::Uuid;

        let ext = match media_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "png",
        };

        // <paste-cache>/<session_id>/paste-<uuid>.<ext>; destination_dir
        // bails on path-unsafe ids.
        let paste_root = crate::data_dir::paste_cache_dir()?;
        let paste_dir = crate::maintenance::paste_cache::destination_dir(&paste_root, &session_id)?;
        fs::create_dir_all(&paste_dir).context("Failed to create paste-cache directory")?;

        let filename = format!("paste-{}.{}", Uuid::new_v4(), ext);
        let filepath = paste_dir.join(&filename);

        let bytes = base64_decode(&data).context("Invalid base64 data")?;

        fs::write(&filepath, &bytes)
            .with_context(|| format!("Failed to write pasted image to {}", filepath.display()))?;

        Ok(filepath.to_string_lossy().to_string())
    })
    .await
}

/// Write a UTF-8 string to an absolute path the user picked from the
/// `plugin-dialog` Save dialog.
///
/// We don't ship `tauri-plugin-fs`, and Tauri's webview also doesn't honour
/// the browser-style `<a download>` click that streamdown uses internally —
/// so the chat view's "Download as CSV / Markdown" buttons are dead unless
/// we route the write through the host process. The dialog already gates
/// the path on user intent, so we just make the parent dir if needed and
/// write.
#[tauri::command]
pub async fn save_text_file_as(path: String, contents: String) -> CmdResult<()> {
    run_blocking(move || {
        use std::fs;

        let target = std::path::PathBuf::from(&path);
        if !target.is_absolute() {
            anyhow::bail!(
                "Refusing to save to non-absolute path: {}",
                target.display()
            );
        }
        if let Some(parent) = target.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .with_context(|| format!("Failed to create directory {}", parent.display()))?;
            }
        }
        fs::write(&target, contents.as_bytes())
            .with_context(|| format!("Failed to write file {}", target.display()))?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn show_image_in_finder(path: String) -> CmdResult<()> {
    run_blocking(move || {
        let source = std::path::PathBuf::from(path);
        if !source.is_file() {
            return Err(anyhow::anyhow!(
                "Image file not found: {}",
                source.display()
            ));
        }
        reveal_file_in_finder(&source).context("Failed to show image in Finder")
    })
    .await
}

#[tauri::command]
pub async fn reveal_path_in_finder(path: String) -> CmdResult<()> {
    run_blocking(move || {
        let source = std::path::PathBuf::from(&path);
        if source.exists() {
            return reveal_file_in_finder(&source).context("Failed to reveal in Finder");
        }
        // File may have been deleted (e.g. a `D` change). Fall back to the
        // closest existing ancestor so the user still gets a useful Finder
        // window pointed at the right area of the workspace.
        if let Some(parent) = source.ancestors().skip(1).find(|p| p.exists()) {
            return open_directory_in_finder(parent)
                .context("Failed to open parent directory in Finder");
        }
        Err(anyhow::anyhow!("Path not found: {}", source.display()))
    })
    .await
}

#[tauri::command]
pub async fn copy_image_to_clipboard(path: String) -> CmdResult<()> {
    run_blocking(move || {
        let source = std::path::PathBuf::from(path);
        if !source.is_file() {
            return Err(anyhow::anyhow!(
                "Image file not found: {}",
                source.display()
            ));
        }
        copy_image_file_to_clipboard(&source).context("Failed to copy image")
    })
    .await
}

#[cfg(target_os = "macos")]
fn reveal_file_in_finder(path: &std::path::Path) -> anyhow::Result<()> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .context("open command failed")
}

#[cfg(not(target_os = "macos"))]
fn reveal_file_in_finder(_path: &std::path::Path) -> anyhow::Result<()> {
    anyhow::bail!("Showing images in Finder is only supported on macOS")
}

#[cfg(target_os = "macos")]
fn open_directory_in_finder(path: &std::path::Path) -> anyhow::Result<()> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .context("open command failed")
}

#[cfg(not(target_os = "macos"))]
fn open_directory_in_finder(_path: &std::path::Path) -> anyhow::Result<()> {
    anyhow::bail!("Opening Finder is only supported on macOS")
}

#[cfg(target_os = "macos")]
fn copy_image_file_to_clipboard(path: &std::path::Path) -> anyhow::Result<()> {
    let class_name = match path
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("jpg" | "jpeg") => "JPEG picture",
        Some("gif") => "GIF picture",
        _ => "«class PNGf»",
    };
    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as {class_name})",
        applescript_escape(&path.to_string_lossy())
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .context("osascript command failed")?;
    if output.status.success() {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn copy_image_file_to_clipboard(_path: &std::path::Path) -> anyhow::Result<()> {
    anyhow::bail!("Copying images is only supported on macOS")
}

fn applescript_escape(input: &str) -> String {
    input.replace('\\', "\\\\").replace('"', "\\\"")
}

fn base64_decode(input: &str) -> anyhow::Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| anyhow::anyhow!("base64 decode error: {e}"))
}

// ---------------------------------------------------------------------------
// Graceful quit (called from the frontend quit-confirmation dialog)
// ---------------------------------------------------------------------------

/// Shut down git watchers, abort active streams (when `force`), tear down
/// the sidecar cooperatively, then exit. Git watchers go first to stop new
/// events from arriving while we drain.
#[tauri::command]
pub async fn request_quit(app: tauri::AppHandle, force: bool) {
    tracing::info!(force, "request_quit invoked from frontend");

    // 1. Stop filesystem watchers so no new events arrive.
    app.state::<git_watcher::GitWatcherManager>().shutdown();

    // 2. If tasks are in flight, gracefully stop every active stream.
    if force {
        let sidecar = app.state::<sidecar::ManagedSidecar>();
        let active = app.state::<agents::ActiveStreams>();
        agents::abort_all_active_streams_blocking(
            &sidecar,
            &active,
            std::time::Duration::from_millis(1500),
        );
    }

    // 3. Signal every Run-tab script and embedded-terminal PTY so dev
    //    servers, watch processes, and shell sessions don't outlive
    //    Helmor as orphan process trees. Unconditional (not gated on
    //    `force`) — even a normal quit needs to clean up the processes
    //    Helmor itself spawned. Each handle's owning `run_script` thread
    //    reaps its own `Child`, so we just need to deliver the signal.
    let scripts = app.state::<ScriptProcessManager>();
    let signaled = scripts.kill_all();
    if signaled > 0 {
        tracing::info!(
            signaled,
            "request_quit: signaled live script/terminal handles"
        );
    }

    // Belt-and-suspenders: stamp every still-open runtime registry
    // row as ended, so the next launch's classification sweep
    // doesn't waste cycles probing PIDs we've already terminated.
    // The per-process `record_ended` calls in `run_script_with_shell`
    // cover the common case; this catches handles that didn't make
    // it through their reaper before app exit.
    match crate::workspace::runtime_registry::record_all_ended() {
        Ok(0) => {}
        Ok(stamped) => tracing::debug!(
            stamped,
            "request_quit: stamped runtime registry rows as ended"
        ),
        Err(error) => tracing::warn!(
            %error,
            "request_quit: failed to stamp runtime registry rows ended; \
             next launch's sweep will reclassify"
        ),
    }

    // 4. Cooperative sidecar teardown: shutdown RPC → SIGTERM → SIGKILL.
    let sidecar = app.state::<sidecar::ManagedSidecar>();
    let (cooperative, escalation) = if force {
        (
            std::time::Duration::from_millis(2000),
            std::time::Duration::from_millis(500),
        )
    } else {
        (
            std::time::Duration::from_millis(500),
            std::time::Duration::from_millis(200),
        )
    };
    sidecar.shutdown(cooperative, escalation);

    // 5. Done — terminate the process.
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Dev-only: nuclear data reset
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevResetResult {
    pub repos_deleted: usize,
    pub workspaces_deleted: usize,
    pub sessions_deleted: usize,
    pub messages_deleted: usize,
    pub directories_removed: Vec<String>,
}

/// Wipe **all** workspaces, sessions, messages, repos, and their filesystem
/// artefacts from the dev data directory.  Only compiled into debug builds.
///
/// Safety guard: the function asserts `data_dir::is_dev()` at runtime as well,
/// so even if someone somehow calls this from a release binary, it refuses.
#[tauri::command]
pub async fn dev_reset_all_data(app: tauri::AppHandle) -> CmdResult<DevResetResult> {
    // 1. Stop all active agent streams so they don't write into deleted sessions.
    {
        let sidecar_state = app.state::<sidecar::ManagedSidecar>();
        let active = app.state::<agents::ActiveStreams>();
        agents::abort_all_active_streams_blocking(
            &sidecar_state,
            &active,
            std::time::Duration::from_millis(1500),
        );
    }

    // 2. Stop all git watchers.
    {
        let manager = app.state::<git_watcher::GitWatcherManager>();
        manager.shutdown();
    }

    run_blocking(move || {
        use crate::data_dir;

        // Runtime double-check: never run in release.
        anyhow::ensure!(
            data_dir::is_dev(),
            "dev_reset_all_data called outside dev mode"
        );

        let data_dir = data_dir::data_dir()?;
        tracing::warn!(dir = %data_dir.display(), "DEV RESET: wiping all data");

        // --- Database cleanup (single transaction) -----------------------
        let mut conn = db::write_conn()?;
        let tx = conn
            .transaction()
            .context("Failed to start dev-reset transaction")?;

        let messages_deleted: usize = tx.execute("DELETE FROM session_messages", []).unwrap_or(0);
        let _plan_state: usize = tx
            .execute("DELETE FROM session_plan_state", [])
            .unwrap_or(0);
        let sessions_deleted: usize = tx.execute("DELETE FROM sessions", []).unwrap_or(0);
        let _pending: usize = tx.execute("DELETE FROM pending_cli_sends", []).unwrap_or(0);
        let workspaces_deleted: usize = tx.execute("DELETE FROM workspaces", []).unwrap_or(0);
        let repos_deleted: usize = tx.execute("DELETE FROM repos", []).unwrap_or(0);

        tx.commit()
            .context("Failed to commit dev-reset transaction")?;

        tracing::info!(
            repos_deleted,
            workspaces_deleted,
            sessions_deleted,
            messages_deleted,
            "DEV RESET: database cleared"
        );

        // --- Filesystem cleanup (best-effort) ----------------------------
        let mut dirs_removed = Vec::new();

        let dirs_to_clear = [
            data_dir.join("workspaces"),
            data_dir.join("cache").join("paste"),
        ];

        for dir in &dirs_to_clear {
            if dir.is_dir() {
                // Remove contents but recreate the empty directory.
                if std::fs::remove_dir_all(dir).is_ok() {
                    dirs_removed.push(dir.display().to_string());
                    std::fs::create_dir_all(dir).ok();
                }
            }
        }

        // Workspace-specific logs (keep the top-level logs/ dir).
        let ws_logs = data_dir.join("logs").join("workspaces");
        if ws_logs.is_dir() && std::fs::remove_dir_all(&ws_logs).is_ok() {
            dirs_removed.push(ws_logs.display().to_string());
        }

        tracing::info!(?dirs_removed, "DEV RESET: filesystem cleaned");

        Ok(DevResetResult {
            repos_deleted,
            workspaces_deleted,
            sessions_deleted,
            messages_deleted,
            directories_removed: dirs_removed,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn parse_semver_extracts_version_from_varied_cli_output() {
        assert_eq!(
            parse_semver("2.1.154 (Claude Code)").as_deref(),
            Some("2.1.154")
        );
        assert_eq!(
            parse_semver("codex-cli 0.137.0").as_deref(),
            Some("0.137.0")
        );
        assert_eq!(parse_semver("1.16.2\n").as_deref(), Some("1.16.2"));
        assert_eq!(parse_semver("v3.4.5").as_deref(), Some("3.4.5"));
        assert_eq!(
            parse_semver("1.2.3-beta.1").as_deref(),
            Some("1.2.3-beta.1")
        );
        assert_eq!(parse_semver("opencode cli"), None);
        assert_eq!(parse_semver("version 1.2"), None);
    }

    #[test]
    fn classify_cli_install_reports_missing_when_path_absent() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();

        let install_path = tmp.path().join("usr/local/bin/helmor");
        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Missing
        );
    }

    #[test]
    fn classify_cli_install_reports_managed_for_matching_symlink() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(install_path.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();
        std::os::unix::fs::symlink(&bundled_cli, &install_path).unwrap();

        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Managed
        );
    }

    #[test]
    fn classify_cli_install_reports_stale_for_regular_file_copy() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(install_path.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();
        fs::write(&install_path, "#!/bin/sh\n").unwrap();

        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Stale
        );
    }

    #[test]
    fn install_cli_symlink_replaces_stale_copy_with_managed_symlink() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(install_path.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();
        fs::write(&install_path, "#!/bin/sh\n").unwrap();

        install_cli_symlink(&bundled_cli, &install_path).unwrap();

        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Managed
        );
    }

    #[test]
    fn check_and_heal_cli_symlink_repoints_a_stale_link() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let old_cli = tmp.path().join("old-worktree/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor-dev");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(old_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(install_path.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();
        fs::write(&old_cli, "#!/bin/sh\n").unwrap();

        // Reproduce the dev-CLI breakage: the managed symlink points at a
        // different worktree's binary, so it reads as Stale.
        std::os::unix::fs::symlink(&old_cli, &install_path).unwrap();
        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Stale
        );

        // The plain (un-forced) heal a restart triggers re-points it with no
        // error and no sudo — the whole point of moving this out of the
        // per-version cache gate.
        assert_eq!(
            check_and_heal_cli_symlink(&install_path, &bundled_cli),
            None
        );
        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Managed
        );
    }

    #[test]
    fn cli_install_remediation_uses_force_replace_symlink_command() {
        let command = cli_install_remediation(
            std::path::Path::new("/Applications/Helmor.app/Contents/MacOS/helmor-cli"),
            std::path::Path::new("/usr/local/bin/helmor-dev"),
        );

        assert_eq!(
            command,
            "sudo ln -sfn '/Applications/Helmor.app/Contents/MacOS/helmor-cli' '/usr/local/bin/helmor-dev'"
        );
    }

    #[test]
    fn applescript_shell_arg_quotes_plain_path() {
        assert_eq!(
            applescript_shell_arg(std::path::Path::new("/usr/local/bin/helmor")),
            "'/usr/local/bin/helmor'"
        );
    }

    #[test]
    fn applescript_shell_arg_escapes_single_quote_for_shell_then_applescript() {
        // Shell-quote turns `'` into `'\''`; the embedded backslash then needs
        // to survive AppleScript string-literal parsing, so it doubles to `\\`.
        assert_eq!(
            applescript_shell_arg(std::path::Path::new("/Users/me/foo's app")),
            r"'/Users/me/foo'\\''s app'"
        );
    }

    #[test]
    fn applescript_shell_arg_escapes_double_quote_and_backslash() {
        assert_eq!(
            applescript_shell_arg(std::path::Path::new("/foo\"bar\\baz")),
            r#"'/foo\"bar\\baz'"#
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_elevated_install_script_produces_expected_osascript_payload() {
        let bundled_cli =
            std::path::Path::new("/Applications/Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = std::path::Path::new("/usr/local/bin/helmor");

        let script = build_elevated_install_script(bundled_cli, install_path);

        let expected_inner = "/bin/mkdir -p '/usr/local/bin' && /bin/ln -sfn \
                              '/Applications/Helmor.app/Contents/MacOS/helmor-cli' \
                              '/usr/local/bin/helmor'";
        assert!(
            script.contains(expected_inner),
            "script missing expected shell command: {script}"
        );
        assert!(
            script.contains("with administrator privileges"),
            "script missing privilege escalation clause: {script}"
        );
        assert!(
            script.contains("with prompt \""),
            "script missing prompt clause: {script}"
        );
    }

    // --- silent components-check helpers -----------------------------------

    #[test]
    fn try_install_cli_silent_at_creates_symlink_when_target_writable() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();

        // No existing install path — the function should mkdir + symlink
        // without any escalation.
        try_install_cli_silent_at(&bundled_cli, &install_path).unwrap();

        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Managed
        );
    }

    #[test]
    fn try_install_cli_silent_at_replaces_stale_copy_in_writable_dir() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(install_path.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();
        fs::write(&install_path, "#!/bin/sh\n# stale\n").unwrap();

        try_install_cli_silent_at(&bundled_cli, &install_path).unwrap();

        assert_eq!(
            classify_cli_install(&install_path, &bundled_cli),
            CliInstallState::Managed
        );
    }

    #[test]
    fn try_install_cli_silent_at_bails_when_target_is_directory() {
        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        let install_path = tmp.path().join("usr/local/bin/helmor");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::create_dir_all(&install_path).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();

        let err = try_install_cli_silent_at(&bundled_cli, &install_path).unwrap_err();
        assert!(
            err.to_string().contains("is a directory"),
            "expected directory-guard message, got: {err}"
        );
    }

    #[test]
    fn try_install_cli_silent_at_bails_with_friendly_message_on_permission_denied() {
        // Pick a parent that almost certainly isn't writable to the test
        // user. macOS test runners can't write to /usr/local/bin in CI
        // without sudo — exactly the condition we want to exercise.
        // Skip the test if for some reason we CAN write there (e.g. dev
        // with broken perms) — passing in either case is wrong.
        let install_path = std::path::PathBuf::from("/usr/local/bin/__helmor_test_silent_probe");
        if install_path.exists() || std::fs::write(&install_path, b"x").is_ok() {
            // Cleanup so a future run isn't polluted.
            let _ = std::fs::remove_file(&install_path);
            eprintln!("skipping permission-denied test: /usr/local/bin is writable here");
            return;
        }

        let tmp = tempdir().unwrap();
        let bundled_cli = tmp.path().join("Helmor.app/Contents/MacOS/helmor-cli");
        fs::create_dir_all(bundled_cli.parent().unwrap()).unwrap();
        fs::write(&bundled_cli, "#!/bin/sh\n").unwrap();

        let err = try_install_cli_silent_at(&bundled_cli, &install_path).unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("administrator access") && message.contains("Retry"),
            "expected friendly sudo message, got: {message}"
        );
    }
}
