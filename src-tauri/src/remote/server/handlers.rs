//! Per-method handler functions.
//!
//! Each handler is a small, pure function: `fn(ctx, params) ->
//! Result<R, JsonRpcError>`. The dispatcher in [`super::dispatch`]
//! owns the version-check gate, params deserialisation, and the
//! response envelope; handlers just translate to runtime / state
//! calls and wrap errors into `HANDLER_FAILED`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::remote::methods::{
    AgentAbortParams, AgentAbortResult, AgentAttachParams, AgentAttachResult, AgentListParams,
    AgentListResult, AgentSendParams, AgentSendResult, AgentSetAuthParams, AgentSetAuthResult,
    InitializeParams, InitializeResult, PingParams, PingResult, TerminalAttachParams,
    TerminalAttachResult, TerminalCloseParams, TerminalCloseResult, TerminalListParams,
    TerminalListResult, TerminalOpenParams, TerminalOpenResult, TerminalResizeParams,
    TerminalResizeResult, TerminalWriteParams, TerminalWriteResult, WorkspaceBranchInfoParams,
    WorkspaceBranchInfoResult, WorkspaceChangesParams, WorkspaceChangesResult,
    WorkspaceFileTreeParams, WorkspaceFileTreeResult, WorkspaceMutateFileParams,
    WorkspaceMutateFileResult, WorkspaceReadFileAtRefParams, WorkspaceReadFileAtRefResult,
    WorkspaceReadFileParams, WorkspaceStatFileParams, WorkspaceStatusParams, WorkspaceStatusResult,
};
use crate::remote::protocol::{error_codes, JsonRpcError, PROTOCOL_VERSION};

use super::ServerContext;

// ── protocol-level handlers ─────────────────────────────────────────

pub(super) fn handle_initialize(
    ctx: &ServerContext,
    params: InitializeParams,
) -> Result<InitializeResult, JsonRpcError> {
    if !major_versions_match(&params.protocol_version, PROTOCOL_VERSION) {
        return Err(JsonRpcError::new(
            error_codes::INCOMPATIBLE_PROTOCOL,
            format!(
                "incompatible protocol: client speaks {} but server speaks {}",
                params.protocol_version, PROTOCOL_VERSION
            ),
        ));
    }
    tracing::info!(
        client_name = %params.client_name,
        client_version = ?params.client_version,
        protocol = %params.protocol_version,
        "remote: initialize handshake accepted"
    );
    ctx.mark_initialized();
    Ok(InitializeResult {
        protocol_version: PROTOCOL_VERSION.to_string(),
        server_version: ctx.server_version().to_string(),
        hostname: ctx.hostname().to_string(),
    })
}

pub(super) fn handle_ping(params: PingParams) -> Result<PingResult, JsonRpcError> {
    use chrono::SecondsFormat;
    Ok(PingResult {
        counter: params.counter,
        server_time: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

// ── workspace metadata ──────────────────────────────────────────────

pub(super) fn handle_workspace_status(
    ctx: &ServerContext,
    params: WorkspaceStatusParams,
) -> Result<WorkspaceStatusResult, JsonRpcError> {
    let workspace_dir = PathBuf::from(&params.workspace_dir);
    ctx.runtime()
        .workspace_status(&workspace_dir)
        .map_err(|err| {
            // Funnel anyhow into HANDLER_FAILED so the client can
            // distinguish "your params were wrong" (INVALID_PARAMS)
            // from "git itself blew up" (HANDLER_FAILED).
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("workspace.status failed: {err:#}"),
            )
        })
}

pub(super) fn handle_workspace_branch_info(
    ctx: &ServerContext,
    params: WorkspaceBranchInfoParams,
) -> Result<WorkspaceBranchInfoResult, JsonRpcError> {
    let workspace_dir = PathBuf::from(&params.workspace_dir);
    ctx.runtime()
        .workspace_branch_info(&workspace_dir)
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("workspace.branchInfo failed: {err:#}"),
            )
        })
}

// ── terminal ────────────────────────────────────────────────────────

pub(super) fn handle_terminal_open(
    ctx: &ServerContext,
    params: TerminalOpenParams,
) -> Result<TerminalOpenResult, JsonRpcError> {
    ctx.terminal_state()
        .open(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("terminal.open failed: {err:#}"),
            )
        })
}

pub(super) fn handle_terminal_write(
    ctx: &ServerContext,
    params: TerminalWriteParams,
) -> Result<TerminalWriteResult, JsonRpcError> {
    ctx.terminal_state().write(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("terminal.write failed: {err:#}"),
        )
    })
}

pub(super) fn handle_terminal_resize(
    ctx: &ServerContext,
    params: TerminalResizeParams,
) -> Result<TerminalResizeResult, JsonRpcError> {
    ctx.terminal_state().resize(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("terminal.resize failed: {err:#}"),
        )
    })
}

pub(super) fn handle_terminal_close(
    ctx: &ServerContext,
    params: TerminalCloseParams,
) -> Result<TerminalCloseResult, JsonRpcError> {
    ctx.terminal_state().close(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("terminal.close failed: {err:#}"),
        )
    })
}

