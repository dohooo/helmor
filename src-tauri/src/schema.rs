//! Database schema initialization for Helmor.
//!
//! Creates all required tables if they don't exist, matching the Conductor
//! schema for data compatibility.

use anyhow::{Context, Result};
use rusqlite::Connection;

/// Ensure the database has all required tables and indexes.
/// Safe to call on every startup — uses IF NOT EXISTS.
pub fn ensure_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(SCHEMA_SQL)
        .context("Failed to initialize database schema")
}

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS repos (
    id TEXT PRIMARY KEY,
    remote_url TEXT,
    name TEXT,
    default_branch TEXT DEFAULT 'main',
    root_path TEXT,
    setup_script TEXT,
    archive_script TEXT,
    display_order INTEGER DEFAULT 0,
    run_script TEXT,
    run_script_mode TEXT DEFAULT 'concurrent',
    remote TEXT,
    custom_prompt_code_review TEXT,
    custom_prompt_create_pr TEXT,
    custom_prompt_rename_branch TEXT,
    conductor_config TEXT,
    custom_prompt_general TEXT,
    icon TEXT,
    hidden INTEGER DEFAULT 0,
    custom_prompt_fix_errors TEXT,
    custom_prompt_resolve_merge_conflicts TEXT,
    storage_version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    repository_id TEXT,
    directory_name TEXT,
    active_session_id TEXT,
    branch TEXT,
    state TEXT DEFAULT 'active',
    derived_status TEXT DEFAULT 'in-progress',
    manual_status TEXT,
    unread INTEGER DEFAULT 0,
    placeholder_branch_name TEXT,
    initialization_parent_branch TEXT,
    big_terminal_mode INTEGER DEFAULT 0,
    setup_log_path TEXT,
    initialization_log_path TEXT,
    initialization_files_copied INTEGER,
    pinned_at TEXT,
    linked_workspace_ids TEXT,
    notes TEXT,
    intended_target_branch TEXT,
    pr_title TEXT,
    pr_description TEXT,
    archive_commit TEXT,
    secondary_directory_name TEXT,
    linked_directory_paths TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    DEPRECATED_city_name TEXT,
    DEPRECATED_archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    status TEXT DEFAULT 'idle',
    claude_session_id TEXT,
    unread_count INTEGER DEFAULT 0,
    freshly_compacted INTEGER DEFAULT 0,
    context_token_count INTEGER DEFAULT 0,
    is_compacting INTEGER DEFAULT 0,
    model TEXT,
    permission_mode TEXT DEFAULT 'default',
    last_user_message_at TEXT,
    resume_session_at TEXT,
    is_hidden INTEGER DEFAULT 0,
    agent_type TEXT,
    title TEXT DEFAULT 'Untitled',
    context_used_percent REAL,
    thinking_enabled INTEGER DEFAULT 1,
    codex_thinking_level TEXT,
    fast_mode INTEGER DEFAULT 0,
    agent_personality TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    DEPRECATED_thinking_level TEXT DEFAULT 'NONE'
);

CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,
    content TEXT,
    sent_at TEXT,
    full_message TEXT,
    cancelled_at TEXT,
    model TEXT,
    sdk_message_id TEXT,
    last_assistant_message_id TEXT,
    turn_id TEXT,
    is_resumable_message INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    session_message_id TEXT,
    type TEXT,
    original_name TEXT,
    path TEXT,
    is_loading INTEGER DEFAULT 0,
    is_draft INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diff_comments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    file_path TEXT,
    line_number INTEGER,
    body TEXT,
    state TEXT,
    location TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    remote_url TEXT,
    author TEXT,
    author_avatar_url TEXT,
    thread_id TEXT,
    reply_to_comment_id TEXT,
    is_outdated INTEGER,
    is_resolved INTEGER,
    end_line_number INTEGER,
    DEPRECATED_update_memory INTEGER
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_attachments_session_id ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session_message_id ON attachments(session_message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_is_draft ON attachments(is_draft);
CREATE INDEX IF NOT EXISTS idx_session_messages_sent_at ON session_messages(session_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_cancelled_at ON session_messages(session_id, cancelled_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_turn_id ON session_messages(turn_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_diff_comments_workspace ON diff_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);

-- Triggers (use CREATE TRIGGER IF NOT EXISTS where supported, otherwise wrapped)
CREATE TRIGGER IF NOT EXISTS update_repos_updated_at
    AFTER UPDATE ON repos
    BEGIN
        UPDATE repos SET updated_at = datetime('now')
        WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_settings_updated_at
    AFTER UPDATE ON settings
    BEGIN
        UPDATE settings SET updated_at = datetime('now')
        WHERE key = NEW.key;
    END;

CREATE TRIGGER IF NOT EXISTS update_sessions_updated_at
    AFTER UPDATE ON sessions
    BEGIN
        UPDATE sessions SET updated_at = datetime('now')
        WHERE id = NEW.id;
    END;
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_schema_creates_tables() {
        let connection = Connection::open_in_memory().unwrap();
        ensure_schema(&connection).unwrap();

        // Verify tables exist
        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        assert!(tables.contains(&"repos".to_string()));
        assert!(tables.contains(&"workspaces".to_string()));
        assert!(tables.contains(&"sessions".to_string()));
        assert!(tables.contains(&"session_messages".to_string()));
        assert!(tables.contains(&"attachments".to_string()));
        assert!(tables.contains(&"settings".to_string()));
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let connection = Connection::open_in_memory().unwrap();
        ensure_schema(&connection).unwrap();
        // Call again — should not error
        ensure_schema(&connection).unwrap();
    }
}
