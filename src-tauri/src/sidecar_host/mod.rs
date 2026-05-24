//! Reverse IPC — sidecar `hostRequest` on stdout, Rust `hostResponse` on stdin.

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
