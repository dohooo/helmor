//! Two REST calls we need for the feedback / Quick-fix flow:
//!
//!   1. `fork_helmor_upstream()` — POST /repos/{owner}/{repo}/forks
//!      Used when the user picks "Quick fix". GitHub treats repeat forks
//!      as idempotent and returns the same fork metadata, so no "has this
//!      user already forked?" probe is needed.
//!
//!   2. `create_helmor_issue(title, body)` — POST /repos/{owner}/{repo}/issues
//!      Used when the user picks "Create issue".
//!
//! Both calls reuse the OAuth token stored by the device-flow identity in
//! `auth.rs` and follow the same header conventions as
//! `github/graphql.rs`. Errors are surfaced verbatim so the UI can show the
//! GitHub-provided reason.

use anyhow::{anyhow, bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth;

use super::{HELMOR_UPSTREAM_OWNER, HELMOR_UPSTREAM_REPO};

const GITHUB_API_VERSION: &str = "2022-11-28";
const GITHUB_ACCEPT_JSON: &str = "application/vnd.github+json";

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

fn require_access_token() -> Result<String> {
    let Some(token) = auth::load_valid_github_access_token()? else {
        bail!(
            "GitHub account is not connected. Connect your GitHub account in Settings to continue."
        );
    };
    Ok(token)
}

fn build_client() -> Result<Client> {
    Client::builder()
        .build()
        .context("Failed to build GitHub HTTP client")
}

/// Fork the helmor upstream repo to the current user's account. Idempotent on
/// GitHub's side — re-forking returns the same fork metadata.
pub fn fork_helmor_upstream() -> Result<ForkResult> {
    let access_token = require_access_token()?;
    let client = build_client()?;

    let url = format!(
        "https://api.github.com/repos/{HELMOR_UPSTREAM_OWNER}/{HELMOR_UPSTREAM_REPO}/forks"
    );

    let response = client
        .post(&url)
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, GITHUB_ACCEPT_JSON)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        // Empty JSON body: we accept all default fork settings.
        .json(&json!({}))
        .send()
        .context("Failed to reach GitHub API")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        bail!("GitHub returned {status}: {body}");
    }

    let parsed: ForkResponse = response
        .json()
        .context("Failed to parse GitHub fork response")?;

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

    let access_token = require_access_token()?;
    let client = build_client()?;

    let url = format!(
        "https://api.github.com/repos/{HELMOR_UPSTREAM_OWNER}/{HELMOR_UPSTREAM_REPO}/issues"
    );

    let response = client
        .post(&url)
        .header(USER_AGENT, "Helmor")
        .header(ACCEPT, GITHUB_ACCEPT_JSON)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
        .json(&json!({
            "title": title,
            "body": body,
        }))
        .send()
        .context("Failed to reach GitHub API")?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        bail!("GitHub returned {status}: {body}");
    }

    let parsed: IssueResponse = response
        .json()
        .context("Failed to parse GitHub issue response")?;

    Ok(IssueResult {
        url: parsed.html_url,
        number: parsed.number,
    })
}
