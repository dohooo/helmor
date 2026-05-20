//! Headless remote daemon (F1 upstream slice).
//!
//! `helmor-server` is the binary that runs on a remote host so a
//! Helmor desktop can render its UI locally while the workspace,
//! terminals, and agents live elsewhere — analogous to Zed's remote
//! development, JetBrains Gateway, or VS Code Remote-SSH (issue
//! #453).
//!
//! This module hosts the JSON-RPC framing + dispatch surface the
//! daemon serves. F1 lands the foundation:
//!
//! - Wire envelope: JSON-RPC 2.0 over newline-delimited stdin/stdout.
//! - Protocol version handshake (`initialize`).
//! - Two read-only methods (`ping`, `runtime.health`) so an operator
//!   can verify the binary is alive + which host it's running on.
//! - No SSH transport, no agent bridge, no workspace ops — those land
//!   in F2-F7 once F1 is reviewed + merged.
//!
//! The architecture this slice is the first step of is documented in
//! `docs/remote-server-architecture.md`.

pub mod protocol;
pub mod server;

pub use protocol::{
    read_frame, write_frame, FrameError, JsonRpcError, JsonRpcId, JsonRpcMessage, JsonRpcRequest,
    JsonRpcResponse, PROTOCOL_VERSION,
};
pub use server::{dispatch_request, ServerContext};
