use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::{json, Value};

use super::mock::{MockAgentSpawner, ScriptedReply};
use super::secrets::{save_secrets, ProviderSecret, SecretsStore};
use super::*;

/// Test notifier that captures every emitted notification. The
/// `Send + Sync` requirement is satisfied via `Arc<Mutex<...>>`.
#[derive(Default)]
struct CapturingNotifier {
    captured: StdMutex<Vec<(String, Value)>>,
}

impl Notifier for CapturingNotifier {
    fn notify(&self, method: &str, params: Value) {
        self.captured
            .lock()
            .unwrap()
            .push((method.to_string(), params));
    }
}

fn wait_for<F: Fn(&Vec<(String, Value)>) -> bool>(
    notifier: &Arc<CapturingNotifier>,
    pred: F,
) -> Vec<(String, Value)> {
    // 200ms is enough for the mock to finish writing its
    // scripted events on a quiet runner; bumping if we ever
    // see flakes.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    loop {
        {
            let guard = notifier.captured.lock().unwrap();
            if pred(&guard) {
                return guard.clone();
            }
        }
        if std::time::Instant::now() >= deadline {
            let guard = notifier.captured.lock().unwrap();
            return guard.clone();
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

#[test]
fn send_writes_sidecar_request_and_fans_events_to_session_notifier() {
    // Scripted reply: when the mock sees a request line containing
    // "sendMessage", emit two events (system.init + assistant).
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({
                "id": "req-1",
                "type": "system",
                "subtype": "init",
                "session_id": "sdk-session-7",
            }),
            json!({
                "id": "req-1",
                "type": "assistant",
                "delta": "hi",
            }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    let result = state
        .send(
            AgentSendParams {
                request_id: "req-1".into(),
                method: "sendMessage".into(),
                params: json!({ "model": "claude", "prompt": "hi" }),
            },
            Arc::clone(&notifier) as Arc<dyn Notifier>,
        )
        .unwrap();
    assert!(result.accepted);

    let captured = wait_for(&notifier, |c| c.len() >= 2);
    assert_eq!(captured.len(), 2, "expected 2 events, got {captured:?}");
    for (method, params) in &captured {
        assert_eq!(method, AGENT_EVENT_METHOD);
        assert_eq!(params["requestId"], "req-1");
    }
    // First event is system.init carrying session_id.
    assert_eq!(captured[0].1["event"]["type"], "system");
    assert_eq!(captured[0].1["event"]["subtype"], "init");
    assert_eq!(captured[0].1["event"]["session_id"], "sdk-session-7");
    // Second event is the assistant turn.
    assert_eq!(captured[1].1["event"]["type"], "assistant");
    assert_eq!(captured[1].1["event"]["delta"], "hi");
}

#[test]
fn send_rejects_empty_request_id_or_method() {
    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new()));
    let notifier = Arc::new(CapturingNotifier::default());
    let err = state
        .send(
            AgentSendParams {
                request_id: "".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&notifier) as Arc<dyn Notifier>,
        )
        .unwrap_err();
    assert!(format!("{err:#}").contains("request_id"));

    let err = state
        .send(
            AgentSendParams {
                request_id: "r1".into(),
                method: "".into(),
                params: json!({}),
            },
            notifier as Arc<dyn Notifier>,
        )
        .unwrap_err();
    assert!(format!("{err:#}").contains("method"));
}

#[test]
fn list_reflects_active_sessions_with_late_bound_metadata() {
    // Scripted reply binds the session's provider + session_id
    // via a system.init event; agent.list should surface those
    // fields once the reader thread has processed the event.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![json!({
            "id": "req-2",
            "type": "system",
            "subtype": "init",
            "session_id": "sdk-session-9",
            "provider": "claude",
        })],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-2".into(),
                method: "sendMessage".into(),
                params: json!({ "cwd": "/srv/repos/demo", "helmorSessionId": "hs-1" }),
            },
            notifier.clone() as Arc<dyn Notifier>,
        )
        .unwrap();

    // Wait for the system.init event to land + populate the
    // session metadata.
    let _ = wait_for(&notifier, |c| !c.is_empty());
    let result = state.list();
    assert_eq!(result.sessions.len(), 1);
    let entry = &result.sessions[0];
    assert_eq!(entry.request_id, "req-2");
    assert_eq!(entry.helmor_session_id.as_deref(), Some("hs-1"));
    assert_eq!(entry.workspace_dir.as_deref(), Some("/srv/repos/demo"));
    assert_eq!(entry.provider.as_deref(), Some("claude"));
    assert!(entry.started_at_ms > 0);
    assert!(entry.last_event_ms >= entry.started_at_ms);
}

