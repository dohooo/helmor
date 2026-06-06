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

use super::server::{EventStreamStarter, SseFrame, StreamStarter};
use crate::agents::{self, AgentSendRequest, AgentStreamEvent, SessionStreamHub};
use crate::error::CommandError;
use crate::sidecar::ManagedSidecar;
use crate::ui_sync::{UiMutationEvent, UiSyncManager};

/// Build the stream starter bound to the concrete Tauri app. Dispatches by
/// command name so the server holds a single type-erased entry point.
pub fn build_stream_starter(app: tauri::AppHandle) -> StreamStarter {
    Arc::new(
        move |command: &str, args: Value, tx: UnboundedSender<String>| match command {
            "send_agent_message_stream" => start_agent_stream(&app, args, tx),
            "subscribe_ui_mutations" => start_ui_subscription(&app, args, tx),
            "subscribe_session_stream" => start_session_stream_subscription(&app, args, tx),
            other => Err(CommandError::from(anyhow::anyhow!(
                "No companion stream for command: {other}"
            ))),
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

/// A Tauri `Channel<T>` whose every message is forwarded as one [`SseFrame`]
/// tagged with `event`. Same bridge as [`ndjson_channel`], formatted for SSE:
/// the serialized event becomes the frame's `data:` line (compact, single-line
/// JSON — no embedded newlines, so it survives the client's SSE parser).
fn sse_channel<T>(event: &'static str, tx: UnboundedSender<SseFrame>) -> Channel<T> {
    Channel::new(move |body: InvokeResponseBody| {
        let data = match body {
            InvokeResponseBody::Json(json) => json,
            InvokeResponseBody::Raw(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        };
        // Receiver gone (client disconnected) just drops the frame.
        let _ = tx.send(SseFrame { event, data });
        Ok(())
    })
}

fn start_agent_stream(
    app: &tauri::AppHandle,
    args: Value,
    tx: UnboundedSender<String>,
) -> Result<(), CommandError> {
    // `api.ts` sends `{ request, onEvent }`; the shim strips the channel,
    // leaving `{ request }`. Accept either the wrapped or bare object.
    let request_value = args.get("request").cloned().unwrap_or(args);
    let request: AgentSendRequest = serde_json::from_value(request_value)
        .map_err(|e| CommandError::from(anyhow::anyhow!("Invalid send request: {e}")))?;

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

/// Build the event-stream starter bound to the concrete app. For each
/// `/v1/stream` connection it subscribes an SSE-formatting `Channel` to
/// `UiSyncManager` (always) and, when `watch` is set, `SessionStreamHub`
/// (`subscribe` replays the last render event so a reconnect mid-turn catches up
/// immediately). Teardown mirrors [`start_ui_subscription`]: when the response
/// body — and thus the receiver — is dropped, `tx.closed()` resolves and both
/// subscriptions are released. Reuses the same shared managers as the desktop
/// paths; no manager changes.
pub fn build_event_stream_starter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> EventStreamStarter {
    Arc::new(
        move |tx: UnboundedSender<SseFrame>, watch: Option<String>| {
            let ui_sub_id = uuid::Uuid::new_v4().to_string();
            let ui_channel = sse_channel::<UiMutationEvent>("ui-mutation", tx.clone());
            app.state::<UiSyncManager>()
                .subscribe(ui_sub_id.clone(), ui_channel);

            let session_sub = watch.map(|session_id| {
                let sub_id = uuid::Uuid::new_v4().to_string();
                let channel = sse_channel::<AgentStreamEvent>("session", tx.clone());
                app.state::<SessionStreamHub>().subscribe(
                    session_id.clone(),
                    sub_id.clone(),
                    channel,
                );
                (session_id, sub_id)
            });

            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tx.closed().await;
                app.state::<UiSyncManager>().unsubscribe(&ui_sub_id);
                if let Some((session_id, sub_id)) = session_sub {
                    app.state::<SessionStreamHub>()
                        .unsubscribe(&session_id, &sub_id);
                }
            });
        },
    )
}
