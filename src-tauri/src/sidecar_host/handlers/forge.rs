//! `forge.*` host methods. Triage uses these to enumerate the user's
//! GitHub / GitLab inbox without reimplementing `gh search` / `glab
//! issue list` in TypeScript.

use anyhow::{anyhow, Context, Result};
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
        "get_inbox_item_detail" => get_inbox_item_detail(params).await,
        "save_attachment" => save_attachment(params).await,
        _ => Err(crate::sidecar_host::unknown_method(method)),
    }
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
