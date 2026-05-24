//! Format a Slack thread into a single prompt-friendly string suitable
//! for injecting as agent context (Claude Code / Codex / etc).
//!
//! The output is plain text — no markdown styling, no React nodes —
//! optimised for an LLM to read and act on. Tokens like `<@U…|name>`
//! that the live UI renders as styled pills are flattened to `@name`
//! here so the agent doesn't have to parse Slack mrkdwn.
//!
//! File attachments are surfaced with their on-disk paths (after the
//! caller pre-warmed the Slack file cache via `slack::files::resolve_to_path`).
//! The agent can then read those paths through its `Read` tool —
//! that's the only way to expose Slack-hosted images to a separate
//! agent process that lacks the workspace cookie.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::{SlackFileRef, SlackMessage, SlackThreadDetail};

/// Inputs the formatter needs alongside the raw thread.
pub struct AgentContextInputs<'a> {
    /// `auth.test` user id for the active workspace. Determines which
    /// messages get the `(you)` annotation.
    pub my_user_id: &'a str,
    /// Friendly workspace label, e.g. "Dosu" (from `SlackWorkspace.team_name`).
    pub workspace_name: &'a str,
    /// Map of file_id → local cache path. Built by the prepare command
    /// before calling `format_thread_for_agent`.
    pub cache_paths: &'a HashMap<String, PathBuf>,
    /// Cap the number of messages rendered to keep prompts bounded.
    /// When exceeded we keep the thread root + the most-recent
    /// `max_messages - 1` replies and emit a `[… N earlier messages
    /// elided …]` marker between them.
    pub max_messages: usize,
}

/// Render a thread into the final prompt-injected string.
///
/// The output starts with a fenced header so the agent recognises a
/// quoted-context block and doesn't confuse it with the user's own
/// instructions:
///
/// ```text
/// [Slack thread context — #eng-frontend / Dosu]
/// You: @caspian (U06EBDDS3PF)
/// Channel: #eng-frontend
/// Permalink: https://dosu-ai.slack.com/…
///
/// Thread (5 messages):
///
///   [22h ago] @michael:
///   …
///
///   [21h ago] @caspian (you):
///   …
/// ```
pub fn format_thread_for_agent(
    detail: &SlackThreadDetail,
    inputs: &AgentContextInputs<'_>,
) -> String {
    let total = detail.messages.len();
    let now_millis = current_time_millis();

    let mut out = String::new();

    out.push_str(&format!(
        "[Slack thread context — {} / {}]\n",
        detail.channel_label, inputs.workspace_name,
    ));
    out.push_str(&format!(
        "Your Slack user id: {} (messages from you are tagged `(you)` below)\n",
        inputs.my_user_id,
    ));
    out.push_str(&format!("Channel: {}\n", detail.channel_label));
    if !detail.permalink.is_empty() {
        out.push_str(&format!(
            "Permalink (not fetchable by you, opens in Slack desktop): {}\n",
            detail.permalink,
        ));
    }
    out.push('\n');

    // Decide which messages to keep. Always preserve the thread root
    // (index 0) — it carries the original context most replies hang
    // off — and keep the most-recent N-1 replies.
    let kept: Vec<(usize, &SlackMessage)> = select_messages(&detail.messages, inputs.max_messages);
    let elided = total.saturating_sub(kept.len());

    let label = if detail.is_thread {
        "Thread"
    } else {
        "Channel context"
    };
    if elided > 0 {
        out.push_str(&format!(
            "{label} ({total} messages total, {elided} elided to keep the prompt bounded):\n\n",
        ));
    } else {
        out.push_str(&format!("{label} ({total} messages):\n\n",));
    }

    let mut prev_index: Option<usize> = None;
    for (idx, message) in kept.iter().copied() {
        if let Some(prev) = prev_index {
            if idx > prev + 1 {
                out.push_str(&format!(
                    "  [… {} earlier messages elided …]\n\n",
                    idx - prev - 1,
                ));
            }
        }
        out.push_str(&format_message(message, inputs, now_millis));
        out.push('\n');
        prev_index = Some(idx);
    }

    out.trim_end().to_string()
}

