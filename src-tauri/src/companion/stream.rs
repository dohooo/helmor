//! Agent streaming bridge for the companion server.
//!
//! `send_agent_message_stream` is `AppHandle<Wry>`-specific and takes a Tauri
//! `Channel`. We construct a `Channel` with a custom handler (Tauri allows
//! `Channel::new(handler)`) that forwards each serialized event as one NDJSON
//! line into the HTTP response — reusing the desktop streaming path verbatim
//! (same shared `ManagedSidecar`, no second sidecar process). The resulting
//! starter is type-erased into [`AgentStreamer`] so the runtime-generic server
//! never names a Tauri runtime.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;
use tokio::sync::mpsc::UnboundedSender;

use super::server::AgentStreamer;
use crate::agents::{self, AgentSendRequest, AgentStreamEvent};
use crate::error::CommandError;
use crate::sidecar::ManagedSidecar;

/// Build the agent-stream starter bound to the concrete Tauri app.
pub fn build_agent_streamer(app: tauri::AppHandle) -> AgentStreamer {
    Arc::new(move |args: Value, tx: UnboundedSender<String>| {
        // `api.ts` sends `{ request, onEvent }`; the shim strips the channel,
        // leaving `{ request }`. Accept either the wrapped or bare object.
        let request_value = args.get("request").cloned().unwrap_or(args);
        let request: AgentSendRequest = serde_json::from_value(request_value)
            .map_err(|e| CommandError::from(anyhow::anyhow!("Invalid send request: {e}")))?;

        let channel = Channel::<AgentStreamEvent>::new(move |body: InvokeResponseBody| {
            let line = match body {
                InvokeResponseBody::Json(json) => json,
                InvokeResponseBody::Raw(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            };
            // Receiver gone (client disconnected) just drops the line.
            let _ = tx.send(line);
            Ok(())
        });

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let sidecar = app.state::<ManagedSidecar>();
            if let Err(error) =
                agents::send_agent_message_stream(app.clone(), sidecar, request, channel).await
            {
                tracing::warn!(
                    error = %format!("{error:?}"),
                    "companion agent stream failed",
                );
            }
        });
        Ok(())
    })
}
