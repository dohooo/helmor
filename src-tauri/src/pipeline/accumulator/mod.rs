//! Stream accumulation: raw sidecar JSON events → IntermediateMessage snapshots.
//!
//! Replaces BOTH the TypeScript `StreamAccumulator` class AND the Rust
//! `ClaudeOutputAccumulator` / `CodexOutputAccumulator` structs.
//!
//! Responsibilities (split across submodules):
//! - `streaming` — Claude block-level streaming (content_block_*) +
//!   `build_partial_*` snapshot constructors + Claude text extractors.
//! - `codex` — Codex `item.*` synthesis (every supported `item.type`).
//! - This file — struct definition, public API, top-level `push_event`
//!   dispatch, lifecycle (`finish_output`), the small Claude full-message
//!   handlers (assistant/user/result/error/system/etc.), and the shared
//!   collection helpers used by both submodules.

mod codex;
mod streaming;

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use super::types::{AgentUsage, CollectedTurn, IntermediateMessage, ParsedAgentOutput};
use streaming::StreamingBlock;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// PushOutcome
// ---------------------------------------------------------------------------

/// Classifies the effect a single `push_event` call had on accumulator
/// state. The pipeline uses this to decide whether the next emit should be
/// a `Full` snapshot, a `Partial` streaming update, or `None`.
///
/// Keeping the classification next to the handlers makes it impossible
/// for a new SDK event type to land without an explicit rendering-tier
/// decision: the dispatch in `push_event` MUST return a variant, which
/// forces the author to think about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
    /// A fully-formed message landed in `collected[]` (or one was replaced
    /// in place by `collect_or_replace`). The pipeline must run the full
    /// adapter + collapse pipeline because the change can affect any part
    /// of the rendered output, not just the trailing partial.
    Finalized,
    /// Only the streaming buffer (`blocks` / `fallback_text` /
    /// `fallback_thinking`) changed. The pipeline can build just the
    /// trailing partial message and emit a `Partial`, skipping collapse.
    StreamingDelta,
    /// Control event with no rendering effect (sidecar framing markers,
    /// SDK turn-lifecycle pings, etc.). The pipeline emits nothing.
    NoOp,
}

// ---------------------------------------------------------------------------
// StreamAccumulator
// ---------------------------------------------------------------------------

/// Unified stream accumulator for both Claude and Codex providers.
///
/// Tracks block-level streaming state for real-time rendering and collects
/// persistence data (turns, usage, model) for the DB layer in `agents.rs`.
///
/// Fields are module-private; the `streaming` and `codex` submodules see
/// them as descendants and mutate state through free functions that take
/// `&mut StreamAccumulator`. External code goes through the methods below.
pub struct StreamAccumulator {
    provider: String,

    // ── Rendering state (replaces TS StreamAccumulator) ──────────────
    /// Finalized full messages ready for the adapter.
    collected: Vec<IntermediateMessage>,
    /// Block-level tracking for Claude structured streaming.
    blocks: BTreeMap<usize, StreamingBlock>,
    /// Whether we've seen at least one content_block_start event.
    has_block_structure: bool,
    /// Fallback flat delta text (legacy backends without block structure).
    fallback_text: String,
    /// Fallback flat delta thinking text.
    fallback_thinking: String,
    /// Stable timestamp for the current streaming partial.
    partial_created_at: Option<String>,
    /// Stable UI message ID for the current in-progress assistant turn.
    active_partial_id: Option<String>,
    partial_count: u32,
    line_count: u64,

    // ── Persistence state (replaces Rust ClaudeOutputAccumulator) ────
    /// Completed turns for DB persistence.
    turns: Vec<CollectedTurn>,
    /// Provider session ID (Claude session_id or Codex thread_id).
    session_id: Option<String>,
    /// Resolved model name.
    resolved_model: String,
    /// Token usage counters.
    usage: AgentUsage,
    /// Raw result JSON line.
    result_json: Option<String>,
    /// Concatenated assistant text (for persistence finalization).
    assistant_text: String,
    /// Concatenated thinking text (Claude only).
    thinking_text: String,
    saw_text_delta: bool,
    saw_thinking_delta: bool,

