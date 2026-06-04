//! In-process integration test for the companion HTTP surface.
//!
//! Starts a real [`CompanionState`] server on loopback and exercises the
//! transport contract end-to-end without a Tauri runtime: the unauthenticated
//! health probe, bearer enforcement, and the `{ code, message }` error shape
//! that the browser transport (`src/lib/ipc.ts`) relies on.
//!
//! Endpoints that touch the database are exercised only on the pre-auth /
//! unknown-command paths, so the test needs no DB pools.

use helmor_lib::companion::CompanionState;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn health_is_public_and_rpc_requires_bearer() {
    // Mock Tauri app supplies an `AppHandle` for the asset resolver; no real
    // bundle is served, which is fine — this test only exercises health/auth.
    let app = tauri::test::mock_app();
    let state = CompanionState::new();
    let info = state
        .start(app.handle().clone())
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
