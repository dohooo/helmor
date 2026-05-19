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

/// Knobs for the liveness loop. Built once at startup; tests
/// override individual fields via [`LivenessConfig::instant_test`].
#[derive(Debug, Clone)]
pub struct LivenessConfig {
    /// How often the loop ticks. 10s in production — long enough
    /// that a healthy connection doesn't burn CPU on the SSH child,
    /// short enough that a dead pipe surfaces within a noticeable
    /// window.
    pub poll_interval: Duration,
    /// Per-ping timeout. SSH's own keepalive is ~5 min, so anything
    /// past a few seconds is almost certainly a hang. 5s leaves
    /// headroom for slow cold pipes without pretending the network
    /// is healthy when it isn't.
    pub ping_timeout: Duration,
    /// Pause between the first failed ping and the inline retry on
    /// a Connected→fail transition. Longer than typical TCP
    /// retransmit, shorter than the next tick — "ignore single-
    /// packet hiccups", not "wait out a real outage".
    pub transient_retry_delay: Duration,
    /// Number of escalation retries before flipping Degraded →
    /// Disconnected. Tolerates a longer flake while the chip is
    /// already amber so the user isn't bothered by slow-but-
    /// recoverable network blips.
    pub escalation_retries: u32,
    /// First backoff between escalation retries; doubles each
    /// attempt. Production default `500ms → 1s → 2s`.
    pub escalation_backoff_base: Duration,
}

impl Default for LivenessConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(10),
            ping_timeout: Duration::from_secs(5),
            transient_retry_delay: Duration::from_millis(750),
            escalation_retries: 3,
            escalation_backoff_base: Duration::from_millis(500),
        }
    }
}

impl LivenessConfig {
    /// Tight-cadence variant — every sleep collapses to a near-zero
    /// duration while retry counts stay at production values. Lets
    /// tests exercise the retry pathway without burning seconds on
    /// real clock waits.
    #[cfg(test)]
    pub fn instant_test() -> Self {
        Self {
            poll_interval: Duration::ZERO,
            ping_timeout: Duration::from_secs(1),
            transient_retry_delay: Duration::ZERO,
            escalation_retries: 3,
            escalation_backoff_base: Duration::from_micros(1),
        }
    }
}

/// Spawn the liveness loop. Returns immediately; the loop runs until
/// the host process exits (no explicit shutdown — Tauri reaps tokio
/// tasks on quit). Idempotent enough to call once per app boot; the
/// setup hook is the natural caller.
pub fn spawn_liveness_loop<R: Runtime>(app: AppHandle<R>, registry: Arc<RuntimeRegistry>) {
    tauri::async_runtime::spawn(async move {
        run_liveness_loop(app, registry, LivenessConfig::default()).await;
    });
}

/// The actual tick loop. Factored out of `spawn_liveness_loop` so
/// tests can drive it with a tighter cadence + a controlled clock.
pub async fn run_liveness_loop<R: Runtime>(
    app: AppHandle<R>,
    registry: Arc<RuntimeRegistry>,
    config: LivenessConfig,
) {
    loop {
        sleep(config.poll_interval).await;
        tick_once(&app, &registry, &config).await;
    }
}

