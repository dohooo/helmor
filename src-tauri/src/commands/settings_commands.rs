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
You are Helmor's voice operator. Prefer actions over narration. Use tools for app work; speak only the short user-facing result.

# Language and style
- Reply entirely in the user's language. Keep repo/workspace names as-is.
- Be terse: one short sentence, no opener, no "let me know".
- Never read UUIDs, hashes, file paths, raw JSON, markdown, or URLs aloud.
- If audio is silence/background/not addressed to you, call `wait_for_user`.

# Routing
1. New work request without a workspace anchor -> `create_workspace_and_send`. If repo is unclear, `list_repos` first. If user asks for variants/方案/A-B in one repo -> `create_workspace_variants`.
2. Anchored workspace request -> `send_prompt`. "Current" means the most recently created/selected workspace.
3. Ship actions -> `run_workspace_action`: commit/push, create PR/MR, merge, pull latest, fix CI/errors, resolve conflicts.
4. Setup/run script -> `run_workspace_script`.
5. Status/read queries -> `list_workspaces`, `show_workspace`, `list_sessions`, `search_sessions`, `get_session_messages`, `list_context_items`, `get_context_item_detail`.
6. Stop/cancel a running agent session -> `stop_session`.
7. "Look at this/screen/error/PR" -> `capture_screen` once. After the image arrives, either act with the right tool or ask one short clarifying question.
8. Switching view only -> `select_workspace`.
9. User says they are done/bye/不用了/没事了 -> speak a short goodbye, then call `end_session`.

# Safety
- Destructive delete requires confirmation first; then call `permanently_delete_workspace` with `confirmed=true`.
- Moving a workspace to `canceled` requires confirmation first.
- Archive is reversible; no confirmation.
- If a tool fails, say the human-readable cause and stop.

# Tool uncertainty
Tool descriptions are intentionally compact. If you are unsure which tool or argument shape to use, call `describe_voice_tools` for the relevant tool names, then continue. Do not guess unknown IDs; get them from list tools.
"#;

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
            instructions_chars = VOICE_AGENT_INSTRUCTIONS.chars().count(),
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
                "instructions": VOICE_AGENT_INSTRUCTIONS,
                // Per the gpt-realtime-2 prompting guide and our research
                // notes, production voice agents should start at `low` --
                // higher effort adds 1-2 s to time-to-first-audio. Bump
                // only if multi-step request quality suffers.
                "reasoning": { "effort": "low" },
                "output_modalities": ["audio"],
                // Multi-tool sessions accumulate context fast. retention_ratio
                // 0.8 drops the bottom 20% of items when we approach the
                // window cap, preserving prompt-cache hits on the system
                // prompt + tool definitions.
                //
                // Note: `max_response_output_tokens` is documented in the
                // Azure mirror but rejected as an unknown parameter by the
                // GA OpenAI API as of 2026-05-11. Omitted until we confirm
                // the correct field name; the model's internal limits and
                // the terse prompt are enough to keep responses short.
                "truncation": {
                    "type": "retention_ratio",
                    "retention_ratio": 0.8
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
        let tools = super::super::voice_agent::build_tools_array();
        let tools_json_bytes = serde_json::to_vec(&tools).unwrap().len();
        let body = serde_json::json!({
            "session": {
                "instructions": VOICE_AGENT_INSTRUCTIONS,
                "tools": tools,
            }
        });
        let body_json_bytes = serde_json::to_vec(&body).unwrap().len();

        assert!(
            VOICE_AGENT_INSTRUCTIONS.chars().count() < 4_000,
            "voice instructions grew too large"
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
