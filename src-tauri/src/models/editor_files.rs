use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use uuid::Uuid;

use super::{db, git_ops, workspaces};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileReadResponse {
    pub path: String,
    pub content: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileWriteResponse {
    pub path: String,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileStatResponse {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub mtime_ms: Option<i64>,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileListItem {
    pub path: String,
    pub absolute_path: String,
    pub name: String,
    pub status: String,
    pub insertions: u32,
    pub deletions: u32,
    /// HEAD-vs-index status for this file (`Some` when the file has staged
    /// changes, `None` otherwise). The Git inspector groups files into
    /// "Staged Changes" based on this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_status: Option<String>,
    /// Index-vs-working-tree status for this file (`Some` when the file has
    /// unstaged modifications or is untracked, `None` otherwise). The Git
    /// inspector groups files into "Changes" based on this field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unstaged_status: Option<String>,
    /// Merge-base-vs-HEAD status for this file (`Some` when the file has
    /// committed changes on the current branch relative to the target
    /// branch, `None` otherwise). The Git inspector shows these in the
    /// "Branch Changes" section — the persistent view of "what does this
    /// PR / branch contain".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub committed_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilePrefetchItem {
    pub absolute_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFilesWithContentResponse {
    pub items: Vec<EditorFileListItem>,
    pub prefetched: Vec<EditorFilePrefetchItem>,
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
    let workspace_root = resolve_allowed_path(Path::new(workspace_root_path), true)?;
    let metadata = fs::metadata(&workspace_root)
        .with_context(|| format!("Failed to stat workspace root {}", workspace_root.display()))?;

    if !metadata.is_dir() {
        bail!(
            "Workspace root is not a directory: {}",
            workspace_root.display()
        );
    }

    let mut discovered_files = Vec::<PathBuf>::new();
    collect_editor_files(&workspace_root, &workspace_root, &mut discovered_files)?;
    discovered_files.sort_by(|left, right| {
        editor_file_sort_key(&workspace_root, left)
            .cmp(&editor_file_sort_key(&workspace_root, right))
    });
    discovered_files.truncate(24);

    Ok(discovered_files
        .into_iter()
        .filter_map(|path| {
            let relative_path = path.strip_prefix(&workspace_root).ok()?;
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
        .collect())
}

/// List ALL workspace files (no 24-cap), filtered by the same skip/include
/// rules as `list_editor_files`. Used by the @-mention picker in the composer:
/// the frontend caches the result and does fuzzy filtering as the user types.
///
/// The walk is bounded by `MAX_WORKSPACE_FILES_FOR_MENTION` so a runaway
/// monorepo can't blow out memory or stall the IPC thread; sane projects fit
/// well under that ceiling once node_modules/dist/etc. are excluded.
pub fn list_workspace_files(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let workspace_root = resolve_allowed_path(Path::new(workspace_root_path), true)?;
    let metadata = fs::metadata(&workspace_root)
        .with_context(|| format!("Failed to stat workspace root {}", workspace_root.display()))?;

    if !metadata.is_dir() {
        bail!(
            "Workspace root is not a directory: {}",
            workspace_root.display()
        );
    }

    let mut discovered_files = Vec::<PathBuf>::new();
    collect_workspace_files_for_mention(&workspace_root, &mut discovered_files)?;
    discovered_files.sort_by(|left, right| {
        editor_file_sort_key(&workspace_root, left)
            .cmp(&editor_file_sort_key(&workspace_root, right))
    });

    Ok(discovered_files
        .into_iter()
        .filter_map(|path| {
            let relative_path = path.strip_prefix(&workspace_root).ok()?;
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
        .collect())
}

/// List workspace files and eagerly read their contents in a single IPC call.
/// Files larger than 1 MB or non-UTF-8 files are skipped in the prefetch list.
pub fn list_editor_files_with_content(
    workspace_root_path: &str,
) -> Result<EditorFilesWithContentResponse> {
    let items = list_editor_files(workspace_root_path)?;

    const MAX_PREFETCH_BYTES: u64 = 1_048_576; // 1 MB

    let prefetched = items
        .iter()
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
        .collect();

    Ok(EditorFilesWithContentResponse { items, prefetched })
}

/// List files changed on the current branch relative to the default branch (main/master),
/// including both committed and uncommitted changes.
pub fn list_workspace_changes(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let workspace_root = Path::new(workspace_root_path);
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        bail!(
            "Workspace root is not a valid directory: {}",
            workspace_root.display()
        );
    }

    let merge_base = find_merge_base(workspace_root)?;

    // Committed changes: merge-base..HEAD
    let committed_output = git_ops::run_git(
        ["diff", "--name-status", merge_base.as_str(), "HEAD"],
        Some(workspace_root),
    )
    .unwrap_or_default();

    // Unstaged changes
    let unstaged_output =
        git_ops::run_git(["diff", "--name-status"], Some(workspace_root)).unwrap_or_default();

    // Staged changes
    let staged_output =
        git_ops::run_git(["diff", "--name-status", "--cached"], Some(workspace_root))
            .unwrap_or_default();

    // Untracked files
    let untracked_output = git_ops::run_git(
        ["ls-files", "--others", "--exclude-standard"],
        Some(workspace_root),
    )
    .unwrap_or_default();

    // Track each diff source separately so the inspector can split files into
    // Staged Changes (HEAD vs index), Changes (index vs working tree), and
    // Branch Changes (merge-base vs HEAD — the committed PR diff).
    let mut committed_map = std::collections::BTreeMap::<String, String>::new();
    parse_name_status_into(&committed_output, &mut committed_map);

    let mut staged_map = std::collections::BTreeMap::<String, String>::new();
    parse_name_status_into(&staged_output, &mut staged_map);

    let mut unstaged_map = std::collections::BTreeMap::<String, String>::new();
    parse_name_status_into(&unstaged_output, &mut unstaged_map);

    // Untracked files surface as unstaged "A" — they aren't in the index yet.
    for line in untracked_output.lines() {
        let path = line.trim();
        if !path.is_empty() {
            unstaged_map
                .entry(path.to_string())
                .or_insert_with(|| "A".to_string());
        }
    }

    let mut file_map = std::collections::BTreeMap::<String, String>::new();

    // Layer in order: committed first, then staged, then unstaged (latest wins)
    for (path, status) in &committed_map {
        file_map.insert(path.clone(), status.clone());
    }
    for (path, status) in &staged_map {
        file_map.insert(path.clone(), status.clone());
    }
    for (path, status) in &unstaged_map {
        file_map.insert(path.clone(), status.clone());
    }

    // Collect line-level stats via --numstat (insertions/deletions per file).
    // We accumulate across committed + staged + unstaged so the totals reflect
    // the full diff from merge-base to the working tree.
    let mut stats_map = std::collections::BTreeMap::<String, (u32, u32)>::new();
    let committed_numstat = git_ops::run_git(
        ["diff", "--numstat", merge_base.as_str(), "HEAD"],
        Some(workspace_root),
    )
    .unwrap_or_default();
    let staged_numstat = git_ops::run_git(["diff", "--numstat", "--cached"], Some(workspace_root))
        .unwrap_or_default();
    let unstaged_numstat =
        git_ops::run_git(["diff", "--numstat"], Some(workspace_root)).unwrap_or_default();
    parse_numstat_into(&committed_numstat, &mut stats_map);
    parse_numstat_into(&staged_numstat, &mut stats_map);
    parse_numstat_into(&unstaged_numstat, &mut stats_map);

    let items: Vec<EditorFileListItem> = file_map
        .into_iter()
        .map(|(relative_path, status)| {
            let absolute = workspace_root.join(&relative_path);
            let name = Path::new(&relative_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| relative_path.clone());
            let (insertions, deletions) = stats_map.get(&relative_path).copied().unwrap_or((0, 0));
            EditorFileListItem {
                path: relative_path.clone(),
                absolute_path: absolute.display().to_string(),
                name,
                status,
                insertions,
                deletions,
                staged_status: staged_map.get(&relative_path).cloned(),
                unstaged_status: unstaged_map.get(&relative_path).cloned(),
                committed_status: committed_map.get(&relative_path).cloned(),
            }
        })
        .collect();

    Ok(items)
}

/// List workspace changes and eagerly read their contents in a single IPC call.
pub fn list_workspace_changes_with_content(
    workspace_root_path: &str,
) -> Result<EditorFilesWithContentResponse> {
    let items = list_workspace_changes(workspace_root_path)?;

    const MAX_PREFETCH_BYTES: u64 = 1_048_576; // 1 MB

    let prefetched = items
        .iter()
        .filter(|item| item.status != "D")
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
        .collect();

    Ok(EditorFilesWithContentResponse { items, prefetched })
}

/// Validate that the workspace root + relative path target a real, registered
/// helmor workspace and that the relative path can't escape it.
fn validate_workspace_relative_path(
    workspace_root_path: &str,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf)> {
    let workspace_root = PathBuf::from(workspace_root_path);
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        bail!(
            "Workspace root is not a valid directory: {}",
            workspace_root.display()
        );
    }

    if relative_path.is_empty() {
        bail!("Relative path must not be empty");
    }
    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        bail!("Relative path must not be absolute: {relative_path}");
    }
    if rel
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("Relative path must not contain parent traversal: {relative_path}");
    }

    let canonical_root = workspace_root.canonicalize().with_context(|| {
        format!(
            "Failed to canonicalize workspace root: {}",
            workspace_root.display()
        )
    })?;
    let workspace_roots = allowed_workspace_roots()?;
    if !workspace_roots
        .iter()
        .any(|root| canonical_root.starts_with(root))
    {
        bail!(
            "Workspace root is not registered as an editable location: {}",
            workspace_root.display()
        );
    }

    let absolute = workspace_root.join(rel);
    Ok((workspace_root, absolute))
}

/// Discard uncommitted changes for a single file in a workspace.
///
/// - For tracked files, runs `git checkout HEAD -- <path>`, which restores the
///   file from HEAD and throws away both staged and unstaged modifications.
/// - For untracked files, removes the file from disk.
///
/// The path is guarded against traversal and against targeting workspaces
/// outside the registered set.
pub fn discard_workspace_file(workspace_root_path: &str, relative_path: &str) -> Result<()> {
    let (workspace_root, absolute) =
        validate_workspace_relative_path(workspace_root_path, relative_path)?;

    // `git ls-files --error-unmatch` exits non-zero if the path isn't tracked
    // (including untracked or nested-in-ignored cases).
    let is_tracked = git_ops::run_git(
        ["ls-files", "--error-unmatch", "--", relative_path],
        Some(&workspace_root),
    )
    .is_ok();

    if is_tracked {
        git_ops::run_git(
            ["checkout", "HEAD", "--", relative_path],
            Some(&workspace_root),
        )
        .with_context(|| format!("Failed to discard changes for {relative_path}"))?;
    } else if absolute.exists() {
        fs::remove_file(&absolute)
            .with_context(|| format!("Failed to remove untracked file: {}", absolute.display()))?;
    }

    Ok(())
}

/// Stage a single file in a workspace via `git add -- <path>`. Works for
/// tracked, untracked, and deleted files alike.
pub fn stage_workspace_file(workspace_root_path: &str, relative_path: &str) -> Result<()> {
    let (workspace_root, _) = validate_workspace_relative_path(workspace_root_path, relative_path)?;

    git_ops::run_git(["add", "--", relative_path], Some(&workspace_root))
        .with_context(|| format!("Failed to stage {relative_path}"))?;

    Ok(())
}

/// Unstage a single file in a workspace, returning its index entry to its
/// HEAD state. Uses `git reset HEAD -- <path>` for portability across git
/// versions (works even when HEAD has no commits via the empty-tree fallback).
pub fn unstage_workspace_file(workspace_root_path: &str, relative_path: &str) -> Result<()> {
    let (workspace_root, _) = validate_workspace_relative_path(workspace_root_path, relative_path)?;

    // `git reset HEAD -- <path>` returns a non-zero exit code when there are
    // index changes (which is the normal case here), but the operation still
    // succeeds. Use `git restore --staged` instead, which is the modern
    // equivalent and exits 0 on success.
    git_ops::run_git(
        ["restore", "--staged", "--", relative_path],
        Some(&workspace_root),
    )
    .with_context(|| format!("Failed to unstage {relative_path}"))?;

    Ok(())
}

/// Find the merge-base commit between HEAD and the default branch.
/// Extract `(repo_name, directory_name)` from a workspace root path.
/// The path format is `{data_dir}/workspaces/{repo_name}/{directory_name}`.
fn parse_workspace_path(workspace_root: &Path) -> Option<(&str, &str)> {
    let dir_name = workspace_root.file_name()?.to_str()?;
    let repo_name = workspace_root.parent()?.file_name()?.to_str()?;
    Some((repo_name, dir_name))
}

/// Query the DB for a workspace's configured remote + target branch.
fn query_workspace_target(
    conn: &rusqlite::Connection,
    repo_name: &str,
    dir_name: &str,
) -> Option<(String, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT r.remote, COALESCE(w.intended_target_branch, r.default_branch)
             FROM workspaces w
             JOIN repos r ON r.id = w.repository_id
             WHERE r.name = ?1 AND w.directory_name = ?2 AND w.state = 'ready'",
        )
        .ok()?;

    stmt.query_row(rusqlite::params![repo_name, dir_name], |row| {
        let remote: Option<String> = row.get(0)?;
        let target: Option<String> = row.get(1)?;
        Ok((remote, target))
    })
    .ok()
    .and_then(|(remote, target)| Some((remote.unwrap_or_else(|| "origin".into()), target?)))
}

/// Look up the workspace's configured remote + intended target branch from the
/// DB so the merge-base is computed against the right ref instead of
/// hard-coded `origin/main`.
fn lookup_workspace_target(workspace_root: &Path) -> Option<(String, String)> {
    let (repo_name, dir_name) = parse_workspace_path(workspace_root)?;
    let conn = db::open_connection(false).ok()?;
    query_workspace_target(&conn, repo_name, dir_name)
}

fn find_merge_base(workspace_root: &Path) -> Result<String> {
    // Build the candidate ref list from the workspace's actual configuration.
    let mut candidates: Vec<String> = Vec::new();

    if let Some((remote, target)) = lookup_workspace_target(workspace_root) {
        // Preferred: remote-tracking ref for the intended target branch
        candidates.push(format!("refs/remotes/{remote}/{target}"));
        // Local fallback for the same branch
        candidates.push(format!("refs/heads/{target}"));
    }

    // Generic fallbacks (covers workspaces without a configured target)
    candidates.push("refs/remotes/origin/main".into());
    candidates.push("refs/remotes/origin/master".into());
    candidates.push("refs/heads/main".into());
    candidates.push("refs/heads/master".into());

    for branch in &candidates {
        if let Ok(base) = git_ops::run_git(["merge-base", "HEAD", branch], Some(workspace_root)) {
            if !base.trim().is_empty() {
                return Ok(base.trim().to_string());
            }
        }
    }

    // Fallback: empty tree object (treats all files as added)
    let empty_tree = git_ops::run_git(
        ["hash-object", "-t", "tree", "/dev/null"],
        Some(workspace_root),
    )
    .context("Failed to generate empty tree hash")?;
    Ok(empty_tree.trim().to_string())
}

/// Parse `git diff --name-status` output into a path→status map.
fn parse_name_status_into(output: &str, map: &mut std::collections::BTreeMap<String, String>) {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Format: "M\tpath" or "R100\told\tnew" (rename)
        let mut parts = line.splitn(2, '\t');
        let Some(raw_status) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };

        // Normalize status: R(ename) → A for the new path, C(opy) → A
        let status = match raw_status.chars().next() {
            Some('M') => "M",
            Some('A') => "A",
            Some('D') => "D",
            Some('R') => {
                // Rename: "R100\told\tnew" — treat new path as Added
                if let Some(new_path) = path.split('\t').nth(1) {
                    map.insert(new_path.to_string(), "A".to_string());
                }
                // Mark old path as deleted
                if let Some(old_path) = path.split('\t').next() {
                    map.insert(old_path.to_string(), "D".to_string());
                }
                continue;
            }
            Some('C') => "A",
            Some('T') => "M", // Type change
            _ => "M",         // Unknown → treat as modified
        };

        map.insert(path.to_string(), status.to_string());
    }
}

/// Parse `git diff --numstat` output and accumulate insertions/deletions per path.
/// Format: "123\t456\tpath" — binary files show "-\t-\tpath".
fn parse_numstat_into(output: &str, map: &mut std::collections::BTreeMap<String, (u32, u32)>) {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let Some(ins_str) = parts.next() else {
            continue;
        };
        let Some(del_str) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };
        // Binary files report "-" — skip them
        let Ok(ins) = ins_str.parse::<u32>() else {
            continue;
        };
        let Ok(del) = del_str.parse::<u32>() else {
            continue;
        };
        // For renames "old => new", use the new path
        let resolved_path = if let Some(arrow_pos) = path.find(" => ") {
            // Could be "dir/{old => new}/file" or "old => new"
            if let Some(brace_start) = path[..arrow_pos].rfind('{') {
                let prefix = &path[..brace_start];
                let new_part = &path[arrow_pos + 4..];
                let suffix = new_part.find('}').map_or("", |i| &new_part[i + 1..]);
                let new_name = new_part.find('}').map_or(new_part, |i| &new_part[..i]);
                format!("{prefix}{new_name}{suffix}")
            } else {
                path[arrow_pos + 4..].to_string()
            }
        } else {
            path.to_string()
        };
        let entry = map.entry(resolved_path).or_insert((0, 0));
        entry.0 += ins;
        entry.1 += del;
    }
}

