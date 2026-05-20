//! The runtime-abstraction seam for the remote-workspace feature.
//!
//! `RemoteRuntime` is the trait every command path that *might*
//! eventually run on a remote machine routes through. Two impls
//! cohabit:
//!
//! - [`LocalRuntime`] — wraps the current direct-call codebase.
//!   This is the production default and the only path with full
//!   behaviour today.
//! - `RemoteRuntime` (future, phase 3+) — dispatches over the
//!   JSON-RPC client to a `helmor-server` running on another
//!   host.
//!
//! This phase only lands the trait, the local impl, and **one**
//! method (`runtime_health`) so the seam is real and exercised.
//! Migrating actual workspace / git / script ops onto it is the
//! work of the following phases — each one moves a small set of
//! methods over, with the local impl always staying a thin wrapper
//! around the existing module functions.
//!
//! ## Why a trait instead of an enum
//!
//! An `enum { Local(...), Remote(...) }` would force every site that
//! takes a runtime to match on both variants. The dispatch pattern
//! we want is "look up the runtime for this workspace and call a
//! method on it" — that's a trait object's job. The `&dyn`
//! indirection adds a vtable lookup per call, but the per-method
//! work is always either a function call (local) or a JSON-RPC
//! round-trip (remote), so the overhead is in the noise either way.

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::methods::{WorkspaceBranchInfoResult, WorkspaceStatusResult};

/// Snapshot returned by [`RemoteRuntime::runtime_health`]. Carries
/// just enough for the UI to render a "connected to X" indicator
/// without forcing the caller to deserialize a richer envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub kind: RuntimeKind,
    /// Friendly hostname. Always set, even for the local runtime
    /// (so a header chip can read it unconditionally).
    pub hostname: String,
    /// Helmor build version of the runtime. For local that's the
    /// running app; for remote that's whatever `helmor-server`
    /// binary the operator installed there.
    pub version: String,
}

/// Discriminates the local-vs-remote nature of a runtime. Kept as a
/// separate enum (rather than `Option<String>`-style hostnaming) so
/// new variants can carry distinct metadata without breaking serde.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RuntimeKind {
    /// The host process is doing the work itself — no RPC client
    /// in the loop.
    Local,
    /// Workspace state lives on `host`; calls translate into JSON-RPC
    /// requests over an SSH-tunneled stdio pipe.
    Remote { host: String },
}

/// Every command path that might eventually have a non-local
/// counterpart routes through this trait. Today it only exposes
/// `runtime_health`; subsequent phases add the workspace / git /
/// script / sidecar / terminal methods.
///
/// Implementations must be `Send + Sync` because the Tauri command
/// layer keeps a single trait object behind `tauri::State` and
/// reaches it from arbitrary blocking-pool threads.
pub trait RemoteRuntime: Send + Sync {
    /// Cheap, side-effect-free probe. Implementations should respond
    /// without acquiring DB locks or touching the network, so the
    /// frontend can poll it on a focus tick without worrying about
    /// latency budget.
    fn runtime_health(&self) -> Result<RuntimeHealth>;

    /// Project the workspace's `git status --porcelain` output into
    /// a wire-friendly shape. First *real* method on the seam: the
    /// local impl shells out to `git`; the future remote impl
    /// translates it into a `workspace.status` JSON-RPC request.
    ///
    /// `workspace_dir` is interpreted on the runtime's *own*
    /// filesystem. The local impl reads it directly; the remote
    /// impl will pass it verbatim and expect the server to resolve
    /// it under its own root.
    fn workspace_status(&self, workspace_dir: &Path) -> Result<WorkspaceStatusResult>;

    /// Read-only "where am I?" projection — current branch, head
    /// commit, and upstream tracking ref. The local impl shells out
    /// to a couple of `git` invocations; the remote impl translates
    /// it into a `workspace.branchInfo` JSON-RPC request.
    ///
    /// `workspace_dir` interpretation matches [`workspace_status`]:
    /// the runtime's own filesystem.
    fn workspace_branch_info(&self, workspace_dir: &Path) -> Result<WorkspaceBranchInfoResult>;

    /// Liveness probe. Distinct from [`runtime_health`] — that method
    /// returns a *cached* snapshot for cheap UI rendering, whereas
    /// `ping` actually round-trips through the transport so a dead
    /// pipe (SSH dropped, server crashed) surfaces as `Err`. Used by
    /// the registry's background poller to drive the connection-state
    /// chip.
    ///
    /// The local impl returns `Ok(())` unconditionally — the
    /// in-process runtime can't be "disconnected".
    fn ping(&self) -> Result<()>;

    /// Open a remote PTY-backed terminal. The default `Err` is what
    /// [`LocalRuntime`] (and tombstones) return — local terminals
    /// route through `workspace::scripts`, not the remote-runner
    /// seam, and a tombstoned remote has no live transport to host
    /// the PTY on.
    fn terminal_open(
        &self,
        _params: super::methods::TerminalOpenParams,
    ) -> Result<super::methods::TerminalOpenResult> {
        anyhow::bail!("terminal.open is only supported on a connected remote runtime")
    }

    /// Push bytes to an open remote terminal's PTY stdin.
    fn terminal_write(
        &self,
        _params: super::methods::TerminalWriteParams,
    ) -> Result<super::methods::TerminalWriteResult> {
        anyhow::bail!("terminal.write is only supported on a connected remote runtime")
    }

    /// Resize an open remote terminal's PTY.
    fn terminal_resize(
        &self,
        _params: super::methods::TerminalResizeParams,
    ) -> Result<super::methods::TerminalResizeResult> {
        anyhow::bail!("terminal.resize is only supported on a connected remote runtime")
    }

