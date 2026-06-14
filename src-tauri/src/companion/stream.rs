//! Streaming bridges for the companion server.
//!
//! Two desktop streaming paths are `AppHandle<Wry>`-specific and Channel-based:
//! agent output (`send_agent_message_stream`) and live UI mutations
//! (`subscribe_ui_mutations`). We construct a Tauri `Channel` with a custom
//! handler (`Channel::new(handler)`) that forwards each serialized event as one
//! NDJSON line into the HTTP response — reusing the desktop paths verbatim
//! (same shared `ManagedSidecar` / `UiSyncManager`). The result is type-erased
//! into [`StreamStarter`] so the runtime-generic server never names a runtime.

use std::sync::Arc;

use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;
use tokio::sync::mpsc::UnboundedSender;

use super::server::StreamStarter;
use crate::agents::{self, AgentSendRequest, AgentStreamEvent, SessionStreamHub};
use crate::error::CommandError;
use crate::sidecar::ManagedSidecar;
use crate::ui_sync::{UiMutationEvent, UiSyncManager};

/// Build the stream starter bound to the concrete Tauri app. Dispatches by
/// command name so the server holds a single type-erased entry point.
pub fn build_stream_starter(app: tauri::AppHandle) -> StreamStarter {
    Arc::new(
        move |command: &str,
              args: Value,
              author_id: Option<String>,
              tx: UnboundedSender<String>| {
            match command {
                "send_agent_message_stream" => start_agent_stream(&app, args, author_id, tx),
                "subscribe_ui_mutations" => start_ui_subscription(&app, args, tx),
                "subscribe_session_stream" => start_session_stream_subscription(&app, args, tx),
                other => Err(CommandError::from(anyhow::anyhow!(
                    "No companion stream for command: {other}"
                ))),
            }
        },
    )
}

/// A Tauri `Channel<T>` whose every message is forwarded as one NDJSON line.
fn ndjson_channel<T>(tx: UnboundedSender<String>) -> Channel<T> {
    Channel::new(move |body: InvokeResponseBody| {
        let line = match body {
            InvokeResponseBody::Json(json) => json,
            InvokeResponseBody::Raw(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        };
        // Receiver gone (client disconnected) just drops the line.
        let _ = tx.send(line);
        Ok(())
    })
}

/// Deserialize the agent-send request and stamp the SERVER-DERIVED `author_id`
/// onto it, OVERWRITING any body-supplied `authorId` so a client can never
/// assert another member's identity (the hard "never client-asserted" rule).
/// Absent header ⇒ `author_id` is `None` ⇒ no author persisted (the
/// local/desktop path). `api.ts` sends `{ request, onEvent }`; the shim strips
/// the channel, leaving `{ request }` — accept either the wrapped or bare object.
fn resolve_request(
    args: Value,
    author_id: Option<String>,
) -> Result<AgentSendRequest, CommandError> {
    let request_value = args.get("request").cloned().unwrap_or(args);
    let mut request: AgentSendRequest = serde_json::from_value(request_value)
        .map_err(|e| CommandError::from(anyhow::anyhow!("Invalid send request: {e}")))?;
    request.author_id = author_id;
    Ok(request)
}

fn start_agent_stream(
    app: &tauri::AppHandle,
    args: Value,
    author_id: Option<String>,
    tx: UnboundedSender<String>,
) -> Result<(), CommandError> {
    let request = resolve_request(args, author_id)?;

    let channel = ndjson_channel::<AgentStreamEvent>(tx);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let sidecar = app.state::<ManagedSidecar>();
        if let Err(error) =
            agents::send_agent_message_stream(app.clone(), sidecar, request, channel).await
        {
            tracing::warn!(error = %format!("{error:?}"), "companion agent stream failed");
        }
    });
    Ok(())
}

fn start_ui_subscription(
    app: &tauri::AppHandle,
    args: Value,
    tx: UnboundedSender<String>,
) -> Result<(), CommandError> {
    let subscription_id = args
        .get("subscriptionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CommandError::from(anyhow::anyhow!("Missing subscriptionId")))?;

    let channel = ndjson_channel::<UiMutationEvent>(tx.clone());
    app.state::<UiSyncManager>()
        .subscribe(subscription_id.clone(), channel);

    // Auto-unsubscribe when the client disconnects (the response body, and thus
    // the receiver, is dropped) — no leaked subscriptions.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tx.closed().await;
        app.state::<UiSyncManager>().unsubscribe(&subscription_id);
    });
    Ok(())
}

/// Bridge `subscribe_session_stream` (a watcher attaching to another client's
/// in-flight turn) onto the companion HTTP/NDJSON transport, reusing the same
/// shared `SessionStreamHub`. Mirrors `start_ui_subscription`'s lifecycle: the
/// SSE/NDJSON body drop auto-detaches the watcher.
fn start_session_stream_subscription(
    app: &tauri::AppHandle,
    args: Value,
    tx: UnboundedSender<String>,
) -> Result<(), CommandError> {
    let session_id = args
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CommandError::from(anyhow::anyhow!("Missing sessionId")))?;
    let subscription_id = args
        .get("subscriptionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CommandError::from(anyhow::anyhow!("Missing subscriptionId")))?;

    let channel = ndjson_channel::<AgentStreamEvent>(tx.clone());
    app.state::<SessionStreamHub>()
        .subscribe(session_id.clone(), subscription_id.clone(), channel);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tx.closed().await;
        app.state::<SessionStreamHub>()
            .unsubscribe(&session_id, &subscription_id);
    });
    Ok(())
}

#[cfg(test)]
mod resolve_request_tests {
    use super::resolve_request;
    use serde_json::json;

    fn body(author: Option<&str>) -> serde_json::Value {
        let mut req = json!({ "provider": "codex", "modelId": "gpt-5.5", "prompt": "hi" });
        if let Some(a) = author {
            req["authorId"] = json!(a);
        }
        json!({ "request": req })
    }

    #[test]
    fn trusted_header_overwrites_body_author_id() {
        // Client forges authorId in the body; the server-derived header wins.
        let request =
            resolve_request(body(Some("evil-client-id")), Some("trusted-7".to_string())).unwrap();
        assert_eq!(request.author_id.as_deref(), Some("trusted-7"));
    }

    #[test]
    fn absent_header_drops_body_author_id_to_none() {
        // No trusted header ⇒ a body-supplied authorId must NOT survive.
        let request = resolve_request(body(Some("evil-client-id")), None).unwrap();
        assert_eq!(request.author_id, None);
    }

    #[test]
    fn header_sets_author_when_body_omits_it() {
        let request = resolve_request(body(None), Some("member-1".to_string())).unwrap();
        assert_eq!(request.author_id.as_deref(), Some("member-1"));
    }
}
