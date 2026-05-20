//! Transport abstraction for the desktop's sidecar plumbing (phase 23c).
//!
//! Pre-phase-23 the streaming pipeline talked to one specific thing —
//! the desktop's local [`crate::sidecar::ManagedSidecar`]. Phase 23a/b
//! lifted the sidecar onto the daemon; this commit makes the desktop
//! transport-agnostic so a workspace bound to a remote runtime sends
//! through the remote's `agent.send` instead of spawning a local
//! sidecar.
//!
//! ## Design
//!
//! - **[`SidecarTransport`]** is the narrow trait the pipeline talks
//!   to: `send` writes a `SidecarRequest`, `subscribe` returns an
//!   `mpsc::Receiver<SidecarEvent>`, `unsubscribe` releases the
//!   listener slot. Three methods, same shape `ManagedSidecar`
//!   already exposed — the local impl is a thin delegation; the
//!   remote impl bridges `agent.event` JSON-RPC notifications back
//!   into the same channel-of-events shape.
//! - **[`LocalSidecarTransport`]** wraps the desktop's existing
//!   `ManagedSidecar`. No behavioural change for local workspaces.
//! - **[`RemoteSidecarTransport`]** holds an `Arc<dyn RemoteRuntime>`,
//!   calls `runtime.agent_send` on `send`, and subscribes to
//!   `agent.event` notifications. The notification's raw `event`
//!   field is the sidecar's `SidecarEvent.raw` JSON unchanged — the
//!   accumulator + persistence don't know which side of the SSH pipe
//!   produced the bytes.
//! - **Persistence is transport-agnostic.** Same rows, same
//!   accumulator, same UI. The transport's only job is "writes go
//!   to the right sidecar; events come back".

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

use crate::remote::client::NotificationSubscription;
use crate::remote::methods::{AgentAbortParams, AgentSendParams};
use crate::remote::registry::{RuntimeRegistry, LOCAL_RUNTIME_NAME};
use crate::remote::runtime::RemoteRuntime;
use crate::remote::workspace_bindings::WorkspaceRuntimeBindings;
use crate::sidecar::{ManagedSidecar, SidecarEvent, SidecarRequest};

/// What flavour of transport this is — used by telemetry / logging
/// to record which side of the SSH pipe a turn dispatched through,
/// and by tests to assert the resolver picked the right one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    /// Desktop's local `helmor-sidecar` child process. Used for
    /// workspaces with `runtime_name IS NULL` (or `"local"`) and
    /// for anonymous streams.
    Local,
    /// Remote runtime over the JSON-RPC pipe. Used for workspaces
    /// bound to a registered remote.
    Remote,
}

/// What the streaming pipeline needs to drive a turn:
/// - write a `SidecarRequest` line that asks the sidecar to do
///   something (sendMessage / abort / updateConfig / etc.);
/// - subscribe to the events that come back, keyed by request id;
/// - tear down the subscription on error or completion.
///
/// `Send + Sync + 'static` so the trait object can move into the
/// `spawn_blocking` closure the event loop runs on.
pub trait SidecarTransport: Send + Sync + 'static {
    /// Write `request` to the sidecar's input. The transport owns
    /// any underlying I/O retry / re-spawn policy; the caller treats
    /// this as a single non-blocking ask.
    fn send(&self, request: &SidecarRequest) -> Result<()>;

    /// Register a per-`request_id` listener and return the
    /// `Receiver` half. The transport is responsible for fanning
    /// events with a matching `id` field onto this channel. Multiple
    /// concurrent subscribers (different request_ids) are supported.
    fn subscribe(&self, request_id: &str) -> mpsc::Receiver<SidecarEvent>;

    /// Drop the listener for `request_id`. Idempotent — calling
    /// twice (or on an unknown id) is a no-op. Required so the
    /// streaming pipeline can release the slot when a turn ends or
    /// errors out without waiting for the receiver to be dropped
    /// (it's stored on the stack frame that owns the event loop).
    fn unsubscribe(&self, request_id: &str);

    /// Surface which flavour this is. Drives telemetry / logging on
    /// the production hot path; tests use it to assert the resolver
    /// picked the right transport without downcasting.
    fn kind(&self) -> TransportKind;
}

// ── LocalSidecarTransport ────────────────────────────────────────────

