//! Shared types for IM backends; `raw: Value` is the per-backend escape hatch (ImFetcher never reads it).

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
    /// Backend-stable id; cursor + cache-path key.
    pub id: String,
    /// Human-readable label for subscription rows and rendered headers.
    pub label: Option<String>,
    pub kind: ImConversationKind,
    /// Opaque backend payload.
    pub raw: Value,
}

#[derive(Debug, Clone)]
pub struct ImMessage {
    /// Backend-stable message id (Lark `om_…`, Slack `ts`).
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub sender: Option<String>,
    /// Display-ready body (mentions resolved, blocks walked).
    pub text: String,
    pub external_url: Option<String>,
    /// Upstream tombstone — fetcher skips.
    pub deleted: bool,
    /// Attachments fetched alongside this message (images, files).
    /// Empty when there are none.
    pub attachments: Vec<ImAttachment>,
    pub raw: Value,
}

/// One downloaded attachment associated with an `ImMessage`. Path is
/// inside the per-candidate staging dir; absolute on disk.
#[derive(Debug, Clone)]
pub struct ImAttachment {
    /// Filename inside the staging dir.
    pub filename: String,
    /// Absolute path on disk (under `staging_dir(source, candidate_id)`).
    pub local_path: std::path::PathBuf,
    /// MIME guess (`image/png` etc.) — `None` for non-images.
    pub mime_type: Option<String>,
    /// File size in bytes.
    pub bytes: u64,
    /// Display label (alt text). Backend-specific (image_key, file name).
    pub alt: Option<String>,
}
