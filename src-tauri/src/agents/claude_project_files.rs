//! Helpers for Claude Code's per-cwd session storage layout.
//!
//! Claude Code persists each session as
//! `~/.claude/projects/<encoded-cwd>/<provider_session_id>.jsonl` plus an
//! optional sibling directory `<provider_session_id>/` that holds tool
//! results, subagent transcripts, etc. The encoded directory is derived
//! from the cwd, so any operation that changes a workspace's cwd
//! (Conductor import, local→worktree conversion, etc.) makes existing
//! sessions invisible to a `resume:` call until we copy the files into
//! the new project dir.

use std::path::{Path, PathBuf};

use crate::workspace::helpers as ws_helpers;

/// Encode a filesystem path into Claude Code's project directory name.
/// Claude uses `path.replace(/[\/.]/g, '-')`.
pub fn encode_project_dir(path: &Path) -> String {
    path.display().to_string().replace(['/', '.'], "-")
}

/// Resolve `~/.claude/projects` from `$HOME`. Returns `None` when HOME is
/// unset or the directory does not exist (fresh install — nothing to do).
fn claude_projects_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let root = home.join(".claude").join("projects");
    if root.is_dir() {
        Some(root)
    } else {
        None
    }
}

/// Copy the Claude session `.jsonl` (and matching `<id>/` subdirectory,
/// if present) for each provider session id from `old_cwd`'s project dir
/// into `new_cwd`'s project dir.
///
/// Best-effort: missing source files are skipped silently (Codex sessions,
/// fresh sessions with no first turn yet, sessions truncated by the user,
/// etc.). Per-file errors are logged and counted; this never returns an
/// error so callers can run it inline with their primary operation
/// without rollback.
///
/// Returns the number of session IDs whose `.jsonl` was successfully
/// copied (the sibling `<id>/` dir, if any, is copied opportunistically
/// and does not affect the returned count).
pub fn migrate_session_files(old_cwd: &Path, new_cwd: &Path, session_ids: &[String]) -> usize {
    let Some(projects_root) = claude_projects_root() else {
        return 0;
    };
    migrate_session_files_at(&projects_root, old_cwd, new_cwd, session_ids)
}

