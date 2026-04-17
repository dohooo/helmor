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
use crate::{db, git_ops};

const MAX_PREFETCH_BYTES: u64 = 1_048_576;

pub fn list_workspace_changes(workspace_root_path: &str) -> Result<Vec<EditorFileListItem>> {
    let workspace_root = Path::new(workspace_root_path);
    if !workspace_root.is_absolute() || !workspace_root.is_dir() {
        bail!(
            "Workspace root is not a valid directory: {}",
            workspace_root.display()
        );
    }

    let target_ref = resolve_target_ref(workspace_root)?;

    // Run all git commands in parallel — they're independent reads.
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

    let mut stats_map = BTreeMap::<String, (u32, u32)>::new();
    parse_numstat_into(&committed_numstat, &mut stats_map);
    parse_numstat_into(&staged_numstat, &mut stats_map);
    parse_numstat_into(&unstaged_numstat, &mut stats_map);

    let items = file_map
        .into_iter()
        .map(|(relative_path, status)| {
            let absolute = workspace_root.join(&relative_path);
            let name = Path::new(&relative_path)
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
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
        .any(|component| matches!(component, std::path::Component::ParentDir))
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

fn lookup_workspace_target(workspace_root: &Path) -> Option<(String, String)> {
    let (repo_name, dir_name) = parse_workspace_path(workspace_root)?;
    let conn = db::open_connection(false).ok()?;
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

fn parse_numstat_into(output: &str, map: &mut BTreeMap<String, (u32, u32)>) {
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

        let Ok(ins) = ins_str.parse::<u32>() else {
            continue;
        };
        let Ok(del) = del_str.parse::<u32>() else {
            continue;
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

        let entry = map.entry(resolved_path).or_insert((0, 0));
        entry.0 += ins;
        entry.1 += del;
    }
}