/// Collect the cached local paths of every image / gif / video-poster
/// in the thread, in chronological message order then per-message
/// declaration order. De-duped by Slack file id (same file shared by
/// multiple replies appears once). Files without a corresponding
/// `cache_paths` entry (cache write failed, or category we don't
/// pre-warm like PDFs / audio) are skipped.
///
/// The output drives the frontend's `kind: "image"` ComposerInsertItem
/// expansion — preserve ordering so the chips line up with the order
/// the agent sees them mentioned in `submit_text`.
pub fn collect_image_paths(
    detail: &SlackThreadDetail,
    cache_paths: &HashMap<String, PathBuf>,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::<String>::new();
    let mut paths: Vec<String> = Vec::new();
    for message in &detail.messages {
        for file in &message.files {
            if !seen.insert(file.id.clone()) {
                continue;
            }
            if let Some(path) = cache_paths.get(&file.id) {
                paths.push(path.to_string_lossy().into_owned());
            }
        }
    }
    paths
}

fn select_messages(messages: &[SlackMessage], max: usize) -> Vec<(usize, &SlackMessage)> {
    if messages.len() <= max || max == 0 {
        return messages.iter().enumerate().collect();
    }
    let mut kept: Vec<(usize, &SlackMessage)> = Vec::with_capacity(max);
    kept.push((0, &messages[0]));
    let tail_count = max - 1;
    let tail_start = messages.len().saturating_sub(tail_count);
    for (i, m) in messages.iter().enumerate().skip(tail_start.max(1)) {
        kept.push((i, m));
    }
    kept
}

fn format_message(
    message: &SlackMessage,
    inputs: &AgentContextInputs<'_>,
    now_millis: i64,
) -> String {
    let mut out = String::new();
    let author_tag = if message.user_id.as_deref() == Some(inputs.my_user_id) {
        format!("@{} (you)", message.author_name)
    } else {
        format!("@{}", message.author_name)
    };
    out.push_str(&format!(
        "  [{}] {}:\n",
        relative_time(now_millis, message.ts_millis),
        author_tag,
    ));

    let body = format_text_plain(&message.text);
    if !body.is_empty() {
        for line in body.lines() {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }

    for file in &message.files {
        if let Some(line) = render_file(file, inputs.cache_paths) {
            out.push_str(&line);
            out.push('\n');
        }
    }

    if !message.reactions.is_empty() {
        let summary: Vec<String> = message
            .reactions
            .iter()
            .map(|r| format!(":{}: {}", r.name, r.count))
            .collect();
        out.push_str(&format!("  Reactions: {}\n", summary.join("  ")));
    }

    out
}

fn render_file(file: &SlackFileRef, cache_paths: &HashMap<String, PathBuf>) -> Option<String> {
    let path = cache_paths.get(&file.id);
    let category = file.category.as_str();
    let dims = match (file.width, file.height) {
        (Some(w), Some(h)) => format!(" ({w}×{h})"),
        _ => String::new(),
    };
    let kind_label = match category {
        "image" => "Image",
        "gif" => "GIF",
        "video" => "Video (poster frame)",
        "audio" => "Audio",
        "pdf" => "PDF",
        _ => "File",
    };
    match (path, category) {
        (Some(local_path), "image" | "gif" | "video") => Some(format!(
            // Two-channel framing: the image is already attached to
            // this turn's user message as a vision input (Claude
            // image block / Codex localImage part), so the agent sees
            // pixels without invoking any tool. The local path is
            // kept as a fallback for the cases where vision isn't
            // available — Codex mid-turn `turn/steer` drops images,
            // and an agent that wants a fresh look can always Read
            // the file. Phrasing intentionally avoids "Use the Read
            // tool to view this image", which would falsely imply
            // the agent must call Read to see the picture.
            "  ▸ {kind_label}: {name}{dims}\n    Attached as image (local path: {path})",
            kind_label = kind_label,
            name = file.name,
            dims = dims,
            path = local_path.display(),
        )),
        _ => Some(format!(
            "  ▸ {kind_label}: {name}{dims}{permalink}",
            kind_label = kind_label,
            name = file.name,
            dims = dims,
            permalink = file
                .permalink
                .as_deref()
                .map(|p| format!("\n    Slack link: {p}"))
                .unwrap_or_default(),
        )),
    }
}

/// Strip Slack mrkdwn-style tokens from a message body so the agent
/// sees plain text. Newlines are preserved (unlike the frontend's
/// chip-formatter `formatSlackTextPlain`, which collapses them to
/// single spaces for single-line consumers).
///
/// Same token replacement table as the TS counterpart in
/// `src/lib/slack-text.tsx`; keep them in sync if either side adds
/// support for a new Slack escape.
fn format_text_plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            if let Some((replacement, advance)) = parse_angle_token(&text[i..]) {
                out.push_str(&replacement);
                i += advance;
                continue;
            }
        }
        // Push next character (UTF-8 safe by stepping through chars).
        let ch_end = next_char_boundary(text, i);
        out.push_str(&text[i..ch_end]);
        i = ch_end;
    }
    out
}

