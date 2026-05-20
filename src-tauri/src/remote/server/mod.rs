//! Server-side state + dispatcher entry point.
//!
//! [`ServerContext`] is the per-connection state — initialized flag,
//! shared agent / terminal registries, the runtime delegation seam.
//! It's threaded through every call to [`dispatch_request`].
//!
//! ## Module layout
//!
//! - [`notifier`] — `Notifier` trait, `NoopNotifier`, `StdoutNotifier`.
//! - [`dispatch`] — `dispatch_request` + the `handle<M, F>` adapter.
//! - [`handlers`] — one `handle_*` function per RPC method.
//!
//! The dispatcher does NOT own the read/write loop — that lives in
//! the `helmor-server` binary so the same dispatcher can drive a
//! loopback test or an in-process integration probe without spinning
//! up a real process.

pub mod crash_history;
mod dispatch;
mod handlers;
pub mod metrics;
mod notifier;

#[cfg(test)]
mod tests;

pub use dispatch::dispatch_request;
pub use notifier::{NoopNotifier, Notifier, StdoutNotifier};

use std::sync::{Arc, Mutex};

use super::agent::RemoteAgentState;
use super::runtime::{LocalRuntime, RemoteRuntime};
use super::terminal::RemoteTerminalState;
use super::watch::RemoteWatchState;

/// Per-connection state. Created when the binary boots, threaded
/// through every dispatch. Today it carries the post-`initialize`
/// gate flag and the server's startup metadata; later phases will
/// add the DB pool, the script-process manager, etc.
pub struct ServerContext {
    /// Set to `true` after a successful `initialize`. Every other
    /// method rejects with `NOT_INITIALIZED` until then so a
    /// confused client (or a probing port-scanner) can't poke at
    /// state without the handshake.
    initialized: Mutex<bool>,
    /// Server binary's package version. Set at startup from
    /// `env!("CARGO_PKG_VERSION")` so the dispatch handler doesn't
    /// re-read it per call.
    server_version: String,
    /// Hostname surfaced in `initialize` responses. `uname -n` on
    /// Unix; later phases can override for friendlier labels.
    hostname: String,
    /// Runtime the server delegates execution to. In the
    /// `helmor-server` binary this is a [`LocalRuntime`] — the
    /// server side of an SSH pair IS the local runtime on the
    /// remote host. Tests can swap in a stub to drive the
    /// dispatcher without shelling out to `git`.
    runtime: Arc<dyn RemoteRuntime>,
    /// Push channel for server-initiated notifications. Handlers
    /// reach this via [`ServerContext::notifier`] and call
    /// `notify(method, params)` to emit. Defaults to
    /// [`NoopNotifier`] so contexts built without a real writer
    /// silently drop notifications.
    notifier: Arc<dyn Notifier>,
    /// Live PTY-backed terminal sessions on this server. Keyed by
    /// client-chosen `terminal_id`. Shared via `Arc` so the
    /// per-session reader threads can keep emitting events even if
    /// the dispatcher's lifetime overlaps with concurrent calls.
    terminal_state: Arc<RemoteTerminalState>,
    /// Live agent (sidecar) bridge. Shared across connections in
    /// daemon mode so the sidecar process outlives any one client —
    /// phase 23d builds the full reattach story on top of this
    /// shared registry. In single-connection mode (used by tests
    /// and the legacy proxy entry point) the state is per-context.
    agent_state: Arc<RemoteAgentState>,
    /// Live workspace file watchers keyed by `watch_id`.
    /// Per-context (per-connection) — watch ids are client-scoped,
    /// so a reconnecting client starts with an empty registry and
    /// re-issues `workspace.startWatch` for whatever it cares about.
    watch_state: Arc<RemoteWatchState>,
    /// Track E2: per-method RPC counters + latency samples. Shared
    /// across connections so the daemon's full traffic profile is
    /// visible from any client's `runtime.metrics` call.
    metrics: Arc<metrics::RpcMetrics>,
    /// Track E2: snapshot of context creation time, used to report
    /// daemon uptime alongside the metrics result. `Instant`-based
    /// so we don't depend on wall-clock corrections during the
    /// daemon's lifetime.
    started_at: std::time::Instant,
}

impl ServerContext {
    pub fn new(server_version: impl Into<String>, hostname: impl Into<String>) -> Self {
        let hostname = hostname.into();
        let runtime: Arc<dyn RemoteRuntime> =
            Arc::new(LocalRuntime::with_hostname(hostname.clone()));
        Self {
            initialized: Mutex::new(false),
            server_version: server_version.into(),
            hostname,
            runtime,
            notifier: Arc::new(NoopNotifier),
            terminal_state: Arc::new(RemoteTerminalState::new()),
            agent_state: Arc::new(RemoteAgentState::disabled(
                "agent runtime not configured for this context",
            )),
            watch_state: Arc::new(RemoteWatchState::new()),
            metrics: Arc::new(metrics::RpcMetrics::new()),
            started_at: std::time::Instant::now(),
        }
    }

