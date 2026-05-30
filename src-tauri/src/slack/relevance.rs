//! Shared, failure-aware "what's relevant to me right now" discovery for
//! Slack. Both the inbox feed (`slack::inbox`) and the triage fetcher
//! (`triage::fetcher::im::slack`) compose these primitives so the
//! failure-handling policy + degradation reporting live in ONE place.
//!
//! The contract that fixes the original bug: a flaky underlying signal
//! (`search.messages` 503s, transient network errors) returns a
//! [`Outcome`] whose `value` is empty/partial AND whose `degraded`
//! carries a human-readable reason — NEVER a silent empty. Callers must
//! treat `degraded.is_some()` as "this is incomplete, surface it",
//! distinct from a genuine empty result.
//!
//! This is also the seam a future `client.counts`/`client.boot`
//! implementation swaps behind — consumers depend on these signatures,
//! not on `search.messages`.

use std::collections::BTreeSet;

use anyhow::Result;
use chrono::{Duration, Utc};

use super::api::{self, ConversationRow, RawMessage, SearchMessagesPage, SearchSort};
use super::credentials::SlackCreds;

/// A discovery result that may be partial. `value` is always usable
/// (possibly empty); `degraded` is `Some(reason)` when an underlying
/// signal failed, so the caller can report incompleteness instead of
/// silently treating "failed" as "nothing relevant".
#[derive(Debug, Clone)]
pub struct Outcome<T> {
    pub value: T,
    pub degraded: Option<String>,
}

impl<T> Outcome<T> {
    fn ok(value: T) -> Self {
        Self {
            value,
            degraded: None,
        }
    }

    fn degraded(value: T, reason: impl Into<String>) -> Self {
        Self {
            value,
            degraded: Some(reason.into()),
        }
    }
}

/// Classify an api error. Auth-fatal (`invalid_auth` / `not_authed` / …)
/// → `Err`, so the caller can propagate it and trigger re-auth (the inbox
/// IPC layer wipes the keychain + emits `SlackTokenInvalidated` on this).
/// Anything else is transient → `Ok` with a degraded (empty/partial)
/// outcome, so a flaky network/search index never looks like "auth gone".
fn classify<T>(empty: T, error: anyhow::Error, what: &str) -> Result<Outcome<T>> {
    if api::is_invalid_auth(&error) {
        Err(error)
    } else {
        Ok(Outcome::degraded(
            empty,
            format!("{what} failed: {error:#}"),
        ))
    }
}

/// Mentions of `@me`, one page, caller-chosen sort. The inbox renders
/// these as feed items; triage reads the channel envelopes to learn which
/// channels mentioned it. Transient failure → empty page + degraded
/// reason so a flaky search index never blanks the whole feed/queue;
/// auth failure → `Err` for the caller to propagate.
pub fn mentions(
    creds: &SlackCreds,
    my_user_id: &str,
    page: u32,
    sort: SearchSort,
) -> Result<Outcome<SearchMessagesPage>> {
    let query = format!("<@{my_user_id}>");
    match api::search_messages(creds, &query, page, sort) {
        Ok(page) => Ok(Outcome::ok(page)),
        Err(error) => classify(
            SearchMessagesPage {
                matches: Vec::new(),
                total_pages: 0,
            },
            error,
            "mentions search",
        ),
    }
}

