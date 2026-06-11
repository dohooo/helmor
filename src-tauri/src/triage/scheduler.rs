//! Layer-2 LLM tick runner. Driven by `fetcher::spawn_scheduler` after each
//! fetch (auto-fire) or by `trigger_tick_now` (manual). Resolves
//! `triageProposal` events → workspaces; `mark_not_actionable`
//! short-circuits via the host bridge.

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
use super::attachments;
use super::config::{load_config, TriageConfig};
use super::fetcher::im as fetcher_im;
use super::fetcher::storage as candidate_storage;
use super::workspace_factory::{create_ai_workspace, CreateAiWorkspaceParams};
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;

/// Per-tick cap on inlined image bytes across ALL candidates. base64
/// inflation factor is ~1.34 — total wire payload stays ≤ ~16 MB which
/// still fits the local llama-server's default request size and leaves
/// room in the 32k context after vision tokenisation.
const PER_TICK_INLINE_BUDGET: u64 = 12 * 1024 * 1024;

/// Per-batch cap, sized for a 32k local context.
const CANDIDATES_PER_BATCH: i64 = 20;
/// Per-tick batch cap (100 candidates total).
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

/// Mirror of sidecar's `propose_workspace` payload.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalEvent {
    candidate_id: String,
    /// Anchor id; composed into `source_ref = chat_id:anchor`.
    task_anchor: String,
    repo_id: String,
    title: String,
    branch_name: String,
    plan_message: String,
}

/// Loop up to MAX_BATCHES_PER_TICK batches; previous batch's decisions
/// persist in DB so SELECT naturally advances.
fn execute_tick<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &TriageConfig,
    tick_id: &str,
) -> Result<ExecuteOk> {
    let repos = list_repos_payload()?;
    let manager = app.state::<crate::local_llm::Manager>();
    // The local LLM can die mid-session (a crash, or a transient connect
    // blip that trips the healthcheck — it then exits and nothing restarts
    // the server until the next app launch). That silently wedges triage:
    // every tick fails the endpoint check below forever. If the model is
    // enabled but not currently serving, (re)start it here so the next tick
    // can classify instead of failing indefinitely. `start()` early-returns
    // when a healthy server is already tracked, so this is a no-op on the
    // happy path.
    if manager.endpoint().is_none() && crate::local_llm::load_settings().enabled {
        if let Err(error) = manager.start() {
            tracing::warn!(
                error = %format!("{error:#}"),
                "triage: local LLM not serving and restart attempt failed",
            );
        }
    }
    let endpoint = manager
        .endpoint()
        .ok_or_else(|| anyhow!("Local LLM is not running"))?;
    // Real llama.cpp `-c` for the active model; lets the sidecar size its deep
    // thinking maxTokens budget to the box instead of a hardcoded guess.
    let context_tokens = manager.current_context_tokens();
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
            context_tokens,
        )?;
        total.created += batch.created;
        total.workspace_failures += batch.workspace_failures;
        // Last non-empty batch summary wins.
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

/// Drain one sidecar batch's events into workspaces.
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
    endpoint_context: u32,
) -> Result<ExecuteOk> {
    let request_id = Uuid::new_v4().to_string();
    let sidecar = app.state::<ManagedSidecar>();
    let rx = sidecar.subscribe(&request_id);

    let enriched_candidates = enrich_with_attachments(candidates);
    let request = SidecarRequest {
        id: request_id.clone(),
        method: "runTriageTick".into(),
        params: json!({
            "tickId": tick_id,
            "systemPrompt": cfg.system_prompt,
            "maxPerTick": cfg.max_per_tick,
            "candidates": enriched_candidates,
            "repos": repos,
            "localModel": {
                "baseUrl": endpoint_url,
                "token": endpoint_token,
                "model": endpoint_model,
                "contextWindow": endpoint_context,
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

/// Resolve a proposal to a workspace; `source_ref = candidate.source_ref:task_anchor` (one chat can spawn N).
fn resolve_and_create<R: Runtime>(
    _app: &AppHandle<R>,
    ev: &ProposalEvent,
) -> Result<super::workspace_factory::CreateAiWorkspaceResult> {
    let row = candidate_storage::get_candidate(&ev.candidate_id)?
        .ok_or_else(|| anyhow!("candidate {} not found", ev.candidate_id))?;
    let anchor = ev.task_anchor.trim();
    if anchor.is_empty() {
        anyhow::bail!(
            "proposal for candidate {} missing task_anchor",
            ev.candidate_id
        );
    }
    let composed_source_ref = format!("{}:{}", row.source_ref, anchor);
    let params = CreateAiWorkspaceParams {
        source_type: row.source.clone(),
        source_ref: composed_source_ref,
        candidate_source_ref: row.source_ref.clone(),
        task_anchor: anchor.to_string(),
        repo_id: ev.repo_id.clone(),
        plan_message: ev.plan_message.clone(),
        title: ev.title.clone(),
        branch_name: ev.branch_name.clone(),
    };
    let result = create_ai_workspace(&params)?;
    // IM fetcher resets next tick; forge has no reset path
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

/// Attach inline base64 image previews to each candidate's JSON payload
/// so the vision-capable local LLM can see them. Non-IM sources pass
/// through untouched. Stops adding images once `PER_TICK_INLINE_BUDGET`
/// is reached — remaining attachments still surface as markdown lines
/// in the chat file the LLM can `read_candidate` for.
fn enrich_with_attachments(candidates: &[candidate_storage::CandidateRow]) -> Vec<Value> {
    let mut remaining: u64 = PER_TICK_INLINE_BUDGET;
    candidates
        .iter()
        .map(|row| enrich_one_candidate(row, &mut remaining))
        .collect()
}

fn enrich_one_candidate(
    row: &candidate_storage::CandidateRow,
    remaining_budget: &mut u64,
) -> Value {
    let mut value = serde_json::to_value(row).unwrap_or(Value::Null);
    let conv_id = row.source_ref.as_str();
    if !matches!(row.source.as_str(), "slack" | "lark") || conv_id.is_empty() {
        return value;
    }
    let entries = fetcher_im::read_attachments_sidecar(&row.source, conv_id);
    if entries.is_empty() {
        return value;
    }
    let mut inlined: Vec<InlineAttachment> = Vec::new();
    for entry in entries {
        if *remaining_budget == 0 {
            break;
        }
        let Some(inline) = attachments::inline_preview(Path::new(&entry.local_path))
            .ok()
            .flatten()
        else {
            continue;
        };
        let cost = inline.data_base64.len() as u64;
        if cost > *remaining_budget {
            continue;
        }
        *remaining_budget -= cost;
        inlined.push(InlineAttachment {
            message_id: entry.message_id,
            filename: entry.filename,
            alt: entry.alt,
            mime_type: inline.mime_type,
            data_base64: inline.data_base64,
        });
    }
    if !inlined.is_empty() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "attachments".into(),
                serde_json::to_value(inlined).unwrap_or(Value::Null),
            );
        }
    }
    value
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InlineAttachment {
    message_id: String,
    filename: String,
    alt: Option<String>,
    mime_type: String,
    data_base64: String,
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
