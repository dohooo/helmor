use anyhow::Context;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    agents::ActionKind, db, rate_limits::throttle::Throttle, settings, sidecar::ManagedSidecar,
};

use super::common::{run_blocking, CmdResult};

/// 30 s belt-and-suspenders gate for rate-limit fetchers. Independent
/// of the frontend's 2 min `refetchInterval` and hover-triggered
/// refetches: even if the UI somehow hammers the command (event-loop
/// bug, runaway hover handler), the upstream HTTP call still fires at
/// most once per provider per 30 s. Within the cooldown window the
/// caller gets the cached body verbatim.
const RATE_LIMITS_THROTTLE_SECONDS: i64 = 30;
static CLAUDE_RATE_LIMITS_THROTTLE: Throttle = Throttle::new(RATE_LIMITS_THROTTLE_SECONDS);
static CODEX_RATE_LIMITS_THROTTLE: Throttle = Throttle::new(RATE_LIMITS_THROTTLE_SECONDS);

/// System prompt for the voice-mode agent. Organized around three
/// intents — new task / anchored task / status query — so the model
/// has a clear default action for every user turn instead of stalling
/// on "which workspace?" clarifications. Kept deliberately short:
/// `gpt-realtime-2` is sensitive to instruction conflicts (per the
/// official prompting guide), and long prompts breed conflicts.
/// Tool descriptions in the `tools` array (built from clap `--help`
/// by `commands::voice_tools`) carry per-tool specifics; this prompt
/// only covers cross-cutting behavior.
const VOICE_AGENT_INSTRUCTIONS: &str = r#"# Role
You are Helmor's voice frontend. You do NOT plan, look up data, or reason. You delegate substantive work to the planner agent via `ask_planner` and voice the responses it streams back. Fast turn-taking, not reasoning.

# Routing
- ANY substantive user request (question, lookup, action, opinion, anything that needs thought) -> `ask_planner` with the user's verbatim transcript. Then speak ONE short ack in the user's language ("on it." / "好的。") and STOP. The dispatcher injects the planner's say/final updates as separate spoken responses; you stay silent until the user speaks again.
- Trivial signals you handle directly (do NOT delegate these):
  - Silence / background audio / not addressed -> `wait_for_user`.
  - Goodbye / "that's all" / "拜拜" / "算了" -> short goodbye, then `end_session`.
  - Visual references ("look at this", "this error") -> `capture_screen` once; default `window`, `screen` only if asked.
- PoC harness: `start_planner_poc` only on explicit "start the planner test" / "启动 planner 测试". After the ack, stay silent — dispatcher injects 5 lines on its own.

# Style
- Reply in the user's language. Be terse: one short sentence per ack. No opener, no "let me know".
- Never read UUIDs, hashes, paths, raw JSON, markdown, URLs.
- If `ask_planner` returns an error envelope, voice the error briefly ("planner is unavailable, try again") and stop.

# What NOT to do
- Do NOT answer substantive questions yourself, even if you know the answer.
- Do NOT call any other tool (list_workspaces, send_prompt, search_mcp_tools, …) — those are the planner's job in Phase 2. For Phase 1 you only have: ask_planner, wait_for_user, end_session, capture_screen, start_planner_poc.
- Do NOT speak again between the ack and the user's next turn unless the planner is clearly broken.
"#;

fn voice_agent_instructions_with_current_time() -> String {
    let now = chrono::Local::now();
    let current_context = match current_helmor_context() {
        Ok(Some(context)) => format!("\n\n{}", context.to_instruction_block()),
        Ok(None) => String::new(),
        Err(error) => {
            tracing::warn!(
                target: "helmor_lib::voice_session",
                "failed to build current Helmor context: {error:#}"
            );
            String::new()
        }
    };
    format!(
        "# Time\n- Now: {}.\n- Resolve relative dates from Now.{}\
        \n\n{}",
        now.format("%Y-%m-%d %H:%M:%S %:z"),
        current_context,
        VOICE_AGENT_INSTRUCTIONS
    )
}

#[derive(Debug, Default)]
struct CurrentHelmorContext {
    repository_slug: Option<String>,
    workspace_ref: Option<String>,
    active_session: Option<String>,
}

