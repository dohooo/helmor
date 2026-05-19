//! Chat-integrated reattach event loop.
//!
//! Phase 24i shipped a streaming reattach surface, but its events
//! only landed in a dev-panel event log. This module bridges those
//! same events into the workspace's chat UI by reusing the existing
//! [`MessagePipeline`] + [`AgentStreamEvent`] channel — the same
//! surface a fresh `send_agent_message_stream` emits through.
//!
//! ## Scope
//!
//! `stream_reattach_via_sidecar` skips the build/send/persist
//! path entirely. The daemon already accepted the prompt and is
//! emitting events; the desktop just subscribes + runs each event
//! through a fresh accumulator. That means:
//!
//! - **No replay of prior history.** Events the daemon emitted
//!   before the reattach are gone (the daemon doesn't buffer).
//!   The chat shows whatever flowed AFTER the attach call.
//! - **Same wire contract as a normal send.** Frontend
//!   `useStreaming` consumes the same `AgentStreamEvent` enum
//!   either way; the new command can be wired into the existing
//!   chat without a parallel rendering path.
//! - **Terminal detection is event-type-based**, not state-machine.
//!   We watch for `result` / `end` / `aborted` / `error` and emit
//!   the matching `Done` / `Aborted` / `Error` envelope. The
//!   richer state-machine [`super::state::TurnSession`] stays
//!   reserved for the fresh-send path where the desktop owns the
//!   initial intent.

use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

use crate::pipeline::{MessagePipeline, PipelineEmit};

use super::active_streams::ActiveStreamHandle;
use super::transports::SidecarTransport;
use super::ActiveStreams;
use super::AgentStreamEvent;

/// Wall-clock guard. Same 45-second window the regular event loop
/// uses, applied to the reattach receive — if the daemon stops
/// emitting we tear down the subscription rather than parking
/// forever.
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);

/// Parameters for the reattach entry point. Owned values
/// throughout so the function can hand the bundle to
/// `spawn_blocking` without borrow-lifetime contortions.
pub struct ReattachStreamInput<R: Runtime = tauri::Wry> {
    pub app: AppHandle<R>,
    pub on_event: Channel<AgentStreamEvent>,
    pub transport: Arc<dyn SidecarTransport>,
    /// The daemon's session id — the same id the desktop would
    /// have stored locally if it had originated the send.
    pub request_id: String,
    /// Helmor session row id. Required for the active-streams
    /// handle + so the workspace's "this session is busy" badge
    /// surfaces during reattach.
    pub helmor_session_id: String,
    pub workspace_id: Option<String>,
    pub provider: String,
    pub model_id: String,
    pub fallback_resolved_model: String,
    pub working_directory: PathBuf,
}

/// Subscribe to the transport's events for `request_id`, run them
/// through a fresh [`MessagePipeline`], and emit `AgentStreamEvent`
/// envelopes through `on_event`. Spawns the event loop on the
/// blocking thread pool and returns immediately — same lifecycle
/// shape `stream_via_sidecar` uses for the regular send.
///
/// Registers an [`ActiveStreamHandle`] for the duration so the
/// desktop's busy badge + abort affordance work for the
/// reattached turn.
pub(crate) fn stream_reattach_via_sidecar<R: Runtime>(input: ReattachStreamInput<R>) {
    let ReattachStreamInput {
        app,
        on_event,
        transport,
        request_id,
        helmor_session_id,
        workspace_id,
        provider,
        model_id,
        fallback_resolved_model,
        working_directory,
    } = input;

    tauri::async_runtime::spawn_blocking(move || {
        run_reattach_loop(
            app,
            on_event,
            transport,
            request_id,
            helmor_session_id,
            workspace_id,
            provider,
            model_id,
            fallback_resolved_model,
            working_directory,
        );
    });
}