/// Channel ids I'm "involved" in over the cold-start window: channels I
/// was @ed in OR posted in. Two `search.messages` queries; each failure
/// degrades independently. DMs (discovered separately) are unaffected.
pub fn involved_channels(
    creds: &SlackCreds,
    my_user_id: &str,
    cold_start_days: i64,
) -> Result<Outcome<BTreeSet<String>>> {
    let after = (Utc::now() - Duration::days(cold_start_days))
        .format("%Y-%m-%d")
        .to_string();
    let queries = [
        ("mention", format!("<@{my_user_id}> after:{after}")),
        ("from-me", format!("from:<@{my_user_id}> after:{after}")),
    ];
    let mut channels = BTreeSet::new();
    let mut failures: Vec<String> = Vec::new();
    for (label, query) in queries {
        match api::search_messages(creds, &query, 1, SearchSort::Timestamp) {
            Ok(page) => collect_channel_ids(&page.matches, &mut channels),
            Err(error) => {
                if api::is_invalid_auth(&error) {
                    return Err(error);
                }
                failures.push(format!("{label}: {error:#}"));
            }
        }
    }
    if failures.is_empty() {
        Ok(Outcome::ok(channels))
    } else {
        Ok(Outcome::degraded(
            channels,
            format!("channel discovery degraded ({})", failures.join("; ")),
        ))
    }
}

/// All conversations I'm a member of, filtered to `types` (Slack-side
/// comma list: `im,mpim,public_channel,private_channel`). Unlike the old
/// triage path, a failure is reported as degraded (empty) rather than
/// silently skipping the whole workspace.
pub fn member_conversations(
    creds: &SlackCreds,
    types: &str,
    limit: u32,
) -> Result<Outcome<Vec<ConversationRow>>> {
    match api::users_conversations(creds, types, limit) {
        Ok(rows) => Ok(Outcome::ok(rows)),
        Err(error) => classify(Vec::new(), error, "users.conversations"),
    }
}

/// Unread DM/MPIM conversations (`unread_count_display > 0`), for the
/// inbox feed. Triage treats all DMs/MPIMs as candidates regardless of
/// unread, so it uses [`member_conversations`] directly.
pub fn unread_dms(creds: &SlackCreds) -> Result<Outcome<Vec<ConversationRow>>> {
    match api::users_conversations_dms(creds) {
        Ok(rows) => Ok(Outcome::ok(
            rows.into_iter()
                .filter(|d| d.unread_count_display > 0)
                .collect(),
        )),
        Err(error) => classify(Vec::new(), error, "users.conversations (dms)"),
    }
}

/// Union the channel ids carried in a batch of `search.messages` hits.
fn collect_channel_ids(matches: &[RawMessage], into: &mut BTreeSet<String>) {
    for hit in matches {
        if let Some(channel) = hit.channel.as_ref() {
            if !channel.id.is_empty() {
                into.insert(channel.id.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn match_in_channel(channel_id: &str) -> RawMessage {
        serde_json::from_value(json!({
            "ts": "1700000000.000100",
            "channel": { "id": channel_id, "name": "eng" },
        }))
        .expect("valid RawMessage")
    }

    #[test]
    fn collect_channel_ids_dedups_and_skips_empty() {
        let matches = vec![
            match_in_channel("C1"),
            match_in_channel("C1"),
            match_in_channel("C2"),
            match_in_channel(""),
        ];
        let mut into = BTreeSet::new();
        collect_channel_ids(&matches, &mut into);
        assert_eq!(into.len(), 2);
        assert!(into.contains("C1") && into.contains("C2"));
    }

    #[test]
    fn outcome_degraded_carries_reason_with_usable_value() {
        let o = Outcome::degraded(vec![1, 2], "boom");
        assert_eq!(o.value, vec![1, 2]);
        assert_eq!(o.degraded.as_deref(), Some("boom"));
    }

    #[test]
    fn classify_propagates_auth_and_degrades_transient() {
        use crate::slack::api::SlackApiError;
        // Auth-fatal → Err so the caller can propagate + trigger re-auth.
        let auth = anyhow::Error::from(SlackApiError {
            method: "users.conversations".into(),
            error: "invalid_auth".into(),
        });
        assert!(classify(Vec::<u8>::new(), auth, "x").is_err());
        // Transient → Ok(degraded), never mistaken for auth loss.
        let transient = anyhow::anyhow!("connection refused");
        let out = classify(Vec::<u8>::new(), transient, "x").expect("transient is not fatal");
        assert!(out.degraded.is_some());
    }
}
