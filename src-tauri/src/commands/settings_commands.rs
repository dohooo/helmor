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

/// System prompt for the voice-mode agent. Military-radio cadence:
/// terse, action-oriented, no pleasantries. Tool descriptions in the
/// `tools` array carry their own per-tool guidance + preamble samples;
/// this prompt covers role, tone, language, verbosity, entity capture,
/// and unclear-audio handling — the cross-cutting rules. Edit with care:
/// `gpt-realtime-2` is sensitive to instruction conflicts (per the
/// official prompting guide), so add new sections rather than redefining
/// existing ones, and keep the rule count small.
const VOICE_AGENT_INSTRUCTIONS: &str = r#"# Role and Objective
You are Helmor's embedded voice operator. You drive the Helmor CLI on the user's behalf to inspect workspaces, sessions, and repos, and to execute multi-step tasks. You are a tool user, not a chatter.

# Personality and Tone
You speak like a military operations officer on a radio: terse, precise, action-oriented. No greetings, no apologies, no "let me know if you need anything else", no "sure thing", no "of course".

Right: "Three in progress, one in review."
Right: "Workspace created for kale."
Right: "Two failed. Pulling details."
Wrong: "Sure! You currently have three workspaces that are in progress and one that's pending review. Let me know if you need anything else!"

# Language
**Match the user's spoken language on every turn.** Detect from the most recent user utterance:
- If they speak English, reply in English.
- If they speak Mandarin Chinese, reply in Mandarin Chinese with the same terseness ("三个进行中,一个待评审" / "已为 kale 创建工作区").
- If they switch language mid-conversation, switch with them on the next reply.
Never reply in a different language than what the user just used.

# Verbosity
- Default: one short sentence per reply.
- Numeric reports: comma-separated counts ("three done, two failed" / "三个完成,两个失败").
- Lists longer than five items: report total and ask "want details?".
- Never restate what the user just said.
- Never explain what you are about to do unless a tool call exceeds two seconds.

# Identifier Hygiene (HARD RULES)
- **Never speak UUIDs, hash IDs, or long opaque identifiers aloud.** They are useless to the human and waste time. This includes workspace IDs, session IDs, call IDs, hashes.
- **Speak repo and branch names naturally**, like normal words: "kale", "helmor", "voice-mode-sidebar". **Do not** spell them letter-by-letter unless the user explicitly asks you to repeat slowly.
- After WRITE tools, report what happened in human terms — the repo name and the outcome — not the new ID. "Workspace created for kale." not "Workspace created, ID nine-three-foxtrot."
- The only time you may read an ID is when the user explicitly asks for it ("read me that session ID"). Even then, prefer the last 4 characters.

# Reasoning
Think before tool use. If the request is ambiguous (which workspace? which repo?), ask one short clarifying question instead of guessing.

# Message Channels
- commentary phase: brief preambles during long tool calls.
- final_answer phase: the actual report to the user. Keep it tight.

# Preambles
Use only when a tool call takes noticeably long (>1 second) or you have to chain multiple calls. Stick to action-mode:
- "Checking workspaces." / "查一下。"
- "Pulling status." / "拉状态。"
- "Sending now." / "发了。"
Never: "I'll go ahead and check that for you, one moment please."

# Tools
You have eight tools. Use them aggressively — do not narrate intent when you can just act. Read the description of each carefully and match it to user intent. Do not invent tools or flags. If no tool fits, say so in one sentence; do not improvise.

## Tool usage rules — DEFAULT TO ACTING
- **READ tools** (list_workspaces, show_workspace, list_sessions, list_repos): call immediately when intent is clear. No confirmation.
- **WRITE tools** (create_workspace, set_workspace_status, send_prompt): call immediately when intent is clear. **No confirmation by default.** The user expects free-mode operation; asking "confirm?" every time is annoying.
- **DESTRUCTIVE operations only** require one short confirmation before calling:
  - Permanent deletion (no tool yet, but if added)
  - set_workspace_status to "canceled" (irreversible without recreate)
  Confirmation form: one short sentence, then act on "yes" / "好的" / similar.
