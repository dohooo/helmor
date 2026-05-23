//! Build the detail view for a single Slack inbox item.
//!
//! Two modes:
//!   1. `thread_ts` is set → `conversations.replies` returns the full
//!      thread including the root message. We render the whole tree.
//!   2. `thread_ts` is None → `conversations.history` with the message's
//!      `ts` as `latest`+`inclusive` gives a small context window around
//!      a single DM / channel message. Better than showing the message
//!      naked.

use anyhow::{bail, Context, Result};

use super::api::{self, RawMessage, RawReaction, UserInfo};
use super::credentials::{self, SlackCreds};
use super::types::{SlackMessage, SlackReactionSummary, SlackThreadDetail};

pub fn get_thread_detail(
    team_id: &str,
    channel_id: &str,
    thread_ts: Option<&str>,
    anchor_ts: &str,
) -> Result<SlackThreadDetail> {
    let creds = match credentials::load_credentials(team_id)? {
        Some(c) => c,
        None => bail!("No stored Slack credentials for team {team_id}"),
    };

    let (raw_messages, is_thread) = if let Some(thread) = thread_ts {
        (
            api::conversations_replies(&creds, channel_id, thread)?,
            true,
        )
    } else {
        // Single-message preview: grab the last ~20 of channel history
        // and flip newest-first → oldest-first for rendering. v1 takes
        // the simple "last 20" slice — perfect-anchor centering can
        // wait until we hear the UX demand it.
        let mut messages = api::conversations_history(&creds, channel_id, None, 20)
            .context("Failed to fetch channel history for detail view")?;
        messages.reverse();
        (messages, false)
    };

    let channel_label =
        api::conversations_info(&creds, channel_id).unwrap_or_else(|_| channel_id.to_string());
    let permalink = api::chat_get_permalink(&creds, channel_id, anchor_ts)
        .ok()
        .flatten()
        .unwrap_or_default();

    let messages = raw_messages
        .into_iter()
        .map(|raw| convert_message(team_id, &creds, raw))
        .collect();

    Ok(SlackThreadDetail {
        team_id: team_id.to_string(),
        channel_id: channel_id.to_string(),
        channel_label,
        is_thread,
        messages,
        permalink,
    })
}

fn convert_message(team_id: &str, creds: &SlackCreds, raw: RawMessage) -> SlackMessage {
    let (author_name, author_avatar_url) = resolve_author(team_id, creds, &raw);
    let ts_millis = api::ts_to_millis(&raw.ts);
    // `raw.text` is empty for bot messages (GitHub etc.) and for richly
    // composed messages where Slack only published the body via
    // `blocks[]`. Walk the alternatives once here so the detail view
    // never falls through to "(empty message)" for content that's
    // visibly there in Slack.
    let text = api::extract_display_text(&raw);
    let reactions = raw
        .reactions
        .into_iter()
        .map(|RawReaction { name, count }| SlackReactionSummary { name, count })
        .collect();
    SlackMessage {
        ts: raw.ts,
        user_id: raw.user_id.clone(),
        author_name,
        author_avatar_url,
        text,
        ts_millis,
        reactions,
    }
}

fn resolve_author(team_id: &str, creds: &SlackCreds, raw: &RawMessage) -> (String, Option<String>) {
    if let Some(uid) = raw.user_id.as_deref() {
        if let Ok(UserInfo {
            display_name,
            avatar_url,
        }) = api::users_info(team_id, creds, uid)
        {
            return (display_name, avatar_url);
        }
    }
    if let Some(name) = raw.username_fallback.as_deref() {
        return (name.to_string(), None);
    }
    (
        raw.user_id.clone().unwrap_or_else(|| "Slack".to_string()),
        None,
    )
}