/// Same as [`migrate_session_files`] but takes the projects root
/// explicitly. Exists for unit testing without env mutation.
pub(crate) fn migrate_session_files_at(
    projects_root: &Path,
    old_cwd: &Path,
    new_cwd: &Path,
    session_ids: &[String],
) -> usize {
    if session_ids.is_empty() || old_cwd == new_cwd {
        return 0;
    }

    let src_dir = projects_root.join(encode_project_dir(old_cwd));
    let dst_dir = projects_root.join(encode_project_dir(new_cwd));

    if !src_dir.is_dir() {
        return 0;
    }

    let mut copied = 0usize;
    for sid in session_ids {
        let jsonl_name = format!("{sid}.jsonl");
        let src_jsonl = src_dir.join(&jsonl_name);
        if !src_jsonl.is_file() {
            continue;
        }

        // Lazy-create dst. If creation fails, give up — every subsequent
        // copy would fail too.
        if !dst_dir.exists() {
            if let Err(error) = std::fs::create_dir_all(&dst_dir) {
                tracing::error!(
                    dst = %dst_dir.display(),
                    error = %error,
                    "Failed to create Claude project dir for session migration",
                );
                return copied;
            }
        }

        let dst_jsonl = dst_dir.join(&jsonl_name);
        match std::fs::copy(&src_jsonl, &dst_jsonl) {
            Ok(_) => copied += 1,
            Err(error) => {
                tracing::error!(
                    src = %src_jsonl.display(),
                    dst = %dst_jsonl.display(),
                    error = %error,
                    "Failed to copy Claude session jsonl",
                );
                continue;
            }
        }

        // Sibling dir holds tool results / subagent transcripts. Optional.
        let src_subdir = src_dir.join(sid);
        if src_subdir.is_dir() {
            let dst_subdir = dst_dir.join(sid);
            if dst_subdir.exists() {
                let _ = std::fs::remove_dir_all(&dst_subdir);
            }
            if let Err(error) = ws_helpers::copy_dir_all(&src_subdir, &dst_subdir) {
                tracing::warn!(
                    src = %src_subdir.display(),
                    dst = %dst_subdir.display(),
                    error = %error,
                    "Failed to copy Claude session sidecar dir",
                );
            }
        }
    }

    if copied > 0 {
        tracing::info!(
            count = copied,
            src = %src_dir.display(),
            dst = %dst_dir.display(),
            "Migrated Claude session files",
        );
    }
    copied
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn encode_project_dir_replaces_slashes_and_dots() {
        let path = PathBuf::from("/Users/me/conductor/workspaces/repo/ws");
        assert_eq!(
            encode_project_dir(&path),
            "-Users-me-conductor-workspaces-repo-ws"
        );

        let path2 = PathBuf::from("/Users/me/helmor-dev/workspaces/repo/ws");
        assert_eq!(
            encode_project_dir(&path2),
            "-Users-me-helmor-dev-workspaces-repo-ws"
        );
    }

    #[test]
    fn migrate_session_files_copies_only_listed_ids() {
        let projects = TempDir::new().unwrap();
        let old_cwd = PathBuf::from("/tmp/fake/local-repo");
        let new_cwd = PathBuf::from("/tmp/fake/worktree");

        let src = projects.path().join(encode_project_dir(&old_cwd));
        fs::create_dir_all(&src).unwrap();

        // Two sessions we own, plus a third unrelated session in the
        // same project dir (e.g. user ran `claude` from the terminal).
        fs::write(src.join("aaa.jsonl"), b"session-a-content").unwrap();
        fs::write(src.join("bbb.jsonl"), b"session-b-content").unwrap();
        fs::write(src.join("unrelated.jsonl"), b"DO NOT COPY").unwrap();
        // Sidecar dir for aaa with one tool-result file.
        fs::create_dir_all(src.join("aaa").join("tool-results")).unwrap();
        fs::write(src.join("aaa/tool-results/r1.json"), b"{}").unwrap();

        let copied = migrate_session_files_at(
            projects.path(),
            &old_cwd,
            &new_cwd,
            &["aaa".to_string(), "bbb".to_string()],
        );
        assert_eq!(copied, 2);

        let dst = projects.path().join(encode_project_dir(&new_cwd));
        assert!(dst.join("aaa.jsonl").is_file());
        assert!(dst.join("bbb.jsonl").is_file());
        assert!(
            !dst.join("unrelated.jsonl").exists(),
            "must not leak unrelated session files",
        );
        assert!(
            dst.join("aaa/tool-results/r1.json").is_file(),
            "sidecar dir for the migrated session should be copied",
        );
    }

    #[test]
    fn migrate_session_files_skips_missing_source_jsonls() {
        let projects = TempDir::new().unwrap();
        let old_cwd = PathBuf::from("/tmp/fake/a");
        let new_cwd = PathBuf::from("/tmp/fake/b");

        let src = projects.path().join(encode_project_dir(&old_cwd));
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("present.jsonl"), b"ok").unwrap();

        // Asking to migrate one present + one absent id: only the
        // present one should land in dst, no error.
        let copied = migrate_session_files_at(
            projects.path(),
            &old_cwd,
            &new_cwd,
            &["present".to_string(), "absent".to_string()],
        );
        assert_eq!(copied, 1);

        let dst = projects.path().join(encode_project_dir(&new_cwd));
        assert!(dst.join("present.jsonl").is_file());
        assert!(!dst.join("absent.jsonl").exists());
    }

    #[test]
    fn migrate_session_files_is_noop_when_source_dir_missing() {
        let projects = TempDir::new().unwrap();
        let copied = migrate_session_files_at(
            projects.path(),
            &PathBuf::from("/tmp/fake/a"),
            &PathBuf::from("/tmp/fake/b"),
            &["xxx".to_string()],
        );
        assert_eq!(copied, 0);
    }

    #[test]
    fn migrate_session_files_is_noop_when_cwd_unchanged() {
        let projects = TempDir::new().unwrap();
        let same = PathBuf::from("/tmp/fake/repo");
        let dir = projects.path().join(encode_project_dir(&same));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("xxx.jsonl"), b"_").unwrap();

        assert_eq!(
            migrate_session_files_at(projects.path(), &same, &same, &["xxx".to_string()]),
            0
        );
    }
}