fn resolve_allowed_path(path: &Path, require_existing: bool) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("Editor file paths must be absolute: {}", path.display());
    }

    let normalized_path = if require_existing || path.exists() {
        path.canonicalize()
            .with_context(|| format!("Failed to resolve editor file {}", path.display()))?
    } else {
        canonicalize_missing_path(path)?
    };

    let workspace_roots = allowed_workspace_roots()?;

    if workspace_roots.is_empty() {
        bail!("No workspace roots are available for in-app editing");
    }

    if workspace_roots
        .iter()
        .any(|workspace_root| normalized_path.starts_with(workspace_root))
    {
        return Ok(normalized_path);
    }

    bail!(
        "Editor file must live inside a workspace root: {}",
        path.display()
    )
}

fn allowed_workspace_roots() -> Result<Vec<PathBuf>> {
    let mut workspace_roots = Vec::new();

    for record in workspaces::load_workspace_records()? {
        let workspace_dir =
            crate::data_dir::workspace_dir(&record.repo_name, &record.directory_name)
                .with_context(|| {
                    format!(
                        "Failed to resolve workspace directory for {}/{}",
                        record.repo_name, record.directory_name
                    )
                })?;

        if !workspace_dir.is_dir() {
            continue;
        }

        workspace_roots.push(workspace_dir.canonicalize().with_context(|| {
            format!(
                "Failed to resolve workspace root {}",
                workspace_dir.display()
            )
        })?);
    }

    workspace_roots.sort();
    workspace_roots.dedup();

    Ok(workspace_roots)
}

