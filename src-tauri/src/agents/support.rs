use std::path::PathBuf;

use anyhow::{Context, Result};
use rusqlite::OptionalExtension;
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
        if directory.is_dir() {
            return Ok(directory);
        }
    }

    std::env::current_dir().context("Failed to resolve working directory")
}

pub(super) fn resolve_resume_working_directory(session_id: &str) -> Result<Option<PathBuf>> {
    let connection = crate::models::db::open_connection(false)
        .context("Failed to open DB while resolving resume workspace")?;
    let workspace_info: Option<(String, String)> = connection
        .query_row(
            r#"SELECT r.name, w.directory_name
               FROM sessions s
               JOIN workspaces w ON w.id = s.workspace_id
               JOIN repos r ON r.id = w.repository_id
               WHERE s.id = ?1"#,
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .context("Failed to load resume workspace info")?;

    workspace_info
        .map(|(repo_name, directory_name)| {
            crate::data_dir::workspace_dir(&repo_name, &directory_name)
        })
        .transpose()
}

#[cfg(test)]
pub(super) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|inner| !inner.trim().is_empty())
}

#[cfg(not(test))]
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|inner| !inner.trim().is_empty())
}
