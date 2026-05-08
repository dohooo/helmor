use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use super::types::{DirEntry, DirEntryKind};

const SKIP_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    ".turbo",
    ".cache",
    ".vercel",
    ".parcel-cache",
    "__pycache__",
    ".pytest_cache",
    ".venv",
    "venv",
];

pub fn list_directory(workspace_root_path: &str, relative_path: &str) -> Result<Vec<DirEntry>> {
    let root = PathBuf::from(workspace_root_path);
    if !root.exists() {
        return Err(anyhow!("workspace not found: {workspace_root_path}"));
    }
    if !root.is_dir() {
        return Err(anyhow!("workspace path is not a directory"));
    }

    let normalized = normalize_relative(relative_path)?;
    let target = root.join(&normalized);
    let canonical_root = fs::canonicalize(&root).context("canonicalize workspace root")?;
    let canonical_target = fs::canonicalize(&target).context("canonicalize target")?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(anyhow!("path traversal rejected"));
    }

    let metadata = fs::symlink_metadata(&canonical_target).context("read metadata")?;
    if metadata.file_type().is_symlink() {
        return Err(anyhow!("symlinked directories are not followed"));
    }

    let read = fs::read_dir(&canonical_target).context("read_dir")?;

    let mut dirs: Vec<DirEntry> = Vec::new();
    let mut files: Vec<DirEntry> = Vec::new();

    for entry_res in read {
        let entry = entry_res.context("dir entry")?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env" {
            continue;
        }
        if SKIP_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }
        let file_type = entry.file_type().context("file_type")?;
        if file_type.is_symlink() {
            continue;
        }
        let absolute_path = entry.path();
        let relative_inside = canonical_target.join(&name);
        let relative_str = relative_inside
            .strip_prefix(&canonical_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        let kind = if file_type.is_dir() {
            DirEntryKind::Directory
        } else {
            DirEntryKind::File
        };
        let dir_entry = DirEntry {
            kind,
            name: name.clone(),
            path: relative_str,
            absolute_path: absolute_path.to_string_lossy().to_string(),
        };
        match kind {
            DirEntryKind::Directory => dirs.push(dir_entry),
            DirEntryKind::File => files.push(dir_entry),
        }
    }

    dirs.sort_by_key(|a| a.name.to_lowercase());
    files.sort_by_key(|a| a.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

fn normalize_relative(relative: &str) -> Result<PathBuf> {
    if relative.is_empty() {
        return Ok(PathBuf::new());
    }
    let raw = Path::new(relative);
    if raw.is_absolute() {
        return Err(anyhow!("absolute relative path rejected"));
    }
    let mut out = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => continue,
            Component::ParentDir => return Err(anyhow!("path traversal rejected")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(anyhow!("absolute relative path rejected"))
            }
        }
    }
    Ok(out)
}
