//! Background fetchers that build the `triage_candidate` index.
//!
//! Each provider implements [`Fetcher`] and runs on its own cadence. The
//! scheduler thread drives them serially; provider failures are logged
//! and isolated so a flaky API doesn't block the others.
//!
//! Layer-2 (the local-LLM tick) reads from `triage_candidate` and never
//! invokes provider APIs directly — see [`storage::list_open_candidates`].

pub mod cache;
pub mod github;
pub mod gitlab;
pub mod im;
pub mod storage;

use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use tauri::{AppHandle, Runtime as TauriRuntime};
use tokio::runtime::{Builder, Runtime};

/// Provider trait — one fetch tick per call. Each implementation owns
/// its own cursor / subscription bookkeeping via `storage::*`.
pub trait Fetcher: Send + Sync {
    /// Stable id, e.g. `"github"` / `"lark"`. Used as
    /// `triage_candidate.source` and as the cursor key.
    fn source(&self) -> &'static str;

    /// Run one fetch tick. Returns a brief summary the scheduler logs.
    /// Errors abort this tick but do NOT propagate — the scheduler logs
    /// them so a partial failure can't take down the loop.
    fn fetch_once(&self) -> Result<FetchSummary>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct FetchSummary {
    pub inserted: usize,
    pub updated: usize,
    pub skipped_decided: usize,
    pub source_parents_scanned: usize,
}

impl FetchSummary {
    pub fn merge(&mut self, other: FetchSummary) {
        self.inserted += other.inserted;
        self.updated += other.updated;
        self.skipped_decided += other.skipped_decided;
        self.source_parents_scanned += other.source_parents_scanned;
    }
}

/// Dedicated multi-thread tokio runtime so lark-cli (async tokio
/// `Command`) calls work without re-entering Tauri's main runtime from
/// the scheduler's std::thread.
pub fn http_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("helmor-triage-fetcher")
            .build()
            .expect("Failed to build tokio runtime for triage fetcher")
    })
}

const STARTUP_DELAY_SEC: u64 = 45;
const TICK_INTERVAL_SEC: u64 = 300; // 5 min

/// Spawn the fetcher scheduler thread. One process-wide instance —
/// drives BOTH the fetcher pipeline (always) AND the Layer-2 LLM tick
/// (only when triage is enabled + auto_run + local LLM is on).
///
/// We deliberately collapse what used to be two separate schedulers
/// (`fetcher` + `triage` heartbeat) into this single loop so a tick
/// always runs against freshly-fetched data. `auto_run=false` keeps
/// the fetcher running on the same cadence but skips the post-fetch
/// tick — the user can still fire one manually via the Run-now button.
pub fn spawn_scheduler<R: TauriRuntime>(app: AppHandle<R>) {
    if let Err(error) = thread::Builder::new()
        .name("triage-fetcher".into())
        .spawn(move || scheduler_loop(app))
    {
        tracing::error!(error = %error, "spawn triage fetcher scheduler failed");
    }
}

fn scheduler_loop<R: TauriRuntime>(app: AppHandle<R>) {
    // Defer the first tick so app startup isn't competing for the
    // single-writer DB pool with the streaming pipeline.
    thread::sleep(Duration::from_secs(STARTUP_DELAY_SEC));
    if let Err(error) = cache::ensure_cache_root() {
        tracing::warn!(error = %format!("{error:#}"), "triage fetcher: failed to ensure cache root");
    }
    loop {
        let start = Instant::now();
        run_once();
        maybe_fire_triage_tick(&app);
        let elapsed = start.elapsed();
        let next = Duration::from_secs(TICK_INTERVAL_SEC).saturating_sub(elapsed);
        thread::sleep(next);
    }
}

/// Bridge fetcher → triage tick. Conditions must all hold:
///   - triage feature enabled in settings
///   - auto-run on (else the user expects only manual fires)
///   - local LLM running
///
/// Failure modes are logged (not propagated) so a busted tick can't
/// stop the fetcher loop. Filtered out the noisy "another tick in
/// flight" case — the previous tick is still doing the job.
fn maybe_fire_triage_tick<R: TauriRuntime>(app: &AppHandle<R>) {
    let cfg = match crate::triage::load_config() {
        Ok(c) => c,
        Err(error) => {
            tracing::warn!(error = %format!("{error:#}"), "triage: load_config failed in fetcher chain");
            return;
        }
    };
    if !cfg.enabled || !cfg.auto_run {
        return;
    }
    if !crate::local_llm::load_settings().enabled {
        return;
    }
    if let Err(error) = crate::triage::trigger_tick_now(app) {
        let msg = format!("{error:#}");
        if !msg.contains("in flight") && !msg.contains("disabled") && !msg.contains("not enabled") {
            tracing::warn!(error = %msg, "triage: auto-fire after fetch failed");
        }
    }
}

/// Run every registered fetcher once. Logs per-provider summary +
/// errors. Public so the manual "Run now" command path (TODO) can reuse
/// it without going through the scheduler thread.
pub fn run_once() {
    for fetcher in registered_fetchers() {
        let source = fetcher.source();
        let started = Instant::now();
        match fetcher.fetch_once() {
            Ok(summary) => {
                tracing::info!(
                    source,
                    inserted = summary.inserted,
                    updated = summary.updated,
                    skipped = summary.skipped_decided,
                    scanned = summary.source_parents_scanned,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "triage fetcher: tick done"
                );
            }
            Err(error) => {
                tracing::warn!(
                    source,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    error = %format!("{error:#}"),
                    "triage fetcher: tick failed"
                );
            }
        }
    }
}

fn registered_fetchers() -> Vec<Box<dyn Fetcher>> {
    vec![
        Box::new(github::GithubFetcher),
        Box::new(gitlab::GitlabFetcher),
        Box::new(im::ImFetcher(im::slack::SlackBackend)),
        Box::new(im::ImFetcher(im::lark::LarkBackend)),
    ]
}
