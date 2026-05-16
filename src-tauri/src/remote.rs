//! Remote-runner RPC protocol.
//!
//! The remote-workspace feature (#453) is structured as a client/server
//! split: the local Helmor app talks to a `helmor-server` binary that
//! runs on the remote machine, owns the workspaces, and drives the
//! agent sidecar there.
//!
//! Wire format is JSON-RPC 2.0 messages framed with `Content-Length`
//! headers — the same shape LSP uses. We pick it deliberately:
//!
//! - Bidirectional pipe is the lowest-friction transport over SSH
//!   (`ssh host helmor-server` is one command, no port forwarding, no
//!   new auth layer to build).
//! - Length-prefixed framing handles binary-safe payloads and partial
//!   reads without inventing a custom delimiter.
//! - JSON keeps the per-method shapes mirrorable in Rust serde and
//!   TypeScript, the two languages the rest of Helmor already speaks.
//!
//! This module is intentionally I/O-flavour-agnostic: the framer
//! exposes `read_frame`/`write_frame` against `BufRead` + `Write`, so
//! the same code drives stdio (binary side), a child process's stdio
//! handles (client side via SSH), or a pair of in-memory pipes (test
//! side). No `tokio` dependency yet — the existing crate already uses
//! `std::thread` for blocking work and the binary will start the same
//! way.

pub mod client;
pub mod codec;
pub mod connection;
pub mod install;
pub mod liveness;
pub mod methods;
pub mod persistence;
pub mod protocol;
pub mod registry;
pub mod runtime;
pub mod server;
pub mod ssh_config;

pub use client::{RemoteSshRuntime, RpcClient};
pub use codec::{read_frame, write_frame, FrameError};
pub use connection::RuntimeConnectionConfig;
pub use liveness::spawn_liveness_loop;
pub use methods::{
    Method, RpcMethod, WorkspaceStatusMethod, WorkspaceStatusParams, WorkspaceStatusResult,
};
pub use protocol::{
    JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, PROTOCOL_VERSION,
};
pub use registry::{RuntimeRegistry, RuntimeState, LOCAL_RUNTIME_NAME};
pub use runtime::{local_runtime, LocalRuntime, RemoteRuntime, RuntimeHealth, RuntimeKind};
pub use server::{dispatch_request, ServerContext};

#[cfg(test)]
mod loopback_tests {
    //! Wire-level smoke tests that drive the framer + dispatcher
    //! end-to-end with in-memory pipes. This is the same code path
    //! the `helmor-server` binary takes, minus the stdin/stdout
    //! plumbing — so a passing test here means the protocol shape
    //! works against the live dispatcher.

    use super::*;
    use serde_json::{json, Value};
    use std::io::Cursor;

    /// Drive one round-trip: write a request frame to a buffer, hand
    /// it to the dispatcher, read the response frame back. Mirrors
    /// the binary's main loop one iteration at a time.
    fn round_trip(ctx: &ServerContext, request: &JsonRpcRequest) -> Option<JsonRpcResponse> {
        let mut request_buf = Vec::new();
        write_frame(&mut request_buf, request).unwrap();

        let mut request_reader = Cursor::new(request_buf);
        let decoded: JsonRpcRequest = read_frame(&mut request_reader).unwrap();

        let response = dispatch_request(ctx, decoded)?;

        let mut response_buf = Vec::new();
        write_frame(&mut response_buf, &response).unwrap();
        let mut response_reader = Cursor::new(response_buf);
        Some(read_frame::<_, JsonRpcResponse>(&mut response_reader).unwrap())
    }

    #[test]
    fn handshake_then_ping_works_end_to_end_through_framed_io() {
        let ctx = ServerContext::new("0.22.1-test", "test-host");

        // 1. Handshake.
        let init = JsonRpcRequest::new(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientName": "helmor-loopback-test",
                "clientVersion": "0.0.1",
            }),
            JsonRpcId::Num(1),
        );
        let init_resp = round_trip(&ctx, &init).expect("response for initialize");
        let init_result: Value = init_resp.result.expect("ok response");
        assert_eq!(init_result["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(init_result["serverVersion"], "0.22.1-test");
        assert_eq!(init_result["hostname"], "test-host");

        // 2. Ping after handshake — server must echo the counter and
        // return a timestamp.
        let ping = JsonRpcRequest::new("ping", json!({ "counter": 7 }), JsonRpcId::Num(2));
        let ping_resp = round_trip(&ctx, &ping).expect("response for ping");
        let ping_result: Value = ping_resp.result.expect("ok response");
        assert_eq!(ping_result["counter"], 7);
        assert!(ping_result["serverTime"].as_str().unwrap().contains('T'));
    }

    #[test]
    fn ping_before_handshake_round_trips_a_not_initialized_error() {
        let ctx = ServerContext::new("0.22.1-test", "test-host");
        let ping = JsonRpcRequest::new("ping", json!({}), JsonRpcId::Num(1));
        let resp = round_trip(&ctx, &ping).expect("response for premature ping");
        let err = resp.error.expect("error response");
        assert_eq!(err.code, protocol::error_codes::NOT_INITIALIZED);
    }

    #[test]
    fn notification_round_trip_produces_no_response_frame() {
        let ctx = ServerContext::new("0.22.1-test", "test-host");
        // Notification = no `id`. The binary's main loop should skip
        // the write entirely.
        let notif = JsonRpcRequest::new("ping", json!({}), JsonRpcId::Null);
        let resp = round_trip(&ctx, &notif);
        assert!(resp.is_none());
    }
}
