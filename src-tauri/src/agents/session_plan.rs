//! Per-session "active plan" projection.
//!
//! Provider plan/todo events (`turn/plan/updated` from Codex,
//! `ExitPlanMode` tool_use from Claude) get normalised into a typed
//! [`SessionPlan`] shape and upserted into `session_plan_state`. The
//! frontend reads the projection through [`load_session_plan_state`] so
//! a pinned-plan UI doesn't have to scan the chat transcript to
//! reconstruct the latest plan after a reload.
//!
//! Projection is intentionally read-only as far as the message pipeline
//! is concerned — the same provider events still flow through the
//! accumulator + adapter to render the in-line plan card/todo list.
//! That keeps the transcript snapshot tests stable across this change.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::models::db;

/// Source provider for the captured plan. Carried separately from
/// `plan.rawSource` so callers can switch on it without parsing the
/// JSON blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanSource {
    /// Synthesised from Codex `turn/plan/updated` events.
    Codex,
    /// Captured from a Claude `ExitPlanMode` tool_use.
    ExitPlanMode,
}

impl PlanSource {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ExitPlanMode => "exit_plan_mode",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "codex" => Some(Self::Codex),
            "exit_plan_mode" => Some(Self::ExitPlanMode),
            _ => None,
        }
    }
}

/// Status of a single plan item. Normalised away from provider-
/// specific spellings (`in_progress`, `inProgress`, …) so the
/// frontend never has to branch on provider quirks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
}

/// Status of the plan as a whole. Currently only `Active` — we
/// don't have a clear signal for "plan completed" from either
/// provider yet, so plans persist until replaced. The enum exists so
/// follow-up PRs can add `Completed` / `Cancelled` without a schema
/// migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Active,
}

impl PlanStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub text: String,
    pub status: PlanItemStatus,
}

/// Structured plan payload. Stored as JSON in the
/// `session_plan_state.plan_json` column.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub items: Vec<PlanItem>,
    /// `id` of the first `inProgress` item, when present; otherwise
    /// the first `pending` item. `None` only when every item is
    /// completed or the plan is empty.
    pub current_item_id: Option<String>,
    /// Free-text prompts the provider suggested for continuing /
    /// revising the plan. Sourced from Claude `ExitPlanMode.allowedPrompts`
    /// when present; empty otherwise.
    pub allowed_prompts: Vec<String>,
    /// Plain-text fallback. Populated for `ExitPlanMode` (which ships
    /// a free-form markdown plan rather than structured items) so the
    /// frontend can keep rendering the original prose.
    pub raw_text: Option<String>,
    /// Mirrors `PlanSource.as_str()`. Carried inside the JSON blob so
    /// callers that only have the row payload still know where the
    /// plan came from.
    pub raw_source: String,
}

/// Public response shape for `get_session_plan_state`. Wraps the
/// stored plan with the row-level metadata the UI needs (timestamps,
/// originating message id) without forcing callers to remember the
/// column layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlanState {
    pub session_id: String,
    pub source: PlanSource,
    pub source_message_id: Option<String>,
    pub plan: Plan,
    pub status: PlanStatus,
    pub updated_at: String,
}

/// Parse a Codex `turn/plan/updated` event payload and produce a
/// [`Plan`]. Returns `None` when the payload has no usable plan
/// (missing or empty `plan` array) so callers can skip the upsert.
pub fn plan_from_codex_event(value: &Value) -> Option<Plan> {
    let steps = value.get("plan").and_then(Value::as_array)?;
    if steps.is_empty() {
        return None;
    }

    let items: Vec<PlanItem> = steps
        .iter()
        .enumerate()
        .filter_map(|(idx, step)| {
            let text = step.get("step").and_then(Value::as_str)?.to_string();
            let status = step
                .get("status")
                .and_then(Value::as_str)
                .map(map_codex_status)
                .unwrap_or(PlanItemStatus::Pending);
            // Codex doesn't ship stable per-step ids — derive one from
            // position so the pinned UI has a key. Replacing the plan
            // (subsequent `turn/plan/updated`) re-derives the ids in
            // lockstep, which is what we want.
            Some(PlanItem {
                id: format!("codex-{idx}"),
                text,
                status,
            })
        })
        .collect();

    if items.is_empty() {
        return None;
    }

    let current_item_id = first_actionable_item(&items);
    Some(Plan {
        items,
        current_item_id,
        allowed_prompts: Vec::new(),
        raw_text: None,
        raw_source: PlanSource::Codex.as_str().to_string(),
    })
}

