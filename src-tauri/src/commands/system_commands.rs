use anyhow::Context;
use serde::Serialize;
use tauri::Manager;

use crate::{
    agents, git_watcher, models::db, models::workspaces as workspace_models, service, sidecar,
};

use super::common::{run_blocking, CmdResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataInfo {
    pub data_mode: String,
    pub data_dir: String,
    pub db_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub installed: bool,
    pub install_path: Option<String>,
    pub build_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Where Helmor installs its CLI binary per OS.
///
/// - macOS & Linux: `/usr/local/bin/helmor` (matches the existing `dev:cli:install`
///   script; Linux users with a writable `/usr/local/bin` or `sudo` get the
///   same path semantics).
/// - Windows: `%LOCALAPPDATA%\Helmor\bin\helmor.exe` — user-level, avoids the
///   UAC prompt and admin requirement of Program Files. Users can add the
///   directory to their PATH themselves (tracked for a later UX pass).
fn cli_install_target() -> anyhow::Result<std::path::PathBuf> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        Ok(std::path::PathBuf::from("/usr/local/bin/helmor"))
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|p| std::path::PathBuf::from(p).join("AppData").join("Local"))
            })
            .context("Cannot determine %LOCALAPPDATA% for CLI install target")?;
        Ok(base.join("Helmor").join("bin").join("helmor.exe"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        Ok(std::path::PathBuf::from("/usr/local/bin/helmor"))
    }
}

/// Name of the compiled CLI binary produced by `cargo build --bin helmor-cli`
/// on the current platform. Windows auto-appends `.exe`.
fn cli_source_binary_name() -> &'static str {
    if cfg!(windows) {
        "helmor-cli.exe"
    } else {
        "helmor-cli"
    }
}

#[tauri::command]
pub fn get_cli_status() -> CmdResult<CliStatus> {
    let install_path = cli_install_target()?;
    let installed = install_path.exists();
    Ok(CliStatus {
        installed,
        install_path: if installed {
            Some(install_path.display().to_string())
        } else {
            None
        },
        build_mode: crate::data_dir::data_mode_label().to_string(),
    })
}

#[tauri::command]
pub async fn install_cli() -> CmdResult<CliStatus> {
    run_blocking(|| {
        let source = std::env::current_exe()?;
        let target_dir = source
            .parent()
            .context("Cannot determine binary directory")?;
        let cli_binary = target_dir.join(cli_source_binary_name());

        if !cli_binary.exists() {
            anyhow::bail!(
                "CLI binary not found at {}. Run `cargo build --bin helmor-cli` first.",
                cli_binary.display()
            );
        }

        let install_path = cli_install_target()?;
        if let Some(parent) = install_path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("Failed to create install directory {}", parent.display())
            })?;
        }
        std::fs::copy(&cli_binary, &install_path).with_context(|| {
            #[cfg(unix)]
            {
                format!(
                    "Failed to copy CLI to {}. You may need to run: sudo cp {} {}",
                    install_path.display(),
                    cli_binary.display(),
                    install_path.display()
                )
            }
            #[cfg(windows)]
            {
                format!(
                    "Failed to copy CLI to {}. Check that the target directory is writable.",
                    install_path.display()
                )
            }
        })?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&install_path, std::fs::Permissions::from_mode(0o755))?;
        }

        Ok(CliStatus {
            installed: true,
            install_path: Some(install_path.display().to_string()),
            build_mode: crate::data_dir::data_mode_label().to_string(),
        })
    })
    .await
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
pub async fn detect_installed_editors() -> CmdResult<Vec<DetectedEditor>> {
    run_blocking(detect_installed_editors_blocking).await
}

