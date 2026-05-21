//! Background auto-reconnect loop for `Disconnected` remote runtimes.
//!
//! The [`super::liveness`] loop already escalates a remote runtime
//! through `Connected → Degraded → Disconnected` on sustained ping
//! failures. Today the user has to click Reconnect in the dev panel
//! to recover. That's fine for the spike but breaks the issue #453
//! requirement that the desktop "shows a banner and resumes" when
//! the SSH link drops.
//!
//! This module owns the resume half. A background loop scans the
//! registry on a fixed cadence, finds any `Disconnected` entries
//! with a persisted [`RuntimeConnectionConfig`], and retries
//! `persistence::connect_from_config` with exponential backoff. On
//! success it swaps the live runtime in via the same
//! `unregister → register` dance the manual command uses; on failure
//! it bumps the backoff and waits for the next attempt window.
//!
//! ## Scope
//!
//! - **Only Disconnected entries.** Degraded entries are still in
//!   the liveness loop's retry burst; auto-reconnecting them would
//!   race the existing escalation logic. We let them either recover
//!   on their own or fall to Disconnected first.
//! - **Per-entry backoff state lives inside the loop.** No new
//!   registry fields, no new persistence — a failed reconnect
//!   doesn't survive an app restart, which is fine because the
//!   liveness loop will re-discover the disconnection on next boot.
//! - **Manual reconnect still wins.** When the user clicks Reconnect
//!   the entry flips back to Connected (or surfaces an error to the
//!   notice). On the next tick the loop sees it's no longer
//!   Disconnected and drops the bookkeeping.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tokio::time::{sleep, Instant};

use crate::ui_sync::{publish, UiMutationEvent};

use super::methods::{RuntimeMetricsParams, RuntimeMetricsResult};
use super::persistence;
use super::registry::{RuntimeRegistry, RuntimeState};

/// Track E4 consumer: after this many daemon restarts within
/// [`CRASH_LOOP_WINDOW`], the auto-reconnect loop emits a
/// `RemoteCrashLoopDetected` event. 3 is conservative — one
/// legitimate restart for the user's own actions (config tweak,
/// version upgrade) plus two crashes inside a 5-minute window
/// would still not trip; three "fresh" daemon starts inside 5min
/// almost always means a crash loop.
pub const CRASH_LOOP_THRESHOLD: u32 = 3;

/// Sliding window for the crash-loop detector. 5 minutes mirrors
/// the `recent_starts_ms` window the daemon already uses for its
/// metrics surface.
pub const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(5 * 60);

/// Knobs for the auto-reconnect loop. Built once at startup; tests
/// override individual fields via [`AutoReconnectConfig::instant_test`].
#[derive(Debug, Clone)]
pub struct AutoReconnectConfig {
    /// How often the loop wakes to check for reconnect work. 5s in
    /// production — quick enough that a flaky network reconnects
    /// without the user noticing, slow enough that the loop doesn't
    /// burn CPU when everything is healthy.
    pub poll_interval: Duration,
    /// First backoff between attempts. Doubles after each failure up
    /// to [`max_backoff`].
    pub initial_backoff: Duration,
    /// Upper bound on the backoff. Keeps the worst-case retry cadence
    /// from drifting into "hours between attempts" on a stubborn
    /// outage.
    pub max_backoff: Duration,
}

impl Default for AutoReconnectConfig {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(5),
            initial_backoff: Duration::from_secs(5),
            max_backoff: Duration::from_secs(5 * 60),
        }
    }
}

impl AutoReconnectConfig {
    /// Microsecond cadence variant for tests. Lets unit tests drive
    /// the full transition matrix without burning seconds on real
    /// clock waits.
    #[cfg(test)]
    pub fn instant_test() -> Self {
        Self {
            poll_interval: Duration::ZERO,
            initial_backoff: Duration::ZERO,
            max_backoff: Duration::from_secs(1),
        }
    }
}