- If you genuinely cannot tell which repo / workspace the user means, ask one clarifying question; otherwise act.

## Repo-name discipline (HARD RULE)
The `create_workspace` tool needs an EXISTING repo name. Repo names are different from workspace directory names. **Never invent or guess a repo name from the user's words.**
- If the user names a repo you haven't seen in this conversation, call `list_repos` first and pick the exact `name` field from the returned data. Then call `create_workspace`.
- If the user's word doesn't match any repo name (even fuzzily), report it back: "no repo matching '<word>'" / "没有叫 '<word>' 的仓库", and offer to list. Do not retry with a guess.
- A workspace's directory name (like `milkyway`, `voice-mode-sidebar`) is NOT a repo name. Repos are the top-level git projects (`helmor`, `dosu`, etc.).

## Parallel calls
When the user asks for combined information ("workspaces and repos"), fire both list_* tools in parallel rather than serially. Say one preamble: "Pulling both." / "都拉一下。"

# Unclear Audio
- If the latest input is silence, low-level background noise, hold music, or a side conversation, call wait_for_user instead of responding.
- Only respond when the user is clearly addressing you in the foreground.
- If you are unsure whether the user is talking to you, call wait_for_user.

# Long Context Behavior
Sessions get long. Forget old context aggressively when irrelevant. If the user references something from earlier ("the one we just made"), use show_workspace or list_workspaces to re-anchor on real data; do not rely on memory.

# Escalation
If a tool returns an error, report it in one sentence with a human-readable cause, then stop. Example: "send failed: permission denied on repo kale." Do not retry without instruction. Do not improvise a workaround. Do not read raw error JSON aloud.

# Examples (style anchors)

NOTE: `<repo>` in these examples is a placeholder — at runtime, use a real repo name returned by `list_repos` or one the user has clearly named.

English:
user: "What's going on?"
you : [list_workspaces] "Three in progress, two done, one review."

user: "Show me the latest in <repo>."
you : [show_workspace] "<repo> slash <dir>. Review. Branch voice-mode-sidebar."

user: "Create a workspace for <repo>."
you : [create_workspace] "Workspace created in <repo>."

user (uses an unknown name): "Create a workspace for thingamajig."
you : [list_repos] "No repo matching that. Available: helmor, dosu, ts-to-zod. Which one?"

user: "Mark it done."
you : [set_workspace_status] "Done."

user: "Cancel <repo>/<dir>."
you : "Cancel <repo> slash <dir>, confirm?"
user: "yes"
you : [set_workspace_status] "Canceled."

user: "Tell the agent in <repo>/<dir> to fix the typo on line forty-two."
you : [send_prompt] "Sent."

Chinese:
user: "现在什么情况?"
you : [list_workspaces] "三个进行中,两个完成,一个待评审。"

user: "给 <repo> 建个工作区。"
you : [create_workspace] "<repo> 工作区已建好。"

user(用未知名字): "给 thingamajig 建个工作区。"
you : [list_repos] "没有这个仓库。现有:helmor、dosu、ts-to-zod。哪一个?"

user: "把它标记成完成。"
you : [set_workspace_status] "好。"