    // ── Claude-specific accumulation ─────────────────────────────────
    /// Current assistant message ID being built (for turn batching).
    cur_asst_id: Option<String>,
    /// Content blocks from the current assistant message.
    cur_asst_blocks: Vec<Value>,
    /// Template of the current assistant message (for rebuilding).
    cur_asst_template: Option<Value>,

    // ── ID-unification tracking ────────────────────────────────────
    /// Index into `collected[]` for the first entry of the current
    /// pending assistant turn (set on the first `handle_assistant` of a
    /// new SDK message ID, consumed by `flush_assistant`).
    pending_turn_collected_idx: Option<usize>,
    /// Index into `collected[]` for the result message (Claude `result`
    /// or Codex `turn.completed`), used by `sync_result_id`.
    result_collected_idx: Option<usize>,

    // ── Coverage guard ───────────────────────────────────────────────
    /// Top-level event types that fell through `push_event`'s match
    /// without a handler. Tested as a hard-zero invariant in
    /// `pipeline_streams.rs` so any new SDK type silently dropped here
    /// fails the build immediately.
    dropped_event_types: Vec<String>,
}

/// Map an `SDKAssistantMessageError` category string to a human-readable
/// label. Both Claude `assistant.error` and (in the future) any other
/// turn-level failure surface route through this — the rendered SystemNotice
/// is the same shape across providers, so the frontend never branches.
fn assistant_error_message(category: &str) -> String {
    match category {
        "rate_limit" => "Rate limited by Anthropic API",
        "max_output_tokens" => "Output truncated: max output tokens reached",
        "billing_error" => "Billing error: check your Anthropic account",
        "authentication_failed" => "Authentication failed: please re-authenticate",
        "invalid_request" => "Invalid request: malformed payload",
        "server_error" => "Anthropic API server error (5xx)",
        "unknown" => "Assistant turn ended in an unknown error state",
        other => return format!("Assistant error: {other}"),
    }
    .to_string()
}

fn patch_tool_use_block(block: &mut Value, resolved: &HashSet<String>) -> bool {
    let Some(obj) = block.as_object_mut() else {
        return false;
    };
    let block_type = obj.get("type").and_then(Value::as_str);
    if !matches!(
        block_type,
        Some("tool_use") | Some("server_tool_use") | Some("mcp_tool_use")
    ) {
        return false;
    }
    let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return false;
    };
    if resolved.contains(id) {
        return false;
    }
    let current = obj.get("__streaming_status").and_then(Value::as_str);
    if matches!(current, Some("done" | "error")) {
        return false;
    }
    obj.insert(
        "__streaming_status".to_string(),
        Value::String("error".to_string()),
    );
    true
}

fn collect_resolved_id(block: &Value, resolved: &mut HashSet<String>) {
    let Some(obj) = block.as_object() else {
        return;
    };
    let block_type = obj.get("type").and_then(Value::as_str);
    if !matches!(block_type, Some("tool_result") | Some("mcp_tool_result")) {
        return;
    }
    if let Some(id) = obj.get("tool_use_id").and_then(Value::as_str) {
        resolved.insert(id.to_string());
    }
}

impl StreamAccumulator {
    pub fn new(provider: &str, fallback_model: &str) -> Self {
        Self {
            provider: provider.to_string(),
            collected: Vec::new(),
            blocks: BTreeMap::new(),
            has_block_structure: false,
            fallback_text: String::new(),
            fallback_thinking: String::new(),
            partial_created_at: None,
            active_partial_id: None,
            partial_count: 0,
            line_count: 0,
            turns: Vec::new(),
            session_id: None,
            resolved_model: fallback_model.to_string(),
            usage: AgentUsage::default(),
            result_json: None,
            assistant_text: String::new(),
            thinking_text: String::new(),
            saw_text_delta: false,
            saw_thinking_delta: false,
            cur_asst_id: None,
            cur_asst_blocks: Vec::new(),
            cur_asst_template: None,
            pending_turn_collected_idx: None,
            result_collected_idx: None,
            dropped_event_types: Vec::new(),
        }
    }

    // =====================================================================
    // Public API
    // =====================================================================

