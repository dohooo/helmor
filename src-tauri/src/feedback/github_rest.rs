//! REST calls for the feedback / Quick-fix flow.
//!
//!   1. `fork_helmor_upstream()` — POST /repos/{owner}/{repo}/forks
//!      Idempotent on GitHub's side; re-forking returns the same metadata.
//!   2. `create_helmor_issue(title, body)` — POST /repos/{owner}/{repo}/issues
//!      Called after the user has confirmed in the dialog.
//!
//! Both go through the shared `gh api` forge backend so we inherit the
//! account selection + auth that the rest of the app uses.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::forge::{accounts, ForgeProvider};

use super::{HELMOR_UPSTREAM_OWNER, HELMOR_UPSTREAM_REPO};

const GITHUB_ACCEPT_JSON_HEADER: &str = "Accept: application/vnd.github+json";
const GITHUB_API_VERSION_HEADER: &str = "X-GitHub-Api-Version: 2022-11-28";
const GITHUB_HOST: &str = "github.com";

/// Metadata returned after successfully forking (or re-fetching an existing
/// fork of) the helmor upstream repository.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    pub owner: String,
    pub repo: String,
    pub clone_url: String,
    pub html_url: String,
}

/// Metadata returned after successfully creating an issue.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueResult {
    pub url: String,
    pub number: i64,
}

#[derive(Debug, Deserialize)]
struct ForkResponse {
    name: String,
    clone_url: String,
    html_url: String,
    owner: ForkOwner,
}

#[derive(Debug, Deserialize)]
struct ForkOwner {
    login: String,
}

#[derive(Debug, Deserialize)]
struct IssueResponse {
    html_url: String,
    number: i64,
}

fn require_github_login() -> Result<String> {
    let Some(backend) = accounts::backend_for(ForgeProvider::Github) else {
        bail!("GitHub support is not available.");
    };
    let logins = backend.list_logins(GITHUB_HOST)?;
    logins.into_iter().next().ok_or_else(|| {
        anyhow!("GitHub account is not connected. Connect GitHub in Settings to continue.")
    })
}

fn run_github_api(login: &str, args: &[&str]) -> Result<String> {
    let Some(backend) = accounts::backend_for(ForgeProvider::Github) else {
        bail!("GitHub support is not available.");
    };
    let output = backend.run_cli(GITHUB_HOST, login, args)?;
    if !output.success {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        bail!("`gh api` failed: {detail}");
    }
    Ok(output.stdout)
}

/// Fork the helmor upstream repo to the current user's account. Idempotent on
/// GitHub's side — re-forking returns the same fork metadata.
pub fn fork_helmor_upstream() -> Result<ForkResult> {
    let login = require_github_login()?;
    let path = format!("repos/{HELMOR_UPSTREAM_OWNER}/{HELMOR_UPSTREAM_REPO}/forks");
    let stdout = run_github_api(
        &login,
        &[
            "api",
            "--method",
            "POST",
            "--hostname",
            GITHUB_HOST,
            "-H",
            GITHUB_ACCEPT_JSON_HEADER,
            "-H",
            GITHUB_API_VERSION_HEADER,
            &path,
        ],
    )?;
    let parsed: ForkResponse =
        serde_json::from_str(&stdout).context("Failed to parse GitHub fork response")?;

    Ok(ForkResult {
        owner: parsed.owner.login,
        repo: parsed.name,
        clone_url: parsed.clone_url,
        html_url: parsed.html_url,
    })
}

/// Create an issue on the helmor upstream repo.
pub fn create_helmor_issue(title: &str, body: &str) -> Result<IssueResult> {
    let title = title.trim();
    if title.is_empty() {
        return Err(anyhow!("Issue title must not be empty"));
    }
    let login = require_github_login()?;
    let path = format!("repos/{HELMOR_UPSTREAM_OWNER}/{HELMOR_UPSTREAM_REPO}/issues");
    let title_field = format!("title={title}");
    let body_field = format!("body={body}");
    let stdout = run_github_api(
        &login,
        &[
            "api",
            "--method",
            "POST",
            "--hostname",
            GITHUB_HOST,
            "-H",
            GITHUB_ACCEPT_JSON_HEADER,
            "-H",
            GITHUB_API_VERSION_HEADER,
            "-f",
            &title_field,
            "-f",
            &body_field,
            &path,
        ],
    )?;
    let parsed: IssueResponse =
        serde_json::from_str(&stdout).context("Failed to parse GitHub issue response")?;
    Ok(IssueResult {
        url: parsed.html_url,
        number: parsed.number,
    })
}
