use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

use super::{
    support::allowed_workspace_roots,
    types::{EditorFileListItem, EditorFilePrefetchItem, EditorFilesWithContentResponse},
};
use crate::{
    bail_coded, db,
    error::{AnyhowCodedExt, ErrorCode},
    git_ops, workspace_state,
};

const MAX_PREFETCH_BYTES: u64 = 1_048_576;
/// Cap how big an untracked file we'll read just to count lines. Keeps the
/// inspector poll cheap when someone drops a multi-GB blob into the worktree.
const MAX_UNTRACKED_LINECOUNT_BYTES: u64 = 4 * 1_048_576;

#[derive(Default, Clone, Copy)]
struct AreaStats {
    insertions: u32,
    deletions: u32,
    is_binary: bool,
}

#[derive(Default, Clone, Copy)]
struct FileStats {
    committed: AreaStats,
    staged: AreaStats,
    unstaged: AreaStats,
}

impl FileStats {
    fn is_binary(&self) -> bool {
        self.committed.is_binary || self.staged.is_binary || self.unstaged.is_binary
    }
}

pub fn list_workspace_changes(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let workspace_root = Path::new(workspace_root_path);
    if !workspace_root.is_absolute() {
        bail!(
            "Workspace root must be an absolute path: {}",
            workspace_root.display()
        );
    }
    if !workspace_root.is_dir() {
        // Workspace dir vanished externally (deleted / archive cleanup /
        // repo moved). The inspector polls this on a fixed interval — if
        // we bailed, every tick would log an error. Return empty changes
        // silently; the selection layer is responsible for reconciling.
        tracing::warn!(
            path = %workspace_root.display(),
            "workspace root missing; returning empty change list",
        );
        return Ok(Vec::new());
    }

    let target_ref = resolve_target_ref(workspace_root)?;

    // Run all git commands in parallel — they're independent reads.
    //
    // Each area gets its own name-status + numstat. We deliberately do NOT
    // sum them: the inspector renders three groups (Staged / Changes /
    // Branch Changes) and each group must show line counts for its own
    // area. Summing would double-count any file touched in more than one
    // area.
    let (
        committed_output,
        unstaged_output,
        staged_output,
        untracked_output,
        committed_numstat,
        staged_numstat,
        unstaged_numstat,
    ) = std::thread::scope(|s| {
        let h_committed = s.spawn(|| {
            git_ops::run_git(
                ["diff", "--name-status", target_ref.as_str(), "HEAD"],
                Some(workspace_root),
            )
            .unwrap_or_default()
        });
        let h_unstaged = s.spawn(|| {
            git_ops::run_git(["diff", "--name-status"], Some(workspace_root)).unwrap_or_default()
        });
        let h_staged = s.spawn(|| {
            git_ops::run_git(["diff", "--name-status", "--cached"], Some(workspace_root))
                .unwrap_or_default()
        });
        let h_untracked = s.spawn(|| {
            git_ops::run_git(
                ["ls-files", "--others", "--exclude-standard"],
                Some(workspace_root),
            )
            .unwrap_or_default()
        });
        let tr = target_ref.as_str();
        let h_cn = s.spawn(move || {
            git_ops::run_git(["diff", "--numstat", tr, "HEAD"], Some(workspace_root))
                .unwrap_or_default()
        });
        let h_sn = s.spawn(|| {
            git_ops::run_git(["diff", "--numstat", "--cached"], Some(workspace_root))
                .unwrap_or_default()
        });
        let h_un = s.spawn(|| {
            git_ops::run_git(["diff", "--numstat"], Some(workspace_root)).unwrap_or_default()
        });
        (
            h_committed.join().unwrap_or_default(),
            h_unstaged.join().unwrap_or_default(),
            h_staged.join().unwrap_or_default(),
            h_untracked.join().unwrap_or_default(),
            h_cn.join().unwrap_or_default(),
            h_sn.join().unwrap_or_default(),
            h_un.join().unwrap_or_default(),
        )
    });

    let mut committed_map = BTreeMap::<String, String>::new();
    parse_name_status_into(&committed_output, &mut committed_map);

    let mut staged_map = BTreeMap::<String, String>::new();
    parse_name_status_into(&staged_output, &mut staged_map);

    let mut unstaged_map = BTreeMap::<String, String>::new();
    parse_name_status_into(&unstaged_output, &mut unstaged_map);

    for line in untracked_output.lines() {
        let path = line.trim();
        if !path.is_empty() {
            unstaged_map
                .entry(path.to_string())
                .or_insert_with(|| "A".to_string());
        }
    }

    let mut file_map = BTreeMap::<String, String>::new();
    for (path, status) in &committed_map {
        file_map.insert(path.clone(), status.clone());
    }
    for (path, status) in &staged_map {
        file_map.insert(path.clone(), status.clone());
    }
    for (path, status) in &unstaged_map {
        file_map.insert(path.clone(), status.clone());
    }

    let mut stats_map = BTreeMap::<String, FileStats>::new();
    parse_numstat_area(&committed_numstat, &mut stats_map, |fs: &mut FileStats| {
        &mut fs.committed
    });
    parse_numstat_area(&staged_numstat, &mut stats_map, |fs| &mut fs.staged);
    parse_numstat_area(&unstaged_numstat, &mut stats_map, |fs| &mut fs.unstaged);
    // Untracked files aren't in any diff — count their lines directly so
    // a brand-new file doesn't always show as +0/-0 in the Changes group.
    fill_untracked_unstaged(&untracked_output, workspace_root, &mut stats_map);

    let items = file_map
        .into_iter()
        .map(|(relative_path, status)| {
            let absolute = workspace_root.join(&relative_path);
            let name = Path::new(&relative_path)
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| relative_path.clone());
            let stats = stats_map.get(&relative_path).copied().unwrap_or_default();
            EditorFileListItem {
                path: relative_path.clone(),
                absolute_path: absolute.display().to_string(),
                name,
                status,
                staged_insertions: stats.staged.insertions,
                staged_deletions: stats.staged.deletions,
                unstaged_insertions: stats.unstaged.insertions,
                unstaged_deletions: stats.unstaged.deletions,
                committed_insertions: stats.committed.insertions,
                committed_deletions: stats.committed.deletions,
                is_binary: stats.is_binary(),
                staged_status: staged_map.get(&relative_path).cloned(),
                unstaged_status: unstaged_map.get(&relative_path).cloned(),
                committed_status: committed_map.get(&relative_path).cloned(),
            }
        })
        .collect();

    Ok(items)
}