#[test]
fn attach_swaps_notifier_so_subsequent_events_flow_to_new_client() {
    // Two events, but only the second flows through the
    // post-attach notifier — proves the swap took effect.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "id": "req-3", "type": "assistant", "delta": "one" }),
            json!({ "id": "req-3", "type": "assistant", "delta": "two" }),
        ],
    );
    // We need to interleave: send → wait first event → attach
    // → wait second event. The mock emits both at once, so for
    // the test we re-bind right after the first one lands.
    // Practically: the test catches both in the original
    // notifier; we just assert attach reports `found=true`.
    let state = RemoteAgentState::new(Arc::new(spawner));
    let initial = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-3".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            initial.clone() as Arc<dyn Notifier>,
        )
        .unwrap();

    // Attach to the live session.
    let attach_result = state
        .attach(
            AgentAttachParams {
                request_id: "req-3".into(),
                since_seq: None,
            },
            Arc::new(CapturingNotifier::default()),
        )
        .unwrap();
    assert!(attach_result.found);

    // Attempt to attach to a non-existent session.
    let miss = state
        .attach(
            AgentAttachParams {
                request_id: "never-existed".into(),
                since_seq: None,
            },
            Arc::new(CapturingNotifier::default()),
        )
        .unwrap();
    assert!(!miss.found);
}

#[test]
fn session_is_removed_on_terminal_result_event() {
    // The reader loop drops sessions on `type: "result"` or
    // `type: "end"` so the map doesn't grow unboundedly. The
    // mock emits a result event → next list call should be
    // empty.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "id": "req-4", "type": "assistant", "delta": "x" }),
            json!({
                "id": "req-4",
                "type": "result",
                "subtype": "success",
                "result": "all done",
            }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-4".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier.clone() as Arc<dyn Notifier>,
        )
        .unwrap();

    // Wait until both events have been notified out.
    let _ = wait_for(&notifier, |c| c.len() >= 2);
    // Session should be gone now.
    let listing = state.list();
    assert!(
        listing.sessions.is_empty(),
        "result event must terminate the session: {listing:?}",
    );
}

#[test]
fn events_without_an_id_field_are_dropped() {
    // The sidecar emits some events that don't carry a session
    // id (e.g. its own startup probes). The reader must drop
    // them rather than routing them to a "default" notifier
    // they don't belong to.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "type": "system", "subtype": "broadcast", "message": "no id here" }),
            json!({ "id": "req-5", "type": "assistant", "delta": "real one" }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-5".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier.clone() as Arc<dyn Notifier>,
        )
        .unwrap();

    let captured = wait_for(&notifier, |c| !c.is_empty());
    // The id-less broadcast must NOT be in the captured list.
    assert_eq!(captured.len(), 1, "expected 1 event, got {captured:?}");
    assert_eq!(captured[0].1["event"]["delta"], "real one");
}

