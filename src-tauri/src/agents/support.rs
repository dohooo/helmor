use std::path::PathBuf;

use anyhow::Result;
#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
pub(super) fn parse_claude_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> crate::pipeline::types::ParsedAgentOutput {
    let mut accumulator =
        crate::pipeline::accumulator::StreamAccumulator::new("claude", fallback_model);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        accumulator.push_event(&value, line);
    }
    accumulator.flush_pending();
    accumulator.drain_output(fallback_session_id)
}

#[cfg(test)]
pub(super) fn parse_codex_output(
    stdout: &str,
    fallback_session_id: Option<&str>,
    fallback_model: &str,
) -> crate::pipeline::types::ParsedAgentOutput {
    let mut accumulator =
        crate::pipeline::accumulator::StreamAccumulator::new("codex", fallback_model);
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        accumulator.push_event(&value, line);
    }
    accumulator.flush_pending();
    accumulator.drain_output(fallback_session_id)
}

pub(super) fn resolve_working_directory(provided: Option<&str>) -> Result<PathBuf> {
    // No silent fallback to `std::env::current_dir()`. macOS GUI launches
    // start at `/`, and a missing cwd silently bound to `/` would write
    // the agent's transcript into the wrong project bucket — the next
    // resume can't find the conversation and returns empty (issue: first
    // turn writes to cwd=/, second turn fails with bad_resume_failure).
    // Every legitimate sender resolves cwd from the workspace; force
    // anything else to error so the bug shows up immediately.
    let Some(path) = non_empty(provided) else {
        return Err(
            crate::error::coded(crate::error::ErrorCode::WorkspaceBroken)
                .context("workingDirectory is required but was not provided"),
        );
    };
    let directory = PathBuf::from(path);
    if !directory.is_dir() {
        return Err(
            crate::error::coded(crate::error::ErrorCode::WorkspaceBroken).context(format!(
                "Workspace directory is missing: {}",
                directory.display()
            )),
        );
    }
    Ok(directory)
}

#[cfg(test)]
pub(super) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|inner| !inner.trim().is_empty())
}

#[cfg(not(test))]
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|inner| !inner.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_treats_blank_as_none() {
        assert_eq!(non_empty(None), None);
        assert_eq!(non_empty(Some("")), None);
        assert_eq!(non_empty(Some("   ")), None);
        assert_eq!(non_empty(Some("\t\n")), None);
    }

    #[test]
    fn non_empty_returns_value_unchanged_when_present() {
        // The caller does any further trimming itself — non_empty is just
        // a "blank guard," not a normaliser.
        assert_eq!(non_empty(Some("  hi  ")), Some("  hi  "));
        assert_eq!(non_empty(Some("/tmp/work")), Some("/tmp/work"));
    }

    #[test]
    fn resolve_working_directory_returns_existing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();
        let resolved = resolve_working_directory(Some(&path)).unwrap();
        assert_eq!(resolved, dir.path());
    }

    #[test]
    fn resolve_working_directory_blank_string_is_workspace_broken() {
        // Blank counts as "no path provided". The previous implementation
        // silently fell back to `std::env::current_dir()` (== `/` for a
        // packaged macOS GUI launch), which made the agent CLI write its
        // transcript into the wrong project bucket. Now it errors loudly
        // so the bug surfaces on the first send instead of poisoning
        // resume on the second.
        let err = resolve_working_directory(Some("   ")).unwrap_err();
        let code = crate::error::extract_code(&err);
        assert_eq!(code, crate::error::ErrorCode::WorkspaceBroken);
        assert!(format!("{err:#}").contains("workingDirectory is required"));
    }

    #[test]
    fn resolve_working_directory_none_is_workspace_broken() {
        let err = resolve_working_directory(None).unwrap_err();
        let code = crate::error::extract_code(&err);
        assert_eq!(code, crate::error::ErrorCode::WorkspaceBroken);
        assert!(format!("{err:#}").contains("workingDirectory is required"));
    }

    #[test]
    fn resolve_working_directory_missing_path_is_workspace_broken() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("ghost");
        let err = resolve_working_directory(Some(missing.to_str().unwrap())).unwrap_err();
        let code = crate::error::extract_code(&err);
        assert_eq!(code, crate::error::ErrorCode::WorkspaceBroken);
        let msg = format!("{err:#}");
        assert!(
            msg.contains("missing"),
            "error message should mention missing dir: {msg}"
        );
    }

    #[test]
    fn resolve_working_directory_rejects_files_as_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir.txt");
        std::fs::write(&file_path, b"hi").unwrap();
        let err = resolve_working_directory(Some(file_path.to_str().unwrap())).unwrap_err();
        let code = crate::error::extract_code(&err);
        assert_eq!(code, crate::error::ErrorCode::WorkspaceBroken);
    }
}
