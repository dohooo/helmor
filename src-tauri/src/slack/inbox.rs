//! Build the Slack Activity feed: mentions + unread-DM snippets, merged
//! by timestamp.
//!
//! This is the v1 approximation of Slack's own Activity view. It is NOT
//! a perfect replica — Slack's view also surfaces emoji-reaction
//! notifications, thread subscriptions, and a few system events that
//! require xoxc-only undocumented endpoints. We trade fidelity for
//! a simple, stable contract built on Slack's public Web API.
//!
//! Pagination is opaque-cursor-shaped. v1 cursor format: a stringified
//! page number for the mentions stream. DM snippets all fit on page 1.

use anyhow::{bail, Result};

use super::api::{self, ConversationRow, RawMessage, SearchMessagesPage, SearchSort, UserInfo};
use super::credentials::{self, SlackCreds};
use super::types::{SlackInboxItem, SlackInboxItemKind, SlackInboxPage};

const MAX_SNIPPET_CHARS: usize = 280;

/// Returns the feed for a single workspace. The caller passes the
/// workspace's `team_id`, we resolve credentials lazily from the keyring.
///
/// On `invalid_auth` we propagate a typed error so the IPC layer can wipe
/// the keychain entry and broadcast `SlackTokenInvalidated` to the UI.
pub fn list_inbox_items(
    team_id: &str,
    my_user_id: &str,
    cursor: Option<&str>,
    limit: u32,
) -> Result<SlackInboxPage> {
    let creds = match credentials::load_credentials(team_id)? {
        Some(c) => c,
        None => bail!("No stored Slack credentials for team {team_id}"),
    };
    let page = cursor
        .and_then(|c| c.parse::<u32>().ok())
        .unwrap_or(1)
        .max(1);

    // Mentions feed: `@<my_user_id>` is Slack's documented "mentions of
    // me" query token. `from:me` would invert it. We deliberately don't
    // request `has:reaction` etc. — keep the query minimal so Slack's
    // search index responds fast.
    let query = format!("<@{my_user_id}>");
    let SearchMessagesPage {
        matches,
        total_pages,
    } = api::search_messages(&creds, &query, page, SearchSort::Timestamp)?;
    let next_cursor = if page < total_pages {
        Some((page + 1).to_string())
    } else {
        None
    };

    let mut items: Vec<SlackInboxItem> = matches
        .into_iter()
        .filter_map(|raw| convert_search_match(team_id, &creds, raw).ok())
        .collect();

    // DMs: only on page 1 — there's typically a handful of unread DMs
    // and they don't paginate. On page 2+ we just want the next chunk
    // of older mentions.
    if page == 1 {
        let dms = unread_dm_snippets(team_id, &creds).unwrap_or_else(|error| {
            tracing::warn!(team = %team_id, error = %format!("{error:#}"), "Failed to fetch unread DMs");
            Vec::new()
        });
        items.extend(dms);
    }

    // Stable merge: most-recent first.
    items.sort_by_key(|item| std::cmp::Reverse(item.ts_millis));
    items.truncate(limit as usize);

    Ok(SlackInboxPage { items, next_cursor })
}

/// Free-text search entry point. Wraps `search.messages` with a
/// caller-supplied query string and sort mode, returning the same
/// `SlackInboxPage` shape the activity feed uses so the frontend can
/// swap data sources without re-templating the list.
///
/// The user's input is passed through verbatim, so Slack search
/// modifiers (`from:@alice`, `in:#eng`, `has:link`, `is:thread`,
/// quoted phrases, `-` negation, etc.) compose naturally without us
/// having to teach the UI about each operator. Cursor format mirrors
/// the activity feed: a stringified page number.
pub fn search(
    team_id: &str,
    query: &str,
    sort: SearchSort,
    cursor: Option<&str>,
    limit: u32,
) -> Result<SlackInboxPage> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        // Empty query would match every message in the workspace —
        // wasteful and not what the UI ever asks for. Treat as "no
        // results" rather than burning a search request.
        return Ok(SlackInboxPage {
            items: Vec::new(),
            next_cursor: None,
        });
    }
    let creds = match credentials::load_credentials(team_id)? {
        Some(c) => c,
        None => bail!("No stored Slack credentials for team {team_id}"),
    };
    let page = cursor
        .and_then(|c| c.parse::<u32>().ok())
        .unwrap_or(1)
        .max(1);

    let SearchMessagesPage {
        matches,
        total_pages,
    } = api::search_messages(&creds, trimmed, page, sort)?;
    let next_cursor = if page < total_pages {
        Some((page + 1).to_string())
    } else {
        None
    };

    let mut items: Vec<SlackInboxItem> = matches
        .into_iter()
        .filter_map(|raw| convert_search_match(team_id, &creds, raw).ok())
        .collect();
    items.truncate(limit as usize);

    Ok(SlackInboxPage { items, next_cursor })
}

