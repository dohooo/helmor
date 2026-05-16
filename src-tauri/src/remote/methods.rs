//! RPC method catalogue.
//!
//! Each method is a typed `(params, result)` pair so the server and
//! client agree on shape at compile time, not at JSON-parse time.
//! Adding a new method is:
//!
//! 1. Define its `Params` + `Result` structs in this file.
//! 2. Add a [`Method`] enum variant that names it.
//! 3. Register a handler in [`super::server::dispatch_request`].
//!
//! The cap on methods this slice adds is intentionally small —
//! `initialize` (handshake) and `ping` (liveness probe). The richer
//! workspace / script / sidecar method set is layered on by later
//! phases of the remote-runner work.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// All methods the protocol recognises. Used by the client side to
/// type-check requests and by the server side to dispatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// Mandatory handshake. Carries the client's protocol version;
    /// the server rejects with `IncompatibleProtocol` if the major
    /// version doesn't match.
    Initialize,
    /// Cheap liveness probe. Client → server, server echoes a
    /// counter so latency / liveness can be measured without
    /// touching the workspace state.
    Ping,
    /// Read-only `git status` projection for a workspace. First
    /// real method on the trait seam — proves the local impl
    /// and the dispatch layer work end-to-end before the SSH
    /// transport lands.
    WorkspaceStatus,
    /// Read-only "where am I?" probe: current branch, head
    /// commit, and upstream tracking ref (when one exists).
    /// Layered alongside `workspace.status` so the dev panel
    /// can answer both "what's dirty?" and "where am I?" without
    /// shelling out to two separate transports.
    WorkspaceBranchInfo,
    /// Open a PTY-backed shell on the server, keyed by a
    /// client-chosen `terminal_id`. Output is pushed back as
    /// `terminal.event` notifications.
    TerminalOpen,
    /// Write bytes to an open terminal's stdin (PTY master).
    TerminalWrite,
    /// Resize an open terminal's PTY (cols, rows).
    TerminalResize,
    /// Kill + reap an open terminal. Idempotent: closing an
    /// already-gone terminal is a no-op.
    TerminalClose,
}

impl Method {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Initialize => "initialize",
            Self::Ping => "ping",
            Self::WorkspaceStatus => "workspace.status",
            Self::WorkspaceBranchInfo => "workspace.branchInfo",
            Self::TerminalOpen => "terminal.open",
            Self::TerminalWrite => "terminal.write",
            Self::TerminalResize => "terminal.resize",
            Self::TerminalClose => "terminal.close",
        }
    }
}

/// Surfaced when [`Method::from_str`] receives a method name the
/// protocol doesn't recognise. Carried out of the dispatcher as
/// JSON-RPC `METHOD_NOT_FOUND`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownMethod(pub String);

impl fmt::Display for UnknownMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown remote method: {:?}", self.0)
    }
}

impl std::error::Error for UnknownMethod {}

impl FromStr for Method {
    type Err = UnknownMethod;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "initialize" => Ok(Self::Initialize),
            "ping" => Ok(Self::Ping),
            "workspace.status" => Ok(Self::WorkspaceStatus),
            "workspace.branchInfo" => Ok(Self::WorkspaceBranchInfo),
            "terminal.open" => Ok(Self::TerminalOpen),
            "terminal.write" => Ok(Self::TerminalWrite),
            "terminal.resize" => Ok(Self::TerminalResize),
            "terminal.close" => Ok(Self::TerminalClose),
            _ => Err(UnknownMethod(value.to_string())),
        }
    }
}

/// Helper trait so both sides can talk about a method by its strongly
/// typed param/result shapes. Server code uses it to deserialise
/// params; client code uses it to build a typed request.
pub trait RpcMethod {
    const NAME: &'static str;
    type Params: Serialize + for<'de> Deserialize<'de>;
    type Result: Serialize + for<'de> Deserialize<'de>;
}

