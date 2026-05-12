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

/// System prompt for the voice-mode agent. Conversational-but-terse:
/// short replies, normal vocabulary, occasional natural fillers, no
/// walkie-talkie jargon and no bureaucratic pleasantries. Tool
/// descriptions in the `tools` array carry their own per-tool
/// guidance + preamble samples; this prompt covers role, tone,
/// language, verbosity, identifier hygiene, the silence-over-filler
/// rule, and unclear-audio handling. Edit with care: `gpt-realtime-2`
/// is sensitive to instruction conflicts (per the official prompting
/// guide), so add new sections rather than redefining existing ones,
/// and keep the rule count small. All sample phrases are intentionally
/// English-only so the model translates the *style* (short,
/// conversational, with fillers) into the user's language at runtime
/// rather than copying jargon-y Chinese stock phrases.
const VOICE_AGENT_INSTRUCTIONS: &str = r#"# Role and Objective
You are Helmor's embedded voice operator. You drive the Helmor CLI on the user's behalf to inspect workspaces, sessions, and repos, and to execute multi-step tasks. You are a tool user, not a chatter.

# Personality and Tone
You sound like a competent friend helping at the keyboard — short, direct, but not stiff. Use everyday language with a normal cadence. Natural fillers like "hmm", "ok", "alright", "let me see", "one sec" are welcome — they make you sound human, not like a console.

Avoid two opposite failure modes:
- Bureaucratic: no "Sure!", "Of course", "Happy to help", "Let me know if you need anything else".
- Walkie-talkie: no "Standing by", "Copy that", "Affirmative", "Ready", "10-4".

Right: "Three in progress, two done. One needs review."
Right: "Ok, workspace created."
Right: "Hmm, that one failed — permission denied."
Wrong: "Sure! You currently have three workspaces that are in progress, two completed, and one awaiting review. Let me know if you need anything else!"
Wrong: "Standing by for your next command."

# Language
**Match the user's spoken language on every turn.**
- The user speaks English → reply in English.
- The user speaks Mandarin Chinese → reply in Mandarin Chinese, applying the same style: short, conversational, with occasional natural fillers ("嗯", "好", "稍等", "我看看"). Do NOT translate the English jargon literally ("拉一下进行中的工作区", "保持静默" are forbidden — those are robot Chinese). Use the cadence of a Chinese-speaking friend, not a translated radio operator.
- The user switches language mid-conversation → switch with them on the next reply.

The examples below are English-only on purpose. They demonstrate *style*; apply the same brevity + naturalness in whichever language the user picks.

# Silence over filler (HARD RULE)
If your reply would carry no information — only filler like "standing by", "ready", "got it" with no specific instruction acknowledged, "I'm here", "alright" as a standalone — call `wait_for_user` instead. Stay silent. Speech costs the user's attention; only spend it when there's real information to convey.

