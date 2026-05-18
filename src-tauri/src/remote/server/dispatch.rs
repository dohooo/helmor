//! Request dispatch table.
//!
//! [`dispatch_request`] is the seam every RPC method funnels through:
//! it owns the version-check gate, the params deserialisation, and
//! the result envelope. Handlers in [`super::handlers`] stay tiny
//! and pure (`fn(ctx, params) -> Result<R, JsonRpcError>`); the
//! dispatcher binds them to method names and shuttles
//! serde_json::Value back and forth.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::remote::methods::{
    AgentAbortMethod, AgentAttachMethod, AgentListMethod, AgentSendMethod, AgentSetAuthMethod,
    InitializeMethod, Method, PingMethod, RpcMethod, TerminalAttachMethod, TerminalCloseMethod,
    TerminalListMethod, TerminalOpenMethod, TerminalResizeMethod, TerminalWriteMethod,
    WorkspaceBranchInfoMethod, WorkspaceChangesMethod, WorkspaceFileTreeMethod,
    WorkspaceMutateFileMethod, WorkspaceReadFileAtRefMethod, WorkspaceReadFileMethod,
    WorkspaceStatFileMethod, WorkspaceStatusMethod,
};
use crate::remote::protocol::{
    error_codes, JsonRpcError, JsonRpcId, JsonRpcRequest, JsonRpcResponse,
};

use super::handlers::{
    handle_agent_abort, handle_agent_attach, handle_agent_list, handle_agent_send,
    handle_agent_set_auth, handle_initialize, handle_ping, handle_terminal_attach,
    handle_terminal_close, handle_terminal_list, handle_terminal_open, handle_terminal_resize,
    handle_terminal_write, handle_workspace_branch_info, handle_workspace_changes,
    handle_workspace_file_tree, handle_workspace_mutate_file, handle_workspace_read_file,
    handle_workspace_read_file_at_ref, handle_workspace_stat_file, handle_workspace_status,
};
use super::ServerContext;