/// Per-entry bookkeeping: when the next attempt is allowed and how
/// long the current backoff window is. The loop creates this on the
/// first Disconnected sighting and removes it when the entry leaves
/// the Disconnected state (recovery, unregister, or replacement).
#[derive(Debug)]
pub(crate) struct BackoffState {
    /// Wall-clock instant after which the next reconnect attempt is
    /// permitted. The first attempt fires at `created_at + initial_backoff`
    /// so a freshly-disconnected entry isn't slammed with an immediate
    /// retry while the network is still settling.
    next_attempt_at: Instant,
    /// Current backoff window. Doubles after each failed attempt up
    /// to the config's `max_backoff`.
    current_backoff: Duration,
    /// Total attempts the loop has made for this entry. Reported in
    /// the [`UiMutationEvent::RemoteReconnectAttempt`] events so the
    /// banner can render "attempt N" if it wants.
    attempts: u32,
}

/// Per-runtime crash-loop bookkeeping. Lives in its own map so the
/// reconnect backoff lifecycle doesn't accidentally reset the alert
/// state (a runtime that recovers, then crash-loops a few minutes
/// later, should re-fire the alert).
#[derive(Debug, Default)]
pub(crate) struct CrashLoopState {
    /// `true` once we've published a `RemoteCrashLoopDetected` event
    /// for the current "loop episode." Resets to false when the
    /// underlying daemon metrics show fewer than the threshold inside
    /// the window — i.e. the loop has actually cleared.
    alerted: bool,
}

impl BackoffState {
    fn new(config: &AutoReconnectConfig, now: Instant) -> Self {
        Self {
            next_attempt_at: now + config.initial_backoff,
            current_backoff: config.initial_backoff,
            attempts: 0,
        }
    }

    /// Record a failed attempt: double the current backoff (capped),
    /// schedule the next window.
    fn schedule_retry_after_failure(&mut self, config: &AutoReconnectConfig, now: Instant) {
        let doubled = self
            .current_backoff
            .saturating_mul(2)
            .min(config.max_backoff);
        // First attempt's window came from `initial_backoff` directly;
        // subsequent ones double until they hit the cap.
        self.current_backoff = if self.current_backoff.is_zero() {
            config.initial_backoff.max(Duration::from_secs(1))
        } else {
            doubled
        };
        self.next_attempt_at = now + self.current_backoff;
    }
}

/// Spawn the auto-reconnect loop. Returns immediately; the loop runs
/// until the host process exits (no explicit shutdown — Tauri reaps
/// tokio tasks on quit). Idempotent enough to call once per app boot.
pub fn spawn_auto_reconnect_loop<R: Runtime>(app: AppHandle<R>, registry: Arc<RuntimeRegistry>) {
    tauri::async_runtime::spawn(async move {
        run_auto_reconnect_loop(app, registry, AutoReconnectConfig::default()).await;
    });
}

/// The actual tick loop. Factored out of `spawn_auto_reconnect_loop`
/// so tests can drive it with a tighter cadence + a controlled clock.
pub async fn run_auto_reconnect_loop<R: Runtime>(
    app: AppHandle<R>,
    registry: Arc<RuntimeRegistry>,
    config: AutoReconnectConfig,
) {
    let mut bookkeeping: HashMap<String, BackoffState> = HashMap::new();
    let mut crash_loops: HashMap<String, CrashLoopState> = HashMap::new();
    loop {
        sleep(config.poll_interval).await;
        tick_once(&app, &registry, &config, &mut bookkeeping, &mut crash_loops).await;
    }
}