/// One tick: snapshot the registry, ping each remote, update state on
/// change. Public so the test harness can call it directly without
/// waiting for the interval.
///
/// State transitions follow the retry pathway documented on
/// [`decide_next_state`] — single-shot retry on a Connected fail,
/// exponential-backoff retry burst on a Degraded → Disconnected
/// transition. Net effect: the chip ignores single-packet drops and
/// tolerates slow-but-recoverable flakes while amber.
pub async fn tick_once<R: Runtime>(
    app: &AppHandle<R>,
    registry: &Arc<RuntimeRegistry>,
    config: &LivenessConfig,
) {
    let snapshot = registry.remote_snapshot();
    for (name, runtime, prior) in snapshot {
        let next = decide_next_state(runtime, &prior, config).await;
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

/// Compute the next state for an entry given its `prior` state and
/// a live runtime to probe. Implements both:
///
/// 1. **Transient-blip suppression** — a Connected entry that fails
///    one ping but recovers on the inline retry stays Connected. No
///    chip flicker for single-packet drops.
/// 2. **Escalation retry burst** — a Degraded entry that would
///    otherwise transition to Disconnected gets a few exponentially-
///    spaced retries first. Saves the user a manual Reconnect for
///    slow-but-recoverable network blips.
///
/// Factored out of `tick_once` so tests exercise the same retry
/// pathway production uses, without dragging an `AppHandle` through.
pub async fn decide_next_state(
    runtime: Arc<dyn RemoteRuntime>,
    prior: &RuntimeState,
    config: &LivenessConfig,
) -> RuntimeState {
    let next = probe_once(Arc::clone(&runtime), prior, config.ping_timeout).await;

    // Transient-blip suppression: see (1) above. Skip retries for
    // entries already in Degraded / Disconnected — there's no
    // transient hypothesis to test, and burning a second timeout per
    // tick would mask a sustained outage.
    if matches!(prior, RuntimeState::Connected) && !matches!(next, RuntimeState::Connected) {
        sleep(config.transient_retry_delay).await;
        return probe_once(runtime, prior, config.ping_timeout).await;
    }

    // Escalation retry burst: see (2) above.
    if matches!(prior, RuntimeState::Degraded { .. })
        && matches!(next, RuntimeState::Disconnected { .. })
    {
        return retry_before_escalating(
            runtime,
            prior,
            next,
            config.ping_timeout,
            config.escalation_retries,
            config.escalation_backoff_base,
        )
        .await;
    }
    next
}

/// Burst-retry a probe with exponential backoff. Returns the first
/// `Connected` outcome that lands, or `candidate` (the
/// would-be-applied Disconnected variant) if every retry also fails.
/// Public so the tests can drive it with a tight backoff without
/// waiting for the full production schedule.
pub async fn retry_before_escalating(
    runtime: Arc<dyn RemoteRuntime>,
    prior: &RuntimeState,
    candidate: RuntimeState,
    ping_timeout: Duration,
    attempts: u32,
    backoff_base: Duration,
) -> RuntimeState {
    let mut delay = backoff_base;
    for _ in 0..attempts {
        sleep(delay).await;
        let outcome = probe_once(Arc::clone(&runtime), prior, ping_timeout).await;
        if matches!(outcome, RuntimeState::Connected) {
            return outcome;
        }
        // Cap doubling so a misconfigured base doesn't compound into
        // a minute-long stall. `saturating_mul` avoids overflow on
        // extreme values.
        delay = delay.saturating_mul(2);
    }
    candidate
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
        fn workspace_branch_info(
            &self,
            _: &Path,
        ) -> anyhow::Result<crate::remote::methods::WorkspaceBranchInfoResult> {
            unreachable!("liveness tests don't probe workspace_branch_info")
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
    /// dropped). Mirrors `tick_once` with `LivenessConfig::instant_test`
    /// so the retry pathway runs at microsecond cadence — the
    /// behaviour under test is the *number* of probes + their landing
    /// semantics, not the cadence.
    async fn tick_states_only(registry: &Arc<RuntimeRegistry>) {
        let config = LivenessConfig::instant_test();
        let snapshot = registry.remote_snapshot();
        for (name, runtime, prior) in snapshot {
            let next = decide_next_state(runtime, &prior, &config).await;
            if next != prior {
                let _ = registry.set_state(&name, next);
            }
        }
    }

    #[tokio::test]
    async fn tick_transitions_an_entry_from_connected_to_disconnected_over_sustained_failure() {
        // Sustained outage. Tick 1 consumes the initial probe + the
        // transient-blip retry (both fail) → Degraded. Tick 2 consumes
        // one probe + ESCALATION_RETRIES escalation probes (all fail)
        // → Disconnected. Scripted outcomes account for both bursts.
        let registry = Arc::new(RuntimeRegistry::new());
        let mut outcomes: Vec<anyhow::Result<()>> = Vec::new();
        // Tick 1: initial + transient retry.
        outcomes.push(err("first"));
        outcomes.push(err("retry"));
        // Tick 2: initial + ESCALATION_RETRIES escalation retries.
        outcomes.push(err("escalate-0"));
        for i in 0..LivenessConfig::default().escalation_retries {
            outcomes.push(err(Box::leak(
                format!("escalate-{}", i + 1).into_boxed_str(),
            )));
        }
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(ScriptedRuntime::new(outcomes));
        registry.register("dev.box", runtime, None).unwrap();

        tick_states_only(&registry).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Degraded { .. })
        ));

        tick_states_only(&registry).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Disconnected { .. })
        ));
    }

    #[tokio::test]
    async fn tick_suppresses_a_single_transient_failure_via_inline_retry() {
        // The new behaviour: a Connected entry that fails one ping but
        // succeeds on the immediate retry stays Connected. No chip
        // flicker for single-packet drops.
        let registry = Arc::new(RuntimeRegistry::new());
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(ScriptedRuntime::new([err("blip"), ok()]));
        registry.register("dev.box", runtime, None).unwrap();

        tick_states_only(&registry).await;

        assert_eq!(registry.state("dev.box"), Some(RuntimeState::Connected));
    }

    #[tokio::test]
    async fn tick_recovers_during_escalation_burst_when_one_retry_succeeds() {
        // Degraded → would-be-Disconnected, but one of the escalation
        // retries succeeds. The entry comes back to Connected without
        // ever entering Disconnected.
        let registry = Arc::new(RuntimeRegistry::new());
        // Tick 1 consumes 2 (initial + transient retry) → Degraded.
        // Tick 2 consumes 1 (initial) then enters escalation burst;
        // the second escalation retry succeeds.
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(ScriptedRuntime::new([
            err("t1-initial"),
            err("t1-retry"),
            err("t2-initial"),
            err("t2-esc-0"),
            ok(),
        ]));
        registry.register("dev.box", runtime, None).unwrap();

        tick_states_only(&registry).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Degraded { .. })
        ));
        tick_states_only(&registry).await;
        assert_eq!(registry.state("dev.box"), Some(RuntimeState::Connected));
    }

    #[tokio::test]
    async fn tick_recovers_a_disconnected_entry_when_ping_succeeds() {
        let registry = Arc::new(RuntimeRegistry::new());
        // Drive to Disconnected: 2 fails (tick 1) + 1 + ESCALATION_RETRIES (tick 2).
        let mut outcomes: Vec<anyhow::Result<()>> = Vec::new();
        outcomes.push(err("t1-initial"));
        outcomes.push(err("t1-retry"));
        outcomes.push(err("t2-initial"));
        for i in 0..LivenessConfig::default().escalation_retries {
            outcomes.push(err(Box::leak(format!("t2-esc-{i}").into_boxed_str())));
        }
        // Tick 3: one Ok pulls us back to Connected. No escalation
        // retry needed for Disconnected → Connected (probe_once is
        // single-shot when prior isn't Degraded).
        outcomes.push(ok());
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(ScriptedRuntime::new(outcomes));
        registry.register("dev.box", runtime, None).unwrap();

        tick_states_only(&registry).await;
        tick_states_only(&registry).await;
        assert!(matches!(
            registry.state("dev.box"),
            Some(RuntimeState::Disconnected { .. })
        ));

        tick_states_only(&registry).await;
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
        tick_states_only(&registry).await;
    }
}