/// The historical path: spawn `helmor-sidecar` as a desktop child
/// process and talk to it directly. Wraps the existing
/// [`ManagedSidecar`] verbatim — every method just delegates.
///
/// Local workspaces (i.e. `workspaces.runtime_name IS NULL` after
/// phase 22b) keep using this transport unchanged. The
/// `ManagedSidecar` itself stays managed by Tauri state so its
/// lifecycle (single instance for the lifetime of the desktop)
/// matches the pre-phase-23 behaviour.
pub struct LocalSidecarTransport {
    sidecar: Arc<ManagedSidecar>,
}

impl LocalSidecarTransport {
    pub fn new(sidecar: Arc<ManagedSidecar>) -> Self {
        Self { sidecar }
    }
}

impl SidecarTransport for LocalSidecarTransport {
    fn send(&self, request: &SidecarRequest) -> Result<()> {
        self.sidecar.send(request)
    }

    fn subscribe(&self, request_id: &str) -> mpsc::Receiver<SidecarEvent> {
        self.sidecar.subscribe(request_id)
    }

    fn unsubscribe(&self, request_id: &str) {
        self.sidecar.unsubscribe(request_id);
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Local
    }
}

// ── RemoteSidecarTransport ──────────────────────────────────────────

/// The phase-23 path: a workspace bound to a registered remote
/// runtime sends `agent.send` JSON-RPC requests across the SSH pipe;
/// events flow back as `agent.event` notifications that the
/// transport unwraps into the same [`SidecarEvent`] shape the local
/// path uses.
///
/// One transport instance per send call is the expected pattern —
/// the underlying [`RemoteRuntime`] (typically `RemoteSshRuntime`)
/// outlives the transport and can support many concurrent turns
/// against the same pipe; the transport is just a per-call adapter.
pub struct RemoteSidecarTransport {
    runtime: Arc<dyn RemoteRuntime>,
    /// One `NotificationSubscription` per active `request_id`.
    /// Drop semantics on the handle unregister the callback from the
    /// underlying `RpcClient`, so dropping the transport (or calling
    /// `unsubscribe`) tears down the pipeline cleanly.
    subscriptions: Arc<Mutex<HashMap<String, RemoteSubscription>>>,
}

/// Bundles the per-request subscription's RAII handle with the
/// matching `Sender` half so the runtime's notification callback can
/// dispatch through it without re-locking the subscriptions map on
/// the hot path.
struct RemoteSubscription {
    _handle: NotificationSubscription,
}

