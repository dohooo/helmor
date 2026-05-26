//! Heartbeat scheduler. Fixed 10 min interval. One tick at a time.

use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use chrono::Local;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

use crate::sidecar::{ManagedSidecar, SidecarRequest};
use crate::ui_sync::{self, UiMutationEvent};

use super::active_status::{ActiveStatusStore, TickOutcome};
use super::config::{enabled_provider_ids, load_config, TriageConfig};
use super::sync::{advance_sync, load_sync_map};
use super::workspace_factory::{create_ai_workspace, CreateAiWorkspaceParams};
use super::HEARTBEAT_SEC;
use std::sync::mpsc::RecvTimeoutError;

static TICK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

pub fn spawn_scheduler<R: Runtime>(app: AppHandle<R>) {
    if let Err(error) = thread::Builder::new()
        .name("triage-scheduler".into())
        .spawn(move || scheduler_loop(app))
    {
        tracing::error!(error = %error, "spawn triage scheduler failed");
    }
}

fn scheduler_loop<R: Runtime>(app: AppHandle<R>) {
    thread::sleep(Duration::from_secs(30));
    loop {
        let cfg = match load_config() {
            Ok(c) => c,
            Err(error) => {
                tracing::warn!(error = %format!("{error:#}"), "triage: load_config failed");
                thread::sleep(Duration::from_secs(300));
                continue;
            }
        };
        // Skip when LLM is off or `auto_run` is paused; manual Run-now still works.
        let llm_on = crate::local_llm::load_settings().enabled;
        if cfg.enabled && cfg.auto_run && llm_on {
            if let Err(error) = run_tick(&app, &cfg) {
                let msg = format!("{error:#}");
                if !msg.contains("in flight") {
                    tracing::warn!(error = %msg, "triage tick failed");
                }
            }
        }
        thread::sleep(Duration::from_secs(HEARTBEAT_SEC));
    }
}

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

    let started_at = Local::now();
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
    // Advance only providers the sidecar actually scanned end-to-end, and only
    // when every proposal made it to a workspace. Anything else risks burying
    // items past the next tick's time floor.
    let should_advance = matches!(
        &outcome,
        Ok(ExecuteOk {
            cancelled: false,
            workspace_failures: 0,
            ..
        })
    );
    if should_advance {
        if let Ok(ok) = &outcome {
            for pid in &ok.scanned_providers {
                if let Err(error) = advance_sync(pid, started_at) {
                    tracing::warn!(error = %format!("{error:#}"), provider = %pid, "advance_sync failed");
                }
            }
        }
    }
    store.record_outcome(&tick_id, kind, summary_text);

    // GC unconsumed staged attachments older than 24h.
    super::attachments::sweep_stale_staging(Duration::from_secs(24 * 60 * 60));

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
    /// Proposals that failed `create_ai_workspace`; gates `advance_sync`.
    pub workspace_failures: u32,
    /// Providers the sidecar reports as fully scanned (preflight passed,
    /// tick ran to normal completion). Empty when cancelled / MAX_TURNS.
    pub scanned_providers: Vec<String>,
}

fn execute_tick<R: Runtime>(
    app: &AppHandle<R>,
    cfg: &TriageConfig,
    tick_id: &str,
) -> Result<ExecuteOk> {
    let providers = enabled_provider_ids(cfg);
    if providers.is_empty() {
        tracing::info!(tick_id = %tick_id, "triage: no providers enabled, skipping");
        return Ok(ExecuteOk {
            created: 0,
            summary: None,
            cancelled: false,
            workspace_failures: 0,
            scanned_providers: Vec::new(),
        });
    }

    let repos = list_repos_payload()?;
    let sync_map = load_sync_map().unwrap_or_default();

    let endpoint = app
        .state::<crate::local_llm::Manager>()
        .endpoint()
        .ok_or_else(|| anyhow!("Local LLM is not running"))?;

    tracing::info!(
        tick_id = %tick_id,
        repos = repos.as_array().map(|a| a.len()).unwrap_or(0),
        providers = ?providers,
        "triage: tick dispatching"
    );

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
            "providers": providers,
            "lastTriagedAt": sync_map,
            "repos": repos,
            "localModel": {
                "baseUrl": endpoint.url,
                "token": endpoint.token,
                "model": endpoint.api_model,
            },
        }),
    };
    sidecar.send(&request).context("send runTriageTick")?;

    let store = app.state::<ActiveStatusStore>();
    let mut proposals: Vec<CreateAiWorkspaceParams> = Vec::new();
    let mut summary_message: Option<String> = None;
    let mut scanned_providers: Vec<String> = Vec::new();
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
                    if let Ok(p) =
                        serde_json::from_value::<CreateAiWorkspaceParams>(params_value.clone())
                    {
                        proposals.push(p);
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
            "triageScanned" => {
                if let Some(arr) = event.raw.get("providers").and_then(Value::as_array) {
                    scanned_providers = arr
                        .iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect();
                }
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

    // Timeout / channel drop without an `end`: tell the sidecar to abort and
    // wait briefly for its terminal event before we release in-flight, so a
    // new tick can't overlap the dying one.
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
    for p in proposals {
        match create_ai_workspace(&p) {
            Ok(result) => {
                created += 1;
                // The priming `session_messages` row is inserted inside
                // `create_ai_workspace`, but no message-cache invalidation
                // fires for it on its own. Without this, a user who clicks
                // the freshly-created workspace before the next periodic
                // refetch sees an EmptyState placeholder and assumes the
                // triage produced nothing.
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
                tracing::warn!(error = %format!("{error:#}"), "workspace creation failed");
            }
        }
    }

    tracing::info!(
        tick_id = %tick_id,
        created,
        workspace_failures,
        cancelled,
        scanned = ?scanned_providers,
        "triage: tick complete"
    );
    ui_sync::publish(app, UiMutationEvent::WorkspaceListChanged);
    Ok(ExecuteOk {
        created,
        summary: summary_message,
        cancelled,
        workspace_failures,
        scanned_providers,
    })
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
