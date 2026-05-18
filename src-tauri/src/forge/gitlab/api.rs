//! Thin wrapper around `glab api …` plus the URL-encoding helpers every
//! endpoint call needs. Higher-level modules (`merge_request`, `pipeline`,
//! `review`) call [`glab_api`] with ready-to-go argv and get the raw
//! process output back.

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::{
    error::{AnyhowCodedExt, ErrorCode},
    forge::command::{run_command, run_command_with_env, CommandOutput},
};

/// Run `glab api --hostname <host> …args`, capturing stdout/stderr.
pub(super) fn glab_api<'a>(
    host: &str,
    args: impl IntoIterator<Item = &'a str>,
) -> anyhow::Result<CommandOutput> {
    let mut full_args = vec![
        "api".to_string(),
        "--hostname".to_string(),
        host.to_string(),
    ];
    full_args.extend(args.into_iter().map(str::to_string));
    tracing::debug!(host, args = ?full_args, "Running glab api");
    let output = match resolved_glab_config_dir() {
        Some(dir) => {
            run_command_with_env("glab", full_args, &[("GLAB_CONFIG_DIR", dir.as_os_str())])
        }
        None => run_command("glab", full_args),
    };
    match &output {
        Ok(output) if output.success => {
            tracing::debug!(host, status = ?output.status, "glab api completed");
        }
        Ok(output) => {
            tracing::warn!(
                host,
                status = ?output.status,
                detail = %command_detail(output),
                "glab api failed"
            );
        }
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                tracing::warn!(host, error = %error, "GitLab CLI is missing");
                return Err(
                    anyhow::anyhow!(error.to_string()).with_code(ErrorCode::ForgeOnboarding)
                );
            } else {
                tracing::error!(host, error = %error, "Failed to run glab api");
            }
        }
    }
    output.map_err(anyhow::Error::new)
}

/// Render a command's combined output as a single user-facing detail
/// string. Prefers stderr (where `glab` writes errors) and falls back to
/// stdout or the process exit code.
///
/// Diagnostic noise (the "Multiple config files found" warning that
/// glab emits when both `~/.config/glab-cli/` and `~/Library/…/glab-cli/`
/// exist) is filtered out — it pollutes every error message even when
/// the actual failure is unrelated, and the user can't act on it from
/// inside Helmor.
pub(super) fn command_detail(output: &CommandOutput) -> String {
    let stderr = strip_glab_noise(&output.stderr);
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = output.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    match output.status {
        Some(code) => format!("glab exited with status {code}"),
        None => "glab exited unsuccessfully".to_string(),
    }
}

/// Drop the multi-config warning preamble glab prints when the user has
/// configs in both XDG (`~/.config/glab-cli/`) and macOS-standard
/// (`~/Library/Application Support/glab-cli/`) locations. The warning
/// wraps four lines (the "Warning: …" header + Using/Ignoring/Consider
/// lines) and is purely informational. Stripping it leaves the real
/// error message clean.
fn strip_glab_noise(stderr: &str) -> String {
    let mut lines: Vec<&str> = stderr.lines().collect();
    while !lines.is_empty() {
        let first = lines[0].trim_start();
        let drop = first.starts_with("Warning: Multiple config files found")
            || first.starts_with("Using: ")
            || first.starts_with("Ignoring: ")
            || first.starts_with("Consider consolidating to one location");
        if drop {
            lines.remove(0);
        } else {
            break;
        }
    }
    lines.join("\n").trim().to_string()
}

/// Percent-encode a segment destined for a GitLab API path (e.g. the
/// `group/sub/project` component becomes `group%2Fsub%2Fproject`).
pub(super) fn encode_path_component(value: &str) -> String {
    encode_percent(value)
}

/// Percent-encode a query-string value.
pub(super) fn encode_query_value(value: &str) -> String {
    encode_percent(value)
}

