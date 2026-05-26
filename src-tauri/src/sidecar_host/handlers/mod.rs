//! `hostRequest` handlers grouped by namespace prefix.
//!
//! Only one namespace today: `triage.*` — Layer-2 LLM's window into
//! `triage_candidate` rows. The old `forge.*` / `lark.*` / `slack.*`
//! handlers existed to feed the previous LLM's discovery loop; that
//! loop is gone (fetcher pre-builds the candidate index) and so are
//! the handlers.

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
