//! `hostRequest` handlers, namespaced. Only `triage.*` today.

pub mod triage;

use anyhow::Result;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

pub async fn route<R: Runtime>(app: AppHandle<R>, method: &str, params: Value) -> Result<Value> {
    if let Some(m) = method.strip_prefix("triage.") {
        return triage::dispatch(app, m, params).await;
    }
    Err(super::unknown_method(method))
}
