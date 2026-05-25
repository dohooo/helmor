//! `lark.*` host methods — thin wrappers over `crate::lark::im`.

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
        "save_image" => save_image(params).await,
        _ => Err(crate::sidecar_host::unknown_method(method)),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveImageParams {
    tick_id: String,
    message_id: String,
    image_key: String,
    #[serde(default)]
    extension: Option<String>,
}

async fn save_image(params: Value) -> Result<Value> {
    let p: SaveImageParams = serde_json::from_value(params)?;
    let ext = p.extension.as_deref().unwrap_or("png");
    let staged = crate::triage::attachments::reserve_attachment(&p.tick_id, Some(ext))?;
    let cwd = staged
        .path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("staged path has no parent"))?
        .to_path_buf();
    im::download_resource(&p.message_id, "image", &p.image_key, &cwd, &staged.filename).await?;
    let size = tokio::fs::metadata(&staged.path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let preview = crate::triage::attachments::inline_preview(&staged.path)
        .ok()
        .flatten();
    let mut out = serde_json::json!({
        "id": staged.id,
        "filename": staged.filename,
        "sizeBytes": size,
    });
    if let (Some(map), Some(preview)) = (out.as_object_mut(), preview) {
        map.insert("dataBase64".into(), Value::String(preview.data_base64));
        map.insert("mimeType".into(), Value::String(preview.mime_type));
    }
    Ok(out)
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