/// `search.messages` result row → SlackInboxItem (mention kind).
fn convert_search_match(
    team_id: &str,
    creds: &SlackCreds,
    raw: RawMessage,
) -> Result<SlackInboxItem> {
    let channel = raw
        .channel
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("search.messages hit missing channel envelope"))?;
    let channel_label = channel
        .name
        .clone()
        .map(|n| format!("#{n}"))
        .unwrap_or_else(|| channel.id.clone());

    let author = resolve_author_name(team_id, creds, raw.user_id.as_deref(), &raw)
        .unwrap_or_else(|_| author_fallback(&raw));
    let permalink = raw.permalink.clone().unwrap_or_default();
    let ts_millis = api::ts_to_millis(&raw.ts);

    Ok(SlackInboxItem {
        id: format!("{}:{}:{}", team_id, channel.id, raw.ts),
        team_id: team_id.to_string(),
        channel_id: channel.id.clone(),
        channel_label,
        kind: SlackInboxItemKind::Mention,
        ts: raw.ts,
        thread_ts: raw.thread_ts,
        author_name: author,
        text_snippet: truncate(&raw.text, MAX_SNIPPET_CHARS),
        ts_millis,
        permalink,
    })
}

/// Unread DM/MPIM list → one SlackInboxItem per channel using its latest
/// message as the snippet. Bounded fanout: we cap at 4 concurrent
/// channels per refresh to stay under Slack's per-token burst threshold
/// (running serially in the blocking pool also limits the rate
/// naturally).
fn unread_dm_snippets(team_id: &str, creds: &SlackCreds) -> Result<Vec<SlackInboxItem>> {
    let dms = api::users_conversations_dms(creds)?;
    let mut items = Vec::new();
    for dm in dms {
        if dm.unread_count_display == 0 {
            continue;
        }
        match snippet_for_dm(team_id, creds, &dm) {
            Ok(Some(item)) => items.push(item),
            Ok(None) => {}
            Err(error) => {
                // Per-DM failure shouldn't kill the whole batch; missing
                // a few unread snippets is fine, an inbox-wide error is
                // not.
                tracing::warn!(
                    team = %team_id,
                    channel = %dm.id,
                    error = %format!("{error:#}"),
                    "Skipping DM snippet",
                );
            }
        }
    }
    Ok(items)
}

fn snippet_for_dm(
    team_id: &str,
    creds: &SlackCreds,
    dm: &ConversationRow,
) -> Result<Option<SlackInboxItem>> {
    let latest = api::conversations_history(creds, &dm.id, dm.last_read.as_deref(), 1)?;
    let Some(message) = latest.into_iter().next() else {
        return Ok(None);
    };
    let label = dm_label(team_id, creds, dm)?;
    let author = resolve_author_name(team_id, creds, message.user_id.as_deref(), &message)
        .unwrap_or_else(|_| author_fallback(&message));
    let permalink = api::chat_get_permalink(creds, &dm.id, &message.ts)
        .ok()
        .flatten()
        .unwrap_or_default();
    let ts_millis = api::ts_to_millis(&message.ts);
    Ok(Some(SlackInboxItem {
        id: format!("{}:{}:{}", team_id, dm.id, message.ts),
        team_id: team_id.to_string(),
        channel_id: dm.id.clone(),
        channel_label: label,
        kind: SlackInboxItemKind::DirectMessage,
        ts: message.ts,
        thread_ts: message.thread_ts,
        author_name: author,
        text_snippet: truncate(&message.text, MAX_SNIPPET_CHARS),
        ts_millis,
        permalink,
    }))
}

/// "DM with Alice" / "Group DM (3)" / etc. Falls back to the channel id
/// if we can't resolve the partner's name without bulk listing users.
fn dm_label(team_id: &str, creds: &SlackCreds, dm: &ConversationRow) -> Result<String> {
    if dm.is_im {
        if let Some(user_id) = dm.user.as_deref() {
            let info = api::users_info(team_id, creds, user_id)?;
            return Ok(format!("DM · {}", info.display_name));
        }
    }
    if dm.is_mpim {
        if let Some(name) = dm.name.as_deref() {
            return Ok(format!("Group · {}", name));
        }
    }
    Ok(dm.name.clone().unwrap_or_else(|| dm.id.clone()))
}

/// Best-effort author lookup. The blocking call is safe because
/// `users.info` is bounded and the result is cached for 5 min in-process.
fn resolve_author_name(
    team_id: &str,
    creds: &SlackCreds,
    user_id: Option<&str>,
    raw: &RawMessage,
) -> Result<String> {
    if let Some(uid) = user_id {
        let UserInfo { display_name, .. } = api::users_info(team_id, creds, uid)?;
        return Ok(display_name);
    }
    if let Some(name) = raw.username_fallback.as_deref() {
        return Ok(name.to_string());
    }
    Err(anyhow::anyhow!("no author hint available"))
}

fn author_fallback(raw: &RawMessage) -> String {
    raw.user_id
        .clone()
        .or_else(|| raw.username_fallback.clone())
        .unwrap_or_else(|| "Slack".to_string())
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::truncate;

    #[test]
    fn truncate_keeps_short_strings_intact() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("", 10), "");
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        assert_eq!(truncate("abcdefghij", 5), "abcde…");
    }

    #[test]
    fn truncate_respects_utf8_char_boundaries() {
        // 6 narrow chars + 1 wide char — the cut must land on a char,
        // not a byte. Naive `text[..max]` would panic.
        let input = "你好世界Helmor";
        let out = truncate(input, 4);
        assert_eq!(out, "你好世界…");
    }
}