#[cfg(target_os = "macos")]
fn detect_installed_editors_blocking() -> anyhow::Result<Vec<DetectedEditor>> {
    let mut editors = Vec::new();

    let candidates: &[(&str, &str, &[&str])] = &[
        (
            "cursor",
            "Cursor",
            &["/Applications/Cursor.app", "$HOME/Applications/Cursor.app"],
        ),
        (
            "vscode",
            "VS Code",
            &[
                "/Applications/Visual Studio Code.app",
                "$HOME/Applications/Visual Studio Code.app",
            ],
        ),
        (
            "vscode-insiders",
            "VS Code Insiders",
            &[
                "/Applications/Visual Studio Code - Insiders.app",
                "$HOME/Applications/Visual Studio Code - Insiders.app",
            ],
        ),
        (
            "windsurf",
            "Windsurf",
            &[
                "/Applications/Windsurf.app",
                "$HOME/Applications/Windsurf.app",
            ],
        ),
        (
            "zed",
            "Zed",
            &["/Applications/Zed.app", "$HOME/Applications/Zed.app"],
        ),
        (
            "webstorm",
            "WebStorm",
            &[
                "/Applications/WebStorm.app",
                "$HOME/Applications/WebStorm.app",
            ],
        ),
        (
            "sublime",
            "Sublime Text",
            &[
                "/Applications/Sublime Text.app",
                "$HOME/Applications/Sublime Text.app",
            ],
        ),
        (
            "terminal",
            "Terminal",
            &["/System/Applications/Utilities/Terminal.app"],
        ),
        (
            "warp",
            "Warp",
            &["/Applications/Warp.app", "$HOME/Applications/Warp.app"],
        ),
    ];

    let home = std::env::var("HOME").unwrap_or_default();

    for (id, name, paths) in candidates {
        for path in *paths {
            let resolved = path.replace("$HOME", &home);
            if std::path::Path::new(&resolved).exists() {
                editors.push(DetectedEditor {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: resolved,
                });
                break;
            }
        }
    }

    Ok(editors)
}

/// Windows editor detection: probe %LOCALAPPDATA%\Programs and
/// %PROGRAMFILES% for VS Code-family installers and Cursor/Zed.
/// Returns the first hit per id — users can re-pick in the UI.
#[cfg(windows)]
fn detect_installed_editors_blocking() -> anyhow::Result<Vec<DetectedEditor>> {
    use std::path::PathBuf;
    let mut editors = Vec::new();

    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let program_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
    let user_home = std::env::var_os("USERPROFILE").map(PathBuf::from);

    // Each candidate is (id, name, relative-paths-to-probe-under-base).
    // We probe each base (LOCALAPPDATA, ProgramFiles, ProgramFiles(x86), USERPROFILE).
    let candidates: &[(&str, &str, &[&str])] = &[
        (
            "cursor",
            "Cursor",
            &["Programs\\cursor\\Cursor.exe", "cursor\\Cursor.exe"],
        ),
        (
            "vscode",
            "VS Code",
            &[
                "Programs\\Microsoft VS Code\\Code.exe",
                "Microsoft VS Code\\Code.exe",
            ],
        ),
        (
            "vscode-insiders",
            "VS Code Insiders",
            &[
                "Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe",
                "Microsoft VS Code Insiders\\Code - Insiders.exe",
            ],
        ),
        (
            "windsurf",
            "Windsurf",
            &["Programs\\Windsurf\\Windsurf.exe", "Windsurf\\Windsurf.exe"],
        ),
        ("zed", "Zed", &["Programs\\Zed\\Zed.exe", "Zed\\Zed.exe"]),
        (
            "webstorm",
            "WebStorm",
            &[
                "JetBrains\\WebStorm\\bin\\webstorm64.exe",
                "JetBrains\\WebStorm\\bin\\webstorm.exe",
            ],
        ),
        (
            "sublime",
            "Sublime Text",
            &[
                "Sublime Text\\sublime_text.exe",
                "Sublime Text 3\\sublime_text.exe",
            ],
        ),
        (
            "warp",
            "Warp",
            &["Programs\\Warp\\warp.exe", "Warp\\warp.exe"],
        ),
    ];

    for (id, name, rels) in candidates {
        for base in [&local, &program_files, &program_files_x86, &user_home]
            .iter()
            .copied()
            .flatten()
        {
            let mut found = None;
            for rel in *rels {
                let candidate = base.join(rel);
                if candidate.is_file() {
                    found = Some(candidate);
                    break;
                }
            }
            if let Some(path) = found {
                editors.push(DetectedEditor {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    path: path.display().to_string(),
                });
                break;
            }
        }
    }

    Ok(editors)
}