impl RemoteSidecarTransport {
    pub fn new(runtime: Arc<dyn RemoteRuntime>) -> Self {
        Self {
            runtime,
            subscriptions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl SidecarTransport for RemoteSidecarTransport {
    fn send(&self, request: &SidecarRequest) -> Result<()> {
        // The remote's `agent.send` mirrors the SidecarRequest shape
        // 1:1: request_id, method, params. The daemon shovels the
        // params blob into its own SidecarRequest verbatim so the
        // upstream SDK contract stays unchanged.
        let params = AgentSendParams {
            request_id: request.id.clone(),
            method: request.method.clone(),
            params: request.params.clone(),
        };
        let result = self.runtime.agent_send(params).with_context(|| {
            format!(
                "agent.send to remote runtime failed (request_id={})",
                request.id
            )
        })?;
        if !result.accepted {
            anyhow::bail!(
                "remote runtime rejected agent.send (request_id={})",
                request.id
            );
        }
        Ok(())
    }

    fn subscribe(&self, request_id: &str) -> mpsc::Receiver<SidecarEvent> {
        let (tx, rx) = mpsc::channel::<SidecarEvent>();
        let needle = request_id.to_string();
        // Subscribe to every `agent.event` notification; filter
        // inside the callback by `request_id`. The filter keeps the
        // transport simple at the cost of a per-event string
        // comparison — for the spike's event volume this is fine.
        // Phase 24-ish polish could reach into the RpcClient's
        // subscriber list to register a per-id subscription.
        let handle = self.runtime.subscribe_agent_events(Box::new(move |notif| {
            if notif.request_id != needle {
                return;
            }
            let event = SidecarEvent {
                raw: notif.event,
                seq: notif.seq,
            };
            // Dropping the receiver before unsubscribe is a
            // benign race — the send returns Err, we ignore it.
            let _ = tx.send(event);
        }));
        match handle {
            Some(handle) => {
                self.subscriptions
                    .lock()
                    .expect("remote subscriptions mutex poisoned")
                    .insert(
                        request_id.to_string(),
                        RemoteSubscription { _handle: handle },
                    );
            }
            None => {
                // The runtime returned None — should never happen
                // for `RemoteSshRuntime`, but local / tombstoned
                // runtimes do. Log it and return an empty receiver
                // (which will recv-disconnect immediately). The
                // streaming pipeline surfaces that as
                // `SidecarDisconnected` and the user-facing toast
                // explains the connection isn't there.
                tracing::warn!(
                    request_id = %request_id,
                    "remote sidecar transport: runtime does not support agent.event subscriptions"
                );
            }
        }
        rx
    }

    fn unsubscribe(&self, request_id: &str) {
        let mut guard = self
            .subscriptions
            .lock()
            .expect("remote subscriptions mutex poisoned");
        guard.remove(request_id);
        // Dropping the `RemoteSubscription` here also drops its
        // `_handle: NotificationSubscription`, which in turn drops
        // the closure registration on the `RpcClient`. The callback
        // stops firing immediately.
    }

    fn kind(&self) -> TransportKind {
        TransportKind::Remote
    }
}

impl RemoteSidecarTransport {
    /// Convenience: forward an abort over `agent.abort`. The
    /// streaming pipeline today writes a `stopSession` SidecarRequest
    /// when it wants to cancel; the abort path goes through `send`
    /// (the request envelope reaches the remote sidecar verbatim).
    /// This helper exists for callers that want a typed entry point
    /// — phase 23d's reattach UX uses it.
    #[allow(dead_code)] // Used in phase 23d's reattach path.
    pub fn abort(&self, request_id: &str) -> Result<()> {
        self.runtime
            .agent_abort(AgentAbortParams {
                request_id: request_id.to_string(),
            })
            .with_context(|| format!("agent.abort failed (request_id={request_id})"))?;
        Ok(())
    }
}

// ── resolver ─────────────────────────────────────────────────────────

/// Pick the right transport given a runtime name + registry. Owned
/// by tests so the binding-aware glue stays testable without a real
/// `AppHandle`. Production callers prefer [`resolve_transport`]
/// which wires the runtime-name lookup through Tauri state.
///
/// Precedence:
/// 1. `runtime_name` is `None`, empty, or `"local"` → local sidecar.
/// 2. Registry missing → local (logged at warn — phase 22a's
///    contract is "absent registry ≡ no remote bindings").
/// 3. Registry doesn't know the name → local (logged at warn — same
///    fall-through that `commands::resolve_runtime_for_call` uses).
/// 4. Found a live runtime → wrap in [`RemoteSidecarTransport`].
pub fn resolve_transport_with_registry(
    sidecar: Arc<ManagedSidecar>,
    runtime_name: Option<&str>,
    registry: Option<Arc<RuntimeRegistry>>,
) -> Arc<dyn SidecarTransport> {
    let local: Arc<dyn SidecarTransport> = Arc::new(LocalSidecarTransport::new(sidecar));
    let Some(name) = runtime_name
        .map(str::trim)
        .filter(|n| !n.is_empty() && *n != LOCAL_RUNTIME_NAME)
    else {
        return local;
    };
    let Some(registry) = registry else {
        tracing::warn!(
            bound_runtime = %name,
            "transport resolver: runtime registry not in app state; falling back to local sidecar"
        );
        return local;
    };
    match registry.lookup(Some(name)) {
        Ok(runtime) => Arc::new(RemoteSidecarTransport::new(runtime)),
        Err(err) => {
            tracing::warn!(
                bound_runtime = %name,
                error = %format!("{err:#}"),
                "transport resolver: bound runtime not registered; falling back to local sidecar"
            );
            local
        }
    }
}

/// AppHandle wrapper for [`resolve_transport_with_registry`]. Looks
/// up the workspace's bound runtime name for the session, then
/// hands the pure resolver the registry from Tauri state. Anonymous
/// streams (no session id) skip the lookup entirely.
pub fn resolve_transport(
    app: &AppHandle,
    sidecar: Arc<ManagedSidecar>,
    helmor_session_id: Option<&str>,
) -> Arc<dyn SidecarTransport> {
    let runtime_name = helmor_session_id
        .filter(|s| !s.is_empty())
        .and_then(|hsid| resolve_runtime_name_for_session(app, hsid));
    let registry = app
        .try_state::<Arc<RuntimeRegistry>>()
        .map(|s| Arc::clone(&s));
    resolve_transport_with_registry(sidecar, runtime_name.as_deref(), registry)
}

/// Read the workspace's bound runtime name for a helmor session id.
/// Consults the `workspaces.runtime_name` column first (phase 22b's
/// load-bearing surface), then the legacy JSON sidecar binding store
/// (`WorkspaceRuntimeBindings`) as a fallback for rows the backfill
/// hasn't reached. `None` and `Some("local")` are equivalent —
/// callers should treat both as "use the local sidecar".
fn resolve_runtime_name_for_session(app: &AppHandle, helmor_session_id: &str) -> Option<String> {
    // session → workspace_id. One query, fail-soft (no toast — the
    // worst case is a fallback to local, which is the same row's
    // pre-binding behaviour anyway).
    let workspace_id: Option<String> = crate::models::db::read_conn()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT workspace_id FROM sessions WHERE id = ?1",
                [helmor_session_id],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
        })
        .flatten();
    let workspace_id = workspace_id?;

    // workspaces.runtime_name (column-first, sidecar fallback —
    // mirrors the resolver in `commands::remote_commands`).
    if let Some(name) = crate::models::workspaces::load_workspace_runtime_name(&workspace_id)
        .ok()
        .flatten()
    {
        return Some(name);
    }
    let bindings = app.try_state::<Arc<WorkspaceRuntimeBindings>>()?;
    bindings.lookup(&workspace_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Stub runtime that captures every `agent_send` call + supports
    /// `subscribe_agent_events` via an in-memory callback list. Tests
    /// drive it to assert the transport's wire shape without
    /// standing up a real SSH connection.
    type AgentEventCallback =
        Box<dyn Fn(crate::remote::methods::AgentEventNotification) + Send + Sync>;

    struct StubRuntime {
        sent: Mutex<Vec<AgentSendParams>>,
        aborts: Mutex<Vec<AgentAbortParams>>,
        callbacks: Arc<Mutex<Vec<AgentEventCallback>>>,
        /// Toggle so `subscribe_agent_events` can return `None` to
        /// exercise the transport's graceful-fallback path.
        emit_subscription: bool,
    }

    impl StubRuntime {
        fn new() -> Self {
            Self {
                sent: Mutex::new(Vec::new()),
                aborts: Mutex::new(Vec::new()),
                callbacks: Arc::new(Mutex::new(Vec::new())),
                emit_subscription: true,
            }
        }

        fn no_subscription_support() -> Self {
            Self {
                emit_subscription: false,
                ..Self::new()
            }
        }

        fn fire(&self, notif: crate::remote::methods::AgentEventNotification) {
            let cbs = self.callbacks.lock().unwrap();
            for cb in cbs.iter() {
                cb(notif.clone());
            }
        }
    }

    impl RemoteRuntime for StubRuntime {
        fn runtime_health(&self) -> Result<crate::remote::runtime::RuntimeHealth> {
            unimplemented!("not used by transport tests")
        }
        fn workspace_status(
            &self,
            _: &std::path::Path,
        ) -> Result<crate::remote::methods::WorkspaceStatusResult> {
            unimplemented!()
        }
        fn workspace_branch_info(
            &self,
            _: &std::path::Path,
        ) -> Result<crate::remote::methods::WorkspaceBranchInfoResult> {
            unimplemented!()
        }
        fn ping(&self) -> Result<()> {
            Ok(())
        }
        fn agent_send(
            &self,
            params: AgentSendParams,
        ) -> Result<crate::remote::methods::AgentSendResult> {
            self.sent.lock().unwrap().push(params);
            Ok(crate::remote::methods::AgentSendResult { accepted: true })
        }
        fn agent_abort(
            &self,
            params: AgentAbortParams,
        ) -> Result<crate::remote::methods::AgentAbortResult> {
            self.aborts.lock().unwrap().push(params);
            Ok(crate::remote::methods::AgentAbortResult::default())
        }
        fn subscribe_agent_events(
            &self,
            callback: Box<dyn Fn(crate::remote::methods::AgentEventNotification) + Send + Sync>,
        ) -> Option<NotificationSubscription> {
            if !self.emit_subscription {
                return None;
            }
            self.callbacks.lock().unwrap().push(callback);
            // The closure is captured above into `self.callbacks`;
            // the returned handle is a dangling one whose `Drop` is a
            // no-op. Tests don't need a real RAII contract because
            // the transport's `unsubscribe` removes the callback from
            // the stub's own list (mirroring what the real client
            // does for production paths).
            Some(NotificationSubscription::dangling_for_tests())
        }
    }

    #[test]
    fn local_transport_delegates_to_managed_sidecar() {
        // We can't easily stand up a real ManagedSidecar without a
        // sidecar binary, so this test just locks the construction
        // surface. The end-to-end "events flow" path is covered by
        // the existing `crate::sidecar::tests`.
        let sidecar = Arc::new(ManagedSidecar::new());
        let transport = LocalSidecarTransport::new(sidecar);
        // subscribe / unsubscribe are infallible no-ops on a never-
        // started sidecar; we just exercise the trait-object path
        // to lock the API.
        let _rx = transport.subscribe("req-1");
        transport.unsubscribe("req-1");
    }

    #[test]
    fn remote_transport_send_forwards_through_agent_send() {
        let runtime = Arc::new(StubRuntime::new());
        let transport = RemoteSidecarTransport::new(runtime.clone() as Arc<dyn RemoteRuntime>);
        let req = SidecarRequest {
            id: "req-1".into(),
            method: "sendMessage".into(),
            params: json!({ "model": "claude", "prompt": "hi" }),
        };
        transport.send(&req).unwrap();
        let calls = runtime.sent.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].request_id, "req-1");
        assert_eq!(calls[0].method, "sendMessage");
        assert_eq!(calls[0].params["model"], "claude");
    }

