//! Typed wrappers around `lark-cli im` subcommands.

use std::path::Path;

use anyhow::Result;
use serde_json::Value;

use super::cli::{run, run_in};

pub struct ChatList<'a> {
    /// Use `ByActiveTimeDesc` for triage — most-recent activity first
    /// is the only sort the fetcher cares about.
    pub sort_type: &'a str,
    /// User-identity only — drops chats the user has muted (DND).
    pub exclude_muted: bool,
    pub page_size: u32,
}

pub async fn chat_list(p: ChatList<'_>) -> Result<Value> {
    let page_size = p.page_size.clamp(1, 100).to_string();
    let mut args: Vec<String> = vec![
        "im".into(),
        "+chat-list".into(),
        "--format".into(),
        "json".into(),
        "--sort-type".into(),
        p.sort_type.into(),
        "--page-size".into(),
        page_size,
    ];
    if p.exclude_muted {
        args.push("--exclude-muted".into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&refs, "chat-list").await
}

pub struct ChatSearch<'a> {
    pub query: Option<&'a str>,
    pub member_ids: Option<&'a str>,
    pub page_size: u32,
}

pub async fn chat_search(p: ChatSearch<'_>) -> Result<Value> {
    let page_size = p.page_size.clamp(1, 100).to_string();
    let mut args: Vec<String> = vec![
        "im".into(),
        "+chat-search".into(),
        "--format".into(),
        "json".into(),
    ];
    if let Some(q) = p.query.and_then(non_empty) {
        args.push("--query".into());
        args.push(q.into());
    }
    if let Some(m) = p.member_ids.and_then(non_empty) {
        args.push("--member-ids".into());
        args.push(m.into());
    }
    args.push("--page-size".into());
    args.push(page_size);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&refs, "chat-search").await
}

pub struct ChatMessages<'a> {
    pub chat_id: &'a str,
    pub page_size: u32,
    pub start: Option<&'a str>,
}

pub async fn chat_messages_list(p: ChatMessages<'_>) -> Result<Value> {
    let page_size = p.page_size.clamp(1, 50).to_string();
    let mut args: Vec<String> = vec![
        "im".into(),
        "+chat-messages-list".into(),
        "--format".into(),
        "json".into(),
        "--chat-id".into(),
        p.chat_id.into(),
        "--page-size".into(),
        page_size,
        "--sort".into(),
        "desc".into(),
    ];
    if let Some(s) = p.start.and_then(non_empty) {
        args.push("--start".into());
        args.push(s.into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&refs, "chat-messages-list").await
}

pub struct MessagesSearch<'a> {
    pub query: Option<&'a str>,
    pub sender: Option<&'a str>,
    pub chat_id: Option<&'a str>,
    pub is_at_me: bool,
    pub start: Option<&'a str>,
    pub end: Option<&'a str>,
    pub page_size: u32,
}

pub async fn messages_search(p: MessagesSearch<'_>) -> Result<Value> {
    let page_size = p.page_size.clamp(1, 50).to_string();
    let mut args: Vec<String> = vec![
        "im".into(),
        "+messages-search".into(),
        "--format".into(),
        "json".into(),
    ];
    if let Some(q) = p.query.and_then(non_empty) {
        args.push("--query".into());
        args.push(q.into());
    }
    if let Some(s) = p.sender.and_then(non_empty) {
        args.push("--sender".into());
        args.push(s.into());
    }
    if let Some(c) = p.chat_id.and_then(non_empty) {
        args.push("--chat-id".into());
        args.push(c.into());
    }
    if p.is_at_me {
        args.push("--is-at-me".into());
    }
    if let Some(s) = p.start.and_then(non_empty) {
        args.push("--start".into());
        args.push(s.into());
    }
    if let Some(e) = p.end.and_then(non_empty) {
        args.push("--end".into());
        args.push(e.into());
    }
    args.push("--page-size".into());
    args.push(page_size);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&refs, "messages-search").await
}

pub async fn messages_get(message_ids: &str) -> Result<Value> {
    run(
        &[
            "im",
            "+messages-mget",
            "--format",
            "json",
            "--message-ids",
            message_ids,
        ],
        "messages-mget",
    )
    .await
}

// `output_filename` must be relative — lark-cli rejects `..`, so caller passes the staging cwd.
pub async fn download_resource(
    message_id: &str,
    kind: &str,
    file_key: &str,
    cwd: &Path,
    output_filename: &str,
) -> Result<()> {
    run_in(
        &[
            "im",
            "+messages-resources-download",
            "--message-id",
            message_id,
            "--type",
            kind,
            "--file-key",
            file_key,
            "--output",
            output_filename,
        ],
        Some(cwd),
        "messages-resources-download",
    )
    .await?;
    Ok(())
}

fn non_empty(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}
