use std::sync::Arc;

use serde_json::{json, Value};

use crate::remote::methods::{WorkspaceBranchInfoResult, WorkspaceStatusResult};
use crate::remote::protocol::{
    error_codes, JsonRpcId, JsonRpcRequest, JsonRpcResponse, PROTOCOL_VERSION,
};
use crate::remote::runtime::RemoteRuntime;

use super::handlers::major_versions_match;
use super::{dispatch_request, ServerContext};

fn fresh_ctx() -> ServerContext {
    ServerContext::new("0.22.1", "test-host")
}

fn request(method: &str, params: Value, id: u64) -> JsonRpcRequest {
    JsonRpcRequest::new(method, params, JsonRpcId::Num(id))
}

// ── initialize ────────────────────────────────────────────────

#[test]
fn initialize_accepts_matching_version_and_unlocks_the_session() {
    let ctx = fresh_ctx();
    let resp = dispatch_request(
        &ctx,
        request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "helmor-client",
                "clientVersion": "0.22.1",
            }),
            1,
        ),
    )
    .expect("initialize must produce a response");
    let result = resp.result.expect("ok response");
    assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(result["hostname"], "test-host");
    assert!(ctx.is_initialized());
}

#[test]
fn initialize_rejects_mismatched_major() {
    let ctx = fresh_ctx();
    let resp = dispatch_request(
        &ctx,
        request(
            "initialize",
            json!({
                "protocolVersion": "1.0.0",
                "clientName": "helmor-client",
            }),
            1,
        ),
    )
    .unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::INCOMPATIBLE_PROTOCOL);
    assert!(!ctx.is_initialized());
}

// ── ping ──────────────────────────────────────────────────────

#[test]
fn ping_before_initialize_returns_not_initialized() {
    let ctx = fresh_ctx();
    let resp = dispatch_request(&ctx, request("ping", json!({}), 1)).unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::NOT_INITIALIZED);
}

#[test]
fn ping_after_initialize_echoes_counter_and_returns_server_time() {
    let ctx = fresh_ctx();
    dispatch_request(
        &ctx,
        request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "helmor-client",
            }),
            1,
        ),
    );
    let resp = dispatch_request(&ctx, request("ping", json!({ "counter": 42 }), 2)).unwrap();
    let result = resp.result.expect("ok response");
    assert_eq!(result["counter"], 42);
    assert!(result["serverTime"].as_str().unwrap().contains('T'));
}

#[test]
fn unknown_method_returns_method_not_found() {
    let ctx = fresh_ctx();
    let resp = dispatch_request(&ctx, request("not-a-method", json!({}), 1)).unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::METHOD_NOT_FOUND);
}

#[test]
fn invalid_params_returns_invalid_params_error_with_method_context() {
    let ctx = fresh_ctx();
    // `protocolVersion` is required by `InitializeParams` — sending
    // an object missing the field should surface an INVALID_PARAMS
    // error mentioning the method name.
    let resp =
        dispatch_request(&ctx, request("initialize", json!({ "clientName": "x" }), 1)).unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::INVALID_PARAMS);
    assert!(
        err.message.contains("`initialize`"),
        "error should name the method: {err:?}"
    );
}

// ── workspace.status ──────────────────────────────────────────

/// Stub runtime so dispatch tests don't need a real git repo on
/// disk. Returns a fixed status keyed off the workspace path so
/// the test can assert the params flowed through correctly.
struct StubRuntime;

impl RemoteRuntime for StubRuntime {
    fn runtime_health(&self) -> anyhow::Result<crate::remote::runtime::RuntimeHealth> {
        unreachable!("workspace.status dispatch tests should not probe health")
    }

    fn workspace_status(
        &self,
        workspace_dir: &std::path::Path,
    ) -> anyhow::Result<WorkspaceStatusResult> {
        // Echo the path back in `changed_paths` so the test can
        // prove the dispatcher decoded params + plumbed them to
        // the runtime.
        Ok(WorkspaceStatusResult {
            is_clean: false,
            changed_paths: vec![workspace_dir.display().to_string()],
        })
    }

