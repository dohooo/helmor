//! Background liveness probe for registered remote runtimes.
//!
//! Spawned once at app startup ([`crate::lib`]). Iterates over
//! [`RuntimeRegistry`]'s remote entries on a fixed cadence, pings
//! each one, and updates the entry's [`RuntimeState`] based on the
//! result. State transitions are broadcast via
//! [`UiMutationEvent::RuntimeStateChanged`] so the frontend chip
//! flips colour without polling.
//!
//! ## State machine
//!
//! ```text
//!     Connected ──ping fail──► Degraded ──ping fail──► Disconnected
//!         ▲                       │                          │
//!         └────ping succeeds──────┴─────────ping succeeds────┘
//! ```
//!
//! One failed ping moves Connected → Degraded. A second consecutive
//! failure pushes Degraded → Disconnected. Any successful ping
//! brings the entry back to Connected, regardless of where it was —
//! the spike doesn't yet differentiate between "transient blip" and
//! "real outage" beyond consecutive-count.
//!
//! ## Timeouts
//!
//! Each ping runs on a `spawn_blocking` task with a hard timeout via
//! [`tokio::time::timeout`]. If the ping doesn't respond inside the
//! window, we treat it as a failure and move on — the inner blocking
//! task continues until the pipe is killed (by `Drop` when the entry
//! is unregistered, or eventually by the OS on app shutdown).

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tokio::time::{sleep, timeout};

use crate::ui_sync::{publish, UiMutationEvent};

use super::registry::{RuntimeRegistry, RuntimeState};
use super::runtime::RemoteRuntime;

/// How often the loop ticks. 10s is the sweet spot: long enough that a
/// healthy connection doesn't burn CPU on the SSH child, short enough
/// that a dead pipe surfaces within a noticeable window.
pub const POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Per-ping timeout. SSH itself has a much longer keepalive default
/// (~5 min), so anything past a few seconds is almost certainly a
/// hang. We choose 5s to leave headroom for slow cold pipes without
/// pretending the network is healthy when it isn't.
pub const PING_TIMEOUT: Duration = Duration::from_secs(5);

/// Spawn the liveness loop. Returns immediately; the loop runs until
/// the host process exits (no explicit shutdown — Tauri reaps tokio
/// tasks on quit). Idempotent enough to call once per app boot; the
/// setup hook is the natural caller.
pub fn spawn_liveness_loop<R: Runtime>(app: AppHandle<R>, registry: Arc<RuntimeRegistry>) {
    tauri::async_runtime::spawn(async move {
        run_liveness_loop(app, registry, POLL_INTERVAL, PING_TIMEOUT).await;
    });
}

/// The actual tick loop. Factored out of `spawn_liveness_loop` so
/// tests can drive it with a tighter cadence + a controlled clock.
pub async fn run_liveness_loop<R: Runtime>(
    app: AppHandle<R>,
    registry: Arc<RuntimeRegistry>,
    interval: Duration,
    ping_timeout: Duration,
) {
    loop {
        sleep(interval).await;
        tick_once(&app, &registry, ping_timeout).await;
    }
}

/// One tick: snapshot the registry, ping each remote, update state on
/// change. Public so the test harness can call it directly without
/// waiting for the interval.
pub async fn tick_once<R: Runtime>(
    app: &AppHandle<R>,
    registry: &Arc<RuntimeRegistry>,
    ping_timeout: Duration,
) {
    let snapshot = registry.remote_snapshot();
    for (name, runtime, prior) in snapshot {
        let next = probe_once(runtime, &prior, ping_timeout).await;
        if next != prior {
            if let Some(_replaced) = registry.set_state(&name, next.clone()) {
                publish(
                    app,
                    UiMutationEvent::RuntimeStateChanged {
                        name: name.clone(),
                        state: next,
                    },
                );
            }
            // `None` from set_state means the entry got unregistered
            // between snapshot + set — that's fine, skip the event.
        }
    }
}

