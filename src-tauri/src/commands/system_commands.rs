use anyhow::Context;
use serde::Serialize;

use crate::{models::workspaces as workspace_models, service};

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

#[tauri::command]
pub fn get_cli_status() -> CmdResult<CliStatus> {
    let install_path = std::path::Path::new("/usr/local/bin/helmor");
    Ok(CliStatus {
        installed: install_path.exists(),
        install_path: if install_path.exists() {
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
        let cli_binary = target_dir.join("helmor-cli");

        if !cli_binary.exists() {
            anyhow::bail!(
                "CLI binary not found at {}. Run `cargo build --bin helmor-cli` first.",
                cli_binary.display()
            );
        }

        let install_path = std::path::PathBuf::from("/usr/local/bin/helmor");
        std::fs::copy(&cli_binary, &install_path).with_context(|| {
            format!(
                "Failed to copy CLI to {}. You may need to run: sudo cp {} {}",
                install_path.display(),
                cli_binary.display(),
                install_path.display()
            )
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

        let dir_str = workspace_dir.display().to_string();
        let app_name = match editor.as_str() {
            "cursor" => "Cursor",
            "vscode" => "Visual Studio Code",
            "vscode-insiders" => "Visual Studio Code - Insiders",
            "windsurf" => "Windsurf",
            "zed" => "Zed",
            "webstorm" => "WebStorm",
            "sublime" => "Sublime Text",
            "terminal" => "Terminal",
            "warp" => "Warp",
            _ => return Err(anyhow::anyhow!("Unsupported editor: {editor}")),
        };

        std::process::Command::new("open")
            .args(["-a", app_name, &dir_str])
            .spawn()
            .with_context(|| format!("Failed to open {editor}"))?;
        Ok(())
    })
    .await
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
