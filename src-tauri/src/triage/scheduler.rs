//! Layer-2 LLM tick runner. No standalone heartbeat — the fetcher
//! scheduler (`fetcher::spawn_scheduler`) drives both pipelines: it
//! pulls fresh data into `triage_candidate`, then (when triage is
//! enabled + auto_run + LLM is running) fires a tick on top of the
//! freshly-fetched data via `trigger_tick_now`.
//!
//! Manual fires (Settings → Run now) also land here.
//!
//! Tick path:
//!   1. Pull open candidates from `triage_candidate`.
//!   2. Hand the slice to the sidecar LLM with repo list + endpoint.
//!   3. For each `triageProposal` event:
//!      - look up candidate row → `(source, source_ref)`
//!      - call `create_ai_workspace` (also dedups on source pair)
//!      - mark the candidate `decision='proposed'`
//!
//! `mark_not_actionable` writes `decision='skip'` from the sidecar
//! directly via the `triage.record_decision` host bridge — the
//! scheduler never sees those.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

use crate::sidecar::{ManagedSidecar, SidecarRequest};
use crate::ui_sync::{self, UiMutationEvent};

use super::active_status::{ActiveStatusStore, TickOutcome};
use super::config::{load_config, TriageConfig};
use super::fetcher::storage as candidate_storage;
use super::workspace_factory::{create_ai_workspace, CreateAiWorkspaceParams};
use std::sync::mpsc::RecvTimeoutError;

/// How many candidates we hand to the LLM per BATCH. Sized to fit a
/// 32k-token local model with 400-char previews + room for tool calls.
const CANDIDATES_PER_BATCH: i64 = 20;
/// Upper bound on batches we'll loop through within a single tick.
/// `CANDIDATES_PER_BATCH * MAX_BATCHES_PER_TICK = 100` candidates max
/// per tick — typical backlogs clear in one tick without making the
/// loop unbounded if upstream goes wild.
const MAX_BATCHES_PER_TICK: u32 = 5;

static TICK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

pub fn trigger_tick_now<R: Runtime>(app: &AppHandle<R>) -> Result<String> {
    let cfg = load_config()?;
    if !cfg.enabled {
        anyhow::bail!("Triage is disabled");
    }
    if !crate::local_llm::load_settings().enabled {
        anyhow::bail!("Local LLM is not enabled");
    }
    run_tick(app, &cfg)
}

// `execute_tick` unwinds once the sidecar emits its terminal `end` after the stop.
pub fn cancel_tick_in_flight<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
    if !TICK_IN_FLIGHT.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let sidecar = app.state::<ManagedSidecar>();
    let request_id = Uuid::new_v4().to_string();
    let request = SidecarRequest {
        id: request_id,
        method: "stopTriageTick".into(),
        params: json!({}),
    };
    sidecar.send(&request).context("send stopTriageTick")?;
    Ok(true)
}

fn run_tick<R: Runtime>(app: &AppHandle<R>, cfg: &TriageConfig) -> Result<String> {
    if TICK_IN_FLIGHT
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        anyhow::bail!("Another triage tick is in flight");
    }
    let _guard = TickGuard;

    let tick_id = Uuid::new_v4().to_string();
    let store = app.state::<ActiveStatusStore>();
    store.begin(&tick_id);
    ui_sync::publish(app, UiMutationEvent::TriageActiveStatusChanged);

    let outcome = execute_tick(app, cfg, &tick_id);

    let (kind, summary_text) = match &outcome {
        Ok(ExecuteOk {
            cancelled: true,
            summary,
            ..
        }) => (TickOutcome::Cancelled, summary.clone()),
        Ok(ExecuteOk {
            created: 0,
            summary,
            ..
        }) => (TickOutcome::NoActionableItems, summary.clone()),
        Ok(ExecuteOk {
            created, summary, ..
        }) => (
            TickOutcome::CreatedWorkspaces { count: *created },
            summary.clone(),
        ),
        Err(error) => (
            TickOutcome::Failed {
                message: format!("{error:#}"),
            },
            None,
        ),
    };
    store.record_outcome(&tick_id, kind, summary_text);

    store.end();
    ui_sync::publish(app, UiMutationEvent::TriageActiveStatusChanged);
    outcome.map(|_| tick_id)
}