impl CurrentHelmorContext {
    fn to_instruction_block(&self) -> String {
        let mut lines = vec!["# Helmor context".to_string()];
        if let Some(slug) = &self.repository_slug {
            lines.push(format!("- Repo slug: {slug}"));
        }
        if let Some(workspace_ref) = &self.workspace_ref {
            lines.push(format!("- Workspace ref: {workspace_ref}"));
        }
        if let Some(active_session) = &self.active_session {
            lines.push(format!("- Active session: {active_session}"));
        }
        lines.push("- Prefer this for current, this, here, latest, or it.".to_string());
        lines.join("\n")
    }
}

fn current_helmor_context() -> anyhow::Result<Option<CurrentHelmorContext>> {
    let Some(workspace_id) = settings::load_setting_value("app.last_workspace_id")? else {
        return Ok(None);
    };
    let Some(workspace) = crate::models::workspaces::load_workspace_record_by_id(&workspace_id)?
    else {
        return Ok(None);
    };

    let repository_slug = crate::forge::accounts::forge_target_from(
        workspace.forge_provider.as_deref(),
        workspace.remote_url.as_deref(),
    )
    .map(|target| {
        format!(
            "{}:{}/{}",
            target.provider.as_storage_str(),
            target.owner,
            target.name
        )
    });
    let workspace_ref = clean_context_value(workspace.branch.as_deref())
        .or_else(|| clean_context_value(Some(&workspace.directory_name)))
        .or_else(|| clean_context_value(Some(&workspace.id)));
    let active_session = current_active_session_for_context(
        &workspace.id,
        workspace.active_session_id.as_deref(),
        workspace.active_session_title.as_deref(),
    )?;

    let context = CurrentHelmorContext {
        repository_slug,
        workspace_ref,
        active_session,
    };
    if context.repository_slug.is_none()
        && context.workspace_ref.is_none()
        && context.active_session.is_none()
    {
        return Ok(None);
    }
    Ok(Some(context))
}

fn current_active_session_for_context(
    workspace_id: &str,
    fallback_session_id: Option<&str>,
    fallback_title: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let last_session_id = settings::load_setting_value("app.last_session_id")?;
    let selected_session = match last_session_id.as_deref() {
        Some(session_id) => load_session_context_label(workspace_id, session_id)?,
        None => None,
    };
    if selected_session.is_some() {
        return Ok(selected_session);
    }
    Ok(format_session_context_label(
        fallback_session_id,
        fallback_title,
    ))
}

