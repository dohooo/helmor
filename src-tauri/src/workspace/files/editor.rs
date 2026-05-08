use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};

use super::{
    support::{
        atomic_write_file, collect_editor_files, collect_workspace_files_for_mention,
        editor_file_sort_key, metadata_mtime_ms, resolve_allowed_path,
    },
    types::{
        EditorFileListItem, EditorFilePrefetchItem, EditorFileReadResponse, EditorFileStatResponse,
        EditorFileWriteResponse, EditorFilesWithContentResponse,
    },
};
use crate::{
    bail_coded,
    error::{AnyhowCodedExt, ErrorCode},
};

const MAX_EDITOR_FILE_ITEMS: usize = 24;
const MAX_PREFETCH_BYTES: u64 = 1_048_576;

/// Read a file at a given git ref. Returns `None` when the path doesn't
/// exist in that ref, or when the workspace itself has vanished (e.g. the
/// user deleted the worktree while an old diff view was still open).
pub fn read_file_at_ref(
    workspace_root_path: &str,
    file_path: &str,
    git_ref: &str,
) -> Result<Option<String>> {
    let workspace_root = Path::new(workspace_root_path);
    if !workspace_root.is_absolute() {
        bail!(
            "Workspace root must be an absolute path: {}",
            workspace_root.display()
        );
    }
    if !workspace_root.is_dir() {
        return Ok(None);
    }

    let abs = Path::new(file_path);
    let relative = abs
        .strip_prefix(workspace_root)
        .with_context(|| format!("{file_path} is not inside {workspace_root_path}"))?;
    let relative_str = relative.to_string_lossy().replace('\\', "/");

    let object = format!("{git_ref}:{relative_str}");
    match crate::git_ops::run_git(["show", &object], Some(workspace_root)) {
        Ok(content) => Ok(Some(content)),
        Err(_) => Ok(None),
    }
}

pub fn read_editor_file(path: &str) -> Result<EditorFileReadResponse> {
    let resolved_path = resolve_allowed_path(Path::new(path), false)?;
    let metadata = match fs::metadata(&resolved_path) {
        Ok(metadata) => metadata,
        // File or any parent component vanished after the open — treat as
        // broken workspace so the frontend offers a recovery action rather
        // than a bare "no such file" toast.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(anyhow::Error::new(error)
                .context(format!(
                    "Editor file no longer exists: {}",
                    resolved_path.display()
                ))
                .with_code(ErrorCode::WorkspaceBroken));
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to stat editor file {}", resolved_path.display()))
        }
    };

    if !metadata.is_file() {
        bail!("Editor target is not a file: {}", resolved_path.display());
    }

    let bytes = fs::read(&resolved_path)
        .with_context(|| format!("Failed to read editor file {}", resolved_path.display()))?;
    let content = String::from_utf8(bytes).with_context(|| {
        format!(
            "Editor file is not valid UTF-8: {}",
            resolved_path.display()
        )
    })?;

    Ok(EditorFileReadResponse {
        path: resolved_path.display().to_string(),
        content,
        mtime_ms: metadata_mtime_ms(&metadata)?,
    })
}

pub fn write_editor_file(path: &str, content: &str) -> Result<EditorFileWriteResponse> {
    let resolved_path = resolve_allowed_path(Path::new(path), false)?;
    let metadata = match fs::metadata(&resolved_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // Target file or parent dir vanished between open and save.
            // Bail with a recoverable code; the editor should prompt to
            // reload / save elsewhere rather than surface a plain error.
            bail_coded!(
                ErrorCode::WorkspaceBroken,
                "Cannot save: {} no longer exists on disk",
                resolved_path.display()
            );
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Failed to stat editor file {}", resolved_path.display()))
        }
    };

    if !metadata.is_file() {
        bail!("Editor target is not a file: {}", resolved_path.display());
    }

    atomic_write_file(&resolved_path, content.as_bytes())?;

    let updated_metadata = fs::metadata(&resolved_path).with_context(|| {
        format!(
            "Failed to stat editor file after save {}",
            resolved_path.display()
        )
    })?;

    Ok(EditorFileWriteResponse {
        path: resolved_path.display().to_string(),
        mtime_ms: metadata_mtime_ms(&updated_metadata)?,
    })
}