    /// Kill + reap an open remote terminal. Idempotent on the wire
    /// — closing an unknown terminal returns Ok.
    fn terminal_close(
        &self,
        _params: super::methods::TerminalCloseParams,
    ) -> Result<super::methods::TerminalCloseResult> {
        anyhow::bail!("terminal.close is only supported on a connected remote runtime")
    }

    /// Enumerate every PTY session still alive on the runtime.
    /// Used by reconnecting clients to discover orphan sessions
    /// they can `attach` back to.
    fn terminal_list(
        &self,
        _params: super::methods::TerminalListParams,
    ) -> Result<super::methods::TerminalListResult> {
        anyhow::bail!("terminal.list is only supported on a connected remote runtime")
    }

    /// Re-bind the stdout stream of an existing terminal to *this*
    /// caller. Returns the current scrollback + the latest known
    /// PTY size; subsequent stdout flows as `terminal.event`
    /// notifications addressed to the calling connection.
    fn terminal_attach(
        &self,
        _params: super::methods::TerminalAttachParams,
    ) -> Result<super::methods::TerminalAttachResult> {
        anyhow::bail!("terminal.attach is only supported on a connected remote runtime")
    }

    /// Subscribe to `terminal.event` notifications coming back from
    /// the runtime. The default `None` means "this runtime doesn't
    /// stream — local terminals use the existing `workspace::scripts`
    /// channel; tombstones have no live transport". Remote runtimes
    /// override to plug into their [`super::client::RpcClient`]'s
    /// notification stream.
    fn subscribe_terminal_events(
        &self,
        _callback: Box<dyn Fn(super::methods::TerminalEventNotification) + Send + Sync>,
    ) -> Option<super::client::NotificationSubscription> {
        None
    }

    // ── workspace inspector ops (phase 20a — surface only) ──────
    //
    // Default bails surface as `HANDLER_FAILED` on the wire until
    // phase 20b implements them on `LocalRuntime`. `RemoteSshRuntime`
    // forwards via `client.call::<...>` from day one — its handlers
    // are pure delegation, so the methods work as soon as the server
    // side is filled in (independent ship of 20b).

    fn workspace_file_tree(
        &self,
        _params: super::methods::WorkspaceFileTreeParams,
    ) -> Result<super::methods::WorkspaceFileTreeResult> {
        anyhow::bail!("workspace.fileTree is not yet implemented on this runtime")
    }

    fn workspace_changes(
        &self,
        _params: super::methods::WorkspaceChangesParams,
    ) -> Result<super::methods::WorkspaceChangesResult> {
        anyhow::bail!("workspace.changes is not yet implemented on this runtime")
    }

    fn workspace_read_file(
        &self,
        _params: super::methods::WorkspaceReadFileParams,
    ) -> Result<crate::workspace::files::EditorFileReadResponse> {
        anyhow::bail!("workspace.readFile is not yet implemented on this runtime")
    }

    fn workspace_read_file_at_ref(
        &self,
        _params: super::methods::WorkspaceReadFileAtRefParams,
    ) -> Result<super::methods::WorkspaceReadFileAtRefResult> {
        anyhow::bail!("workspace.readFileAtRef is not yet implemented on this runtime")
    }

    fn workspace_stat_file(
        &self,
        _params: super::methods::WorkspaceStatFileParams,
    ) -> Result<crate::workspace::files::EditorFileStatResponse> {
        anyhow::bail!("workspace.statFile is not yet implemented on this runtime")
    }

    fn workspace_mutate_file(
        &self,
        _params: super::methods::WorkspaceMutateFileParams,
    ) -> Result<super::methods::WorkspaceMutateFileResult> {
        anyhow::bail!("workspace.mutateFile is not yet implemented on this runtime")
    }

    fn workspace_search(
        &self,
        _params: super::methods::WorkspaceSearchParams,
    ) -> Result<super::methods::WorkspaceSearchResult> {
        anyhow::bail!("workspace.search is not yet implemented on this runtime")
    }

    fn workspace_start_watch(
        &self,
        _params: super::methods::WorkspaceStartWatchParams,
    ) -> Result<super::methods::WorkspaceStartWatchResult> {
        anyhow::bail!("workspace.startWatch is only supported on a connected remote runtime")
    }

    fn workspace_stop_watch(
        &self,
        _params: super::methods::WorkspaceStopWatchParams,
    ) -> Result<super::methods::WorkspaceStopWatchResult> {
        anyhow::bail!("workspace.stopWatch is only supported on a connected remote runtime")
    }

    /// Subscribe to `workspace.fileEvent` notifications coming back
    /// from a started watcher. Default `None` mirrors the agent /
    /// terminal subscribers: local + tombstoned runtimes don't run
    /// the wire (a local workspace uses [`FileWatcher`] directly).
    /// Only [`super::client::RemoteSshRuntime`] overrides.
    fn subscribe_workspace_file_events(
        &self,
        _callback: Box<dyn Fn(super::methods::WorkspaceFileEventNotification) + Send + Sync>,
    ) -> Option<super::client::NotificationSubscription> {
        None
    }

    /// Snapshot RPC-pipe telemetry for this runtime. `None` for
    /// runtimes that don't have a wire to instrument (the local
    /// runtime is in-process; tombstoned remotes have no client).
    /// Drives the desktop's "Connection diagnostics" panel.
    fn client_diagnostics(&self) -> Option<super::client::RpcClientDiagnostics> {
        None
    }

