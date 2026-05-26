//! Slack ImBackend.
//!
//! Discovery follows the same rule the Lark backend enforces:
//!   - DMs (im) and group-DMs (mpim) → always included; the ingest
//!     step decides whether they actually have recent activity.
//!   - public / private channels → only when there's a clear "I'm
//!     involved here" signal in the last `COLD_START_DAYS`:
//!     * I posted in the channel  (search: `from:<@me> after:…`)
//!     * I was @ed in the channel (search: `<@me> after:…`)
//!       A busy channel I'm a passive member of doesn't earn a slot.
//!
//! Per-conversation pull uses `conversations.history` with a
//! Slack-format `oldest` ts derived from the cursor.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use serde_json::json;

use crate::models::slack_workspaces;
use crate::slack::api::{self, ConversationRow, RawMessage};
use crate::slack::credentials::{self, SlackCreds};
use crate::slack::types::SlackWorkspace;

use super::types::{ImConversation, ImConversationKind, ImMessage};
use super::ImBackend;

const SOURCE: &str = "slack";

pub struct SlackBackend;

impl ImBackend for SlackBackend {
    fn source(&self) -> &'static str {
        SOURCE
    }

    fn preflight(&self) -> Result<()> {
        let workspaces = slack_workspaces::list_workspaces().context("list slack workspaces")?;
        if workspaces.is_empty() {
            anyhow::bail!("no Slack workspace connected");
        }
        Ok(())
    }

    fn discover_conversations(&self, _limit: usize) -> Result<Vec<ImConversation>> {
        let workspaces = slack_workspaces::list_workspaces()?;
        let mut out: Vec<ImConversation> = Vec::new();
        for ws in &workspaces {
            let creds = match credentials::load_credentials(&ws.team_id)? {
                Some(c) => c,
                None => continue,
            };

            // Build the "I'm involved here" channel set: messages I
            // posted OR messages mentioning me, within COLD_START_DAYS.
            // Search failures are non-fatal — we degrade to "no
            // channels pass the filter" rather than aborting the
            // workspace entirely. DMs still flow through.
            let involved_channels = collect_involved_channels(ws, &creds);

            let mut rows = match api::users_conversations(
                &creds,
                "im,mpim,public_channel,private_channel",
                500,
            ) {
                Ok(r) => r,
                Err(error) => {
                    tracing::warn!(
                        team_id = %ws.team_id,
                        error = %format!("{error:#}"),
                        "slack backend: users.conversations failed",
                    );
                    continue;
                }
            };
            rows.retain(|c| {
                if c.is_im || c.is_mpim {
                    true // DMs / group-DMs unconditional
                } else {
                    involved_channels.contains(&c.id)
                }
            });
            // DMs first; among channels the order doesn't really
            // matter (the generic layer truncates to a cap anyway).
            rows.sort_by(|a, b| {
                let dm_a = (a.is_im || a.is_mpim) as u8;
                let dm_b = (b.is_im || b.is_mpim) as u8;
                dm_b.cmp(&dm_a)
            });
            for row in rows {
                out.push(to_im_conversation(ws, &row));
            }
        }
        Ok(out)
    }

    fn fetch_messages(
        &self,
        conv: &ImConversation,
        since: Option<DateTime<Utc>>,
        limit: usize,
    ) -> Result<Vec<ImMessage>> {
        let ConvHandle { team_id, .. } = parse_handle(conv);
        let creds = match credentials::load_credentials(team_id)? {
            Some(c) => c,
            None => return Ok(Vec::new()),
        };
        let channel_id = parse_channel_id(&conv.id);
        let oldest = since.map(|dt| format!("{}.000000", dt.timestamp()));
        let raws = api::conversations_history(
            &creds,
            channel_id,
            oldest.as_deref(),
            limit.min(u32::MAX as usize) as u32,
        )
        .with_context(|| format!("slack conversations.history {channel_id}"))?;
        let mut messages = Vec::with_capacity(raws.len());
        for raw in raws {
            if let Some(m) = to_im_message(team_id, &creds, &raw) {
                messages.push(m);
            }
        }
        Ok(messages)
    }
}

/// Run two `search.messages` queries (mentions + from-me) bounded by
/// `COLD_START_DAYS` and collect distinct `channel.id` hits. Failures
/// in either query fall back to whatever the other one returned.
fn collect_involved_channels(ws: &SlackWorkspace, creds: &SlackCreds) -> BTreeSet<String> {
    let after = (Utc::now() - Duration::days(super::COLD_START_DAYS))
        .format("%Y-%m-%d")
        .to_string();
    let mention_query = format!("<@{my}> after:{after}", my = ws.my_user_id);
    let sent_query = format!("from:<@{my}> after:{after}", my = ws.my_user_id);
    let mut channels = BTreeSet::new();
    for (label, q) in [("mention", mention_query), ("from-me", sent_query)] {
        match api::search_messages(creds, &q, 1, api::SearchSort::Timestamp) {
            Ok(page) => {
                for hit in &page.matches {
                    if let Some(ch) = hit.channel.as_ref() {
                        if !ch.id.is_empty() {
                            channels.insert(ch.id.clone());
                        }
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    team_id = %ws.team_id,
                    kind = label,
                    error = %format!("{error:#}"),
                    "slack backend: search.messages failed; channels may be under-discovered",
                );
            }
        }
    }
    channels
}

/// Slack stores per-conversation context in our `ImConversation.id` as
/// `<team_id>:<channel_id>` so the cursor / cache layout stays scoped per
/// workspace AND per channel. `raw` carries the original ConversationRow.
struct ConvHandle<'a> {
    team_id: &'a str,
    #[allow(dead_code)]
    channel_id: &'a str,
}