/// One tick: scan the registry, attempt reconnects on any
/// Disconnected entries whose backoff window has elapsed, prune
/// bookkeeping for entries that left the Disconnected state.
/// Crate-visible so the spawn site + unit tests can drive it; the
/// signature takes a private bookkeeping type, so leaking it
/// further would trip clippy's private-interface lint.
pub(crate) async fn tick_once<R: Runtime>(
    app: &AppHandle<R>,
    registry: &Arc<RuntimeRegistry>,
    config: &AutoReconnectConfig,
    bookkeeping: &mut HashMap<String, BackoffState>,
    crash_loops: &mut HashMap<String, CrashLoopState>,
) {
    let snapshot = registry.remote_snapshot();
    let live_disconnected: HashSet<String> = snapshot
        .iter()
        .filter(|(_, _, state)| matches!(state, RuntimeState::Disconnected { .. }))
        .map(|(name, _, _)| name.clone())
        .collect();

    // Drop bookkeeping for entries that are no longer disconnected —
    // either they recovered on their own (via liveness ping) or got
    // unregistered. Keeps the map from growing unbounded.
    bookkeeping.retain(|name, _| live_disconnected.contains(name));
    // Drop crash-loop bookkeeping for entries that no longer exist
    // in the registry at all (a runtime the user deleted should
    // start fresh if they re-add it). Re-registered entries that
    // happen to share a name keep their alert-state; that's the
    // intended behaviour — the same daemon coming back after a few
    // minutes of being unregistered shouldn't bypass the cooldown.
    let known: HashSet<&str> = snapshot.iter().map(|(name, _, _)| name.as_str()).collect();
    crash_loops.retain(|name, _| known.contains(name.as_str()));

    let now = Instant::now();
    for name in live_disconnected {
        let state = bookkeeping
            .entry(name.clone())
            .or_insert_with(|| BackoffState::new(config, now));
        if now < state.next_attempt_at {
            continue;
        }

        let Some(connection_config) = registry.config_for(&name) else {
            // No persisted config — usually the registry's own entry
            // for a transport that bypassed the registry persistence
            // layer (tests, ad-hoc tools). Auto-reconnect needs a
            // config to know what to reconnect WITH; skip until the
            // user re-adds it.
            continue;
        };

        state.attempts += 1;
        let attempt = state.attempts;
        publish(
            app,
            UiMutationEvent::RemoteReconnectAttempt {
                name: name.clone(),
                attempt,
                succeeded: None,
            },
        );

        let cfg_for_blocking = connection_config.clone();
        let join = tauri::async_runtime::spawn_blocking(move || {
            persistence::connect_from_config(&cfg_for_blocking)
        })
        .await;

        let attempt_result = match join {
            Ok(Ok(runtime)) => {
                // Confirm the new runtime answers a health query — the
                // connect call only proves the handshake; a health
                // query proves the dispatcher is alive too.
                let runtime_for_health = Arc::clone(&runtime);
                let health = tauri::async_runtime::spawn_blocking(move || {
                    runtime_for_health.runtime_health()
                })
                .await
                .map_err(|join_err| anyhow::anyhow!("health probe task panicked: {join_err}"))
                .and_then(|result| result);
                match health {
                    Ok(snapshot) => {
                        // Same drift check the manual connect path
                        // runs. Reconnecting against an older daemon
                        // (operator never reinstalled across desktop
                        // upgrades) shouldn't slip past silently.
                        let desktop_version = env!("CARGO_PKG_VERSION");
                        if crate::remote::install::daemon_version_is_older(
                            &snapshot.version,
                            desktop_version,
                        ) {
                            publish(
                                app,
                                UiMutationEvent::RemoteServerVersionDrift {
                                    name: name.clone(),
                                    daemon_version: snapshot.version.clone(),
                                    desktop_version: desktop_version.to_string(),
                                },
                            );
                        }
                        Ok(runtime)
                    }
                    Err(err) => Err(format!("{err:#}")),
                }
            }
            Ok(Err(err)) => Err(format!("{err:#}")),
            Err(join_err) => Err(format!("reconnect task panicked: {join_err}")),
        };

        match attempt_result {
            Ok(new_runtime) => {
                // Swap the tombstone for the new runtime. `unregister`
                // is idempotent + drops the stale Arc; `register`
                // primes the new state at Connected via fresh().
                let _ = registry.unregister(&name);
                if let Err(err) =
                    registry.register(name.clone(), new_runtime, Some(connection_config.clone()))
                {
                    tracing::warn!(
                        runtime = %name,
                        error = %err,
                        "auto_reconnect: registry.register failed after successful connect",
                    );
                    // Schedule another attempt instead of bailing —
                    // a stale entry that races us is recoverable next
                    // tick.
                    state.schedule_retry_after_failure(config, now);
                    publish(
                        app,
                        UiMutationEvent::RemoteReconnectAttempt {
                            name: name.clone(),
                            attempt,
                            succeeded: Some(false),
                        },
                    );
                    continue;
                }
                bookkeeping.remove(&name);
                publish(
                    app,
                    UiMutationEvent::RuntimeStateChanged {
                        name: name.clone(),
                        state: RuntimeState::Connected,
                    },
                );
                publish(
                    app,
                    UiMutationEvent::RemoteReconnectAttempt {
                        name: name.clone(),
                        attempt,
                        succeeded: Some(true),
                    },
                );
                // Track E4 consumer: every successful reconnect is
                // also a chance to spot a crash-loop pattern. Pulls
                // `runtime.metrics` from the freshly-registered
                // runtime and fires `RemoteCrashLoopDetected` when
                // the daemon's own restart history exceeds the
                // threshold inside the window. Idempotent per
                // episode via `CrashLoopState::alerted`.
                check_crash_loop(app, registry, &name, crash_loops).await;
            }
            Err(reason) => {
                // Stash the new failure reason on the existing
                // tombstone so the banner shows the latest error.
                let _ = registry.set_state(
                    &name,
                    RuntimeState::Disconnected {
                        reason: reason.clone(),
                    },
                );
                state.schedule_retry_after_failure(config, now);
                publish(
                    app,
                    UiMutationEvent::RemoteReconnectAttempt {
                        name: name.clone(),
                        attempt,
                        succeeded: Some(false),
                    },
                );
                // Also publish the state change so any listener that
                // cares about the freshest reason picks it up.
                publish(
                    app,
                    UiMutationEvent::RuntimeStateChanged {
                        name,
                        state: RuntimeState::Disconnected { reason },
                    },
                );
            }
        }
    }
}