    #[test]
    fn remote_transport_send_bails_when_runtime_rejects() {
        // Build a runtime that explicitly rejects (returns
        // accepted=false). The transport surfaces it as an error
        // rather than silently dropping the request.
        struct RejectingRuntime;
        impl RemoteRuntime for RejectingRuntime {
            fn runtime_health(&self) -> Result<crate::remote::runtime::RuntimeHealth> {
                unimplemented!()
            }
            fn workspace_status(
                &self,
                _: &std::path::Path,
            ) -> Result<crate::remote::methods::WorkspaceStatusResult> {
                unimplemented!()
            }
            fn workspace_branch_info(
                &self,
                _: &std::path::Path,
            ) -> Result<crate::remote::methods::WorkspaceBranchInfoResult> {
                unimplemented!()
            }
            fn ping(&self) -> Result<()> {
                Ok(())
            }
            fn agent_send(
                &self,
                _: AgentSendParams,
            ) -> Result<crate::remote::methods::AgentSendResult> {
                Ok(crate::remote::methods::AgentSendResult { accepted: false })
            }
        }
        let transport: RemoteSidecarTransport =
            RemoteSidecarTransport::new(Arc::new(RejectingRuntime));
        let err = transport
            .send(&SidecarRequest {
                id: "req-2".into(),
                method: "sendMessage".into(),
                params: json!({}),
            })
            .unwrap_err();
        assert!(
            format!("{err:#}").contains("rejected agent.send"),
            "error should mention the rejection: {err:#}"
        );
    }