    /// Feed a raw sidecar JSON event into the accumulator and report what
    /// kind of state change it produced. The caller (`MessagePipeline`)
    /// uses the returned `PushOutcome` to decide between a full re-render,
    /// a partial render, or skipping emission entirely.
    pub fn push_event(&mut self, value: &Value, raw_line: &str) -> PushOutcome {
        self.line_count += 1;

        // Extract session ID
        if let Some(sid) = value
            .get("session_id")
            .and_then(Value::as_str)
            .or_else(|| value.get("thread_id").and_then(Value::as_str))
        {
            self.session_id = Some(sid.to_string());
        }

        // Extract resolved model (Claude only)
        if self.provider != "codex" {
            if let Some(model) = streaming::extract_claude_model_name(value) {
                self.resolved_model = model;
            }
        }

        let event_type = value.get("type").and_then(Value::as_str);

        // Top-level noise filter — types listed in
        // `pipeline::event_filter::SUPPRESSED_EVENT_TYPES` get dropped
        // before any handler runs. Edit that file to toggle.
        if let Some(t) = event_type {
            if crate::pipeline::event_filter::is_suppressed_event_type(t) {
                return PushOutcome::NoOp;
            }
        }

        match event_type {
            // ── Claude streaming deltas ────────────────────────────────
            // These mutate `blocks`/`fallback_text`/`fallback_thinking`
            // and the pipeline can render them via `build_partial`.
            Some("stream_event") => {
                streaming::handle_stream_event(self, value);
                PushOutcome::StreamingDelta
            }
            Some("tool_progress") => {
                streaming::handle_tool_progress(self, value);
                PushOutcome::StreamingDelta
            }

            // ── Claude finalized full messages ─────────────────────────
            Some("assistant") => {
                self.handle_assistant(value, raw_line);
                PushOutcome::Finalized
            }
            Some("user") => {
                self.handle_user(raw_line, value);
                PushOutcome::Finalized
            }
            Some("result") => {
                self.handle_result(value, raw_line);
                PushOutcome::Finalized
            }
            Some("error") => {
                self.handle_error(raw_line, value);
                PushOutcome::Finalized
            }
            Some("rate_limit_event") => {
                self.handle_rate_limit_event(raw_line, value);
                PushOutcome::Finalized
            }
            // `prompt_suggestion` and `auth_status` are normally caught
            // by the noise filter above. The arms stay so uncommenting
            // either entry in `event_filter.rs` reaches a real handler
            // (or NoOp for auth_status, which has no body to render).
            Some("prompt_suggestion") => {
                self.handle_prompt_suggestion(raw_line, value);
                PushOutcome::Finalized
            }
            Some("auth_status") => PushOutcome::NoOp,
            Some("system") => {
                self.handle_claude_system(raw_line, value);
                PushOutcome::Finalized
            }

            // SDKToolUseSummaryMessage — the SDK summarizes a long
            // tool result so the model's context doesn't blow up. We
            // surface it as a SystemNotice so the user knows the raw
            // output was truncated; reshape into a Claude-style
            // `{type: system, subtype: tool_use_summary}` envelope so
            // the existing `convert_system_msg` path renders it.
            Some("tool_use_summary") => {
                self.handle_tool_use_summary(raw_line, value);
                PushOutcome::Finalized
            }

            // ── Codex item / turn events ───────────────────────────────
            // Codex items go through `collect_or_replace` which mutates
            // `collected[]` directly — they don't touch the streaming
            // `blocks` buffer, so the partial-render path can't surface
            // them. They're also free to update non-trailing entries
            // (multiple items can be in flight when subagents fan out),
            // so a "render the trailing partial only" optimization would
            // miss updates. Routing them through `Finalized` means each
            // delta runs the full adapter + collapse pass; that cost is
            // structurally tied to Codex's per-item snapshot model rather
            // than something we can shave with the current pipeline.
            // If this ever becomes a profile hot spot the right fix is
            // to extend `build_partial` to render an arbitrary trailing
            // collected entry (and have `collect_or_replace` report which
            // index it touched), not to silently downgrade these to
            // `StreamingDelta` here.
            Some("item.completed") => {
                codex::handle_item_completed(self, raw_line, value);
                PushOutcome::Finalized
            }
            Some("item.started") | Some("item.updated") => {
                codex::handle_item_snapshot(self, raw_line, value, false);
                PushOutcome::Finalized
            }
            Some("turn.completed") => {
                self.handle_turn_completed(value, raw_line);
                PushOutcome::Finalized
            }
            Some("turn.failed") => {
                self.handle_codex_turn_failed(raw_line, value);
                PushOutcome::Finalized
            }

            // ── No-op control / lifecycle markers ──────────────────────
            // Codex turn-lifecycle marker. The SDK emits this immediately
            // before the first item.* event; it carries no rendering
            // content (the assistant text comes from item.completed
            // /agent_message). Pure no-op.
            Some("turn.started") => PushOutcome::NoOp,
            // Codex thread lifecycle: only updates session_id (already
            // captured above). No render impact.
            Some("thread.started") | Some("thread.resumed") => {
                if let Some(tid) = value.get("thread_id").and_then(Value::as_str) {
                    self.session_id = Some(tid.to_string());
                }
                PushOutcome::NoOp
            }
            // Sidecar protocol control events. These are NOT SDK messages —
            // they're framing markers the sidecar emits to signal terminal
            // state. The agents.rs event loop reacts to them; the pipeline
            // accumulator intentionally has nothing to render.
            Some("end")
            | Some("aborted")
            | Some("ready")
            | Some("pong")
            | Some("stopped")
            | Some("titleGenerated") => PushOutcome::NoOp,

            other => {
                // Coverage guard: any unhandled top-level event type is
                // recorded so `pipeline_streams.rs` can fail the test if a
                // fixture exercises a type we don't yet parse. Adding a
                // handler above must clear the corresponding entry here.
                let label = other.unwrap_or("<missing-type>").to_string();
                if !self.dropped_event_types.contains(&label) {
                    self.dropped_event_types.push(label);
                }
                PushOutcome::NoOp
            }
        }
    }