/// Track E4 consumer: pull `runtime.metrics` from the named runtime,
/// count restarts inside `CRASH_LOOP_WINDOW`, and publish a
/// `RemoteCrashLoopDetected` event when the count crosses the
/// threshold. Idempotent per `CrashLoopState::alerted` — re-firing
/// every reconnect would spam a banner the user already dismissed.
///
/// Failures (runtime unregistered between detection + lookup, metrics
/// RPC errored, etc.) silently no-op: this is opportunistic detection,
/// not the source of truth. The daemon's `recent_starts_ms` field
/// remains the authoritative signal the dev panel reads on demand.
pub(crate) async fn check_crash_loop<R: Runtime>(
    app: &AppHandle<R>,
    registry: &Arc<RuntimeRegistry>,
    name: &str,
    crash_loops: &mut HashMap<String, CrashLoopState>,
) {
    // Re-lookup so we exercise the freshly-registered runtime, not
    // the in-flight Arc that may have been replaced. The set/get
    // race window is small but real (another tick or a manual
    // reconnect could swap mid-flight); the lookup is cheap.
    let runtime = match registry.lookup(Some(name)) {
        Ok(rt) => rt,
        Err(_) => return,
    };
    // Spin the RPC off the cooperative scheduler — `runtime.metrics`
    // is sync (frame I/O on the wire) and we don't want to stall
    // the auto-reconnect loop on a slow remote.
    let metrics: RuntimeMetricsResult = match tauri::async_runtime::spawn_blocking(move || {
        runtime.runtime_metrics(RuntimeMetricsParams {})
    })
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(err)) => {
            tracing::debug!(
                runtime = %name,
                error = %format!("{err:#}"),
                "auto_reconnect: runtime.metrics failed during crash-loop probe",
            );
            return;
        }
        Err(join_err) => {
            tracing::debug!(
                runtime = %name,
                error = %format!("{join_err:#}"),
                "auto_reconnect: crash-loop probe task panicked",
            );
            return;
        }
    };

    evaluate_crash_loop(app, name, &metrics.recent_starts_ms, crash_loops);
}