    #[test]
    fn remote_transport_subscribe_routes_matching_request_id_to_the_receiver() {
        let runtime = Arc::new(StubRuntime::new());
        let transport = RemoteSidecarTransport::new(runtime.clone() as Arc<dyn RemoteRuntime>);
        let rx = transport.subscribe("req-3");

        // Emit two events: one matching, one unrelated. Only the
        // matching one should land on the receiver.
        runtime.fire(crate::remote::methods::AgentEventNotification {
            request_id: "req-other".into(),
            event: json!({ "type": "assistant", "delta": "skip me" }),
            seq: None,
        });
        runtime.fire(crate::remote::methods::AgentEventNotification {
            request_id: "req-3".into(),
            event: json!({ "type": "assistant", "delta": "for me" }),
            seq: None,
        });

        let event = rx
            .recv_timeout(std::time::Duration::from_millis(200))
            .expect("subscriber should receive the matching event");
        assert_eq!(event.raw["type"], "assistant");
        assert_eq!(event.raw["delta"], "for me");
        // No further event queued.
        assert!(
            rx.try_recv().is_err(),
            "unrelated request_id must not flow to this receiver"
        );
    }

    #[test]
    fn remote_transport_unsubscribe_drops_the_listener_handle() {
        let runtime = Arc::new(StubRuntime::new());
        let transport = RemoteSidecarTransport::new(runtime.clone() as Arc<dyn RemoteRuntime>);
        let _rx = transport.subscribe("req-4");
        {
            let map = transport.subscriptions.lock().unwrap();
            assert_eq!(map.len(), 1);
        }
        transport.unsubscribe("req-4");
        let map = transport.subscriptions.lock().unwrap();
        assert!(
            map.is_empty(),
            "unsubscribe should remove the entry from the per-request map"
        );
        // Idempotent: a second unsubscribe is a no-op.
        drop(map);
        transport.unsubscribe("req-4");
    }