fn load_session_context_label(
    workspace_id: &str,
    session_id: &str,
) -> anyhow::Result<Option<String>> {
    let conn = db::read_conn()?;
    let mut stmt =
        conn.prepare("SELECT title FROM sessions WHERE id = ?1 AND workspace_id = ?2 LIMIT 1")?;
    let mut rows = stmt.query(rusqlite::params![session_id, workspace_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let title: Option<String> = row.get(0)?;
    Ok(format_session_context_label(
        Some(session_id),
        title.as_deref(),
    ))
}

fn format_session_context_label(session_id: Option<&str>, title: Option<&str>) -> Option<String> {
    match (clean_context_value(title), clean_context_value(session_id)) {
        (Some(title), Some(id)) => Some(format!("{title} [{id}]")),
        (Some(title), None) => Some(title),
        (None, Some(id)) => Some(id),
        (None, None) => None,
    }
}

fn clean_context_value(value: Option<&str>) -> Option<String> {
    let value = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(96).collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiRealtimeClientSecret {
    pub value: String,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct OpenAiRealtimeClientSecretResponse {
    value: String,
    expires_at: Option<i64>,
}

#[tauri::command]
pub async fn get_app_settings() -> CmdResult<std::collections::HashMap<String, String>> {
    run_blocking(|| {
        let conn = db::read_conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM settings WHERE key LIKE 'app.%' OR key LIKE 'branch_prefix_%'",
            )
            .context("Failed to query app settings")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .context("Failed to iterate app settings")?;

        let mut map = std::collections::HashMap::new();
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
        Ok(map)
    })
    .await
}

#[tauri::command]
pub async fn update_app_settings(
    sidecar: State<'_, ManagedSidecar>,
    settings_map: std::collections::HashMap<String, String>,
) -> CmdResult<()> {
    let touched_cursor_key = settings_map.contains_key("app.cursor_provider");
    run_blocking(move || {
        for (key, value) in &settings_map {
            if !key.starts_with("app.") && !key.starts_with("branch_prefix_") {
                continue;
            }
            settings::upsert_setting_value(key, value)?;
        }
        Ok(())
    })
    .await?;

    // Hot-push the key — restart would interrupt other providers.
    if touched_cursor_key {
        sidecar.push_cursor_api_key(crate::sidecar::load_cursor_api_key());
    }
    Ok(())
}

#[tauri::command]
pub async fn create_openai_realtime_client_secret() -> CmdResult<OpenAiRealtimeClientSecret> {
    run_blocking(|| {
        let start = std::time::Instant::now();
        tracing::info!(
            target: "helmor_lib::voice_session",
            "minting OpenAI Realtime client secret",
        );

        let api_key = settings::load_setting_value("app.openai_realtime_api_key")?
            .unwrap_or_default()
            .trim()
            .to_string();

        if api_key.is_empty() {
            tracing::warn!(
                target: "helmor_lib::voice_session",
                "client secret mint aborted: api key not configured",
            );
            anyhow::bail!("OpenAI Realtime API key is not configured.");
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("build OpenAI Realtime HTTP client")?;
        let instructions = voice_agent_instructions_with_current_time();
        let tools = super::voice_agent::build_tools_array();
        let tool_size_summaries = summarize_tool_payload_sizes(&tools);
        let tool_size_summaries_json =
            serde_json::to_string(&tool_size_summaries).unwrap_or_else(|_| "[]".to_string());
        let tools_json_bytes = serde_json::to_vec(&tools)
            .map(|bytes| bytes.len())
            .unwrap_or_default();
        tracing::info!(
            target: "helmor_lib::voice_session",
            tools_count = tools.len(),
            instructions_chars = instructions.chars().count(),
            tools_json_bytes,
            largest_tools = %tool_size_summaries_json,
            "assembled session payload"
        );
        let body = serde_json::json!({
            "expires_after": {
                "anchor": "created_at",
                "seconds": 600
            },
            "session": {
                "type": "realtime",
                "model": "gpt-realtime-2",
                "instructions": instructions,
                // Medium gives the realtime voice agent enough planning
                // depth for multi-step tool routing while avoiding the
                // latency / TPM pressure of high.
                "reasoning": { "effort": "medium" },
                // Default is `inf`, which lets gpt-realtime-2 reserve up
                // to its 32k max output budget for a response. Voice-mode
                // replies and tool arguments should be tiny, so cap this
                // hard to avoid burning most of the TPM bucket per turn.
                "max_output_tokens": 512,
                "output_modalities": ["audio"],
                // Multi-tool sessions accumulate context fast. retention_ratio
                // 0.7 drops the oldest 30% of conversation items once the
                // window cap is reached, reducing repeated truncations in
                // long sessions without changing the tool surface.
                "truncation": {
                    "type": "retention_ratio",
                    "retention_ratio": 0.7
                },
                "audio": {
                    "input": {
                        "noise_reduction": { "type": "near_field" },
                        // Capture user-side text alongside audio so the
                        // conversation history is searchable and the UI can
                        // render transcripts. Mini variant for cost.
                        "transcription": { "model": "gpt-4o-mini-transcribe" },
                        "turn_detection": {
                            // interrupt_response: true so users can interject
                            // mid-narration ("never mind, just list them").
                            // The raised threshold + 1 s silence + the
                            // wait_for_user no-op tool catch the background-
                            // noise false-positives the previous `false`
                            // setting was guarding against.
                            "type": "server_vad",
                            "threshold": 0.8,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": 1000,
                            "create_response": true,
                            "interrupt_response": true
                        }
                    },
                    "output": {
                        "voice": "marin",
                        // Bumped to 1.15 to match the military-radio
                        // cadence in the prompt; 1.0 sounds sleepy for
                        // terse reports, 1.2+ starts to feel chipmunk-y.
                        "speed": 1.15
                    }
                },
                // Tool definitions live in `voice_agent` so their
                // descriptions can be assembled from clap's own
                // `--help` output at session-mint time — one source of
                // truth (the CLI args) for both the human typing
                // `helmor send --help` and the model picking a tool.
                "tools": tools
            }
        });
        let body_json_bytes = serde_json::to_vec(&body)
            .map(|bytes| bytes.len())
            .unwrap_or_default();
        let session_json_bytes = body
            .get("session")
            .and_then(|session| serde_json::to_vec(session).ok())
            .map(|bytes| bytes.len())
            .unwrap_or_default();
        tracing::info!(
            target: "helmor_lib::voice_session",
            body_json_bytes,
            session_json_bytes,
            "assembled client secret request size"
        );

        let post_start = std::time::Instant::now();
        let response = client
            .post("https://api.openai.com/v1/realtime/client_secrets")
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .context("create OpenAI Realtime client secret")?;

        let status = response.status();
        let text = response
            .text()
            .context("read OpenAI Realtime client secret response")?;
        tracing::info!(
            target: "helmor_lib::voice_session",
            status = %status,
            response_bytes = text.len(),
            post_elapsed_ms = post_start.elapsed().as_millis() as u64,
            "client secret HTTP response"
        );

        if !status.is_success() {
            tracing::warn!(
                target: "helmor_lib::voice_session",
                status = %status,
                body_preview = %text.chars().take(500).collect::<String>(),
                "client secret mint failed"
            );
            anyhow::bail!(
                "OpenAI Realtime client secret request failed with HTTP {status}: {text}"
            );
        }

        let parsed: OpenAiRealtimeClientSecretResponse =
            serde_json::from_str(&text).context("parse OpenAI Realtime client secret response")?;
        tracing::info!(
            target: "helmor_lib::voice_session",
            expires_at = ?parsed.expires_at,
            secret_len = parsed.value.len(),
            total_elapsed_ms = start.elapsed().as_millis() as u64,
            "client secret minted"
        );

        Ok(OpenAiRealtimeClientSecret {
            value: parsed.value,
            expires_at: parsed.expires_at,
        })
    })
    .await
}

fn summarize_tool_payload_sizes(tools: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut summaries = tools
        .iter()
        .map(|tool| {
            let name = tool
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("<unknown>");
            let description_chars = tool
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(|description| description.chars().count())
                .unwrap_or_default();
            let parameters_json_bytes = tool
                .get("parameters")
                .and_then(|parameters| serde_json::to_vec(parameters).ok())
                .map(|bytes| bytes.len())
                .unwrap_or_default();
            let total_json_bytes = serde_json::to_vec(tool)
                .map(|bytes| bytes.len())
                .unwrap_or_default();
            (
                total_json_bytes,
                serde_json::json!({
                    "name": name,
                    "descriptionChars": description_chars,
                    "parametersJsonBytes": parameters_json_bytes,
                    "totalJsonBytes": total_json_bytes,
                }),
            )
        })
        .collect::<Vec<_>>();
    summaries.sort_by_key(|(total_json_bytes, _)| std::cmp::Reverse(*total_json_bytes));
    summaries
        .into_iter()
        .take(6)
        .map(|(_, summary)| summary)
        .collect()
}

/// Read the account-global Codex rate-limit snapshot. Each call attempts
/// a live `wham/usage` fetch via the Codex OAuth token in
/// `~/.codex/auth.json` and falls back to the cached body on failure.
/// `app.codex_rate_limits` stores the raw response — no shape mapping —
/// so downstream parsing lives entirely in the frontend, mirroring the
/// Claude pipeline.
///
/// Frontend `useQuery` already caches the returned body and gates
/// repeat calls via `staleTime` / `refetchInterval`. We deliberately do
/// NOT publish a `*RateLimitsChanged` UI-sync event from this command
/// — that would invalidate the same query key the frontend just
/// resolved and trigger an immediate refetch, looping into HTTP 429.
#[tauri::command]
pub async fn get_codex_rate_limits() -> CmdResult<Option<String>> {
    run_blocking(|| {
        let cached = settings::load_setting_value(settings::CODEX_RATE_LIMITS_KEY)?;
        if !CODEX_RATE_LIMITS_THROTTLE.should_fetch() {
            return Ok(cached);
        }
        // Record before the HTTP roundtrip so a 429 or network error
        // also serves the throttle cooldown — we never want a failure
        // to invite an immediate retry.
        CODEX_RATE_LIMITS_THROTTLE.record_attempt();
        match crate::rate_limits::codex::fetch_codex_rate_limits() {
            Ok(body) => {
                settings::upsert_setting_value(settings::CODEX_RATE_LIMITS_KEY, &body)?;
                Ok(Some(body))
            }
            Err(error) => {
                tracing::warn!("Failed to refresh Codex rate limits: {error}");
                Ok(cached)
            }
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_session_static_payload_stays_compact() {
        let instructions = voice_agent_instructions_with_current_time();
        let instructions_chars = instructions.chars().count();
        let tools = super::super::voice_agent::build_tools_array();
        let tools_json_bytes = serde_json::to_vec(&tools).unwrap().len();
        let body = serde_json::json!({
            "session": {
                "instructions": instructions,
                "tools": tools,
            }
        });
        let body_json_bytes = serde_json::to_vec(&body).unwrap().len();

        // Phase-0 PoC bumps this from 4_500 to 5_500 to fit the
        // temporary harness block. Tighten back down to 4_500 when the
        // PoC tool + instructions are stripped.
        assert!(
            instructions_chars < 5_500,
            "voice instructions grew too large: {instructions_chars} chars"
        );
        assert!(
            tools_json_bytes < 10_000,
            "voice tool declarations grew too large: {tools_json_bytes} bytes"
        );
        assert!(
            body_json_bytes < 15_000,
            "voice static session payload grew too large: {body_json_bytes} bytes"
        );
    }
}

/// Read the account-global Claude rate-limit snapshot. Each call
/// attempts a live fetch and falls back to the cached body on failure.
/// `app.claude_rate_limits` stores the raw Anthropic response — no
/// shape mapping — so downstream parsing lives entirely in the frontend.
///
/// See `get_codex_rate_limits` for why this command does not publish a
/// `*RateLimitsChanged` UI-sync event.
#[tauri::command]
pub async fn get_claude_rate_limits() -> CmdResult<Option<String>> {
    run_blocking(|| {
        let cached = settings::load_setting_value(settings::CLAUDE_RATE_LIMITS_KEY)?;
        if !CLAUDE_RATE_LIMITS_THROTTLE.should_fetch() {
            return Ok(cached);
        }
        CLAUDE_RATE_LIMITS_THROTTLE.record_attempt();
        match crate::rate_limits::claude::fetch_claude_rate_limits() {
            Ok(body) => {
                settings::upsert_setting_value(settings::CLAUDE_RATE_LIMITS_KEY, &body)?;
                Ok(Some(body))
            }
            Err(error) => {
                tracing::warn!("Failed to refresh Claude rate limits: {error}");
                Ok(cached)
            }
        }
    })
    .await
}

#[tauri::command]
pub async fn load_auto_close_action_kinds() -> CmdResult<Vec<ActionKind>> {
    run_blocking(settings::load_auto_close_action_kinds).await
}

#[tauri::command]
pub async fn save_auto_close_action_kinds(kinds: Vec<ActionKind>) -> CmdResult<()> {
    run_blocking(move || settings::save_auto_close_action_kinds(&kinds)).await
}

#[tauri::command]
pub async fn load_auto_close_opt_in_asked() -> CmdResult<Vec<ActionKind>> {
    run_blocking(settings::load_auto_close_opt_in_asked).await
}

#[tauri::command]
pub async fn save_auto_close_opt_in_asked(kinds: Vec<ActionKind>) -> CmdResult<()> {
    run_blocking(move || settings::save_auto_close_opt_in_asked(&kinds)).await
}