    fn workspace_branch_info(
        &self,
        workspace_dir: &std::path::Path,
    ) -> anyhow::Result<WorkspaceBranchInfoResult> {
        // Same echo trick — proves the dispatcher decoded the
        // params and plumbed them through the trait.
        Ok(WorkspaceBranchInfoResult {
            current_branch: workspace_dir.display().to_string(),
            head_commit: "stub-head".into(),
            upstream_ref: Some("origin/stub".into()),
        })
    }

    fn ping(&self) -> anyhow::Result<()> {
        unreachable!("workspace.status dispatch tests don't ping")
    }
}

fn initialized_ctx_with_stub() -> ServerContext {
    let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
    // Drive a handshake so the gate opens, just like a real
    // client would do.
    dispatch_request(
        &ctx,
        request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "helmor-client",
            }),
            1,
        ),
    )
    .expect("initialize response");
    ctx
}

#[test]
fn workspace_status_dispatches_to_runtime_and_returns_camel_case_result() {
    let ctx = initialized_ctx_with_stub();
    let resp = dispatch_request(
        &ctx,
        request(
            "workspace.status",
            json!({ "workspaceDir": "/tmp/example" }),
            2,
        ),
    )
    .unwrap();
    let result = resp.result.expect("ok response");
    assert_eq!(result["isClean"], false);
    assert_eq!(
        result["changedPaths"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>()),
        Some(vec!["/tmp/example"]),
    );
}

#[test]
fn workspace_status_before_initialize_returns_not_initialized() {
    // Fresh ctx — no handshake. Even with the stub runtime, the
    // gate must reject.
    let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
    let resp = dispatch_request(
        &ctx,
        request(
            "workspace.status",
            json!({ "workspaceDir": "/tmp/example" }),
            1,
        ),
    )
    .unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::NOT_INITIALIZED);
}

#[test]
fn workspace_status_with_missing_workspace_dir_returns_invalid_params() {
    let ctx = initialized_ctx_with_stub();
    let resp = dispatch_request(&ctx, request("workspace.status", json!({}), 2)).unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::INVALID_PARAMS);
    assert!(
        err.message.contains("`workspace.status`"),
        "error should name the method: {err:?}"
    );
}

#[test]
fn workspace_status_runtime_failure_surfaces_as_handler_failed() {
    struct FailingRuntime;
    impl RemoteRuntime for FailingRuntime {
        fn runtime_health(&self) -> anyhow::Result<crate::remote::runtime::RuntimeHealth> {
            unreachable!()
        }
        fn workspace_status(&self, _: &std::path::Path) -> anyhow::Result<WorkspaceStatusResult> {
            Err(anyhow::anyhow!("git: not a repository"))
        }
        fn workspace_branch_info(
            &self,
            _: &std::path::Path,
        ) -> anyhow::Result<WorkspaceBranchInfoResult> {
            Err(anyhow::anyhow!("git: not a repository"))
        }
        fn ping(&self) -> anyhow::Result<()> {
            unreachable!()
        }
    }
    let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(FailingRuntime));
    // Handshake first.
    dispatch_request(
        &ctx,
        request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "helmor-client",
            }),
            1,
        ),
    );
    let resp = dispatch_request(
        &ctx,
        request("workspace.status", json!({ "workspaceDir": "/nope" }), 2),
    )
    .unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::HANDLER_FAILED);
    assert!(
        err.message.contains("not a repository"),
        "error should preserve git's message: {err:?}"
    );
}

// ── workspace inspector dispatch (phase 20a) ──────────────────
//
// The trait defaults bail with "not yet implemented" — we verify
// the dispatcher decodes params, hits the right trait method, and
// surfaces the bail as `HANDLER_FAILED`. When phase 20b backs
// `LocalRuntime` with real impls, the *dispatch* tests still hold;
// only the underlying behaviour changes.

fn run_after_initialize(ctx: &ServerContext, req: JsonRpcRequest) -> JsonRpcResponse {
    dispatch_request(
        ctx,
        request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "helmor-client",
            }),
            1,
        ),
    )
    .expect("initialize response");
    dispatch_request(ctx, req).expect("dispatcher should produce a response")
}

fn default_bail_ctx() -> ServerContext {
    // `StubRuntime` overrides workspace_status / branch_info, but
    // intentionally does NOT override the new inspector methods —
    // so we exercise the default trait bail through real dispatch.
    ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime))
}

