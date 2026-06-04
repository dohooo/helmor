//! HTTP RPC dispatch.
//!
//! Maps a command name + JSON args to the same domain functions the Tauri
//! command handlers call, returning a JSON value. Slice 0 wires a small set of
//! pure read commands (no `AppHandle`/`State` needed) to prove the model; the
//! generic dispatcher that carries the real `AppHandle`/managed `State` and
//! covers the full 48-command frontend surface lands in a later slice.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;

/// Dispatch a single RPC call. `args` is the parsed JSON request body (or
/// `Value::Null` when there is no body).
pub async fn dispatch(cmd: &str, _args: Value) -> Result<Value> {
    match cmd {
        "list_workspace_groups" => json(run(crate::workspaces::list_workspace_groups).await?),
        "list_repositories" => json(run(crate::repos::list_repositories).await?),
        "get_data_info" => json(run(crate::service::get_data_info).await?),
        other => Err(anyhow!("Unknown companion command: {other}")),
    }
}

/// Run a blocking domain function on the blocking pool, flattening the join
/// error into the anyhow result.
async fn run<F, T>(f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| anyhow!("companion rpc join failed: {e}"))?
}

/// Serialize a domain value into the JSON envelope returned to the client.
fn json<T: Serialize>(value: T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}
