//! Background fetchers that populate `triage_candidate`. Layer-2 reads from
//! there; failures are isolated per provider.

pub mod cache;
pub mod github;
pub mod gitlab;
pub mod im;
pub mod storage;

use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Utc};
use tauri::{AppHandle, Runtime as TauriRuntime};
use tokio::runtime::{Builder, Runtime};

/// Cold-start lookback — kept small so fresh users don't drown in old noise.
pub const COLD_START_DAYS: i64 = 3;

/// Cold-start cutoff (DateTime + unix-ms helpers below).
pub fn cold_start_cutoff() -> DateTime<Utc> {
    Utc::now() - chrono::Duration::days(COLD_START_DAYS)
}

pub fn cold_start_cutoff_ms() -> i64 {
    cold_start_cutoff().timestamp_millis()
}

/// Provider trait — one fetch tick per call. Each implementation owns
/// its own cursor / subscription bookkeeping via `storage::*`.
pub trait Fetcher: Send + Sync {
    /// Stable id, e.g. `"github"` / `"lark"`. Used as
    /// `triage_candidate.source` and as the cursor key.
    fn source(&self) -> &'static str;

    /// Run one tick; errors logged, never propagated.
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

/// Spawn the fetcher scheduler thread. Single loop drives fetch + (when
/// enabled) Layer-2 tick on freshly-fetched data.
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

/// Fire a Layer-2 tick post-fetch when enabled + auto_run. Logs
/// failures (swallows the noisy `in flight` case).
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
    if let Err(error) = crate::triage::trigger_tick_now(app) {
        let msg = format!("{error:#}");
        if !msg.contains("in flight") && !msg.contains("disabled") {
            tracing::warn!(error = %msg, "triage: auto-fire after fetch failed");
        }
    }
}

/// Run every registered fetcher once. Logs per-provider summary.
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