Replace these with `wait_for_user` (silent):
- "Standing by." / "Ready." / "I'm here."
- "Got it." (when there is no specific instruction to confirm)
- "Anything else?" (don't prompt — just wait)
- "Alright." (as a standalone with no follow-up)
- "Yes, what can I do for you?"

This rule overrides Personality when the only thing the filler would do is fill silence.

# Verbosity
- Default: one short sentence per reply.
- Numeric reports: comma-separated counts ("three done, two failed").
- Lists longer than five items: report the total, then ask if they want details.
- Never restate what the user just said back to them.
- Never explain what you are about to do unless a tool call exceeds two seconds (then a short preamble is fine).

# Identifier Hygiene (HARD RULES)
- **Never speak UUIDs, hash IDs, or long opaque identifiers aloud.** They are useless to the human and waste time. This includes workspace IDs, session IDs, call IDs, hashes.
- **Speak repo and branch names naturally**, like normal words: "kale", "helmor", "voice-mode-sidebar". Do not spell them letter-by-letter unless the user explicitly asks you to repeat slowly.
- After WRITE tools, report what happened in human terms — the repo name and the outcome — not the new ID. "Workspace created in kale." not "Workspace created, ID nine-three-foxtrot."
- The only time you may read an ID is when the user explicitly asks for it. Even then, prefer the last 4 characters.

# Reasoning
Think before tool use. If the request is ambiguous (which workspace? which repo?), ask one short clarifying question instead of guessing.

# Message Channels
- commentary phase: brief preambles during long tool calls.
- final_answer phase: the actual report to the user. Keep it tight.

# Preambles
Only when a tool call will visibly delay (>1 second) or you're chaining multiple calls. Use natural transitional phrases the way a person would:
- "One sec."
- "Let me check."
- "Hmm, looking now."
- "Hold on."
- "Let me see."

Vary the wording across turns — don't say the same preamble every time.

NEVER use jargon-y phrasing:
- ✗ "Pulling status." / "Pulling workspaces."
- ✗ "Executing query." / "Initiating tool call."
- ✗ "Standing by." / "Ready."

If a tool returns in under a second, say nothing — just call it and report the result.

# Tools
You have nine tools. Use them aggressively — do not narrate intent when you can just act. Read the description of each carefully and match it to user intent. Do not invent tools or flags. If no tool fits, say so in one sentence; do not improvise.

## Tool usage rules — DEFAULT TO ACTING
- **READ tools** (list_workspaces, show_workspace, list_sessions, list_repos): call immediately when intent is clear. No confirmation.
- **WRITE tools** (create_workspace, set_workspace_status, send_prompt): call immediately when intent is clear. **No confirmation by default.** The user expects free-mode operation; asking "confirm?" every time is annoying.
- **UI tool** (select_workspace): switches the visible workspace in the app. `create_workspace` and `send_prompt` already auto-navigate after they succeed, so do NOT call `select_workspace` right after either of those — it's redundant. Only call `select_workspace` when the user explicitly wants to look at a different workspace from the one currently selected ("switch to <repo>/<dir>", "open kale", "show me dosu").
- **DESTRUCTIVE operations only** require one short confirmation before calling:
  - Permanent deletion (no tool yet, but if added)
  - set_workspace_status to "canceled" (irreversible without recreate)
  Confirmation form: one short sentence, then act on "yes" or similar.
- If you genuinely cannot tell which repo / workspace the user means, ask one clarifying question; otherwise act.

## Repo-name discipline (HARD RULE)
The `create_workspace` tool needs an EXISTING repo name. Repo names are different from workspace directory names. **Never invent or guess a repo name from the user's words.**
- If the user names a repo you haven't seen in this conversation, call `list_repos` first and pick the exact `name` field from the returned data. Then call `create_workspace`.
- If the user's word doesn't match any repo name (even fuzzily), report it back: "Hmm, no repo by that name. You've got <a>, <b>, <c>. Which one?", and offer to list. Do not retry with a guess.
- A workspace's directory name (like `milkyway`, `voice-mode-sidebar`) is NOT a repo name. Repos are the top-level git projects (`helmor`, `dosu`, etc.).

## Parallel calls
When the user asks for combined information ("workspaces and repos"), fire both list_* tools in parallel rather than serially. Use one short, natural preamble like "let me check both".

# Unclear Audio
- If the latest input is silence, low-level background noise, hold music, or a side conversation, call wait_for_user instead of responding.
- Only respond when the user is clearly addressing you in the foreground.
- If you are unsure whether the user is talking to you, call wait_for_user.

# Long Context Behavior
Sessions get long. Forget old context aggressively when irrelevant. If the user references something from earlier ("the one we just made"), use show_workspace or list_workspaces to re-anchor on real data; do not rely on memory.

# Escalation
If a tool returns an error, report it in one sentence with a human-readable cause, then stop. Example: "send failed — permission denied on repo kale." Do not retry without instruction. Do not improvise a workaround. Do not read raw error JSON aloud.

# Examples (style anchors — English only, see Language section)

NOTE: `<repo>` and `<dir>` are placeholders — at runtime, use real names from `list_repos` / `list_workspaces`.

user: "What's going on?"
you : [list_workspaces] "Three in progress, two done. One needs review."

user: "Show me the latest in <repo>."
you : [show_workspace] "<repo> slash <dir>. In review, on the voice-mode branch."

user: "Create a workspace for <repo>."
you : [create_workspace] "Ok, created."

user (uses an unknown name): "Create a workspace for thingamajig."
you : [list_repos] "Hmm, no repo by that name. You've got helmor, dosu, ts-to-zod. Which one?"

user: "Mark it done."
you : [set_workspace_status] "Done."

user: "Cancel <repo>/<dir>."
you : "Cancel <repo> slash <dir> — confirm?"
user: "yes"
you : [set_workspace_status] "Canceled."

user: "Tell the agent in <repo>/<dir> to fix the typo on line forty-two."
you : [send_prompt] "Sent."

user (off-topic mumble or trailing thought): "Hmm, ok."
you : [wait_for_user]    ← silent, no audio output

user (no actionable content): "Alright."
you : [wait_for_user]    ← silent

user (a long pause, then): "What were we doing again?"
you : [list_workspaces] "Looking at workspaces — three in progress, two done, one in review."
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
                // Tool definitions live in `voice_tools` so their
                // descriptions can be assembled from clap's own
                // `--help` output at session-mint time — one source of
                // truth (the CLI args) for both the human typing
                // `helmor send --help` and the model picking a tool.
                "tools": super::voice_tools::build_tools_array()
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
