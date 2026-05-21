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
    AgentAbortParams, AgentAbortResult, AgentAttachParams, AgentAttachResult,
    AgentAuthStatusParams, AgentAuthStatusResult, AgentListParams, AgentListResult,
    AgentSendParams, AgentSendResult, AgentSetAuthParams, AgentSetAuthResult, DaemonTailLogParams,
    DaemonTailLogResult, InitializeParams, InitializeResult, PingParams, PingResult,
    RuntimeMetricsParams, RuntimeMetricsResult, TerminalAttachParams, TerminalAttachResult,
    TerminalCloseParams, TerminalCloseResult, TerminalListParams, TerminalListResult,
    TerminalOpenParams, TerminalOpenResult, TerminalResizeParams, TerminalResizeResult,
    TerminalWriteParams, TerminalWriteResult, WorkspaceBranchInfoParams, WorkspaceBranchInfoResult,
    WorkspaceBundleParams, WorkspaceBundleResult, WorkspaceChangesParams, WorkspaceChangesResult,
    WorkspaceFileTreeParams, WorkspaceFileTreeResult, WorkspaceMutateFileParams,
    WorkspaceMutateFileResult, WorkspaceReadFileAtRefParams, WorkspaceReadFileAtRefResult,
    WorkspaceReadFileParams, WorkspaceSearchParams, WorkspaceSearchResult,
    WorkspaceStartWatchParams, WorkspaceStartWatchResult, WorkspaceStatFileParams,
    WorkspaceStatusParams, WorkspaceStatusResult, WorkspaceStopWatchParams,
    WorkspaceStopWatchResult, WorkspaceUnbundleParams, WorkspaceUnbundleResult,
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

/// Track E2 + E4: snapshot the daemon's per-method RPC metrics and
/// recent restart timestamps. The desktop's runtime debug panel
/// renders the metrics table + a "crashed N times in 5 min" warning
/// when `recent_starts_ms` exceeds the operator-configured threshold.
pub(super) fn handle_runtime_metrics(
    ctx: &ServerContext,
    _params: RuntimeMetricsParams,
) -> Result<RuntimeMetricsResult, JsonRpcError> {
    Ok(RuntimeMetricsResult {
        methods: ctx.metrics().snapshot(),
        uptime_secs: ctx.uptime().as_secs(),
        recent_starts_ms: crate::remote::server::crash_history::recent_starts_ms(5 * 60 * 1000),
    })
}

/// Track E1: read the trailing `max_lines` lines of the daemon's
/// log file. Capped at 1000 lines server-side so a runaway client
/// can't ask for an unbounded payload. `truncated=true` signals the
/// file has more content than the cap allowed.
pub(super) fn handle_daemon_tail_log(
    params: DaemonTailLogParams,
) -> Result<DaemonTailLogResult, JsonRpcError> {
    use std::io::{BufRead, BufReader, Seek, SeekFrom};

    const HARD_LIMIT: u32 = 1000;
    let max_lines = params.max_lines.min(HARD_LIMIT);

    let path = match crate::remote::daemon::default_log_path() {
        Ok(p) => p,
        Err(err) => {
            return Err(JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("daemon.tailLog: resolve log path: {err:#}"),
            ));
        }
    };
    let log_path = path.display().to_string();

    // No file yet → return an empty tail rather than erroring. The
    // daemon may simply not have logged anything in this session.
    if !path.exists() {
        return Ok(DaemonTailLogResult {
            log_path,
            lines: Vec::new(),
            truncated: false,
        });
    }
    if max_lines == 0 {
        return Ok(DaemonTailLogResult {
            log_path,
            lines: Vec::new(),
            truncated: true,
        });
    }

    // Tail strategy: read the file via a buffered ring of the last
    // `max_lines` lines. For typical daemon logs (KB to a few MB)
    // this is fast enough + bounded in memory. A future
    // optimisation could seek-from-end for huge logs.
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(err) => {
            return Err(JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("daemon.tailLog: open {log_path}: {err}"),
            ));
        }
    };
    let file_len = file.seek(SeekFrom::End(0)).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("daemon.tailLog: stat {log_path}: {err}"),
        )
    })?;
    file.seek(SeekFrom::Start(0)).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("daemon.tailLog: rewind {log_path}: {err}"),
        )
    })?;

    let reader = BufReader::new(file);
    let mut ring: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(max_lines as usize);
    let mut total_lines: u64 = 0;
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(err) => {
                tracing::warn!(
                    log_path = %log_path,
                    error = %err,
                    "daemon.tailLog: read error; returning partial tail",
                );
                break;
            }
        };
        total_lines += 1;
        if ring.len() == max_lines as usize {
            ring.pop_front();
        }
        ring.push_back(line);
    }
    let truncated = total_lines > max_lines as u64 || file_len > 0 && ring.is_empty();
    Ok(DaemonTailLogResult {
        log_path,
        lines: ring.into_iter().collect(),
        truncated,
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

pub(super) fn handle_workspace_search(
    ctx: &ServerContext,
    params: WorkspaceSearchParams,
) -> Result<WorkspaceSearchResult, JsonRpcError> {
    ctx.runtime().workspace_search(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.search failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_bundle(
    ctx: &ServerContext,
    params: WorkspaceBundleParams,
) -> Result<WorkspaceBundleResult, JsonRpcError> {
    ctx.runtime().workspace_bundle(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.bundle failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_unbundle(
    ctx: &ServerContext,
    params: WorkspaceUnbundleParams,
) -> Result<WorkspaceUnbundleResult, JsonRpcError> {
    ctx.runtime().workspace_unbundle(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.unbundle failed: {err:#}"),
        )
    })
}

pub(super) fn handle_workspace_start_watch(
    ctx: &ServerContext,
    params: WorkspaceStartWatchParams,
) -> Result<WorkspaceStartWatchResult, JsonRpcError> {
    ctx.watch_state()
        .start_watch(params, Arc::clone(ctx.notifier()))
        .map_err(|err| {
            JsonRpcError::new(
                error_codes::HANDLER_FAILED,
                format!("workspace.startWatch failed: {err:#}"),
            )
        })
}

pub(super) fn handle_workspace_stop_watch(
    ctx: &ServerContext,
    params: WorkspaceStopWatchParams,
) -> Result<WorkspaceStopWatchResult, JsonRpcError> {
    ctx.watch_state().stop_watch(params).map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("workspace.stopWatch failed: {err:#}"),
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

/// Track G2 read side: snapshot which providers have a key configured
/// without ever revealing the key itself. The desktop renders the
/// presence bits as a chip on the remote-server row + as a
/// "Currently configured" line in the auth dialog.
pub(super) fn handle_agent_auth_status(
    ctx: &ServerContext,
    _params: AgentAuthStatusParams,
) -> Result<AgentAuthStatusResult, JsonRpcError> {
    ctx.agent_state().auth_status().map_err(|err| {
        JsonRpcError::new(
            error_codes::HANDLER_FAILED,
            format!("agent.authStatus failed: {err:#}"),
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