/// Upper bound for the @-mention file list. The composer caches and
/// fuzzy-filters this in the frontend, so we want it big enough that real
/// projects (a few thousand source files) come back complete, but small
/// enough that a freak monorepo doesn't OOM the IPC thread.
const MAX_WORKSPACE_FILES_FOR_MENTION: usize = 5000;

fn collect_workspace_files_for_mention(
    current_dir: &Path,
    discovered_files: &mut Vec<PathBuf>,
) -> Result<()> {
    if discovered_files.len() >= MAX_WORKSPACE_FILES_FOR_MENTION {
        return Ok(());
    }

    let mut entries = fs::read_dir(current_dir)
        .with_context(|| {
            format!(
                "Failed to read workspace directory {}",
                current_dir.display()
            )
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| {
            format!(
                "Failed to iterate workspace directory {}",
                current_dir.display()
            )
        })?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if discovered_files.len() >= MAX_WORKSPACE_FILES_FOR_MENTION {
            break;
        }

        let entry_path = entry.path();
        let file_type = entry.file_type().with_context(|| {
            format!("Failed to inspect workspace entry {}", entry_path.display())
        })?;

        if file_type.is_dir() {
            if should_skip_workspace_dir_for_mention(&entry_path) {
                continue;
            }

            collect_workspace_files_for_mention(&entry_path, discovered_files)?;
            continue;
        }

        if file_type.is_file() && should_include_workspace_file_for_mention(&entry_path) {
            discovered_files.push(entry_path);
        }
    }

    Ok(())
}