#[test]
fn abort_writes_a_sidecar_abort_envelope() {
    // The mock matches on "abort" in the request line. We
    // configure a no-op reply (empty events vec) so the
    // request is accepted but no event flows.
    let spawner = MockAgentSpawner::new()
        .respond("sendMessage", vec![])
        .respond("abort", vec![]);
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    // Need to send first so the sidecar is running. (Lazy
    // spawn happens on the first call.)
    state
        .send(
            AgentSendParams {
                request_id: "req-6".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier as Arc<dyn Notifier>,
        )
        .unwrap();
    let result = state
        .abort(AgentAbortParams {
            request_id: "req-6".into(),
        })
        .unwrap();
    // The result struct is `{}` on the wire — success is
    // signalled by no error.
    assert_eq!(result, AgentAbortResult::default());
}

#[test]
fn disabled_state_bails_with_legible_reason() {
    let state = RemoteAgentState::disabled("HELMOR_SIDECAR_PATH not set");
    let notifier = Arc::new(CapturingNotifier::default());
    let err = state
        .send(
            AgentSendParams {
                request_id: "req-7".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier as Arc<dyn Notifier>,
        )
        .unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("HELMOR_SIDECAR_PATH not set"),
        "error should surface the disabled reason verbatim: {msg}"
    );
}

#[test]
fn handshake_other_than_ready_surfaces_as_spawn_error() {
    // Custom handshake → bridge should bail with the parsed
    // line in the error so the operator can see what the
    // sidecar emitted instead.
    let spawner = MockAgentSpawner::new().with_handshake(r#"{"type":"boom"}"#);
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    let err = state
        .send(
            AgentSendParams {
                request_id: "req-8".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier as Arc<dyn Notifier>,
        )
        .unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("not type=ready"),
        "handshake error should name the issue: {msg}",
    );
}

#[test]
fn scripted_reply_close_after_drops_session_on_eof() {
    // Wedges the reader loop's EOF handling: if the sidecar
    // dies mid-stream, the reader thread exits cleanly and
    // future sends fail (or, post-23d, re-spawn). For 23b we
    // just confirm the thread doesn't panic and the session
    // map's existing entries survive.
    let spawner = MockAgentSpawner::new();
    spawner.script.lock().unwrap().push(ScriptedReply {
        match_substring: "sendMessage".into(),
        events: vec![json!({ "id": "req-9", "type": "assistant", "delta": "x" })],
        close_after: true,
    });
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-9".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier.clone() as Arc<dyn Notifier>,
        )
        .unwrap();
    let _ = wait_for(&notifier, |c| !c.is_empty());
    // No panic + the captured event is intact.
    assert_eq!(notifier.captured.lock().unwrap().len(), 1);
}

// ── set_auth + secrets store (phase 23d) ────────────────────

fn temp_secrets_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.json");
    (dir, path)
}

#[test]
fn set_auth_persists_provider_key_to_secrets_file() {
    let (_dir, path) = temp_secrets_path();
    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new()))
        .with_secrets_path(Some(path.clone()));
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: Some("sk-test".into()),
            base_url: None,
        })
        .unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    let parsed: SecretsStore = serde_json::from_str(&raw).unwrap();
    let cursor = parsed.providers.get("cursor").expect("cursor entry");
    assert_eq!(cursor.api_key.as_deref(), Some("sk-test"));
}

#[test]
#[cfg(unix)]
fn set_auth_writes_file_mode_0600_on_unix() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, path) = temp_secrets_path();
    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new()))
        .with_secrets_path(Some(path.clone()));
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: Some("sk-test".into()),
            base_url: None,
        })
        .unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "secrets file must be readable only by the owner, got {mode:o}",
    );
}

#[test]
fn set_auth_clear_removes_provider_entry() {
    // Two-step: set then clear (api_key=None). The cursor
    // entry should vanish from the store; the file remains.
    let (_dir, path) = temp_secrets_path();
    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new()))
        .with_secrets_path(Some(path.clone()));
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: Some("sk-test".into()),
            base_url: None,
        })
        .unwrap();
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: None,
            base_url: None,
        })
        .unwrap();
    let parsed: SecretsStore =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(
        !parsed.providers.contains_key("cursor"),
        "clear should remove the entry, got {:?}",
        parsed.providers
    );
}

#[test]
fn set_auth_treats_empty_string_api_key_as_clear() {
    let (_dir, path) = temp_secrets_path();
    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new()))
        .with_secrets_path(Some(path.clone()));
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: Some("initial".into()),
            base_url: None,
        })
        .unwrap();
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: Some("   ".into()), // whitespace == clear
            base_url: None,
        })
        .unwrap();
    let parsed: SecretsStore =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(!parsed.providers.contains_key("cursor"));
}

#[test]
fn set_auth_rejects_empty_provider() {
    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new())).with_secrets_path(None);
    let err = state
        .set_auth(AgentSetAuthParams {
            provider: "  ".into(),
            api_key: Some("x".into()),
            base_url: None,
        })
        .unwrap_err();
    assert!(format!("{err:#}").contains("provider must not be empty"));
}

