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
        if directory.is_dir() {
            return Ok(directory);
        }
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