struct TickGuard;
impl Drop for TickGuard {
    fn drop(&mut self) {
        TICK_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

pub struct ExecuteOk {
    pub created: u32,
    pub summary: Option<String>,
    pub cancelled: bool,
    pub workspace_failures: u32,
}

/// What the sidecar sends back inside a `triageProposal` event.
/// Mirror of the new sidecar-side `propose_workspace` payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalEvent {
    candidate_id: String,
    repo_id: String,
    title: String,
    branch_name: String,
    plan_message: String,
}

/// Run up to MAX_BATCHES_PER_TICK back-to-back LLM batches. Each batch
/// pulls a fresh slice of open candidates (the previous batch's
/// decisions are already persisted in DB, so the next SELECT naturally
/// skips them). Stops early when the queue is empty or the user
/// cancels.
fn execute_tick<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &TriageConfig,
    tick_id: &str,
) -> Result<ExecuteOk> {
    let repos = list_repos_payload()?;
    let endpoint = app
        .state::<crate::local_llm::Manager>()
        .endpoint()
        .ok_or_else(|| anyhow!("Local LLM is not running"))?;
    let store = app.state::<ActiveStatusStore>();

    let mut total = ExecuteOk {
        created: 0,
        summary: None,
        cancelled: false,
        workspace_failures: 0,
    };

    for batch_n in 1..=MAX_BATCHES_PER_TICK {
        let candidates = candidate_storage::list_open_candidates(CANDIDATES_PER_BATCH)
            .context("list_open_candidates")?;
        if candidates.is_empty() {
            tracing::info!(
                tick_id = %tick_id,
                batch = batch_n,
                "triage: queue empty, ending tick",
            );
            break;
        }
        store.set_batch(batch_n, MAX_BATCHES_PER_TICK);
        ui_sync::publish(app, UiMutationEvent::TriageActiveStatusChanged);
        tracing::info!(
            tick_id = %tick_id,
            batch = batch_n,
            batch_total = MAX_BATCHES_PER_TICK,
            candidate_count = candidates.len(),
            "triage: batch dispatching",
        );
        let batch = run_one_batch(
            app,
            cfg,
            tick_id,
            &candidates,
            &repos,
            &endpoint.url,
            &endpoint.token,
            &endpoint.api_model,
        )?;
        total.created += batch.created;
        total.workspace_failures += batch.workspace_failures;
        // Keep the most recent non-empty summary — typically the last
        // batch's "nothing more to judge" / cap-reached message is the
        // one users want to see in the outcome line.
        if batch.summary.is_some() {
            total.summary = batch.summary;
        }
        if batch.cancelled {
            total.cancelled = true;
            tracing::info!(tick_id = %tick_id, batch = batch_n, "triage: cancelled by user");
            break;
        }
    }

    ui_sync::publish(app, UiMutationEvent::WorkspaceListChanged);
    Ok(total)
}