/// Directory skip list for the @-mention picker.
///
/// Unlike `should_skip_editor_dir` (the inspector view), this does NOT skip
/// every dot-directory by default — `.github`, `.vscode`, `.husky` etc. are
/// often the targets of legitimate mentions ("review @.github/workflows/ci.yml").
/// Only the explicit set of build/cache/dependency dirs is excluded.
fn should_skip_workspace_dir_for_mention(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };

    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "build"
            | "coverage"
            | "target"
            | ".next"
            | ".turbo"
            | ".cache"
            | ".venv"
            | "__pycache__"
    )
}

/// File inclusion rule for the @-mention picker.
///
/// Uses a binary-extension **blacklist** rather than the inspector's text/code
/// extension whitelist. The mention picker should surface anything an agent
/// could plausibly read as text — Shell scripts, SQL, Protobuf, Dockerfile,
/// LICENSE, dotfiles like `.gitignore`, etc. — and only filter out obviously
/// binary blobs (images, audio, video, archives, executables, fonts, office
/// docs, databases, disk images).
///
/// PDFs and SVGs are intentionally allowed: PDFs are common mention targets
/// (specs, RFCs) and the agent can extract text; SVGs are XML and editable.
///
/// Files without an extension (Makefile, Dockerfile, LICENSE, Procfile, ...)
/// are allowed — they're almost always text in a code workspace.
fn should_include_workspace_file_for_mention(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    // OS metadata files we never want in the picker, regardless of extension.
    if matches!(file_name, ".DS_Store" | "Thumbs.db" | "desktop.ini") {
        return false;
    }

    // No extension → almost always a text/config file in a code workspace.
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return true;
    };

    let lower = extension.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        // Raster images (SVG is XML — allowed)
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "tif"
            | "avif" | "heic" | "heif"
        // Audio
        | "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "wma" | "opus"
        // Video
        | "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" | "wmv" | "flv"
        // Archives
        | "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" | "rar" | "tgz" | "tbz2" | "zst" | "lz" | "lzma"
        // Compiled binaries / object files
        | "exe" | "dll" | "so" | "dylib" | "o" | "a" | "class" | "jar" | "war" | "ear" | "pyc" | "pyo" | "wasm" | "node"
        // Fonts
        | "ttf" | "otf" | "woff" | "woff2" | "eot"
        // Office docs (PDF intentionally allowed above)
        | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
        // Databases
        | "db" | "sqlite" | "sqlite3" | "mdb"
        // Disk images / installer packages
        | "iso" | "dmg" | "pkg" | "deb" | "rpm" | "msi" | "apk" | "ipa"
        // Misc binary blobs
        | "bin" | "dat"
    )
}

fn collect_editor_files(
    workspace_root: &Path,
    current_dir: &Path,
    discovered_files: &mut Vec<PathBuf>,
) -> Result<()> {
    if discovered_files.len() >= 48 {
        return Ok(());
    }

    let mut entries = fs::read_dir(current_dir)
        .with_context(|| {
            format!(
                "Failed to read workspace directory {}",
                current_dir.display()
            )
        })?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| {
            format!(
                "Failed to iterate workspace directory {}",
                current_dir.display()
            )
        })?;

    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        if discovered_files.len() >= 48 {
            break;
        }

        let entry_path = entry.path();
        let file_type = entry.file_type().with_context(|| {
            format!("Failed to inspect workspace entry {}", entry_path.display())
        })?;

        if file_type.is_dir() {
            if should_skip_editor_dir(workspace_root, &entry_path) {
                continue;
            }

            collect_editor_files(workspace_root, &entry_path, discovered_files)?;
            continue;
        }

        if file_type.is_file() && should_include_editor_file(&entry_path) {
            discovered_files.push(entry_path);
        }
    }

    Ok(())
}

fn should_skip_editor_dir(workspace_root: &Path, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };

    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "build"
            | "coverage"
            | "target"
            | ".next"
            | ".turbo"
            | ".cache"
            | ".venv"
            | "__pycache__"
    ) || (name.starts_with('.') && path != workspace_root)
}

fn should_include_editor_file(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    if matches!(
        file_name,
        "package.json"
            | "pnpm-lock.yaml"
            | "bun.lock"
            | "Cargo.toml"
            | "Cargo.lock"
            | "tsconfig.json"
            | "vite.config.ts"
            | "README.md"
            | "AGENTS.md"
    ) {
        return true;
    }

    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some(
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "rs"
                | "json"
                | "toml"
                | "md"
                | "css"
                | "html"
                | "yml"
                | "yaml"
                | "py"
                | "go"
                | "java"
                | "swift"
                | "kt"
        )
    )
}