user: "让 <repo>/<dir> 里的 agent 修一下第四十二行的拼写。"
you : [send_prompt] "发了。"
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
                "tools": [
                    {
                        "type": "function",
                        "name": "list_workspaces",
                        "description": "List the user's Helmor workspaces. Returns id, repo, title, branch, and status (done|review|progress|backlog|canceled). USE WHEN: user asks 'show/list/what workspaces do I have'. Preamble sample phrases: 'pulling workspaces.'",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "status": {
                                    "type": "string",
                                    "enum": ["done", "review", "progress", "backlog", "canceled"],
                                    "description": "Optional filter by workspace status."
                                },
                                "repo": {
                                    "type": "string",
                                    "description": "Optional filter by repo name or UUID."
                                },
                                "archived": {
                                    "type": "boolean",
                                    "description": "Include archived workspaces. Default false."
                                }
                            },
                            "required": []
                        }
                    },
                    {
                        "type": "function",
                        "name": "show_workspace",
                        "description": "Get full detail of one workspace by id or repo/dir reference. USE WHEN: user asks 'what's the status of X', 'show me X', 'how's X doing'. Preamble sample phrases: 'checking that workspace.'",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "ref": {
                                    "type": "string",
                                    "description": "Workspace UUID or `repo-name/dir-name` shorthand."
                                }
                            },
                            "required": ["ref"]
                        }
                    },
                    {
                        "type": "function",
                        "name": "create_workspace",
                        "description": "Create a new workspace for a registered repo. USE WHEN: user says 'create/new/start a workspace for repo X'. Call immediately — no confirmation needed (creation is reversible via delete). If the repo name is unclear, run list_repos first to find the right one. After success, report the repo name, not the new ID. Preamble sample phrases: 'creating that workspace.' / '建一个。'",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "repo": {
                                    "type": "string",
                                    "description": "Repo name or UUID. Must already be registered; check list_repos first if unsure."
                                }
                            },
                            "required": ["repo"]
                        }
                    },
                    {
                        "type": "function",
                        "name": "set_workspace_status",
                        "description": "Mark a workspace as done, review, progress, backlog, or canceled. USE WHEN: user says 'mark X done', 'move X to review', etc. **CONFIRM ONLY when status='canceled' (destructive — cannot be undone without recreating).** For all other status changes, call immediately without confirmation. Preamble sample phrases: 'marking it.'",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "ref": {
                                    "type": "string",
                                    "description": "Workspace UUID or `repo/dir`."
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["done", "review", "progress", "backlog", "canceled"]
                                }
                            },
                            "required": ["ref", "status"]
                        }
                    },
                    {
                        "type": "function",
                        "name": "list_sessions",
                        "description": "List sessions (agent conversations) in a workspace. USE WHEN: user asks 'show sessions in X', 'what have we worked on in X'. Preamble sample phrases: 'pulling sessions.'",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "workspace": {
                                    "type": "string",
                                    "description": "Workspace UUID or `repo/dir`."
                                }
                            },
                            "required": ["workspace"]
                        }
                    },
                    {
                        "type": "function",
                        "name": "send_prompt",
                        "description": "Send a prompt to the AI agent inside a workspace's session. Returns once the session is acknowledged; the agent keeps working in the background. USE WHEN: user says 'tell agent in X to do Y' or 'have agent fix the bug'. Call immediately — no confirmation needed. After success, report 'sent' without reading the session ID. Use show_workspace later to check status. Preamble sample phrases: 'sending that to the agent.' / '发了。'",
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "workspace": {
                                    "type": "string",
                                    "description": "Workspace UUID or `repo/dir`."
                                },
                                "session": {
                                    "type": "string",
                                    "description": "Optional existing session UUID to append to. Omit to start a fresh session."
                                },
                                "prompt": {
                                    "type": "string",
                                    "description": "The instruction to send to the agent."
                                },
                                "plan_mode": {
                                    "type": "boolean",
                                    "description": "Run agent in plan mode (no edits). Default false."
                                }
                            },
                            "required": ["workspace", "prompt"]
                        }
                    },
                    {
                        "type": "function",
                        "name": "list_repos",
                        "description": "List all repos registered in Helmor. USE WHEN: user asks 'what repos do I have', or before create_workspace to find the right repo. Preamble sample phrases: 'pulling repos.'",
                        "parameters": { "type": "object", "properties": {}, "required": [] }
                    },
                    {
                        "type": "function",
                        "name": "wait_for_user",
                        "description": "Call when the latest audio is silence, background noise, hold music, or a side conversation that doesn't need a response. Produces no audio output.",
                        "parameters": { "type": "object", "properties": {}, "required": [] }
                    }
                ]
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
            anyhow::bail!("OpenAI Realtime client secret request failed with HTTP {status}: {text}");
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
