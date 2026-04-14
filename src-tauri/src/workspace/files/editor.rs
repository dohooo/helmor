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

const MAX_EDITOR_FILE_ITEMS: usize = 24;
const MAX_PREFETCH_BYTES: u64 = 1_048_576;

/// Read a file at a given git ref. Returns `None` when the path doesn't exist in that ref.
pub fn read_file_at_ref(
    workspace_root_path: &str,
    file_path: &str,
    git_ref: &str,
) -> Result<Option<String>> {
    let workspace_root = Path::new(workspace_root_path);
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        bail!(
            "Workspace root is not a valid directory: {}",
            workspace_root.display()
        );
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
    let resolved_path = resolve_allowed_path(Path::new(path), true)?;
    let metadata = fs::metadata(&resolved_path)
        .with_context(|| format!("Failed to stat editor file {}", resolved_path.display()))?;

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
    let resolved_path = resolve_allowed_path(Path::new(path), true)?;
    let metadata = fs::metadata(&resolved_path)
        .with_context(|| format!("Failed to stat editor file {}", resolved_path.display()))?;

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
    let workspace_root = resolve_workspace_root(workspace_root_path)?;
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
    let workspace_root = resolve_workspace_root(workspace_root_path)?;
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

fn resolve_workspace_root(workspace_root_path: &str) -> Result<PathBuf> {
    let workspace_root = resolve_allowed_path(Path::new(workspace_root_path), true)?;
    let metadata = fs::metadata(&workspace_root)
        .with_context(|| format!("Failed to stat workspace root {}", workspace_root.display()))?;

    if !metadata.is_dir() {
        bail!(
            "Workspace root is not a directory: {}",
            workspace_root.display()
        );
    }

    Ok(workspace_root)
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
                insertions: 0,
                deletions: 0,
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
