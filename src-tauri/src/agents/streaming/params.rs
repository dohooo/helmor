//! `sendMessage` request param assembly + the `/add-dir` linked-directory
//! lookup it depends on. Pure modulo the DB read for linked directories,
//! which is isolated so tests can snapshot the full payload against a
//! seeded workspace row (see `tests/streaming_send_params.rs`).

use serde_json::Value;

/// Inputs to `build_send_message_params`. Grouped into a struct so the
/// constructor stays call-site ergonomic and we don't need to track
/// argument positions.
pub struct BuildSendMessageParamsInput<'a> {
    pub sidecar_session_id: &'a str,
    pub prompt: &'a str,
    pub cli_model: &'a str,
    pub cwd: &'a str,
    pub resume_session_id: Option<&'a str>,
    pub provider: &'a str,
    pub effort_level: Option<&'a str>,
    pub permission_mode: Option<&'a str>,
    pub fast_mode: bool,
    pub helmor_session_id: Option<&'a str>,
    pub claude_base_url: Option<&'a str>,
    pub claude_auth_token: Option<&'a str>,
    /// Image attachments to forward to the sidecar. Omitted from the
    /// wire payload when empty.
    pub images: &'a [String],
}

/// Build the `sendMessage` request params that the sidecar receives.
///
/// `additionalDirectories` and `sourceRepoPath` are omitted when absent
/// so the sidecar payload stays tight and existing snapshot fixtures
/// for untouched sessions don't churn.
pub fn build_send_message_params(input: BuildSendMessageParamsInput<'_>) -> Value {
    let additional_directories = lookup_workspace_linked_directories(input.helmor_session_id);
    let source_repo_path = lookup_workspace_repo_root_path(input.helmor_session_id);

    let mut params = serde_json::json!({
        "sessionId": input.sidecar_session_id,
        "prompt": input.prompt,
        "model": input.cli_model,
        "cwd": input.cwd,
        "resume": input.resume_session_id,
        "provider": input.provider,
        "effortLevel": input.effort_level,
        "permissionMode": input.permission_mode,
        "fastMode": input.fast_mode,
    });
    if !additional_directories.is_empty() {
        if let Some(obj) = params.as_object_mut() {
            obj.insert(
                "additionalDirectories".to_string(),
                Value::from(additional_directories),
            );
        }
    }
    if let Some(path) = source_repo_path {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("sourceRepoPath".to_string(), Value::from(path));
        }
    }
    if !input.images.is_empty() {
        if let Some(obj) = params.as_object_mut() {
            obj.insert("images".to_string(), Value::from(input.images.to_vec()));
        }
    }
    if let (Some(base_url), Some(auth_token)) = (input.claude_base_url, input.claude_auth_token) {
        if let Some(obj) = params.as_object_mut() {
            obj.insert(
                "claudeEnvironment".to_string(),
                serde_json::json!({
                    "ANTHROPIC_BASE_URL": base_url,
                    "ANTHROPIC_AUTH_TOKEN": auth_token,
                }),
            );
        }
    }
    params
}

/// Load the workspace's `/add-dir` list via the helmor session id. Returns
/// an empty vec if the session is not yet persisted or the workspace has
/// no linked directories — both are normal states. DB read failures are
/// degraded to an empty list (the feature is best-effort per turn) but
/// logged so a broken DB surfaces in the logs instead of as "my
/// /add-dir silently stopped working".
pub fn lookup_workspace_linked_directories(helmor_session_id: Option<&str>) -> Vec<String> {
    let Some(hsid) = helmor_session_id else {
        return Vec::new();
    };
    let conn = match crate::models::db::read_conn() {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                helmor_session_id = %hsid,
                error = %err,
                "Failed to open DB for linked-directory lookup; falling back to empty list",
            );
            return Vec::new();
        }
    };
    let raw: Option<String> = match conn.query_row(
        r#"SELECT w.linked_directory_paths
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           WHERE s.id = ?1"#,
        [hsid],
        |row| row.get(0),
    ) {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(err) => {
            tracing::warn!(
                helmor_session_id = %hsid,
                error = %err,
                "linked_directory_paths query failed; falling back to empty list",
            );
            return Vec::new();
        }
    };
    crate::workspaces::parse_linked_directory_paths(raw.as_deref())
}

