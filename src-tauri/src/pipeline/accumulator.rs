//! Stream accumulation: raw sidecar JSON events → IntermediateMessage snapshots.
//!
//! Replaces BOTH the TypeScript `StreamAccumulator` class AND the Rust
//! `ClaudeOutputAccumulator` / `CodexOutputAccumulator` structs.
//!
//! Responsibilities:
//! - Block-level tracking for Claude streaming (content_block_start/delta/stop)
//! - Codex item.completed synthesis (agent_message + command_execution)
//! - Persistence data collection (turns, session_id, usage, model)
//! - Partial message snapshot generation for the adapter stage

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde_json::Value;

use super::types::{AgentUsage, CollectedTurn, IntermediateMessage, ParsedAgentOutput};

// ---------------------------------------------------------------------------
// Streaming block types (internal)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum StreamingBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
        /// Set to true when content_block_stop arrives.
        done: bool,
    },
    ToolUse {
        tool_use_id: String,
        tool_name: String,
        input_json_text: String,
        parsed_input: Option<Value>,
        status: &'static str,
    },
}

// ---------------------------------------------------------------------------
// StreamAccumulator
// ---------------------------------------------------------------------------

/// Unified stream accumulator for both Claude and Codex providers.
///
/// Tracks block-level streaming state for real-time rendering and collects
/// persistence data (turns, usage, model) for the DB layer in `agents.rs`.
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
            if let Some(model) = extract_claude_model_name(value) {
                self.resolved_model = model;
            }
        }

        let event_type = value.get("type").and_then(Value::as_str);

        match event_type {
            Some("stream_event") => self.handle_stream_event(value),
            Some("tool_progress") => self.handle_tool_progress(value),
            Some("assistant") => self.handle_assistant(value, raw_line),
            Some("user") => self.handle_user(raw_line, value),
            Some("result") => self.handle_result(value, raw_line),
            Some("error") => self.handle_error(raw_line, value),
            Some("item.completed") => self.handle_codex_item_completed(raw_line, value),
            Some("turn.completed") => self.handle_turn_completed(value, raw_line),
            Some("thread.started") | Some("thread.resumed") => {
                if let Some(tid) = value.get("thread_id").and_then(Value::as_str) {
                    self.session_id = Some(tid.to_string());
                }
            }
            _ => {}
        }
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
            Some(self.build_partial_from_blocks(session_id, partial_id, created_at))
        } else {
            let text = self.fallback_text.trim();
            let thinking = self.fallback_thinking.trim();
            if !text.is_empty() || !thinking.is_empty() {
                let (partial_id, created_at) = self.get_or_create_partial_identity(context_key);
                Some(self.build_partial_fallback(session_id, partial_id, created_at))
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
    // Event handlers
    // =====================================================================

    fn handle_stream_event(&mut self, value: &Value) {
        let event = match value.get("event") {
            Some(e) => e,
            None => return,
        };
        let event_type = event.get("type").and_then(Value::as_str);

        match event_type {
            Some("content_block_start") => {
                self.has_block_structure = true;
                self.handle_block_start(event);
            }
            Some("content_block_delta") => {
                if self.has_block_structure {
                    self.handle_block_delta(event);
                } else {
                    self.handle_legacy_delta(event);
                }
            }
            Some("content_block_stop") => {
                self.handle_block_stop(event);
            }
            _ => {
                // Legacy/simple delta format (no eventType, just delta object)
                if let Some(delta) = event.get("delta") {
                    if event_type.is_none() {
                        self.apply_delta(delta);
                    }
                }
            }
        }
    }

    fn handle_block_start(&mut self, event: &Value) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let content_block = match event.get("content_block") {
            Some(cb) => cb,
            None => return,
        };
        let block_type = content_block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("");

        match block_type {
            "text" => {
                self.blocks.insert(
                    index,
                    StreamingBlock::Text {
                        text: String::new(),
                    },
                );
            }
            "thinking" => {
                self.blocks.insert(
                    index,
                    StreamingBlock::Thinking {
                        text: String::new(),
                        done: false,
                    },
                );
            }
            "tool_use" => {
                self.blocks.insert(
                    index,
                    StreamingBlock::ToolUse {
                        tool_use_id: content_block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        tool_name: content_block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string(),
                        input_json_text: String::new(),
                        parsed_input: None,
                        status: "pending",
                    },
                );
            }
            _ => {}
        }
    }

    fn handle_block_delta(&mut self, event: &Value) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let delta = match event.get("delta") {
            Some(d) => d,
            None => return,
        };
        let block = match self.blocks.get_mut(&index) {
            Some(b) => b,
            None => return,
        };
        let delta_type = delta.get("type").and_then(Value::as_str);

        match (block, delta_type) {
            (StreamingBlock::Text { text }, Some("text_delta")) => {
                if let Some(dt) = delta.get("text").and_then(Value::as_str) {
                    text.push_str(dt);
                    // Also accumulate for persistence
                    self.assistant_text.push_str(dt);
                    self.saw_text_delta = true;
                }
            }
            (StreamingBlock::Thinking { text, .. }, Some("thinking_delta")) => {
                if let Some(dt) = delta.get("thinking").and_then(Value::as_str) {
                    text.push_str(dt);
                    self.thinking_text.push_str(dt);
                    self.saw_thinking_delta = true;
                }
            }
            (
                StreamingBlock::ToolUse {
                    input_json_text,
                    status,
                    ..
                },
                Some("input_json_delta"),
            ) => {
                if let Some(pj) = delta.get("partial_json").and_then(Value::as_str) {
                    input_json_text.push_str(pj);
                    *status = "streaming_input";
                }
            }
            _ => {}
        }
    }

    fn handle_block_stop(&mut self, event: &Value) {
        let index = event.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        match self.blocks.get_mut(&index) {
            Some(StreamingBlock::Thinking { done, .. }) => {
                *done = true;
            }
            Some(StreamingBlock::ToolUse {
                input_json_text,
                parsed_input,
                status,
                ..
            }) => {
                if !input_json_text.is_empty() {
                    if let Ok(v) = serde_json::from_str::<Value>(input_json_text) {
                        *parsed_input = Some(v);
                    }
                }
                *status = "running";
            }
            _ => {}
        }
    }

    fn handle_legacy_delta(&mut self, event: &Value) {
        if let Some(delta) = event.get("delta") {
            if let Some(text) = delta.get("text").and_then(Value::as_str) {
                self.fallback_text.push_str(text);
                self.assistant_text.push_str(text);
                self.saw_text_delta = true;
            }
            if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
                self.fallback_thinking.push_str(thinking);
                self.thinking_text.push_str(thinking);
                self.saw_thinking_delta = true;
            }
        }
    }

    fn apply_delta(&mut self, delta: &Value) {
        if let Some(text) = delta.get("text").and_then(Value::as_str) {
            if self.has_block_structure {
                self.append_to_last_text_block(text);
            } else {
                self.fallback_text.push_str(text);
            }
            self.assistant_text.push_str(text);
            self.saw_text_delta = true;
        }
        if let Some(thinking) = delta.get("thinking").and_then(Value::as_str) {
            if self.has_block_structure {
                self.append_to_last_thinking_block(thinking);
            } else {
                self.fallback_thinking.push_str(thinking);
            }
            self.thinking_text.push_str(thinking);
            self.saw_thinking_delta = true;
        }
    }

    fn handle_tool_progress(&mut self, value: &Value) {
        let tool_use_id = match value.get("tool_use_id").and_then(Value::as_str) {
            Some(id) => id,
            None => return,
        };
        for block in self.blocks.values_mut() {
            if let StreamingBlock::ToolUse {
                tool_use_id: id,
                status,
                ..
            } = block
            {
                if id == tool_use_id {
                    *status = "running";
                    break;
                }
            }
        }
    }

    fn handle_assistant(&mut self, value: &Value, raw_line: &str) {
        // === Persistence ===
        if !self.saw_text_delta {
            if let Some(text) = extract_claude_assistant_text(value) {
                self.assistant_text.push_str(&text);
            }
        }
        if !self.saw_thinking_delta {
            if let Some(thinking) = extract_claude_thinking_text(value) {
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

    fn handle_codex_item_completed(&mut self, raw_line: &str, value: &Value) {
        let item = match value.get("item") {
            Some(i) => i,
            None => return,
        };

        let item_type = item.get("type").and_then(Value::as_str);

        if item_type == Some("agent_message") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                if !self.assistant_text.is_empty() {
                    self.assistant_text.push_str("\n\n");
                }
                self.assistant_text.push_str(text);
            }
            // Persistence: push as a turn
            self.turns.push(CollectedTurn {
                role: "assistant".to_string(),
                content_json: raw_line.to_string(),
            });
            // Rendering
            self.collect_message(raw_line, value, "assistant", None);
            return;
        }

        if item_type == Some("command_execution") {
            let command = item.get("command").and_then(Value::as_str).unwrap_or("");
            let output = item.get("output").and_then(Value::as_str).unwrap_or("");
            let exit_code = item.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
            let synthetic_id = format!("codex-cmd-{}", self.line_count);

            // Synthesize tool_use("Bash")
            let synthetic_assistant = serde_json::json!({
                "type": "assistant",
                "message": {
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": synthetic_id,
                        "name": "Bash",
                        "input": {"command": command}
                    }]
                }
            });
            let sa_str = serde_json::to_string(&synthetic_assistant).unwrap_or_default();
            self.collect_message(&sa_str, &synthetic_assistant, "assistant", None);

            // Synthesize tool_result
            let result_content = if exit_code == 0 {
                output.to_string()
            } else {
                format!("Exit code: {exit_code}\n{output}")
            };
            let synthetic_result = serde_json::json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": synthetic_id,
                        "content": result_content
                    }]
                }
            });
            let sr_str = serde_json::to_string(&synthetic_result).unwrap_or_default();
            self.collect_message(&sr_str, &synthetic_result, "user", None);

            // Persistence: push raw line as a turn
            self.turns.push(CollectedTurn {
                role: "assistant".to_string(),
                content_json: raw_line.to_string(),
            });
        }
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
    // Internal helpers
    // =====================================================================

    fn finalize_blocks(&mut self) {
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

    fn collect_message(
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

    fn append_to_last_text_block(&mut self, text: &str) {
        for block in self.blocks.values_mut().rev() {
            if let StreamingBlock::Text { text: t } = block {
                t.push_str(text);
                return;
            }
        }
        // No text block exists — create one
        let idx = self.blocks.len();
        self.blocks.insert(
            idx,
            StreamingBlock::Text {
                text: text.to_string(),
            },
        );
    }

    fn append_to_last_thinking_block(&mut self, text: &str) {
        for block in self.blocks.values_mut().rev() {
            if let StreamingBlock::Thinking { text: t, .. } = block {
                t.push_str(text);
                return;
            }
        }
        let idx = self.blocks.len();
        self.blocks.insert(
            idx,
            StreamingBlock::Thinking {
                text: text.to_string(),
                done: false,
            },
        );
    }

    // =====================================================================
    // Partial message builders
    // =====================================================================

    fn build_partial_from_blocks(
        &self,
        _session_id: &str,
        partial_id: String,
        created_at: String,
    ) -> IntermediateMessage {
        let mut content_blocks = Vec::new();
        for block in self.blocks.values() {
            match block {
                StreamingBlock::Text { text } => {
                    let display = if text.is_empty() {
                        "..."
                    } else {
                        text.as_str()
                    };
                    content_blocks.push(serde_json::json!({"type": "text", "text": display}));
                }
                StreamingBlock::Thinking { text, done } => {
                    if !text.is_empty() {
                        content_blocks.push(serde_json::json!({
                            "type": "thinking",
                            "thinking": text,
                            "__is_streaming": !done,
                        }));
                    }
                }
                StreamingBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    input_json_text,
                    parsed_input,
                    status,
                } => {
                    let input = parsed_input
                        .clone()
                        .unwrap_or_else(|| serde_json::json!({}));
                    content_blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": tool_use_id,
                        "name": tool_name,
                        "input": input,
                        "__streaming_status": status,
                        "__input_json_text": input_json_text,
                    }));
                }
            }
        }

        if content_blocks.is_empty() {
            content_blocks.push(serde_json::json!({"type": "text", "text": "..."}));
        }

        let parsed = serde_json::json!({
            "type": "assistant",
            "message": {
                "type": "message",
                "role": "assistant",
                "content": content_blocks,
            },
            "__streaming": true,
        });

        IntermediateMessage {
            id: partial_id,
            role: "assistant".to_string(),
            raw_json: serde_json::to_string(&parsed).unwrap_or_default(),
            parsed: Some(parsed),
            created_at,
            is_streaming: true,
        }
    }

    fn build_partial_fallback(
        &self,
        _session_id: &str,
        partial_id: String,
        created_at: String,
    ) -> IntermediateMessage {
        let text = self.fallback_text.trim();
        let thinking = self.fallback_thinking.trim();
        let display_text = if text.is_empty() { "..." } else { text };

        let parsed = if !thinking.is_empty() {
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": thinking},
                        {"type": "text", "text": display_text},
                    ],
                },
                "__streaming": true,
            })
        } else {
            serde_json::json!({
                "type": "assistant",
                "message": {
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": display_text},
                    ],
                },
                "__streaming": true,
            })
        };

        IntermediateMessage {
            id: partial_id,
            role: "assistant".to_string(),
            raw_json: serde_json::to_string(&parsed).unwrap_or_default(),
            parsed: Some(parsed),
            created_at,
            is_streaming: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Claude text extraction helpers (moved from agents.rs)
// ---------------------------------------------------------------------------

fn extract_claude_model_name(value: &Value) -> Option<String> {
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        return Some(model.to_string());
    }
    if let Some(model) = value
        .get("message")
        .and_then(|m| m.get("model"))
        .and_then(Value::as_str)
    {
        return Some(model.to_string());
    }
    if let Some(model) = value
        .get("model")
        .and_then(|m| m.get("display_name"))
        .and_then(Value::as_str)
    {
        return Some(model.to_string());
    }
    None
}

