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
    /// Enumerate every terminal currently alive on the server.
    /// Used by clients reconnecting to a daemon that outlived
    /// the previous SSH session — `terminal.attach` plugs back
    /// into a session listed here.
    TerminalList,
    /// Re-bind output for an existing terminal to the *calling*
    /// client. Returns the current scrollback buffer as a single
    /// initial chunk; subsequent stdout flows as `terminal.event`
    /// notifications addressed to this connection. "Last attach
    /// wins" — only one client at a time receives live events;
    /// previous subscribers stop seeing them (but the scrollback
    /// they already buffered is theirs to keep).
    TerminalAttach,
    /// Recursive listing of every file in a workspace, including
    /// untracked ones. Mirrors what the inspector's file-tree tab
    /// calls today (`list_workspace_files`).
    WorkspaceFileTree,
    /// `git status`-aware projection of the workspace: file paths +
    /// change classification + line counts. Optionally includes
    /// per-file content snapshots for the diff viewer.
    WorkspaceChanges,
    /// Read a single file's bytes. The wire result mirrors
    /// `EditorFileReadResponse`: path + content + mtime.
    WorkspaceReadFile,
    /// Project a single file's content at a git ref
    /// (`git show <ref>:<path>`). `None` means "ref or path
    /// didn't exist" — used by the diff viewer to detect
    /// added-since-ref files.
    WorkspaceReadFileAtRef,
    /// Lightweight existence/mode probe. Cheap — used by the
    /// editor when deciding whether to render a path as a file
    /// or a directory.
    WorkspaceStatFile,
    /// File-level write operation. The `action` field
    /// discriminates between Write (with content), Discard,
    /// Stage, and Unstage; folding them into one method keeps
    /// the catalogue narrow and adds further actions without
    /// growing the surface area.
    WorkspaceMutateFile,
    /// Forward an opaque `SidecarRequest` (sendMessage / abort /
    /// resolveUserInput / generateTitle / …) to the daemon's
    /// managed sidecar process. Events flow back as
    /// `agent.event` notifications keyed by the same
    /// `request_id` the client picked. Phase 23a: surface-only;
    /// the server-side bridge lands in 23b.
    AgentSend,
    /// Abort an active agent stream by `request_id`. Translates
    /// to the sidecar's own `abort` RPC on the daemon side.
    AgentAbort,
    /// Enumerate every agent session the daemon's sidecar is
    /// currently running. Used by reconnecting clients to
    /// discover orphan sessions they can `attach` to (mirrors
    /// `terminal.list`).
    AgentList,
    /// Re-bind the `agent.event` stream for an existing session
    /// to the calling client. Idempotent and "last attach wins"
    /// — the previous subscriber stops seeing live events. Used
    /// by reconnect flows and by tests.
    AgentAttach,
    /// Push an SDK API key + optional base URL into the daemon's
    /// secrets store. The daemon persists it to
    /// `$HOME/.helmor/server/secrets.json` (mode 0600) and hot-
    /// pushes it to the live sidecar via its `updateConfig` RPC.
    /// Keys never persist on the desktop side — phase 23d's
    /// design intent is "auth lives remote-only".
    AgentSetAuth,
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
            Self::TerminalList => "terminal.list",
            Self::TerminalAttach => "terminal.attach",
            Self::WorkspaceFileTree => "workspace.fileTree",
            Self::WorkspaceChanges => "workspace.changes",
            Self::WorkspaceReadFile => "workspace.readFile",
            Self::WorkspaceReadFileAtRef => "workspace.readFileAtRef",
            Self::WorkspaceStatFile => "workspace.statFile",
            Self::WorkspaceMutateFile => "workspace.mutateFile",
            Self::AgentSend => "agent.send",
            Self::AgentAbort => "agent.abort",
            Self::AgentList => "agent.list",
            Self::AgentAttach => "agent.attach",
            Self::AgentSetAuth => "agent.setAuth",
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
            "terminal.list" => Ok(Self::TerminalList),
            "terminal.attach" => Ok(Self::TerminalAttach),
            "workspace.fileTree" => Ok(Self::WorkspaceFileTree),
            "workspace.changes" => Ok(Self::WorkspaceChanges),
            "workspace.readFile" => Ok(Self::WorkspaceReadFile),
            "workspace.readFileAtRef" => Ok(Self::WorkspaceReadFileAtRef),
            "workspace.statFile" => Ok(Self::WorkspaceStatFile),
            "workspace.mutateFile" => Ok(Self::WorkspaceMutateFile),
            "agent.send" => Ok(Self::AgentSend),
            "agent.abort" => Ok(Self::AgentAbort),
            "agent.list" => Ok(Self::AgentList),
            "agent.attach" => Ok(Self::AgentAttach),
            "agent.setAuth" => Ok(Self::AgentSetAuth),
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

