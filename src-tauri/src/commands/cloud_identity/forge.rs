//! Cloud Run Identity — per-member forge (gh/glab) credential broker (upload).
//!
//! Captures THIS machine's forge credentials and PUTs them to the member's
//! `ForgeIdentity` Durable Object on the control-plane Worker (the single owner
//! at rest), so the remote shared sandbox can authenticate git/gh/glab AS this
//! member (true per-member). Runs ONLY on the desktop (LOCAL_ONLY): the gh token
//! lives in the OS keychain and glab's token in a local config file — neither is
//! reachable from the cloud container.
//!
//! Extraction mirrors the local-docker launcher:
//! - gh: `gh auth token --hostname github.com` (the token lives in the keychain,
//!   not in hosts.yml, so it MUST be pulled via the CLI, not copied).
//! - glab: the verbatim `glab-cli/config.yml` (the token is plaintext in it).
//!
//! IRON RULES (mirror the Claude broker): the credentials NEVER leave this
//! process except in the single authenticated `PUT /team/forge-identity` body;
//! NEVER logged, NEVER returned to the frontend (the result is metadata only),
//! NEVER persisted locally by Helmor.

use anyhow::Context;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::{forge_identity_url, WORKER_TIMEOUT};
use crate::commands::common::{run_blocking, CmdResult};

/// Body of `PUT /team/forge-identity`. Both fields are optional; at least one is
/// present (enforced before upload). camelCase to match the Worker handler.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    github_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    glab_config_yml: Option<&'a str>,
}

/// Worker echo — metadata only, NEVER a token.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    #[serde(default)]
    #[allow(dead_code)]
    changed: bool,
}

/// Returned to the frontend after a successful sync. Metadata only — what got
/// uploaded, never any token.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudForgeAuthResult {
    pub has_github: bool,
    pub glab_hosts: Vec<String>,
}

#[tauri::command]
pub async fn authorize_cloud_forge_identity(
    worker_url: String,
    team_token: String,
) -> CmdResult<CloudForgeAuthResult> {
    run_blocking(move || authorize_blocking(&worker_url, &team_token)).await
}

fn authorize_blocking(worker_url: &str, team_token: &str) -> anyhow::Result<CloudForgeAuthResult> {
    let github_token = extract_github_token();
    let glab = extract_glab_config();
    if github_token.is_none() && glab.is_none() {
        anyhow::bail!(
            "No gh or glab login found on this machine. Run `gh auth login` and/or `glab auth login` first."
        );
    }

    let has_github = github_token.is_some();
    let glab_hosts = glab
        .as_ref()
        .map(|(_, hosts)| hosts.clone())
        .unwrap_or_default();

    upload_to_worker(
        worker_url,
        team_token,
        github_token.as_ref().map(|t| t.as_str()),
        glab.as_ref().map(|(config, _)| config.as_str()),
    )?;

    Ok(CloudForgeAuthResult {
        has_github,
        glab_hosts,
    })
}

/// Pull the active github.com token from the keychain via the bundled gh. The
/// token is never in hosts.yml on macOS, so a CLI call is the only way to read
/// it. `None` when gh is absent / logged out.
fn extract_github_token() -> Option<Zeroizing<String>> {
    let output =
        crate::forge::command::run_command("gh", ["auth", "token", "--hostname", "github.com"])
            .ok()?;
    if !output.success {
        return None;
    }
    let token = output.stdout.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(Zeroizing::new(token))
    }
}

/// Read the host's glab `config.yml` (token is plaintext in it) + the host list.
/// `None` when glab is not configured.
fn extract_glab_config() -> Option<(String, Vec<String>)> {
    let dir = crate::forge::gitlab::resolved_glab_config_dir()?;
    let config = std::fs::read_to_string(dir.join("config.yml")).ok()?;
    if config.trim().is_empty() {
        return None;
    }
    let hosts = parse_glab_hosts(&config);
    Some((config, hosts))
}

/// Host keys under glab's `hosts:` block. Mirrors the cloud `parseGlabHosts`
/// (4-space-indented host keys) so both layers agree on the contract.
fn parse_glab_hosts(config: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    let mut in_hosts = false;
    for line in config.lines() {
        if line.trim_end() == "hosts:" {
            in_hosts = true;
            continue;
        }
        if !in_hosts {
            continue;
        }
        // A non-indented line ends the `hosts:` block.
        if line.chars().next().is_some_and(|c| !c.is_whitespace()) {
            break;
        }
        if let Some(rest) = line.strip_prefix("    ") {
            if !rest.starts_with(' ') {
                if let Some(name) = rest.strip_suffix(':') {
                    let name = name.trim();
                    if !name.is_empty() {
                        hosts.push(name.to_string());
                    }
                }
            }
        }
    }
    hosts
}

/// PUT the captured credentials to the Worker. NEVER logs the body. Blocking
/// reqwest — the async command wraps this in `spawn_blocking`.
fn upload_to_worker(
    worker_base: &str,
    team_token: &str,
    github_token: Option<&str>,
    glab_config_yml: Option<&str>,
) -> anyhow::Result<()> {
    let url = forge_identity_url(worker_base)?;
    let body = serde_json::to_string(&UploadBody {
        github_token,
        glab_config_yml,
    })
    .context("Failed to serialize forge-identity upload body")?;

    let client = reqwest::blocking::Client::builder()
        .timeout(WORKER_TIMEOUT)
        .build()
        .context("Failed to build HTTP client")?;

    let mut request = client
        .put(&url)
        .header("Content-Type", "application/json")
        .body(body);
    if !team_token.is_empty() {
        request = request.bearer_auth(team_token);
    }

    let response = request
        .send()
        .context("Failed to reach the team Worker to store the forge identity")?;

    let status = response.status();
    if !status.is_success() {
        anyhow::bail!(
            "Worker rejected the forge identity (HTTP {})",
            status.as_u16()
        );
    }

    response
        .json::<UploadResponse>()
        .context("Worker returned an unexpected forge-identity response")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_body_is_camel_case_and_omits_absent_fields() {
        let body = serde_json::to_string(&UploadBody {
            github_token: Some("gho_secret"),
            glab_config_yml: None,
        })
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["githubToken"], "gho_secret");
        assert!(value.get("glabConfigYml").is_none());
        assert!(value.get("github_token").is_none());
        assert_eq!(value.as_object().unwrap().len(), 1);
    }

    #[test]
    fn parse_glab_hosts_reads_four_space_host_keys() {
        let config = "hosts:\n    gitlab.com:\n        token: x\n    ngit.hundun.cn:\n        token: y\nother: 1\n";
        assert_eq!(parse_glab_hosts(config), ["gitlab.com", "ngit.hundun.cn"]);
    }

    #[test]
    fn parse_glab_hosts_empty_when_no_hosts_block() {
        assert!(parse_glab_hosts("git_protocol: ssh\n").is_empty());
    }
}