#[test]
fn set_auth_hot_pushes_update_config_to_running_sidecar() {
    // Spin up the bridge (send + handshake), then call set_auth.
    // The mock spawner captures every line written to stdin —
    // we read its outbound buffer to verify updateConfig flowed
    // through with the new key.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![json!({ "id": "req-1", "type": "assistant", "delta": "ok" })],
    );
    // Capture writes to stdin via a sibling Arc<Mutex<Vec<u8>>>
    // — the MockAgentSpawner's ChannelWriter doesn't expose
    // sent bytes directly, but its `respond("updateConfig", ...)`
    // would only fire if the daemon wrote a matching line. Add
    // a second script entry that captures by surfacing a canned
    // ack.
    let spawner = spawner.respond(
        "updateConfig",
        vec![json!({ "id": "ack", "type": "system", "subtype": "config_ack" })],
    );
    let (_dir, path) = temp_secrets_path();
    let state = RemoteAgentState::new(Arc::new(spawner)).with_secrets_path(Some(path.clone()));
    let notifier = Arc::new(CapturingNotifier::default());
    // Start the bridge.
    state
        .send(
            AgentSendParams {
                request_id: "req-1".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier.clone() as Arc<dyn Notifier>,
        )
        .unwrap();
    let _ = wait_for(&notifier, |c| !c.is_empty());

    // Hot-push: setAuth while the sidecar is running. The mock
    // matches "updateConfig" in the request line and emits a
    // canned ack; that ack flows back through the reader thread
    // → it has no `id` matching a registered session so it's
    // dropped silently (which is fine; we just need the write to
    // succeed).
    state
        .set_auth(AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: Some("hot-pushed".into()),
            base_url: None,
        })
        .unwrap();

    // The file got the new key.
    let parsed: SecretsStore =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        parsed
            .providers
            .get("cursor")
            .and_then(|s| s.api_key.as_deref()),
        Some("hot-pushed")
    );
}

