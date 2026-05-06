//! Cleanup path for abnormal stream exits — heartbeat timeouts and
//! channel disconnects. Unlike the normal `end | aborted | error`
//! finalization (which lives inline in the event loop), this path has
//! no terminal sidecar event to act on, so we synthesize one:
//! persist a generic error message and flip the session row to `idle`.
//!
//! Kept as a free fn so both the timeout/disconnect match arms in
//! `streaming/mod.rs` and the regression tests below drive the same
//! code path.

use crate::agents::{finalize_session_metadata, persist_error_message, ExchangeContext};

/// Persist an error message and finalize the session after an abnormal
/// stream exit (heartbeat timeout, channel disconnect). Returns `true` iff
/// the session row was successfully transitioned to `idle`.
pub(crate) fn cleanup_abnormal_stream_exit(
    rid: &str,
    exchange_ctx: Option<&ExchangeContext>,
    resolved_model: &str,
    user_message: &str,
    effort_level: Option<&str>,
    permission_mode: Option<&str>,
) -> bool {
    let Some(ctx) = exchange_ctx else {
        tracing::debug!(
            rid = %rid,
            "cleanup_abnormal_stream_exit: no exchange_ctx — nothing to finalize"
        );
        return false;
    };
    let conn = match crate::models::db::write_conn() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(
                rid = %rid,
                session_id = %ctx.helmor_session_id,
                "cleanup_abnormal_stream_exit: write_conn borrow failed — session may be stuck: {e}"
            );
            return false;
        }
    };

    let err_persist_ok = match persist_error_message(&conn, ctx, resolved_model, user_message) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(
                rid = %rid,
                session_id = %ctx.helmor_session_id,
                "cleanup_abnormal_stream_exit: persist_error_message failed: {error}"
            );
            false
        }
    };

    // Clear the stored provider_session_id — the sidecar/SDK was killed
    // mid-write, so the provider's conversation jsonl is likely corrupt
    // (or at least undefined). Reusing the same id on the next send
    // makes Claude return an immediate empty result that we'd misread
    // as success, permanently bricking the thread (issue #398).
    if let Err(error) = conn.execute(
        "UPDATE sessions SET provider_session_id = NULL WHERE id = ?1",
        rusqlite::params![ctx.helmor_session_id],
    ) {
        tracing::error!(
            rid = %rid,
            session_id = %ctx.helmor_session_id,
            "cleanup_abnormal_stream_exit: failed to clear provider_session_id: {error}"
        );
    }

    match finalize_session_metadata(&conn, ctx, "idle", effort_level, permission_mode) {
        Ok(_) => {
            tracing::debug!(
                rid = %rid,
                session_id = %ctx.helmor_session_id,
                err_persist_ok,
                "cleanup_abnormal_stream_exit: session finalized to idle"
            );
            true
        }
        Err(error) => {
            tracing::error!(
                rid = %rid,
                session_id = %ctx.helmor_session_id,
                "cleanup_abnormal_stream_exit: finalize_session_metadata failed: {error}"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_session<F: FnOnce()>(session_status: &str, f: F) {
        with_session_and_provider_id(session_status, None, f);
    }

    fn with_session_and_provider_id<F: FnOnce()>(
        session_status: &str,
        provider_session_id: Option<&str>,
        f: F,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::data_dir::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::env::set_var("HELMOR_DATA_DIR", dir.path());
        crate::data_dir::ensure_directory_structure().unwrap();

        let db_path = crate::data_dir::db_path().unwrap();
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, default_branch) VALUES ('r-1', 'r', 'main')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state, status)
             VALUES ('w-1', 'r-1', 'd', 'ready', 'in-progress')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status, title, provider_session_id)
             VALUES (?1, 'w-1', ?2, 't', ?3)",
            rusqlite::params!["s-1", session_status, provider_session_id],
        )
        .unwrap();
        drop(conn);

        f();

        std::env::remove_var("HELMOR_DATA_DIR");
    }

    fn provider_session_id() -> Option<String> {
        crate::models::db::read_conn()
            .unwrap()
            .query_row(
                "SELECT provider_session_id FROM sessions WHERE id = 's-1'",
                [],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap()
    }

    fn ctx() -> ExchangeContext {
        ExchangeContext {
            helmor_session_id: "s-1".to_string(),
            model_id: "opus".to_string(),
            model_provider: "claude".to_string(),
            user_message_id: "user-1".to_string(),
        }
    }

    fn session_status() -> String {
        crate::models::db::read_conn()
            .unwrap()
            .query_row("SELECT status FROM sessions WHERE id = 's-1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
    }

    fn error_message_count() -> i64 {
        crate::models::db::read_conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM session_messages
                 WHERE session_id = 's-1' AND content LIKE '%sidecar%'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
    }

    #[test]
    fn finalizes_session_to_idle_and_persists_error_message() {
        with_session("streaming", || {
            let persisted = cleanup_abnormal_stream_exit(
                "rid-1",
                Some(&ctx()),
                "opus",
                "sidecar dead, retry",
                None,
                None,
            );
            assert!(persisted, "expected persisted=true on successful finalize");
            assert_eq!(session_status(), "idle");
            assert_eq!(error_message_count(), 1);
        });
    }

    #[test]
    fn returns_false_and_does_not_touch_db_when_exchange_ctx_is_none() {
        with_session("streaming", || {
            let persisted =
                cleanup_abnormal_stream_exit("rid-2", None, "opus", "sidecar dead", None, None);
            assert!(!persisted);
            assert_eq!(session_status(), "streaming");
            assert_eq!(error_message_count(), 0);
        });
    }

    #[test]
    fn returns_false_when_session_row_does_not_exist() {
        with_session("streaming", || {
            let mut bad_ctx = ctx();
            bad_ctx.helmor_session_id = "nonexistent".to_string();
            let persisted = cleanup_abnormal_stream_exit(
                "rid-3",
                Some(&bad_ctx),
                "opus",
                "sidecar dead",
                None,
                None,
            );
            assert!(!persisted);
        });
    }

    #[test]
    fn clears_provider_session_id_so_next_send_starts_fresh() {
        with_session_and_provider_id("streaming", Some("provider-sid-stale"), || {
            assert_eq!(
                provider_session_id().as_deref(),
                Some("provider-sid-stale"),
                "precondition: row starts with a provider session id",
            );
            let persisted = cleanup_abnormal_stream_exit(
                "rid-clear",
                Some(&ctx()),
                "opus",
                "sidecar dead, retry",
                None,
                None,
            );
            assert!(persisted);
            assert_eq!(
                provider_session_id(),
                None,
                "abnormal exit must clear provider_session_id so the next send doesn't \
                 replay a corrupt resume target (issue #398)",
            );
        });
    }
}
