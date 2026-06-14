//! Cloud Run Identity brokers — capture a user's **subscription** credential on
//! their own machine and hand it to the per-team Durable Object on the
//! control-plane Worker, which is the single owner of the secret at rest.
//!
//! Two providers, one shared contract:
//!   * [`codex`] — captures the ChatGPT OAuth `refresh_token` + `id_token` via
//!     an interactive `codex login` (loopback callback) and reads the throwaway
//!     `auth.json`.
//!   * [`claude`] — captures the long-lived `CLAUDE_CODE_OAUTH_TOKEN` via
//!     `claude setup-token`. That command is an Ink raw-mode TUI that prints the
//!     token to the terminal ONLY (it saves nothing to disk), so capture needs a
//!     PTY, not piped stdio.
//!
//! Each provider uploads over its OWN authenticated sibling route — Codex to
//! `PUT {worker_url}/team/cloud-identity`, Claude to
//! `PUT {worker_url}/team/claude-identity` (the Worker has distinct handlers
//! reading distinct bodies: `{refreshToken, idToken}` vs `{oauthToken}`). Both
//! derive the member from the bearer alone; neither secret is ever logged,
//! returned to the frontend, written to the user's real CLI home, or persisted
//! locally by Helmor.
//!
//! The team Worker base URL + bearer live in the frontend's `localStorage`
//! (`src/lib/team-mode.ts`); the Rust backend cannot read them, so each command
//! takes `worker_url` + `team_token` in.

use std::path::Path;
use std::time::Duration;

mod claude;
mod codex;

// Re-export the Tauri commands so the existing registration paths
// (`commands::cloud_identity::authorize_cloud_codex_identity`) keep resolving
// after the file→directory split. Globs (not named re-exports) are required:
// `#[tauri::command]` generates sibling `__cmd__*` / `__tauri_command_name_*`
// items in the defining module that `tauri::generate_handler!` resolves through
// this path, so they must come along with the function.
pub use claude::*;
pub use codex::*;

/// Worker route the **Codex** broker PUTs the cloud identity through, appended to
/// the (trailing-slash-stripped) team base URL. The Worker's `putCloudIdentity`
/// handler reads `{refreshToken, idToken}`.
const CLOUD_IDENTITY_PATH: &str = "/team/cloud-identity";

/// Worker route the **Claude** broker PUTs the cloud identity through. A SIBLING
/// of the Codex route (not the same path with a `provider` discriminant): the
/// Worker's `putClaudeIdentity` handler reads `{oauthToken}` and stores it in
/// the `ClaudeIdentity` DO. Using the Codex path would hit `putCloudIdentity`,
/// which reads `refreshToken`/`idToken` and 400s on a Claude body.
const CLAUDE_IDENTITY_PATH: &str = "/team/claude-identity";

/// Short timeout for the control-plane round-trips — these are tiny JSON
/// requests against the Worker, mirroring `rate_limits::codex`.
const WORKER_TIMEOUT: Duration = Duration::from_secs(30);

/// Join the (possibly trailing-slashed) team base URL with the given route path.
/// Mirrors the frontend's `normalizeUrl` (strip trailing `/`) so a base saved
/// with or without a slash resolves identically. Rejects an empty base.
fn identity_url(worker_base: &str, path: &str) -> anyhow::Result<String> {
    let trimmed = worker_base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        anyhow::bail!("Team mode is not configured (no Worker URL).");
    }
    Ok(format!("{trimmed}{path}"))
}

/// Build the Codex broker's `PUT /team/cloud-identity` URL from the team base.
fn cloud_identity_url(worker_base: &str) -> anyhow::Result<String> {
    identity_url(worker_base, CLOUD_IDENTITY_PATH)
}

/// Build the Claude broker's `PUT /team/claude-identity` URL from the team base.
fn claude_identity_url(worker_base: &str) -> anyhow::Result<String> {
    identity_url(worker_base, CLAUDE_IDENTITY_PATH)
}

/// Tighten a freshly created directory to `0700` on Unix. No-op on Windows,
/// where the per-user temp dir already inherits the user's ACL and there is no
/// POSIX mode to set. Best-effort hardening on top of `tempfile`'s default.
/// Shared by both brokers' throwaway CLI-home dirs.
#[cfg(unix)]
fn harden_dir_permissions(path: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("Failed to set 0700 on temp dir at {}", path.display()))
}

#[cfg(not(unix))]
fn harden_dir_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_identity_url_strips_trailing_slash() {
        assert_eq!(
            cloud_identity_url("https://team.example.workers.dev/").unwrap(),
            "https://team.example.workers.dev/team/cloud-identity"
        );
        assert_eq!(
            cloud_identity_url("https://team.example.workers.dev").unwrap(),
            "https://team.example.workers.dev/team/cloud-identity"
        );
        assert_eq!(
            cloud_identity_url("  https://team.example.workers.dev///  ").unwrap(),
            "https://team.example.workers.dev/team/cloud-identity"
        );
    }

    #[test]
    fn cloud_identity_url_rejects_empty_base() {
        assert!(cloud_identity_url("").is_err());
        assert!(cloud_identity_url("   ").is_err());
        assert!(cloud_identity_url("///").is_err());
    }

    #[test]
    fn claude_identity_url_uses_the_sibling_route() {
        // The Claude broker MUST target the sibling `/team/claude-identity`
        // route (Worker `putClaudeIdentity`), NOT the Codex `/team/cloud-identity`
        // path — the latter reads refreshToken/idToken and 400s on a Claude body.
        assert_eq!(
            claude_identity_url("https://team.example.workers.dev/").unwrap(),
            "https://team.example.workers.dev/team/claude-identity"
        );
        assert_eq!(
            claude_identity_url("https://team.example.workers.dev").unwrap(),
            "https://team.example.workers.dev/team/claude-identity"
        );
        assert!(claude_identity_url("   ").is_err());
    }
}