fn extract_claude_assistant_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)?;
    let text: String = content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}

fn extract_claude_thinking_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)?;
    let text: String = content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("thinking") {
                block.get("thinking").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.trim().is_empty()).then_some(text)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accumulate_text_deltas() {
        let mut acc = StreamAccumulator::new("claude", "opus");
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "Hello"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": " world"}
                }
            }),
            "",
        );

        let snapshot = acc.snapshot("ctx", "sess");
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].is_streaming);
        let parsed = snapshot[0].parsed.as_ref().unwrap();
        let text = parsed["message"]["content"][0]["text"].as_str().unwrap();
        assert_eq!(text, "Hello world");
    }

    #[test]
    fn accumulate_tool_use_blocks() {
        let mut acc = StreamAccumulator::new("claude", "opus");
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "tc1", "name": "read"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": "{\"file_path\""}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": ": \"/a.txt\"}"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {"type": "content_block_stop", "index": 0}
            }),
            "",
        );

        let snapshot = acc.snapshot("ctx", "sess");
        assert_eq!(snapshot.len(), 1);
        let parsed = snapshot[0].parsed.as_ref().unwrap();
        let block = &parsed["message"]["content"][0];
        assert_eq!(block["name"].as_str().unwrap(), "read");
        assert_eq!(block["__streaming_status"].as_str().unwrap(), "running");
    }

    #[test]
    fn full_assistant_clears_blocks() {
        let mut acc = StreamAccumulator::new("claude", "opus");
        // Add a text block
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "hello"}
                }
            }),
            "",
        );

        // Full assistant message arrives — should clear blocks
        let full_msg = json!({
            "type": "assistant",
            "message": {
                "id": "msg1",
                "role": "assistant",
                "content": [{"type": "text", "text": "hello"}]
            }
        });
        let raw = serde_json::to_string(&full_msg).unwrap();
        acc.push_event(&full_msg, &raw);

        let snapshot = acc.snapshot("ctx", "sess");
        // Should have the collected full message, no streaming partial
        assert_eq!(snapshot.len(), 1);
        assert!(!snapshot[0].is_streaming);
    }

    #[test]
    fn codex_command_execution_synthesis() {
        let mut acc = StreamAccumulator::new("codex", "gpt-5.4");
        let event = json!({
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "command": "ls -la",
                "output": "file1.txt\nfile2.txt",
                "exit_code": 0
            }
        });
        let raw = serde_json::to_string(&event).unwrap();
        acc.push_event(&event, &raw);

        let snapshot = acc.snapshot("ctx", "sess");
        // Should have synthetic assistant (tool_use) + user (tool_result)
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0].role, "assistant");
        assert_eq!(snapshot[1].role, "user");
    }

    #[test]
    fn partial_identity_stays_stable_across_deltas() {
        let mut acc = StreamAccumulator::new("claude", "opus");
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": "{\"command\":\"ls\""}
                }
            }),
            "",
        );

        let first = acc.snapshot("ctx", "sess").pop().unwrap();

        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "input_json_delta", "partial_json": ",\"cwd\":\"/tmp\"}"}
                }
            }),
            "",
        );

        let second = acc.snapshot("ctx", "sess").pop().unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(first.created_at, second.created_at);
    }

    #[test]
    fn finalized_assistant_reuses_partial_id() {
        let mut acc = StreamAccumulator::new("claude", "opus");
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "tool_use", "id": "tool-1", "name": "Bash"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": "{\"command\":\"git status --short\"}"
                    }
                }
            }),
            "",
        );

        let partial_id = acc.snapshot("ctx", "sess").pop().unwrap().id;
        let full_msg = json!({
            "type": "assistant",
            "message": {
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tool-1",
                    "name": "Bash",
                    "input": {"command": "git status --short"}
                }]
            }
        });
        let raw = serde_json::to_string(&full_msg).unwrap();
        acc.push_event(&full_msg, &raw);

        let snapshot = acc.snapshot("ctx", "sess");
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].id, partial_id);
    }

    #[test]
    fn fallback_delta_accumulation() {
        let mut acc = StreamAccumulator::new("claude", "opus");
        // Legacy delta without block structure
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "delta": {"text": "Hello", "thinking": "hmm"}
                }
            }),
            "",
        );
        acc.push_event(
            &json!({
                "type": "stream_event",
                "event": {
                    "delta": {"text": " world"}
                }
            }),
            "",
        );

        let snapshot = acc.snapshot("ctx", "sess");
        assert_eq!(snapshot.len(), 1);
        assert!(snapshot[0].is_streaming);
        let parsed = snapshot[0].parsed.as_ref().unwrap();
        // Should have thinking + text blocks
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
    }

    /// Regression for the "final assistant turn lost on stream end" bug.
    ///
    /// `handle_assistant` does NOT push to `self.turns` directly — it stages
    /// the message into `cur_asst_*` and only flushes when (a) the next
    /// assistant has a different msg_id, (b) a user/tool_result event
    /// arrives, or (c) `flush_assistant` is called explicitly.
    ///
    /// In a typical Claude session the **final** assistant turn never hits
    /// any of those triggers — it's followed by a `result` event and then
    /// the stream `end`. Until this fix, agents.rs read `turns_len()`
    /// BEFORE calling `finish_output(mut self)`, so the staged final
    /// assistant turn was missed; the subsequent `flush_assistant` inside
    /// `finish_output` happened on a `self` that was about to be consumed,
    /// so the freshly-pushed turn was unreachable to the persistence loop.
    ///
    /// This test pins the contract that finish_output makes the final
    /// assistant turn observable on the still-alive accumulator.
    #[test]
    fn finish_output_flushes_final_assistant_into_turns() {
        let mut acc = StreamAccumulator::new("claude", "opus");

        // 1. A complete tool_use turn — this one DOES get flushed at the
        //    moment the next assistant arrives, because the next assistant
        //    has a different msg_id. Mirrors a typical "Claude calls a
        //    tool, gets the result, then writes a final reply" sequence.
        let asst_with_tool = json!({
            "type": "assistant",
            "message": {
                "id": "msg_tool",
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "t1",
                    "name": "Read",
                    "input": {"file_path": "/x"}
                }]
            }
        });
        acc.push_event(&asst_with_tool, &asst_with_tool.to_string());

        // 2. A user tool_result — flushes the previous assistant into turns.
        let user_tool_result = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "t1",
                    "content": "file contents"
                }]
            }
        });
        acc.push_event(&user_tool_result, &user_tool_result.to_string());

        // After step 2: tool turn + user turn = 2 turns
        assert_eq!(
            acc.turns_len(),
            2,
            "tool_use assistant + tool_result user should both be flushed"
        );

        // 3. The final assistant reply with text + thinking blocks.
        //    Stays staged in cur_asst_* — NO flush trigger fires for it.
        let asst_final = json!({
            "type": "assistant",
            "message": {
                "id": "msg_final",
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "let me summarize"},
                    {"type": "text", "text": "Here's the answer."}
                ]
            }
        });
        acc.push_event(&asst_final, &asst_final.to_string());

        // 4. result event — does NOT flush.
        let result = json!({
            "type": "result",
            "subtype": "success",
            "result": "Here's the answer.",
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });
        acc.push_event(&result, &result.to_string());

        // Pre-finalize state: the final assistant turn is still staged,
        // turns_len() reports only the 2 already-flushed turns.
        assert_eq!(
            acc.turns_len(),
            2,
            "final assistant turn should still be staged in cur_asst_*"
        );

        // The fix: finish_output must flush the staged turn AND leave the
        // accumulator alive so the caller can read it.
        let output = acc
            .finish_output(Some("sess-xyz"))
            .expect("finish_output should succeed");

        // Post-finalize: the staged turn is now in self.turns, observable
        // on the SAME accumulator instance the caller still owns.
        assert_eq!(
            acc.turns_len(),
            3,
            "finish_output should flush the staged final assistant into self.turns"
        );

        // The flushed turn is the final assistant message, with both
        // thinking and text blocks intact.
        let final_turn = acc.turn_at(2);
        assert_eq!(final_turn.role, "assistant");
        let parsed: serde_json::Value = serde_json::from_str(&final_turn.content_json).unwrap();
        let blocks = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(
            blocks.len(),
            2,
            "final turn should preserve both thinking and text blocks"
        );
        assert_eq!(blocks[0]["type"].as_str(), Some("thinking"));
        assert_eq!(blocks[1]["type"].as_str(), Some("text"));
        assert_eq!(blocks[1]["text"].as_str(), Some("Here's the answer."));

        // ParsedAgentOutput should also expose the assistant text.
        assert!(output.assistant_text.contains("Here's the answer."));
    }

    /// Regression for the "thinking blocks silently dropped" bug.
    ///
    /// The Claude SDK delivers each finalized content block as its OWN
    /// `assistant` event with the same `msg_id` — i.e., delta-style, not
    /// cumulative snapshot. The buggy code in `handle_assistant` did
    /// `cur_asst_blocks = blocks.clone()` on every event, which clobbered
    /// any prior block of the same turn.
    ///
    /// In production this manifested as: every `thinking` block immediately
    /// followed by a `tool_use` (or `text`) block of the same msg_id was
    /// silently dropped before persistence. DB inspection from 2026-04
    /// onward showed zero `thinking`-containing assistant rows in any
    /// post-migration session.
    ///
    /// Fix: when the new event has the same `msg_id` as the currently
    /// batching turn, append blocks to `cur_asst_blocks` instead of
    /// replacing them. This test pins the contract.
    #[test]
    fn delta_assistant_events_with_same_msg_id_append_blocks() {
        let mut acc = StreamAccumulator::new("claude", "opus");

        // Mirror the real Claude SDK pattern: thinking → tool_use → tool_result.
        // Both assistant events share the same msg_id; each contains a
        // single delta block.
        let asst_thinking = json!({
            "type": "assistant",
            "message": {
                "id": "msg_shared",
                "role": "assistant",
                "content": [{
                    "type": "thinking",
                    "thinking": "Let me read the file first."
                }]
            }
        });
        acc.push_event(&asst_thinking, &asst_thinking.to_string());

        let asst_tool = json!({
            "type": "assistant",
            "message": {
                "id": "msg_shared",
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "tool_1",
                    "name": "Read",
                    "input": {"file_path": "/x"}
                }]
            }
        });
        acc.push_event(&asst_tool, &asst_tool.to_string());

        // tool_result triggers the flush of the batched assistant turn.
        let user_tool_result = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "tool_1",
                    "content": "file contents"
                }]
            }
        });
        acc.push_event(&user_tool_result, &user_tool_result.to_string());

        // After flush: 1 assistant turn + 1 user turn = 2.
        assert_eq!(acc.turns_len(), 2);

        // The flushed assistant turn must contain BOTH the thinking AND
        // the tool_use blocks. Buggy code dropped the thinking entirely,
        // persisting only [tool_use].
        let asst_turn = acc.turn_at(0);
        assert_eq!(asst_turn.role, "assistant");
        let parsed: serde_json::Value = serde_json::from_str(&asst_turn.content_json).unwrap();
        let blocks = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(
            blocks.len(),
            2,
            "delta-style same-msg_id events should be merged into one turn with both blocks"
        );
        assert_eq!(blocks[0]["type"].as_str(), Some("thinking"));
        assert_eq!(blocks[1]["type"].as_str(), Some("tool_use"));
        assert_eq!(
            blocks[0]["thinking"].as_str(),
            Some("Let me read the file first.")
        );
        assert_eq!(blocks[1]["id"].as_str(), Some("tool_1"));
    }

    /// Different msg_id should still REPLACE, not append. Pins the boundary
    /// case so a future "always append" mistake gets caught.
    #[test]
    fn delta_assistant_events_with_different_msg_id_flush_then_replace() {
        let mut acc = StreamAccumulator::new("claude", "opus");

        let asst_a = json!({
            "type": "assistant",
            "message": {
                "id": "msg_A",
                "role": "assistant",
                "content": [{"type": "text", "text": "first turn"}]
            }
        });
        acc.push_event(&asst_a, &asst_a.to_string());

        // Different msg_id triggers flush of msg_A first, then starts msg_B fresh.
        let asst_b = json!({
            "type": "assistant",
            "message": {
                "id": "msg_B",
                "role": "assistant",
                "content": [{"type": "text", "text": "second turn"}]
            }
        });
        acc.push_event(&asst_b, &asst_b.to_string());

        // msg_A flushed → 1 turn so far. msg_B is still staged.
        assert_eq!(acc.turns_len(), 1);
        let first_turn: serde_json::Value =
            serde_json::from_str(&acc.turn_at(0).content_json).unwrap();
        assert_eq!(first_turn["message"]["id"].as_str(), Some("msg_A"));
        let first_blocks = first_turn["message"]["content"].as_array().unwrap();
        assert_eq!(first_blocks.len(), 1);
        assert_eq!(first_blocks[0]["text"].as_str(), Some("first turn"));

        // finish_output flushes msg_B into turns.
        acc.finish_output(None).unwrap();
        assert_eq!(acc.turns_len(), 2);
        let second_turn: serde_json::Value =
            serde_json::from_str(&acc.turn_at(1).content_json).unwrap();
        assert_eq!(second_turn["message"]["id"].as_str(), Some("msg_B"));
        let second_blocks = second_turn["message"]["content"].as_array().unwrap();
        assert_eq!(second_blocks.len(), 1);
        assert_eq!(second_blocks[0]["text"].as_str(), Some("second turn"));
    }
}
