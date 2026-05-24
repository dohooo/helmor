//! `forge.*` host methods. Triage uses these to enumerate the user's
//! GitHub / GitLab inbox without reimplementing `gh search` / `glab
//! issue list` in TypeScript.

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::forge::{
    accounts, forge_backend_for, ForgeProvider, InboxFilters, InboxKind, InboxSource,
};

pub async fn dispatch<R: Runtime>(
    _app: AppHandle<R>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "discover_login" => discover_login(params).await,
        "list_inbox_items" => list_inbox_items(params).await,
        "list_repo_items" => list_repo_items(params).await,
        "get_inbox_item_detail" => get_inbox_item_detail(params).await,
        "save_attachment" => save_attachment(params).await,
        _ => Err(crate::sidecar_host::unknown_method(method)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRepoItemsParams {
    repo_id: String,
    /// "issues" | "prs" (GitHub) | "mrs" (GitLab)
    kind: String,
    /// "open" | "closed" | "all" — defaults to "open".
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

async fn list_repo_items(params: Value) -> Result<Value> {
    let p: ListRepoItemsParams = serde_json::from_value(params)?;
    let limit = p.limit.unwrap_or(30).clamp(1, 100) as u32;
    let state = p
        .state
        .as_deref()
        .map(str::to_lowercase)
        .unwrap_or_else(|| "open".to_string());
    let kind = p.kind.to_lowercase();

    tauri::async_runtime::spawn_blocking(move || -> Result<Value> {
        // RepositoryRecord only carries the git remote *name* (e.g. "origin");
        // `list_repositories()` is the loader that resolves it to the URL.
        let summary = crate::models::repos::list_repositories()?
            .into_iter()
            .find(|r| r.id == p.repo_id)
            .ok_or_else(|| anyhow!("repo {} not found", p.repo_id))?;
        let provider = summary
            .forge_provider
            .as_deref()
            .unwrap_or("")
            .to_lowercase();
        let remote = summary
            .remote_url
            .as_deref()
            .ok_or_else(|| anyhow!("repo {} has no remote URL", p.repo_id))?;

        match provider.as_str() {
            "github" => run_gh_list(remote, &kind, &state, limit),
            "gitlab" => run_glab_list(remote, &kind, &state, limit),
            other => bail!("forge.list_repo_items: provider \"{other}\" not supported"),
        }
    })
    .await?
}

fn run_gh_list(remote: &str, kind: &str, state: &str, limit: u32) -> Result<Value> {
    let (owner, name) = parse_github_remote(remote)
        .ok_or_else(|| anyhow!("cannot parse GitHub remote: {remote}"))?;
    let repo_arg = format!("{owner}/{name}");
    let subcommand = match kind {
        "issues" => "issue",
        "prs" | "mrs" => "pr",
        other => bail!("unknown kind: {other}"),
    };
    let limit_str = limit.to_string();
    let json_fields = match subcommand {
        "issue" => "number,title,state,author,url,updatedAt,body,labels,assignees",
        "pr" => "number,title,state,author,url,updatedAt,body,labels,assignees,isDraft",
        _ => unreachable!(),
    };
    let args = vec![
        subcommand,
        "list",
        "-R",
        repo_arg.as_str(),
        "--state",
        state,
        "--limit",
        limit_str.as_str(),
        "--json",
        json_fields,
    ];
    let output =
        crate::forge::command::run_command("gh", args).map_err(|e| anyhow!("spawn gh: {e}"))?;
    if !output.success {
        let tail = output.stderr.lines().rev().take(5).collect::<Vec<_>>();
        bail!(
            "gh {subcommand} list failed (exit {:?}): {}",
            output.status,
            tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
        );
    }
    let items: Value =
        serde_json::from_str(&output.stdout).unwrap_or_else(|_| Value::Array(Vec::new()));
    Ok(json!({ "items": items, "repo": repo_arg }))
}

fn run_glab_list(remote: &str, kind: &str, state: &str, limit: u32) -> Result<Value> {
    let full_path = parse_gitlab_full_path(remote)
        .ok_or_else(|| anyhow!("cannot parse GitLab remote: {remote}"))?;
    let subcommand = match kind {
        "issues" => "issue",
        "prs" | "mrs" => "mr",
        other => bail!("unknown kind: {other}"),
    };
    let glab_state = match state {
        "open" => "opened",
        "closed" => "closed",
        _ => "all",
    };
    let limit_str = limit.to_string();
    let args = vec![
        subcommand,
        "list",
        "-R",
        full_path.as_str(),
        "--state",
        glab_state,
        "--per-page",
        limit_str.as_str(),
        "--output",
        "json",
    ];
    let output =
        crate::forge::command::run_command("glab", args).map_err(|e| anyhow!("spawn glab: {e}"))?;
    if !output.success {
        let tail = output.stderr.lines().rev().take(5).collect::<Vec<_>>();
        bail!(
            "glab {subcommand} list failed (exit {:?}): {}",
            output.status,
            tail.into_iter().rev().collect::<Vec<_>>().join("\n"),
        );
    }
    let items: Value =
        serde_json::from_str(&output.stdout).unwrap_or_else(|_| Value::Array(Vec::new()));
    Ok(json!({ "items": items, "repo": full_path }))
}

/// `git@github.com:owner/repo.git` or `https://github.com/owner/repo(.git)`
fn parse_github_remote(remote: &str) -> Option<(String, String)> {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let body = trimmed
        .strip_prefix("git@github.com:")
        .or_else(|| trimmed.strip_prefix("https://github.com/"))
        .or_else(|| trimmed.strip_prefix("ssh://git@github.com/"))?;
    let mut parts = body.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

/// Accept any GitLab host (gitlab.com, ngit.hundun.cn, self-hosted).
/// Returns the project's `group[/sub]/project` path that `glab -R` wants.
fn parse_gitlab_full_path(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    // git@host:group/project — split on the first colon.
    if let Some((_, rest)) = trimmed.split_once(':') {
        if !rest.contains("://") && rest.contains('/') {
            return Some(rest.to_string());
        }
    }
    // https://host/group/project — strip scheme + host.
    if let Some(no_scheme) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://git@"))
    {
        let (_, rest) = no_scheme.split_once('/')?;
        if !rest.is_empty() {
            return Some(rest.to_string());
        }
    }
    None
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveAttachmentParams {
    tick_id: String,
    /// HTTPS URL of an image embedded in an issue/PR body or comment.
    /// GitHub user-content / GitLab uploads are public CDNs; no auth
    /// header needed for the common case.
    url: String,
}

async fn save_attachment(params: Value) -> Result<Value> {
    let p: SaveAttachmentParams = serde_json::from_value(params)?;
    let ext = guess_ext(&p.url);
    let staged = crate::triage::attachments::reserve_attachment(&p.tick_id, ext.as_deref())?;
    let response = reqwest::get(&p.url)
        .await
        .with_context(|| format!("GET {}", p.url))?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {} fetching {}", response.status(), p.url);
    }
    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("read body of {}", p.url))?;
    tokio::fs::write(&staged.path, &bytes).await?;
    Ok(json!({
        "id": staged.id,
        "filename": staged.filename,
        "sizeBytes": bytes.len(),
    }))
}

fn guess_ext(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let last = path.rsplit('/').next()?;
    let dot = last.rfind('.')?;
    let ext = &last[dot + 1..];
    if ext.is_empty() || ext.len() > 12 {
        return None;
    }
    Some(ext.to_string())
}

fn parse_provider(s: &str) -> Result<ForgeProvider> {
    match s {
        "github" | "Github" => Ok(ForgeProvider::Github),
        "gitlab" | "Gitlab" => Ok(ForgeProvider::Gitlab),
        _ => Err(anyhow!("unknown forge provider: {s}")),
    }
}

fn parse_kind(s: &str) -> Result<InboxKind> {
    match s {
        "issues" | "Issues" => Ok(InboxKind::Issues),
        "prs" | "Prs" | "PRs" => Ok(InboxKind::Prs),
        "discussions" | "Discussions" => Ok(InboxKind::Discussions),
        _ => Err(anyhow!("unknown inbox kind: {s}")),
    }
}

fn parse_source(s: &str) -> Result<InboxSource> {
    match s {
        "github_issue" | "githubIssue" | "GithubIssue" => Ok(InboxSource::GithubIssue),
        "github_pr" | "githubPr" | "GithubPr" => Ok(InboxSource::GithubPr),
        "github_discussion" | "githubDiscussion" | "GithubDiscussion" => {
            Ok(InboxSource::GithubDiscussion)
        }
        "gitlab_issue" | "gitlabIssue" | "GitlabIssue" => Ok(InboxSource::GitlabIssue),
        "gitlab_mr" | "gitlabMr" | "GitlabMr" => Ok(InboxSource::GitlabMr),
        _ => Err(anyhow!("unknown inbox source: {s}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverLoginParams {
    provider: String,
    #[serde(default)]
    host: Option<String>,
}

async fn discover_login(params: Value) -> Result<Value> {
    let p: DiscoverLoginParams = serde_json::from_value(params)?;
    let provider = parse_provider(&p.provider)?;
    let host = p.host.unwrap_or_else(|| match provider {
        ForgeProvider::Gitlab => "gitlab.com".to_string(),
        // Github + Unknown (parse_provider rejects Unknown so it's
        // unreachable in practice — default to github.com for safety).
        _ => "github.com".to_string(),
    });
    let logins = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>> {
        let backend = accounts::backend_for(provider)
            .ok_or_else(|| anyhow!("forge backend missing for {provider:?}"))?;
        backend.list_logins(&host)
    })
    .await??;
    Ok(json!({
        "login": logins.first().cloned(),
        "all": logins,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListInboxParams {
    provider: String,
    kind: String,
    login: String,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    filters: Option<InboxFilters>,
}

async fn list_inbox_items(params: Value) -> Result<Value> {
    let p: ListInboxParams = serde_json::from_value(params)?;
    let provider = parse_provider(&p.provider)?;
    let kind = parse_kind(&p.kind)?;
    let limit = p.limit.unwrap_or(30).clamp(1, 100) as usize;
    let page = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let backend = forge_backend_for(provider)
            .ok_or_else(|| anyhow!("forge backend missing for {provider:?}"))?;
        match kind {
            InboxKind::Issues => backend.list_inbox_issues(
                &p.login,
                p.host.as_deref(),
                p.cursor.as_deref(),
                limit,
                p.repo.as_deref(),
                p.filters,
            ),
            InboxKind::Prs => backend.list_inbox_prs(
                &p.login,
                p.host.as_deref(),
                p.cursor.as_deref(),
                limit,
                p.repo.as_deref(),
                p.filters,
            ),
            InboxKind::Discussions => backend.list_inbox_discussions(
                &p.login,
                p.host.as_deref(),
                p.cursor.as_deref(),
                limit,
                p.repo.as_deref(),
                p.filters,
            ),
        }
    })
    .await??;
    Ok(serde_json::to_value(page)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailParams {
    provider: String,
    login: String,
    #[serde(default)]
    host: Option<String>,
    source: String,
    external_id: String,
}

async fn get_inbox_item_detail(params: Value) -> Result<Value> {
    let p: DetailParams = serde_json::from_value(params)?;
    let provider = parse_provider(&p.provider)?;
    let source = parse_source(&p.source)?;
    let detail = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let backend = forge_backend_for(provider)
            .ok_or_else(|| anyhow!("forge backend missing for {provider:?}"))?;
        backend.get_inbox_item_detail(&p.login, p.host.as_deref(), source, &p.external_id)
    })
    .await??;
    Ok(serde_json::to_value(detail)?)
}