fn encode_percent(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Resolve the directory glab should use as its config root, picking
/// one and only one even when the user has configs in both
/// `$XDG_CONFIG_HOME/glab-cli/` and `~/Library/Application Support/glab-cli/`.
///
/// Why this exists: glab prints a "Multiple config files found" warning
/// to stderr on every invocation when both dirs are populated, and the
/// warning leaks into our diagnostics. Setting `GLAB_CONFIG_DIR`
/// pins glab to a single dir so the warning never fires. We pick the
/// XDG dir when both are valid — that's the dir glab itself prefers in
/// the warning's "Using" line.
///
/// Cached after first resolution since the answer is stable for the
/// process lifetime.
fn resolved_glab_config_dir() -> Option<&'static PathBuf> {
    static CACHED: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHED.get_or_init(compute_glab_config_dir).as_ref()
}

fn compute_glab_config_dir() -> Option<PathBuf> {
    let xdg = xdg_glab_dir();
    let macos = macos_glab_dir();

    let xdg_has_config = xdg.as_ref().is_some_and(|p| p.join("config.yml").exists());
    let macos_has_config = macos
        .as_ref()
        .is_some_and(|p| p.join("config.yml").exists());

    match (xdg_has_config, macos_has_config) {
        (true, true) | (true, false) => xdg,
        (false, true) => macos,
        (false, false) => None,
    }
}

fn xdg_glab_dir() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("XDG_CONFIG_HOME") {
        if !value.trim().is_empty() {
            return Some(PathBuf::from(value).join("glab-cli"));
        }
    }
    let home = std::env::var_os("HOME")?;
    let mut path = PathBuf::from(home);
    path.push(".config");
    path.push("glab-cli");
    Some(path)
}

fn macos_glab_dir() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    let mut path = PathBuf::from(home);
    path.push("Library");
    path.push("Application Support");
    path.push("glab-cli");
    Some(path)
}

pub(super) fn looks_like_missing_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("404") || normalized.contains("not found")
}

pub(super) fn looks_like_auth_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("401")
        || normalized.contains("403")
        || normalized.contains("no token found")
        || normalized.contains("unauthenticated")
        || normalized.contains("unauthorized")
        || normalized.contains("forbidden")
        || normalized.contains("not logged in")
        || normalized.contains("not logged into")
        || normalized.contains("authentication required")
        || normalized.contains("authentication failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_gitlab_project_path_for_api() {
        assert_eq!(
            encode_path_component("platform/tools/api"),
            "platform%2Ftools%2Fapi"
        );
    }

    #[test]
    fn classifies_missing_and_auth_errors() {
        assert!(looks_like_missing_error("404 Not Found"));
        assert!(!looks_like_missing_error("401 Unauthorized"));
        assert!(looks_like_auth_error("401 Unauthorized"));
        assert!(looks_like_auth_error("Unauthenticated."));
        assert!(looks_like_auth_error("No token found"));
        assert!(looks_like_auth_error("authentication required"));
        assert!(looks_like_auth_error("authentication failed"));
        assert!(!looks_like_auth_error("authentication is optional"));
        assert!(!looks_like_auth_error("500 Internal Server Error"));
    }

    #[test]
    fn strips_multi_config_warning_from_stderr() {
        let stderr = "Warning: Multiple config files found. Only the first one will be used.\n  \
                      Using: /Users/me/.config/glab-cli/config.yml\n  \
                      Ignoring: /Users/me/Library/Application Support/glab-cli/config.yml\n\
                      Consider consolidating to one location to avoid confusion.\n\
                      glab: 404 Project Not Found (HTTP 404)";
        assert_eq!(
            strip_glab_noise(stderr),
            "glab: 404 Project Not Found (HTTP 404)"
        );
    }

    #[test]
    fn strip_glab_noise_passes_clean_errors_through() {
        assert_eq!(
            strip_glab_noise("glab: 401 Unauthorized"),
            "glab: 401 Unauthorized"
        );
        assert_eq!(strip_glab_noise(""), "");
    }

    #[test]
    fn strip_glab_noise_preserves_warning_lines_after_a_real_error() {
        // The warning preamble is consumed only when it's at the head of
        // stderr. Anything after a non-warning line stays intact so we
        // don't accidentally swallow legitimate output that happens to
        // contain the word "Warning".
        let stderr = "glab: 500 Internal Server Error\n\
                      Warning: Multiple config files found. Only the first one will be used.";
        assert!(strip_glab_noise(stderr).contains("Warning: Multiple config files"));
    }
}
