//! `hostRequest` handlers grouped by namespace prefix (`forge.*`,
//! `slack.*`, `lark.*`). Each submodule dispatches its own methods.

pub mod forge;
pub mod lark;
pub mod slack;

use anyhow::Result;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

pub async fn route<R: Runtime>(app: AppHandle<R>, method: &str, params: Value) -> Result<Value> {
    if let Some(m) = method.strip_prefix("forge.") {
        return forge::dispatch(app, m, params).await;
    }
    if let Some(m) = method.strip_prefix("slack.") {
        return slack::dispatch(app, m, params).await;
    }
    if let Some(m) = method.strip_prefix("lark.") {
        return lark::dispatch(app, m, params).await;
    }
    Err(super::unknown_method(method))
}