/// Parse a `<…>` Slack token starting at the current cursor. Returns
/// the replacement string + how many bytes to advance the cursor past
/// the closing `>`. Returns `None` for unrecognised forms — caller
/// falls back to copying the `<` literal through.
fn parse_angle_token(slice: &str) -> Option<(String, usize)> {
    let close = slice.find('>')?;
    let body = &slice[1..close];
    let total = close + 1;
    if let Some(after_at) = body.strip_prefix('@') {
        // <@U123|name> or <@U123>
        if let Some(pipe) = after_at.find('|') {
            let label = &after_at[pipe + 1..];
            return Some((format!("@{label}"), total));
        }
        return Some((format!("@{after_at}"), total));
    }
    if let Some(after_hash) = body.strip_prefix('#') {
        // <#C123|name> or <#C123>
        if let Some(pipe) = after_hash.find('|') {
            let label = &after_hash[pipe + 1..];
            return Some((format!("#{label}"), total));
        }
        return Some((format!("#{after_hash}"), total));
    }
    // <url|label> or <url>. URLs always start with http(s) or mailto
    // — guard against accidentally swallowing a literal `<` from
    // ordinary prose.
    if body.starts_with("http://") || body.starts_with("https://") || body.starts_with("mailto:") {
        if let Some(pipe) = body.find('|') {
            let label = &body[pipe + 1..];
            return Some((label.to_string(), total));
        }
        return Some((body.to_string(), total));
    }
    None
}