fn parse_handle(conv: &ImConversation) -> ConvHandle<'_> {
    let (team, channel) = conv
        .id
        .split_once(':')
        .unwrap_or((conv.id.as_str(), conv.id.as_str()));
    ConvHandle {
        team_id: team,
        channel_id: channel,
    }
}

fn parse_channel_id(conv_id: &str) -> &str {
    conv_id.split_once(':').map(|(_, c)| c).unwrap_or(conv_id)
}

fn to_im_conversation(ws: &SlackWorkspace, row: &ConversationRow) -> ImConversation {
    let kind = if row.is_im {
        ImConversationKind::Dm
    } else if row.is_mpim {
        ImConversationKind::GroupDm
    } else if row.is_private {
        ImConversationKind::PrivateChannel
    } else {
        ImConversationKind::Channel
    };
    let label = row.name.clone().map(|n| match kind {
        ImConversationKind::Dm | ImConversationKind::GroupDm => format!("DM · {n}"),
        _ => format!("#{n}"),
    });
    ImConversation {
        id: format!("{}:{}", ws.team_id, row.id),
        label,
        kind,
        raw: json!({
            "team_id": ws.team_id,
            "channel_id": row.id,
            "unread_count_display": row.unread_count_display,
        }),
    }
}

fn to_im_message(team_id: &str, creds: &SlackCreds, raw: &RawMessage) -> Option<ImMessage> {
    if raw.ts.is_empty() {
        return None;
    }
    let body = api::extract_display_text(raw);
    let text = api::resolve_mentions(team_id, creds, &body);
    let sender = raw
        .user_id
        .as_deref()
        .and_then(|uid| api::users_info(team_id, creds, uid).ok())
        .map(|u| u.display_name)
        .or_else(|| raw.username_fallback.clone());
    let timestamp = ts_string_to_utc(&raw.ts).unwrap_or_else(Utc::now);
    // Carry only the bits a future render-override might need (e.g. thread
    // context). RawMessage doesn't implement Serialize, so we hand-build.
    let raw_blob = json!({
        "thread_ts": raw.thread_ts,
        "files": raw.files.len(),
        "has_reactions": !raw.reactions.is_empty(),
    });
    Some(ImMessage {
        id: raw.ts.clone(),
        timestamp,
        sender,
        text,
        external_url: raw.permalink.clone(),
        deleted: false,
        raw: raw_blob,
    })
}

fn ts_string_to_utc(ts: &str) -> Option<DateTime<Utc>> {
    let secs_f: f64 = ts.parse().ok()?;
    let secs = secs_f as i64;
    let nanos = ((secs_f - secs as f64) * 1_000_000_000f64) as u32;
    Utc.timestamp_opt(secs, nanos).single()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> SlackWorkspace {
        SlackWorkspace {
            team_id: "T0".into(),
            team_name: "test".into(),
            team_domain: "test".into(),
            my_user_id: "U_me".into(),
            added_at: 0,
        }
    }

    fn row(
        id: &str,
        name: &str,
        is_im: bool,
        is_mpim: bool,
        is_private: bool,
        unread: u32,
    ) -> ConversationRow {
        ConversationRow {
            id: id.into(),
            name: Some(name.into()),
            is_im,
            is_mpim,
            is_channel: !is_im && !is_mpim,
            is_private,
            user: None,
            unread_count_display: unread,
            last_read: None,
        }
    }

    #[test]
    fn maps_dm_to_kind_dm_with_label() {
        let conv = to_im_conversation(&ws(), &row("D1", "alice", true, false, false, 0));
        assert_eq!(conv.kind, ImConversationKind::Dm);
        assert_eq!(conv.label.as_deref(), Some("DM · alice"));
        assert_eq!(conv.id, "T0:D1");
    }

    #[test]
    fn maps_private_channel_to_kind_private_channel() {
        let conv = to_im_conversation(&ws(), &row("C1", "leads", false, false, true, 1));
        assert_eq!(conv.kind, ImConversationKind::PrivateChannel);
        assert_eq!(conv.label.as_deref(), Some("#leads"));
    }

    #[test]
    fn maps_mpim_to_kind_group_dm() {
        let conv = to_im_conversation(&ws(), &row("MP1", "trio", false, true, false, 0));
        assert_eq!(conv.kind, ImConversationKind::GroupDm);
        assert_eq!(conv.label.as_deref(), Some("DM · trio"));
    }

    #[test]
    fn conv_id_round_trips_through_parse_handle() {
        let conv = to_im_conversation(&ws(), &row("C1", "eng", false, false, false, 1));
        let handle = parse_handle(&conv);
        assert_eq!(handle.team_id, "T0");
        assert_eq!(handle.channel_id, "C1");
    }

    #[test]
    fn ts_round_trip() {
        let dt = ts_string_to_utc("1735000000.123456").unwrap();
        assert_eq!(dt.timestamp(), 1735000000);
    }
}