fn assert_bail_with_method_prefix(resp: &JsonRpcResponse, method: &str) {
    let err = resp
        .error
        .as_ref()
        .unwrap_or_else(|| panic!("expected error response for `{method}`, got: {resp:?}"));
    assert_eq!(err.code, error_codes::HANDLER_FAILED);
    let expected_prefix = format!("{method} failed:");
    assert!(
        err.message.starts_with(&expected_prefix),
        "error message should be prefixed with `{expected_prefix}`, got: {}",
        err.message
    );
    assert!(
        err.message.contains("not yet implemented"),
        "default bail should reach the wire verbatim, got: {}",
        err.message
    );
}

#[test]
fn workspace_file_tree_default_bail_surfaces_as_handler_failed() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.fileTree",
            json!({ "workspaceDir": "/tmp/example" }),
            2,
        ),
    );
    assert_bail_with_method_prefix(&resp, "workspace.fileTree");
}

#[test]
fn workspace_changes_default_bail_surfaces_as_handler_failed() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.changes",
            json!({
                "workspaceDir": "/tmp/example",
                "includeContent": true,
            }),
            2,
        ),
    );
    assert_bail_with_method_prefix(&resp, "workspace.changes");
}

#[test]
fn workspace_read_file_default_bail_surfaces_as_handler_failed() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.readFile",
            json!({
                "workspaceDir": "/tmp/example",
                "relativePath": "src/main.rs",
            }),
            2,
        ),
    );
    assert_bail_with_method_prefix(&resp, "workspace.readFile");
}

#[test]
fn workspace_read_file_at_ref_default_bail_surfaces_as_handler_failed() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.readFileAtRef",
            json!({
                "workspaceDir": "/tmp/example",
                "relativePath": "src/main.rs",
                "gitRef": "HEAD",
            }),
            2,
        ),
    );
    assert_bail_with_method_prefix(&resp, "workspace.readFileAtRef");
}

#[test]
fn workspace_stat_file_default_bail_surfaces_as_handler_failed() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.statFile",
            json!({
                "workspaceDir": "/tmp/example",
                "relativePath": "Cargo.toml",
            }),
            2,
        ),
    );
    assert_bail_with_method_prefix(&resp, "workspace.statFile");
}

#[test]
fn workspace_mutate_file_default_bail_surfaces_as_handler_failed() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.mutateFile",
            json!({
                "workspaceDir": "/tmp/example",
                "relativePath": "Cargo.toml",
                "action": { "type": "write", "content": "[package]\nname = \"x\"\n" },
            }),
            2,
        ),
    );
    assert_bail_with_method_prefix(&resp, "workspace.mutateFile");
}

// ── agent.* default surfaces (phase 23b) ─────────────────────
//
// The ServerContext built by `with_runtime` carries a disabled
// `RemoteAgentState` so unit tests don't accidentally spawn a
// sidecar. Mutating methods surface the explicit
// "agent runtime not configured" reason; the infallible
// `agent.list` returns an empty list, and `agent.attach`
// reports `found=false` (the same shape as attaching to a
// missing live session). Tests that drive a real sidecar live
// in `remote::agent::tests`.

fn assert_agent_disabled(resp: &JsonRpcResponse, method: &str) {
    let err = resp
        .error
        .as_ref()
        .unwrap_or_else(|| panic!("expected error response for `{method}`, got: {resp:?}"));
    assert_eq!(err.code, error_codes::HANDLER_FAILED);
    let expected_prefix = format!("{method} failed:");
    assert!(
        err.message.starts_with(&expected_prefix),
        "error message should be prefixed with `{expected_prefix}`, got: {}",
        err.message
    );
    assert!(
        err.message.contains("agent runtime is not available"),
        "disabled-state bail should surface the legible reason: {}",
        err.message
    );
}

#[test]
fn agent_send_with_disabled_state_surfaces_legible_error() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "agent.send",
            json!({
                "requestId": "req-1",
                "method": "sendMessage",
                "params": { "model": "claude-sonnet-4-6", "prompt": "hi" },
            }),
            2,
        ),
    );
    assert_agent_disabled(&resp, "agent.send");
}

#[test]
fn agent_abort_with_disabled_state_surfaces_legible_error() {
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request("agent.abort", json!({ "requestId": "req-1" }), 2),
    );
    assert_agent_disabled(&resp, "agent.abort");
}