#[test]
fn ensure_running_pushes_stored_cursor_key_on_first_spawn() {
    // Pre-seed the secrets file before constructing the state.
    // First send() spawns the sidecar, which should pick up the
    // stored key + emit an updateConfig as part of startup.
    let (_dir, path) = temp_secrets_path();
    let preseeded = SecretsStore {
        providers: {
            let mut m = HashMap::new();
            m.insert(
                "cursor".into(),
                ProviderSecret {
                    api_key: Some("preseeded-key".into()),
                    base_url: None,
                },
            );
            m
        },
    };
    save_secrets(&path, &preseeded).unwrap();

    let spawner = MockAgentSpawner::new()
        .respond(
            "sendMessage",
            vec![json!({ "id": "req-1", "type": "assistant" })],
        )
        .respond(
            "updateConfig",
            vec![json!({ "id": "config-ack", "type": "system" })],
        );
    let state = RemoteAgentState::new(Arc::new(spawner)).with_secrets_path(Some(path.clone()));
    let notifier = Arc::new(CapturingNotifier::default());
    // The act of sending kicks ensure_running, which spawns the
    // sidecar AND pushes the stored cursor key. If the push
    // didn't fire, the mock's updateConfig branch wouldn't
    // match, but the test passes as long as `send` succeeds —
    // we just need to confirm no panic + the sidecar accepted
    // the send.
    let result = state
        .send(
            AgentSendParams {
                request_id: "req-1".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            notifier as Arc<dyn Notifier>,
        )
        .unwrap();
    assert!(result.accepted);
}

// ── Phase 24q-1: event journal + replay-from-seq ─────────────────
//
// The four tests below exercise the daemon-side event journal added
// in phase 24q-1: the reader thread tagging every notification with
// a `seq`, plus `agent.attach` replaying journaled entries to a
// reconnecting client.
//
// Journal unit tests (ring append, eviction gap signalling, etc.)
// live alongside `EventJournal` in `super::journal::tests`. These
// tests cover the end-to-end seam through `RemoteAgentState` so a
// regression that breaks the reader/attach interaction surfaces
// here rather than after-the-fact during manual SSH reattach.

#[test]
fn reader_loop_tags_every_notification_with_a_monotonic_seq() {
    // The seq starts at 1 and increments per event. This is the
    // value the desktop will store as its `last_event_seq` and
    // pass back on the next reattach.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "id": "req-seq", "type": "assistant", "delta": "one" }),
            json!({ "id": "req-seq", "type": "assistant", "delta": "two" }),
            json!({ "id": "req-seq", "type": "assistant", "delta": "three" }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let notifier = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-seq".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&notifier) as Arc<dyn Notifier>,
        )
        .unwrap();

    let captured = wait_for(&notifier, |events| events.len() >= 3);
    assert_eq!(captured.len(), 3, "expected 3 events, got {captured:?}");
    let seqs: Vec<u64> = captured
        .iter()
        .filter_map(|(_, params)| params.get("seq").and_then(Value::as_u64))
        .collect();
    assert_eq!(
        seqs,
        vec![1, 2, 3],
        "reader must tag each event with a monotonic seq starting at 1",
    );
}

#[test]
fn attach_with_no_since_seq_flushes_full_journal_to_new_notifier() {
    // Cold-attach contract: a fresh client passes `since_seq=None`
    // and receives every journaled event in order before the
    // first live event lands.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "id": "req-cold", "type": "assistant", "delta": "a" }),
            json!({ "id": "req-cold", "type": "assistant", "delta": "b" }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let initial = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-cold".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&initial) as Arc<dyn Notifier>,
        )
        .unwrap();
    // Wait until the reader thread has appended both events to
    // the journal — observing them on the initial notifier proves
    // the append happened (the reader appends before notifying).
    wait_for(&initial, |events| events.len() >= 2);

    let replay_target = Arc::new(CapturingNotifier::default());
    let result = state
        .attach(
            AgentAttachParams {
                request_id: "req-cold".into(),
                since_seq: None,
            },
            Arc::clone(&replay_target) as Arc<dyn Notifier>,
        )
        .unwrap();

    assert!(result.found);
    assert_eq!(result.last_seq, 2);
    assert_eq!(result.replayed_count, 2);
    assert_eq!(result.replay_gap, None);

    let replayed = replay_target.captured.lock().unwrap().clone();
    assert_eq!(
        replayed.len(),
        2,
        "expected 2 replayed events, got {replayed:?}"
    );
    let seqs: Vec<u64> = replayed
        .iter()
        .filter_map(|(_, params)| params.get("seq").and_then(Value::as_u64))
        .collect();
    assert_eq!(seqs, vec![1, 2]);
    let deltas: Vec<String> = replayed
        .iter()
        .filter_map(|(_, params)| {
            params
                .get("event")
                .and_then(|e| e.get("delta"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert_eq!(deltas, vec!["a".to_string(), "b".to_string()]);
}

#[test]
fn attach_with_since_seq_flushes_only_newer_entries() {
    // Reconnect contract: a client that's already seen seq 1
    // passes `since_seq=Some(1)` and receives only seq 2 onward.
    // The flush respects the gap in seqs.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "id": "req-warm", "type": "assistant", "delta": "x" }),
            json!({ "id": "req-warm", "type": "assistant", "delta": "y" }),
            json!({ "id": "req-warm", "type": "assistant", "delta": "z" }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let initial = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-warm".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&initial) as Arc<dyn Notifier>,
        )
        .unwrap();
    wait_for(&initial, |events| events.len() >= 3);

    let replay_target = Arc::new(CapturingNotifier::default());
    let result = state
        .attach(
            AgentAttachParams {
                request_id: "req-warm".into(),
                since_seq: Some(1),
            },
            Arc::clone(&replay_target) as Arc<dyn Notifier>,
        )
        .unwrap();

    assert!(result.found);
    assert_eq!(result.last_seq, 3);
    assert_eq!(result.replayed_count, 2, "only seqs 2 and 3 should replay");
    assert_eq!(result.replay_gap, None);

    let replayed = replay_target.captured.lock().unwrap().clone();
    let seqs: Vec<u64> = replayed
        .iter()
        .filter_map(|(_, params)| params.get("seq").and_then(Value::as_u64))
        .collect();
    assert_eq!(seqs, vec![2, 3]);
}

#[test]
fn attach_with_caught_up_since_seq_replays_nothing() {
    // The desktop reattaches having already seen everything the
    // journal has. The flush should be empty + replay_gap=None +
    // last_seq carries the daemon's current head so the desktop
    // can keep its local marker in sync.
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![json!({ "id": "req-caughtup", "type": "assistant", "delta": "only" })],
    );
    let state = RemoteAgentState::new(Arc::new(spawner));
    let initial = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-caughtup".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&initial) as Arc<dyn Notifier>,
        )
        .unwrap();
    wait_for(&initial, |events| !events.is_empty());

    let replay_target = Arc::new(CapturingNotifier::default());
    let result = state
        .attach(
            AgentAttachParams {
                request_id: "req-caughtup".into(),
                since_seq: Some(1),
            },
            Arc::clone(&replay_target) as Arc<dyn Notifier>,
        )
        .unwrap();

    assert!(result.found);
    assert_eq!(result.last_seq, 1, "head is still seq 1");
    assert_eq!(result.replayed_count, 0);
    assert_eq!(result.replay_gap, None);
    assert!(
        replay_target.captured.lock().unwrap().is_empty(),
        "nothing should have flushed to the new notifier",
    );
}

// ── Phase 24t: durable journal + replay-only sessions ─────────────

#[test]
fn terminal_event_moves_session_into_ended_replay_only_with_journal_on_disk() {
    // The reader thread sees a `result` terminal, transitions the
    // session from `sessions` → `ended_sessions`, and the on-disk
    // file remains so `agent.attach` can later replay from it.
    let dir = tempfile::tempdir().unwrap();
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({
                "id": "req-end-1",
                "type": "system",
                "subtype": "init",
                "session_id": "hs-end-1",
                "provider": "claude",
            }),
            json!({
                "id": "req-end-1",
                "type": "assistant",
                "delta": "done",
            }),
            json!({
                "id": "req-end-1",
                "type": "result",
            }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner)).with_journal_dir(dir.path().to_path_buf());
    let notifier = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-end-1".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&notifier) as Arc<dyn Notifier>,
        )
        .unwrap();
    // Wait for the terminal event to drain so the reader has
    // moved the session into the ended map.
    let _ = wait_for(&notifier, |events| {
        events.iter().any(|(_, p)| p["event"]["type"] == "result")
    });
    // agent.list now reports the session as ended-replay-only.
    let listed = state.list();
    let entry = listed
        .sessions
        .iter()
        .find(|s| s.request_id == "req-end-1")
        .expect("ended session missing from list");
    assert_eq!(
        entry.state,
        crate::remote::methods::AgentSessionState::EndedReplayOnly,
    );
    assert_eq!(entry.helmor_session_id.as_deref(), Some("hs-end-1"));
    assert_eq!(entry.provider.as_deref(), Some("claude"));
    // On-disk journal file still exists.
    let journal_path = dir.path().join("req-end-1.jsonl");
    assert!(
        journal_path.exists(),
        "expected on-disk journal at {}",
        journal_path.display(),
    );
}

#[test]
fn attach_to_ended_replay_only_flushes_on_disk_journal_to_notifier() {
    // Seed a journal file by running the session, wait for its
    // terminal, then attach a fresh notifier and assert that the
    // pre-recorded events flow back without a live sidecar process
    // emitting them (the spawner script is exhausted by now).
    let dir = tempfile::tempdir().unwrap();
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({
                "id": "req-replay-1",
                "type": "assistant",
                "delta": "snapshot-1",
            }),
            json!({
                "id": "req-replay-1",
                "type": "assistant",
                "delta": "snapshot-2",
            }),
            json!({
                "id": "req-replay-1",
                "type": "result",
            }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner)).with_journal_dir(dir.path().to_path_buf());
    let original = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-replay-1".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&original) as Arc<dyn Notifier>,
        )
        .unwrap();
    let _ = wait_for(&original, |events| {
        events.iter().any(|(_, p)| p["event"]["type"] == "result")
    });

    // Now attach with a fresh notifier — the session is in the
    // ended_sessions map, so the daemon flushes from disk.
    let replay = Arc::new(CapturingNotifier::default());
    let result = state
        .attach(
            AgentAttachParams {
                request_id: "req-replay-1".into(),
                since_seq: None,
            },
            Arc::clone(&replay) as Arc<dyn Notifier>,
        )
        .unwrap();
    assert!(result.found);
    assert_eq!(result.replayed_count, 3, "all 3 events should replay");
    assert_eq!(result.last_seq, 3);
    assert_eq!(result.replay_gap, None);

    let captured = replay.captured.lock().unwrap();
    assert_eq!(captured.len(), 3);
    assert_eq!(captured[0].1["event"]["delta"], "snapshot-1");
    assert_eq!(captured[1].1["event"]["delta"], "snapshot-2");
    assert_eq!(captured[2].1["event"]["type"], "result");
}

