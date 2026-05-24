//! Reverse IPC: sidecar calls into Rust via `hostRequest` JSON on stdout,
//! Rust replies via `hostResponse` JSON on stdin. Mirrors `SidecarRequest`
//! but inverted. Used by the triage agent to reuse Helmor's native
//! forge / slack / lark integrations instead of reimplementing them in
//! the sidecar.

pub mod handlers;
pub mod protocol;

use anyhow::Result;
use serde_json::Value;
use tauri::{AppHandle, Runtime};

pub use protocol::{HostRequest, HostResponse};

pub async fn dispatch<R: Runtime>(app: AppHandle<R>, method: &str, params: Value) -> Result<Value> {
    handlers::route(app, method, params).await
}

pub fn unknown_method(method: &str) -> anyhow::Error {
    anyhow::anyhow!("unknown host method: {method}")
}
