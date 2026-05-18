//! Persist `contextUsageUpdated` sidecar events into the session row and
//! broadcast a `ContextUsageChanged` UI mutation. The frontend pulls fresh
//! meta from the DB via React Query — we don't ship the payload over the
//! Tauri channel, only the invalidation cue.

use rusqlite::params;
use serde_json::Value;
use tauri::AppHandle;

/// Outcome of parsing+writing a `contextUsageUpdated` event.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ContextUsageWriteOutcome {
    /// Malformed event (missing/empty sessionId or meta).
    Skipped,
    /// Event valid, DB row updated.
    Wrote(String),
    /// Event valid but no row matched the sessionId. Don't broadcast —
    /// nobody is subscribed to a ghost session, and silently treating it
    /// as a successful write would mask sidecar/DB races.
    UnknownSession(String),
}

pub(super) fn write_context_usage_meta(
    conn: &rusqlite::Connection,
    raw: &Value,
) -> std::result::Result<ContextUsageWriteOutcome, rusqlite::Error> {
    let Some(session_id) = raw.get("sessionId").and_then(Value::as_str) else {
        return Ok(ContextUsageWriteOutcome::Skipped);
    };
    if session_id.is_empty() {
        return Ok(ContextUsageWriteOutcome::Skipped);
    }
    let Some(meta) = raw.get("meta").and_then(Value::as_str) else {
        return Ok(ContextUsageWriteOutcome::Skipped);
    };
    let affected = conn.execute(
        "UPDATE sessions SET context_usage_meta = ?1 WHERE id = ?2",
        params![meta, session_id],
    )?;
    if affected == 0 {
        return Ok(ContextUsageWriteOutcome::UnknownSession(
            session_id.to_string(),
        ));
    }
    Ok(ContextUsageWriteOutcome::Wrote(session_id.to_string()))
}

/// Frontend-driven write: persist a verified meta blob (e.g. from a
/// trustworthy hover-time live fetch) and broadcast the same
/// `ContextUsageChanged` event the sidecar path uses, so observers in
/// other windows refresh without us touching their query cache directly.
pub(crate) fn persist_context_usage_meta(app: &AppHandle, session_id: &str, meta: &str) {
    let raw = serde_json::json!({ "sessionId": session_id, "meta": meta });
    persist_context_usage_event(app, &raw);
}

/// Persist a `contextUsageUpdated` event and broadcast `ContextUsageChanged`.
/// Payload-free — the frontend refetches via React Query on invalidation.
pub(super) fn persist_context_usage_event(app: &AppHandle, raw: &Value) {
    let outcome = match crate::models::db::write_conn() {
        Ok(conn) => match write_context_usage_meta(&conn, raw) {
            Ok(outcome) => outcome,
            Err(err) => {
                tracing::warn!("Failed to persist context_usage_meta: {err}");
                return;
            }
        },
        Err(err) => {
            tracing::warn!("context_usage write_conn borrow failed: {err}");
            return;
        }
    };
    let session_id = match outcome {
        ContextUsageWriteOutcome::Skipped => {
            tracing::warn!("contextUsageUpdated event malformed (missing sessionId or meta)");
            return;
        }
        ContextUsageWriteOutcome::UnknownSession(id) => {
            tracing::warn!(
                session_id = %id,
                "contextUsageUpdated for unknown session — likely a stale/post-delete event"
            );
            return;
        }
        ContextUsageWriteOutcome::Wrote(id) => id,
    };
    crate::ui_sync::publish(
        app,
        crate::ui_sync::UiMutationEvent::ContextUsageChanged { session_id },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_test_db_with_session(session_id: &str) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status) VALUES (?1, 'w1', 'idle')",
            [session_id],
        )
        .unwrap();
        conn
    }

    fn read_meta(conn: &rusqlite::Connection, session_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT context_usage_meta FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .unwrap()
    }

    #[test]
    fn write_context_usage_meta_persists_string() {
        let conn = open_test_db_with_session("s1");
        let raw = serde_json::json!({
            "sessionId": "s1",
            "meta": r#"{"usedTokens":42,"maxTokens":1000,"percentage":4.2}"#,
        });
        let outcome = write_context_usage_meta(&conn, &raw).unwrap();
        assert_eq!(outcome, ContextUsageWriteOutcome::Wrote("s1".to_string()));
        assert_eq!(
            read_meta(&conn, "s1").as_deref(),
            Some(r#"{"usedTokens":42,"maxTokens":1000,"percentage":4.2}"#)
        );
    }

    #[test]
    fn write_context_usage_meta_skips_when_meta_null() {
        let conn = open_test_db_with_session("s1");
        conn.execute(
            "UPDATE sessions SET context_usage_meta = '{}' WHERE id = 's1'",
            [],
        )
        .unwrap();
        let raw = serde_json::json!({ "sessionId": "s1", "meta": null });
        let outcome = write_context_usage_meta(&conn, &raw).unwrap();
        assert_eq!(outcome, ContextUsageWriteOutcome::Skipped);
        assert_eq!(read_meta(&conn, "s1").as_deref(), Some("{}"));
    }

    #[test]
    fn write_context_usage_meta_skips_when_session_id_missing() {
        let conn = open_test_db_with_session("s1");
        for raw in [
            serde_json::json!({}),
            serde_json::json!({ "sessionId": "" }),
            serde_json::json!({ "sessionId": null, "meta": "{}" }),
        ] {
            let outcome = write_context_usage_meta(&conn, &raw).unwrap();
            assert_eq!(outcome, ContextUsageWriteOutcome::Skipped);
        }
        assert!(read_meta(&conn, "s1").is_none());
    }

    #[test]
    fn write_context_usage_meta_reports_unknown_session() {
        // UPDATE against a non-existent id affects 0 rows. The outcome must
        // distinguish this from a real write so persist_context_usage_event
        // can skip the broadcast — silently treating it as a write would
        // mask sidecar/DB races (stale event after delete, etc.).
        let conn = open_test_db_with_session("s1");
        let raw = serde_json::json!({ "sessionId": "ghost", "meta": "{}" });
        let outcome = write_context_usage_meta(&conn, &raw).unwrap();
        assert_eq!(
            outcome,
            ContextUsageWriteOutcome::UnknownSession("ghost".to_string())
        );
        assert!(read_meta(&conn, "s1").is_none());
    }
}
