use std::path::PathBuf;

use anyhow::{Context, Result};
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
    if let Some(path) = non_empty(provided) {
        let directory = PathBuf::from(path);
        // Provided path MUST exist — silently falling back to the helmor
        // process's cwd would spawn the agent CLI in `/` (or the app bundle)
        // and pollute session_messages with nonsense output. Tag the error
        // with `WorkspaceBroken` so the frontend can offer "Permanently
        // Delete" instead of a generic failure toast.
        if !directory.is_dir() {
            return Err(
                crate::error::coded(crate::error::ErrorCode::WorkspaceBroken).context(format!(
                    "Workspace directory is missing: {}",
                    directory.display()
                )),
            );
        }
        return Ok(directory);
    }

    std::env::current_dir().context("Failed to resolve working directory")
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
    fn resolve_working_directory_blank_string_falls_back_to_cwd() {
        let resolved = resolve_working_directory(Some("   ")).unwrap();
        // Blank counts as "no path provided" — must equal current cwd.
        assert_eq!(resolved, std::env::current_dir().unwrap());
    }

    #[test]
    fn resolve_working_directory_none_falls_back_to_cwd() {
        let resolved = resolve_working_directory(None).unwrap();
        assert_eq!(resolved, std::env::current_dir().unwrap());
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