#[test]
fn agent_list_with_disabled_state_returns_empty_listing() {
    // `list` is infallible — it snapshots the sessions map.
    // A disabled state has no sessions; wire result is
    // `{ sessions: [] }`.
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(&ctx, request("agent.list", json!({}), 2));
    let result = resp.result.expect("ok response");
    let sessions = result["sessions"].as_array().expect("sessions array");
    assert!(
        sessions.is_empty(),
        "disabled state must report no sessions"
    );
}

#[test]
fn agent_attach_with_disabled_state_reports_not_found() {
    // Attaching against a disabled state finds no matching
    // session and returns `found=false` rather than erroring —
    // same contract as attaching to a missing live session.
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request("agent.attach", json!({ "requestId": "req-1" }), 2),
    );
    let result = resp.result.expect("ok response");
    assert_eq!(result["found"], false);
}

#[test]
fn agent_methods_reject_pre_initialize_requests() {
    // The initialization gate must cover the new entry points
    // too — agent.send before initialize should fail at the gate,
    // not at the runtime bail.
    let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
    let resp = dispatch_request(
        &ctx,
        request(
            "agent.send",
            json!({
                "requestId": "req-1",
                "method": "sendMessage",
                "params": {},
            }),
            1,
        ),
    )
    .unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::NOT_INITIALIZED);
}

#[test]
fn agent_send_rejects_malformed_params() {
    // `params` is `serde_json::Value` (opaque) but `request_id` +
    // `method` are required strings. Missing them is INVALID_PARAMS,
    // not HANDLER_FAILED.
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "agent.send",
            json!({ "params": { "model": "x" } }), // missing requestId + method
            2,
        ),
    );
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::INVALID_PARAMS);
    assert!(
        err.message.contains("`agent.send`"),
        "error should name the method: {err:?}"
    );
}

#[test]
fn workspace_inspector_methods_reject_pre_initialize_requests() {
    // Spot-check the gate works for the new methods too — pick
    // one representative call. The branchInfo / status tests
    // already cover the gate path generically; here we just make
    // sure the new entry points didn't accidentally bypass it.
    let ctx = ServerContext::with_runtime("0.22.1", "test-host", Arc::new(StubRuntime));
    let resp = dispatch_request(
        &ctx,
        request(
            "workspace.readFile",
            json!({
                "workspaceDir": "/tmp/example",
                "relativePath": "src/main.rs",
            }),
            1,
        ),
    )
    .unwrap();
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::NOT_INITIALIZED);
}

#[test]
fn workspace_inspector_methods_reject_malformed_params() {
    // `workspace.mutateFile` has the richest param shape — an
    // internally-tagged enum buried inside the object. Pick a
    // garbled action to prove the dispatcher's `INVALID_PARAMS`
    // path covers it.
    let ctx = default_bail_ctx();
    let resp = run_after_initialize(
        &ctx,
        request(
            "workspace.mutateFile",
            json!({
                "workspaceDir": "/tmp/example",
                "relativePath": "Cargo.toml",
                "action": { "type": "explode" },
            }),
            2,
        ),
    );
    let err = resp.error.expect("error response");
    assert_eq!(err.code, error_codes::INVALID_PARAMS);
    assert!(
        err.message.contains("`workspace.mutateFile`"),
        "error should name the method: {err:?}"
    );
}

// ── notifications ─────────────────────────────────────────────

#[test]
fn notification_request_returns_no_response_even_on_error() {
    let ctx = fresh_ctx();
    // No id → notification. Even though the method is unknown,
    // the dispatcher must NOT produce a response envelope.
    let resp = dispatch_request(
        &ctx,
        JsonRpcRequest::new("not-a-method", json!({}), JsonRpcId::Null),
    );
    assert!(resp.is_none());
}

// ── major_versions_match ──────────────────────────────────────

#[test]
fn major_versions_match_treats_0x_minor_as_breaking() {
    assert!(major_versions_match("0.1.0", "0.1.5"));
    assert!(!major_versions_match("0.1.0", "0.2.0"));
    // 1.x+: minor is non-breaking.
    assert!(major_versions_match("1.2.0", "1.5.0"));
    assert!(!major_versions_match("1.0.0", "2.0.0"));
}
