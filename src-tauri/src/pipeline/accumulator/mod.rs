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

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde_json::Value;

use super::types::{AgentUsage, CollectedTurn, IntermediateMessage, ParsedAgentOutput};
use streaming::StreamingBlock;

#[cfg(test)]
mod tests;

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

    // ── Coverage guard ───────────────────────────────────────────────
    /// Top-level event types that fell through `push_event`'s match
    /// without a handler. Tested as a hard-zero invariant in
    /// `pipeline_streams.rs` so any new SDK type silently dropped here
    /// fails the build immediately.
    dropped_event_types: Vec<String>,
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
            dropped_event_types: Vec::new(),
        }
    }

    // =====================================================================
    // Public API
    // =====================================================================

    /// Feed a raw sidecar JSON event into the accumulator.
    pub fn push_event(&mut self, value: &Value, raw_line: &str) {
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

        match event_type {
            Some("stream_event") => streaming::handle_stream_event(self, value),
            Some("tool_progress") => streaming::handle_tool_progress(self, value),
            Some("assistant") => self.handle_assistant(value, raw_line),
            Some("user") => self.handle_user(raw_line, value),
            Some("result") => self.handle_result(value, raw_line),
            Some("error") => self.handle_error(raw_line, value),
            Some("item.completed") => codex::handle_item_completed(self, raw_line, value),
            Some("turn.completed") => self.handle_turn_completed(value, raw_line),
            Some("turn.failed") => self.handle_codex_turn_failed(raw_line, value),
            Some("thread.started") | Some("thread.resumed") => {
                if let Some(tid) = value.get("thread_id").and_then(Value::as_str) {
                    self.session_id = Some(tid.to_string());
                }
            }
            Some("rate_limit_event") => self.handle_rate_limit_event(raw_line, value),
            Some("prompt_suggestion") => self.handle_prompt_suggestion(raw_line, value),
            Some("system") => self.handle_claude_system(raw_line, value),
            // Codex turn-lifecycle marker. The SDK emits this immediately
            // before the first item.* event; it carries no rendering content
            // (the assistant text comes from item.completed/agent_message).
            // Pure no-op.
            Some("turn.started") => {}
            // Codex item-lifecycle markers. Items are full snapshots, so
            // item.started/updated route through the same handler as
            // item.completed but without persistence — the streaming
            // render uses the latest snapshot, persistence happens once
            // on completed.
            Some("item.started") | Some("item.updated") => {
                codex::handle_item_snapshot(self, raw_line, value, false);
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
            | Some("titleGenerated") => {}
            other => {
                // Coverage guard: any unhandled top-level event type is
                // recorded so `pipeline_streams.rs` can fail the test if a
                // fixture exercises a type we don't yet parse. Adding a
                // handler above must clear the corresponding entry here.
                let label = other.unwrap_or("<missing-type>").to_string();
                if !self.dropped_event_types.contains(&label) {
                    self.dropped_event_types.push(label);
                }
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

    /// Finalize the accumulator and return persistence output.
    ///
    /// Takes `&mut self` (not `mut self`) so the caller can read additional
    /// state from the accumulator AFTER finalization — most importantly,
    /// `turns_len()` and `turn_at(...)` to persist the turn that
    /// `flush_assistant()` just appended for the final staged assistant
    /// message. Consuming `self` here used to silently drop that turn,
    /// because `flush_assistant` ran AFTER the caller had already read
    /// `turns_len()`.
    ///
    /// Drains owned `Option<String>` and `AgentUsage` fields via
    /// `take()`/`mem::take`. `resolved_model` is cloned (not drained) so
    /// the persistence loop in agents.rs can still call
    /// `accumulator.resolved_model()` to label the turns it just flushed.
    pub fn finish_output(
        &mut self,
        fallback_session_id: Option<&str>,
    ) -> Result<ParsedAgentOutput> {
        self.flush_assistant();

        let assistant_text = self.assistant_text.trim().to_string();
        if assistant_text.is_empty() {
            bail!(
                "{} returned no assistant text.",
                if self.provider == "codex" {
                    "Codex"
                } else {
                    "Claude"
                }
            );
        }

        let thinking_text = self.thinking_text.trim().to_string();
        let thinking_text = if thinking_text.is_empty() {
            None
        } else {
            Some(thinking_text)
        };

        Ok(ParsedAgentOutput {
            assistant_text,
            thinking_text,
            session_id: self
                .session_id
                .take()
                .or_else(|| fallback_session_id.map(str::to_string)),
            resolved_model: self.resolved_model.clone(),
            usage: std::mem::take(&mut self.usage),
            result_json: self.result_json.take(),
        })
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
    }

    fn handle_user(&mut self, raw_line: &str, value: &Value) {
        // Persistence: flush any pending assistant turn
        self.flush_assistant();
        self.turns.push(CollectedTurn {
            role: "user".to_string(),
            content_json: raw_line.to_string(),
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

        // Rendering
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
            role: "error".to_string(),
            content_json: raw_line.to_string(),
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
        // Top-level Claude `system` event (subtype=init|compact_boundary|
        // task_*). The adapter renders the appropriate banner from the
        // subtype.
        self.collect_message(raw_line, value, "system", None);
    }

    fn handle_turn_completed(&mut self, value: &Value, raw_line: &str) {
        // Persistence
        if let Some(parsed_usage) = value.get("usage") {
            self.usage.input_tokens = parsed_usage.get("input_tokens").and_then(Value::as_i64);
            self.usage.output_tokens = parsed_usage.get("output_tokens").and_then(Value::as_i64);
        }
        self.result_json = Some(raw_line.to_string());

        // Rendering
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
            return;
        }

        if let Some(mut template) = self.cur_asst_template.take() {
            if let Some(message) = template.get_mut("message") {
                message["content"] = Value::Array(std::mem::take(&mut self.cur_asst_blocks));
            }
            self.turns.push(CollectedTurn {
                role: "assistant".to_string(),
                content_json: template.to_string(),
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
