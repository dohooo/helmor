//! Shared types for the message pipeline.
//!
//! Defines both the **output types** serialized to the frontend (ThreadMessageLike,
//! MessagePart, CollapsedGroupPart, etc.) and **internal types** used between
//! pipeline stages (IntermediateMessage, CollectedTurn, HistoricalRecord).

use std::fmt;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Output types — serialized to the frontend via Tauri IPC
// ---------------------------------------------------------------------------

/// Top-level message role. Values:
/// - `User` / `Assistant`: the two canonical conversation roles (both stored
///   in DB and emitted to frontend).
/// - `System`: synthesised by the adapter for pipeline-internal events
///   (rate-limit notices, prompt suggestions, error placeholders). Emitted
///   to frontend but never persisted to `session_messages.role`.
/// - `Error`: **persistence-only**. Stored when a tool-call or turn crashes
///   so the UI can replay the failure after reload. The adapter converts
///   `Error` rows into a `System` `ThreadMessageLike` at render time, so
///   frontend components never see this variant in practice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    Assistant,
    System,
    User,
    Error,
}

impl MessageRole {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Assistant => "assistant",
            Self::System => "system",
            Self::User => "user",
            Self::Error => "error",
        }
    }
}

impl fmt::Display for MessageRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct UnknownMessageRole(pub String);

impl fmt::Display for UnknownMessageRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown message role: {:?}", self.0)
    }
}

impl std::error::Error for UnknownMessageRole {}

impl FromStr for MessageRole {
    type Err = UnknownMessageRole;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "assistant" => Ok(Self::Assistant),
            "system" => Ok(Self::System),
            "user" => Ok(Self::User),
            "error" => Ok(Self::Error),
            _ => Err(UnknownMessageRole(s.to_string())),
        }
    }
}

impl FromSql for MessageRole {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value
            .as_str()?
            .parse()
            .map_err(|e: UnknownMessageRole| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for MessageRole {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
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
///
/// Every variant carries a stable `id` the frontend uses as the React key.
/// `ToolCall` reuses its SDK-assigned `tool_call_id` (no separate `id` field);
/// all others carry their own `id`. The `part_id()` accessor hides the
/// difference so callers that just need "the key for this part" don't branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessagePart {
    /// Plain text block.
    #[serde(rename = "text")]
    Text { id: String, text: String },

    /// Extended thinking / reasoning block.
    #[serde(rename = "reasoning")]
    Reasoning {
        id: String,
        text: String,
        /// Live state: `Some(true)` active, `Some(false)` just finished in
        /// this session, `None` historical / unknown. Only partials and the
        /// live handler on `handle_assistant` set this; persistence strips it.
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming: Option<bool>,
        /// Backend-measured duration in ms for a completed block, persisted
        /// so "Thought for Ns" also survives a reload.
        #[serde(skip_serializing_if = "Option::is_none", rename = "durationMs")]
        duration_ms: Option<u64>,
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
        /// Only `Some(true)`; success cases collapse to None.
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
        /// Streaming execution progress indicator.
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming_status: Option<StreamingStatus>,
        /// Sub-agent work folded in by `grouping::group_child_messages`.
        /// Only `Task` / `Agent` tool calls populate this; everything else
        /// leaves it empty and `skip_serializing_if = "Vec::is_empty"`
        /// keeps the JSON shape unchanged for non-subagent tool calls.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        children: Vec<ExtendedMessagePart>,
    },

    /// Inline notice from the SDK (rate limit, status update, etc.) — a
    /// single-part system message that the frontend renders as a
    /// styled banner.
    #[serde(rename = "system-notice", rename_all = "camelCase")]
    SystemNotice {
        id: String,
        severity: NoticeSeverity,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
    },

    /// Unified todo-list block. Both Claude (`TodoWrite` tool_use) and
    /// Codex (`item.completed` of `todo_list`) collapse into this single
    /// shape so the frontend renders identically across providers.
    #[serde(rename = "todo-list", rename_all = "camelCase")]
    TodoList { id: String, items: Vec<TodoItem> },

    /// Inline image emitted as a content block by the Claude SDK. The
    /// payload is either a base64-encoded blob (with media type) or an
    /// external URL — the frontend renders both with `<img>`.
    #[serde(rename = "image", rename_all = "camelCase")]
    Image {
        id: String,
        source: ImageSource,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
    },

    /// Pre-canned prompt the Claude SDK suggests to the user. Rendered
    /// as a clickable chip — clicking copies the suggestion into the
    /// composer.
    #[serde(rename = "prompt-suggestion", rename_all = "camelCase")]
    PromptSuggestion { id: String, text: String },

    /// Persisted ExitPlanMode review card. The plan itself needs to live in
    /// the chat thread so users can revisit it later even after the deferred
    /// interaction state is gone.
    #[serde(rename = "plan-review", rename_all = "camelCase")]
    PlanReview {
        tool_use_id: String,
        tool_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        plan_file_path: Option<String>,
        #[serde(default)]
        allowed_prompts: Vec<PlanAllowedPrompt>,
    },

    /// Inline file reference from the composer's @-mention picker.
    #[serde(rename = "file-mention", rename_all = "camelCase")]
    FileMention { id: String, path: String },
}

impl MessagePart {
    /// Stable id used as the React key for this part. Delegates to the
    /// variant's natural id field (`tool_call_id` for ToolCall,
    /// `tool_use_id` for PlanReview, `id` for everything else).
    pub fn part_id(&self) -> &str {
        match self {
            Self::Text { id, .. }
            | Self::Reasoning { id, .. }
            | Self::SystemNotice { id, .. }
            | Self::TodoList { id, .. }
            | Self::Image { id, .. }
            | Self::PromptSuggestion { id, .. }
            | Self::FileMention { id, .. } => id,
            Self::ToolCall { tool_call_id, .. } => tool_call_id,
            Self::PlanReview { tool_use_id, .. } => tool_use_id,
        }
    }
}

/// Image payload variants. `Base64` carries the raw blob (no `data:` URI
/// prefix); the frontend reconstructs the data URL using `media_type`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImageSource {
    Base64 { data: String },
    Url { url: String },
    File { path: String },
}

/// Severity tier for `MessagePart::SystemNotice`. The frontend picks the
/// banner color and icon from this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoticeSeverity {
    Info,
    Warning,
    Error,
}

