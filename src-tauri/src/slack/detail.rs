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

use super::api::{self, FileCategory, RawFile, RawMessage, RawReaction, UserInfo};
use super::credentials::{self, SlackCreds};
use super::types::{SlackFileRef, SlackMessage, SlackReactionSummary, SlackThreadDetail};

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
    // Detail body: recover the real text from `text` / `blocks` /
    // `attachments`, but skip the `files` placeholder branch. When a
    // message is purely a file share, the inline preview rendered from
    // `files` below replaces what would otherwise be `📎 N files` —
    // we don't want both showing. Then resolve `<@U…>` mentions to the
    // labeled `<@U…|display>` form so the frontend can render
    // human-readable `@names` instead of opaque user ids.
    let body = api::extract_message_body(&raw);
    let text = api::resolve_mentions(team_id, creds, &body);
    let reactions = raw
        .reactions
        .iter()
        .cloned()
        .map(|RawReaction { name, count }| SlackReactionSummary { name, count })
        .collect();
    let files = raw.files.iter().map(slack_file_ref).collect();
    SlackMessage {
        ts: raw.ts,
        user_id: raw.user_id,
        author_name,
        author_avatar_url,
        text,
        ts_millis,
        reactions,
        files,
    }
}

/// Build the wire shape sent to the frontend for a single file. Inline
/// preview / source URLs are rewritten from Slack's `files.slack.com`
/// origin into our custom `slack-file://` protocol so the webview can
/// load them without the workspace cookie.
fn slack_file_ref(raw: &RawFile) -> SlackFileRef {
    let category_str = match raw.category() {
        FileCategory::Image => "image",
        FileCategory::Gif => "gif",
        FileCategory::Video => "video",
        FileCategory::Audio => "audio",
        FileCategory::Pdf => "pdf",
        FileCategory::Other => "other",
    };
    let preview_url = match raw.category() {
        // Animated GIFs need to be served from the original URL so the
        // animation plays — the thumb is a frozen frame.
        FileCategory::Gif => raw
            .url_private
            .as_deref()
            .or_else(|| raw.preview_url())
            .map(rewrite_to_slack_file_uri),
        FileCategory::Image => raw.preview_url().map(rewrite_to_slack_file_uri),
        // Video: the static-frame `thumb_video` is what we show until
        // the user clicks through.
        FileCategory::Video => raw
            .thumb_video
            .as_deref()
            .or_else(|| raw.preview_url())
            .map(rewrite_to_slack_file_uri),
        // Audio / PDF / other → no inline preview, just the chip.
        FileCategory::Audio | FileCategory::Pdf | FileCategory::Other => None,
    };
    let source_url = match raw.category() {
        FileCategory::Image | FileCategory::Gif | FileCategory::Video => {
            raw.url_private.as_deref().map(rewrite_to_slack_file_uri)
        }
        _ => None,
    };
    SlackFileRef {
        id: raw.id.clone(),
        name: raw
            .title
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| raw.name.clone())
            .unwrap_or_else(|| "Attachment".to_string()),
        mimetype: raw.mimetype.clone(),
        category: category_str.to_string(),
        preview_url,
        source_url,
        permalink: raw.permalink.clone(),
        width: raw.original_w,
        height: raw.original_h,
    }
}

/// `https://files.slack.com/files-tmb/T…-F…/img.png` →
/// `slack-file://files-tmb/T…-F…/img.png`. Slack's CDN host is always
/// `files.slack.com`; the custom protocol's path is the rest of the
/// Slack URL verbatim so the handler can reconstruct it.
fn rewrite_to_slack_file_uri(slack_url: &str) -> String {
    let stripped = slack_url
        .strip_prefix("https://files.slack.com/")
        .or_else(|| slack_url.strip_prefix("http://files.slack.com/"))
        .unwrap_or(slack_url);
    format!("slack-file://{stripped}")
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