    // ── agent.* ops (phase 23a — surface only) ──────────────────
    //
    // Phase 23a defines the wire shapes; the trait defaults bail.
    // `RemoteSshRuntime` overrides delegate via `client.call`, so
    // once phase 23b lands a `RemoteAgentState` on the daemon side,
    // every remote runtime gets agent dispatch for free. `LocalRuntime`
    // intentionally keeps the bail — local workspaces continue using
    // `ManagedSidecar` directly through `agents::streaming::send`,
    // not through the seam.

    fn agent_send(
        &self,
        _params: super::methods::AgentSendParams,
    ) -> Result<super::methods::AgentSendResult> {
        anyhow::bail!("agent.send is only supported on a connected remote runtime")
    }

    fn agent_abort(
        &self,
        _params: super::methods::AgentAbortParams,
    ) -> Result<super::methods::AgentAbortResult> {
        anyhow::bail!("agent.abort is only supported on a connected remote runtime")
    }

    fn agent_list(
        &self,
        _params: super::methods::AgentListParams,
    ) -> Result<super::methods::AgentListResult> {
        anyhow::bail!("agent.list is only supported on a connected remote runtime")
    }

    fn agent_attach(
        &self,
        _params: super::methods::AgentAttachParams,
    ) -> Result<super::methods::AgentAttachResult> {
        anyhow::bail!("agent.attach is only supported on a connected remote runtime")
    }

    /// Push an SDK API key (or null to clear) into the runtime's
    /// secrets store. Phase 23d: only the SSH-backed `RemoteSshRuntime`
    /// implements this; the local runtime keeps using the desktop's
    /// existing `app.cursor_provider` settings row directly.
    fn agent_set_auth(
        &self,
        _params: super::methods::AgentSetAuthParams,
    ) -> Result<super::methods::AgentSetAuthResult> {
        anyhow::bail!("agent.setAuth is only supported on a connected remote runtime")
    }

    /// Subscribe to `agent.event` notifications coming back from the
    /// runtime. Default `None` mirrors [`subscribe_terminal_events`]:
    /// local + tombstoned runtimes don't stream, so the desktop's
    /// agent pipeline either talks to its own `ManagedSidecar` (local)
    /// or to the remote's notification stream (`RemoteSshRuntime`
    /// override).
    fn subscribe_agent_events(
        &self,
        _callback: Box<dyn Fn(super::methods::AgentEventNotification) + Send + Sync>,
    ) -> Option<super::client::NotificationSubscription> {
        None
    }

    /// Track E1: read the daemon's trailing log lines. Only the
    /// remote runtime has a daemon log to tail; the local runtime
    /// bails so the dev-panel surface can distinguish "this runtime
    /// has no log" from "the log is empty".
    fn daemon_tail_log(
        &self,
        _params: super::methods::DaemonTailLogParams,
    ) -> Result<super::methods::DaemonTailLogResult> {
        anyhow::bail!("daemon.tailLog is only supported on a connected remote runtime")
    }

    /// Track E2: snapshot the daemon's RPC metrics registry.
    /// Local-only — there's no daemon RPC pipe to instrument on
    /// the local runtime.
    fn runtime_metrics(
        &self,
        _params: super::methods::RuntimeMetricsParams,
    ) -> Result<super::methods::RuntimeMetricsResult> {
        anyhow::bail!("runtime.metrics is only supported on a connected remote runtime")
    }
}

/// The default runtime — does the work in-process. Every existing
/// command path can be migrated onto this without changing behaviour
/// because each method just calls the same free function the
/// command used to call directly.
pub struct LocalRuntime {
    /// Captured once at construction so the hot path doesn't shell
    /// out to `uname -n` per request.
    hostname: String,
    /// Captured from `CARGO_PKG_VERSION` so the binary version and
    /// the runtime version are guaranteed to agree without a cross-
    /// crate include.
    version: &'static str,
}

impl LocalRuntime {
    /// Read the hostname once and stash it. Failures fall back to
    /// `"localhost"` rather than propagating — `runtime_health` is
    /// supposed to be fail-safe.
    pub fn new() -> Self {
        Self::with_hostname(read_local_hostname())
    }

