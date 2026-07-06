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
use crate::agents::{
    self, AgentSendRequest, AgentStreamEvent, RoomChatSendRequest, SessionStreamHub,
};
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
                "post_room_chat_message" => start_room_chat(&app, args, author_id, tx),
                "subscribe_ui_mutations" => start_ui_subscription(&app, args, tx),
                "subscribe_session_stream" => start_session_stream_subscription(&app, args, tx),
                other => Err(CommandError::from(anyhow::anyhow!(
                    "No companion stream for command: {other}"
                ))),
            }
        },
    )
}

/// DF-4: run a turn/post command and surface a failure as a TYPED terminal
/// error event on the NDJSON body — never a silent 200 empty stream.
///
/// The dispatched commands (`send_agent_message_stream`,
/// `post_room_chat_message`) return `Err` from ENTRY validation (empty
/// prompt, provider/model mismatch, workingDirectory resolution, non-UUID
/// `clientMessageId` — R2-F2) before any stream event is emitted. On the
/// desktop these surface through the invoke rejection; on the companion
/// transport the response headers (200, x-ndjson) have already left, so the
/// WP2 "a failed stream must carry a terminal error event" contract requires
/// the error to travel IN-BAND. `persisted: false` (nothing was written) and
/// `internal: false` (entry validation is actionable, show the message).
async fn run_and_surface<F>(tx: UnboundedSender<String>, label: &'static str, command: F)
where
    F: std::future::Future<Output = Result<(), CommandError>>,
{
    let Err(error) = command.await else { return };
    tracing::warn!(error = %format!("{error:?}"), "companion {label} failed");
    let event = AgentStreamEvent::Error {
        message: format!("{error:?}"),
        persisted: false,
        internal: false,
    };
    match serde_json::to_string(&event) {
        Ok(line) => {
            // Receiver gone (client disconnected) just drops the line.
            let _ = tx.send(line);
        }
        Err(serialize_error) => {
            tracing::error!(error = %serialize_error, "failed to serialize terminal error event");
        }
    }
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

/// Deserialize the room-chat request and stamp the SERVER-DERIVED `author_id`
/// exactly like `resolve_request` does for agent streams.
fn resolve_room_chat_request(
    args: Value,
    author_id: Option<String>,
) -> Result<RoomChatSendRequest, CommandError> {
    let request_value = args.get("request").cloned().unwrap_or(args);
    let mut request: RoomChatSendRequest = serde_json::from_value(request_value)
        .map_err(|e| CommandError::from(anyhow::anyhow!("Invalid room-chat request: {e}")))?;
    // Overwrite any client-supplied authorId with the trusted header value —
    // the hard "never client-asserted" rule.
    request.author_id = author_id;
    Ok(request)
}

fn start_room_chat(
    app: &tauri::AppHandle,
    args: Value,
    author_id: Option<String>,
    tx: UnboundedSender<String>,
) -> Result<(), CommandError> {
    let request = resolve_room_chat_request(args, author_id)?;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Keep the channel alive for the full task duration so `tx` is not
        // dropped early (the server's cleanup waits on tx.closed()). Room-chat
        // itself doesn't stream events over this channel — the Update goes to
        // the hub — but dropping _channel before the task completes would close
        // tx and signal the HTTP response body as finished prematurely.
        let _channel = ndjson_channel::<AgentStreamEvent>(tx.clone());
        let app_for_command = app.clone();
        run_and_surface(tx, "room-chat", async move {
            let hub = app_for_command.state::<SessionStreamHub>();
            agents::post_room_chat_message(app_for_command.clone(), request, hub).await
        })
        .await;
    });
    Ok(())
}

fn start_agent_stream(
    app: &tauri::AppHandle,
    args: Value,
    author_id: Option<String>,
    tx: UnboundedSender<String>,
) -> Result<(), CommandError> {
    let request = resolve_request(args, author_id)?;

    let channel = ndjson_channel::<AgentStreamEvent>(tx.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_for_command = app.clone();
        run_and_surface(tx, "agent stream", async move {
            let sidecar = app_for_command.state::<ManagedSidecar>();
            agents::send_agent_message_stream(app_for_command.clone(), sidecar, request, channel)
                .await
        })
        .await;
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
mod run_and_surface_tests {
    use super::run_and_surface;
    use crate::error::CommandError;

    /// DF-4 anchor: a command failure becomes exactly ONE typed terminal
    /// error line on the NDJSON body — the WP2 contract at the entry layer.
    /// The entry validations themselves are unit-anchored at their sources
    /// (non-UUID clientMessageId in `agents::tests` for R2-F2,
    /// workingDirectory resolution in `agents::support::tests`).
    #[tokio::test]
    async fn err_command_emits_exactly_one_typed_terminal_error_line() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        run_and_surface(tx, "agent stream", async {
            Err(CommandError::from(anyhow::anyhow!(
                "workingDirectory is required but was not provided"
            )))
        })
        .await;

        let line = rx.try_recv().expect("terminal error line must be emitted");
        let event: serde_json::Value = serde_json::from_str(&line).expect("line is one JSON event");
        assert_eq!(event["kind"], "error");
        assert_eq!(event["persisted"], false);
        assert_eq!(event["internal"], false);
        assert!(
            event["message"]
                .as_str()
                .unwrap()
                .contains("workingDirectory is required"),
            "error event must name the cause, got {event}"
        );
        // Exactly one line, then the channel closes (tx dropped) → body EOF.
        assert!(
            rx.try_recv().is_err(),
            "no extra lines after the terminal error"
        );
    }

    #[tokio::test]
    async fn ok_command_emits_nothing() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        run_and_surface(tx, "room-chat", async { Ok(()) }).await;
        assert!(rx.try_recv().is_err(), "success path adds no lines");
    }
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

#[cfg(test)]
mod resolve_room_chat_request_tests {
    use super::resolve_room_chat_request;
    use serde_json::json;

    fn body(author: Option<&str>) -> serde_json::Value {
        let mut req = json!({ "helmorSessionId": "sess-abc", "prompt": "hello room" });
        if let Some(a) = author {
            req["authorId"] = json!(a);
        }
        json!({ "request": req })
    }

    #[test]
    fn trusted_header_overwrites_body_author_id() {
        // Client forges authorId in the body; the server-derived header wins.
        let request =
            resolve_room_chat_request(body(Some("evil-client-id")), Some("trusted-7".to_string()))
                .unwrap();
        assert_eq!(request.author_id.as_deref(), Some("trusted-7"));
    }

    #[test]
    fn absent_header_drops_body_author_id_to_none() {
        // No trusted header ⇒ a body-supplied authorId must NOT survive.
        let request = resolve_room_chat_request(body(Some("evil-client-id")), None).unwrap();
        assert_eq!(request.author_id, None);
    }

    #[test]
    fn header_sets_author_when_body_omits_it() {
        let request = resolve_room_chat_request(body(None), Some("member-1".to_string())).unwrap();
        assert_eq!(request.author_id.as_deref(), Some("member-1"));
    }

    #[test]
    fn preserves_client_message_id_for_room_chat_reconciliation() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        let request = resolve_room_chat_request(
            json!({
                "request": {
                    "helmorSessionId": "sess-abc",
                    "clientMessageId": id,
                    "prompt": "hello room",
                    "authorId": "evil-client-id"
                }
            }),
            Some("trusted-7".to_string()),
        )
        .unwrap();

        assert_eq!(request.client_message_id.as_deref(), Some(id));
        assert_eq!(request.author_id.as_deref(), Some("trusted-7"));
    }
}