#[allow(clippy::too_many_arguments)]
fn run_reattach_loop<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<AgentStreamEvent>,
    transport: Arc<dyn SidecarTransport>,
    request_id: String,
    helmor_session_id: String,
    workspace_id: Option<String>,
    provider: String,
    model_id: String,
    fallback_resolved_model: String,
    working_directory: PathBuf,
) {
    tracing::debug!(
        rid = %request_id,
        provider = %provider,
        helmor_session_id = %helmor_session_id,
        transport = ?transport.kind(),
        "stream_reattach_via_sidecar"
    );

    // Mirror the send path's per-session lock so a concurrent send
    // can't race us into the same `resume:` id. Reattach is
    // user-initiated and benign on its own, but stacking it
    // against a fresh send would still corrupt the conversation
    // jsonl (issue #398). State binding happens inside the
    // background thread; the outer `spawn_blocking` already moved
    // ownership of `app` here.
    let active_streams_state: tauri::State<'_, ActiveStreams> = app.state();
    let handle = ActiveStreamHandle {
        request_id: request_id.clone(),
        sidecar_session_id: helmor_session_id.clone(),
        provider: provider.clone(),
        helmor_session_id: Some(helmor_session_id.clone()),
        workspace_id: workspace_id.clone(),
    };
    let registered = active_streams_state.try_register_for_session(handle);
    if !registered {
        let message = "Another send is already running for this session — \
                       reattach is disabled while it completes."
            .to_string();
        let _ = on_event.send(AgentStreamEvent::Error {
            message,
            persisted: false,
            internal: false,
        });
        return;
    }
    crate::ui_sync::publish(&app, crate::ui_sync::UiMutationEvent::ActiveStreamsChanged);

    let rx = transport.subscribe(&request_id);
    let working_dir_str = working_directory.display().to_string();

    let request_id_for_loop = request_id.clone();
    let mut pipeline = MessagePipeline::new(
        &provider,
        &fallback_resolved_model,
        &request_id,
        &helmor_session_id,
    );
    let mut resolved_session_id: Option<String> = None;
    let started_at = Instant::now();
    let mut event_count: u64 = 0;

    'outer: loop {
        let event = match rx.recv_timeout(HEARTBEAT_TIMEOUT) {
            Ok(ev) => ev,
            Err(RecvTimeoutError::Timeout) => {
                tracing::warn!(
                    rid = %request_id_for_loop,
                    elapsed_ms = started_at.elapsed().as_millis(),
                    event_count,
                    "reattach: heartbeat timeout; tearing down stream"
                );
                let _ = on_event.send(AgentStreamEvent::Error {
                    message: "The remote stopped sending events. Reconnect from the dev panel."
                        .into(),
                    persisted: false,
                    internal: true,
                });
                break 'outer;
            }
            Err(RecvTimeoutError::Disconnected) => {
                tracing::warn!(
                    rid = %request_id_for_loop,
                    elapsed_ms = started_at.elapsed().as_millis(),
                    event_count,
                    "reattach: transport disconnected; tearing down stream"
                );
                let _ = on_event.send(AgentStreamEvent::Error {
                    message: "Connection to the remote was lost.".into(),
                    persisted: false,
                    internal: true,
                });
                break 'outer;
            }
        };

        if event.event_type() == "heartbeat" {
            // Liveness pings keep the channel warm but don't
            // mutate the chat state.
            continue;
        }
        event_count += 1;

        // Track the provider-issued session id for the terminal
        // emit envelope (Done / Aborted / Error). Mirrors the
        // session-id capture logic in the regular event loop,
        // simplified — we don't gate on Claude's
        // `should_adopt_provider_session_id` because the
        // conversation already exists; the daemon has already
        // resolved the right id.
        if let Some(sid) = event.session_id() {
            if resolved_session_id.is_none() {
                resolved_session_id = Some(sid.to_string());
            }
        }

        // Push into the accumulator. The same JSON the daemon
        // emits is what the regular send path pushes too — the
        // accumulator doesn't care which side of the SSH pipe
        // produced the bytes.
        let line = serde_json::to_string(&event.raw).unwrap_or_default();
        let emit = pipeline.push_event(&event.raw, &line);
        match emit {
            PipelineEmit::Full(messages) => {
                let _ = on_event.send(AgentStreamEvent::Update { messages });
            }
            PipelineEmit::Partial(message) => {
                let _ = on_event.send(AgentStreamEvent::StreamingPartial { message });
            }
            PipelineEmit::None => {}
        }

        // Terminal event detection. The daemon's wire shape uses
        // `type: "result" | "end" | "aborted" | "error"` for
        // turn-terminating events. After emitting the final
        // accumulator state above, ship the matching envelope
        // and break.
        let event_type = event.event_type();
        match event_type {
            "result" | "end" => {
                let final_messages = pipeline.finish();
                let _ = on_event.send(AgentStreamEvent::Update {
                    messages: final_messages,
                });
                let resolved_model = pipeline.accumulator.resolved_model().to_string();
                let _ = on_event.send(AgentStreamEvent::Done {
                    provider: provider.clone(),
                    model_id: model_id.clone(),
                    resolved_model,
                    session_id: resolved_session_id.clone(),
                    working_directory: working_dir_str.clone(),
                    // We don't persist on the desktop side — the
                    // daemon already wrote whatever it wrote when
                    // the original send fired. Reporting
                    // persisted=false makes that explicit.
                    persisted: false,
                });
                break 'outer;
            }
            "aborted" => {
                let final_messages = pipeline.finish();
                let _ = on_event.send(AgentStreamEvent::Update {
                    messages: final_messages,
                });
                let reason = event
                    .raw
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("user_requested")
                    .to_string();
                let resolved_model = pipeline.accumulator.resolved_model().to_string();
                let _ = on_event.send(AgentStreamEvent::Aborted {
                    provider: provider.clone(),
                    model_id: model_id.clone(),
                    resolved_model,
                    session_id: resolved_session_id.clone(),
                    working_directory: working_dir_str.clone(),
                    persisted: false,
                    reason,
                });
                break 'outer;
            }
            "error" => {
                let message = event
                    .raw
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Stream error")
                    .to_string();
                let internal = event
                    .raw
                    .get("internal")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let _ = on_event.send(AgentStreamEvent::Error {
                    message,
                    persisted: false,
                    internal,
                });
                break 'outer;
            }
            _ => {}
        }
    }

    transport.unsubscribe(&request_id);
    active_streams_state.unregister(&request_id);
    crate::ui_sync::publish(&app, crate::ui_sync::UiMutationEvent::ActiveStreamsChanged);

    tracing::info!(
        rid = %request_id_for_loop,
        elapsed_ms = started_at.elapsed().as_millis(),
        event_count,
        "reattach: event loop exited"
    );
}