    /// Construct with a caller-supplied hostname. Useful for tests
    /// where shelling out to `uname` is overkill / non-deterministic.
    pub fn with_hostname(hostname: String) -> Self {
        Self {
            hostname,
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}

impl Default for LocalRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteRuntime for LocalRuntime {
    fn runtime_health(&self) -> Result<RuntimeHealth> {
        Ok(RuntimeHealth {
            kind: RuntimeKind::Local,
            hostname: self.hostname.clone(),
            version: self.version.to_string(),
        })
    }

    fn ping(&self) -> Result<()> {
        // In-process runtime is always alive by construction. Liveness
        // probes against `local` are effectively no-ops; the registry's
        // poller skips them entirely, but the method still has to exist
        // for trait-object dispatch.
        Ok(())
    }

    fn workspace_status(&self, workspace_dir: &Path) -> Result<WorkspaceStatusResult> {
        let workspace_str = workspace_dir.display().to_string();
        // `run_git_capture` returns stdout verbatim. We can't use the
        // standard `run_git` here because it trims the result, and
        // porcelain v1 *encodes the staging state in the leading
        // space* — a stripped leading byte means `line[3..]` slices
        // off the first byte of the path on unstaged modifications.
        let output = crate::git_ops::run_git_capture(
            [
                "-C",
                workspace_str.as_str(),
                "status",
                "--porcelain",
                "--untracked-files=normal",
            ],
            None,
        )
        .with_context(|| format!("Failed to read workspace status for {workspace_str}"))?;
        Ok(parse_porcelain_status(&output))
    }

    fn workspace_branch_info(&self, workspace_dir: &Path) -> Result<WorkspaceBranchInfoResult> {
        // `current_branch_name` errors on a fresh repo with no
        // commits / detached HEAD in some cases — for branch-info
        // we want a sensible empty-string fallback rather than
        // a hard failure, so the UI can still render "(detached)"
        // alongside a real HEAD commit.
        let current_branch = crate::git_ops::current_branch_name(workspace_dir).unwrap_or_default();
        let head_commit = crate::git_ops::current_workspace_head_commit(workspace_dir)
            .with_context(|| {
                format!("Failed to read HEAD commit for {}", workspace_dir.display())
            })?;
        let upstream_ref = crate::git_ops::current_upstream_ref_name(workspace_dir);
        Ok(WorkspaceBranchInfoResult {
            current_branch,
            head_commit,
            upstream_ref,
        })
    }

    // ── workspace inspector ops (phase 20b — real impls) ─────────
    //
    // Each method does the seam-level sandbox (`workspace_dir` +
    // optional `relative_path` → absolute path that stays inside the
    // workspace), then delegates to the workspace::files `_inner`
    // helpers that perform the actual git / fs work *without* the
    // desktop's DB-driven `allowed_workspace_roots` check.
    //
    // The DB check is irrelevant here on two axes:
    // - On the desktop, every callsite already routes through this
    //   trait when the workspace is bound to a remote runtime —
    //   their `runtime_name` resolves before the DB sandbox would
    //   matter.
    // - On the helmor-server binary, there is no helmor DB; the
    //   binary would simply error out of every editor call. The
    //   `_inner` variants exist precisely so this path can do its
    //   own sandbox without touching SQLite.
    //
    // Failures from the underlying helpers (missing file, git
    // error, broken workspace) surface verbatim — the dispatcher
    // wraps them as `HANDLER_FAILED`, preserving the human message
    // for the inspector to show.

    fn workspace_file_tree(
        &self,
        params: super::methods::WorkspaceFileTreeParams,
    ) -> Result<super::methods::WorkspaceFileTreeResult> {
        let workspace_dir = PathBuf::from(&params.workspace_dir);
        let entries = crate::workspace::files::list_workspace_files_inner(&workspace_dir);
        Ok(super::methods::WorkspaceFileTreeResult { entries })
    }

    fn workspace_changes(
        &self,
        params: super::methods::WorkspaceChangesParams,
    ) -> Result<super::methods::WorkspaceChangesResult> {
        if params.include_content {
            let response = crate::workspace::files::list_workspace_changes_with_content(
                params.workspace_dir.as_str(),
            )?;
            Ok(super::methods::WorkspaceChangesResult {
                items: response.items,
                prefetched: response.prefetched,
            })
        } else {
            let items =
                crate::workspace::files::list_workspace_changes(params.workspace_dir.as_str())?;
            Ok(super::methods::WorkspaceChangesResult {
                items,
                prefetched: Vec::new(),
            })
        }
    }

    fn workspace_read_file(
        &self,
        params: super::methods::WorkspaceReadFileParams,
    ) -> Result<crate::workspace::files::EditorFileReadResponse> {
        let workspace_dir = PathBuf::from(&params.workspace_dir);
        let absolute = join_workspace_relative(&workspace_dir, &params.relative_path)?;
        crate::workspace::files::read_editor_file_inner(&absolute)
    }

    fn workspace_read_file_at_ref(
        &self,
        params: super::methods::WorkspaceReadFileAtRefParams,
    ) -> Result<super::methods::WorkspaceReadFileAtRefResult> {
        let workspace_dir = PathBuf::from(&params.workspace_dir);
        let absolute = join_workspace_relative(&workspace_dir, &params.relative_path)?;
        let content = crate::workspace::files::read_file_at_ref(
            params.workspace_dir.as_str(),
            absolute.display().to_string().as_str(),
            params.git_ref.as_str(),
        )?;
        Ok(super::methods::WorkspaceReadFileAtRefResult { content })
    }

    fn workspace_stat_file(
        &self,
        params: super::methods::WorkspaceStatFileParams,
    ) -> Result<crate::workspace::files::EditorFileStatResponse> {
        let workspace_dir = PathBuf::from(&params.workspace_dir);
        let absolute = join_workspace_relative(&workspace_dir, &params.relative_path)?;
        crate::workspace::files::stat_editor_file_inner(&absolute)
    }

    fn workspace_mutate_file(
        &self,
        params: super::methods::WorkspaceMutateFileParams,
    ) -> Result<super::methods::WorkspaceMutateFileResult> {
        use super::methods::WorkspaceMutateFileAction;
        let workspace_dir = PathBuf::from(&params.workspace_dir);
        let absolute = join_workspace_relative(&workspace_dir, &params.relative_path)?;
        let relative = params.relative_path.as_str();
        match params.action {
            WorkspaceMutateFileAction::Write { content } => {
                let response =
                    crate::workspace::files::write_editor_file_inner(&absolute, &content)?;
                Ok(super::methods::WorkspaceMutateFileResult {
                    mtime_ms: Some(response.mtime_ms),
                })
            }
            WorkspaceMutateFileAction::Discard => {
                crate::workspace::files::discard_workspace_file_inner(
                    &workspace_dir,
                    relative,
                    &absolute,
                )?;
                Ok(super::methods::WorkspaceMutateFileResult { mtime_ms: None })
            }
            WorkspaceMutateFileAction::Stage => {
                crate::workspace::files::stage_workspace_file_inner(&workspace_dir, relative)?;
                Ok(super::methods::WorkspaceMutateFileResult { mtime_ms: None })
            }
            WorkspaceMutateFileAction::Unstage => {
                crate::workspace::files::unstage_workspace_file_inner(&workspace_dir, relative)?;
                Ok(super::methods::WorkspaceMutateFileResult { mtime_ms: None })
            }
        }
    }

    fn workspace_search(
        &self,
        params: super::methods::WorkspaceSearchParams,
    ) -> Result<super::methods::WorkspaceSearchResult> {
        let workspace_dir = PathBuf::from(&params.workspace_dir);
        let results = crate::workspace::files::search_workspace_inner(
            &workspace_dir,
            &params.query,
            params.max_results,
            params.case_insensitive,
            params.fixed_string,
        )?;
        Ok(super::methods::WorkspaceSearchResult {
            matches: results
                .matches
                .into_iter()
                .map(|hit| super::methods::WorkspaceSearchMatch {
                    relative_path: hit.relative_path,
                    line_number: hit.line_number,
                    line: hit.line,
                })
                .collect(),
            truncated: results.truncated,
        })
    }
}

/// Validate a workspace-relative path coming over the wire and join
/// it onto the runtime's own filesystem root. Rejects empty paths,
/// absolute paths, and any `..` traversal — the daemon must never
/// read or write outside the workspace root the client named.
///
/// Returns the joined absolute path on success. Symlink-escape
/// detection (canonicalise + `starts_with` workspace root) is
/// deferred: it would need a partial canonicalise so missing-file
/// calls like `statFile` and `writeFile` (on a brand-new file) keep
/// working. The cheap textual check below covers the obvious
/// hostile inputs; a stricter pass can land alongside symlink
/// support if it ever matters.
fn join_workspace_relative(workspace_dir: &Path, relative_path: &str) -> Result<PathBuf> {
    if relative_path.is_empty() {
        bail!("relative path must not be empty");
    }
    let rel = Path::new(relative_path);
    if rel.is_absolute() {
        bail!("relative path must not be absolute: {relative_path}");
    }
    if rel
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        bail!("relative path must not contain `..`: {relative_path}");
    }
    Ok(workspace_dir.join(rel))
}

/// Turn `git status --porcelain` output into the wire-shaped
/// projection. Kept here (not in `git/ops.rs`) so the parsing
/// rules live next to the trait method that emits the result —
/// future schema changes touch one place.
fn parse_porcelain_status(output: &str) -> WorkspaceStatusResult {
    use std::collections::BTreeSet;
    // Porcelain v1 format: `XY<space>path` where X is staged status,
    // Y is unstaged status. Paths beyond column 3. Renames produce
    // `R  old -> new` — we keep the trailing portion as the canonical
    // path (matches what git/ops.rs's parse does today).
    let paths: BTreeSet<String> = output
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let path = line[3..].trim();
            if path.is_empty() {
                return None;
            }
            Some(path.to_string())
        })
        .collect();
    let is_clean = paths.is_empty();
    WorkspaceStatusResult {
        is_clean,
        changed_paths: paths.into_iter().collect(),
    }
}