// ── terminal.list / terminal.attach ───────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TerminalListParams {}

/// Per-terminal metadata in the `terminal.list` response. Carries
/// the bits a reconnecting client needs to decide whether to
/// reattach: the terminal id (to pass to `terminal.attach`), the
/// shell's pid, the workspace dir it was opened against, and when
/// it was opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListEntry {
    pub terminal_id: String,
    pub pid: u32,
    pub workspace_dir: String,
    /// Unix epoch milliseconds when `terminal.open` ran. Lets the
    /// UI sort by "most recent" without per-client clocks.
    pub opened_at_ms: i64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListResult {
    pub terminals: Vec<TerminalListEntry>,
}

pub struct TerminalListMethod;
impl RpcMethod for TerminalListMethod {
    const NAME: &'static str = "terminal.list";
    type Params = TerminalListParams;
    type Result = TerminalListResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachParams {
    pub terminal_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    /// Scrollback bytes captured server-side since the last attach
    /// (or since `terminal.open` if this is the first attach).
    /// Encoded as a UTF-8 string with `from_utf8_lossy` to preserve
    /// ANSI escape sequences verbatim while still being JSON-safe.
    pub scrollback: String,
    /// The terminal's current size, in case the new client wants
    /// to resize its local view to match.
    pub cols: u16,
    pub rows: u16,
}

pub struct TerminalAttachMethod;
impl RpcMethod for TerminalAttachMethod {
    const NAME: &'static str = "terminal.attach";
    type Params = TerminalAttachParams;
    type Result = TerminalAttachResult;
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

// ── workspace.fileTree / .changes / .readFile / .readFileAtRef ────
// ── workspace.statFile / .mutateFile ──────────────────────────────
//
// These six methods make up phase 20's inspector lift. The result
// types re-use the existing `workspace::files::types` shapes —
// adding `Deserialize` + `PartialEq` to those types in phase 20 was
// enough; the wire IS that contract. Method-local Params + Result
// wrappers sit here so adding a future field (paging, filter,
// reflog-style metadata) doesn't churn the inspector's local types.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileTreeParams {
    /// Absolute filesystem path to the workspace, interpreted on
    /// the runtime's *own* filesystem (same shape as the existing
    /// `workspace.status` / `workspace.branchInfo` ops).
    pub workspace_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileTreeResult {
    pub entries: Vec<crate::workspace::files::EditorFileListItem>,
}

pub struct WorkspaceFileTreeMethod;
impl RpcMethod for WorkspaceFileTreeMethod {
    const NAME: &'static str = "workspace.fileTree";
    type Params = WorkspaceFileTreeParams;
    type Result = WorkspaceFileTreeResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangesParams {
    pub workspace_dir: String,
    /// When `true`, the result includes per-file content snapshots
    /// (HEAD / index / working copy) the diff viewer needs. When
    /// `false`, only the file list + status — much cheaper for the
    /// sidebar's hot path.
    pub include_content: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangesResult {
    pub items: Vec<crate::workspace::files::EditorFileListItem>,
    /// Per-file content snapshots, populated only when
    /// `include_content` was true on the request. Empty otherwise
    /// — the wire stays small without growing two parallel methods.
    #[serde(default)]
    pub prefetched: Vec<crate::workspace::files::EditorFilePrefetchItem>,
}

pub struct WorkspaceChangesMethod;
impl RpcMethod for WorkspaceChangesMethod {
    const NAME: &'static str = "workspace.changes";
    type Params = WorkspaceChangesParams;
    type Result = WorkspaceChangesResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReadFileParams {
    pub workspace_dir: String,
    /// Path relative to `workspace_dir`. Server resolves it
    /// against the workspace root and rejects anything that would
    /// escape (`..`, absolute paths, symlink redirects) — phase
    /// 20b adds the sandbox check.
    pub relative_path: String,
}

pub struct WorkspaceReadFileMethod;
impl RpcMethod for WorkspaceReadFileMethod {
    const NAME: &'static str = "workspace.readFile";
    type Params = WorkspaceReadFileParams;
    type Result = crate::workspace::files::EditorFileReadResponse;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReadFileAtRefParams {
    pub workspace_dir: String,
    pub relative_path: String,
    /// `HEAD`, `:0` (index), `origin/main`, … — passed verbatim
    /// to `git show <ref>:<path>` on the server side.
    pub git_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReadFileAtRefResult {
    /// `None` distinguishes "ref/path missing" (deleted file or
    /// path didn't exist at that ref) from an empty file. The
    /// inspector's diff viewer renders the missing-side as a
    /// stub when this is None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

pub struct WorkspaceReadFileAtRefMethod;
impl RpcMethod for WorkspaceReadFileAtRefMethod {
    const NAME: &'static str = "workspace.readFileAtRef";
    type Params = WorkspaceReadFileAtRefParams;
    type Result = WorkspaceReadFileAtRefResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatFileParams {
    pub workspace_dir: String,
    pub relative_path: String,
}

pub struct WorkspaceStatFileMethod;
impl RpcMethod for WorkspaceStatFileMethod {
    const NAME: &'static str = "workspace.statFile";
    type Params = WorkspaceStatFileParams;
    type Result = crate::workspace::files::EditorFileStatResponse;
}

/// Discriminator for `workspace.mutateFile`. `Write` carries the
/// new content; the git index ops (`Stage` / `Unstage`) and
/// `Discard` (revert to HEAD/index) are content-free.
///
/// Internally tagged so the wire looks like
/// `{"type":"write","content":"..."}` instead of an outer Object
/// with `action: "write"` and a separate `content` sibling — fewer
/// implicit-coupling rules for the frontend to remember.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceMutateFileAction {
    Write { content: String },
    Discard,
    Stage,
    Unstage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutateFileParams {
    pub workspace_dir: String,
    pub relative_path: String,
    pub action: WorkspaceMutateFileAction,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutateFileResult {
    /// Populated for the `Write` action (the file's new mtime).
    /// `None` for stage/unstage/discard, which don't return a
    /// file-level timestamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<i64>,
}

pub struct WorkspaceMutateFileMethod;
impl RpcMethod for WorkspaceMutateFileMethod {
    const NAME: &'static str = "workspace.mutateFile";
    type Params = WorkspaceMutateFileParams;
    type Result = WorkspaceMutateFileResult;
}

// ── agent.send / agent.abort / agent.list / agent.attach (phase 23a) ──
//
// `SidecarRequest` is the existing local-sidecar envelope (id + method
// + params). For the remote case the desktop forwards that envelope
// verbatim through `agent.send` and the daemon on the remote shovels
// it into its own sidecar's stdin. Events flow back as
// `agent.event` notifications carrying the raw `SidecarEvent` JSON
// keyed by the same `request_id` the client chose.
//
// Phase 23a is surface-only: the trait grows default-bailing methods,
// `RemoteSshRuntime` delegates via `client.call`, and the dispatcher
// returns `HANDLER_FAILED` until 23b wires `RemoteAgentState` on the
// daemon side. The wire shapes are locked in here so 23b can flip
// the implementation without re-touching the catalogue.

/// Method name for server→client agent events. Not an `RpcMethod`
/// (no Params/Result pair — it's a notification, not a call) but
/// pinned as a `const` so client + server agree on the wire string.
pub const AGENT_EVENT_METHOD: &str = "agent.event";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendParams {
    /// Client-chosen identifier. Mirrored on every `agent.event`
    /// notification the daemon emits in response, so multi-session
    /// clients can demux without a side-band map. Typically a UUID.
    pub request_id: String,
    /// Sidecar method name: `"sendMessage"`, `"abort"`, `"steer"`,
    /// `"resolveUserInput"`, `"getContextUsage"`,
    /// `"listSlashCommands"`, `"generateTitle"`. Forwarded verbatim
    /// into the daemon's `SidecarRequest.method` field.
    pub method: String,
    /// Sidecar method params. The daemon does not interpret the
    /// shape — it shovels the JSON straight to the sidecar's stdin.
    /// Keeping it `serde_json::Value` lets the catalogue stay stable
    /// across `claude-agent-sdk` upgrades that change param shapes.
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSendResult {
    /// `true` when the daemon accepted the request and forwarded it
    /// to the sidecar. Events flow asynchronously as `agent.event`
    /// notifications carrying the same `request_id`. `false` only
    /// arises if a future server-side gate (e.g. concurrent-session
    /// limit) rejects the request before it reaches the sidecar.
    pub accepted: bool,
}

pub struct AgentSendMethod;
impl RpcMethod for AgentSendMethod {
    const NAME: &'static str = "agent.send";
    type Params = AgentSendParams;
    type Result = AgentSendResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAbortParams {
    /// Identifier of the request to abort. Matches the
    /// `request_id` originally passed to `agent.send`.
    pub request_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAbortResult {}

pub struct AgentAbortMethod;
impl RpcMethod for AgentAbortMethod {
    const NAME: &'static str = "agent.abort";
    type Params = AgentAbortParams;
    type Result = AgentAbortResult;
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentListParams {}

/// Per-session metadata in the `agent.list` response. Carries the
/// bits a reconnecting client needs to decide whether to reattach.
/// Empty `helmor_session_id` / `provider` / `workspace_dir` fields
/// reflect requests the daemon accepted before the sidecar's
/// `system.init` event landed — the values are populated once the
/// sidecar reports them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionEntry {
    pub request_id: String,
    /// Helmor session id supplied by the desktop on the original
    /// `agent.send`. Daemon stashes it so a reconnecting client can
    /// surface "the dev.box session for workspace X is still alive."
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helmor_session_id: Option<String>,
    /// Provider name (`"claude"` / `"codex"` / `"cursor"`), parsed
    /// from the sidecar's `system.init` event. `None` until that
    /// event arrives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Working directory the agent is running against on the
    /// remote side. `None` until the sidecar's first event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_dir: Option<String>,
    /// Unix epoch milliseconds when the daemon accepted the request.
    pub started_at_ms: i64,
    /// Unix epoch milliseconds of the most recent event the daemon
    /// forwarded for this session. Lets a reconnecting client tell a
    /// dormant session from one mid-stream.
    pub last_event_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentListResult {
    pub sessions: Vec<AgentSessionEntry>,
}

pub struct AgentListMethod;
impl RpcMethod for AgentListMethod {
    const NAME: &'static str = "agent.list";
    type Params = AgentListParams;
    type Result = AgentListResult;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachParams {
    pub request_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachResult {
    /// `true` when the daemon swapped the per-request notifier to
    /// the calling client. `false` means the session expired or
    /// never existed on this daemon — the client should drop its
    /// local subscription rather than wait indefinitely.
    pub found: bool,
}

pub struct AgentAttachMethod;
impl RpcMethod for AgentAttachMethod {
    const NAME: &'static str = "agent.attach";
    type Params = AgentAttachParams;
    type Result = AgentAttachResult;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetAuthParams {
    /// Provider this secret applies to. Today: `"cursor"` (the only
    /// provider that reads its key from the desktop side); future
    /// custom Claude / Codex providers would extend this set.
    pub provider: String,
    /// `Some(_)` to set; `None` to clear. The daemon writes `null`
    /// to its on-disk store and pushes `{ cursorApiKey: null }` (or
    /// the provider-equivalent) to the live sidecar so the next
    /// call reverts to the unauthenticated state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Optional base URL — used by custom Claude providers that
    /// proxy through a different host. `None` for the default
    /// provider endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSetAuthResult {}

pub struct AgentSetAuthMethod;
impl RpcMethod for AgentSetAuthMethod {
    const NAME: &'static str = "agent.setAuth";
    type Params = AgentSetAuthParams;
    type Result = AgentSetAuthResult;
}

/// Notification payload pushed via
/// `Notifier::notify(AGENT_EVENT_METHOD, ...)`. The `event` field is
/// the *raw* `SidecarEvent` JSON — the daemon doesn't interpret it
/// so the desktop's existing accumulator + pipeline see byte-identical
/// shapes whether the workspace is local or remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventNotification {
    /// Identifier of the request that produced this event. Matches
    /// the `request_id` from `agent.send`.
    pub request_id: String,
    /// Raw sidecar event JSON. The desktop reconstructs a
    /// `SidecarEvent { raw: ... }` from this value and feeds it into
    /// the local pipeline unchanged.
    pub event: serde_json::Value,
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
            Method::TerminalList,
            Method::TerminalAttach,
            Method::WorkspaceFileTree,
            Method::WorkspaceChanges,
            Method::WorkspaceReadFile,
            Method::WorkspaceReadFileAtRef,
            Method::WorkspaceStatFile,
            Method::WorkspaceMutateFile,
            Method::AgentSend,
            Method::AgentAbort,
            Method::AgentList,
            Method::AgentAttach,
            Method::AgentSetAuth,
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

    #[test]
    fn terminal_list_result_round_trips_with_camel_case_keys() {
        let result = TerminalListResult {
            terminals: vec![TerminalListEntry {
                terminal_id: "t-1".into(),
                pid: 42,
                workspace_dir: "/home/me/repo".into(),
                opened_at_ms: 1_700_000_000_000,
                cols: 100,
                rows: 30,
            }],
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"terminalId\""));
        assert!(wire.contains("\"workspaceDir\""));
        assert!(wire.contains("\"openedAtMs\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
        let restored: TerminalListResult = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, result);
    }

    #[test]
    fn terminal_list_result_serialises_empty_terminals_as_empty_array() {
        // The "no sessions on this remote" case has to ship a real
        // empty array — `null` would force the frontend to nil-check
        // every list call.
        let wire = serde_json::to_value(TerminalListResult::default()).unwrap();
        assert!(wire["terminals"].is_array());
        assert_eq!(wire["terminals"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn terminal_attach_wire_shapes_use_camel_case_and_carry_scrollback() {
        let params = TerminalAttachParams {
            terminal_id: "t-1".into(),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"terminalId\""));

        let result = TerminalAttachResult {
            scrollback: "$ echo hi\nhi\n".into(),
            cols: 100,
            rows: 30,
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"scrollback\""));
        assert!(wire.contains("\"cols\""));
        assert!(wire.contains("\"rows\""));
        let restored: TerminalAttachResult = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, result);
    }

    // ── workspace.* (phase 20a) wire shapes ──────────────────────

    use crate::workspace::files::{
        EditorFileListItem, EditorFilePrefetchItem, EditorFileReadResponse, EditorFileStatResponse,
    };

    fn sample_file_entry(path: &str) -> EditorFileListItem {
        EditorFileListItem {
            path: path.into(),
            absolute_path: format!("/repo/{path}"),
            name: path.rsplit('/').next().unwrap_or(path).into(),
            status: "modified".into(),
            staged_insertions: 1,
            staged_deletions: 0,
            unstaged_insertions: 3,
            unstaged_deletions: 2,
            committed_insertions: 0,
            committed_deletions: 0,
            is_binary: false,
            staged_status: Some("M".into()),
            unstaged_status: Some("M".into()),
            committed_status: None,
        }
    }

    #[test]
    fn workspace_file_tree_wire_shapes_are_camel_case_and_round_trip() {
        let params = WorkspaceFileTreeParams {
            workspace_dir: "/repo".into(),
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"workspaceDir\""));

        let result = WorkspaceFileTreeResult {
            entries: vec![sample_file_entry("src/foo.rs")],
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"absolutePath\""));
        assert!(wire.contains("\"stagedInsertions\""));
        assert!(!wire.contains('_'), "snake_case leaked: {wire}");
        let restored: WorkspaceFileTreeResult = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, result);
    }

    #[test]
    fn workspace_changes_round_trips_with_and_without_content() {
        // Without content: prefetched is empty. With content: it's
        // populated. Both shapes round-trip lossless.
        let bare = WorkspaceChangesResult {
            items: vec![sample_file_entry("a.txt")],
            prefetched: vec![],
        };
        let wire = serde_json::to_string(&bare).unwrap();
        // `prefetched: []` serialises because the default attribute
        // alone won't skip an empty vec; we accept the slight verbose
        // round-trip in exchange for type stability on the client.
        let restored: WorkspaceChangesResult = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, bare);

        let with_content = WorkspaceChangesResult {
            items: vec![sample_file_entry("a.txt")],
            prefetched: vec![EditorFilePrefetchItem {
                absolute_path: "/repo/a.txt".into(),
                content: "hello\n".into(),
            }],
        };
        let wire = serde_json::to_string(&with_content).unwrap();
        assert!(wire.contains("\"prefetched\""));
        let restored: WorkspaceChangesResult = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, with_content);
    }

    #[test]
    fn workspace_changes_params_carry_include_content_flag() {
        let params = WorkspaceChangesParams {
            workspace_dir: "/repo".into(),
            include_content: true,
        };
        let wire = serde_json::to_string(&params).unwrap();
        assert!(wire.contains("\"includeContent\":true"));
        // Default false → still emits the field explicitly, since
        // the boolean isn't marked `#[serde(default)]`. The client
        // must always specify it — we want loud failures on
        // omission, not a silent default.
        let cheap = WorkspaceChangesParams {
            workspace_dir: "/repo".into(),
            include_content: false,
        };
        let wire = serde_json::to_string(&cheap).unwrap();
        assert!(wire.contains("\"includeContent\":false"));
    }

    #[test]
    fn workspace_read_file_uses_existing_response_shape_verbatim() {
        // The Result type *is* `EditorFileReadResponse` — the
        // inspector's local contract IS the wire contract for this
        // method. Confirm the round-trip works through the wire.
        let result = EditorFileReadResponse {
            path: "/repo/src/main.rs".into(),
            content: "fn main() {}\n".into(),
            mtime_ms: 1_700_000_000_000,
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"path\""));
        assert!(wire.contains("\"content\""));
        assert!(wire.contains("\"mtimeMs\""));
        let restored: EditorFileReadResponse = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, result);
    }

    #[test]
    fn workspace_read_file_at_ref_distinguishes_missing_from_empty() {
        let missing = WorkspaceReadFileAtRefResult { content: None };
        let wire = serde_json::to_string(&missing).unwrap();
        // None is skipped on the wire — receivers default to None.
        assert!(
            !wire.contains("content"),
            "None content should drop the field: {wire}"
        );

        let empty = WorkspaceReadFileAtRefResult {
            content: Some(String::new()),
        };
        let wire = serde_json::to_string(&empty).unwrap();
        assert!(wire.contains("\"content\":\"\""));

        // Round trip: missing parses back into None.
        let restored: WorkspaceReadFileAtRefResult = serde_json::from_str("{}").unwrap();
        assert_eq!(restored.content, None);
    }

    #[test]
    fn workspace_stat_file_round_trips_existing_stat_response_shape() {
        let result = EditorFileStatResponse {
            path: "/repo/src/main.rs".into(),
            exists: true,
            is_file: true,
            mtime_ms: Some(1_700_000_000_000),
            size: Some(42),
        };
        let wire = serde_json::to_string(&result).unwrap();
        assert!(wire.contains("\"isFile\""));
        assert!(wire.contains("\"mtimeMs\""));
        let restored: EditorFileStatResponse = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, result);
    }

    #[test]
    fn workspace_mutate_file_action_is_internally_tagged() {
        // The frontend will discriminate on `action.type` — same
        // pattern as RuntimeKind / TerminalEventKind.
        let write = WorkspaceMutateFileAction::Write {
            content: "new\n".into(),
        };
        let wire = serde_json::to_value(&write).unwrap();
        assert_eq!(wire["type"], "write");
        assert_eq!(wire["content"], "new\n");

        let discard = WorkspaceMutateFileAction::Discard;
        let wire = serde_json::to_value(&discard).unwrap();
        assert_eq!(wire["type"], "discard");
        // No extra fields — the unit variants stay clean on the wire.
        assert!(wire.get("content").is_none());

        let stage = WorkspaceMutateFileAction::Stage;
        let wire = serde_json::to_value(&stage).unwrap();
        assert_eq!(wire["type"], "stage");

        let unstage = WorkspaceMutateFileAction::Unstage;
        let wire = serde_json::to_value(&unstage).unwrap();
        assert_eq!(wire["type"], "unstage");

        // Round-trip every variant.
        for variant in [
            WorkspaceMutateFileAction::Write {
                content: "x".into(),
            },
            WorkspaceMutateFileAction::Discard,
            WorkspaceMutateFileAction::Stage,
            WorkspaceMutateFileAction::Unstage,
        ] {
            let wire = serde_json::to_string(&variant).unwrap();
            let restored: WorkspaceMutateFileAction = serde_json::from_str(&wire).unwrap();
            assert_eq!(restored, variant);
        }
    }

    #[test]
    fn workspace_mutate_file_result_omits_mtime_when_absent() {
        // Stage/Unstage/Discard return no timestamp; the response
        // is essentially `{}`. Write fills it in.
        let bare = WorkspaceMutateFileResult::default();
        let wire = serde_json::to_string(&bare).unwrap();
        assert_eq!(wire, "{}");

        let after_write = WorkspaceMutateFileResult {
            mtime_ms: Some(1_700_000_000_000),
        };
        let wire = serde_json::to_string(&after_write).unwrap();
        assert!(wire.contains("\"mtimeMs\":1700000000000"));
    }

    // ── agent.* wire shapes (phase 23a) ───────────────────────────

    #[test]
    fn agent_send_params_forward_raw_sidecar_payload_with_camel_case() {
        // The params struct uses camelCase on the wire so the
        // JSON-RPC envelope is consistent with every other method.
        // The inner `params` JSON is opaque — the daemon shovels it
        // into `SidecarRequest.params` verbatim.
        let params = AgentSendParams {
            request_id: "req-1".into(),
            method: "sendMessage".into(),
            params: serde_json::json!({
                "model": "claude-sonnet-4-6",
                "prompt": "hi",
            }),
        };
        let wire = serde_json::to_value(&params).unwrap();
        assert_eq!(wire["requestId"], "req-1");
        assert_eq!(wire["method"], "sendMessage");
        assert_eq!(wire["params"]["model"], "claude-sonnet-4-6");
    }

    #[test]
    fn agent_send_result_serialises_accepted_flag() {
        let wire = serde_json::to_value(AgentSendResult { accepted: true }).unwrap();
        assert_eq!(wire["accepted"], true);
        // Default is `false` — used in tests that want to verify the
        // daemon's gate fired without populating any session state.
        let default = serde_json::to_value(AgentSendResult::default()).unwrap();
        assert_eq!(default["accepted"], false);
    }

    #[test]
    fn agent_abort_params_round_trip() {
        let params = AgentAbortParams {
            request_id: "req-2".into(),
        };
        let wire = serde_json::to_string(&params).unwrap();
        let restored: AgentAbortParams = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored.request_id, "req-2");
        assert!(wire.contains("\"requestId\""));
    }

    #[test]
    fn agent_list_entry_omits_optional_fields_when_absent() {
        // Before the sidecar's `system.init` event lands, `provider` /
        // `helmor_session_id` / `workspace_dir` are all `None`. The
        // wire shape should drop them rather than emit `null`s —
        // mirrors the rest of the catalogue.
        let entry = AgentSessionEntry {
            request_id: "req-3".into(),
            helmor_session_id: None,
            provider: None,
            workspace_dir: None,
            started_at_ms: 1_700_000_000_000,
            last_event_ms: 1_700_000_000_500,
        };
        let wire = serde_json::to_value(&entry).unwrap();
        assert_eq!(wire["requestId"], "req-3");
        assert_eq!(wire["startedAtMs"], 1_700_000_000_000_i64);
        assert_eq!(wire["lastEventMs"], 1_700_000_000_500_i64);
        assert!(wire.get("helmorSessionId").is_none(), "wire: {wire}");
        assert!(wire.get("provider").is_none(), "wire: {wire}");
        assert!(wire.get("workspaceDir").is_none(), "wire: {wire}");
    }

    #[test]
    fn agent_list_entry_round_trips_through_serde_with_full_payload() {
        let entry = AgentSessionEntry {
            request_id: "r1".into(),
            helmor_session_id: Some("ws-session-1".into()),
            provider: Some("claude".into()),
            workspace_dir: Some("/srv/repos/demo".into()),
            started_at_ms: 1,
            last_event_ms: 2,
        };
        let wire = serde_json::to_string(&entry).unwrap();
        let restored: AgentSessionEntry = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, entry);
    }

    #[test]
    fn agent_attach_result_carries_found_flag() {
        let wire = serde_json::to_value(AgentAttachResult { found: true }).unwrap();
        assert_eq!(wire["found"], true);
    }

    #[test]
    fn agent_event_notification_wraps_raw_sidecar_payload() {
        // The whole point of phase 23 is that the desktop's existing
        // accumulator sees byte-identical SidecarEvent JSON whether
        // the workspace is local or remote. This test wedges that
        // contract: the `event` field is the raw JSON, untouched by
        // the wrapping.
        let inner = serde_json::json!({
            "id": "req-4",
            "type": "assistant",
            "session_id": "sdk-session-7",
            "delta": { "text": "hello" }
        });
        let notif = AgentEventNotification {
            request_id: "req-4".into(),
            event: inner.clone(),
        };
        let wire = serde_json::to_value(&notif).unwrap();
        assert_eq!(wire["requestId"], "req-4");
        // The wrapped payload survives as-is — sub-fields don't get
        // shuffled into camelCase, sidecar-side underscores
        // (`session_id`) survive.
        assert_eq!(wire["event"], inner);
    }

    #[test]
    fn agent_event_method_constant_matches_the_catalogue() {
        assert_eq!(AGENT_EVENT_METHOD, "agent.event");
    }

    #[test]
    fn agent_set_auth_params_omit_optional_fields_when_absent() {
        // Wire shape for a clear: provider + api_key=None should
        // emit just `{ provider: "cursor" }` — `null` would mean
        // "explicit clear" too, but skipping the field keeps the
        // payload tight and the daemon treats both as
        // "remove the entry".
        let params = AgentSetAuthParams {
            provider: "cursor".into(),
            api_key: None,
            base_url: None,
        };
        let wire = serde_json::to_value(&params).unwrap();
        assert_eq!(wire["provider"], "cursor");
        assert!(
            wire.get("apiKey").is_none(),
            "absent apiKey should be skipped: {wire}"
        );
        assert!(
            wire.get("baseUrl").is_none(),
            "absent baseUrl should be skipped: {wire}"
        );
    }

    #[test]
    fn agent_set_auth_params_round_trip_with_full_payload() {
        let params = AgentSetAuthParams {
            provider: "claude".into(),
            api_key: Some("sk-test".into()),
            base_url: Some("https://proxy.example.com".into()),
        };
        let wire = serde_json::to_string(&params).unwrap();
        let restored: AgentSetAuthParams = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, params);
        // CamelCase on the wire.
        assert!(wire.contains("\"apiKey\""));
        assert!(wire.contains("\"baseUrl\""));
    }
}
