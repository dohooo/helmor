//! Shared types crossing the IM-backend boundary.
//!
//! Both `ImConversation` and `ImMessage` use a `raw: serde_json::Value`
//! escape hatch. The generic `ImFetcher` never touches `raw` — it just
//! hands it back to the backend on subsequent calls. That lets us model
//! Slack channels, Lark p2p chats, Dingtalk groups, … through one struct
//! without exploding into associated types (which trait-object usage
//! would have to navigate).

use chrono::{DateTime, Utc};
use serde_json::Value;

/// Coarse classification surfaced to the LLM via `triage_candidate.source_kind`.
/// Backends map their platform-native types into one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImConversationKind {
    /// 1:1 direct message.
    Dm,
    /// Multi-party direct message (Slack MPIM, WeChat group ≤ ~8 people).
    GroupDm,
    /// Open / public channel (Slack `#eng`, Lark public group).
    Channel,
    /// Invite-only channel (Slack private channel, Lark internal group).
    PrivateChannel,
}

impl ImConversationKind {
    /// String the storage layer stores in `source_kind`. Stable contract —
    /// don't rename without a migration.
    pub fn as_source_kind(self) -> &'static str {
        match self {
            ImConversationKind::Dm => "dm",
            ImConversationKind::GroupDm => "group_dm",
            ImConversationKind::Channel => "channel",
            ImConversationKind::PrivateChannel => "private_channel",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ImConversation {
    /// Backend-stable id used as `triage_fetch_cursor.source_parent` and
    /// the cache-path segment. Must be unique within a backend.
    pub id: String,
    /// Human-readable label for subscription rows and rendered headers.
    pub label: Option<String>,
    pub kind: ImConversationKind,
    /// Opaque backend payload. ImFetcher never reads it; backend pulls it
    /// out in `fetch_messages` / `render_payload` if it needs extras.
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct ImMessage {
    /// Backend-stable message id (Lark `om_…`, Slack `ts`, etc.).
    /// Unique within the backend so we can build `source_ref` from it
    /// directly.
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub sender: Option<String>,
    /// Already-resolved human-readable body (mentions expanded to display
    /// names, blocks walked, etc.). Backends do the platform-specific
    /// extraction so the generic renderer sees one shape.
    pub text: String,
    pub external_url: Option<String>,
    /// Whether the upstream marked this message deleted/tombstoned.
    /// Fetcher skips these so we don't fill the candidate table with
    /// ghost rows.
    pub deleted: bool,
    pub raw: Value,
}