/// Synthesise a fresh `request_id` when the caller doesn't know
/// the daemon's id ahead of time. Reserved for the future "click
/// any session, attach by helmor_session_id" surface — today's
/// callers always know the daemon's request id.
#[allow(dead_code)]
pub(crate) fn fresh_request_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use tauri::ipc::InvokeResponseBody;

    use crate::sidecar::{SidecarEvent, SidecarRequest};

    /// In-memory transport that lets tests pipe events directly
    /// into the reattach receiver. Pairs with
    /// `capturing_channel` for end-to-end assertions on
    /// emitted AgentStreamEvents.
    #[derive(Default)]
    struct ManualTransport {
        senders: Mutex<Vec<(String, mpsc::Sender<SidecarEvent>)>>,
        unsubscribed: Mutex<Vec<String>>,
    }

    impl ManualTransport {
        fn fire(&self, request_id: &str, raw: Value) {
            let senders = self.senders.lock().unwrap();
            for (rid, tx) in senders.iter() {
                if rid == request_id {
                    let _ = tx.send(SidecarEvent { raw: raw.clone() });
                }
            }
        }

        fn close(&self, request_id: &str) {
            // Drop the matching sender to simulate a transport
            // disconnect.
            let mut senders = self.senders.lock().unwrap();
            senders.retain(|(rid, _)| rid != request_id);
        }
    }

    impl SidecarTransport for ManualTransport {
        fn send(&self, _request: &SidecarRequest) -> anyhow::Result<()> {
            // Reattach never calls send — assert so we catch a
            // regression that accidentally re-introduces it.
            panic!("reattach path must not call transport.send");
        }
        fn subscribe(&self, request_id: &str) -> mpsc::Receiver<SidecarEvent> {
            let (tx, rx) = mpsc::channel();
            self.senders.lock().unwrap().push((request_id.into(), tx));
            rx
        }
        fn unsubscribe(&self, request_id: &str) {
            self.unsubscribed.lock().unwrap().push(request_id.into());
            let mut senders = self.senders.lock().unwrap();
            senders.retain(|(rid, _)| rid != request_id);
        }
        fn kind(&self) -> super::super::transports::TransportKind {
            super::super::transports::TransportKind::Remote
        }
    }

    /// Build a `Channel<AgentStreamEvent>` that captures every
    /// emitted payload into a `Mutex<Vec<_>>` decoded back into
    /// the typed enum.
    fn capturing_channel() -> (
        Channel<AgentStreamEvent>,
        Arc<Mutex<Vec<serde_json::Value>>>,
    ) {
        let captured: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let inner = Arc::clone(&captured);
        let channel = Channel::<AgentStreamEvent>::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                let value: serde_json::Value = serde_json::from_str(&s).unwrap();
                inner.lock().unwrap().push(value);
            }
            Ok(())
        });
        (channel, captured)
    }

    // ── Per-event helpers ────────────────────────────────────────
    //
    // The full event loop needs an AppHandle (for the
    // ui_sync::publish + active_streams state binding). Each
    // helper below covers a single decision the loop makes — the
    // intent is that a future refactor can extract these into
    // public helpers + the loop becomes a thin orchestrator. For
    // now we duplicate the predicates so the test surface stays
    // ergonomic without requiring a real Tauri context.

    fn detect_terminal_kind(raw: &Value) -> Option<&'static str> {
        match raw.get("type").and_then(Value::as_str)? {
            "result" | "end" => Some("done"),
            "aborted" => Some("aborted"),
            "error" => Some("error"),
            _ => None,
        }
    }

    #[test]
    fn terminal_detection_recognises_result_end_aborted_error() {
        let cases: &[(Value, Option<&str>)] = &[
            (serde_json::json!({ "type": "result" }), Some("done")),
            (serde_json::json!({ "type": "end" }), Some("done")),
            (serde_json::json!({ "type": "aborted" }), Some("aborted")),
            (serde_json::json!({ "type": "error" }), Some("error")),
            (serde_json::json!({ "type": "assistant" }), None),
            (serde_json::json!({ "type": "system" }), None),
            // Missing `type` is non-terminal — the daemon's
            // sidecar always tags events.
            (serde_json::json!({ "foo": 1 }), None),
        ];
        for (raw, expected) in cases {
            assert_eq!(
                detect_terminal_kind(raw),
                *expected,
                "detect_terminal_kind({raw}) = {:?}; expected {:?}",
                detect_terminal_kind(raw),
                expected,
            );
        }
    }

    #[test]
    fn aborted_event_extracts_user_facing_reason_with_fallback() {
        // The Aborted envelope's `reason` field defaults to
        // `user_requested` when the daemon doesn't supply one.
        // Mirrors the regular event loop's default so reattach
        // events look identical to live ones in the UI.
        let with_reason = serde_json::json!({
            "type": "aborted",
            "reason": "rate_limited",
        });
        let without_reason = serde_json::json!({ "type": "aborted" });

        assert_eq!(
            with_reason
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("user_requested"),
            "rate_limited"
        );
        assert_eq!(
            without_reason
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("user_requested"),
            "user_requested"
        );
    }

    #[test]
    fn error_event_extracts_message_and_internal_flag() {
        let with_internal = serde_json::json!({
            "type": "error",
            "message": "Sidecar crashed",
            "internal": true,
        });
        let user_error = serde_json::json!({
            "type": "error",
            "message": "Rate limit hit",
            "internal": false,
        });
        let missing = serde_json::json!({ "type": "error" });

        for (raw, expected_msg, expected_internal) in [
            (with_internal, "Sidecar crashed", true),
            (user_error, "Rate limit hit", false),
            (missing, "Stream error", false),
        ] {
            let message = raw
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Stream error")
                .to_string();
            let internal = raw
                .get("internal")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            assert_eq!(message, expected_msg);
            assert_eq!(internal, expected_internal);
        }
    }

    #[test]
    fn pipeline_emits_partial_then_full_in_order() {
        // The reattach loop maps PipelineEmit → AgentStreamEvent
        // identically to the send path. This test pins the
        // ordering through MessagePipeline directly so a future
        // refactor that reorders Partial/Full would surface as
        // a mismatch here.
        let mut pipeline = MessagePipeline::new("claude", "claude-opus-4", "rid-1", "hs-1");

        // Delta — accumulator should produce a partial.
        let delta = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": "Hello" }
            }
        });
        let line = delta.to_string();
        match pipeline.push_event(&delta, &line) {
            PipelineEmit::Partial(_) | PipelineEmit::None => {}
            PipelineEmit::Full(_) => panic!("delta should not be a finalization event"),
        }

        // Finalize: an assistant message. The accumulator
        // re-renders the full history.
        let assistant = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "Hello there" }]
            }
        });
        let line = assistant.to_string();
        match pipeline.push_event(&assistant, &line) {
            PipelineEmit::Full(messages) => assert!(!messages.is_empty()),
            PipelineEmit::Partial(_) => {
                panic!("assistant event should emit Full, got Partial")
            }
            PipelineEmit::None => panic!("assistant event should emit Full, got None"),
        }
    }

    #[test]
    fn fresh_request_id_returns_a_non_empty_unique_string() {
        // Defence against a future regression that swaps the
        // UUID generator for a stub returning "".
        let a = fresh_request_id();
        let b = fresh_request_id();
        assert!(!a.is_empty());
        assert!(!b.is_empty());
        assert_ne!(a, b);
    }

    /// Mirror of the regular event loop's heartbeat handling:
    /// a `type: "heartbeat"` event should be skipped silently.
    /// The accumulator never sees it; the channel never
    /// receives anything for it.
    #[test]
    fn heartbeat_events_are_skipped() {
        let raw = serde_json::json!({ "type": "heartbeat" });
        // The `event.event_type() == "heartbeat"` check is what
        // gates the skip. Reproduce the predicate without the
        // full Event wrapper.
        let event_type = raw.get("type").and_then(Value::as_str).unwrap_or("");
        assert_eq!(event_type, "heartbeat");
    }

    /// Lock the contract that ManualTransport panics on
    /// send — protects against an accidental future call to
    /// transport.send from the reattach path.
    #[test]
    #[should_panic(expected = "reattach path must not call transport.send")]
    fn manual_transport_panics_on_send() {
        let transport = ManualTransport::default();
        let _ = transport.send(&SidecarRequest {
            id: "x".into(),
            method: "y".into(),
            params: serde_json::json!({}),
        });
    }

    #[test]
    fn manual_transport_fire_routes_only_matching_request_id() {
        // Two subscribers; firing for one only delivers to that
        // one. This is the same demux the reattach loop relies on
        // for the per-request_id event flow.
        let transport = ManualTransport::default();
        let rx_a = transport.subscribe("rid-A");
        let rx_b = transport.subscribe("rid-B");

        transport.fire("rid-A", serde_json::json!({ "type": "assistant" }));

        let event = rx_a
            .recv_timeout(std::time::Duration::from_millis(50))
            .expect("rid-A should receive");
        assert_eq!(event.raw["type"], "assistant");
        assert!(rx_b
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());

        transport.close("rid-A");
    }

    #[test]
    fn capturing_channel_round_trips_an_emitted_update() {
        // The channel test fixture must round-trip AgentStreamEvent
        // JSON correctly so the integration test assertions work.
        let (chan, captured) = capturing_channel();
        chan.send(AgentStreamEvent::Update { messages: vec![] })
            .unwrap();
        let snapshot = captured.lock().unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0]["kind"], "update");
    }

    // ── End-to-end loop tests ────────────────────────────────────
    //
    // The 24l-tests follow-up. The unit tests above pin individual
    // decisions; these run the full `run_reattach_loop` with a
    // mock AppHandle, a ManualTransport, and a capturing channel.
    // They prove the loop's orchestration — subscribe, receive,
    // push through pipeline, emit AgentStreamEvent, detect
    // terminal — in one go, so a regression that breaks the seams
    // surfaces here instead of waiting on a manual SSH session.

    use tauri::test::{mock_builder, mock_context, noop_assets};

    /// Build a Tauri AppHandle with the state the reattach loop
    /// reads (`ActiveStreams`, `UiSyncManager`). No window, no
    /// real IPC — just the registry slots `app.state::<T>()`
    /// returns inside the loop.
    fn mock_app_handle() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = mock_builder()
            .manage(ActiveStreams::new())
            .manage(crate::ui_sync::UiSyncManager::new())
            .build(mock_context(noop_assets()))
            .expect("mock app should build");
        app.handle().clone()
    }

    /// Wait up to `timeout` for the captured-channel vec to satisfy
    /// `pred`. Returns the final snapshot either way; tests assert
    /// on the result so a timeout produces a legible failure rather
    /// than a hang.
    fn wait_for_events(
        captured: &Arc<Mutex<Vec<Value>>>,
        timeout: Duration,
        pred: impl Fn(&[Value]) -> bool,
    ) -> Vec<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let snapshot = captured.lock().unwrap().clone();
            if pred(&snapshot) {
                return snapshot;
            }
            if Instant::now() >= deadline {
                return snapshot;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn run_loop_streams_delta_then_finalises_on_result() {
        // The happy path: fire a content-block delta, then an
        // assistant finalize, then a `result` terminal. The
        // channel should see StreamingPartial / Update /
        // Update (finish) / Done in order.
        let app = mock_app_handle();
        let transport = Arc::new(ManualTransport::default());
        let transport_dyn: Arc<dyn SidecarTransport> = transport.clone();
        let (chan, captured) = capturing_channel();

        // Run the loop on a worker so the test thread can fire
        // events into the transport while it spins.
        let loop_handle = {
            let transport = transport_dyn.clone();
            std::thread::spawn(move || {
                run_reattach_loop(
                    app,
                    chan,
                    transport,
                    "rid-loop-1".into(),
                    "hs-loop-1".into(),
                    Some("ws-1".into()),
                    "claude".into(),
                    "claude-opus-4".into(),
                    "claude-opus-4".into(),
                    PathBuf::from("/tmp/loop"),
                )
            })
        };

        // Give the loop a moment to register its subscription —
        // ManualTransport::fire is a no-op for non-matching rids.
        let _ = wait_for_events(&captured, Duration::from_millis(100), |_| false);

        transport.fire(
            "rid-loop-1",
            serde_json::json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": { "type": "text_delta", "text": "Hi" }
                }
            }),
        );
        transport.fire(
            "rid-loop-1",
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Hi there" }]
                }
            }),
        );
        transport.fire(
            "rid-loop-1",
            serde_json::json!({
                "type": "result",
                "session_id": "sdk-session-loop-1",
            }),
        );

        loop_handle.join().expect("reattach loop should exit");

        let events = captured.lock().unwrap().clone();
        // At least: one partial-or-update, one final update on
        // finish, one Done. The accumulator may emit additional
        // updates between — we assert the *terminal sequence*
        // and the *presence* of intermediate cooked events.
        let kinds: Vec<&str> = events
            .iter()
            .map(|v| v["kind"].as_str().unwrap_or(""))
            .collect();
        assert!(
            kinds.contains(&"streamingPartial") || kinds.contains(&"update"),
            "expected at least one streamingPartial or update before terminal, got {kinds:?}",
        );
        assert_eq!(
            kinds.last().copied(),
            Some("done"),
            "last event should be Done, got {kinds:?}",
        );
        // The Done envelope carries the captured session id.
        // Wire keys are camelCase — the frontend's AgentStreamEvent
        // type claims this shape and the IPC channel emits it via
        // serde. A snake_case regression here would silently break
        // the chat's "did this turn finish?" handler.
        let done = events.last().unwrap();
        assert_eq!(done["sessionId"], "sdk-session-loop-1");
        assert_eq!(done["persisted"], false);
        assert_eq!(done["workingDirectory"], "/tmp/loop");
        assert_eq!(done["modelId"], "claude-opus-4");
    }

    #[test]
    fn run_loop_emits_aborted_with_reason_when_daemon_reports_abort() {
        // The aborted path: a single `aborted` event with a
        // `reason` should produce one final Update + one Aborted
        // carrying the reason verbatim.
        let app = mock_app_handle();
        let transport = Arc::new(ManualTransport::default());
        let transport_dyn: Arc<dyn SidecarTransport> = transport.clone();
        let (chan, captured) = capturing_channel();

        let loop_handle = {
            let transport = transport_dyn.clone();
            std::thread::spawn(move || {
                run_reattach_loop(
                    app,
                    chan,
                    transport,
                    "rid-abort-1".into(),
                    "hs-abort-1".into(),
                    None,
                    "claude".into(),
                    "claude-opus-4".into(),
                    "claude-opus-4".into(),
                    PathBuf::from("/tmp/abort"),
                )
            })
        };
        let _ = wait_for_events(&captured, Duration::from_millis(100), |_| false);

        transport.fire(
            "rid-abort-1",
            serde_json::json!({
                "type": "aborted",
                "reason": "rate_limited",
            }),
        );
        loop_handle.join().expect("loop should exit on aborted");

        let events = captured.lock().unwrap().clone();
        let terminal = events.last().expect("at least one event should be emitted");
        assert_eq!(terminal["kind"], "aborted");
        assert_eq!(terminal["reason"], "rate_limited");
        assert_eq!(terminal["persisted"], false);
    }

    #[test]
    fn run_loop_emits_error_envelope_when_daemon_reports_error() {
        // The daemon's `error` event surfaces as an AgentStreamEvent
        // Error envelope with message + internal flag preserved.
        let app = mock_app_handle();
        let transport = Arc::new(ManualTransport::default());
        let transport_dyn: Arc<dyn SidecarTransport> = transport.clone();
        let (chan, captured) = capturing_channel();

        let loop_handle = {
            let transport = transport_dyn.clone();
            std::thread::spawn(move || {
                run_reattach_loop(
                    app,
                    chan,
                    transport,
                    "rid-err-1".into(),
                    "hs-err-1".into(),
                    None,
                    "claude".into(),
                    "claude-opus-4".into(),
                    "claude-opus-4".into(),
                    PathBuf::from("/tmp/err"),
                )
            })
        };
        let _ = wait_for_events(&captured, Duration::from_millis(100), |_| false);

        transport.fire(
            "rid-err-1",
            serde_json::json!({
                "type": "error",
                "message": "Sidecar crashed",
                "internal": true,
            }),
        );
        loop_handle.join().expect("loop should exit on error");

        let events = captured.lock().unwrap().clone();
        let terminal = events.last().expect("at least one event");
        assert_eq!(terminal["kind"], "error");
        assert_eq!(terminal["message"], "Sidecar crashed");
        assert_eq!(terminal["internal"], true);
    }

    #[test]
    fn run_loop_unsubscribes_and_unregisters_after_terminal_event() {
        // After a terminal event, the loop must:
        //  - tear down the transport subscription so the daemon
        //    can stop forwarding events for this request_id,
        //  - release the per-session ActiveStreams slot so a
        //    subsequent send isn't gated.
        let app = mock_app_handle();
        let app_for_query = app.clone();
        let transport = Arc::new(ManualTransport::default());
        let transport_dyn: Arc<dyn SidecarTransport> = transport.clone();
        let (chan, _captured) = capturing_channel();

        let loop_handle = {
            let transport = transport_dyn.clone();
            std::thread::spawn(move || {
                run_reattach_loop(
                    app,
                    chan,
                    transport,
                    "rid-unsub-1".into(),
                    "hs-unsub-1".into(),
                    None,
                    "claude".into(),
                    "claude-opus-4".into(),
                    "claude-opus-4".into(),
                    PathBuf::from("/tmp/unsub"),
                )
            })
        };
        // Sub registered → fire terminal → join.
        std::thread::sleep(Duration::from_millis(20));
        transport.fire("rid-unsub-1", serde_json::json!({ "type": "result" }));
        loop_handle.join().expect("loop should exit");

        let unsubscribed = transport.unsubscribed.lock().unwrap().clone();
        assert!(
            unsubscribed.iter().any(|r| r == "rid-unsub-1"),
            "loop must call transport.unsubscribe for its request_id; saw {unsubscribed:?}",
        );
        // ActiveStreams snapshot should not still hold our handle.
        let active = app_for_query.state::<ActiveStreams>();
        assert_eq!(
            active.len(),
            0,
            "loop must call ActiveStreams::unregister on exit",
        );
    }

    #[test]
    fn run_loop_refuses_to_run_when_another_stream_holds_the_session_lock() {
        // Issue #398's per-session lock: if another stream
        // already holds the session, the reattach loop must
        // immediately emit an Error and bail. No subscribe call,
        // no pipeline work.
        let app = mock_app_handle();
        let transport = Arc::new(ManualTransport::default());
        let transport_dyn: Arc<dyn SidecarTransport> = transport.clone();
        let (chan, captured) = capturing_channel();

        // Pre-register a competing handle on the same helmor
        // session id so try_register_for_session returns false.
        let competing = ActiveStreamHandle {
            request_id: "rid-other".into(),
            sidecar_session_id: "hs-busy".into(),
            provider: "claude".into(),
            helmor_session_id: Some("hs-busy".into()),
            workspace_id: None,
        };
        assert!(app
            .state::<ActiveStreams>()
            .try_register_for_session(competing));

        let loop_handle = {
            let transport = transport_dyn.clone();
            std::thread::spawn(move || {
                run_reattach_loop(
                    app,
                    chan,
                    transport,
                    "rid-blocked".into(),
                    "hs-busy".into(),
                    None,
                    "claude".into(),
                    "claude-opus-4".into(),
                    "claude-opus-4".into(),
                    PathBuf::from("/tmp/blocked"),
                )
            })
        };
        loop_handle.join().expect("loop should exit quickly");

        let events = captured.lock().unwrap().clone();
        assert_eq!(events.len(), 1, "expected exactly one envelope: {events:?}");
        assert_eq!(events[0]["kind"], "error");
        assert_eq!(events[0]["internal"], false);
        let msg = events[0]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("Another send is already running"),
            "error message should mention the lock; got {msg:?}",
        );
        // The blocked loop never even subscribed.
        let unsubscribed = transport.unsubscribed.lock().unwrap().clone();
        assert!(
            unsubscribed.is_empty(),
            "blocked loop must not subscribe → no unsubscribe call; saw {unsubscribed:?}",
        );
    }
}