/// Resolve the source repo root path for a helmor session. Sidecar uses
/// it to read project-scope MCP servers from `~/.claude.json` (the
/// worktree cwd never matches the user's registered project key, so
/// without this hint Claude sees only user-scope MCPs).
pub fn lookup_workspace_repo_root_path(helmor_session_id: Option<&str>) -> Option<String> {
    let hsid = helmor_session_id?;
    let conn = match crate::models::db::read_conn() {
        Ok(c) => c,
        Err(err) => {
            tracing::warn!(
                helmor_session_id = %hsid,
                error = %err,
                "Failed to open DB for repo root_path lookup; falling back to None",
            );
            return None;
        }
    };
    match conn.query_row(
        r#"SELECT r.root_path
           FROM sessions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN repos r ON r.id = w.repository_id
           WHERE s.id = ?1"#,
        [hsid],
        |row| row.get::<_, Option<String>>(0),
    ) {
        Ok(Some(path)) if !path.is_empty() => Some(path),
        Ok(_) => None,
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(err) => {
            tracing::warn!(
                helmor_session_id = %hsid,
                error = %err,
                "repo root_path query failed; falling back to None",
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_test_db<F: FnOnce(&rusqlite::Connection)>(name: &str, f: F) {
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
            "INSERT INTO repos (id, name, default_branch) VALUES ('r-1', ?1, 'main')",
            [name],
        )
        .unwrap();
        f(&conn);
        std::env::remove_var("HELMOR_DATA_DIR");
    }

    fn insert_ws_session(
        conn: &rusqlite::Connection,
        ws_id: &str,
        sess_id: &str,
        linked: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO workspaces (id, repository_id, directory_name, state,
             status, linked_directory_paths) VALUES (?1, 'r-1', 'ws', 'ready',
             'in-progress', ?2)",
            rusqlite::params![ws_id, linked],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status) VALUES (?1, ?2, 'idle')",
            [sess_id, ws_id],
        )
        .unwrap();
    }

    #[test]
    fn returns_empty_when_session_id_is_missing() {
        with_test_db("noop", |_conn| {
            assert!(lookup_workspace_linked_directories(None).is_empty());
        });
    }

    #[test]
    fn returns_empty_when_session_row_not_found() {
        with_test_db("orphan", |_conn| {
            assert!(lookup_workspace_linked_directories(Some("unknown-session")).is_empty());
        });
    }

    #[test]
    fn returns_empty_when_linked_column_is_null() {
        with_test_db("null-col", |conn| {
            insert_ws_session(conn, "w-1", "s-1", None);
            assert!(lookup_workspace_linked_directories(Some("s-1")).is_empty());
        });
    }

    #[test]
    fn returns_parsed_list_when_linked_column_populated() {
        with_test_db("populated", |conn| {
            insert_ws_session(conn, "w-2", "s-2", Some(r#"["/abs/a","/abs/b"]"#));
            assert_eq!(
                lookup_workspace_linked_directories(Some("s-2")),
                vec!["/abs/a".to_string(), "/abs/b".to_string()],
            );
        });
    }

    #[test]
    fn returns_empty_when_json_is_malformed() {
        with_test_db("malformed", |conn| {
            insert_ws_session(conn, "w-3", "s-3", Some("not json"));
            assert!(lookup_workspace_linked_directories(Some("s-3")).is_empty());
        });
    }

    #[test]
    fn trims_and_dedupes_at_parse_time() {
        with_test_db("normalize", |conn| {
            insert_ws_session(
                conn,
                "w-4",
                "s-4",
                Some(r#"["  /abs/a  ","/abs/a","","/abs/b"]"#),
            );
            assert_eq!(
                lookup_workspace_linked_directories(Some("s-4")),
                vec!["/abs/a".to_string(), "/abs/b".to_string()],
            );
        });
    }
}