/// Parse the `tool_input` of an `ExitPlanMode` tool_use into a [`Plan`].
/// Claude ships free-text plans (markdown bullet list) rather than
/// structured items, so the projection keeps the original text as a
/// `raw_text` fallback and extracts items per top-level bullet line
/// when the format is recognisable.
pub fn plan_from_exit_plan_mode(tool_input: &Value) -> Option<Plan> {
    let plan_text = tool_input.get("plan").and_then(Value::as_str)?;
    let trimmed = plan_text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let items: Vec<PlanItem> = trimmed
        .lines()
        .filter_map(|line| {
            // Top-level bullets only — leading whitespace marks a
            // nested item that the structured panel can't render in
            // a flat list. The raw markdown still goes into
            // `raw_text` so the panel can fall back to a full render
            // if it ever needs the nesting.
            if line.starts_with(char::is_whitespace) {
                return None;
            }
            let body = line
                .strip_prefix("- ")
                .or_else(|| line.strip_prefix("* "))
                .or_else(|| line.strip_prefix("• "))?;
            let text = body.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        })
        .enumerate()
        .map(|(idx, text)| PlanItem {
            id: format!("exit-plan-{idx}"),
            text,
            status: PlanItemStatus::Pending,
        })
        .collect();

    let current_item_id = first_actionable_item(&items);
    let allowed_prompts = tool_input
        .get("allowedPrompts")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Some(Plan {
        items,
        current_item_id,
        allowed_prompts,
        raw_text: Some(trimmed.to_string()),
        raw_source: PlanSource::ExitPlanMode.as_str().to_string(),
    })
}

fn first_actionable_item(items: &[PlanItem]) -> Option<String> {
    items
        .iter()
        .find(|i| i.status == PlanItemStatus::InProgress)
        .or_else(|| items.iter().find(|i| i.status == PlanItemStatus::Pending))
        .map(|i| i.id.clone())
}

fn map_codex_status(raw: &str) -> PlanItemStatus {
    match raw {
        "completed" => PlanItemStatus::Completed,
        "inProgress" | "in_progress" => PlanItemStatus::InProgress,
        _ => PlanItemStatus::Pending,
    }
}

/// Upsert the current plan for a session. Callers pass the typed plan
/// directly so they pick the projection strategy (Codex vs ExitPlanMode)
/// once and don't re-parse the payload here.
///
/// Returns `Ok(true)` when a row was actually written. A subsequent call
/// with an identical plan still writes (to keep `updated_at` accurate
/// for the bridge invalidation event), so callers don't need to dedupe
/// upstream.
pub fn upsert_session_plan(
    conn: &Connection,
    session_id: &str,
    source: PlanSource,
    source_message_id: Option<&str>,
    plan: &Plan,
) -> Result<bool> {
    let plan_json = serde_json::to_string(plan).context("Failed to serialise plan JSON")?;
    let rows = conn
        .execute(
            r#"
            INSERT INTO session_plan_state (
                session_id, source, source_message_id, plan_json, status, updated_at
            ) VALUES (?1, ?2, ?3, ?4, 'active', datetime('now'))
            ON CONFLICT(session_id) DO UPDATE SET
                source = excluded.source,
                source_message_id = excluded.source_message_id,
                plan_json = excluded.plan_json,
                status = 'active',
                updated_at = datetime('now')
            "#,
            params![session_id, source.as_str(), source_message_id, plan_json],
        )
        .with_context(|| format!("Failed to upsert session_plan_state for {session_id}"))?;
    Ok(rows > 0)
}

