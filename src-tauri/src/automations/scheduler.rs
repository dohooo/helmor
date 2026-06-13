//! Stateless poll-loop scheduler for automations.
//!
//! Same shape as `triage::fetcher::spawn_scheduler`: a dedicated std::thread
//! that ticks every 30s. All durable state lives in SQLite — a tick reads due
//! rows, CAS-claims each slot (advancing `next_run_at` computed from *now*),
//! and only then dispatches. Consequences, by construction:
//!
//! - App quit / crash / machine sleep: the next tick (whenever it happens)
//!   sees overdue rows and fires each exactly once — one catch-up run, no
//!   backlog, no double-fire.
//! - Busy target session: skipped *without claiming*; the 30s cadence is the
//!   retry loop, which serializes runs naturally.
//! - Dispatch failure after a claim: the claim stands (run lost, next slot
//!   recovers) — except the busy race, which rolls the claim back, and a
//!   missing target, which pauses the automation.

use std::collections::{HashMap, HashSet};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use tauri::{AppHandle, Manager};

use super::dispatch::{self, RunError};
use super::schedule::{format_utc, next_run_after, Schedule};
use crate::agents::ActiveStreams;
use crate::models::automations::{self, AutomationRecord, RUNS_IN_CHAT, STATUS_PAUSED};
use crate::models::db;

const STARTUP_DELAY_SEC: u64 = 20;
const TICK_INTERVAL_SEC: u64 = 30;

pub fn spawn_scheduler(app: AppHandle) {
    if let Err(error) = thread::Builder::new()
        .name("automations-scheduler".into())
        .spawn(move || scheduler_loop(app))
    {
        tracing::error!(error = %error, "automations: failed to spawn scheduler thread");
    }
}

fn scheduler_loop(app: AppHandle) {
    // Defer the first tick so startup catch-up runs don't compete with the
    // boot sequence for the single-writer DB pool.
    thread::sleep(Duration::from_secs(STARTUP_DELAY_SEC));
    // automation_id → session_id of a run this process started and believes
    // is still streaming. Purely an overlap guard; pruned against
    // ActiveStreams each tick, so it self-heals and survives nothing.
    let mut in_flight: HashMap<String, String> = HashMap::new();
    loop {
        let start = Instant::now();
        if let Err(error) = tick(&app, &mut in_flight) {
            tracing::warn!(error = %format!("{error:#}"), "automations: tick failed");
        }
        let elapsed = start.elapsed();
        thread::sleep(Duration::from_secs(TICK_INTERVAL_SEC).saturating_sub(elapsed));
    }
}

fn tick(app: &AppHandle, in_flight: &mut HashMap<String, String>) -> anyhow::Result<()> {
    let active_sessions: HashSet<String> = app
        .state::<ActiveStreams>()
        .snapshot_for_ui()
        .into_iter()
        .map(|stream| stream.session_id)
        .collect();
    in_flight.retain(|_, session_id| active_sessions.contains(session_id));

    let now = db::current_timestamp()?;
    let due = automations::due_automations(&now)?;
    if due.is_empty() {
        return Ok(());
    }

    let mut changed = false;
    for automation in due {
        match fire(app, &automation, &active_sessions, in_flight) {
            Ok(row_changed) => changed |= row_changed,
            Err(error) => tracing::warn!(
                automation_id = %automation.id,
                error = %format!("{error:#}"),
                "automations: firing failed"
            ),
        }
    }
    if changed {
        crate::ui_sync::publish(app, crate::ui_sync::UiMutationEvent::AutomationsChanged);
    }
    Ok(())
}

/// Claim-then-dispatch one due automation. Returns true when the row changed
/// (claimed, fired, or paused) so the tick knows to publish a UI event.
fn fire(
    app: &AppHandle,
    automation: &AutomationRecord,
    active_sessions: &HashSet<String>,
    in_flight: &mut HashMap<String, String>,
) -> anyhow::Result<bool> {
    // Overlap guards — skip WITHOUT claiming; the next tick retries.
    if in_flight.contains_key(&automation.id) {
        return Ok(false);
    }
    if automation.runs_in == RUNS_IN_CHAT {
        if let Some(session_id) = automation.session_id.as_deref() {
            if active_sessions.contains(session_id) {
                return Ok(false);
            }
        }
    }

    let schedule: Schedule = match serde_json::from_value(automation.schedule.clone()) {
        Ok(schedule) => schedule,
        Err(error) => {
            // A corrupt schedule would stay due forever — pause loudly
            // instead of warning every 30s.
            tracing::error!(
                automation_id = %automation.id,
                error = %error,
                "automations: unparseable schedule — pausing"
            );
            automations::set_automation_status(&automation.id, STATUS_PAUSED, None)?;
            return Ok(true);
        }
    };

    // Claim before dispatch: CAS on the observed `next_run_at` makes this
    // slot fire at most once, and computing the new value from *now* means a
    // long-offline automation catches up exactly once.
    let new_next = format_utc(next_run_after(&schedule, Utc::now())?);
    let claim_now = db::current_timestamp()?;
    if !automations::claim_automation(
        &automation.id,
        &automation.next_run_at,
        &new_next,
        &claim_now,
    )? {
        // Someone else won (concurrent edit / second claimer). Not ours.
        return Ok(false);
    }

    match dispatch::run_automation_now(app, automation) {
        Ok(started) => {
            tracing::info!(
                automation_id = %automation.id,
                session_id = %started.session_id,
                next_run_at = %new_next,
                "automations: run dispatched"
            );
            in_flight.insert(automation.id.clone(), started.session_id);
            Ok(true)
        }
        Err(RunError::SessionBusy) => {
            // The pre-check raced a user send. Roll the claim back so the
            // slot retries on the next tick instead of losing the run.
            automations::unclaim_automation(
                &automation.id,
                &new_next,
                &automation.next_run_at,
                automation.last_run_at.as_deref(),
            )?;
            Ok(false)
        }
        Err(RunError::TargetMissing(reason)) => {
            tracing::warn!(
                automation_id = %automation.id,
                reason,
                "automations: target missing — pausing"
            );
            automations::set_automation_status(&automation.id, STATUS_PAUSED, None)?;
            Ok(true)
        }
        Err(RunError::Other(error)) => {
            // Keep the claim — deliberate no-retry policy. Unclaiming would
            // hot-retry a persistent failure every 30s; the next scheduled
            // slot is the recovery path.
            tracing::error!(
                automation_id = %automation.id,
                error = %format!("{error:#}"),
                "automations: dispatch failed — run skipped until next slot"
            );
            Ok(true)
        }
    }
}
