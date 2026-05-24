//! `lark.*` host methods. Wraps the Rust-side `crate::lark::im` helpers
//! (which shell out to `lark-cli`). Triage previously spawned `lark-cli`
//! from the sidecar; we centralize the shell-out in Rust so any future
//! caller (inbox UI, context bridge) reuses the same surface.

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

use crate::lark::im;

pub async fn dispatch<R: Runtime>(
    _app: AppHandle<R>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match method {
        "auth_status" => {
            crate::lark::auth_status().await?;
            Ok(Value::Bool(true))
        }
        "chat_search" => chat_search(params).await,
        "chat_messages_list" => chat_messages_list(params).await,
        "messages_search" => messages_search(params).await,
        "messages_get" => messages_get(params).await,
        _ => Err(crate::sidecar_host::unknown_method(method)),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ChatSearchParams {
    query: Option<String>,
    member_ids: Option<String>,
    page_size: Option<u32>,
}

async fn chat_search(params: Value) -> Result<Value> {
    let p: ChatSearchParams = serde_json::from_value(params)?;
    im::chat_search(im::ChatSearch {
        query: p.query.as_deref(),
        member_ids: p.member_ids.as_deref(),
        page_size: p.page_size.unwrap_or(50),
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessagesParams {
    chat_id: String,
    #[serde(default)]
    page_size: Option<u32>,
    #[serde(default)]
    start: Option<String>,
}

async fn chat_messages_list(params: Value) -> Result<Value> {
    let p: ChatMessagesParams = serde_json::from_value(params)?;
    im::chat_messages_list(im::ChatMessages {
        chat_id: &p.chat_id,
        page_size: p.page_size.unwrap_or(50),
        start: p.start.as_deref(),
    })
    .await
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MessagesSearchParams {
    query: Option<String>,
    sender: Option<String>,
    chat_id: Option<String>,
    is_at_me: bool,
    start: Option<String>,
    end: Option<String>,
    page_size: Option<u32>,
}

async fn messages_search(params: Value) -> Result<Value> {
    let p: MessagesSearchParams = serde_json::from_value(params)?;
    im::messages_search(im::MessagesSearch {
        query: p.query.as_deref(),
        sender: p.sender.as_deref(),
        chat_id: p.chat_id.as_deref(),
        is_at_me: p.is_at_me,
        start: p.start.as_deref(),
        end: p.end.as_deref(),
        page_size: p.page_size.unwrap_or(50),
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesGetParams {
    message_ids: String,
}

async fn messages_get(params: Value) -> Result<Value> {
    let p: MessagesGetParams = serde_json::from_value(params)?;
    im::messages_get(&p.message_ids).await
}