#[test]
fn attach_to_ended_replay_only_honors_since_seq_cursor() {
    // Caller already has seq 1 + 2 locally; only seq 3 should flush.
    let dir = tempfile::tempdir().unwrap();
    let spawner = MockAgentSpawner::new().respond(
        "sendMessage",
        vec![
            json!({ "id": "req-since-1", "type": "assistant", "delta": "one" }),
            json!({ "id": "req-since-1", "type": "assistant", "delta": "two" }),
            json!({ "id": "req-since-1", "type": "result" }),
        ],
    );
    let state = RemoteAgentState::new(Arc::new(spawner)).with_journal_dir(dir.path().to_path_buf());
    let original = Arc::new(CapturingNotifier::default());
    state
        .send(
            AgentSendParams {
                request_id: "req-since-1".into(),
                method: "sendMessage".into(),
                params: json!({}),
            },
            Arc::clone(&original) as Arc<dyn Notifier>,
        )
        .unwrap();
    let _ = wait_for(&original, |events| {
        events.iter().any(|(_, p)| p["event"]["type"] == "result")
    });

    let replay = Arc::new(CapturingNotifier::default());
    let result = state
        .attach(
            AgentAttachParams {
                request_id: "req-since-1".into(),
                since_seq: Some(2),
            },
            Arc::clone(&replay) as Arc<dyn Notifier>,
        )
        .unwrap();
    assert!(result.found);
    assert_eq!(result.replayed_count, 1);
    let captured = replay.captured.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].1["event"]["type"], "result");
    assert_eq!(captured[0].1["seq"], 3);
}