fn editor_file_sort_key(workspace_root: &Path, path: &Path) -> (usize, usize, String) {
    let relative = path
        .strip_prefix(workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let depth = relative.matches('/').count();
    let priority = if relative.starts_with("src/") {
        0
    } else if relative.starts_with("app/")
        || relative.starts_with("lib/")
        || relative.starts_with("components/")
    {
        1
    } else if depth == 0 {
        2
    } else {
        3
    };

    (priority, depth, relative)
}

fn atomic_write_file(path: &Path, content: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("Editor file has no parent directory: {}", path.display()))?;
    let file_name = path
        .file_name()
        .with_context(|| format!("Editor file has no file name: {}", path.display()))?
        .to_string_lossy();
    let temp_path = parent.join(format!(".{file_name}.helmor-{}", Uuid::new_v4()));

    let write_result = (|| -> Result<()> {
        let mut temp_file = fs::OpenOptions::new()
            .create_new(true)
            .truncate(true)
            .write(true)
            .open(&temp_path)
            .with_context(|| {
                format!("Failed to create temp editor file {}", temp_path.display())
            })?;

        temp_file
            .write_all(content)
            .with_context(|| format!("Failed to write temp editor file {}", temp_path.display()))?;
        temp_file
            .sync_all()
            .with_context(|| format!("Failed to flush temp editor file {}", temp_path.display()))?;

        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temp_path, metadata.permissions()).with_context(|| {
                format!(
                    "Failed to copy permissions onto temp editor file {}",
                    temp_path.display()
                )
            })?;
        }

        fs::rename(&temp_path, path).with_context(|| {
            format!(
                "Failed to replace editor file {} with {}",
                path.display(),
                temp_path.display()
            )
        })?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

fn canonicalize_missing_path(path: &Path) -> Result<PathBuf> {
    let mut missing_segments = Vec::<OsString>::new();
    let mut current = path;

    while !current.exists() {
        let segment = current
            .file_name()
            .with_context(|| format!("Editor path has no file name: {}", path.display()))?;
        missing_segments.push(segment.to_os_string());
        current = current
            .parent()
            .with_context(|| format!("Editor path has no parent: {}", path.display()))?;
    }

    let mut resolved = current
        .canonicalize()
        .with_context(|| format!("Failed to resolve editor parent {}", current.display()))?;

    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }

    Ok(resolved)
}