/// Single row inside a `MessagePart::TodoList`. Both providers' source
/// shapes (Claude `{content, status}`, Codex `{text, completed}`) are
/// normalized to this struct in the adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

/// Explicit tool prompts Claude pre-approved while presenting a plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAllowedPrompt {
    pub tool: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

/// Category for a collapsed group of tool calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollapseCategory {
    Search,
    Read,
    /// Read-only shell commands executed via Bash/Run tools.
    Shell,
    Mixed,
}

/// A collapsed summary replacing consecutive search/read tool calls.
///
/// `id` is derived from the first tool's `tool_call_id` (`group:{first_id}`)
/// so the React key stays stable across renders — the tool IDs don't change
/// as the group gains members during streaming, so the first-tool-derived
/// id doesn't either.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollapsedGroupPart {
    /// Always serialized as `"collapsed-group"`.
    #[serde(rename = "type")]
    pub part_type: String,
    pub id: String,
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
        let id = tools
            .first()
            .map(|t| format!("group:{}", t.part_id()))
            .unwrap_or_else(|| "group:empty".to_string());
        Self {
            part_type: "collapsed-group".to_string(),
            id,
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

impl ExtendedMessagePart {
    /// Stable id for this part. Matches `MessagePart::part_id` for `Basic`
    /// and the group's own `id` for `CollapsedGroup`.
    pub fn part_id(&self) -> &str {
        match self {
            Self::Basic(part) => part.part_id(),
            Self::CollapsedGroup(group) => &group.id,
        }
    }
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
    pub role: MessageRole,
    pub raw_json: String,
    pub parsed: Option<Value>,
    pub created_at: String,
    pub is_streaming: bool,
}

/// A single turn collected from the CLI stream output, used for DB persistence.
///
/// Moved here from `agents.rs` so that the pipeline accumulator and the
/// persistence logic in `agents.rs` share the same type.
///
/// The `id` is the DB row key AND the id attached to the matching
/// `IntermediateMessage` in `collected[]` — they're assigned in lockstep
/// at turn creation so the frontend sees one stable id from the first
/// streaming partial through DB commit.
#[derive(Debug, Clone)]
pub struct CollectedTurn {
    pub id: String,
    pub role: MessageRole,
    pub content_json: String,
}

/// Input record for converting historical (DB-persisted) messages through
/// the adapter pipeline. Mirrors the subset of DB fields needed for rendering.
///
/// `parsed_content` is always populated when the row holds valid JSON. After
/// the user_prompt migration the `content` column is JSON-only, so the only
/// way `parsed_content` can be `None` is a corrupted row — the adapter falls
/// back to a system "Event" placeholder in that case.
#[derive(Debug, Clone)]
pub struct HistoricalRecord {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
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