// ── initialize ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// Protocol version the client speaks (matches
    /// [`super::protocol::PROTOCOL_VERSION`] for compatible peers).
    pub protocol_version: String,
    /// Human-readable client name. Logged on the server side so a
    /// remote operator can tell who connected.
    pub client_name: String,
    /// Optional client build version. Surfaced in `tracing` logs and
    /// in future diagnostics commands. `None` for ad-hoc clients
    /// (CLI probes, tests).
    #[serde(default)]
    pub client_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    /// Protocol version the server speaks. Client must verify the
    /// majors match before continuing.
    pub protocol_version: String,
    /// Server binary's package version (e.g. `0.22.1`). Used for
    /// future deprecation messaging.
    pub server_version: String,
    /// Free-form server hostname / label for the UI. Today this is
    /// `hostname` on Unix; later phases may surface a user-set name.
    pub hostname: String,
}

pub struct InitializeMethod;
impl RpcMethod for InitializeMethod {
    const NAME: &'static str = "initialize";
    type Params = InitializeParams;
    type Result = InitializeResult;
}

// ── ping ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingParams {
    /// Opaque counter the client increments so its echo loop can
    /// pair responses with requests without leaning on JSON-RPC
    /// `id`. Useful when the client side multiplexes ping with
    /// other traffic on the same pipe.
    #[serde(default)]
    pub counter: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    /// Echo of the counter the client sent.
    pub counter: u64,
    /// Server-side timestamp (RFC 3339, millisecond precision).
    /// Surfaced in the connection-health panel and useful for
    /// debugging time-skew issues over SSH.
    pub server_time: String,
}

pub struct PingMethod;
impl RpcMethod for PingMethod {
    const NAME: &'static str = "ping";
    type Params = PingParams;
    type Result = PingResult;
}

// ── workspace.status ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusParams {
    /// Absolute filesystem path to the workspace directory. For the
    /// SSH transport, this is interpreted on the *server's* filesystem
    /// — clients can't pass local paths verbatim and expect them to
    /// resolve. A later phase will likely replace this with a logical
    /// workspace identifier resolved server-side.
    pub workspace_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusResult {
    /// True iff `git status --porcelain --untracked-files=normal`
    /// produced no output. Equivalent to "nothing staged, unstaged,
    /// or untracked".
    pub is_clean: bool,
    /// Paths from porcelain output, sorted + deduped. Status code
    /// prefixes are stripped — the UI just needs the set of changed
    /// files for a count or list.
    pub changed_paths: Vec<String>,
}

pub struct WorkspaceStatusMethod;
impl RpcMethod for WorkspaceStatusMethod {
    const NAME: &'static str = "workspace.status";
    type Params = WorkspaceStatusParams;
    type Result = WorkspaceStatusResult;
}

// ── workspace.branchInfo ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranchInfoParams {
    /// Absolute filesystem path to the workspace directory.
    /// Interpreted on the runtime's *own* filesystem — the SSH
    /// transport passes it verbatim and expects the server to
    /// resolve it under its own root.
    pub workspace_dir: String,
}

/// Read-only "where am I?" projection. All three fields come from
/// well-defined `git rev-parse` / `git symbolic-ref` invocations on
/// the local impl, so the shape is the same whether the runtime is
/// local or routed over SSH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBranchInfoResult {
    /// Branch name (`git symbolic-ref --short HEAD`). The trimmed
    /// branch name as the user would read it, e.g. `feature/foo`.
    /// Empty string when HEAD is detached — preserved as-is rather
    /// than turned into a synthetic name so callers can detect the
    /// detached state.
    pub current_branch: String,
    /// HEAD commit SHA-1 (`git rev-parse HEAD`). Always populated
    /// for a non-empty repository.
    pub head_commit: String,
    /// Upstream tracking ref (`branch.<name>.merge` + `branch.<name>.remote`),
    /// rendered as `<remote>/<branch>`. `None` when the current
    /// branch isn't tracking anything (e.g. fresh local branch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_ref: Option<String>,
}

pub struct WorkspaceBranchInfoMethod;
impl RpcMethod for WorkspaceBranchInfoMethod {
    const NAME: &'static str = "workspace.branchInfo";
    type Params = WorkspaceBranchInfoParams;
    type Result = WorkspaceBranchInfoResult;
}

// ── terminal.* ────────────────────────────────────────────────────

/// Method name for server→client terminal output. Not an RpcMethod
/// (no Params/Result pair — it's a notification, not a call) but
/// pinned as a `const` so client + server agree on the wire string.
pub const TERMINAL_EVENT_METHOD: &str = "terminal.event";