pub fn list_workspace_changes_with_content(
    workspace_root_path: &str,
) -> Result<EditorFilesWithContentResponse> {
    let items = list_workspace_changes(workspace_root_path)?;
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

fn validate_workspace_relative_path(
    workspace_root_path: &str,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf)> {
    let workspace_root = PathBuf::from(workspace_root_path);
    if !workspace_root.is_absolute() {
        bail!(
            "Workspace root must be an absolute path: {}",
            workspace_root.display()
        );
    }
    // Directory vanished (archived, deleted externally, repo moved). Tag
    // the error so the frontend can offer "Permanently Delete" rather than
    // a generic red toast with no recovery action.
    if !workspace_root.is_dir() {
        bail_coded!(
            ErrorCode::WorkspaceBroken,
            "Workspace directory is missing: {}",
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
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("Relative path must not contain parent traversal: {relative_path}");
    }

    let canonical_root = workspace_root.canonicalize().map_err(|error| {
        // canonicalize only fails here if the directory was removed between
        // the is_dir() check above and now (TOCTOU). Same recovery action.
        anyhow::Error::new(error)
            .context(format!(
                "Failed to canonicalize workspace root: {}",
                workspace_root.display()
            ))
            .with_code(ErrorCode::WorkspaceBroken)
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

pub fn discard_workspace_file(workspace_root_path: &str, relative_path: &str) -> Result<()> {
    let (workspace_root, absolute) =
        validate_workspace_relative_path(workspace_root_path, relative_path)?;

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

pub fn stage_workspace_file(workspace_root_path: &str, relative_path: &str) -> Result<()> {
    let (workspace_root, _) = validate_workspace_relative_path(workspace_root_path, relative_path)?;

    git_ops::run_git(["add", "--", relative_path], Some(&workspace_root))
        .with_context(|| format!("Failed to stage {relative_path}"))?;

    Ok(())
}

pub fn unstage_workspace_file(workspace_root_path: &str, relative_path: &str) -> Result<()> {
    let (workspace_root, _) = validate_workspace_relative_path(workspace_root_path, relative_path)?;

    git_ops::run_git(
        ["restore", "--staged", "--", relative_path],
        Some(&workspace_root),
    )
    .with_context(|| format!("Failed to unstage {relative_path}"))?;

    Ok(())
}

pub(super) fn parse_workspace_path(workspace_root: &Path) -> Option<(&str, &str)> {
    let dir_name = workspace_root.file_name()?.to_str()?;
    let repo_name = workspace_root.parent()?.file_name()?.to_str()?;
    Some((repo_name, dir_name))
}

pub(super) fn query_workspace_target(
    conn: &Connection,
    repo_name: &str,
    dir_name: &str,
) -> Option<(String, String)> {
    let sql = format!(
        "SELECT r.remote, COALESCE(w.intended_target_branch, r.default_branch)
		 FROM workspaces w
		 JOIN repos r ON r.id = w.repository_id
		 WHERE r.name = ?1 AND w.directory_name = ?2 AND w.state {}",
        workspace_state::OPERATIONAL_FILTER,
    );
    let mut stmt = conn.prepare(&sql).ok()?;

    stmt.query_row(rusqlite::params![repo_name, dir_name], |row| {
        let remote: Option<String> = row.get(0)?;
        let target: Option<String> = row.get(1)?;
        Ok((remote, target))
    })
    .ok()
    .and_then(|(remote, target)| Some((remote.unwrap_or_else(|| "origin".into()), target?)))
}

fn lookup_workspace_target(workspace_root: &Path) -> Option<(String, String)> {
    let (repo_name, dir_name) = parse_workspace_path(workspace_root)?;
    let conn = db::read_conn().ok()?;
    query_workspace_target(&conn, repo_name, dir_name)
}

/// Resolve the target branch ref for diff comparison.
///
/// Returns the ref itself (not a merge-base) so `git diff <ref> HEAD`
/// compares the two branch tips directly. This means identical trees
/// produce zero diff, which is the correct behavior for "Branch Changes".
///
/// Uses a single `git for-each-ref` call to batch-check all candidates
/// instead of N sequential `rev-parse --verify` invocations.
pub(super) fn resolve_target_ref(workspace_root: &Path) -> Result<String> {
    let mut candidates = Vec::<String>::new();

    if let Some((remote, target)) = lookup_workspace_target(workspace_root) {
        candidates.push(format!("refs/remotes/{remote}/{target}"));
        candidates.push(format!("refs/heads/{target}"));
    }

    candidates.push("refs/remotes/origin/main".into());
    candidates.push("refs/remotes/origin/master".into());
    candidates.push("refs/heads/main".into());
    candidates.push("refs/heads/master".into());

    // Batch-check with a single git call.
    let mut args = vec![
        "for-each-ref".to_string(),
        "--format=%(refname)".to_string(),
    ];
    args.extend(candidates.iter().cloned());
    let existing_refs: std::collections::HashSet<String> =
        git_ops::run_git(args.iter().map(|s| s.as_str()), Some(workspace_root))
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();

    for branch in &candidates {
        if existing_refs.contains(branch) {
            return Ok(branch.clone());
        }
    }

    // No target branch found — fall back to the canonical SHA1 empty-tree
    // hash. This is a git constant (identical on every platform and every
    // git version) so we avoid spawning `hash-object -t tree /dev/null`,
    // which relied on `/dev/null` being mappable on Windows git-for-Windows.
    // Reference: https://git-scm.com/book/en/v2/Git-Internals-Git-Objects
    const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    // Silence unused-variable warning — workspace_root is no longer needed
    // here, but we keep the outer signature stable.
    let _ = workspace_root;
    Ok(EMPTY_TREE_SHA1.to_string())
}

fn parse_name_status_into(output: &str, map: &mut BTreeMap<String, String>) {
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let mut parts = line.splitn(2, '\t');
        let Some(raw_status) = parts.next() else {
            continue;
        };
        let Some(path) = parts.next() else {
            continue;
        };

        let status = match raw_status.chars().next() {
            Some('M') => "M",
            Some('A') => "A",
            Some('D') => "D",
            Some('R') => {
                if let Some(new_path) = path.split('\t').nth(1) {
                    map.insert(new_path.to_string(), "A".to_string());
                }
                if let Some(old_path) = path.split('\t').next() {
                    map.insert(old_path.to_string(), "D".to_string());
                }
                continue;
            }
            Some('C') => "A",
            Some('T') => "M",
            _ => "M",
        };

        map.insert(path.to_string(), status.to_string());
    }
}

/// Parse one `git diff --numstat` output and apply the per-file numbers to
/// the area selected by `pick`. Each numstat output covers exactly one area
/// (committed / staged / unstaged) so within a single call we overwrite —
/// there's no `+=` accumulation across areas.
fn parse_numstat_area<F>(output: &str, map: &mut BTreeMap<String, FileStats>, mut pick: F)
where
    F: FnMut(&mut FileStats) -> &mut AreaStats,
{
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

        // Binary files: numstat prints `-\t-\t<path>`. Track the binary flag
        // but leave line counts at zero — there's no meaningful line diff.
        let (ins, del, is_binary) = if ins_str == "-" && del_str == "-" {
            (0u32, 0u32, true)
        } else {
            let Ok(ins) = ins_str.parse::<u32>() else {
                continue;
            };
            let Ok(del) = del_str.parse::<u32>() else {
                continue;
            };
            (ins, del, false)
        };

        let resolved_path = if let Some(arrow_pos) = path.find(" => ") {
            if let Some(brace_start) = path[..arrow_pos].rfind('{') {
                let prefix = &path[..brace_start];
                let new_part = &path[arrow_pos + 4..];
                let suffix = new_part
                    .find('}')
                    .map_or("", |index| &new_part[index + 1..]);
                let new_name = new_part
                    .find('}')
                    .map_or(new_part, |index| &new_part[..index]);
                format!("{prefix}{new_name}{suffix}")
            } else {
                path[arrow_pos + 4..].to_string()
            }
        } else {
            path.to_string()
        };

        let area = pick(map.entry(resolved_path).or_default());
        // One numstat output = one area. Within an area, a path appears at
        // most once, so assignment is correct (and safer than `+=`).
        area.insertions = ins;
        area.deletions = del;
        if is_binary {
            area.is_binary = true;
        }
    }
}

/// Untracked files don't appear in any `git diff` output, so count their
/// lines from the file content directly. Capped to keep inspector polls
/// cheap. Counts are attributed to the unstaged area, which is where
/// untracked files surface in the UI.
fn fill_untracked_unstaged(
    untracked_output: &str,
    workspace_root: &Path,
    map: &mut BTreeMap<String, FileStats>,
) {
    for line in untracked_output.lines() {
        let path = line.trim();
        if path.is_empty() {
            continue;
        }
        let absolute = workspace_root.join(path);
        let Ok(metadata) = fs::metadata(&absolute) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }

        let entry = map.entry(path.to_string()).or_default();
        if metadata.len() > MAX_UNTRACKED_LINECOUNT_BYTES {
            // Don't slurp huge blobs just to count lines; just flag as
            // binary-ish and leave counts zero. The file still surfaces in
            // the UI via name-status / ls-files.
            entry.unstaged.is_binary = true;
            continue;
        }

        let Ok(bytes) = fs::read(&absolute) else {
            continue;
        };
        // Treat invalid-UTF-8 untracked files as binary — same display
        // behavior as git's binary numstat sentinel.
        let Ok(text) = std::str::from_utf8(&bytes) else {
            entry.unstaged.is_binary = true;
            continue;
        };
        if text.is_empty() {
            continue;
        }
        // git numstat for a brand-new file = `lines().count()`: counts the
        // last line even when the file doesn't end with a newline, and
        // treats `\r\n` as one line break. u32::try_from caps absurd line
        // counts; failure is harmless (count stays 0).
        let line_count = u32::try_from(text.lines().count()).unwrap_or(u32::MAX);
        entry.unstaged.insertions = line_count;
    }
}