    /// Top-level event types seen during this run that no handler matched.
    /// Empty in steady state — `pipeline_streams.rs` asserts on this.
    pub fn dropped_event_types(&self) -> &[String] {
        &self.dropped_event_types
    }

    /// Borrow the collected (finalized) messages — no allocation.
    pub fn collected(&self) -> &[IntermediateMessage] {
        &self.collected
    }

    /// Build only the trailing partial message (if any streaming content exists).
    /// Returns `None` if there is no active streaming content.
    /// This is the only allocation needed per render cycle.
    pub fn build_partial(
        &mut self,
        context_key: &str,
        session_id: &str,
    ) -> Option<IntermediateMessage> {
        if !self.blocks.is_empty() {
            let (partial_id, created_at) = self.get_or_create_partial_identity(context_key);
            Some(streaming::build_partial_from_blocks(
                self, session_id, partial_id, created_at,
            ))
        } else {
            let text = self.fallback_text.trim();
            let thinking = self.fallback_thinking.trim();
            if !text.is_empty() || !thinking.is_empty() {
                let (partial_id, created_at) = self.get_or_create_partial_identity(context_key);
                Some(streaming::build_partial_fallback(
                    self, session_id, partial_id, created_at,
                ))
            } else {
                None
            }
        }
    }

    /// Convenience: build full snapshot (collected + partial) as one Vec.
    /// Used by tests. Production code uses `collected()` + `build_partial()`
    /// to avoid cloning the collected vec.
    #[cfg(test)]
    pub fn snapshot(&mut self, context_key: &str, session_id: &str) -> Vec<IntermediateMessage> {
        let mut messages = self.collected.clone();
        if let Some(partial) = self.build_partial(context_key, session_id) {
            messages.push(partial);
        }
        messages
    }

    /// Whether the accumulator has an active streaming partial.
    pub fn has_active_partial(&self) -> bool {
        !self.blocks.is_empty()
            || !self.fallback_text.trim().is_empty()
            || !self.fallback_thinking.trim().is_empty()
    }

    // ── Persistence accessors ───────────────────────────────────────

    pub fn turns_len(&self) -> usize {
        self.turns.len()
    }