/// Wire shape for an `terminal.open` request. `terminalId` is
/// caller-chosen so the client can route incoming
/// `terminal.event` notifications to the right consumer without
/// waiting for the open call's reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenParams {
    /// Stable identifier the client picks (any non-empty string;
    /// typically a UUID). All subsequent terminal.write / .resize /
    /// .close calls and the terminal.event notifications carry the
    /// same id so multiple terminals per remote can interleave on
    /// one pipe.
    pub terminal_id: String,
    /// Where to spawn the shell, on the server's filesystem.
    pub workspace_dir: String,
    /// Override the shell binary. `None` → `$SHELL` on the remote,
    /// falling back to `/bin/sh` if it isn't set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Initial PTY size. xterm-256color defaults are 80×24 but the
    /// frontend almost always knows its actual viewport — pass it
    /// so the shell's first prompt renders at the right width.
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenResult {
    /// PID of the spawned shell. Returned so the UI can show it in
    /// diagnostics; nothing in the client *needs* it for routing
    /// (terminal_id does that).
    pub pid: u32,
}

pub struct TerminalOpenMethod;
impl RpcMethod for TerminalOpenMethod {
    const NAME: &'static str = "terminal.open";
    type Params = TerminalOpenParams;
    type Result = TerminalOpenResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteParams {
    pub terminal_id: String,
    /// UTF-8 string sent to the PTY master verbatim. The frontend
    /// is responsible for appending `\r` / `\n` (terminals expect
    /// `\r` for "enter", not `\n`).
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteResult {
    /// Bytes actually written. Should equal `data.len()` on success;
    /// a partial write indicates buffer pressure the client can
    /// retry on.
    pub bytes_written: usize,
}

pub struct TerminalWriteMethod;
impl RpcMethod for TerminalWriteMethod {
    const NAME: &'static str = "terminal.write";
    type Params = TerminalWriteParams;
    type Result = TerminalWriteResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalResizeResult {}

pub struct TerminalResizeMethod;
impl RpcMethod for TerminalResizeMethod {
    const NAME: &'static str = "terminal.resize";
    type Params = TerminalResizeParams;
    type Result = TerminalResizeResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseParams {
    pub terminal_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCloseResult {}

pub struct TerminalCloseMethod;
impl RpcMethod for TerminalCloseMethod {
    const NAME: &'static str = "terminal.close";
    type Params = TerminalCloseParams;
    type Result = TerminalCloseResult;
}

/// Notification payload pushed via `Notifier::notify(TERMINAL_EVENT_METHOD, ...)`.
/// Internally tagged by `kind` so the frontend can discriminate
/// stdout / exit / error without sniffing absent fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEventKind {
    /// Chunk of bytes from the PTY master. Encoded as a UTF-8
    /// string with `String::from_utf8_lossy` on the server — invalid
    /// sequences become `\u{FFFD}` rather than dropping the chunk.
    Stdout { data: String },
    /// Process exited (or was killed). `code` is `Some(0..=255)` for
    /// a normal exit, `None` if the process was killed by a signal
    /// before we could read its status.
    Exited { code: Option<i32> },
    /// Server-side error during the lifetime of the session — e.g.
    /// the reader thread couldn't poll the master fd. The terminal
    /// is removed from the server's state by the time this fires.
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEventNotification {
    pub terminal_id: String,
    pub event: TerminalEventKind,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn method_enum_round_trips_through_strings() {
        for method in [
            Method::Initialize,
            Method::Ping,
            Method::WorkspaceStatus,
            Method::WorkspaceBranchInfo,
            Method::TerminalOpen,
            Method::TerminalWrite,
            Method::TerminalResize,
            Method::TerminalClose,
        ] {
            assert_eq!(method.as_str().parse::<Method>().ok(), Some(method));
        }
        assert!("not-a-method".parse::<Method>().is_err());
    }

    #[test]
    fn workspace_branch_info_wire_shapes_are_camel_case() {
        let params = WorkspaceBranchInfoParams {
            workspace_dir: "/tmp/example".into(),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"workspaceDir\""));

        let result = WorkspaceBranchInfoResult {
            current_branch: "main".into(),
            head_commit: "abc123".into(),
            upstream_ref: Some("origin/main".into()),
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"currentBranch\""));
        assert!(wire.contains("\"headCommit\""));
        assert!(wire.contains("\"upstreamRef\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
    }

    #[test]
    fn workspace_branch_info_omits_upstream_ref_when_absent() {
        // Tracking-less branches don't pretend to have an upstream
        // on the wire — the option is dropped via skip_serializing_if.
        let result = WorkspaceBranchInfoResult {
            current_branch: "feature/foo".into(),
            head_commit: "def456".into(),
            upstream_ref: None,
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(!wire.contains("upstreamRef"), "wire leaked None: {wire}");
    }

    #[test]
    fn workspace_status_wire_shapes_are_camel_case() {
        let params = WorkspaceStatusParams {
            workspace_dir: "/tmp/example".into(),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"workspaceDir\""));

        let result = WorkspaceStatusResult {
            is_clean: false,
            changed_paths: vec!["src/foo.rs".into()],
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"isClean\""));
        assert!(wire.contains("\"changedPaths\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
    }

    #[test]
    fn initialize_params_are_camel_case_on_the_wire() {
        let params = InitializeParams {
            protocol_version: "0.1.0".into(),
            client_name: "helmor".into(),
            client_version: Some("0.22.1".into()),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"protocolVersion\""));
        assert!(wire.contains("\"clientName\""));
        assert!(wire.contains("\"clientVersion\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
    }

    #[test]
    fn ping_counter_defaults_to_zero_when_absent() {
        // The client side often probes without setting a counter
        // (e.g. the first liveness check); the server should accept
        // that.
        let params: PingParams = serde_json::from_str("{}").unwrap();
        assert_eq!(params.counter, 0);
    }

    // ── terminal.* wire shapes ───────────────────────────────────

    #[test]
    fn terminal_open_params_round_trip_with_camel_case_keys() {
        let params = TerminalOpenParams {
            terminal_id: "term-1".into(),
            workspace_dir: "/home/me/repo".into(),
            shell: Some("/bin/zsh".into()),
            cols: 120,
            rows: 30,
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"terminalId\""));
        assert!(wire.contains("\"workspaceDir\""));
        assert!(wire.contains("\"shell\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
        let restored: TerminalOpenParams = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored.terminal_id, "term-1");
        assert_eq!(restored.cols, 120);
    }

    #[test]
    fn terminal_open_params_omit_shell_when_none() {
        let params = TerminalOpenParams {
            terminal_id: "t".into(),
            workspace_dir: "/tmp".into(),
            shell: None,
            cols: 80,
            rows: 24,
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(
            !wire.contains("shell"),
            "absent shell should be skipped: {wire}"
        );
    }

    #[test]
    fn terminal_event_notification_is_camel_case_internally_tagged() {
        // The frontend will branch on `event.kind === "stdout" |
        // "exited" | "error"` — same pattern as RuntimeKind/State.
        let stdout = TerminalEventNotification {
            terminal_id: "t".into(),
            event: TerminalEventKind::Stdout {
                data: "hello\n".into(),
            },
        };
        let wire = serde_json::to_value(&stdout).unwrap();
        assert_eq!(wire["terminalId"], "t");
        assert_eq!(wire["event"]["kind"], "stdout");
        assert_eq!(wire["event"]["data"], "hello\n");

        let exited = TerminalEventNotification {
            terminal_id: "t".into(),
            event: TerminalEventKind::Exited { code: Some(0) },
        };
        let wire = serde_json::to_value(&exited).unwrap();
        assert_eq!(wire["event"]["kind"], "exited");
        assert_eq!(wire["event"]["code"], 0);
    }

    #[test]
    fn terminal_write_result_carries_bytes_written() {
        let result = TerminalWriteResult { bytes_written: 7 };
        let wire = serde_json::to_value(&result).unwrap();
        assert_eq!(wire["bytesWritten"], 7);
    }

    #[test]
    fn terminal_resize_and_close_results_are_empty_objects() {
        // Both are no-payload methods on the success path; the
        // wire is a plain `{}`. Round-tripping `()` doesn't fit
        // serde_json's expectations, so dedicated empty structs
        // give us stable Display + a place to hang future fields.
        let resize_wire = serde_json::to_string(&TerminalResizeResult::default()).unwrap();
        assert_eq!(resize_wire, "{}");
        let close_wire = serde_json::to_string(&TerminalCloseResult::default()).unwrap();
        assert_eq!(close_wire, "{}");
    }
}