/// Process-lifetime singleton for the local runtime. Tauri command
/// handlers reach this when they want the "this machine" runtime
/// without juggling a per-call construction.
pub fn local_runtime() -> &'static (dyn RemoteRuntime + 'static) {
    static INSTANCE: OnceLock<LocalRuntime> = OnceLock::new();
    INSTANCE.get_or_init(LocalRuntime::new)
}

/// Best-effort local hostname read. Mirrors the resolver the
/// `helmor-server` binary uses so a local <-> remote pair report
/// hostnames the same way. Failure → `"localhost"`.
fn read_local_hostname() -> String {
    if let Ok(host) = std::env::var("HOSTNAME") {
        if !host.is_empty() {
            return host;
        }
    }
    match std::process::Command::new("uname").arg("-n").output() {
        Ok(output) if output.status.success() => {
            let raw = String::from_utf8_lossy(&output.stdout);
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                "localhost".to_string()
            } else {
                trimmed.to_string()
            }
        }
        _ => "localhost".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for the future SSH-backed impl. Lets us prove the
    /// trait is object-safe and the dispatch surface compiles for
    /// non-local impls *now*, before the SSH transport lands.
    struct FakeRemoteRuntime {
        host: String,
        version: String,
    }

    impl RemoteRuntime for FakeRemoteRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            Ok(RuntimeHealth {
                kind: RuntimeKind::Remote {
                    host: self.host.clone(),
                },
                hostname: self.host.clone(),
                version: self.version.clone(),
            })
        }

        fn workspace_status(&self, _workspace_dir: &Path) -> Result<WorkspaceStatusResult> {
            // The fake exists only to prove dispatch — return a stub
            // that's distinguishable from a real local-runtime result.
            Ok(WorkspaceStatusResult {
                is_clean: true,
                changed_paths: vec![],
            })
        }
        fn workspace_branch_info(&self, _: &Path) -> Result<WorkspaceBranchInfoResult> {
            Ok(WorkspaceBranchInfoResult {
                current_branch: format!("fake-branch-on-{}", self.host),
                head_commit: "fake-sha".into(),
                upstream_ref: None,
            })
        }
        fn ping(&self) -> Result<()> {
            Ok(())
        }
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .unwrap_or_else(|e| panic!("git {args:?} failed to spawn: {e}"));
        assert!(
            output.status.success(),
            "git {args:?} in {} failed: {}",
            repo.display(),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run_git(dir.path(), &["init"]);
        run_git(dir.path(), &["checkout", "-b", "main"]);
        run_git(dir.path(), &["config", "user.email", "helmor@example.com"]);
        run_git(dir.path(), &["config", "user.name", "Helmor Test"]);
        run_git(dir.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        run_git(dir.path(), &["add", "file.txt"]);
        run_git(dir.path(), &["commit", "-m", "initial"]);
        dir
    }

    // ── LocalRuntime ─────────────────────────────────────────────

    #[test]
    fn local_runtime_health_reports_local_kind_and_captured_hostname() {
        let runtime = LocalRuntime::with_hostname("test-host".into());
        let health = runtime.runtime_health().unwrap();
        assert_eq!(health.kind, RuntimeKind::Local);
        assert_eq!(health.hostname, "test-host");
        // The build version flows from CARGO_PKG_VERSION; just
        // assert it's non-empty so a future Cargo bump doesn't
        // pin the assertion to a moving target.
        assert!(!health.version.is_empty());
    }

    #[test]
    fn local_runtime_default_constructor_works() {
        let runtime = LocalRuntime::default();
        let health = runtime.runtime_health().unwrap();
        assert_eq!(health.kind, RuntimeKind::Local);
        // We don't assert the literal hostname — the test runner
        // hostname is environment-dependent. We just assert that
        // *some* non-empty hostname comes back (the fallback case
        // returns "localhost").
        assert!(!health.hostname.is_empty());
    }

    #[test]
    fn local_runtime_singleton_is_stable_across_calls() {
        let first = local_runtime();
        let second = local_runtime();
        // The trait-object pointers from `OnceLock` should be the
        // same instance — singleton, not per-call reinit.
        assert!(std::ptr::eq(
            first as *const _ as *const (),
            second as *const _ as *const (),
        ));
    }

    // ── trait object safety ──────────────────────────────────────

    #[test]
    fn trait_is_object_safe_and_swappable_between_impls() {
        // Vec of trait objects exercises both `Send + Sync` bounds
        // and the dyn-dispatch slot. If a future method added to
        // the trait broke object safety, this stops compiling.
        let runtimes: Vec<Box<dyn RemoteRuntime>> = vec![
            Box::new(LocalRuntime::with_hostname("local-1".into())),
            Box::new(FakeRemoteRuntime {
                host: "remote-1".into(),
                version: "0.22.1".into(),
            }),
        ];
        let kinds: Vec<RuntimeKind> = runtimes
            .iter()
            .map(|r| r.runtime_health().unwrap().kind)
            .collect();
        assert_eq!(kinds[0], RuntimeKind::Local);
        assert_eq!(
            kinds[1],
            RuntimeKind::Remote {
                host: "remote-1".into(),
            }
        );
    }

    // ── RuntimeKind wire format ──────────────────────────────────

    #[test]
    fn runtime_kind_serializes_with_camel_case_type_tag() {
        // The frontend will branch on `kind.type === "local" | "remote"`
        // for the connection-status chip. Lock the wire format down
        // now so a stray rename doesn't silently make the chip dead
        // until someone notices.
        let local = serde_json::to_value(RuntimeKind::Local).unwrap();
        assert_eq!(local["type"], "local");

        let remote = serde_json::to_value(RuntimeKind::Remote {
            host: "ec2-1.example.com".into(),
        })
        .unwrap();
        assert_eq!(remote["type"], "remote");
        assert_eq!(remote["host"], "ec2-1.example.com");
    }

    #[test]
    fn runtime_health_round_trips_through_serde() {
        let original = RuntimeHealth {
            kind: RuntimeKind::Remote {
                host: "dev.box".into(),
            },
            hostname: "dev.box".into(),
            version: "0.22.1".into(),
        };
        let wire = serde_json::to_string(&original).unwrap();
        let restored: RuntimeHealth = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, original);
    }

    // ── LocalRuntime::workspace_status ───────────────────────────

    #[test]
    fn local_runtime_workspace_status_reports_clean_repo() {
        let dir = init_repo();
        let runtime = LocalRuntime::with_hostname("test-host".into());

        let status = runtime.workspace_status(dir.path()).unwrap();

        assert!(status.is_clean, "fresh init_repo should be clean");
        assert!(status.changed_paths.is_empty());
    }

    #[test]
    fn local_runtime_workspace_status_surfaces_modified_and_untracked_paths() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        let runtime = LocalRuntime::with_hostname("test-host".into());

        let status = runtime.workspace_status(dir.path()).unwrap();

        assert!(!status.is_clean);
        // Sorted + deduped, both files surfaced regardless of staging
        // state. `untracked-files=normal` means `new.txt` shows up.
        assert_eq!(
            status.changed_paths,
            vec!["file.txt".to_string(), "new.txt".to_string()],
        );
    }

    #[test]
    fn local_runtime_workspace_branch_info_reports_current_branch_and_head() {
        let dir = init_repo();
        let runtime = LocalRuntime::with_hostname("test-host".into());

        let info = runtime.workspace_branch_info(dir.path()).unwrap();

        assert_eq!(info.current_branch, "main");
        // Fresh init_repo has one commit; SHA-1 hash is 40 hex chars.
        assert_eq!(
            info.head_commit.len(),
            40,
            "expected a full 40-char SHA-1 hash, got `{}`",
            info.head_commit
        );
        // No remote / upstream configured on the fresh repo.
        assert!(
            info.upstream_ref.is_none(),
            "fresh repo has no upstream tracking ref: {:?}",
            info.upstream_ref
        );
    }

    // ── workspace inspector ops (phase 20b) ──────────────────────
    //
    // Each method gets a happy-path test against a real tempdir git
    // repo plus the obvious failure modes (missing file, sandbox
    // escape). The point is to exercise the `LocalRuntime` impl
    // verbatim — same code path the helmor-server binary runs.

    use crate::remote::methods::{
        WorkspaceChangesParams, WorkspaceFileTreeParams, WorkspaceMutateFileAction,
        WorkspaceMutateFileParams, WorkspaceReadFileAtRefParams, WorkspaceReadFileParams,
        WorkspaceStatFileParams,
    };

    fn make_local_runtime() -> LocalRuntime {
        LocalRuntime::with_hostname("test-host".into())
    }

    #[test]
    fn local_runtime_workspace_file_tree_lists_files_inside_the_root() {
        let dir = init_repo();
        // Add a couple of files in subdirs to prove the walker
        // recurses + reports paths relative to the workspace root.
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("nested.txt"), "n\n").unwrap();
        let runtime = make_local_runtime();

        let result = runtime
            .workspace_file_tree(WorkspaceFileTreeParams {
                workspace_dir: dir.path().display().to_string(),
            })
            .expect("file tree on a real repo should succeed");

        let paths: Vec<_> = result.entries.iter().map(|e| e.path.as_str()).collect();
        assert!(
            paths.contains(&"file.txt"),
            "tracked file should surface: {paths:?}"
        );
        assert!(
            paths.contains(&"sub/nested.txt"),
            "nested untracked file should surface: {paths:?}"
        );
    }

    #[test]
    fn local_runtime_workspace_changes_returns_empty_items_on_clean_repo() {
        let dir = init_repo();
        let runtime = make_local_runtime();
        let result = runtime
            .workspace_changes(WorkspaceChangesParams {
                workspace_dir: dir.path().display().to_string(),
                include_content: false,
            })
            .expect("clean repo should not error");
        assert!(result.items.is_empty(), "clean repo: {result:?}");
        assert!(result.prefetched.is_empty());
    }

    #[test]
    fn local_runtime_workspace_changes_with_content_prefetches_modified_files() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "changed body\n").unwrap();
        let runtime = make_local_runtime();

        let result = runtime
            .workspace_changes(WorkspaceChangesParams {
                workspace_dir: dir.path().display().to_string(),
                include_content: true,
            })
            .expect("changes call should succeed");

        assert!(
            result.items.iter().any(|i| i.path == "file.txt"),
            "modified path should appear: {result:?}"
        );
        assert!(
            !result.prefetched.is_empty(),
            "include_content=true should fill prefetched: {result:?}"
        );
    }

    #[test]
    fn local_runtime_workspace_changes_omits_prefetched_when_include_content_false() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "changed body\n").unwrap();
        let runtime = make_local_runtime();

        let result = runtime
            .workspace_changes(WorkspaceChangesParams {
                workspace_dir: dir.path().display().to_string(),
                include_content: false,
            })
            .unwrap();

        assert!(!result.items.is_empty(), "items list should still populate");
        assert!(
            result.prefetched.is_empty(),
            "include_content=false should skip prefetch: {result:?}"
        );
    }

    #[test]
    fn local_runtime_workspace_read_file_returns_content_and_mtime() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let response = runtime
            .workspace_read_file(WorkspaceReadFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
            })
            .expect("read existing file");

        assert_eq!(response.content, "base\n");
        assert!(response.mtime_ms > 0, "mtime should be populated");
    }

    #[test]
    fn local_runtime_workspace_read_file_rejects_parent_traversal() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let err = runtime
            .workspace_read_file(WorkspaceReadFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "../escape.txt".into(),
            })
            .expect_err("parent traversal must be rejected at the seam");
        let msg = format!("{err}");
        assert!(
            msg.contains("`..`"),
            "error should call out the traversal: {msg}"
        );
    }

    #[test]
    fn local_runtime_workspace_read_file_rejects_absolute_relative_path() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let err = runtime
            .workspace_read_file(WorkspaceReadFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "/etc/passwd".into(),
            })
            .expect_err("absolute relative_path must be rejected");
        let msg = format!("{err}");
        assert!(
            msg.contains("must not be absolute"),
            "error should call out the absolute path: {msg}"
        );
    }

    #[test]
    fn local_runtime_workspace_read_file_rejects_empty_relative_path() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let err = runtime
            .workspace_read_file(WorkspaceReadFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: String::new(),
            })
            .expect_err("empty relative_path must be rejected");
        let msg = format!("{err}");
        assert!(msg.contains("must not be empty"), "{msg}");
    }

    #[test]
    fn local_runtime_workspace_read_file_at_ref_returns_committed_content() {
        let dir = init_repo();
        // Modify the working tree so HEAD's content differs from the
        // working file. The function should return the HEAD version.
        std::fs::write(dir.path().join("file.txt"), "changed body\n").unwrap();
        let runtime = make_local_runtime();

        let response = runtime
            .workspace_read_file_at_ref(WorkspaceReadFileAtRefParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
                git_ref: "HEAD".into(),
            })
            .expect("read at HEAD should succeed");

        assert_eq!(
            response.content,
            Some("base\n".to_string()),
            "HEAD should hold the pre-modification body",
        );
    }

    #[test]
    fn local_runtime_workspace_read_file_at_ref_returns_none_for_missing_path() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let response = runtime
            .workspace_read_file_at_ref(WorkspaceReadFileAtRefParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "never-existed.rs".into(),
                git_ref: "HEAD".into(),
            })
            .expect("ref-read on a missing path is `Ok(None)`, not an error");

        assert!(response.content.is_none(), "{response:?}");
    }

    #[test]
    fn local_runtime_workspace_stat_file_reports_existence_and_size() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let response = runtime
            .workspace_stat_file(WorkspaceStatFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
            })
            .expect("stat existing file");

        assert!(response.exists);
        assert!(response.is_file);
        // "base\n" → 5 bytes.
        assert_eq!(response.size, Some(5));
        assert!(response.mtime_ms.is_some());
    }

    #[test]
    fn local_runtime_workspace_stat_file_reports_missing_file_as_exists_false() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let response = runtime
            .workspace_stat_file(WorkspaceStatFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "missing.rs".into(),
            })
            .expect("stat on missing file should still be Ok");

        assert!(!response.exists);
        assert!(!response.is_file);
        assert!(response.size.is_none());
        assert!(response.mtime_ms.is_none());
    }

    #[test]
    fn local_runtime_workspace_mutate_file_write_updates_content_and_mtime() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        let response = runtime
            .workspace_mutate_file(WorkspaceMutateFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
                action: WorkspaceMutateFileAction::Write {
                    content: "new body\n".into(),
                },
            })
            .expect("write existing file");
        assert!(response.mtime_ms.is_some(), "write should report mtime");

        let on_disk = std::fs::read_to_string(dir.path().join("file.txt")).unwrap();
        assert_eq!(on_disk, "new body\n");
    }

    #[test]
    fn local_runtime_workspace_mutate_file_stage_then_unstage_round_trips() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "edited\n").unwrap();
        let runtime = make_local_runtime();

        runtime
            .workspace_mutate_file(WorkspaceMutateFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
                action: WorkspaceMutateFileAction::Stage,
            })
            .expect("stage should succeed");

        // After staging, `git diff --cached` should list the file.
        let cached =
            crate::git_ops::run_git(["diff", "--cached", "--name-only"], Some(dir.path())).unwrap();
        assert!(
            cached.contains("file.txt"),
            "stage should put file in index: {cached:?}"
        );

        runtime
            .workspace_mutate_file(WorkspaceMutateFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
                action: WorkspaceMutateFileAction::Unstage,
            })
            .expect("unstage should succeed");

        let cached_after =
            crate::git_ops::run_git(["diff", "--cached", "--name-only"], Some(dir.path())).unwrap();
        assert!(
            cached_after.is_empty(),
            "unstage should empty the index: {cached_after:?}",
        );
    }

    #[test]
    fn local_runtime_workspace_mutate_file_discard_restores_tracked_file() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "edited\n").unwrap();
        let runtime = make_local_runtime();

        runtime
            .workspace_mutate_file(WorkspaceMutateFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "file.txt".into(),
                action: WorkspaceMutateFileAction::Discard,
            })
            .expect("discard tracked file");

        let on_disk = std::fs::read_to_string(dir.path().join("file.txt")).unwrap();
        assert_eq!(on_disk, "base\n", "discard should restore HEAD content");
    }

    #[test]
    fn local_runtime_workspace_mutate_file_discard_removes_untracked_file() {
        let dir = init_repo();
        std::fs::write(dir.path().join("scratch.txt"), "throwaway\n").unwrap();
        let runtime = make_local_runtime();

        runtime
            .workspace_mutate_file(WorkspaceMutateFileParams {
                workspace_dir: dir.path().display().to_string(),
                relative_path: "scratch.txt".into(),
                action: WorkspaceMutateFileAction::Discard,
            })
            .expect("discard untracked file");

        assert!(
            !dir.path().join("scratch.txt").exists(),
            "discard of an untracked file should delete it"
        );
    }

    #[test]
    fn local_runtime_workspace_mutate_file_propagates_sandbox_violation() {
        let dir = init_repo();
        let runtime = make_local_runtime();

        // Each non-write action runs the sandbox before the git call,
        // so a `..` path can't even reach the git binary.
        for (label, action) in [
            ("stage", WorkspaceMutateFileAction::Stage),
            ("unstage", WorkspaceMutateFileAction::Unstage),
            ("discard", WorkspaceMutateFileAction::Discard),
            (
                "write",
                WorkspaceMutateFileAction::Write {
                    content: "x".into(),
                },
            ),
        ] {
            let err = runtime
                .workspace_mutate_file(WorkspaceMutateFileParams {
                    workspace_dir: dir.path().display().to_string(),
                    relative_path: "../escape".into(),
                    action,
                })
                .expect_err("`..` must be rejected before the underlying op");
            assert!(
                format!("{err}").contains("`..`"),
                "{label}: error should call out the traversal: {err:#}",
            );
        }
    }

    // ── join_workspace_relative ──────────────────────────────────

    #[test]
    fn join_workspace_relative_accepts_nested_relative_paths() {
        let joined =
            join_workspace_relative(Path::new("/tmp/ws"), "src/lib/foo.rs").expect("happy path");
        assert_eq!(joined, PathBuf::from("/tmp/ws/src/lib/foo.rs"));
    }

    #[test]
    fn join_workspace_relative_rejects_dot_dot_anywhere_in_path() {
        // Component-level check — `..` buried inside the path rejects
        // the same as a leading `..`. Prevents `a/../../etc/passwd`.
        let err = join_workspace_relative(Path::new("/tmp/ws"), "a/../../etc/passwd")
            .expect_err("buried `..` must be rejected");
        assert!(format!("{err}").contains("`..`"));
    }

    // ── porcelain parser ─────────────────────────────────────────

    #[test]
    fn parse_porcelain_status_handles_typical_status_codes() {
        // Mix of modified, untracked, deleted. The parser strips the
        // 3-char status prefix and sorts the result.
        let raw = " M src/foo.rs\n?? new.txt\n D removed.rs\n";
        let parsed = parse_porcelain_status(raw);
        assert!(!parsed.is_clean);
        assert_eq!(
            parsed.changed_paths,
            vec![
                "new.txt".to_string(),
                "removed.rs".to_string(),
                "src/foo.rs".to_string(),
            ]
        );
    }

    #[test]
    fn parse_porcelain_status_treats_empty_output_as_clean() {
        let parsed = parse_porcelain_status("");
        assert!(parsed.is_clean);
        assert!(parsed.changed_paths.is_empty());
    }
}