pub fn stat_editor_file(path: &str) -> Result<EditorFileStatResponse> {
    let resolved_path = resolve_allowed_path(Path::new(path), false)?;

    match fs::metadata(&resolved_path) {
        Ok(metadata) => Ok(EditorFileStatResponse {
            path: resolved_path.display().to_string(),
            exists: true,
            is_file: metadata.is_file(),
            mtime_ms: Some(metadata_mtime_ms(&metadata)?),
            size: Some(metadata.len() as i64),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EditorFileStatResponse {
            path: resolved_path.display().to_string(),
            exists: false,
            is_file: false,
            mtime_ms: None,
            size: None,
        }),
        Err(error) => Err(error)
            .with_context(|| format!("Failed to stat editor file {}", resolved_path.display())),
    }
}

pub fn list_editor_files(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let Some(workspace_root) = resolve_workspace_root_optional(workspace_root_path)? else {
        return Ok(Vec::new());
    };
    let mut discovered_files = Vec::<PathBuf>::new();
    collect_editor_files(&workspace_root, &workspace_root, &mut discovered_files)?;
    discovered_files.sort_by(|left, right| {
        editor_file_sort_key(&workspace_root, left)
            .cmp(&editor_file_sort_key(&workspace_root, right))
    });
    discovered_files.truncate(MAX_EDITOR_FILE_ITEMS);

    Ok(build_list_items(&workspace_root, discovered_files))
}

pub fn list_workspace_files(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let Some(workspace_root) = resolve_workspace_root_optional(workspace_root_path)? else {
        return Ok(Vec::new());
    };
    let mut discovered_files = Vec::<PathBuf>::new();
    collect_workspace_files_for_mention(&workspace_root, &mut discovered_files)?;
    discovered_files.sort_by(|left, right| {
        editor_file_sort_key(&workspace_root, left)
            .cmp(&editor_file_sort_key(&workspace_root, right))
    });

    Ok(build_list_items(&workspace_root, discovered_files))
}

pub fn list_editor_files_with_content(
    workspace_root_path: &str,
) -> Result<EditorFilesWithContentResponse> {
    let items = list_editor_files(workspace_root_path)?;
    let prefetched = prefetch_items(&items, true);

    Ok(EditorFilesWithContentResponse { items, prefetched })
}

/// Best-effort variant for read-only listers. Returns `None` if the
/// workspace directory has vanished (deleted externally, archived, etc.)
/// so callers surface an empty list instead of a red toast. Real errors
/// (permission denied, path outside allowed roots, malformed arg) still
/// propagate.
fn resolve_workspace_root_optional(workspace_root_path: &str) -> Result<Option<PathBuf>> {
    let workspace_root = resolve_allowed_path(Path::new(workspace_root_path), false)?;
    match fs::metadata(&workspace_root) {
        Ok(metadata) if metadata.is_dir() => Ok(Some(workspace_root)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!(
                path = %workspace_root.display(),
                "workspace root missing; returning empty file list",
            );
            Ok(None)
        }
        Err(error) => Err(error)
            .with_context(|| format!("Failed to stat workspace root {}", workspace_root.display())),
    }
}

fn build_list_items(
    workspace_root: &Path,
    discovered_files: Vec<PathBuf>,
) -> Vec<EditorFileListItem> {
    discovered_files
        .into_iter()
        .filter_map(|path| {
            let relative_path = path.strip_prefix(workspace_root).ok()?;
            Some(EditorFileListItem {
                path: relative_path.to_string_lossy().replace('\\', "/"),
                absolute_path: path.display().to_string(),
                name: path.file_name()?.to_string_lossy().to_string(),
                status: "M".to_string(),
                staged_insertions: 0,
                staged_deletions: 0,
                unstaged_insertions: 0,
                unstaged_deletions: 0,
                committed_insertions: 0,
                committed_deletions: 0,
                is_binary: false,
                staged_status: None,
                unstaged_status: None,
                committed_status: None,
            })
        })
        .collect()
}

fn prefetch_items(
    items: &[EditorFileListItem],
    include_deleted: bool,
) -> Vec<EditorFilePrefetchItem> {
    items
        .iter()
        .filter(|item| include_deleted || item.status != "D")
        .filter_map(|item| {
            let path = Path::new(&item.absolute_path);
            let metadata = fs::metadata(path).ok()?;
            if metadata.len() > MAX_PREFETCH_BYTES {
                return None;
            }
            let bytes = fs::read(path).ok()?;
            let content = String::from_utf8(bytes).ok()?;
            Some(EditorFilePrefetchItem {
                absolute_path: item.absolute_path.clone(),
                content,
            })
        })
        .collect()
}