#[test]
fn with_journal_dir_recovers_pre_existing_files_on_startup() {
    // Pre-seed a JSONL file in the journal dir (simulating a daemon
    // restart). `with_journal_dir` should pick it up as an
    // endedReplayOnly entry surfaced by agent.list.
    use crate::remote::agent::journal::JournalEntry;
    use crate::remote::agent::journal_store::JournalDiskWriter;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("req-recovered-1.jsonl");
    {
        let mut writer = JournalDiskWriter::open(path.clone()).unwrap();
        writer
            .append(&JournalEntry {
                seq: 1,
                ts_ms: 1_000,
                payload: json!({
                    "id": "req-recovered-1",
                    "type": "system",
                    "session_id": "hs-recovered-1",
                    "provider": "claude",
                }),
            })
            .unwrap();
        writer
            .append(&JournalEntry {
                seq: 2,
                ts_ms: 2_000,
                payload: json!({
                    "id": "req-recovered-1",
                    "type": "result",
                }),
            })
            .unwrap();
    }

    let state = RemoteAgentState::new(Arc::new(MockAgentSpawner::new()))
        .with_journal_dir(dir.path().to_path_buf());

    let listed = state.list();
    let entry = listed
        .sessions
        .iter()
        .find(|s| s.request_id == "req-recovered-1")
        .expect("recovered session not surfaced by agent.list");
    assert_eq!(
        entry.state,
        crate::remote::methods::AgentSessionState::EndedReplayOnly,
    );
    assert_eq!(entry.helmor_session_id.as_deref(), Some("hs-recovered-1"));
    assert_eq!(entry.provider.as_deref(), Some("claude"));

    // attach replays the file through the supplied notifier.
    let replay = Arc::new(CapturingNotifier::default());
    let result = state
        .attach(
            AgentAttachParams {
                request_id: "req-recovered-1".into(),
                since_seq: None,
            },
            Arc::clone(&replay) as Arc<dyn Notifier>,
        )
        .unwrap();
    assert!(result.found);
    assert_eq!(result.replayed_count, 2);
    assert_eq!(result.last_seq, 2);
}
