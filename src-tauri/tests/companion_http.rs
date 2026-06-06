//! In-process integration test for the companion HTTP surface.
//!
//! Starts a real [`CompanionState`] server on loopback and exercises the
//! transport contract end-to-end without a Tauri runtime: the unauthenticated
//! health probe, bearer enforcement, and the `{ code, message }` error shape
//! that the browser transport (`src/lib/ipc.ts`) relies on.
//!
//! Endpoints that touch the database are exercised only on the pre-auth /
//! unknown-command paths, so the test needs no DB pools.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use helmor_lib::agents::SessionStreamHub;
use helmor_lib::companion::{
    build_event_stream_starter, CompanionState, Dispatcher, EventStreamStarter, StreamStarter,
    Verifier,
};
use helmor_lib::error::CommandError;
use helmor_lib::ui_sync::{UiMutationEvent, UiSyncManager};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::Manager;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_is_public_and_rpc_requires_bearer() {
    // Mock Tauri app supplies an `AppHandle` for the asset resolver; no real
    // bundle is served, which is fine — this test only exercises health/auth.
    let app = tauri::test::mock_app();
    let state = CompanionState::new();
    // The streamer is never invoked here (no stream request), so a no-op is fine.
    let streamer: StreamStarter = Arc::new(|_cmd, _args, _tx| Ok(()));
    // In-memory verifier (no DB) so the test stays isolated; only the dev token
    // and this known PAT authenticate.
    let verifier: Verifier = Arc::new(|bearer| bearer == "hlm_paired_test");
    // Stub dispatcher replicating the two dispatch paths this test asserts
    // (unknown command + missing required arg) without needing a real app/DB.
    let dispatcher: Dispatcher = Arc::new(|cmd: String, args: serde_json::Value| {
        async move {
            match cmd.as_str() {
                "get_workspace" => {
                    args.get("workspaceId")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| -> CommandError {
                            anyhow::anyhow!("Missing required argument: workspaceId").into()
                        })?;
                    Ok(serde_json::Value::Null)
                }
                other => Err(anyhow::anyhow!("Unknown companion command: {other}").into()),
            }
        }
        .boxed()
    });
    // No `/v1/stream` connection is opened here, so a no-op event starter is fine.
    let event_starter: EventStreamStarter = Arc::new(|_tx, _watch| {});
    let info = state
        .start(
            app.handle().clone(),
            streamer,
            dispatcher,
            verifier,
            event_starter,
        )
        .await
        .expect("companion server should start");
    let base = format!("http://{}", info.addr);
    let client = reqwest::Client::new();

    // `info()` reflects the running server.
    let reported = state.info().await.expect("server should report info");
    assert_eq!(reported.addr, info.addr);
    assert_eq!(reported.token, info.token);
    assert!(info.token.starts_with("hlm_"));

    // Health is unauthenticated and reports liveness.
    let health = client
        .get(format!("{base}/v1/health"))
        .send()
        .await
        .expect("health request");
    assert_eq!(health.status(), 200);
    let body: serde_json::Value = health.json().await.expect("health json");
    assert_eq!(body["status"], "ok");
    assert_eq!(body["service"], "helmor-companion");

    // RPC without a bearer token is rejected.
    let unauth = client
        .post(format!("{base}/rpc/list_workspace_groups"))
        .send()
        .await
        .expect("unauth request");
    assert_eq!(unauth.status(), 401);

    // RPC with the wrong bearer token is rejected.
    let wrong = client
        .post(format!("{base}/rpc/list_workspace_groups"))
        .bearer_auth("hlm_wrong")
        .send()
        .await
        .expect("wrong-token request");
    assert_eq!(wrong.status(), 401);

    // A token accepted by the injected verifier (a "paired device") passes auth
    // — it reaches dispatch (here an unknown command → 400, not 401).
    let paired = client
        .post(format!("{base}/rpc/__does_not_exist__"))
        .bearer_auth("hlm_paired_test")
        .send()
        .await
        .expect("paired-token request");
    assert_eq!(paired.status(), 400);

    // Authenticated unknown command returns the `{ code, message }` error
    // shape — and never reaches the database.
    let unknown = client
        .post(format!("{base}/rpc/__does_not_exist__"))
        .bearer_auth(&info.token)
        .send()
        .await
        .expect("unknown-command request");
    assert_eq!(unknown.status(), 400);
    let err: serde_json::Value = unknown.json().await.expect("error json");
    assert_eq!(err["code"], "Unknown");
    assert!(err["message"]
        .as_str()
        .unwrap_or_default()
        .contains("Unknown companion command"));

    // An authenticated operate command with a missing required arg is rejected
    // at the dispatch layer (before touching the DB) with the { code, message }
    // shape.
    let missing_arg = client
        .post(format!("{base}/rpc/get_workspace"))
        .bearer_auth(&info.token)
        .send()
        .await
        .expect("missing-arg request");
    assert_eq!(missing_arg.status(), 400);
    let err: serde_json::Value = missing_arg.json().await.expect("error json");
    assert!(err["message"]
        .as_str()
        .unwrap_or_default()
        .contains("Missing required argument: workspaceId"));

    // Shutdown is idempotent and clears reported info.
    state.shutdown().await;
    assert!(state.info().await.is_none());
}

