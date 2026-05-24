//! `slack.*` host methods. Wraps the same `slack::inbox` / `slack::detail`
//! entry points the `slack_*` Tauri commands use. Multi-workspace by
//! `team_id` — the agent first calls `slack.list_workspaces`, then keys
//! every subsequent call on the chosen `teamId`.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::models::slack_workspaces;
use crate::slack::{api as slack_api, detail, inbox};

pub async fn dispatch<R: Runtime>(
    _app: AppHandle<R>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "list_workspaces" => list_workspaces().await,
        "list_inbox" => list_inbox(params).await,
        "search_messages" => search_messages(params).await,
        "get_thread_detail" => get_thread_detail(params).await,
        _ => Err(crate::sidecar_host::unknown_method(method)),
    }
}

async fn list_workspaces() -> Result<Value> {
    let workspaces =
        tauri::async_runtime::spawn_blocking(slack_workspaces::list_workspaces).await??;
    Ok(serde_json::to_value(workspaces)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListInboxParams {
    team_id: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

async fn list_inbox(params: Value) -> Result<Value> {
    let p: ListInboxParams = serde_json::from_value(params)?;
    let limit = p.limit.unwrap_or(30).clamp(1, 100);
    let page = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let workspace = slack_workspaces::get_workspace(&p.team_id)?
            .with_context(|| format!("Slack workspace {} not connected", p.team_id))?;
        inbox::list_inbox_items(
            &workspace.team_id,
            &workspace.my_user_id,
            p.cursor.as_deref(),
            limit,
        )
    })
    .await??;
    Ok(serde_json::to_value(page)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    team_id: String,
    query: String,
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<u32>,
}

async fn search_messages(params: Value) -> Result<Value> {
    let p: SearchParams = serde_json::from_value(params)?;
    let limit = p.limit.unwrap_or(30).clamp(1, 100);
    let sort = match p.sort.as_deref() {
        Some("relevance") | Some("score") => slack_api::SearchSort::Score,
        _ => slack_api::SearchSort::Timestamp,
    };
    let page = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        let workspace = slack_workspaces::get_workspace(&p.team_id)?
            .with_context(|| format!("Slack workspace {} not connected", p.team_id))?;
        inbox::search(
            &workspace.team_id,
            &p.query,
            sort,
            p.cursor.as_deref(),
            limit,
        )
    })
    .await??;
    Ok(serde_json::to_value(page)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadParams {
    team_id: String,
    channel_id: String,
    #[serde(default)]
    thread_ts: Option<String>,
    anchor_ts: String,
}

async fn get_thread_detail(params: Value) -> Result<Value> {
    let p: ThreadParams = serde_json::from_value(params)?;
    let detail = tauri::async_runtime::spawn_blocking(move || -> Result<_> {
        // Validate workspace presence before reaching for credentials.
        let _ = slack_workspaces::get_workspace(&p.team_id)?
            .with_context(|| format!("Slack workspace {} not connected", p.team_id))?;
        detail::get_thread_detail(
            &p.team_id,
            &p.channel_id,
            p.thread_ts.as_deref(),
            &p.anchor_ts,
        )
    })
    .await??;
    Ok(serde_json::to_value(detail)?)
}

#[allow(dead_code)]
fn _ensure_anyhow_used(_e: anyhow::Error) -> anyhow::Error {
    anyhow!("placeholder")
}