/// Linux editor detection: parse the standard XDG `.desktop` locations
/// (`~/.local/share/applications` and `/usr/share/applications`) and match
/// well-known app ids to their `Exec=` line.
#[cfg(all(unix, not(target_os = "macos")))]
fn detect_installed_editors_blocking() -> anyhow::Result<Vec<DetectedEditor>> {
    use std::path::PathBuf;
    let mut editors = Vec::new();

    // Desktop-file-name → (id, display-name).
    let targets: &[(&str, &str, &str)] = &[
        ("cursor.desktop", "cursor", "Cursor"),
        ("code.desktop", "vscode", "VS Code"),
        (
            "code-insiders.desktop",
            "vscode-insiders",
            "VS Code Insiders",
        ),
        ("windsurf.desktop", "windsurf", "Windsurf"),
        ("dev.zed.Zed.desktop", "zed", "Zed"),
        ("zed.desktop", "zed", "Zed"),
        ("jetbrains-webstorm.desktop", "webstorm", "WebStorm"),
        ("sublime_text.desktop", "sublime", "Sublime Text"),
        ("dev.warp.Warp.desktop", "warp", "Warp"),
    ];

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        search_dirs.push(h.join(".local/share/applications"));
        search_dirs.push(h.join(".local/share/flatpak/exports/share/applications"));
    }
    search_dirs.push(PathBuf::from("/usr/share/applications"));
    search_dirs.push(PathBuf::from("/usr/local/share/applications"));
    search_dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));

    let mut seen_ids = std::collections::HashSet::new();
    for (filename, id, name) in targets {
        if seen_ids.contains(id) {
            continue;
        }
        for dir in &search_dirs {
            let candidate = dir.join(filename);
            if !candidate.is_file() {
                continue;
            }
            let Ok(contents) = std::fs::read_to_string(&candidate) else {
                continue;
            };
            // Very small `.desktop` parser — just pluck `Exec=` up to the first
            // non-path arg placeholder (%f / %u). The editor id is already in
            // the known set, so we don't need a full ini parser.
            let exec_line = contents
                .lines()
                .filter(|l| !l.starts_with('#'))
                .find_map(|l| l.strip_prefix("Exec="))
                .unwrap_or("");
            let exec = exec_line
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches('"');
            if exec.is_empty() {
                continue;
            }
            editors.push(DetectedEditor {
                id: (*id).to_string(),
                name: (*name).to_string(),
                path: exec.to_string(),
            });
            seen_ids.insert(*id);
            break;
        }
    }

    // Fall back to terminal + warp on PATH if not found via .desktop.
    // (Intentionally limited — users on headless servers probably don't want
    // a long list of shells as "editors".)

    Ok(editors)
}

#[tauri::command]
pub async fn open_workspace_in_editor(workspace_id: String, editor: String) -> CmdResult<()> {
    run_blocking(move || {
        let record = workspace_models::load_workspace_record_by_id(&workspace_id)?
            .with_context(|| format!("Workspace not found: {workspace_id}"))?;

        let workspace_dir =
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)?;
        if !workspace_dir.is_dir() {
            return Err(anyhow::anyhow!(
                "Workspace directory not found: {}",
                workspace_dir.display()
            ));
        }

        // Validate editor id against the allow-list shared with
        // detect_installed_editors so we never spawn arbitrary binaries.
        const KNOWN: &[&str] = &[
            "cursor",
            "vscode",
            "vscode-insiders",
            "windsurf",
            "zed",
            "webstorm",
            "sublime",
            "terminal",
            "warp",
        ];
        if !KNOWN.contains(&editor.as_str()) {
            return Err(anyhow::anyhow!("Unsupported editor: {editor}"));
        }

        launch_editor_with_dir(&editor, &workspace_dir)
            .with_context(|| format!("Failed to open {editor}"))
    })
    .await
}

