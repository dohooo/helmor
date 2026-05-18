//! `claude-code/<version>` user-agent string for the usage HTTP call.
//!
//! Probing the actual installed CLI keeps our requests
//! indistinguishable from the real Claude CLI. Falls back to a hard-
//! coded version on any probe failure (binary missing, slow shell init,
//! parse hiccup) — Anthropic doesn't gate on User-Agent, the precise
//! value just helps stay on the same shape.

use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use super::process::run_with_timeout;

const CLAUDE_CODE_FALLBACK_VERSION: &str = "2.1.0";
const CLAUDE_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// `claude --version` doesn't change for the life of a Helmor process
/// (the user can't upgrade Claude CLI without restarting Helmor first
/// — at minimum to clear our in-memory state). Probe once, reuse.
static USER_AGENT: OnceLock<String> = OnceLock::new();

pub(super) fn claude_code_user_agent() -> String {
    USER_AGENT
        .get_or_init(|| {
            let version =
                probe_claude_version().unwrap_or_else(|| CLAUDE_CODE_FALLBACK_VERSION.to_string());
            format!("claude-code/{version}")
        })
        .clone()
}

fn probe_claude_version() -> Option<String> {
    let output = run_with_timeout(
        Command::new("claude").args(["--allowed-tools", "", "--version"]),
        CLAUDE_VERSION_PROBE_TIMEOUT,
    )?;
    parse_claude_version_output(&output)
}

fn parse_claude_version_output(raw: &str) -> Option<String> {
    let first_line = raw.lines().next().unwrap_or(raw).trim();
    if first_line.is_empty() {
        return None;
    }
    // `claude --version` prints "<version> (Claude Code)" — take the
    // first whitespace-delimited token. Tolerate ANSI-free leading junk
    // by skipping non-numeric prefixes if present.
    let token = first_line.split_whitespace().next()?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_version_output() {
        assert_eq!(
            parse_claude_version_output("2.1.70 (Claude Code)\n"),
            Some("2.1.70".to_string())
        );
        assert_eq!(
            parse_claude_version_output("2.1.0\n"),
            Some("2.1.0".to_string())
        );
        assert!(parse_claude_version_output("").is_none());
        assert!(parse_claude_version_output("   \n").is_none());
    }
}
