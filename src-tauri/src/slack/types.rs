//! Wire shapes shared across the Slack module.
//!
//! Everything that crosses the IPC boundary is `#[serde(rename_all = "camelCase")]`
//! so it matches the TypeScript counterparts in `src/lib/api.ts` directly.

use serde::{Deserialize, Serialize};

/// Connected Slack workspace metadata. Stored in the `slack_workspaces`
/// table; the matching token + cookie live in the keychain, keyed by
/// `team_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackWorkspace {
    pub team_id: String,
    pub team_name: String,
    pub team_domain: String,
    pub my_user_id: String,
    /// Wall-clock seconds since UNIX epoch. Drives the "Connected on …"
    /// label in Settings if/when we add one — v1 stores it but does not
    /// surface it.
    pub added_at: i64,
}

/// One row in the Slack Activity feed.
///
/// Two kinds in v1: an `@me` mention (always a single message, may belong
/// to a thread) or an unread DM/MPIM with a "latest snippet". Reactions /
/// thread replies are NOT pre-fetched — we leave those for the detail
/// view to lazy-load.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackInboxItem {
    /// Stable id for React keys. `<team_id>:<channel_id>:<ts>`.
    pub id: String,
    pub team_id: String,
    pub channel_id: String,
    /// User-facing channel name (`#eng-frontend`) or DM partner name
    /// ("Devin"). Resolved server-side so the frontend can render without
    /// extra IPC calls.
    pub channel_label: String,
    pub kind: SlackInboxItemKind,
    /// Slack message ts (`"1700000000.123456"`). Doubles as the message's
    /// permanent id within its channel.
    pub ts: String,
    /// Parent thread ts, when this message lives in a thread. Drives the
    /// detail view's choice between `conversations.replies` (thread) and
    /// `conversations.history` (single message context).
    pub thread_ts: Option<String>,
    /// Sender display name. `users.info` is called lazily and cached;
    /// when the cache misses we fall back to the raw user id.
    pub author_name: String,
    /// Sender avatar (`image_72` from users.info), if resolvable. `None`
    /// when the user lookup misses or the workspace strips profile
    /// images. The frontend falls back to initials.
    pub author_avatar_url: Option<String>,
    /// First ~280 chars of the message body. Slack mrkdwn is left
    /// as-is — the detail view does the real markdown rendering.
    pub text_snippet: String,
    /// Slack message ts converted to milliseconds. Drives the relative
    /// "4h ago" label and sort order.
    pub ts_millis: i64,
    /// Stable Slack deep link, opens the desktop client to this message.
    pub permalink: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlackInboxItemKind {
    /// `@me` mention — `search.messages` hit.
    Mention,
    /// Latest message in an unread DM or group DM.
    DirectMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackInboxPage {
    pub items: Vec<SlackInboxItem>,
    /// Opaque cursor for the NEXT page. `None` = end of feed reached.
    /// V1 just paginates the search.messages stream — DM snippets fit on
    /// page 1 and don't paginate further.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackThreadDetail {
    pub team_id: String,
    pub channel_id: String,
    pub channel_label: String,
    /// Whether this is a real thread (`conversations.replies`) or a
    /// best-effort context window (`conversations.history`) around a
    /// single message.
    pub is_thread: bool,
    pub messages: Vec<SlackMessage>,
    pub permalink: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMessage {
    pub ts: String,
    pub user_id: Option<String>,
    pub author_name: String,
    pub author_avatar_url: Option<String>,
    /// Raw Slack mrkdwn. Rendering left to the frontend (Streamdown).
    pub text: String,
    pub ts_millis: i64,
    pub reactions: Vec<SlackReactionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackReactionSummary {
    pub name: String,
    pub count: u32,
}