/// Platform-specific editor launcher. macOS keeps using `open -a` with a
/// friendly app name so the existing Launch Services association is
/// respected. Windows/Linux look the editor up via `detect_installed_editors`
/// to find an absolute path, then spawn it directly with the directory as
/// its first argument. If detection doesn't find the editor, we fall back to
/// a `xdg-open <dir>` / `start "" <dir>` that opens the directory with the
/// user's default handler — imperfect but graceful.
#[cfg(target_os = "macos")]
fn launch_editor_with_dir(editor: &str, dir: &std::path::Path) -> anyhow::Result<()> {
    let app_name = mac_app_name_for_editor(editor)
        .ok_or_else(|| anyhow::anyhow!("Unsupported editor: {editor}"))?;
    let dir_str = dir.display().to_string();
    std::process::Command::new("open")
        .args(["-a", app_name, &dir_str])
        .spawn()
        .map(|_| ())
        .context("open command failed")
}

#[cfg(target_os = "macos")]
fn mac_app_name_for_editor(editor: &str) -> Option<&'static str> {
    Some(match editor {
        "cursor" => "Cursor",
        "vscode" => "Visual Studio Code",
        "vscode-insiders" => "Visual Studio Code - Insiders",
        "windsurf" => "Windsurf",
        "zed" => "Zed",
        "webstorm" => "WebStorm",
        "sublime" => "Sublime Text",
        "terminal" => "Terminal",
        "warp" => "Warp",
        _ => return None,
    })
}

#[cfg(not(target_os = "macos"))]
fn launch_editor_with_dir(editor: &str, dir: &std::path::Path) -> anyhow::Result<()> {
    // Look up the editor via the same detection pipeline used by the UI so
    // the absolute path is canonical. If detection missed this editor we
    // fall back to the OS default-handler opener.
    let detected = detect_installed_editors_blocking().unwrap_or_default();
    let editor_path = detected
        .into_iter()
        .find(|e| e.id == editor)
        .map(|e| std::path::PathBuf::from(e.path));

    let dir_str = dir.display().to_string();

    if let Some(path) = editor_path {
        std::process::Command::new(&path)
            .arg(&dir_str)
            .spawn()
            .with_context(|| format!("Failed to spawn {}", path.display()))?;
        return Ok(());
    }

    // Fallback: delegate to the system default handler.
    #[cfg(windows)]
    {
        // `cmd /C start "" <dir>` opens the directory with Explorer's default.
        // The empty title (`""`) is required because `start` otherwise
        // interprets the quoted path as a window title.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &dir_str])
            .spawn()
            .context("cmd /C start command failed")?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir_str)
            .spawn()
            .context("xdg-open command failed")?;
    }

    Ok(())
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
    pub attachments_deleted: usize,
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
        let mut conn = db::open_connection(true)?;
        let tx = conn
            .transaction()
            .context("Failed to start dev-reset transaction")?;

        let attachments_deleted: usize = tx.execute("DELETE FROM attachments", []).unwrap_or(0);
        let messages_deleted: usize = tx.execute("DELETE FROM session_messages", []).unwrap_or(0);
        let sessions_deleted: usize = tx.execute("DELETE FROM sessions", []).unwrap_or(0);
        let _diff_comments: usize = tx.execute("DELETE FROM diff_comments", []).unwrap_or(0);
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
            data_dir.join("archived-contexts"),
            data_dir.join("paste-cache"),
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
            attachments_deleted,
            directories_removed: dirs_removed,
        })
    })
    .await
}