/// Step to the next UTF-8 character boundary so we never split a
/// multi-byte sequence (e.g. emoji, CJK) when we copy bytes through.
fn next_char_boundary(text: &str, mut i: usize) -> usize {
    i += 1;
    while i < text.len() && !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

fn current_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// "22h ago" / "3d ago" / "just now" style relative time.
fn relative_time(now_millis: i64, ts_millis: i64) -> String {
    let delta = now_millis - ts_millis;
    if delta < 60_000 {
        return "just now".to_string();
    }
    let minutes = delta / 60_000;
    if minutes < 60 {
        return format!("{minutes}m ago");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    let days = hours / 24;
    format!("{days}d ago")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slack::types::SlackReactionSummary;

    fn empty_paths() -> HashMap<String, PathBuf> {
        HashMap::new()
    }

    fn make_msg(ts_millis: i64, user_id: &str, author: &str, text: &str) -> SlackMessage {
        SlackMessage {
            ts: format!("{}.000000", ts_millis / 1000),
            user_id: Some(user_id.to_string()),
            author_name: author.to_string(),
            author_avatar_url: None,
            text: text.to_string(),
            ts_millis,
            reactions: Vec::new(),
            files: Vec::new(),
        }
    }

    #[test]
    fn format_text_plain_swaps_user_mentions() {
        let result = format_text_plain("hi <@U08P4HCEJS1|james> and <@U06|caspian>");
        assert_eq!(result, "hi @james and @caspian");
    }

    #[test]
    fn format_text_plain_preserves_newlines() {
        // The body formatter, unlike the frontend chip variant, must
        // keep multi-line bodies intact so the agent sees paragraph
        // breaks the user wrote.
        let result = format_text_plain("line one\n\nline three");
        assert_eq!(result, "line one\n\nline three");
    }

    #[test]
    fn format_text_plain_handles_channel_and_url_tokens() {
        assert_eq!(
            format_text_plain("see <#C03|eng-frontend>"),
            "see #eng-frontend",
        );
        assert_eq!(
            format_text_plain("docs <https://example.com|here>"),
            "docs here",
        );
        assert_eq!(
            format_text_plain("plain <https://example.com>"),
            "plain https://example.com",
        );
    }

    #[test]
    fn format_text_plain_is_utf8_safe() {
        // Multi-byte chars (CJK + emoji) must not be split by the
        // byte-stepping cursor.
        let result = format_text_plain("你好 <@U1|caspian> 😂");
        assert_eq!(result, "你好 @caspian 😂");
    }

    #[test]
    fn format_text_plain_leaves_unknown_angle_tokens_intact() {
        // Bare `<` in prose (e.g. code snippet) shouldn't be eaten by
        // an over-eager parser.
        let result = format_text_plain("if (x < 5) ...");
        assert_eq!(result, "if (x < 5) ...");
    }

    #[test]
    fn select_messages_keeps_root_and_tail_when_over_cap() {
        let messages: Vec<SlackMessage> = (0..10)
            .map(|i| make_msg(1_000 * i, "U1", "alice", &format!("msg {i}")))
            .collect();
        let kept = select_messages(&messages, 3);
        let indices: Vec<usize> = kept.iter().map(|(i, _)| *i).collect();
        // root + last two replies.
        assert_eq!(indices, vec![0, 8, 9]);
    }

    #[test]
    fn select_messages_keeps_everything_when_under_cap() {
        let messages: Vec<SlackMessage> = (0..3)
            .map(|i| make_msg(1_000 * i, "U1", "alice", &format!("m{i}")))
            .collect();
        let kept = select_messages(&messages, 10);
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn format_thread_marks_self_replies_with_you() {
        let detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![
                make_msg(
                    1_700_000_000_000,
                    "U_MICHAEL",
                    "michael",
                    "hey <@U_ME|caspian>",
                ),
                make_msg(1_700_000_100_000, "U_ME", "caspian", "got it"),
            ],
        };
        let cache_paths = empty_paths();
        let out = format_thread_for_agent(
            &detail,
            &AgentContextInputs {
                my_user_id: "U_ME",
                workspace_name: "Dosu",
                cache_paths: &cache_paths,
                max_messages: 100,
            },
        );
        assert!(out.contains("@michael:"));
        assert!(out.contains("@caspian (you):"));
        // mention inside body should be plain-text formatted too.
        assert!(out.contains("hey @caspian"));
        // not the raw token.
        assert!(!out.contains("<@U_ME|caspian>"));
    }

    #[test]
    fn format_thread_emits_local_path_for_cached_image() {
        let mut detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![make_msg(1_700_000_000_000, "U1", "alice", "look:")],
        };
        detail.messages[0].files.push(SlackFileRef {
            id: "F1".into(),
            name: "screenshot.png".into(),
            mimetype: Some("image/png".into()),
            category: "image".into(),
            preview_url: None,
            source_url: None,
            permalink: None,
            width: Some(1920),
            height: Some(1080),
        });
        let mut cache_paths = HashMap::new();
        cache_paths.insert(
            "F1".to_string(),
            PathBuf::from("/tmp/helmor/cache/slack-files/abc.png"),
        );
        let out = format_thread_for_agent(
            &detail,
            &AgentContextInputs {
                my_user_id: "U_ME",
                workspace_name: "Dosu",
                cache_paths: &cache_paths,
                max_messages: 100,
            },
        );
        assert!(out.contains("Image: screenshot.png (1920×1080)"));
        // New phrasing: the image is attached as vision input upstream
        // (Claude image block / Codex localImage part); the local path
        // is a fallback channel, not the primary access route. Must
        // NOT tell the agent to "Use the Read tool" — that would
        // imply Read is required, which is wrong now.
        assert!(
            out.contains("Attached as image (local path: /tmp/helmor/cache/slack-files/abc.png)",)
        );
        assert!(!out.contains("Use the Read tool"));
    }

    #[test]
    fn format_thread_renders_reactions_inline() {
        let mut detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![make_msg(1_700_000_000_000, "U1", "alice", "ship it")],
        };
        detail.messages[0].reactions = vec![
            SlackReactionSummary {
                name: "white_check_mark".into(),
                count: 3,
            },
            SlackReactionSummary {
                name: "rocket".into(),
                count: 1,
            },
        ];
        let cache_paths = empty_paths();
        let out = format_thread_for_agent(
            &detail,
            &AgentContextInputs {
                my_user_id: "U_ME",
                workspace_name: "Dosu",
                cache_paths: &cache_paths,
                max_messages: 100,
            },
        );
        assert!(out.contains("Reactions: :white_check_mark: 3  :rocket: 1"));
    }

    #[test]
    fn format_thread_elides_middle_when_over_cap() {
        let messages: Vec<SlackMessage> = (0..10)
            .map(|i| {
                make_msg(
                    1_700_000_000_000 + i * 60_000,
                    "U1",
                    "alice",
                    &format!("m{i}"),
                )
            })
            .collect();
        let detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages,
        };
        let cache_paths = empty_paths();
        let out = format_thread_for_agent(
            &detail,
            &AgentContextInputs {
                my_user_id: "U_ME",
                workspace_name: "Dosu",
                cache_paths: &cache_paths,
                max_messages: 3,
            },
        );
        assert!(out.contains("10 messages total, 7 elided"));
        assert!(out.contains("[… 7 earlier messages elided …]"));
    }

    fn file_ref(id: &str, name: &str) -> SlackFileRef {
        SlackFileRef {
            id: id.to_string(),
            name: name.to_string(),
            mimetype: Some("image/png".to_string()),
            category: "image".to_string(),
            preview_url: None,
            source_url: None,
            permalink: None,
            width: None,
            height: None,
        }
    }

    #[test]
    fn collect_image_paths_preserves_chronological_order() {
        // Three messages with images interleaved with a text-only
        // reply. The output must enumerate paths in the order the
        // agent will encounter the file references inside `submit_text`.
        let mut msg1 = make_msg(1, "U1", "alice", "first");
        msg1.files.push(file_ref("F1", "first.png"));
        msg1.files.push(file_ref("F2", "second.png"));
        let msg2 = make_msg(2, "U2", "bob", "just text");
        let mut msg3 = make_msg(3, "U1", "alice", "third");
        msg3.files.push(file_ref("F3", "third.png"));

        let detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![msg1, msg2, msg3],
        };
        let mut cache_paths = HashMap::new();
        cache_paths.insert("F1".into(), PathBuf::from("/cache/first.png"));
        cache_paths.insert("F2".into(), PathBuf::from("/cache/second.png"));
        cache_paths.insert("F3".into(), PathBuf::from("/cache/third.png"));

        let paths = collect_image_paths(&detail, &cache_paths);
        assert_eq!(
            paths,
            vec![
                "/cache/first.png".to_string(),
                "/cache/second.png".to_string(),
                "/cache/third.png".to_string(),
            ],
        );
    }

    #[test]
    fn collect_image_paths_dedupes_by_file_id_across_messages() {
        // Slack file shares can be re-attached to multiple replies
        // (forward, "this still applies" reposts). The vec should
        // include each file id exactly once — the first occurrence
        // wins so chip ordering matches the earliest mention in text.
        let mut msg1 = make_msg(1, "U1", "alice", "look");
        msg1.files.push(file_ref("F1", "screenshot.png"));
        let mut msg2 = make_msg(2, "U2", "bob", "+1");
        msg2.files.push(file_ref("F1", "screenshot.png"));
        msg2.files.push(file_ref("F2", "other.png"));

        let detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![msg1, msg2],
        };
        let mut cache_paths = HashMap::new();
        cache_paths.insert("F1".into(), PathBuf::from("/cache/F1.png"));
        cache_paths.insert("F2".into(), PathBuf::from("/cache/F2.png"));

        let paths = collect_image_paths(&detail, &cache_paths);
        assert_eq!(
            paths,
            vec!["/cache/F1.png".to_string(), "/cache/F2.png".to_string()],
        );
    }

    #[test]
    fn collect_image_paths_skips_files_without_cached_path() {
        // A cache-write failure (e.g. transient network error on the
        // Slack CDN) leaves the file out of `cache_paths`. It must
        // not appear in `image_paths` — the corresponding chip would
        // otherwise be a broken <img>. The thread text still mentions
        // the file via the `_ =>` arm of `render_file`, so the agent
        // knows it existed.
        let mut msg = make_msg(1, "U1", "alice", "look");
        msg.files.push(file_ref("F1", "good.png"));
        msg.files.push(file_ref("F2", "bad.png"));

        let detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![msg],
        };
        let mut cache_paths = HashMap::new();
        cache_paths.insert("F1".into(), PathBuf::from("/cache/good.png"));
        // F2 deliberately missing — cache write failed.

        let paths = collect_image_paths(&detail, &cache_paths);
        assert_eq!(paths, vec!["/cache/good.png".to_string()]);
    }

    #[test]
    fn collect_image_paths_empty_when_no_files() {
        let detail = SlackThreadDetail {
            team_id: "T1".into(),
            channel_id: "C1".into(),
            channel_label: "#eng".into(),
            is_thread: true,
            permalink: String::new(),
            messages: vec![make_msg(1, "U1", "alice", "text only")],
        };
        let cache_paths = HashMap::new();
        assert!(collect_image_paths(&detail, &cache_paths).is_empty());
    }
}