pub(super) fn handle_terminal_list(
    ctx: &ServerContext,
    _params: TerminalListParams,
) -> Result<TerminalListResult, JsonRpcError> {
    // `list` is infallible — it just snapshots in-memory state.
    Ok(ctx.terminal_state().list())
}

pub(super) fn handle_terminal_attach(
    ctx: &ServerContext,
    params: TerminalAttachParams,
) -> Result<TerminalAttachResult, JsonRpcError> {
    ctx.terminal_state()
        .attach(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("terminal.attach failed: {err:#}"),
            )
        })
}

// ── workspace inspector ops (phase 20a — pure delegation) ───────────
//
// Each handler just forwards to `ctx.runtime().workspace_*`. The
// default trait impl bails until phase 20b backs `LocalRuntime` with
// real reads / writes — at which point the same handler keeps working
// without changes here.

pub(super) fn handle_workspace_file_tree(
    ctx: &ServerContext,
    params: WorkspaceFileTreeParams,
) -> Result<WorkspaceFileTreeResult, JsonRpcError> {
    ctx.runtime().workspace_file_tree(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.fileTree failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_changes(
    ctx: &ServerContext,
    params: WorkspaceChangesParams,
) -> Result<WorkspaceChangesResult, JsonRpcError> {
    ctx.runtime().workspace_changes(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.changes failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_read_file(
    ctx: &ServerContext,
    params: WorkspaceReadFileParams,
) -> Result<crate::workspace::files::EditorFileReadResponse, JsonRpcError> {
    ctx.runtime().workspace_read_file(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.readFile failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_read_file_at_ref(
    ctx: &ServerContext,
    params: WorkspaceReadFileAtRefParams,
) -> Result<WorkspaceReadFileAtRefResult, JsonRpcError> {
    ctx.runtime()
        .workspace_read_file_at_ref(params)
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("workspace.readFileAtRef failed: {err:#}"),
            )
        })
}

pub(super) fn handle_workspace_stat_file(
    ctx: &ServerContext,
    params: WorkspaceStatFileParams,
) -> Result<crate::workspace::files::EditorFileStatResponse, JsonRpcError> {
    ctx.runtime().workspace_stat_file(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.statFile failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_mutate_file(
    ctx: &ServerContext,
    params: WorkspaceMutateFileParams,
) -> Result<WorkspaceMutateFileResult, JsonRpcError> {
    ctx.runtime().workspace_mutate_file(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.mutateFile failed: {err:#}"),
        )
    })
}

// ── agent surfaces (phase 23b) ──────────────────────────────────────
//
// Agent handlers route directly to `ctx.agent_state()` (the sidecar
// bridge), not through `ctx.runtime()`. The runtime trait's agent_*
// methods stay as the desktop-side delegation surface —
// `RemoteSshRuntime` calls into them, and the wire lands here. Mirrors
// the pattern terminal handlers use: state holding owned subprocesses
// lives on the context, not the runtime.

pub(super) fn handle_agent_send(
    ctx: &ServerContext,
    params: AgentSendParams,
) -> Result<AgentSendResult, JsonRpcError> {
    ctx.agent_state()
        .send(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("agent.send failed: {err:#}"),
            )
        })
}

pub(super) fn handle_agent_abort(
    ctx: &ServerContext,
    params: AgentAbortParams,
) -> Result<AgentAbortResult, JsonRpcError> {
    ctx.agent_state().abort(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("agent.abort failed: {err:#}"),
        )
    })
}

pub(super) fn handle_agent_list(
    ctx: &ServerContext,
    _params: AgentListParams,
) -> Result<AgentListResult, JsonRpcError> {
    // `list` is infallible — it just snapshots in-memory state.
    Ok(ctx.agent_state().list())
}

pub(super) fn handle_agent_attach(
    ctx: &ServerContext,
    params: AgentAttachParams,
) -> Result<AgentAttachResult, JsonRpcError> {
    ctx.agent_state()
        .attach(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("agent.attach failed: {err:#}"),
            )
        })
}

pub(super) fn handle_agent_set_auth(
    ctx: &ServerContext,
    params: AgentSetAuthParams,
) -> Result<AgentSetAuthResult, JsonRpcError> {
    ctx.agent_state().set_auth(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("agent.setAuth failed: {err:#}"),
        )
    })
}

// ── helpers ─────────────────────────────────────────────────────────

/// Two semver strings are protocol-compatible iff their *major*
/// segments match. Anything below `1.0` is treated as a pre-release
/// where every published version is its own major (i.e. `0.1.x` is
/// incompatible with `0.2.x`).
pub(super) fn major_versions_match(left: &str, right: &str) -> bool {
    fn major_pair(v: &str) -> Option<(&str, &str)> {
        let mut parts = v.splitn(3, '.');
        let major = parts.next()?;
        let minor = parts.next()?;
        Some((major, minor))
    }
    match (major_pair(left), major_pair(right)) {
        (Some((lm, ln)), Some((rm, rn))) => {
            if lm != rm {
                return false;
            }
            // Pre-1.0: minor is the effective compatibility line.
            if lm == "0" {
                return ln == rn;
            }
            true
        }
        _ => false,
    }
}
