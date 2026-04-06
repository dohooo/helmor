//! Shared types for the message pipeline.
//!
//! Defines both the **output types** serialized to the frontend (ThreadMessageLike,
//! MessagePart, CollapsedGroupPart, etc.) and **internal types** used between
//! pipeline stages (IntermediateMessage, CollectedTurn, HistoricalRecord).

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Output types — serialized to the frontend via Tauri IPC
// ---------------------------------------------------------------------------

/// Top-level message role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    Assistant,
    System,
    User,
}

/// Streaming progress for a tool-call part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamingStatus {
    Pending,
    StreamingInput,
    Running,
    Done,
    Error,
}

/// A single content part inside a message.
///
/// Serialized as internally tagged `{"type": "text", ...}`, `{"type": "tool-call", ...}`, etc.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessagePart {
    /// Plain text block.
    #[serde(rename = "text")]
    Text { text: String },

    /// Extended thinking / reasoning block.
    #[serde(rename = "reasoning")]
    Reasoning {
        text: String,
        /// Per-part streaming state — only the active thinking block is streaming.
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming: Option<bool>,
    },

    /// Tool invocation with optional result.
    #[serde(rename = "tool-call", rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        /// Structured args (may be empty object during streaming).
        args: Value,
        /// Stringified args for display.
        args_text: String,
        /// Tool execution result (set when user tool_result is merged back).
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        /// Streaming execution progress indicator.
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming_status: Option<StreamingStatus>,
    },
}

/// Category for a collapsed group of tool calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollapseCategory {
    Search,
    Read,
    Mixed,
}

/// A collapsed summary replacing consecutive search/read tool calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollapsedGroupPart {
    /// Always serialized as `"collapsed-group"`.
    #[serde(rename = "type")]
    pub part_type: String,
    /// Whether this group contains search, read, or both.
    pub category: CollapseCategory,
    /// The original tool-call parts in this group.
    pub tools: Vec<MessagePart>,
    /// Whether the last tool in the group is still executing.
    pub active: bool,
    /// Human-readable summary, e.g. "Searched for 'foo' (2×), read 3 files".
    pub summary: String,
}

impl CollapsedGroupPart {
    pub fn new(
        category: CollapseCategory,
        tools: Vec<MessagePart>,
        active: bool,
        summary: String,
    ) -> Self {
        Self {
            part_type: "collapsed-group".to_string(),
            category,
            tools,
            active,
            summary,
        }
    }
}

/// A content part that is either a basic MessagePart or a CollapsedGroupPart.
///
/// Uses `#[serde(untagged)]` so the JSON representation is flat:
/// basic parts keep their `{"type":"text",...}` shape while collapsed groups
/// have `{"type":"collapsed-group",...}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExtendedMessagePart {
    Basic(MessagePart),
    CollapsedGroup(CollapsedGroupPart),
}

/// Completion status of a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageStatus {
    /// Status type, e.g. "complete", "incomplete".
    #[serde(rename = "type")]
    pub status_type: String,
    /// Optional reason, e.g. "stop", "end_turn".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A fully rendered message ready for the frontend to display.
///
/// This is the final output of the pipeline — the frontend performs
/// zero parsing and passes this directly to rendering components.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessageLike {
    pub role: MessageRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub content: Vec<ExtendedMessagePart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<MessageStatus>,
    /// True when this message is still being streamed from an agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
}

// ---------------------------------------------------------------------------
// Internal types — used between pipeline stages, not serialized to frontend
// ---------------------------------------------------------------------------

/// Lightweight intermediate message produced by the accumulator,
/// consumed by the adapter. Does not leak to the frontend.
#[derive(Debug, Clone)]
pub struct IntermediateMessage {
    pub id: String,
    pub role: String,
    pub raw_json: String,
    pub parsed: Option<Value>,
    pub created_at: String,
    pub is_streaming: bool,
}

/// A single turn collected from the CLI stream output, used for DB persistence.
///
/// Moved here from `agents.rs` so that the pipeline accumulator and the
/// persistence logic in `agents.rs` share the same type.
#[derive(Debug, Clone)]
pub struct CollectedTurn {
    pub role: String,
    pub content_json: String,
}

/// Input record for converting historical (DB-persisted) messages through
/// the adapter pipeline.  Mirrors the DB row shape without pulling in the
/// full `SessionMessageRecord` type.
#[derive(Debug, Clone)]
pub struct HistoricalRecord {
    pub id: String,
    pub role: String,
    pub content: String,
    pub content_is_json: bool,
    pub parsed_content: Option<Value>,
    pub created_at: String,
}

/// Token usage counters from an agent invocation.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
}

/// Full parsed output from a CLI invocation (used at stream finalization).
#[derive(Debug)]
pub struct ParsedAgentOutput {
    pub assistant_text: String,
    pub thinking_text: Option<String>,
    pub session_id: Option<String>,
    pub resolved_model: String,
    pub usage: AgentUsage,
    pub result_json: Option<String>,
}