/// Run one ping against `runtime` and project the result into the
/// next [`RuntimeState`]. Pure function over the prior state — easy
/// to unit-test the transitions.
async fn probe_once(
    runtime: Arc<dyn RemoteRuntime>,
    prior: &RuntimeState,
    ping_timeout: Duration,
) -> RuntimeState {
    // Trait's `ping` is sync (the call is blocking I/O). Push it onto
    // the blocking pool so we don't stall the tokio runtime if a peer
    // is slow.
    let ping_handle = tauri::async_runtime::spawn_blocking(move || runtime.ping());

    let outcome: Result<anyhow::Result<()>, tokio::time::error::Elapsed> =
        timeout(ping_timeout, ping_handle)
            .await
            .map(|join| match join {
                Ok(result) => result,
                Err(join_err) => Err(anyhow::anyhow!("ping task panicked: {join_err}")),
            });

    match outcome {
        Ok(Ok(())) => RuntimeState::Connected,
        Ok(Err(err)) => degrade_or_disconnect(prior, format!("{err:#}")),
        Err(_elapsed) => {
            degrade_or_disconnect(prior, format!("ping timed out after {ping_timeout:?}"))
        }
    }
}

/// Project a ping failure onto the next state. One failure trips the
/// entry to Degraded; two consecutive failures escalate to
/// Disconnected. `reason` is preserved verbatim for the UI.
fn degrade_or_disconnect(prior: &RuntimeState, reason: String) -> RuntimeState {
    match prior {
        RuntimeState::Connected => RuntimeState::Degraded { reason },
        RuntimeState::Degraded { .. } | RuntimeState::Disconnected { .. } => {
            RuntimeState::Disconnected { reason }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::Mutex;

    use crate::remote::methods::WorkspaceStatusResult;
    use crate::remote::runtime::{RuntimeHealth, RuntimeKind};

    /// Configurable stub: each `ping()` call pops the front of `outcomes`
    /// and returns it. Tests load it with `Ok`/`Err` sequences to drive
    /// state transitions.
    struct ScriptedRuntime {
        outcomes: Mutex<std::collections::VecDeque<anyhow::Result<()>>>,
    }

    impl ScriptedRuntime {
        fn new<I: IntoIterator<Item = anyhow::Result<()>>>(outcomes: I) -> Self {
            Self {
                outcomes: Mutex::new(outcomes.into_iter().collect()),
            }
        }
    }

    impl RemoteRuntime for ScriptedRuntime {
        fn runtime_health(&self) -> anyhow::Result<RuntimeHealth> {
            Ok(RuntimeHealth {
                kind: RuntimeKind::Remote {
                    host: "scripted".into(),
                },
                hostname: "scripted".into(),
                version: "0.0.0".into(),
            })
        }
        fn workspace_status(&self, _: &Path) -> anyhow::Result<WorkspaceStatusResult> {
            unreachable!("liveness tests don't probe workspace_status")
        }
        fn ping(&self) -> anyhow::Result<()> {
            self.outcomes
                .lock()
                .expect("outcomes mutex poisoned")
                .pop_front()
                .unwrap_or_else(|| Err(anyhow::anyhow!("scripted runtime ran out of outcomes")))
        }
    }

    fn ok() -> anyhow::Result<()> {
        Ok(())
    }
    fn err(msg: &'static str) -> anyhow::Result<()> {
        Err(anyhow::anyhow!(msg))
    }

    // ── degrade_or_disconnect (pure) ─────────────────────────────

    #[test]
    fn first_failure_takes_connected_to_degraded() {
        let next = degrade_or_disconnect(&RuntimeState::Connected, "boom".into());
        assert!(matches!(next, RuntimeState::Degraded { .. }));
    }

    #[test]
    fn second_consecutive_failure_takes_degraded_to_disconnected() {
        let next = degrade_or_disconnect(
            &RuntimeState::Degraded {
                reason: "prior".into(),
            },
            "boom".into(),
        );
        assert!(matches!(next, RuntimeState::Disconnected { .. }));
    }

    #[test]
    fn failure_while_disconnected_stays_disconnected_with_new_reason() {
        let next = degrade_or_disconnect(
            &RuntimeState::Disconnected {
                reason: "prior".into(),
            },
            "latest".into(),
        );
        match next {
            RuntimeState::Disconnected { reason } => assert_eq!(reason, "latest"),
            other => panic!("expected Disconnected, got {other:?}"),
        }
    }

    // ── probe_once: end-to-end transitions ───────────────────────

    #[tokio::test]
    async fn probe_succeeds_then_returns_connected_even_from_disconnected_prior() {
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(ScriptedRuntime::new([ok()]));
        let next = probe_once(
            runtime,
            &RuntimeState::Disconnected {
                reason: "prior".into(),
            },
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(next, RuntimeState::Connected);
    }

    #[tokio::test]
    async fn probe_fails_from_connected_moves_to_degraded() {
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(ScriptedRuntime::new([err("pipe closed")]));
        let next = probe_once(runtime, &RuntimeState::Connected, Duration::from_secs(1)).await;
        assert!(matches!(next, RuntimeState::Degraded { .. }));
    }

    // ── tick_once: registry interaction ──────────────────────────

    /// Tick the loop once without an `AppHandle` (events would be
    /// dropped). Tests that want to assert on events should use the
    /// MockRuntime path described in tauri::test; for the spike we
    /// just assert on registry state, which is the source of truth.
    async fn tick_states_only(registry: &Arc<RuntimeRegistry>, ping_timeout: Duration) {
        // Inline copy of tick_once minus the publish() — keeps tests
        // free of the AppHandle plumbing while still exercising the
        // state-transition pathway.
        let snapshot = registry.remote_snapshot();
        for (name, runtime, prior) in snapshot {
            let next = probe_once(runtime, &prior, ping_timeout).await;
            if next != prior {
                let _ = registry.set_state(&name, next);
            }
        }
    }

    #[tokio::test]
    async fn tick_transitions_an_entry_from_connected_to_disconnected_over_two_failures() {
        let registry = Arc::new(RuntimeRegistry::new());
        let runtime: Arc<dyn RemoteRuntime> =
            Arc::new(ScriptedRuntime::new([err("first"), err("second")]));
        registry.register("dev.box", runtime, None).unwrap();

        // Tick 1: Connected → Degraded
        tick_states_only(&registry, Duration::from_secs(1)).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Degraded { .. })
        ));

        // Tick 2: Degraded → Disconnected
        tick_states_only(&registry, Duration::from_secs(1)).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Disconnected { .. })
        ));
    }

    #[tokio::test]
    async fn tick_recovers_a_disconnected_entry_when_ping_succeeds() {
        let registry = Arc::new(RuntimeRegistry::new());
        let runtime: Arc<dyn RemoteRuntime> =
            Arc::new(ScriptedRuntime::new([err("first"), err("second"), ok()]));
        registry.register("dev.box", runtime, None).unwrap();

        // Drive to Disconnected
        tick_states_only(&registry, Duration::from_secs(1)).await;
        tick_states_only(&registry, Duration::from_secs(1)).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Disconnected { .. })
        ));

        // Successful ping should pull it back to Connected.
        tick_states_only(&registry, Duration::from_secs(1)).await;
        assert_eq!(registry.state("dev.box"), Some(RuntimeState::Connected));
    }

    #[tokio::test]
    async fn tick_skips_local_runtime() {
        // The registry's local entry is always Connected by construction;
        // remote_snapshot must exclude it so the tick never even tries
        // to ping the local runtime.
        let registry = Arc::new(RuntimeRegistry::new());
        // No remotes registered — snapshot must be empty.
        assert_eq!(registry.remote_snapshot().len(), 0);
        // Tick with no remotes: no-op, no panic.
        tick_states_only(&registry, Duration::from_secs(1)).await;
    }
}
