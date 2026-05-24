//! `lark-cli im +chat-search` / `+chat-messages-list` / `+messages-search`
//! / `+messages-mget` typed wrappers.

use anyhow::Result;
use serde_json::Value;

use super::cli::run;

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

fn non_empty(s: &str) -> Option<&str> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}