    /// Construct with a caller-supplied runtime. Used by tests to
    /// inject a fake; production code goes through [`Self::new`].
    pub fn with_runtime(
        server_version: impl Into<String>,
        hostname: impl Into<String>,
        runtime: Arc<dyn RemoteRuntime>,
    ) -> Self {
        Self {
            initialized: Mutex::new(false),
            server_version: server_version.into(),
            hostname: hostname.into(),
            runtime,
            notifier: Arc::new(NoopNotifier),
            terminal_state: Arc::new(RemoteTerminalState::new()),
            agent_state: Arc::new(RemoteAgentState::disabled(
                "agent runtime not configured for this context",
            )),
            watch_state: Arc::new(RemoteWatchState::new()),
            metrics: Arc::new(metrics::RpcMetrics::new()),
            started_at: std::time::Instant::now(),
        }
    }

    /// Builder-style: attach a notifier to an existing context.
    /// Used by the binary to wire its `StdoutNotifier` in *after*
    /// constructing the context with the real runtime.
    pub fn set_notifier(&mut self, notifier: Arc<dyn Notifier>) {
        self.notifier = notifier;
    }

    /// Builder-style: swap in a shared `RemoteTerminalState`. The
    /// daemon uses this so every accepted connection shares one
    /// PTY registry — otherwise each new SSH session would see a
    /// fresh empty `terminal.list`, defeating the whole reattach
    /// story.
    pub fn set_terminal_state(&mut self, terminal_state: Arc<RemoteTerminalState>) {
        self.terminal_state = terminal_state;
    }

    /// Builder-style: swap in a shared `RemoteAgentState`. The
    /// daemon uses this so every accepted connection routes to the
    /// same sidecar bridge — agent.list across reconnect sees the
    /// same active sessions instead of starting fresh.
    pub fn set_agent_state(&mut self, agent_state: Arc<RemoteAgentState>) {
        self.agent_state = agent_state;
    }

    /// Handler entry point for emitting notifications. Public so
    /// handlers in this module (and tests) can reach the notifier
    /// without crawling private fields.
    pub fn notifier(&self) -> &Arc<dyn Notifier> {
        &self.notifier
    }

    /// Per-context PTY state. Tests reach in to assert "session
    /// closed" / "still running"; the dispatcher handlers use it to
    /// open / write / resize / close.
    pub fn terminal_state(&self) -> &Arc<RemoteTerminalState> {
        &self.terminal_state
    }

    /// Per-context agent bridge. Handlers reach this to forward
    /// `agent.send` / `agent.abort` / `agent.list` / `agent.attach`
    /// into the sidecar bridge. `Arc` shared across connections in
    /// daemon mode so the sidecar process is not torn down on each
    /// reconnect.
    pub fn agent_state(&self) -> &Arc<RemoteAgentState> {
        &self.agent_state
    }

    /// Per-context workspace watcher registry. Handlers reach this
    /// for `workspace.startWatch` / `workspace.stopWatch`. The
    /// registry is per-connection — a reconnecting client starts
    /// with an empty set and re-issues watches as needed.
    pub fn watch_state(&self) -> &Arc<RemoteWatchState> {
        &self.watch_state
    }

    /// Track E2: shared RPC metrics registry. The dispatcher records
    /// each call's latency + outcome here; the `runtime.metrics`
    /// handler snapshots it.
    pub fn metrics(&self) -> &Arc<metrics::RpcMetrics> {
        &self.metrics
    }

    /// Track E2: daemon uptime since this context was constructed.
    /// Surfaced in `runtime.metrics` so the desktop can compute
    /// calls/sec without needing its own wall-clock anchor.
    pub fn uptime(&self) -> std::time::Duration {
        self.started_at.elapsed()
    }

    /// Server binary version — surfaced in `initialize` responses.
    pub(super) fn server_version(&self) -> &str {
        &self.server_version
    }

    /// Hostname — surfaced in `initialize` responses.
    pub(super) fn hostname(&self) -> &str {
        &self.hostname
    }

    /// Runtime delegation seam used by workspace handlers.
    pub(super) fn runtime(&self) -> &Arc<dyn RemoteRuntime> {
        &self.runtime
    }

    pub(super) fn is_initialized(&self) -> bool {
        *self.initialized.lock().expect("ctx mutex poisoned")
    }

    pub(super) fn mark_initialized(&self) {
        *self.initialized.lock().expect("ctx mutex poisoned") = true;
    }
}
