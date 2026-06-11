use anyhow::{Context, Result};
use rusqlite::params;
use serde_json::{json, Value};

use crate::pipeline::types::HistoricalRecord;

pub const SEARCH_LIMIT_MAX: usize = 20;
pub const GET_MESSAGES_LIMIT_MAX: usize = 20;
pub const BODY_LIMIT_MAX: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionWindowPosition {
    Head,
    Tail,
}

impl SessionWindowPosition {
    pub fn from_mcp_value(value: &str) -> Self {
        if value.eq_ignore_ascii_case("head") {
            Self::Head
        } else {
            Self::Tail
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Head => "head",
            Self::Tail => "tail",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionBodyPosition {
    Start,
    End,
}

impl SessionBodyPosition {
    pub fn from_mcp_value(value: &str) -> Self {
        if value.eq_ignore_ascii_case("end") {
            Self::End
        } else {
            Self::Start
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionSearchOptions<'a> {
    pub query: Option<&'a str>,
    pub repo_name_filter: Option<&'a str>,
    pub status: Option<&'a str>,
    pub include_archived: bool,
    pub limit: usize,
}

pub fn search_sessions(options: SessionSearchOptions<'_>) -> Result<Value> {
    let trimmed_query = options.query.map(str::trim).filter(|s| !s.is_empty());
    let status_filter = options
        .status
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);
    if trimmed_query.is_none() && status_filter.is_none() {
        anyhow::bail!("session search: provide query or status");
    }

    let limit = options.limit.clamp(1, SEARCH_LIMIT_MAX);
    let repo_name_filter = options
        .repo_name_filter
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);
    let like = trimmed_query.map(|q| format!("%{}%", q.to_ascii_lowercase()));

    let conn = super::db::read_conn()?;
    let mut statement = conn.prepare(
        r#"
        SELECT
          s.id,
          s.workspace_id,
          s.title,
          s.agent_type,
          s.status,
          s.model,
          s.permission_mode,
          s.updated_at,
          s.last_user_message_at,
          s.action_kind,
          w.active_session_id,
          w.directory_name,
          w.state,
          COALESCE(w.status, 'in-progress') AS workspace_status,
          r.name AS repo_name
        FROM sessions s
        JOIN workspaces w ON w.id = s.workspace_id
        JOIN repos r ON r.id = w.repository_id
        WHERE COALESCE(s.is_hidden, 0) = 0
          AND (?2 OR w.state != 'archived')
          AND (?3 IS NULL OR lower(r.name) = ?3)
          AND (
            ?1 IS NULL
            OR lower(s.title) LIKE ?1
            OR EXISTS (
              SELECT 1
              FROM session_messages sm
              WHERE sm.session_id = s.id AND lower(sm.content) LIKE ?1
            )
          )
        ORDER BY
          CASE WHEN ?1 IS NOT NULL AND lower(s.title) LIKE ?1 THEN 0 ELSE 1 END,
          datetime(s.updated_at) DESC,
          s.id DESC
        "#,
    )?;

    let rows = statement.query_map(
        params![like, options.include_archived, repo_name_filter],
        |row| {
            let session_id: String = row.get(0)?;
            let workspace_id: String = row.get(1)?;
            let title: String = row.get(2)?;
            let session_status: String = row.get(4)?;
            let active_session_id: Option<String> = row.get(10)?;
            let directory: String = row.get(11)?;
            let repo_name: String = row.get(14)?;
            Ok(json!({
                "sessionId": session_id,
                "workspaceId": workspace_id,
                "workspaceRef": format!("{repo_name}/{directory}"),
                "workspaceDirectory": directory,
                "workspaceState": row.get::<_, String>(12)?,
                "workspaceStatus": row.get::<_, String>(13)?,
                "repo": repo_name,
                "title": title,
                "sessionStatus": session_status,
                "active": active_session_id.as_deref() == Some(session_id.as_str()),
                "agentType": row.get::<_, Option<String>>(3)?,
                "model": row.get::<_, Option<String>>(5)?,
                "permissionMode": row.get::<_, String>(6)?,
                "updatedAt": row.get::<_, String>(7)?,
                "lastUserMessageAt": row.get::<_, Option<String>>(8)?,
                "actionKind": row.get::<_, Option<String>>(9)?,
            }))
        },
    )?;

    let mut sessions: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for row in rows {
        let row = row?;
        if let Some(wanted) = status_filter.as_deref() {
            let stored = row.get("sessionStatus").and_then(Value::as_str);
            if !stored
                .map(|s| s.eq_ignore_ascii_case(wanted))
                .unwrap_or(false)
            {
                continue;
            }
        }
        total += 1;
        if sessions.len() < limit {
            sessions.push(row);
        }
    }

    let returned = sessions.len();
    Ok(json!({
        "sessions": sessions,
        "returned": returned,
        "total": total,
        "hasMore": total > returned,
    }))
}

pub fn get_session_messages(
    session_id: &str,
    limit: usize,
    position: SessionWindowPosition,
    body_limit: usize,
    body_position: SessionBodyPosition,
) -> Result<Value> {
    let limit = limit.clamp(1, GET_MESSAGES_LIMIT_MAX);
    let body_limit = body_limit.clamp(1, BODY_LIMIT_MAX);
    let (records, total_messages) = list_session_records(session_id, limit, position)?;
    let has_more = total_messages > records.len();

    let messages: Vec<Value> = records
        .iter()
        .map(|record| {
            let summary = summarize_historical_record(record);
            let total = summary.chars().count();
            let take = body_limit.min(total);
            let offset = match body_position {
                SessionBodyPosition::End => total.saturating_sub(take),
                SessionBodyPosition::Start => 0,
            };
            let body: String = summary.chars().skip(offset).take(take).collect();
            let returned = body.chars().count();
            json!({
                "id": record.id,
                "role": record.role,
                "createdAt": record.created_at,
                "body": body,
                "bodyOffset": offset,
                "bodyLength": returned,
                "bodyTotal": total,
                "bodyHasMore": returned < total,
            })
        })
        .collect();

    Ok(json!({
        "messages": messages,
        "windowSize": records.len(),
        "windowPosition": position.as_str(),
        "windowHasMore": has_more,
        "totalMessages": total_messages,
        "total": total_messages,
        "hasMore": has_more,
    }))
}

/// SQL window into `session_messages`. Returns rows in chronological
/// order regardless of `position`; `position == Tail` selects the newest
/// `limit` rows.
fn list_session_records(
    session_id: &str,
    limit: usize,
    position: SessionWindowPosition,
) -> Result<(Vec<HistoricalRecord>, usize)> {
    let connection = super::db::read_conn()?;
    let total: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .context("Failed to count session messages")?;

    let order = match position {
        SessionWindowPosition::Head => "ASC",
        SessionWindowPosition::Tail => "DESC",
    };
    let mut statement = connection.prepare(&format!(
        r#"
        SELECT
          sm.id,
          sm.role,
          sm.content,
          sm.created_at
        FROM session_messages sm
        WHERE sm.session_id = ?1
        ORDER BY sm.sent_at {order}, sm.rowid {order}
        LIMIT ?2
        "#
    ))?;
    let rows = statement.query_map(params![session_id, limit as i64], |row| {
        let content: String = row.get(2)?;
        Ok(HistoricalRecord {
            id: row.get(0)?,
            role: row.get(1)?,
            parsed_content: serde_json::from_str::<Value>(&content).ok(),
            content,
            created_at: row.get(3)?,
        })
    })?;
    let mut records = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    if matches!(position, SessionWindowPosition::Tail) {
        records.reverse();
    }
    Ok((records, total.max(0) as usize))
}

mod summarize;

use summarize::summarize_historical_record;