    #[test]
    fn remote_transport_subscribe_gracefully_handles_runtime_without_subscriptions() {
        // Mirrors the case where the binding-aware resolver hands us
        // a `LocalRuntime` or a tombstone — `subscribe_agent_events`
        // returns `None`. The transport must not panic; the
        // returned receiver disconnects immediately.
        let runtime = Arc::new(StubRuntime::no_subscription_support());
        let transport = RemoteSidecarTransport::new(runtime as Arc<dyn RemoteRuntime>);
        let rx = transport.subscribe("req-5");
        // The Sender side was dropped (we never stored it) so the
        // receiver should disconnect.
        let result = rx.recv_timeout(std::time::Duration::from_millis(50));
        assert!(
            result.is_err(),
            "no-subscription runtime should leave the receiver disconnected, got {result:?}"
        );
    }

    #[test]
    fn remote_transport_abort_forwards_through_agent_abort() {
        let runtime = Arc::new(StubRuntime::new());
        let transport = RemoteSidecarTransport::new(runtime.clone() as Arc<dyn RemoteRuntime>);
        transport.abort("req-6").unwrap();
        let aborts = runtime.aborts.lock().unwrap();
        assert_eq!(aborts.len(), 1);
        assert_eq!(aborts[0].request_id, "req-6");
    }

    // ── resolver (phase 23c) ──────────────────────────────────────

    fn is_local(t: &Arc<dyn SidecarTransport>) -> bool {
        t.kind() == TransportKind::Local
    }

    fn dummy_sidecar() -> Arc<ManagedSidecar> {
        Arc::new(ManagedSidecar::new())
    }

    fn registry_with_stub(name: &str) -> Arc<RuntimeRegistry> {
        let registry = Arc::new(RuntimeRegistry::new());
        // Register a stub runtime under `name`. The registry's
        // own tests already cover lookups; here we just need any
        // valid runtime entry.
        registry
            .register(
                name,
                Arc::new(StubRuntime::new()) as Arc<dyn RemoteRuntime>,
                None,
            )
            .unwrap();
        registry
    }

    #[test]
    fn resolver_returns_local_for_none_runtime_name() {
        let transport = resolve_transport_with_registry(dummy_sidecar(), None, None);
        assert!(is_local(&transport));
    }

    #[test]
    fn resolver_returns_local_for_empty_and_local_runtime_names() {
        for name in [Some(""), Some("local"), Some("  "), None] {
            let transport = resolve_transport_with_registry(
                dummy_sidecar(),
                name,
                Some(registry_with_stub("dev.box")),
            );
            assert!(
                is_local(&transport),
                "name {name:?} should resolve to local"
            );
        }
    }

    #[test]
    fn resolver_returns_remote_when_registry_has_matching_runtime() {
        let registry = registry_with_stub("dev.box");
        let transport =
            resolve_transport_with_registry(dummy_sidecar(), Some("dev.box"), Some(registry));
        assert!(
            !is_local(&transport),
            "registered remote runtime should produce a RemoteSidecarTransport"
        );
    }

    #[test]
    fn resolver_falls_back_to_local_when_registry_missing() {
        // Phase 22a's contract: "absent registry ≡ no remote
        // bindings". The resolver should warn + degrade to local
        // rather than panic.
        let transport = resolve_transport_with_registry(dummy_sidecar(), Some("dev.box"), None);
        assert!(is_local(&transport));
    }

    #[test]
    fn resolver_falls_back_to_local_when_registry_lookup_misses() {
        // Bound runtime name doesn't match any registered entry —
        // same situation `commands::resolve_runtime_for_call`
        // handles: warn + degrade to local.
        let registry = registry_with_stub("staging.box");
        let transport = resolve_transport_with_registry(
            dummy_sidecar(),
            Some("dev.box"), // not registered
            Some(registry),
        );
        assert!(
            is_local(&transport),
            "unregistered runtime name should fall back to local"
        );
    }
}