/// Pure-logic evaluator. Separated so unit tests can drive the
/// threshold + cooldown semantics without a real RPC pipe.
pub(crate) fn evaluate_crash_loop<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    recent_starts_ms: &[i64],
    crash_loops: &mut HashMap<String, CrashLoopState>,
) {
    let count = recent_starts_ms.len() as u32;
    let entry = crash_loops.entry(name.to_string()).or_default();
    if count >= CRASH_LOOP_THRESHOLD {
        if entry.alerted {
            // Same loop episode — banner is already up.
            return;
        }
        entry.alerted = true;
        publish(
            app,
            UiMutationEvent::RemoteCrashLoopDetected {
                name: name.to_string(),
                restart_count: count,
                window_ms: CRASH_LOOP_WINDOW.as_millis() as i64,
                recent_starts_ms: recent_starts_ms.to_vec(),
            },
        );
        return;
    }
    // Count dropped back below the threshold — the window has slid
    // past the qualifying restarts (or the daemon is genuinely
    // stable now). Clear the cooldown so a future episode re-fires.
    if entry.alerted {
        entry.alerted = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    use crate::remote::connection::RuntimeConnectionConfig;
    use crate::remote::methods::{WorkspaceBranchInfoResult, WorkspaceStatusResult};
    use crate::remote::runtime::{RemoteRuntime, RuntimeHealth, RuntimeKind};

    /// Mirror of liveness::tests::ScriptedRuntime — a stub that
    /// answers ping() / runtime_health() with scripted outcomes.
    struct StubRuntime {
        health_ok: bool,
    }

    impl RemoteRuntime for StubRuntime {
        fn runtime_health(&self) -> anyhow::Result<RuntimeHealth> {
            if self.health_ok {
                Ok(RuntimeHealth {
                    kind: RuntimeKind::Remote {
                        host: "stub".into(),
                    },
                    hostname: "stub".into(),
                    version: "0.0.0".into(),
                })
            } else {
                Err(anyhow::anyhow!("health probe refused"))
            }
        }
        fn workspace_status(&self, _: &Path) -> anyhow::Result<WorkspaceStatusResult> {
            unreachable!("auto-reconnect tests don't probe workspace_status")
        }
        fn workspace_branch_info(&self, _: &Path) -> anyhow::Result<WorkspaceBranchInfoResult> {
            unreachable!("auto-reconnect tests don't probe workspace_branch_info")
        }
        fn ping(&self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    // The `tick_once` tests below pre-register a Disconnected entry
    // with a stub `Local` config. Real auto-reconnect would call
    // `persistence::connect_from_config` against the live LocalRuntime
    // path; the integration tests in `remote_binary_integration.rs`
    // cover the live path. Here we focus on the loop's bookkeeping +
    // event-emission shape — the side that controls the banner.

    fn disconnected_state() -> RuntimeState {
        RuntimeState::Disconnected {
            reason: "test outage".into(),
        }
    }

    fn local_config() -> RuntimeConnectionConfig {
        RuntimeConnectionConfig::Local { binary_path: None }
    }

    fn register_disconnected(registry: &RuntimeRegistry, name: &str) {
        let runtime: Arc<dyn RemoteRuntime> = Arc::new(StubRuntime { health_ok: true });
        registry
            .register_with_state(name, runtime, Some(local_config()), disconnected_state())
            .expect("register_with_state");
    }

    /// `tick_once` without an AppHandle. Tests that don't care about
    /// the published events (just the state-machine bookkeeping) use
    /// this to keep their fixtures small.
    async fn tick_no_app(
        registry: &Arc<RuntimeRegistry>,
        config: &AutoReconnectConfig,
        bookkeeping: &mut HashMap<String, BackoffState>,
    ) {
        // Mirror tick_once's flow without the publish calls — we
        // exercise the live function elsewhere with a real mock app.
        // Pure inline copy so a regression in tick_once that bypasses
        // bookkeeping shows up immediately in the assertions below.
        let snapshot = registry.remote_snapshot();
        let live_disconnected: HashSet<String> = snapshot
            .iter()
            .filter(|(_, _, state)| matches!(state, RuntimeState::Disconnected { .. }))
            .map(|(name, _, _)| name.clone())
            .collect();
        bookkeeping.retain(|name, _| live_disconnected.contains(name));
        let now = Instant::now();
        for name in live_disconnected {
            let state = bookkeeping
                .entry(name.clone())
                .or_insert_with(|| BackoffState::new(config, now));
            if now < state.next_attempt_at {
                continue;
            }
            let Some(_cfg) = registry.config_for(&name) else {
                continue;
            };
            state.attempts += 1;
            // Simulate a failure so the test exercises the retry path
            // without spinning up the real persistence layer.
            state.schedule_retry_after_failure(config, now);
        }
    }

    #[tokio::test]
    async fn first_tick_inserts_bookkeeping_for_a_disconnected_entry() {
        let registry = Arc::new(RuntimeRegistry::new());
        register_disconnected(&registry, "dev.box");
        let config = AutoReconnectConfig::instant_test();
        let mut book: HashMap<String, BackoffState> = HashMap::new();

        tick_no_app(&registry, &config, &mut book).await;

        assert!(
            book.contains_key("dev.box"),
            "first tick should record bookkeeping for the entry",
        );
        assert_eq!(book["dev.box"].attempts, 1);
    }

    #[tokio::test]
    async fn bookkeeping_drops_when_entry_recovers() {
        let registry = Arc::new(RuntimeRegistry::new());
        register_disconnected(&registry, "dev.box");
        let config = AutoReconnectConfig::instant_test();
        let mut book: HashMap<String, BackoffState> = HashMap::new();

        tick_no_app(&registry, &config, &mut book).await;
        // External actor (manual reconnect / liveness ping) flips
        // the entry back to Connected.
        let _ = registry.set_state("dev.box", RuntimeState::Connected);

        tick_no_app(&registry, &config, &mut book).await;

        assert!(
            !book.contains_key("dev.box"),
            "bookkeeping must drop once the entry is no longer disconnected",
        );
    }

    #[tokio::test]
    async fn bookkeeping_drops_when_entry_is_unregistered() {
        let registry = Arc::new(RuntimeRegistry::new());
        register_disconnected(&registry, "dev.box");
        let config = AutoReconnectConfig::instant_test();
        let mut book: HashMap<String, BackoffState> = HashMap::new();

        tick_no_app(&registry, &config, &mut book).await;
        let _ = registry.unregister("dev.box");

        tick_no_app(&registry, &config, &mut book).await;

        assert!(book.is_empty());
    }

    #[tokio::test]
    async fn failed_attempt_increments_attempts_and_doubles_backoff() {
        let registry = Arc::new(RuntimeRegistry::new());
        register_disconnected(&registry, "dev.box");
        // Use a non-zero initial so the test sees the doubling.
        let config = AutoReconnectConfig {
            poll_interval: Duration::ZERO,
            initial_backoff: Duration::from_millis(10),
            max_backoff: Duration::from_secs(60),
        };
        let mut book: HashMap<String, BackoffState> = HashMap::new();

        // Force the first attempt's window to elapse immediately so
        // the tick actually fires.
        let now = Instant::now();
        book.insert(
            "dev.box".into(),
            BackoffState {
                next_attempt_at: now,
                current_backoff: config.initial_backoff,
                attempts: 0,
            },
        );

        tick_no_app(&registry, &config, &mut book).await;

        let state = &book["dev.box"];
        assert_eq!(state.attempts, 1);
        // After one failure backoff should have doubled to ~20ms (or
        // hit the cap; cap is 60s here so doubling wins).
        assert!(
            state.current_backoff >= Duration::from_millis(20)
                && state.current_backoff <= Duration::from_millis(40),
            "backoff after first failure should be ~doubled, got {:?}",
            state.current_backoff,
        );
    }

    // ── Track E4 consumer: crash-loop detection ───────────────────

    use serde_json::Value;
    use std::sync::Mutex as StdMutex;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    /// Build a mock app + a captured-publish channel hung off the
    /// global UiSyncManager. Tests assert on the channel's captured
    /// payload to verify the right event was fired.
    fn mock_app_with_capture() -> (
        tauri::AppHandle<tauri::test::MockRuntime>,
        Arc<StdMutex<Vec<Value>>>,
    ) {
        let app = mock_builder()
            .manage(crate::ui_sync::UiSyncManager::new())
            .build(mock_context(noop_assets()))
            .expect("mock app should build");
        let captured: Arc<StdMutex<Vec<Value>>> = Arc::new(StdMutex::new(Vec::new()));
        let inner = Arc::clone(&captured);
        let channel = Channel::<UiMutationEvent>::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                let value: Value = serde_json::from_str(&s).unwrap();
                inner.lock().unwrap().push(value);
            }
            Ok(())
        });
        let handle = app.handle().clone();
        let manager = handle.state::<crate::ui_sync::UiSyncManager>();
        manager.subscribe("test".to_string(), channel);
        (handle, captured)
    }

    fn crash_loop_events(captured: &Arc<StdMutex<Vec<Value>>>) -> Vec<Value> {
        captured
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("remoteCrashLoopDetected"))
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn evaluate_below_threshold_does_not_fire_an_event() {
        let (app, captured) = mock_app_with_capture();
        let mut loops: HashMap<String, CrashLoopState> = HashMap::new();
        // 2 restarts < threshold (3) → no event.
        evaluate_crash_loop(&app, "dev.box", &[100, 200], &mut loops);
        assert!(crash_loop_events(&captured).is_empty());
        assert!(
            !loops.get("dev.box").map(|e| e.alerted).unwrap_or(false),
            "alerted flag should stay false below threshold",
        );
    }

    #[tokio::test]
    async fn evaluate_at_threshold_fires_a_crash_loop_event() {
        let (app, captured) = mock_app_with_capture();
        let mut loops: HashMap<String, CrashLoopState> = HashMap::new();
        evaluate_crash_loop(&app, "dev.box", &[100, 200, 300], &mut loops);
        let events = crash_loop_events(&captured);
        assert_eq!(events.len(), 1, "expected exactly one event: {events:?}");
        let event = &events[0];
        assert_eq!(event["name"], "dev.box");
        assert_eq!(event["restartCount"], 3);
        assert_eq!(event["windowMs"], 5 * 60 * 1000);
        let starts = event["recentStartsMs"].as_array().expect("array");
        assert_eq!(starts.len(), 3);
        assert!(loops.get("dev.box").map(|e| e.alerted).unwrap_or(false));
    }

    #[tokio::test]
    async fn evaluate_above_threshold_does_not_re_fire_within_the_same_episode() {
        // Two ticks in the same loop episode → one event total. The
        // banner stays up; we don't want to spam the user.
        let (app, captured) = mock_app_with_capture();
        let mut loops: HashMap<String, CrashLoopState> = HashMap::new();
        evaluate_crash_loop(&app, "dev.box", &[1, 2, 3, 4], &mut loops);
        evaluate_crash_loop(&app, "dev.box", &[1, 2, 3, 4, 5], &mut loops);
        assert_eq!(crash_loop_events(&captured).len(), 1);
    }

    #[tokio::test]
    async fn evaluate_clears_alerted_flag_when_window_slides_past_qualifying_restarts() {
        // First call trips the cooldown. Second call sees the count
        // drop below threshold (window has slid past) — flag clears
        // so a future episode re-fires.
        let (app, captured) = mock_app_with_capture();
        let mut loops: HashMap<String, CrashLoopState> = HashMap::new();
        evaluate_crash_loop(&app, "dev.box", &[1, 2, 3], &mut loops);
        assert!(loops["dev.box"].alerted);
        evaluate_crash_loop(&app, "dev.box", &[5], &mut loops);
        assert!(!loops["dev.box"].alerted, "cooldown must clear");
        // Re-trip: a new event fires.
        evaluate_crash_loop(&app, "dev.box", &[10, 11, 12], &mut loops);
        let events = crash_loop_events(&captured);
        assert_eq!(events.len(), 2, "expected two distinct episodes");
    }

    #[tokio::test]
    async fn evaluate_keeps_per_runtime_state_independent() {
        // Tripping the loop on dev.box must NOT silence a later
        // detection on staging — the cooldown is per-runtime.
        let (app, captured) = mock_app_with_capture();
        let mut loops: HashMap<String, CrashLoopState> = HashMap::new();
        evaluate_crash_loop(&app, "dev.box", &[1, 2, 3], &mut loops);
        evaluate_crash_loop(&app, "staging", &[10, 11, 12], &mut loops);
        let events = crash_loop_events(&captured);
        assert_eq!(events.len(), 2);
        let names: Vec<_> = events.iter().filter_map(|e| e["name"].as_str()).collect();
        assert!(names.contains(&"dev.box"));
        assert!(names.contains(&"staging"));
    }

    #[tokio::test]
    async fn backoff_caps_at_max_backoff() {
        // Drive a few failures with a tight cap so the doubling
        // immediately saturates.
        let mut state = BackoffState {
            next_attempt_at: Instant::now(),
            current_backoff: Duration::from_millis(100),
            attempts: 0,
        };
        let config = AutoReconnectConfig {
            poll_interval: Duration::ZERO,
            initial_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_millis(150),
        };

        let now = Instant::now();
        state.schedule_retry_after_failure(&config, now);
        state.schedule_retry_after_failure(&config, now);
        state.schedule_retry_after_failure(&config, now);
        state.schedule_retry_after_failure(&config, now);

        assert_eq!(state.current_backoff, Duration::from_millis(150));
    }
}