/// `/v1/stream` carries the live `ui-mutation` feed and wires `?watch=` to the
/// shared `SessionStreamHub` (subscribing on connect, unsubscribing on drop).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_carries_ui_mutations_and_session_watch() {
    // A managed app so `build_event_stream_starter` subscribes the real shared
    // managers — the same instances this test publishes into.
    let app = mock_builder()
        .manage(UiSyncManager::new())
        .manage(SessionStreamHub::new())
        .build(mock_context(noop_assets()))
        .expect("mock app builds");
    let handle = app.handle().clone();

    let state = CompanionState::new();
    let streamer: StreamStarter = Arc::new(|_cmd, _args, _tx| Ok(()));
    let dispatcher: Dispatcher =
        Arc::new(|_cmd, _args| async { Ok(serde_json::Value::Null) }.boxed());
    let verifier: Verifier = Arc::new(|_| false);
    let event_starter = build_event_stream_starter(handle.clone());
    let info = state
        .start(
            handle.clone(),
            streamer,
            dispatcher,
            verifier,
            event_starter,
        )
        .await
        .expect("companion server should start");
    let base = format!("http://{}", info.addr);
    let client = reqwest::Client::new();

    // Unauthenticated stream is rejected.
    let unauth = client
        .get(format!("{base}/v1/stream"))
        .send()
        .await
        .expect("unauth stream request");
    assert_eq!(unauth.status(), 401);

    // ui-mutation feed: connect, publish, observe the frame. By the time `send()`
    // resolves the handler has already run `event_starter`, so the UiSyncManager
    // subscription is registered — publishing now is race-free.
    let mut resp = client
        .get(format!("{base}/v1/stream"))
        .bearer_auth(&info.token)
        .send()
        .await
        .expect("stream request");
    assert_eq!(resp.status(), 200);
    handle
        .state::<UiSyncManager>()
        .publish(UiMutationEvent::WorkspaceListChanged);

    let text = read_until(&mut resp, "ui-mutation", Duration::from_secs(5)).await;
    assert!(text.contains("hello"), "missing hello frame: {text}");
    assert!(
        text.contains("ui-mutation") && text.contains("workspaceListChanged"),
        "missing ui-mutation frame: {text}"
    );
    drop(resp);

    // `?watch=` registers a session subscriber, and dropping the stream tears it
    // down (the `tx.closed()` teardown path).
    let watch_resp = client
        .get(format!("{base}/v1/stream?watch=sess-1"))
        .bearer_auth(&info.token)
        .send()
        .await
        .expect("watch stream request");
    assert_eq!(watch_resp.status(), 200);
    let hub = handle.state::<SessionStreamHub>();
    assert!(
        poll_until(Duration::from_secs(2), || hub.any_subscribers()).await,
        "watch did not register a session subscriber"
    );
    drop(watch_resp);
    assert!(
        poll_until(Duration::from_secs(2), || !hub.any_subscribers()).await,
        "dropping the watch stream did not unsubscribe"
    );

    state.shutdown().await;
}

/// Read SSE chunks until the accumulated text contains `needle` or `timeout`.
async fn read_until(resp: &mut reqwest::Response, needle: &str, timeout: Duration) -> String {
    let mut text = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), resp.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                text.push_str(&String::from_utf8_lossy(&bytes));
                if text.contains(needle) {
                    break;
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) => break, // stream ended / transport error
            Err(_) => {}                        // per-read timeout — wait until deadline
        }
    }
    text
}

/// Poll `cond` until it returns true or `timeout` elapses.
async fn poll_until(timeout: Duration, cond: impl Fn() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    cond()
}
