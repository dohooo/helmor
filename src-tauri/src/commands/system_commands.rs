use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{LazyLock, Mutex};

use anyhow::Context;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{
    LogicalSize, LogicalUnit, Manager, PixelUnit, Size, State, Window, WindowSizeConstraints,
};

use crate::workspace::scripts::{ScriptContext, ScriptEvent, ScriptProcessManager};
use crate::{agents, data_dir, git_watcher, models::db, service, sidecar};

use super::common::{run_blocking, CmdResult};

// Best-fit fixed window size for the current onboarding motion layout.
// Resizing is restored when onboarding exits.
const ONBOARDING_WINDOW_WIDTH: f64 = 1300.0;
const ONBOARDING_WINDOW_HEIGHT: f64 = 810.0;
const HELMOR_SKILL_NAME: &str = "helmor-cli";
const HELMOR_SKILL_SOURCE: &str = "dohooo/helmor/.codex/skills/helmor-cli";

static ONBOARDING_WINDOW_STATE: LazyLock<Mutex<HashMap<String, bool>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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

/// Where Helmor installs its managed CLI entrypoint on macOS.
fn cli_install_target() -> std::path::PathBuf {
    std::path::PathBuf::from(format!("/usr/local/bin/{}", installed_cli_name()))
}

fn installed_cli_name() -> &'static str {
    if crate::data_dir::is_dev() {
        "helmor-dev"
    } else {
        "helmor"
    }
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
        name = installed_cli_name(),
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
            codex: codex_login_ready(),
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

/// File-backed React Query persister storage. The cache lives in the
/// data dir (next to `helmor.db`) instead of localStorage, so it isn't
/// bound by the webview's ~5–10 MB localStorage quota. The frontend
/// addresses each cache key as a distinct file under
/// `<data_dir>/query-cache/<key>` — only one key is in use today
/// (`helmor-query-cache`), but the namespacing keeps the door open for
/// the persister's optional `entries()` extension.
fn query_cache_dir() -> anyhow::Result<PathBuf> {
    let dir = data_dir::data_dir()?.join("query-cache");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("Failed to create query cache dir at {dir:?}"))?;
    Ok(dir)
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
            codex: codex_login_ready(),
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

        Ok(helmor_skills_status_for_agents(&agents))
    })
    .await
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

#[tauri::command]
pub async fn open_agent_login_terminal(provider: String) -> CmdResult<()> {
    run_blocking(move || open_agent_login_terminal_impl(&provider)).await
}

#[tauri::command]
pub async fn get_agent_login_status() -> CmdResult<AgentLoginStatus> {
    run_blocking(|| {
        Ok(AgentLoginStatus {
            claude: claude_login_ready(),
            codex: codex_login_ready(),
        })
    })
    .await
}

fn claude_login_ready() -> bool {
    match std::process::Command::new("claude")
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

fn codex_login_ready() -> bool {
    match std::process::Command::new("codex")
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

fn agent_login_command(provider: &str) -> anyhow::Result<&'static str> {
    match provider {
        "claude" => Ok("claude auth login"),
        "codex" => Ok("codex login"),
        _ => anyhow::bail!("Unknown agent provider: {provider}"),
    }
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
    let command = agent_login_command(&provider)?.to_string();
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
    let script_command = applescript_string(command);
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

#[tauri::command]
pub async fn save_pasted_image(data: String, media_type: String) -> CmdResult<String> {
    run_blocking(move || {
        use std::fs;
        use uuid::Uuid;

        let ext = match media_type.as_str() {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "png",
        };

        let paste_dir = crate::data_dir::data_dir()?.join("paste-cache");
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

    // 3. Cooperative sidecar teardown: shutdown RPC → SIGTERM → SIGKILL.
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

    // 4. Done — terminate the process.
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

        let dirs_to_clear = [data_dir.join("workspaces"), data_dir.join("paste-cache")];

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
}
