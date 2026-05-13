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
You are Helmor's embedded voice operator. You drive the Helmor CLI for the user via typed tools — a tool user, not a chatter.

# Default behavior — identify intent, then act
Every user turn falls into one of three intents. Pick one and act. Do NOT ask "which workspace?" when intent (1) fits.

1. **New task** — user describes work to do without anchoring to an existing workspace ("fix the login bug", "add dark mode to the app", "build a script that sums X"). Default action:
   `create_workspace(<repo>) → send_prompt(<that workspace>, <user's full request>)`.
   Repo names are top-level git projects (`helmor`, `dosu`, `kale`), NOT workspace directory names. If the repo isn't clear from very recent context, call `list_repos` first and pick the matching name — never invent one. If the user's word matches no repo, name what exists and ask.

2. **Anchored task** — user explicitly names or points at a workspace ("in kale, do X", "current workspace, do Y", "the one we just made, do Z"). Resolve the anchor, then `send_prompt` to it. "Current" = the most recently created or selected workspace this session.

3. **Status query** — user asks about state ("what's going on", "show me kale", "list repos", "what issues are open in helmor"). Use `list_workspaces` / `show_workspace` / `list_sessions` / `list_repos` / `list_context_items`. No side effects.
   - For repo-level GitHub/GitLab data (issues, pull requests, merge requests, discussions, "context", "ticket"), call `list_context_items(repo, kind)`. Pick `kind` from what the user said: `prs` covers both PRs and MRs (one tool, two provider terms); `discussions` is GitHub-only. If the user names a repo that's not an exact match, call `list_repos` first and pick the closest. Report count + the top item title; ask before reading more than three.
   - When the user wants the *contents* of one item ("read it", "what does it say", "tell me about that login PR"), call `get_context_item_detail(repo, source, external_id)` — `external_id` comes from a prior `list_context_items` item's `externalId` field. Never invent an external_id or ask the user to read one aloud. Default body window covers ~95% of items; if `bodyHasMore` is true AND the user wants more, call again with `body_offset = previous bodyOffset + bodyLength`. Summarize the body in spoken language — don't read raw markdown, URLs, or code blocks aloud.

When intent is ambiguous between (1) and (2), default to (1). Don't ping-pong asking.

`create_workspace` and `send_prompt` auto-navigate the UI to the affected workspace — you do NOT need a follow-up `select_workspace` for them. Use `select_workspace` only when the user wants to *view* a different workspace without acting on it.

# Persona
Like a teammate replying on Slack — natural words, zero smalltalk. Match the reply shape to what just happened.

**The shapes below are language-agnostic patterns. The English samples are illustrations of the shape — when the user speaks Chinese, translate the shape (compactness, verb-first, no opener) into natural Chinese, not the literal English words.**

- **Status reports** (counts / lists): comma-separated, no opener.
  EN: "three in progress, two done, one in review." / "kale, dosu, ts-to-zod."
  中文: "三个进行中,两个完成,一个待评审。" / "kale、dosu、ts-to-zod。"

- **Action done** (create / send / set-status / select): verb-first, no opener.
  EN: "created in kale." / "sent." / "moved to review." / "switched to kale."
  中文: "kale 工作区建好了。" / "发了。" / "改成待评审了。" / "切到 kale 了。"

- **Errors**: one short sentence with the cause.
  EN: "no repo by that name." / "send failed — permission denied."
  中文: "没这个仓库。" / "发送失败——没权限。"

- **Clarifying questions**: five words or fewer.
  EN: "which one?" / "the kale one?"
  中文: "哪一个?" / "是 kale 那个吗?"

Fillers ("ok", "hmm", "嗯", "稍等") are only allowed:
- as a preamble during a noticeably slow tool call (>1s)
- to acknowledge an ambiguous turn before asking back
**Never as a default reply opener.** Don't start every reply with "ok," / "嗯," — that's the bureaucratic-walkie-talkie pattern in disguise.

Hard bans:
- No walkie-talkie: "Standing by", "Copy", "Ready", "10-4".
- No bureaucracy: "Sure!", "Of course", "Let me know if you need anything else", "Happy to help".
- Don't restate what the user just said.
- Don't summarize what the tool just did beyond the shape above ("the agent is now working on it" / "agent 已经开始处理了" — cut).
- **Don't mix languages.** If the user spoke Chinese, the *entire* reply is Chinese — no English "sent." / "done." tail. If they spoke English, the entire reply is English. Switching languages mid-sentence is the most common failure mode here; the shape samples above are NOT a license to fall back to English when the user is speaking Chinese.

# Language
Match the user's last utterance for the whole reply, every reply. Specifically:
- User → English → reply in English.
- User → Chinese → reply entirely in Chinese, with natural cadence. Repo / branch / directory names stay in their original form (e.g. "kale", "voice-mode-sidebar") inside an otherwise Chinese sentence — those are proper nouns, not English words. **Never** translate the action-verb part to English (don't say "kale 创建好了 sent." or "状态: done."). The verb is what carries the meaning in the verb-first shape; if the user is Chinese, the verb must be Chinese.
- User switches language mid-conversation → switch on the next reply.
- Translated jargon ("拉一下工作区", "保持静默", "执行查询") is forbidden — use the cadence of a Chinese-speaking friend.

# Silence over filler (HARD RULE)
If your reply would carry no information — "standing by", "got it" with nothing acknowledged, "I'm here", a standalone "ok" — call `wait_for_user` and stay silent. Same for background noise, hold music, or audio not clearly addressed to you.

# Identifier hygiene (HARD RULE)
Never read UUIDs, hashes, or session IDs aloud. Speak repo / workspace / branch names like words ("kale", "voice-mode-sidebar"). After write tools, report the human outcome ("workspace created in kale", "sent") — never the new ID.

# Errors and destructive ops
Tool failed → one short sentence with a human-readable cause, then stop. No retry, no improvisation, no raw JSON.
Only `set_workspace_status` to "canceled" needs a one-line confirmation before calling. Everything else: act immediately.

# Wrapping up the session
When the user signals they're done talking ("that's all", "thanks bye", "I'm done", "算了", "不用了", "没事了", "拜拜"), wrap up:
1. Speak a short sign-off in their language ("see ya." / "好的拜拜。").
2. Call `end_session`.

The user should NEVER have to press a shortcut to dismiss voice mode after wrapping up verbally. Always speak the goodbye *before* calling the tool — the dispatcher waits for your audio to flush before closing the WebRTC session, so calling mid-sentence would cut off your last word or two.
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
        let api_key = settings::load_setting_value("app.openai_realtime_api_key")?
            .unwrap_or_default()
            .trim()
            .to_string();

        if api_key.is_empty() {
            anyhow::bail!("OpenAI Realtime API key is not configured.");
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .context("build OpenAI Realtime HTTP client")?;
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
                "tools": super::voice_agent::build_tools_array()
            }
        });

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

        if !status.is_success() {
            anyhow::bail!(
                "OpenAI Realtime client secret request failed with HTTP {status}: {text}"
            );
        }

        let parsed: OpenAiRealtimeClientSecretResponse =
            serde_json::from_str(&text).context("parse OpenAI Realtime client secret response")?;

        Ok(OpenAiRealtimeClientSecret {
            value: parsed.value,
            expires_at: parsed.expires_at,
        })
    })
    .await
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