fn metadata_mtime_ms(metadata: &fs::Metadata) -> Result<i64> {
    let duration = metadata
        .modified()
        .context("Failed to read file modification time")?
        .duration_since(UNIX_EPOCH)
        .context("File modification time predates the Unix epoch")?;

    i64::try_from(duration.as_millis()).context("File modification time exceeds i64 range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data_dir::TEST_ENV_LOCK as TEST_LOCK;
    use rusqlite::Connection;

    struct TestDataDir {
        root: PathBuf,
    }

    impl TestDataDir {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("helmor-test-{name}-{}", Uuid::new_v4()));
            std::env::set_var("HELMOR_DATA_DIR", root.display().to_string());
            crate::data_dir::ensure_directory_structure().unwrap();

            let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
            crate::schema::ensure_schema(&connection).unwrap();

            Self { root }
        }
    }

    impl Drop for TestDataDir {
        fn drop(&mut self) {
            std::env::remove_var("HELMOR_DATA_DIR");
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct EditorFilesHarness {
        _test_dir: TestDataDir,
        workspace_dir: PathBuf,
        outside_dir: PathBuf,
    }

    impl EditorFilesHarness {
        fn new() -> Self {
            let test_dir = TestDataDir::new("editor-files");
            let source_repo_root = test_dir.root.join("source-repo");
            fs::create_dir_all(&source_repo_root).unwrap();

            let connection = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
            connection
                .execute(
                    "INSERT INTO repos (id, name, root_path) VALUES ('repo-1', 'helmor', ?1)",
                    [source_repo_root.display().to_string()],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status) VALUES ('workspace-1', 'repo-1', 'editor-mode', 'ready', 'in-progress')",
                    [],
                )
                .unwrap();

            let workspace_dir = crate::data_dir::workspace_dir("helmor", "editor-mode").unwrap();
            fs::create_dir_all(&workspace_dir).unwrap();

            let outside_dir = test_dir.root.join("outside");
            fs::create_dir_all(&outside_dir).unwrap();

            Self {
                _test_dir: test_dir,
                workspace_dir,
                outside_dir,
            }
        }
    }

    #[test]
    fn read_editor_file_rejects_paths_outside_workspace_roots() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let outside_file = harness.outside_dir.join("not-allowed.ts");
        fs::write(&outside_file, "console.log('x')\n").unwrap();

        let error = read_editor_file(outside_file.to_str().unwrap()).unwrap_err();

        assert!(
            format!("{error:#}").contains("inside a workspace root"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn write_editor_file_replaces_existing_file_contents() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let allowed_file = harness.workspace_dir.join("src").join("App.tsx");
        fs::create_dir_all(allowed_file.parent().unwrap()).unwrap();
        fs::write(&allowed_file, "const before = true;\n").unwrap();

        let response =
            write_editor_file(allowed_file.to_str().unwrap(), "const after = true;\n").unwrap();

        assert_eq!(
            fs::read_to_string(&allowed_file).unwrap(),
            "const after = true;\n"
        );
        assert!(response.mtime_ms > 0);
    }

    #[test]
    fn stat_editor_file_reports_missing_files_inside_workspace_roots() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let missing_file = harness.workspace_dir.join("src").join("missing.ts");

        let response = stat_editor_file(missing_file.to_str().unwrap()).unwrap();

        assert_eq!(
            PathBuf::from(&response.path),
            canonicalize_missing_path(&missing_file).unwrap()
        );
        assert!(!response.exists);
        assert!(!response.is_file);
        assert_eq!(response.mtime_ms, None);
        assert_eq!(response.size, None);
    }

    #[test]
    fn list_editor_files_returns_existing_workspace_files() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();
        let src_dir = harness.workspace_dir.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        let app_file = src_dir.join("App.tsx");
        fs::write(&app_file, "export const app = true;\n").unwrap();
        fs::write(harness.workspace_dir.join("README.md"), "# Demo\n").unwrap();

        let files = list_editor_files(harness.workspace_dir.to_str().unwrap()).unwrap();

        assert!(!files.is_empty());
        let expected_app_file = app_file.canonicalize().unwrap();
        assert!(files
            .iter()
            .any(|file| Path::new(&file.absolute_path) == expected_app_file.as_path()));
        assert!(files
            .iter()
            .all(|file| Path::new(&file.absolute_path).is_file()));
    }

    #[test]
    fn list_workspace_files_uses_blacklist_filter_for_mention_picker() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();

        // Allowed by the blacklist but EXCLUDED by the inspector's whitelist —
        // this is the whole point of switching to a blacklist.
        let allowed_extras = [
            "deploy.sh",
            "schema.sql",
            "api.proto",
            "service.graphql",
            "main.cpp",
            "header.h",
            "app.lua",
            "site.scss",
            "Dockerfile", // no extension
            "Makefile",   // no extension
            "LICENSE",    // no extension
            ".gitignore", // dotfile
            ".editorconfig",
            "diagram.svg", // SVG is XML, allowed
            "spec.pdf",    // PDFs are valid mention targets
        ];
        for name in allowed_extras {
            fs::write(harness.workspace_dir.join(name), b"contents\n").unwrap();
        }

        // Hidden config DIRECTORIES the mention picker should walk into
        // (unlike the inspector's stricter rule, which skips all dot-dirs).
        let github_workflows = harness.workspace_dir.join(".github").join("workflows");
        fs::create_dir_all(&github_workflows).unwrap();
        fs::write(github_workflows.join("ci.yml"), b"name: ci\n").unwrap();
        let vscode_dir = harness.workspace_dir.join(".vscode");
        fs::create_dir_all(&vscode_dir).unwrap();
        fs::write(vscode_dir.join("settings.json"), b"{}\n").unwrap();

        // Blacklisted binaries — must NOT appear in the result.
        let blacklisted_binaries = [
            "logo.png",
            "song.mp3",
            "clip.mp4",
            "bundle.zip",
            "tool.exe",
            "lib.so",
            "font.woff2",
            "report.docx",
            "data.sqlite3",
            "image.dmg",
        ];
        for name in blacklisted_binaries {
            fs::write(harness.workspace_dir.join(name), b"\x00\x01\x02").unwrap();
        }

        // OS metadata noise — never surfaced even though it has no extension.
        fs::write(harness.workspace_dir.join(".DS_Store"), b"meta").unwrap();

        // Excluded directories — still skipped.
        let node_modules = harness.workspace_dir.join("node_modules").join("react");
        fs::create_dir_all(&node_modules).unwrap();
        fs::write(node_modules.join("index.js"), b"vendor\n").unwrap();
        let git_dir = harness.workspace_dir.join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), b"ref: refs/heads/main\n").unwrap();

        let files = list_workspace_files(harness.workspace_dir.to_str().unwrap()).unwrap();
        let result_paths: std::collections::HashSet<String> =
            files.iter().map(|f| f.path.clone()).collect();

        // Every blacklist-allowed file should be present.
        for name in allowed_extras {
            assert!(
                result_paths.contains(name),
                "expected blacklist-allowed file {name} to appear, got {result_paths:?}",
            );
        }
        assert!(
            result_paths.contains(".github/workflows/ci.yml"),
            "expected .github/workflows/ci.yml in result, got {result_paths:?}",
        );
        assert!(
            result_paths.contains(".vscode/settings.json"),
            "expected .vscode/settings.json in result, got {result_paths:?}",
        );

        // No blacklisted binary should leak through.
        for name in blacklisted_binaries {
            assert!(
                !result_paths.contains(name),
                "binary {name} should be excluded by the blacklist",
            );
        }
        assert!(
            !result_paths.contains(".DS_Store"),
            "OS metadata .DS_Store should be excluded",
        );

        // Excluded directories must not leak.
        for path in &result_paths {
            assert!(
                !path.contains("node_modules"),
                "node_modules leaked: {path}",
            );
            assert!(!path.starts_with(".git/"), "git dir leaked: {path}");
        }
    }

    #[test]
    fn list_workspace_files_returns_all_files_without_24_cap_and_skips_excluded_dirs() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let harness = EditorFilesHarness::new();

        // Create 30 source files across nested directories — well past the
        // 24-file truncation `list_editor_files` enforces. The mention picker
        // must see all of them so the user can search the full workspace.
        let src_dir = harness.workspace_dir.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        for index in 0..15 {
            fs::write(
                src_dir.join(format!("file_{index:02}.ts")),
                "export const x = true;\n",
            )
            .unwrap();
        }
        let nested_dir = src_dir.join("components").join("widgets");
        fs::create_dir_all(&nested_dir).unwrap();
        for index in 0..15 {
            fs::write(
                nested_dir.join(format!("widget_{index:02}.tsx")),
                "export const w = true;\n",
            )
            .unwrap();
        }

        // Drop a file inside each excluded directory; none should appear.
        let node_modules = harness.workspace_dir.join("node_modules").join("react");
        fs::create_dir_all(&node_modules).unwrap();
        fs::write(node_modules.join("index.js"), "/* vendor */\n").unwrap();
        let git_dir = harness.workspace_dir.join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        let dist_dir = harness.workspace_dir.join("dist");
        fs::create_dir_all(&dist_dir).unwrap();
        fs::write(dist_dir.join("bundle.js"), "/* built */\n").unwrap();

        // Also drop a binary-ish file with an unsupported extension — it
        // should be filtered out by `should_include_editor_file`.
        fs::write(harness.workspace_dir.join("logo.png"), b"\x89PNG").unwrap();

        let files = list_workspace_files(harness.workspace_dir.to_str().unwrap()).unwrap();

        // 30 source files, no truncation.
        assert_eq!(
            files.len(),
            30,
            "expected all 30 source files, got {} (paths: {:?})",
            files.len(),
            files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );

        // Excluded directories must not leak into the result.
        for file in &files {
            assert!(
                !file.path.contains("node_modules"),
                "node_modules leaked: {}",
                file.path
            );
            assert!(
                !file.path.starts_with(".git"),
                "git dir leaked: {}",
                file.path
            );
            assert!(
                !file.path.starts_with("dist/"),
                "dist leaked: {}",
                file.path
            );
            assert!(!file.path.ends_with(".png"), "binary leaked: {}", file.path);
        }

        // Sanity: nested files are reported with forward-slash relative paths
        // and the corresponding absolute path resolves to a real file.
        let nested_match = files
            .iter()
            .find(|f| f.path == "src/components/widgets/widget_00.tsx")
            .expect("expected nested widget in result");
        assert!(Path::new(&nested_match.absolute_path).is_file());
        assert_eq!(nested_match.name, "widget_00.tsx");
    }

    // ── Git file classification tests ──────────────────────────────────

    /// Creates a real git repo with a `main` branch and an initial commit,
    /// then creates a feature branch and switches to it. Returns the repo
    /// root path as a `PathBuf` that can be passed to `list_workspace_changes`.
    struct GitRepoHarness {
        root: PathBuf,
        _temp: tempfile::TempDir,
    }

    impl GitRepoHarness {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().to_path_buf();

            // Init repo + initial commit on main
            git_ops::run_git(["init", "-b", "main"], Some(&root)).unwrap();
            git_ops::run_git(["config", "user.email", "test@helmor.test"], Some(&root)).unwrap();
            git_ops::run_git(["config", "user.name", "Test"], Some(&root)).unwrap();

            fs::write(root.join("README.md"), "# Test\n").unwrap();
            git_ops::run_git(["add", "."], Some(&root)).unwrap();
            git_ops::run_git(["commit", "-m", "init"], Some(&root)).unwrap();

            // Create and switch to feature branch
            git_ops::run_git(["checkout", "-b", "feature/test"], Some(&root)).unwrap();

            Self { root, _temp: temp }
        }

        fn path_str(&self) -> &str {
            self.root.to_str().unwrap()
        }

        fn write_file(&self, relative: &str, content: &str) {
            let abs = self.root.join(relative);
            if let Some(parent) = abs.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(abs, content).unwrap();
        }

        fn git(&self, args: &[&str]) -> String {
            git_ops::run_git(args.iter().copied(), Some(&self.root)).unwrap_or_default()
        }

        fn changes(&self) -> Vec<EditorFileListItem> {
            list_workspace_changes(self.path_str()).unwrap()
        }

        fn find(&self, path: &str) -> Option<EditorFileListItem> {
            self.changes().into_iter().find(|item| item.path == path)
        }
    }

    #[test]
    fn classification_unstaged_modification() {
        let repo = GitRepoHarness::new();

        // Commit a file on the feature branch, then modify it without staging
        repo.write_file("src/app.ts", "const v1 = true;\n");
        repo.git(&["add", "src/app.ts"]);
        repo.git(&["commit", "-m", "add app"]);
        repo.write_file("src/app.ts", "const v2 = true;\n");

        let item = repo.find("src/app.ts").expect("file should appear");
        assert!(
            item.unstaged_status.is_some(),
            "should have unstaged_status: {item:?}"
        );
        assert_eq!(item.unstaged_status.as_deref(), Some("M"));
        // File is committed on branch (vs main) AND has working tree changes
        assert!(item.committed_status.is_some());
    }

    #[test]
    fn classification_staged_modification() {
        let repo = GitRepoHarness::new();

        // Commit a file, then modify and stage it
        repo.write_file("src/app.ts", "const v1 = true;\n");
        repo.git(&["add", "src/app.ts"]);
        repo.git(&["commit", "-m", "add app"]);
        repo.write_file("src/app.ts", "const v2 = true;\n");
        repo.git(&["add", "src/app.ts"]);

        let item = repo.find("src/app.ts").expect("file should appear");
        assert_eq!(
            item.staged_status.as_deref(),
            Some("M"),
            "should have staged M: {item:?}"
        );
        // No unstaged changes (everything is staged)
        assert!(
            item.unstaged_status.is_none(),
            "should NOT have unstaged_status: {item:?}"
        );
    }

    #[test]
    fn classification_untracked_file() {
        let repo = GitRepoHarness::new();

        // Create a new file without staging
        repo.write_file("new-file.txt", "hello\n");

        let item = repo.find("new-file.txt").expect("file should appear");
        assert_eq!(
            item.unstaged_status.as_deref(),
            Some("A"),
            "untracked file should have unstaged A: {item:?}"
        );
        assert!(
            item.staged_status.is_none(),
            "untracked should NOT have staged_status: {item:?}"
        );
        assert!(
            item.committed_status.is_none(),
            "untracked should NOT have committed_status: {item:?}"
        );
    }

    #[test]
    fn classification_staged_new_file() {
        let repo = GitRepoHarness::new();

        // Create and stage a new file
        repo.write_file("new-file.txt", "hello\n");
        repo.git(&["add", "new-file.txt"]);

        let item = repo.find("new-file.txt").expect("file should appear");
        assert_eq!(
            item.staged_status.as_deref(),
            Some("A"),
            "staged new file should have staged A: {item:?}"
        );
        assert!(
            item.unstaged_status.is_none(),
            "fully staged should NOT have unstaged_status: {item:?}"
        );
    }

    #[test]
    fn classification_committed_on_branch() {
        let repo = GitRepoHarness::new();

        // Commit a file on the feature branch
        repo.write_file("feature.ts", "export const feature = true;\n");
        repo.git(&["add", "feature.ts"]);
        repo.git(&["commit", "-m", "add feature"]);

        let item = repo.find("feature.ts").expect("file should appear");
        assert_eq!(
            item.committed_status.as_deref(),
            Some("A"),
            "committed file should have committed A: {item:?}"
        );
        // No staged or unstaged changes (committed and clean)
        assert!(
            item.staged_status.is_none(),
            "clean committed should NOT have staged_status: {item:?}"
        );
        assert!(
            item.unstaged_status.is_none(),
            "clean committed should NOT have unstaged_status: {item:?}"
        );
    }

    #[test]
    fn classification_both_staged_and_unstaged() {
        let repo = GitRepoHarness::new();

        // Commit a file, then stage a change, then modify again
        repo.write_file("mixed.ts", "v1\n");
        repo.git(&["add", "mixed.ts"]);
        repo.git(&["commit", "-m", "add mixed"]);
        repo.write_file("mixed.ts", "v2\n");
        repo.git(&["add", "mixed.ts"]);
        repo.write_file("mixed.ts", "v3\n");

        let item = repo.find("mixed.ts").expect("file should appear");
        assert_eq!(
            item.staged_status.as_deref(),
            Some("M"),
            "should have staged M: {item:?}"
        );
        assert_eq!(
            item.unstaged_status.as_deref(),
            Some("M"),
            "should have unstaged M: {item:?}"
        );
    }

    #[test]
    fn classification_after_commit_changes_clear() {
        let repo = GitRepoHarness::new();

        // Create, stage, commit — should only show in committed section
        repo.write_file("done.ts", "done\n");
        repo.git(&["add", "done.ts"]);
        repo.git(&["commit", "-m", "add done"]);

        let item = repo.find("done.ts").expect("file should appear");
        assert!(
            item.committed_status.is_some(),
            "should have committed_status: {item:?}"
        );
        assert!(
            item.staged_status.is_none(),
            "committed file should NOT have staged: {item:?}"
        );
        assert!(
            item.unstaged_status.is_none(),
            "committed file should NOT have unstaged: {item:?}"
        );
    }

    #[test]
    fn classification_no_changes_empty_result() {
        let repo = GitRepoHarness::new();

        // No changes at all — only README.md exists but it's on main too
        let items = repo.changes();
        assert!(
            items.is_empty(),
            "clean branch should have no changes: {items:?}"
        );
    }

    #[test]
    fn classification_discard_removes_from_changes() {
        let repo = GitRepoHarness::new();

        // Modify, then discard
        repo.write_file("README.md", "modified\n");
        assert!(
            repo.find("README.md").is_some(),
            "modified file should show"
        );

        repo.git(&["checkout", "--", "README.md"]);
        assert!(
            repo.find("README.md").is_none(),
            "discarded file should NOT show"
        );
    }

    // ── parse_workspace_path tests ────────────────────────────────────

    #[test]
    fn parse_workspace_path_normal() {
        let path = Path::new("/Users/x/helmor-dev/workspaces/my-repo/feature-branch");
        let (repo, dir) = parse_workspace_path(path).unwrap();
        assert_eq!(repo, "my-repo");
        assert_eq!(dir, "feature-branch");
    }

    #[test]
    fn parse_workspace_path_root_returns_none() {
        assert!(parse_workspace_path(Path::new("/")).is_none());
    }

    #[test]
    fn parse_workspace_path_single_component_returns_none() {
        assert!(parse_workspace_path(Path::new("/tmp")).is_none());
    }

    // ── query_workspace_target tests ──────────────────────────────────

    fn test_db_with_workspace(
        remote: Option<&str>,
        target: Option<&str>,
        default_branch: &str,
    ) -> rusqlite::Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, default_branch, remote) VALUES ('r1', 'test-repo', ?1, ?2)",
            rusqlite::params![default_branch, remote],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, intended_target_branch)
             VALUES ('w1', 'r1', 'ws-dir', 'ready', 'in-progress', ?1)",
            rusqlite::params![target],
        )
        .unwrap();
        conn
    }

    #[test]
    fn query_target_returns_intended_target_branch() {
        let conn = test_db_with_workspace(Some("origin"), Some("develop"), "main");
        let result = query_workspace_target(&conn, "test-repo", "ws-dir");
        assert_eq!(result, Some(("origin".into(), "develop".into())));
    }

    #[test]
    fn query_target_falls_back_to_default_branch() {
        let conn = test_db_with_workspace(Some("origin"), None, "main");
        let result = query_workspace_target(&conn, "test-repo", "ws-dir");
        assert_eq!(result, Some(("origin".into(), "main".into())));
    }

    #[test]
    fn query_target_defaults_remote_to_origin() {
        let conn = test_db_with_workspace(None, Some("develop"), "main");
        let result = query_workspace_target(&conn, "test-repo", "ws-dir");
        assert_eq!(result, Some(("origin".into(), "develop".into())));
    }

    #[test]
    fn query_target_custom_remote() {
        let conn = test_db_with_workspace(Some("upstream"), Some("release"), "main");
        let result = query_workspace_target(&conn, "test-repo", "ws-dir");
        assert_eq!(result, Some(("upstream".into(), "release".into())));
    }

    #[test]
    fn query_target_returns_none_for_unknown_workspace() {
        let conn = test_db_with_workspace(Some("origin"), Some("develop"), "main");
        let result = query_workspace_target(&conn, "test-repo", "nonexistent");
        assert!(result.is_none());
    }

    #[test]
    fn query_target_returns_none_for_archived_workspace() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, default_branch) VALUES ('r1', 'test-repo', 'main')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, intended_target_branch)
             VALUES ('w1', 'r1', 'ws-dir', 'archived', 'done', 'develop')",
            rusqlite::params![],
        )
        .unwrap();
        let result = query_workspace_target(&conn, "test-repo", "ws-dir");
        assert!(result.is_none(), "archived workspaces should not match");
    }

    // ── find_merge_base with configured target ────────────────────────

    #[test]
    fn find_merge_base_uses_configured_target_branch() {
        let _lock = TEST_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let test_dir = TestDataDir::new("merge-base-target");

        // Set up a git repo with main + a target branch
        let repo_root = test_dir.root.join("source-repo");
        fs::create_dir_all(&repo_root).unwrap();
        git_ops::run_git(["init", "-b", "main"], Some(&repo_root)).unwrap();
        git_ops::run_git(
            ["config", "user.email", "test@helmor.test"],
            Some(&repo_root),
        )
        .unwrap();
        git_ops::run_git(["config", "user.name", "Test"], Some(&repo_root)).unwrap();
        fs::write(repo_root.join("f.txt"), "base\n").unwrap();
        git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
        git_ops::run_git(["commit", "-m", "init"], Some(&repo_root)).unwrap();

        // Create a target branch and diverge
        git_ops::run_git(["checkout", "-b", "custom/target"], Some(&repo_root)).unwrap();
        fs::write(repo_root.join("target.txt"), "target\n").unwrap();
        git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
        git_ops::run_git(["commit", "-m", "target commit"], Some(&repo_root)).unwrap();
        let target_sha = git_ops::run_git(["rev-parse", "HEAD"], Some(&repo_root))
            .unwrap()
            .trim()
            .to_string();

        // Create a workspace branch from target
        git_ops::run_git(["checkout", "-b", "workspace/dev"], Some(&repo_root)).unwrap();
        fs::write(repo_root.join("work.txt"), "work\n").unwrap();
        git_ops::run_git(["add", "."], Some(&repo_root)).unwrap();
        git_ops::run_git(["commit", "-m", "workspace commit"], Some(&repo_root)).unwrap();

        // Switch main repo away from workspace/dev so the worktree can use it
        git_ops::run_git(["checkout", "main"], Some(&repo_root)).unwrap();

        let workspace_dir =
            crate::data_dir::workspace_dir("merge-base-repo", "merge-base-ws").unwrap();
        git_ops::run_git(
            [
                "worktree",
                "add",
                workspace_dir.to_str().unwrap(),
                "workspace/dev",
            ],
            Some(&repo_root),
        )
        .unwrap();

        // Seed DB with matching workspace
        let conn = Connection::open(crate::data_dir::db_path().unwrap()).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, root_path, default_branch, remote) VALUES ('r1', 'merge-base-repo', ?1, 'main', 'origin')",
            [repo_root.display().to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, derived_status, intended_target_branch)
             VALUES ('w1', 'r1', 'merge-base-ws', 'ready', 'in-progress', 'custom/target')",
            [],
        )
        .unwrap();
        drop(conn);

        // Now: find_merge_base should compare against custom/target, not main.
        // The merge-base of workspace/dev and custom/target is target_sha.
        let base = find_merge_base(&workspace_dir).unwrap();
        assert_eq!(
            base, target_sha,
            "merge-base should be the target branch tip, not main"
        );
    }
}
