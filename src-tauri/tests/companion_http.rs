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

use futures::FutureExt;
use helmor_lib::companion::{CompanionState, Dispatcher, StreamStarter, Verifier};
use helmor_lib::error::CommandError;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_is_public_and_rpc_requires_bearer() {
    // Mock Tauri app supplies an `AppHandle` for the asset resolver; no real
    // bundle is served, which is fine — this test only exercises health/auth.
    let app = tauri::test::mock_app();
    let state = CompanionState::new();
    // The streamer is never invoked here (no stream request), so a no-op is fine.
    let streamer: StreamStarter = Arc::new(|_cmd, _args, _author_id, _tx| Ok(()));
    // In-memory verifier (no DB) so the test stays isolated; only the dev token
    // and this known PAT authenticate.
    let verifier: Verifier = Arc::new(|bearer| bearer == "hlm_paired_test");
    // Stub dispatcher replicating the two dispatch paths this test asserts
    // (unknown command + missing required arg) without needing a real app/DB.
    let dispatcher: Dispatcher = Arc::new(|cmd: String, args: serde_json::Value, _author_id| {
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
    let info = state
        .start(app.handle().clone(), streamer, dispatcher, verifier)
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

/// Trust boundary: the server must hand the streamer the team member id from
/// the trusted `X-Helmor-Member-Id` header — NEVER a value from the request
/// body. This proves `author_id` is server-derived; the production streamer
/// (`companion::stream::start_agent_stream`) then OVERWRITES `request.author_id`
/// with this argument, so a client-supplied `authorId` in the body can never
/// assert another member's identity.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_stream_passes_trusted_header_author_id_not_body() {
    let app = tauri::test::mock_app();
    let state = CompanionState::new();

    // Capture the author_id the server forwards to the streamer.
    let (seen_tx, seen_rx) = std::sync::mpsc::channel::<Option<String>>();
    let seen_tx = Arc::new(std::sync::Mutex::new(seen_tx));
    let streamer: StreamStarter = Arc::new(move |_cmd, _args, author_id, _tx| {
        seen_tx.lock().unwrap().send(author_id).unwrap();
        Ok(())
    });
    let verifier: Verifier = Arc::new(|_bearer| false);
    let dispatcher: Dispatcher = Arc::new(|cmd: String, _args: serde_json::Value, _author_id| {
        async move { Err(anyhow::anyhow!("Unknown companion command: {cmd}").into()) }.boxed()
    });

    let token = "hlm_stream_trust".to_string();
    let info = state
        .start_serve(
            app.handle().clone(),
            "127.0.0.1",
            0,
            token.clone(),
            streamer,
            dispatcher,
            verifier,
        )
        .await
        .expect("serve companion should start");
    let base = format!("http://127.0.0.1:{}", info.addr.port());
    let client = reqwest::Client::new();

    // Body asserts a forged `authorId`; the trusted header carries the real id.
    client
        .post(format!("{base}/rpc-stream/send_agent_message_stream"))
        .bearer_auth(&token)
        .header("X-Helmor-Member-Id", "trusted-member-7")
        .json(&serde_json::json!({
            "request": {
                "provider": "claude",
                "modelId": "opus-1m",
                "prompt": "hi",
                "authorId": "evil-client-id",
            }
        }))
        .send()
        .await
        .expect("stream request");

    let seen = seen_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("streamer invoked");
    assert_eq!(
        seen.as_deref(),
        Some("trusted-member-7"),
        "server must forward the trusted-header member id, not the body's authorId"
    );

    state.shutdown().await;
}

/// `helmor serve` smoke test: `start_serve` binds the requested address with a
/// caller-supplied capability token (no random dev token, no paired-device
/// verifier), and the resulting surface gates RPC on exactly that token. This
/// mirrors the container path (`0.0.0.0:$PORT` + `HELMOR_COMPANION_TOKEN`)
/// without building a full windowless Wry app.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serve_binds_with_capability_token_and_gates_rpc() {
    let app = tauri::test::mock_app();
    let state = CompanionState::new();
    let streamer: StreamStarter = Arc::new(|_cmd, _args, _author_id, _tx| Ok(()));
    // Serve rejects everything beyond the injected capability token.
    let verifier: Verifier = Arc::new(|_bearer| false);
    let dispatcher: Dispatcher = Arc::new(|cmd: String, _args: serde_json::Value, _author_id| {
        async move { Err(anyhow::anyhow!("Unknown companion command: {cmd}").into()) }.boxed()
    });

    let capability_token = "hlm_serve_capability".to_string();
    // Bind 0.0.0.0:0 (the real container shape) and reach it over loopback.
    let info = state
        .start_serve(
            app.handle().clone(),
            "0.0.0.0",
            0,
            capability_token.clone(),
            streamer,
            dispatcher,
            verifier,
        )
        .await
        .expect("serve companion should start");
    // The bound token is exactly what we injected — not a random dev token.
    assert_eq!(info.token, capability_token);

    let base = format!("http://127.0.0.1:{}", info.addr.port());
    let client = reqwest::Client::new();

    // Health stays public.
    let health = client
        .get(format!("{base}/v1/health"))
        .send()
        .await
        .expect("health request");
    assert_eq!(health.status(), 200);

    // The injected capability token authenticates (reaches dispatch → 400 on
    // the unknown command, proving it passed auth rather than 401).
    let authed = client
        .post(format!("{base}/rpc/__does_not_exist__"))
        .bearer_auth(&capability_token)
        .send()
        .await
        .expect("authed request");
    assert_eq!(authed.status(), 400);

    // Any other bearer is rejected (no dev-token fallback, verifier rejects).
    let wrong = client
        .post(format!("{base}/rpc/__does_not_exist__"))
        .bearer_auth("hlm_not_the_token")
        .send()
        .await
        .expect("wrong-token request");
    assert_eq!(wrong.status(), 401);

    state.shutdown().await;
    assert!(state.info().await.is_none());
}
