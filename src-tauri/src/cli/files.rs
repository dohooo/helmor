//! `helmor files` — list, read, write, stage, discard workspace files.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::editor_files;
use crate::models::workspaces as workspace_models;
use crate::service;
use crate::ui_sync::UiMutationEvent;

use super::args::{Cli, FilesAction};
use super::{notify_ui_event, output};

pub fn dispatch(action: &FilesAction, cli: &Cli) -> Result<()> {
    match action {
        FilesAction::Changes { workspace_ref } => changes(workspace_ref, cli),
        FilesAction::List { workspace_ref } => list(workspace_ref, cli),
        FilesAction::Show {
            workspace_ref,
            path,
            git_ref,
        } => show(workspace_ref, path, git_ref.as_deref(), cli),
        FilesAction::Write {
            workspace_ref,
            path,
        } => write(workspace_ref, path, cli),
        FilesAction::Stage {
            workspace_ref,
            path,
        } => stage(workspace_ref, path, cli),
        FilesAction::Unstage {
            workspace_ref,
            path,
        } => unstage(workspace_ref, path, cli),
        FilesAction::Discard {
            workspace_ref,
            path,
        } => discard(workspace_ref, path, cli),
    }
}

fn resolve_workspace(workspace_ref: &str) -> Result<(String, PathBuf)> {
    let id = service::resolve_workspace_ref(workspace_ref)?;
    let record = workspace_models::load_workspace_record_by_id(&id)?
        .with_context(|| format!("Workspace not found: {id}"))?;
    let root = crate::workspace::helpers::workspace_path(&record)?;
    Ok((id, root))
}

/// Turn a possibly-relative `<path>` into an absolute path inside the
/// workspace. Absolute paths are passed through.
fn resolve_absolute(workspace_root: &Path, path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace_root.join(candidate)
    }
}

fn changes(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let (_, root) = resolve_workspace(workspace_ref)?;
    let items = editor_files::list_workspace_changes(&root.display().to_string())?;
    output::print(cli, &items, |items| format_list(items))
}

fn list(workspace_ref: &str, cli: &Cli) -> Result<()> {
    let (_, root) = resolve_workspace(workspace_ref)?;
    let items = editor_files::list_workspace_files(&root.display().to_string())?;
    output::print(cli, &items, |items| format_list(items))
}

fn format_list(items: &[editor_files::EditorFileListItem]) -> String {
    if items.is_empty() {
        return "No files.".to_string();
    }
    items
        .iter()
        .map(|f| {
            format!(
                "{}\t+{} -{}\t{}",
                f.status, f.insertions, f.deletions, f.path
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn show(workspace_ref: &str, path: &str, git_ref: Option<&str>, cli: &Cli) -> Result<()> {
    let (_, root) = resolve_workspace(workspace_ref)?;
    let absolute = resolve_absolute(&root, path);
    if let Some(git_ref) = git_ref {
        let content = editor_files::read_file_at_ref(
            &root.display().to_string(),
            &absolute.display().to_string(),
            git_ref,
        )?;
        match content {
            Some(body) => {
                if cli.json {
                    let payload = serde_json::json!({ "path": absolute.display().to_string(), "ref": git_ref, "content": body });
                    println!("{}", serde_json::to_string_pretty(&payload)?);
                } else {
                    print!("{body}");
                }
            }
            None => anyhow::bail!("File does not exist at ref {git_ref}"),
        }
        return Ok(());
    }

    let response = editor_files::read_editor_file(&absolute.display().to_string())?;
    if cli.json {
        println!("{}", serde_json::to_string_pretty(&response)?);
    } else {
        print!("{}", response.content);
    }
    Ok(())
}

fn write(workspace_ref: &str, path: &str, cli: &Cli) -> Result<()> {
    let (workspace_id, root) = resolve_workspace(workspace_ref)?;
    let absolute = resolve_absolute(&root, path);
    let mut content = String::new();
    std::io::stdin()
        .read_to_string(&mut content)
        .context("Failed to read new file content from stdin")?;
    let response = editor_files::write_editor_file(&absolute.display().to_string(), &content)?;
    notify_ui_event(UiMutationEvent::WorkspaceFilesChanged { workspace_id });
    output::print(cli, &response, |r| format!("Wrote {}", r.path))
}

fn stage(workspace_ref: &str, path: &str, cli: &Cli) -> Result<()> {
    let (workspace_id, root) = resolve_workspace(workspace_ref)?;
    editor_files::stage_workspace_file(&root.display().to_string(), path)?;
    notify_ui_event(UiMutationEvent::WorkspaceFilesChanged { workspace_id });
    output::print_ok(cli, &format!("Staged {path}"));
    Ok(())
}

fn unstage(workspace_ref: &str, path: &str, cli: &Cli) -> Result<()> {
    let (workspace_id, root) = resolve_workspace(workspace_ref)?;
    editor_files::unstage_workspace_file(&root.display().to_string(), path)?;
    notify_ui_event(UiMutationEvent::WorkspaceFilesChanged { workspace_id });
    output::print_ok(cli, &format!("Unstaged {path}"));
    Ok(())
}

fn discard(workspace_ref: &str, path: &str, cli: &Cli) -> Result<()> {
    let (workspace_id, root) = resolve_workspace(workspace_ref)?;
    editor_files::discard_workspace_file(&root.display().to_string(), path)?;
    notify_ui_event(UiMutationEvent::WorkspaceFilesChanged { workspace_id });
    output::print_ok(cli, &format!("Discarded changes in {path}"));
    Ok(())
}