/// One sidecar request → drain events → resolve `triageProposal`s into
/// workspaces. Caller (`execute_tick`) aggregates across batches.
#[allow(clippy::too_many_arguments)]
fn run_one_batch<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &TriageConfig,
    tick_id: &str,
    candidates: &[candidate_storage::CandidateRow],
    repos: &Value,
    endpoint_url: &str,
    endpoint_token: &str,
    endpoint_model: &str,
) -> Result<ExecuteOk> {
    let request_id = Uuid::new_v4().to_string();
    let sidecar = app.state::<ManagedSidecar>();
    let rx = sidecar.subscribe(&request_id);

    let request = SidecarRequest {
        id: request_id.clone(),
        method: "runTriageTick".into(),
        params: json!({
            "tickId": tick_id,
            "systemPrompt": cfg.system_prompt,
            "maxPerTick": cfg.max_per_tick,
            "candidates": candidates,
            "repos": repos,
            "localModel": {
                "baseUrl": endpoint_url,
                "token": endpoint_token,
                "model": endpoint_model,
            },
        }),
    };
    sidecar.send(&request).context("send runTriageTick")?;

    let store = app.state::<ActiveStatusStore>();
    let mut proposal_events: Vec<ProposalEvent> = Vec::new();
    let mut summary_message: Option<String> = None;
    let mut got_terminal = false;
    let mut error_message: Option<String> = None;
    let mut cancelled = false;
    let deadline = std::time::Instant::now() + Duration::from_secs(1800);

    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let event = match rx.recv_timeout(deadline - now) {
            Ok(event) => event,
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        };
        match event.event_type() {
            "triageProposal" => {
                if let Some(params_value) = event.raw.get("params") {
                    if let Ok(p) = serde_json::from_value::<ProposalEvent>(params_value.clone()) {
                        proposal_events.push(p);
                    } else {
                        tracing::warn!(
                            raw = ?params_value,
                            "triage: malformed proposal event, skipping",
                        );
                    }
                }
            }
            "triageSummary" => {
                summary_message = event
                    .raw
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
            }
            "triageCancelled" => {
                cancelled = true;
            }
            "triageProgress" => {
                if let Some(turn) = event.raw.get("turn").and_then(Value::as_u64) {
                    store.set_turn(turn as u32);
                }
                if let Some(tool) = event.raw.get("tool").and_then(Value::as_str) {
                    let args = event
                        .raw
                        .get("argsPreview")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    store.push_tool(tool, args);
                }
                ui_sync::publish(app, UiMutationEvent::TriageActiveStatusChanged);
            }
            "end" => {
                got_terminal = true;
                break;
            }
            "error" => {
                got_terminal = true;
                error_message = event
                    .raw
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .or_else(|| Some("sidecar error".into()));
                break;
            }
            _ => {}
        }
    }

    if !got_terminal {
        let stop_req = SidecarRequest {
            id: Uuid::new_v4().to_string(),
            method: "stopTriageTick".into(),
            params: json!({ "tickId": tick_id }),
        };
        let _ = sidecar.send(&stop_req);
        let cleanup_deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let now = std::time::Instant::now();
            if now >= cleanup_deadline {
                break;
            }
            match rx.recv_timeout(cleanup_deadline - now) {
                Ok(event) if matches!(event.event_type(), "end" | "error") => {
                    got_terminal = true;
                    break;
                }
                Ok(_) => continue,
                Err(_) => break,
            }
        }
    }

    sidecar.unsubscribe(&request_id);

    if let Some(msg) = error_message {
        return Err(anyhow!(msg));
    }
    if !got_terminal {
        return Err(anyhow!("triage sidecar tick timed out"));
    }

    let mut created = 0u32;
    let mut workspace_failures = 0u32;
    for ev in proposal_events {
        match resolve_and_create(app, &ev) {
            Ok(result) => {
                created += 1;
                ui_sync::publish(
                    app,
                    UiMutationEvent::SessionMessagesAppended {
                        session_id: result.session_id,
                    },
                );
                ui_sync::publish(
                    app,
                    UiMutationEvent::TriageWorkspaceCreated {
                        workspace_id: result.workspace_id,
                    },
                );
            }
            Err(error) => {
                workspace_failures += 1;
                tracing::warn!(
                    error = %format!("{error:#}"),
                    candidate_id = %ev.candidate_id,
                    "workspace creation failed",
                );
            }
        }
    }

    tracing::info!(
        tick_id = %tick_id,
        created,
        workspace_failures,
        cancelled,
        "triage: batch complete"
    );
    Ok(ExecuteOk {
        created,
        summary: summary_message,
        cancelled,
        workspace_failures,
    })
}

/// Look up the candidate row, build a `CreateAiWorkspaceParams` from its
/// `(source, source_ref)`, create the workspace, and record the decision.
fn resolve_and_create<R: Runtime>(
    _app: &AppHandle<R>,
    ev: &ProposalEvent,
) -> Result<super::workspace_factory::CreateAiWorkspaceResult> {
    let row = candidate_storage::get_candidate(&ev.candidate_id)?
        .ok_or_else(|| anyhow!("candidate {} not found", ev.candidate_id))?;
    let params = CreateAiWorkspaceParams {
        source_type: row.source.clone(),
        source_ref: row.source_ref.clone(),
        repo_id: ev.repo_id.clone(),
        plan_message: ev.plan_message.clone(),
        title: ev.title.clone(),
        branch_name: ev.branch_name.clone(),
    };
    let result = create_ai_workspace(&params)?;
    // Record decision so the candidate doesn't surface again next tick.
    if let Err(error) = candidate_storage::record_decision(
        &ev.candidate_id,
        "proposed",
        Some(&format!("workspace {}", result.workspace_id)),
    ) {
        tracing::warn!(
            error = %format!("{error:#}"),
            candidate_id = %ev.candidate_id,
            "failed to record 'proposed' decision",
        );
    }
    Ok(result)
}

fn list_repos_payload() -> Result<Value> {
    let repos = crate::models::repos::list_repositories()?;
    let payload: Vec<Value> = repos
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id,
                "name": r.name,
                "remoteUrl": r.remote_url,
                "forgeProvider": r.forge_provider,
                "forgeLogin": r.forge_login,
            })
        })
        .collect();
    Ok(Value::Array(payload))
}