/// Decode a JSON-RPC request, dispatch to the matching handler, and
/// build the response envelope. Notifications (id absent) get `None`
/// back so the binary's write loop skips the response write.
pub fn dispatch_request(ctx: &ServerContext, req: JsonRpcRequest) -> Option<JsonRpcResponse> {
    let id = req.id.clone();
    let method: Method = match req.method.parse() {
        Ok(m) => m,
        Err(_) => {
            return wrap_error(
                &id,
                error_codes::METHOD_NOT_FOUND,
                format!("unknown method: {}", req.method),
            );
        }
    };

    // The handshake gate: every non-`initialize` method requires
    // initialization to have happened first.
    if method != Method::Initialize && !ctx.is_initialized() {
        return wrap_error(
            &id,
            error_codes::NOT_INITIALIZED,
            "client must call `initialize` before any other method",
        );
    }

    let outcome: Result<Value, JsonRpcError> = match method {
        Method::Initialize => {
            handle::<InitializeMethod, _>(req.params, |params| handle_initialize(ctx, params))
        }
        Method::Ping => handle::<PingMethod, _>(req.params, handle_ping),
        Method::WorkspaceStatus => handle::<WorkspaceStatusMethod, _>(req.params, |params| {
            handle_workspace_status(ctx, params)
        }),
        Method::WorkspaceBranchInfo => {
            handle::<WorkspaceBranchInfoMethod, _>(req.params, |params| {
                handle_workspace_branch_info(ctx, params)
            })
        }
        Method::TerminalOpen => {
            handle::<TerminalOpenMethod, _>(req.params, |params| handle_terminal_open(ctx, params))
        }
        Method::TerminalWrite => handle::<TerminalWriteMethod, _>(req.params, |params| {
            handle_terminal_write(ctx, params)
        }),
        Method::TerminalResize => handle::<TerminalResizeMethod, _>(req.params, |params| {
            handle_terminal_resize(ctx, params)
        }),
        Method::TerminalClose => handle::<TerminalCloseMethod, _>(req.params, |params| {
            handle_terminal_close(ctx, params)
        }),
        Method::TerminalList => {
            handle::<TerminalListMethod, _>(req.params, |params| handle_terminal_list(ctx, params))
        }
        Method::TerminalAttach => handle::<TerminalAttachMethod, _>(req.params, |params| {
            handle_terminal_attach(ctx, params)
        }),
        Method::WorkspaceFileTree => handle::<WorkspaceFileTreeMethod, _>(req.params, |params| {
            handle_workspace_file_tree(ctx, params)
        }),
        Method::WorkspaceChanges => handle::<WorkspaceChangesMethod, _>(req.params, |params| {
            handle_workspace_changes(ctx, params)
        }),
        Method::WorkspaceReadFile => handle::<WorkspaceReadFileMethod, _>(req.params, |params| {
            handle_workspace_read_file(ctx, params)
        }),
        Method::WorkspaceReadFileAtRef => {
            handle::<WorkspaceReadFileAtRefMethod, _>(req.params, |params| {
                handle_workspace_read_file_at_ref(ctx, params)
            })
        }
        Method::WorkspaceStatFile => handle::<WorkspaceStatFileMethod, _>(req.params, |params| {
            handle_workspace_stat_file(ctx, params)
        }),
        Method::WorkspaceMutateFile => {
            handle::<WorkspaceMutateFileMethod, _>(req.params, |params| {
                handle_workspace_mutate_file(ctx, params)
            })
        }
        Method::AgentSend => {
            handle::<AgentSendMethod, _>(req.params, |params| handle_agent_send(ctx, params))
        }
        Method::AgentAbort => {
            handle::<AgentAbortMethod, _>(req.params, |params| handle_agent_abort(ctx, params))
        }
        Method::AgentList => {
            handle::<AgentListMethod, _>(req.params, |params| handle_agent_list(ctx, params))
        }
        Method::AgentAttach => {
            handle::<AgentAttachMethod, _>(req.params, |params| handle_agent_attach(ctx, params))
        }
        Method::AgentSetAuth => {
            handle::<AgentSetAuthMethod, _>(req.params, |params| handle_agent_set_auth(ctx, params))
        }
    };

    let response = match outcome {
        Ok(result) => JsonRpcResponse::success(id.clone(), result),
        Err(err) => JsonRpcResponse::failure(id.clone(), err),
    };
    if id.is_notification() {
        // Per JSON-RPC: notifications never get a response, even on
        // error. We still run the handler for its side effects.
        None
    } else {
        Some(response)
    }
}

/// Adapt a strongly-typed handler `fn(params) -> Result<R, JsonRpcError>`
/// to the dynamic params/value pipeline the dispatcher operates on.
fn handle<M, F>(params: Value, handler: F) -> Result<Value, JsonRpcError>
where
    M: RpcMethod,
    F: FnOnce(M::Params) -> Result<M::Result, JsonRpcError>,
    M::Params: DeserializeOwned,
    M::Result: Serialize,
{
    let parsed: M::Params = if params.is_null() {
        // No params at all — try to decode an empty object so methods
        // with optional fields still work.
        serde_json::from_value(Value::Object(Default::default())).map_err(|err| {
            JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                format!("missing params for method `{}`: {err}", M::NAME),
            )
        })?
    } else {
        serde_json::from_value(params).map_err(|err| {
            JsonRpcError::new(
                error_codes::INVALID_PARAMS,
                format!("invalid params for method `{}`: {err}", M::NAME),
            )
        })?
    };
    let result = handler(parsed)?;
    serde_json::to_value(&result).map_err(|err| {
        JsonRpcError::new(
            error_codes::INTERNAL_ERROR,
            format!("failed to serialise result for `{}`: {err}", M::NAME),
        )
    })
}

fn wrap_error(id: &JsonRpcId, code: i32, message: impl Into<String>) -> Option<JsonRpcResponse> {
    if id.is_notification() {
        // Errors on notifications are dropped silently — JSON-RPC
        // does not allow responding to a notification at all.
        return None;
    }
    Some(JsonRpcResponse::failure(
        id.clone(),
        JsonRpcError::new(code, message),
    ))
}
