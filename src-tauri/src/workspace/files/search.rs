use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use super::types::{DirEntryKind, PathSearchHit};

pub const MAX_SEARCH_HITS: usize = 200;
const MAX_VISITED: usize = 50_000;

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

pub fn search_paths(workspace_root_path: &str, query: &str) -> Result<Vec<PathSearchHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let root = PathBuf::from(workspace_root_path);
    if !root.exists() || !root.is_dir() {
        return Err(anyhow!("workspace not found"));
    }
    let canonical_root = fs::canonicalize(&root).context("canonicalize root")?;
    let needle = trimmed.to_lowercase();

    let mut hits: Vec<(u8, PathSearchHit)> = Vec::new();
    let mut visited = 0usize;
    walk(
        &canonical_root,
        &canonical_root,
        &needle,
        &mut hits,
        &mut visited,
    )?;

    hits.sort_by_key(|b| std::cmp::Reverse(b.0));
    Ok(hits
        .into_iter()
        .take(MAX_SEARCH_HITS)
        .map(|(_, h)| h)
        .collect())
}

fn walk(
    root: &Path,
    dir: &Path,
    needle: &str,
    hits: &mut Vec<(u8, PathSearchHit)>,
    visited: &mut usize,
) -> Result<()> {
    if hits.len() >= MAX_SEARCH_HITS * 2 || *visited >= MAX_VISITED {
        return Ok(());
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    for entry_res in read {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        *visited += 1;
        if *visited >= MAX_VISITED {
            return Ok(());
        }
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env" {
            continue;
        }
        if SKIP_DIR_NAMES.contains(&name.as_str()) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let absolute = entry.path();
        let relative = absolute
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());

        let lname = name.to_lowercase();
        let lpath = relative.to_lowercase();
        let kind = if file_type.is_dir() {
            DirEntryKind::Directory
        } else {
            DirEntryKind::File
        };

        let rank = if lname == *needle {
            4
        } else if lname.starts_with(needle) {
            3
        } else if lname.contains(needle) {
            2
        } else if lpath.contains(needle) {
            1
        } else {
            0
        };
        if rank > 0 {
            hits.push((
                rank,
                PathSearchHit {
                    kind,
                    name: name.clone(),
                    path: relative.clone(),
                    absolute_path: absolute.to_string_lossy().to_string(),
                },
            ));
        }

        if file_type.is_dir() {
            walk(root, &absolute, needle, hits, visited)?;
            if hits.len() >= MAX_SEARCH_HITS * 2 || *visited >= MAX_VISITED {
                return Ok(());
            }
        }
    }
    Ok(())
}