    pub fn turn_at(&self, index: usize) -> &CollectedTurn {
        &self.turns[index]
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    pub fn resolved_model(&self) -> &str {
        &self.resolved_model
    }

    pub fn usage(&self) -> &AgentUsage {
        &self.usage
    }

    pub fn result_json(&self) -> Option<&str> {
        self.result_json.as_deref()
    }

    /// Propagate pre-assigned turn UUIDs back into the corresponding
    /// `collected[]` entries so the IDs the frontend sees during streaming
    /// match the IDs stored in the DB. Call after persisting turns.
    pub fn sync_persisted_ids(&mut self) {
        for turn in &self.turns {
            if let Some(idx) = turn.collected_idx {
                if idx < self.collected.len() {
                    self.collected[idx].id = turn.id.clone();
                }
            }
        }
    }

    /// Propagate the result message's DB row ID into the corresponding
    /// `collected[]` entry. Call after `persist_result_and_finalize`.
    pub fn sync_result_id(&mut self, result_id: &str) {
        if let Some(idx) = self.result_collected_idx {
            if idx < self.collected.len() {
                self.collected[idx].id = result_id.to_string();
            }
        }
    }

    /// Reclassify any in-flight tool_use as `error` so the adapter's
    /// settle pass can fill `result = "aborted by user"` and the
    /// frontend stops the spinner. Walks live Claude blocks, staged
    /// blocks, and collected[] (where Codex synthetic items live).
    /// Tool_uses with a matching tool_result are left alone.
    pub fn mark_pending_tools_aborted(&mut self) {
        let resolved_ids = self.collect_resolved_tool_use_ids();

        for block in self.blocks.values_mut() {
            if let StreamingBlock::ToolUse {
                tool_use_id,
                status,
                ..
            } = block
            {
                if resolved_ids.contains(tool_use_id.as_str()) {
                    continue;
                }
                if matches!(*status, "pending" | "streaming_input" | "running") {
                    *status = "error";
                }
            }
        }

        for block in self.cur_asst_blocks.iter_mut() {
            patch_tool_use_block(block, &resolved_ids);
        }

        for msg in self.collected.iter_mut() {
            if msg.role != "assistant" {
                continue;
            }
            let Some(parsed) = msg.parsed.as_mut() else {
                continue;
            };
            let Some(blocks) = parsed
                .get_mut("message")
                .and_then(|m| m.get_mut("content"))
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            let mut changed = false;
            for block in blocks.iter_mut() {
                if patch_tool_use_block(block, &resolved_ids) {
                    changed = true;
                }
            }
            if changed {
                msg.raw_json =
                    serde_json::to_string(parsed).unwrap_or_else(|_| msg.raw_json.clone());
            }
        }
    }

    fn collect_resolved_tool_use_ids(&self) -> HashSet<String> {
        let mut ids = HashSet::new();
        for msg in &self.collected {
            let Some(parsed) = msg.parsed.as_ref() else {
                continue;
            };
            let Some(blocks) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for block in blocks {
                collect_resolved_id(block, &mut ids);
            }
        }
        // mcp_tool_result can live inline in the still-staged assistant message
        for block in &self.cur_asst_blocks {
            collect_resolved_id(block, &mut ids);
        }
        ids
    }

    /// Flush staged Claude assistant blocks into `self.turns`. Idempotent.
    pub fn flush_pending(&mut self) {
        self.flush_assistant();
    }

    /// Convert any active streaming partial into a finalized assistant
    /// message so terminal notices can land after it in the rendered thread.
    /// Used by abort handling, where no final provider `assistant` event will
    /// arrive to consume the partial naturally.
    pub(super) fn materialize_partial(&mut self, context_key: &str, _session_id: &str) {
        if !self.has_active_partial() {
            return;
        }

        let (partial_id, created_at) = self.get_or_create_partial_identity(context_key);
        let partial = if !self.blocks.is_empty() {
            streaming::build_materialized_partial_from_blocks(self, partial_id, created_at)
        } else {
            streaming::build_materialized_partial_fallback(self, partial_id, created_at)
        };

        if let Some(message) = partial {
            let collected_idx = self.collected.len();
            self.turns.push(CollectedTurn {
                id: uuid::Uuid::new_v4().to_string(),
                role: "assistant".to_string(),
                content_json: message.raw_json.clone(),
                collected_idx: Some(collected_idx),
            });
            self.collected.push(message);
        }

        self.finalize_blocks();
    }

    /// Project accumulator state into `ParsedAgentOutput`. Always succeeds —
    /// empty input yields empty output. Drains owned fields, single-call.
    pub fn drain_output(&mut self, fallback_session_id: Option<&str>) -> ParsedAgentOutput {
        let assistant_text = self.assistant_text.trim().to_string();
        let thinking_text = {
            let t = self.thinking_text.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        };

        ParsedAgentOutput {
            assistant_text,
            thinking_text,
            session_id: self
                .session_id
                .take()
                .or_else(|| fallback_session_id.map(str::to_string)),
            resolved_model: self.resolved_model.clone(),
            usage: std::mem::take(&mut self.usage),
            result_json: self.result_json.take(),
        }
    }

    /// Push an `{type:"error",content:"aborted by user"}` row into both
    /// `collected[]` (live render) and `turns` (persistence). Same shape
    /// imported sessions use, so the existing adapter renders it.
    pub fn append_aborted_notice(&mut self) {
        const NOTICE_JSON: &str = r#"{"type":"error","content":"aborted by user"}"#;
        let parsed = serde_json::json!({
            "type": "error",
            "content": "aborted by user",
        });

        self.line_count += 1;
        let collected_idx = self.collected.len();
        self.collected.push(IntermediateMessage {
            id: format!("abort:{}", self.line_count),
            role: "error".to_string(),
            raw_json: NOTICE_JSON.to_string(),
            parsed: Some(parsed),
            created_at: chrono::Utc::now().to_rfc3339(),
            is_streaming: false,
        });
        self.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "error".to_string(),
            content_json: NOTICE_JSON.to_string(),
            collected_idx: Some(collected_idx),
        });
    }

    // =====================================================================
    // Claude full-message handlers (small enough to live alongside dispatch)
    // =====================================================================

    fn handle_assistant(&mut self, value: &Value, raw_line: &str) {
        // === Persistence ===
        if !self.saw_text_delta {
            if let Some(text) = streaming::extract_claude_assistant_text(value) {
                self.assistant_text.push_str(&text);
            }
        }
        if !self.saw_thinking_delta {
            if let Some(thinking) = streaming::extract_claude_thinking_text(value) {
                self.thinking_text.push_str(&thinking);
            }
        }

        // Turn batching for persistence: group content blocks by message ID.
        let msg_id = value
            .get("message")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str);

        // If we're already batching a different msg_id, flush it first.
        let same_msg_id = self
            .cur_asst_id
            .as_deref()
            .is_some_and(|current| Some(current) == msg_id);
        if self.cur_asst_id.is_some() && !same_msg_id {
            self.flush_assistant();
        }

        // Track the collected[] index of the first entry in this
        // assistant group so flush_assistant can link the turn to it.
        if self.pending_turn_collected_idx.is_none() {
            self.pending_turn_collected_idx = Some(self.collected.len());
        }

        self.cur_asst_id = msg_id.map(str::to_string);
        self.cur_asst_template = Some(value.clone());
        if let Some(blocks) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            // The Claude SDK sends each finalized content block as its own
            // `assistant` event with the SAME msg_id — i.e., delta-style,
            // not cumulative snapshot. Append, don't replace, so prior
            // blocks (e.g. a thinking block immediately before a tool_use)
            // survive into the persisted turn.
            //
            // The original code used `cur_asst_blocks = blocks.clone()`
            // assuming each event carried a complete turn snapshot. That
            // assumption was wrong, and silently dropped every thinking
            // block followed by another block of the same turn — DB
            // inspection from 2026-04 onwards showed zero thinking
            // blocks in any persisted assistant row.
            if same_msg_id {
                self.cur_asst_blocks.extend_from_slice(blocks);
            } else {
                self.cur_asst_blocks = blocks.clone();
            }
        }

        // === Rendering ===
        // Finalize streaming blocks and push the full message to collected.
        // Matches TS behavior: always push, never replace.
        // The adapter's merge_adjacent_assistants handles merging.
        let partial_id = self.active_partial_id.clone();
        self.finalize_blocks();
        self.collect_message(raw_line, value, "assistant", partial_id.as_deref());

        // SDKAssistantMessage.error: turn-level failure category. Reshape
        // into the same `{type: error, message}` envelope `handle_error`
        // and `handle_codex_turn_failed` use, so the rendered output is
        // identical regardless of which provider produced the failure.
        // Frontend never branches on provider — both Claude assistant
        // errors and Codex turn.failed flow through the same SystemNotice.
        if let Some(category) = value.get("error").and_then(Value::as_str) {
            let label = assistant_error_message(category);
            let synthetic = serde_json::json!({
                "type": "error",
                "message": label,
            });
            let s = serde_json::to_string(&synthetic).unwrap_or_default();
            self.collect_message(&s, &synthetic, "error", None);
        }
    }

    fn handle_user(&mut self, raw_line: &str, value: &Value) {
        // Persistence: flush any pending assistant turn
        self.flush_assistant();
        let collected_idx = self.collected.len();
        self.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "user".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: Some(collected_idx),
        });

        // Rendering
        self.collect_message(raw_line, value, "user", None);
    }

    fn handle_result(&mut self, value: &Value, raw_line: &str) {
        // Persistence
        if self.assistant_text.trim().is_empty() {
            if let Some(text) = value.get("result").and_then(Value::as_str) {
                self.assistant_text.push_str(text);
            }
        }
        if let Some(parsed_usage) = value.get("usage") {
            self.usage.input_tokens = parsed_usage.get("input_tokens").and_then(Value::as_i64);
            self.usage.output_tokens = parsed_usage.get("output_tokens").and_then(Value::as_i64);
        }
        self.result_json = Some(raw_line.to_string());

        // Rendering — track index so sync_result_id can back-fill the DB UUID.
        self.result_collected_idx = Some(self.collected.len());
        self.collect_message(raw_line, value, "assistant", None);
    }

    fn handle_error(&mut self, raw_line: &str, value: &Value) {
        self.collect_message(raw_line, value, "error", None);
    }

    /// Codex `turn.failed` carries `{error: {message}}`. Re-shape into a
    /// generic `{type: error, message}` so it routes through the same
    /// `build_error_label` path the Claude error events use, and persist
    /// the original line so the historical loader can replay it.
    fn handle_codex_turn_failed(&mut self, raw_line: &str, value: &Value) {
        let message = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("Codex turn failed")
            .to_string();
        let synthetic = serde_json::json!({
            "type": "error",
            "message": message,
        });
        let s = serde_json::to_string(&synthetic).unwrap_or_default();
        self.collect_message(&s, &synthetic, "error", None);

        self.turns.push(CollectedTurn {
            id: uuid::Uuid::new_v4().to_string(),
            role: "error".to_string(),
            content_json: raw_line.to_string(),
            collected_idx: None,
        });
    }

    fn handle_rate_limit_event(&mut self, raw_line: &str, value: &Value) {
        // Collected as a "system" intermediate message; the adapter
        // recognizes type=rate_limit_event and emits a SystemNotice part.
        self.collect_message(raw_line, value, "system", None);
    }

    fn handle_prompt_suggestion(&mut self, raw_line: &str, value: &Value) {
        // Collected as system role; the adapter recognizes
        // type=prompt_suggestion and emits a PromptSuggestion part.
        self.collect_message(raw_line, value, "system", None);
    }

    fn handle_claude_system(&mut self, raw_line: &str, value: &Value) {
        // Subtypes listed in `event_filter::SUPPRESSED_SYSTEM_SUBTYPES`
        // never enter `collected[]` — they don't cross IPC, don't render,
        // don't waste downstream work. Edit that file to toggle.
        if let Some(subtype) = value.get("subtype").and_then(Value::as_str) {
            if crate::pipeline::event_filter::is_suppressed_system_subtype(subtype) {
                return;
            }
        }
        self.collect_message(raw_line, value, "system", None);
    }

    /// Reshape an `SDKToolUseSummaryMessage` into a synthetic
    /// `{type: system, subtype: tool_use_summary}` envelope so the
    /// existing system-message conversion path can render it. The
    /// summary text and the count of preceding tool uses both flow
    /// through `convert_system_msg`.
    fn handle_tool_use_summary(&mut self, _raw_line: &str, value: &Value) {
        let summary = value
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if summary.is_empty() {
            return;
        }
        let count = value
            .get("preceding_tool_use_ids")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        let synthetic = serde_json::json!({
            "type": "system",
            "subtype": "tool_use_summary",
            "summary": summary,
            "tool_use_count": count,
        });
        let s = serde_json::to_string(&synthetic).unwrap_or_default();
        self.collect_message(&s, &synthetic, "system", None);
    }

    fn handle_turn_completed(&mut self, value: &Value, raw_line: &str) {
        // Persistence
        if let Some(parsed_usage) = value.get("usage") {
            self.usage.input_tokens = parsed_usage.get("input_tokens").and_then(Value::as_i64);
            self.usage.output_tokens = parsed_usage.get("output_tokens").and_then(Value::as_i64);
        }
        self.result_json = Some(raw_line.to_string());

        // Rendering — Codex equivalent of handle_result
        self.result_collected_idx = Some(self.collected.len());
        self.collect_message(raw_line, value, "assistant", None);
    }

    // =====================================================================
    // Internal helpers — called by submodules and the handlers above.
    // =====================================================================

    pub(super) fn finalize_blocks(&mut self) {
        self.blocks.clear();
        self.has_block_structure = false;
        self.fallback_text.clear();
        self.fallback_thinking.clear();
        self.partial_created_at = None;
        self.active_partial_id = None;
    }

    fn flush_assistant(&mut self) {
        if self.cur_asst_blocks.is_empty() {
            self.cur_asst_id = None;
            self.pending_turn_collected_idx = None;
            return;
        }

        if let Some(mut template) = self.cur_asst_template.take() {
            if let Some(message) = template.get_mut("message") {
                message["content"] = Value::Array(std::mem::take(&mut self.cur_asst_blocks));
            }
            self.turns.push(CollectedTurn {
                id: uuid::Uuid::new_v4().to_string(),
                role: "assistant".to_string(),
                content_json: template.to_string(),
                collected_idx: self.pending_turn_collected_idx.take(),
            });
        }

        self.cur_asst_id = None;
    }

    pub(super) fn collect_message(
        &mut self,
        raw: &str,
        parsed: &Value,
        role: &str,
        override_id: Option<&str>,
    ) {
        let id = override_id
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("stream:{}:{role}", self.line_count));
        let created_at = self.get_partial_created_at();

        self.collected.push(IntermediateMessage {
            id,
            role: role.to_string(),
            raw_json: raw.to_string(),
            parsed: Some(parsed.clone()),
            created_at,
            is_streaming: false,
        });
    }

    /// Collect a message OR replace the most recent existing entry whose
    /// id matches `override_id`. Used by Codex item.* snapshots so a
    /// later item.updated overwrites the earlier item.started/updated for
    /// the same logical item, instead of pushing a new copy.
    pub(super) fn collect_or_replace(
        &mut self,
        raw: &str,
        parsed: &Value,
        role: &str,
        override_id: Option<String>,
    ) {
        if let Some(id) = override_id.as_deref() {
            if let Some(existing) = self.collected.iter_mut().rev().find(|m| m.id == id) {
                existing.raw_json = raw.to_string();
                existing.parsed = Some(parsed.clone());
                return;
            }
        }
        self.collect_message(raw, parsed, role, override_id.as_deref());
    }

    fn get_partial_created_at(&mut self) -> String {
        if self.partial_created_at.is_none() {
            self.partial_created_at = Some(chrono::Utc::now().to_rfc3339());
        }
        self.partial_created_at.clone().unwrap()
    }

    fn get_or_create_partial_identity(&mut self, context_key: &str) -> (String, String) {
        let created_at = self.get_partial_created_at();
        if self.active_partial_id.is_none() {
            self.partial_count += 1;
            self.active_partial_id = Some(format!(
                "{context_key}:stream-partial:{}",
                self.partial_count
            ));
        }
        (self.active_partial_id.clone().unwrap(), created_at)
    }
}