/// Borrow the write pool and run [`upsert_session_plan`] under it.
/// Convenience wrapper for runtime hook sites that don't already hold
/// a connection.
pub fn upsert_session_plan_via_pool(
    session_id: &str,
    source: PlanSource,
    source_message_id: Option<&str>,
    plan: &Plan,
) -> Result<bool> {
    let conn = db::write_conn()?;
    upsert_session_plan(&conn, session_id, source, source_message_id, plan)
}

/// Load the latest plan for a session, if any. Returns `Ok(None)`
/// when the row is missing OR when the stored JSON fails to parse —
/// stale rows from a hypothetical breaking shape change should not
/// crash the panel.
pub fn load_session_plan_state(session_id: &str) -> Result<Option<SessionPlanState>> {
    let conn = db::read_conn()?;
    let row = conn
        .query_row(
            "SELECT session_id, source, source_message_id, plan_json, status, updated_at \
             FROM session_plan_state WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .ok();
    let Some((session_id, source_str, source_message_id, plan_json, status_str, updated_at)) = row
    else {
        return Ok(None);
    };

    let source = match PlanSource::from_str(&source_str) {
        Some(s) => s,
        None => {
            tracing::warn!(session_id, source = %source_str, "session_plan: unknown source — ignoring row");
            return Ok(None);
        }
    };
    let plan: Plan = match serde_json::from_str(&plan_json) {
        Ok(plan) => plan,
        Err(error) => {
            tracing::warn!(
                session_id,
                %error,
                "session_plan: stored plan_json failed to parse — ignoring row"
            );
            return Ok(None);
        }
    };
    let status = match status_str.as_str() {
        "active" => PlanStatus::Active,
        other => {
            tracing::warn!(session_id, status = %other, "session_plan: unknown status — defaulting to active");
            PlanStatus::Active
        }
    };

    Ok(Some(SessionPlanState {
        session_id,
        source,
        source_message_id,
        plan,
        status,
        updated_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mirror the production migration so the upsert SQL can run.
        crate::schema::ensure_schema(&conn).unwrap();
        conn
    }

    // ── plan_from_codex_event ──────────────────────────────────────────

    #[test]
    fn codex_plan_maps_statuses_and_picks_current_item() {
        let event = json!({
            "type": "turn/plan/updated",
            "turnId": "t1",
            "plan": [
                { "step": "inspect", "status": "completed" },
                { "step": "design", "status": "in_progress" },
                { "step": "implement", "status": "pending" },
            ],
        });

        let plan = plan_from_codex_event(&event).expect("plan from codex event");
        assert_eq!(plan.items.len(), 3);
        assert_eq!(plan.items[0].status, PlanItemStatus::Completed);
        assert_eq!(plan.items[1].status, PlanItemStatus::InProgress);
        assert_eq!(plan.items[2].status, PlanItemStatus::Pending);
        // Per-position derived id matches what the synthetic TodoWrite
        // emits in the accumulator — stable across replays.
        assert_eq!(plan.items[1].id, "codex-1");
        // `currentItemId` prefers the inProgress step, falling back to
        // the first pending one.
        assert_eq!(plan.current_item_id.as_deref(), Some("codex-1"));
        assert_eq!(plan.raw_source, "codex");
        assert!(plan.raw_text.is_none());
    }

    #[test]
    fn codex_plan_falls_back_to_first_pending_when_no_in_progress() {
        let event = json!({
            "plan": [
                { "step": "design", "status": "completed" },
                { "step": "implement", "status": "pending" },
                { "step": "test", "status": "pending" },
            ],
        });
        let plan = plan_from_codex_event(&event).unwrap();
        assert_eq!(plan.current_item_id.as_deref(), Some("codex-1"));
    }

    #[test]
    fn codex_plan_returns_none_for_missing_or_empty_plan_array() {
        assert!(plan_from_codex_event(&json!({})).is_none());
        assert!(plan_from_codex_event(&json!({ "plan": [] })).is_none());
        // Steps with no `step` field are dropped; if every step is
        // unusable we return None rather than an empty plan.
        let only_garbage = json!({ "plan": [{ "status": "completed" }] });
        assert!(plan_from_codex_event(&only_garbage).is_none());
    }

    #[test]
    fn codex_plan_treats_unknown_status_as_pending() {
        let event = json!({
            "plan": [{ "step": "x", "status": "skipped" }],
        });
        let plan = plan_from_codex_event(&event).unwrap();
        assert_eq!(plan.items[0].status, PlanItemStatus::Pending);
    }

    // ── plan_from_exit_plan_mode ───────────────────────────────────────

    #[test]
    fn exit_plan_mode_extracts_bullet_items_and_preserves_raw_text() {
        let input = json!({
            "plan": "- Inspect backend\n- Add schema\n  - Indented sub-item ignored\n- Implement projection",
            "allowedPrompts": ["Continue plan", "Revise plan"],
        });

        let plan = plan_from_exit_plan_mode(&input).expect("plan from exit_plan_mode");
        // Top-level bullets only — nested ones don't make it into the
        // structured items list, but the raw markdown is preserved.
        assert_eq!(plan.items.len(), 3);
        assert_eq!(plan.items[0].text, "Inspect backend");
        assert_eq!(plan.items[2].text, "Implement projection");
        // All items start as pending — Claude doesn't ship per-item
        // status with ExitPlanMode.
        assert!(plan
            .items
            .iter()
            .all(|i| i.status == PlanItemStatus::Pending));
        assert_eq!(plan.current_item_id.as_deref(), Some("exit-plan-0"));
        assert_eq!(
            plan.allowed_prompts,
            vec!["Continue plan".to_string(), "Revise plan".to_string()]
        );
        assert_eq!(plan.raw_source, "exit_plan_mode");
        assert!(plan.raw_text.as_deref().unwrap().contains("Indented"));
    }

    #[test]
    fn exit_plan_mode_returns_none_for_empty_or_missing_plan() {
        assert!(plan_from_exit_plan_mode(&json!({})).is_none());
        assert!(plan_from_exit_plan_mode(&json!({ "plan": "" })).is_none());
        assert!(plan_from_exit_plan_mode(&json!({ "plan": "   \n  \n" })).is_none());
    }

    #[test]
    fn exit_plan_mode_handles_unbulleted_prose_as_raw_text_only() {
        // Free-form prose without bullets has no extractable items but
        // we still keep the raw text so the panel can render it.
        let plan = plan_from_exit_plan_mode(&json!({
            "plan": "First, do the thing.\nThen do the other thing.",
        }))
        .unwrap();
        assert!(plan.items.is_empty());
        assert!(plan.current_item_id.is_none());
        assert!(plan
            .raw_text
            .as_deref()
            .unwrap()
            .contains("First, do the thing"));
    }

    // ── upsert + load round-trip ───────────────────────────────────────

    #[test]
    fn upsert_and_load_round_trips_typed_shape() {
        let conn = open_test_conn();
        let plan = plan_from_codex_event(&json!({
            "plan": [
                { "step": "one", "status": "completed" },
                { "step": "two", "status": "in_progress" },
            ],
        }))
        .unwrap();

        upsert_session_plan(&conn, "s1", PlanSource::Codex, None, &plan).unwrap();

        // Bypass the connection-pool wrapper because we're in-memory.
        let stored_json: String = conn
            .query_row(
                "SELECT plan_json FROM session_plan_state WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let restored: Plan = serde_json::from_str(&stored_json).unwrap();
        assert_eq!(restored, plan);
    }

    #[test]
    fn upsert_replaces_existing_row_in_place() {
        let conn = open_test_conn();
        let first = plan_from_codex_event(&json!({
            "plan": [{ "step": "design", "status": "pending" }],
        }))
        .unwrap();
        upsert_session_plan(&conn, "s1", PlanSource::Codex, None, &first).unwrap();

        // Update with a different plan (more items, different source
        // — simulates ExitPlanMode landing after a Codex plan).
        let second = plan_from_exit_plan_mode(&json!({
            "plan": "- first\n- second",
        }))
        .unwrap();
        upsert_session_plan(
            &conn,
            "s1",
            PlanSource::ExitPlanMode,
            Some("msg-42"),
            &second,
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_plan_state WHERE session_id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "upsert must keep exactly one row per session");

        let (source, source_msg_id): (String, Option<String>) = conn
            .query_row(
                "SELECT source, source_message_id FROM session_plan_state WHERE session_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(source, "exit_plan_mode");
        assert_eq!(source_msg_id.as_deref(), Some("msg-42"));
    }

    // ── streaming-bypass wiring: real provider event shapes ────────────

    /// Mirrors the exact projection sequence the streaming bypass runs in
    /// `agents::streaming::stream_via_sidecar` — the `event.raw` envelope
    /// the sidecar delivers (NOT a pre-cleaned tool_input) is fed straight
    /// into the parsers, gated the same way, and upserted with the same
    /// `(source, source_message_id)` arguments. Guards against drift between
    /// the real event shapes and the projection layer.
    #[test]
    fn streaming_bypass_projects_real_provider_event_shapes() {
        let conn = open_test_conn();

        // Codex: verbatim `turn/plan/updated` envelope from
        // tests/fixtures/streams/codex/plan-mode.jsonl. The hook gates on
        // `event.raw["type"] == "turn/plan/updated"` before projecting, so
        // assert that discriminator here too.
        let codex_raw = json!({
            "type": "turn/plan/updated",
            "threadId": "thread_1",
            "turnId": "turn_1",
            "plan": [
                { "step": "Audit fixtures", "status": "completed" },
                { "step": "Sanitize captured content", "status": "inProgress" },
                { "step": "Refresh snapshots", "status": "pending" },
            ],
            "session_id": "session_1",
        });
        assert_eq!(
            codex_raw.get("type").and_then(Value::as_str),
            Some("turn/plan/updated"),
            "hook gate must match the real codex event discriminator"
        );
        let codex_plan =
            plan_from_codex_event(&codex_raw).expect("real codex envelope must yield a plan");
        let wrote = upsert_session_plan(&conn, "s1", PlanSource::Codex, None, &codex_plan).unwrap();
        assert!(wrote, "codex projection must write a row");

        let (source, msg_id, plan_json): (String, Option<String>, String) = conn
            .query_row(
                "SELECT source, source_message_id, plan_json \
                 FROM session_plan_state WHERE session_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(source, "codex");
        assert!(
            msg_id.is_none(),
            "codex hook passes source_message_id = None"
        );
        let restored: Plan = serde_json::from_str(&plan_json).unwrap();
        assert_eq!(restored.items.len(), 3);
        assert_eq!(restored.items[1].status, PlanItemStatus::InProgress);
        assert_eq!(restored.current_item_id.as_deref(), Some("codex-1"));
        assert_eq!(restored.raw_source, "codex");

        // Claude: the bypass passes the full `planCaptured` envelope
        // (`event.raw`, with `kind`/`toolUseId` siblings) straight into
        // `plan_from_exit_plan_mode`, and forwards the persisted message id
        // as `source_message_id`.
        let exit_raw = json!({
            "kind": "planCaptured",
            "toolUseId": "toolu_abc",
            "plan": "- Inspect backend\n- Implement projection",
        });
        let exit_plan = plan_from_exit_plan_mode(&exit_raw)
            .expect("real planCaptured envelope must yield a plan");
        let wrote = upsert_session_plan(
            &conn,
            "s2",
            PlanSource::ExitPlanMode,
            Some("msg-1"),
            &exit_plan,
        )
        .unwrap();
        assert!(wrote, "exit_plan_mode projection must write a row");

        let (source, msg_id, plan_json): (String, Option<String>, String) = conn
            .query_row(
                "SELECT source, source_message_id, plan_json \
                 FROM session_plan_state WHERE session_id = 's2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(source, "exit_plan_mode");
        assert_eq!(msg_id.as_deref(), Some("msg-1"));
        let restored: Plan = serde_json::from_str(&plan_json).unwrap();
        assert_eq!(restored.items.len(), 2);
        assert_eq!(restored.raw_source, "exit_plan_mode");
        assert!(restored.raw_text.is_some());
    }
}
