//! Database schema initialization for Helmor.
//!
//! Creates all required tables if they don't exist, matching the Conductor
//! schema for data compatibility.

use anyhow::{Context, Result};
use rusqlite::Connection;

/// Identifier sanity check before string-interpolating into SQL. SQLite
/// `pragma_table_info()` and `DROP TABLE` don't accept bound parameters
/// for the table/column name, so we must interpolate. All call sites pass
/// hardcoded identifiers, but the assertion makes that contract explicit.
fn assert_safe_identifier(value: &str) {
    debug_assert!(
        !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "schema identifier must match [A-Za-z0-9_]+: {value}"
    );
}

fn has_column(connection: &Connection, table: &str, column: &str) -> bool {
    assert_safe_identifier(table);
    assert_safe_identifier(column);
    connection
        .prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
        ))
        .and_then(|mut stmt| stmt.exists([column]))
        .unwrap_or(false)
}

fn has_table(connection: &Connection, table: &str) -> bool {
    connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .and_then(|mut stmt| stmt.exists([table]))
        .unwrap_or(false)
}

/// Columns that legacy installs may still carry but production no longer
/// reads or writes. Drop on every startup; the migration is idempotent.
///
/// Provenance: identified by the `audit-unused-db-schema` cleanup. Each
/// column was either never written, only written and never read, or only
/// read into a frontend type that nothing consumes.
const DEAD_COLUMNS: &[(&str, &str)] = &[
    // repos: feature stubs that never shipped or were abandoned.
    ("repos", "conductor_config"),
    ("repos", "custom_prompt_code_review"),
    ("repos", "icon"),
    // `branch_prefix_type` and `run_script_mode` were once stubs here.
    // Both have since been revived as real per-repo columns (multi-account
    // refactor and non-concurrent run mode respectively) — keep them OUT
    // of this list so they survive startup.
    ("repos", "storage_version"),
    // workspaces: legacy fields with no read path in production.
    ("workspaces", "big_terminal_mode"),
    ("workspaces", "initialization_files_copied"),
    ("workspaces", "linked_workspace_ids"),
    ("workspaces", "notes"),
    ("workspaces", "placeholder_branch_name"),
    ("workspaces", "pr_description"),
    ("workspaces", "secondary_directory_name"),
    // sessions: vestigial flags / counters never surfaced after a refactor.
    ("sessions", "agent_personality"),
    ("sessions", "context_token_count"),
    ("sessions", "context_used_percent"),
    ("sessions", "freshly_compacted"),
    ("sessions", "is_compacting"),
    ("sessions", "resume_session_at"),
    ("sessions", "thinking_enabled"),
    // session_messages: written by the streaming pipeline but never SELECTed.
    ("session_messages", "last_assistant_message_id"),
    ("session_messages", "model"),
    ("session_messages", "sdk_message_id"),
    ("session_messages", "is_resumable_message"),
];

/// Columns whose drop must be preceded by an index drop. Listed
/// separately so the table above stays a single shape.
const DEAD_INDEXED_COLUMNS: &[(&str, &str, &str)] = &[
    (
        "session_messages",
        "cancelled_at",
        "idx_session_messages_cancelled_at",
    ),
    (
        "session_messages",
        "turn_id",
        "idx_session_messages_turn_id",
    ),
];

/// Whole tables that legacy installs may still have. Dropping cascades
/// indexes automatically; named indexes are dropped explicitly so we don't
/// leave stale entries in `sqlite_master` if the table predates them.
const DEAD_TABLES: &[(&str, &[&str])] = &[
    (
        "attachments",
        &[
            "idx_attachments_session_id",
            "idx_attachments_session_message_id",
            "idx_attachments_is_draft",
        ],
    ),
    ("diff_comments", &["idx_diff_comments_workspace"]),
    // Briefly existed during the Terminal-tab persistence experiment. We
    // decided not to ship cross-restart history; this drop cleans up dev DBs
    // that ran the intermediate code so they don't carry an orphan table.
    ("terminal_history", &["idx_terminal_history_workspace"]),
];

fn drop_dead_schema(connection: &Connection) -> Result<()> {
    for &(table, column) in DEAD_COLUMNS {
        if has_column(connection, table, column) {
            assert_safe_identifier(table);
            assert_safe_identifier(column);
            connection
                .execute_batch(&format!("ALTER TABLE {table} DROP COLUMN {column}"))
                .with_context(|| format!("Failed to drop {table}.{column}"))?;
        }
    }
    for &(table, column, index) in DEAD_INDEXED_COLUMNS {
        if has_column(connection, table, column) {
            assert_safe_identifier(table);
            assert_safe_identifier(column);
            assert_safe_identifier(index);
            connection
                .execute_batch(&format!(
                    "DROP INDEX IF EXISTS {index};\nALTER TABLE {table} DROP COLUMN {column};"
                ))
                .with_context(|| format!("Failed to drop {table}.{column}"))?;
        }
    }
    for &(table, indexes) in DEAD_TABLES {
        if has_table(connection, table) {
            assert_safe_identifier(table);
            let mut sql = String::new();
            for index in indexes {
                assert_safe_identifier(index);
                sql.push_str(&format!("DROP INDEX IF EXISTS {index};\n"));
            }
            sql.push_str(&format!("DROP TABLE {table};\n"));
            connection
                .execute_batch(&sql)
                .with_context(|| format!("Failed to drop {table} table"))?;
        }
    }
    Ok(())
}

/// Ensure the database has all required tables and indexes.
/// Safe to call on every startup — uses IF NOT EXISTS.
pub fn ensure_schema(connection: &Connection) -> Result<()> {
    connection
        .execute_batch(SCHEMA_SQL)
        .context("Failed to initialize database schema")?;
    run_migrations(connection).context("Failed to run database migrations")
}

/// Incremental migrations for schema changes to existing databases.
fn run_migrations(connection: &Connection) -> Result<()> {
    // Migration: rename claude_session_id → provider_session_id (supports any agent provider)
    let has_old_column: bool = connection
        .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if has_old_column {
        connection
            .execute_batch(
                "ALTER TABLE sessions RENAME COLUMN claude_session_id TO provider_session_id",
            )
            .context("Failed to rename claude_session_id → provider_session_id")?;
    }

    // Migration: add effort_level column if missing (replaces thinking_enabled + codex_thinking_level)
    let has_effort: bool = connection
        .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'effort_level'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if !has_effort {
        connection
            .execute_batch("ALTER TABLE sessions ADD COLUMN effort_level TEXT DEFAULT 'high'")
            .context("Failed to add effort_level column")?;

        // Backfill effort_level from codex_thinking_level for imported Codex sessions
        connection
            .execute_batch(
                "UPDATE sessions SET effort_level = codex_thinking_level WHERE codex_thinking_level IS NOT NULL AND codex_thinking_level != '' AND effort_level = 'high'"
            )
            .ok();
    }

    // Migration: drop dead `full_message` column from session_messages.
    // It was only ever written (always with the same value as `content`),
    // never read. Cleared up to remove confusion about which column to query.
    let has_full_message: bool = connection
        .prepare("SELECT 1 FROM pragma_table_info('session_messages') WHERE name = 'full_message'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if has_full_message {
        connection
            .execute_batch("ALTER TABLE session_messages DROP COLUMN full_message")
            .context("Failed to drop full_message column")?;
    }

    // Migration: add action_kind column so we can distinguish one-off "action
    // sessions" (e.g. create-pr, commit-and-push, resolve-conflicts, fix)
    // from normal chat sessions. NULL = chat session; any string value marks
    // the session as a dispatched action and unlocks post-stream verifiers,
    // auto-hide behavior, and inspector badges.
    let has_action_kind: bool = connection
        .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'action_kind'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if !has_action_kind {
        connection
            .execute_batch("ALTER TABLE sessions ADD COLUMN action_kind TEXT")
            .context("Failed to add action_kind column")?;
    }

    // Migration: ensure repos.custom_prompt_review exists.
    //
    // The column was originally introduced as `custom_prompt_review_pr`
    // alongside the (removed) "Review PR" header button. The button is now
    // a generic "Review changes" helper, so the column was renamed to
    // `custom_prompt_review`. Three start states must converge cleanly:
    //   1. Brand-new DB — CREATE TABLE already adds `custom_prompt_review`.
    //   2. Old DB that picked up the previous migration — has the legacy
    //      `custom_prompt_review_pr`. RENAME preserves any user-saved prompt.
    //   3. Old DB that pre-dates either migration — neither column exists,
    //      so we ADD the new one.
    let has_repos_table: bool = connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repos'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);
    if has_repos_table {
        let has_new_col: bool = connection
            .prepare("SELECT 1 FROM pragma_table_info('repos') WHERE name = 'custom_prompt_review'")
            .and_then(|mut stmt| stmt.exists([]))
            .unwrap_or(false);
        let has_legacy_col: bool = connection
            .prepare(
                "SELECT 1 FROM pragma_table_info('repos') WHERE name = 'custom_prompt_review_pr'",
            )
            .and_then(|mut stmt| stmt.exists([]))
            .unwrap_or(false);
        if !has_new_col {
            if has_legacy_col {
                connection
                    .execute_batch(
                        "ALTER TABLE repos RENAME COLUMN custom_prompt_review_pr TO custom_prompt_review",
                    )
                    .context("Failed to rename custom_prompt_review_pr -> custom_prompt_review")?;
            } else {
                connection
                    .execute_batch("ALTER TABLE repos ADD COLUMN custom_prompt_review TEXT")
                    .context("Failed to add custom_prompt_review column")?;
            }
        }
    }

    // Migration: wrap plain-text user prompts as JSON.
    //
    // Pre-migration, the `content` column held a union type: assistant/system/
    // result rows stored a JSON string, but real human prompts stored raw text.
    // The adapter sniffed the first byte to decide which path to take, which
    // misclassified any prompt that happened to start with `{` or `[`.
    //
    // Post-migration: every user prompt is wrapped as
    //   {"type":"user_prompt","text":"..."}
    // and the column always holds JSON. The new `user_prompt` discriminator
    // also distinguishes real prompts from the SDK's tool_result-as-user
    // wrappers (`type=user`), so the adapter no longer needs the sniff.
    //
    // Idempotent: only touches user rows whose content isn't already a JSON
    // object with a `type` field. Already-wrapped rows (type=user_prompt) and
    // SDK tool_result wrappers (type=user) are skipped.
    connection
        .execute_batch(
            r#"
            UPDATE session_messages
            SET content = json_object('type', 'user_prompt', 'text', content)
            WHERE role = 'user'
              AND (
                NOT json_valid(content)
                OR json_extract(content, '$.type') IS NULL
              );
            "#,
        )
        .context("Failed to wrap plain-text user prompts as JSON")?;

    // Migration: deduplicate repos with identical root_path.
    // Keeps the oldest row per root_path, re-parents workspaces from duplicates,
    // then adds a unique index so it can't recur.
    let has_repos_table: bool = connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repos'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);
    let has_unique_idx: bool = connection
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_repos_root_path'",
        )
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if has_repos_table && !has_unique_idx {
        connection
            .execute_batch(
                r#"
                -- Re-parent workspaces from duplicate repos to the canonical (oldest) repo
                UPDATE workspaces
                SET repository_id = (
                    SELECT r2.id FROM repos r2
                    WHERE r2.root_path = (SELECT root_path FROM repos WHERE id = workspaces.repository_id)
                    ORDER BY r2.created_at ASC
                    LIMIT 1
                )
                WHERE repository_id IN (
                    SELECT r.id FROM repos r
                    WHERE r.root_path IN (
                        SELECT root_path FROM repos GROUP BY root_path HAVING COUNT(*) > 1
                    )
                );

                -- Delete duplicate repos (keep the oldest per root_path)
                DELETE FROM repos WHERE id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY root_path ORDER BY created_at ASC) AS rn
                        FROM repos
                    ) WHERE rn = 1
                );

                CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_root_path ON repos(root_path);
                "#,
            )
            .context("Failed to deduplicate repos and create unique index on root_path")?;
    }

    // Migration: drop dead workspace log path columns.
    // These stored temp-file paths for git-worktree and setup-script output
    // that were never read back. The files themselves lived in /tmp and were
    // cleaned up by the OS on reboot.
    let has_setup_log: bool = connection
        .prepare("SELECT 1 FROM pragma_table_info('workspaces') WHERE name = 'setup_log_path'")
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if has_setup_log {
        connection
            .execute_batch(
                r#"
                ALTER TABLE workspaces DROP COLUMN setup_log_path;
                ALTER TABLE workspaces DROP COLUMN initialization_log_path;
                "#,
            )
            .context("Failed to drop workspace log path columns")?;
    }

    // Migration: drop all remaining DEPRECATED_ columns.
    let has_city_name: bool = connection
        .prepare(
            "SELECT 1 FROM pragma_table_info('workspaces') WHERE name = 'DEPRECATED_city_name'",
        )
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if has_city_name {
        connection
            .execute_batch(
                r#"
                ALTER TABLE workspaces DROP COLUMN DEPRECATED_city_name;
                ALTER TABLE workspaces DROP COLUMN DEPRECATED_archived;
                "#,
            )
            .context("Failed to drop deprecated workspace columns")?;
    }

    let has_update_memory: bool = connection
        .prepare(
            "SELECT 1 FROM pragma_table_info('diff_comments') WHERE name = 'DEPRECATED_update_memory'",
        )
        .and_then(|mut stmt| stmt.exists([]))
        .unwrap_or(false);

    if has_update_memory {
        connection
            .execute_batch("ALTER TABLE diff_comments DROP COLUMN DEPRECATED_update_memory")
            .context("Failed to drop deprecated diff_comments column")?;
    }

    // Migration: opaque JSON snapshot for the composer's context-usage ring.
    if !has_column(connection, "sessions", "context_usage_meta") {
        connection
            .execute_batch("ALTER TABLE sessions ADD COLUMN context_usage_meta TEXT")
            .context("Failed to add context_usage_meta column")?;
    }

    // Migration: opaque JSON snapshot of the active Codex `/goal` state, used
    // by the panel-header banner. NULL means no active goal.
    if !has_column(connection, "sessions", "codex_goal_meta") {
        connection
            .execute_batch("ALTER TABLE sessions ADD COLUMN codex_goal_meta TEXT")
            .context("Failed to add codex_goal_meta column")?;
    }

    // Migration: toggle for auto-running the setup script on workspace
    // creation. Default 1 (on) — preserves the pre-feature behavior for
    // existing repos and is the most common case. Users opt out per-repo
    // when they prefer to run setup manually from the inspector.
    // Nullable so the conductor-import path (which copies rows without
    // specifying this column) can leave it NULL; reads treat NULL as on.
    if has_table(connection, "repos") && !has_column(connection, "repos", "auto_run_setup") {
        connection
            .execute_batch("ALTER TABLE repos ADD COLUMN auto_run_setup INTEGER DEFAULT 1")
            .context("Failed to add auto_run_setup column")?;
    }

    // Migration: forge_provider — cached classification of the repo's
    // remote ("github" / "gitlab" / "unknown"). Set once at repo-creation
    // time by the layered detector in `crate::forge`. Legacy rows stay
    // NULL and the loader re-runs detection on demand.
    if has_table(connection, "repos") && !has_column(connection, "repos", "forge_provider") {
        connection
            .execute_batch("ALTER TABLE repos ADD COLUMN forge_provider TEXT")
            .context("Failed to add forge_provider column")?;
    }

    // Migration: forge_login — the gh/glab account login bound to this
    // repo. Auto-detected on add-repo by probing each logged-in account
    // for access; NULL means no account had access (or detection hasn't
    // run yet). Used to set GH_TOKEN per-spawn so multi-account users
    // don't have to manually `gh auth switch` between repos.
    if has_table(connection, "repos") && !has_column(connection, "repos", "forge_login") {
        connection
            .execute_batch("ALTER TABLE repos ADD COLUMN forge_login TEXT")
            .context("Failed to add forge_login column")?;
    }

    if has_table(connection, "repos") && !has_column(connection, "repos", "branch_prefix_custom") {
        connection
            .execute_batch("ALTER TABLE repos ADD COLUMN branch_prefix_custom TEXT")
            .context("Failed to add branch_prefix_custom column")?;
    }

    // Re-add the per-repo `branch_prefix_type` column. Earlier shipped
    // releases dropped it via DEAD_COLUMNS; the multi-account refactor
    // brings it back as the canonical place for the override. No data
    // back-fill — no prior release wrote a value worth preserving.
    if has_table(connection, "repos") && !has_column(connection, "repos", "branch_prefix_type") {
        connection
            .execute_batch("ALTER TABLE repos ADD COLUMN branch_prefix_type TEXT")
            .context("Failed to add branch_prefix_type column")?;
    }

    // Migration: per-repo run-script mode. 'concurrent' (default) preserves
    // the historical behavior of allowing multiple workspaces in the same
    // repo to run their scripts at once. 'non-concurrent' makes a new run
    // stop any other run script in the same repo first — convenient when
    // the script binds a fixed port.
    if has_table(connection, "repos") && !has_column(connection, "repos", "run_script_mode") {
        connection
            .execute_batch("ALTER TABLE repos ADD COLUMN run_script_mode TEXT DEFAULT 'concurrent'")
            .context("Failed to add run_script_mode column")?;
    }

    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "pr_sync_state")
    {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN pr_sync_state TEXT DEFAULT 'none'")
            .context("Failed to add pr_sync_state column")?;
    }

    // Migration: composer drafts move from per-browser localStorage into
    // SQLite as a JSON-serialised Lexical editor state. Nullable — most
    // sessions don't have a draft most of the time, and clearing the
    // draft writes NULL rather than an empty JSON blob. Frontend
    // performs a one-time copy of leftover localStorage drafts into
    // this column on first launch (see `draft-storage.ts`).
    if has_table(connection, "sessions") && !has_column(connection, "sessions", "draft_state") {
        connection
            .execute_batch("ALTER TABLE sessions ADD COLUMN draft_state TEXT")
            .context("Failed to add sessions.draft_state column")?;
    }

    // Migration: cache the live PR/MR url on the workspace row so the
    // inspector can render the PR badge optimistically (before the live
    // forge query returns). The PR number is parsed from the URL on the
    // frontend, so storing the URL alone covers both fields.
    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "pr_url") {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN pr_url TEXT")
            .context("Failed to add pr_url column")?;
    }

    let had_workspace_status =
        has_table(connection, "workspaces") && has_column(connection, "workspaces", "status");
    if has_table(connection, "workspaces") && !had_workspace_status {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN status TEXT DEFAULT 'in-progress'")
            .context("Failed to add workspace status column")?;
    }
    if has_table(connection, "workspaces") {
        let legacy_status_expr = if has_column(connection, "workspaces", "manual_status")
            && has_column(connection, "workspaces", "derived_status")
        {
            "COALESCE(NULLIF(manual_status, ''), NULLIF(derived_status, ''), 'in-progress')"
        } else if has_column(connection, "workspaces", "derived_status") {
            "COALESCE(NULLIF(derived_status, ''), 'in-progress')"
        } else {
            "'in-progress'"
        };
        connection
            .execute_batch(&format!(
                "UPDATE workspaces SET status = {legacy_status_expr} WHERE {}",
                if had_workspace_status {
                    "status IS NULL OR status = ''"
                } else {
                    "1 = 1"
                }
            ))
            .context("Failed to backfill workspace status")?;

        if has_column(connection, "workspaces", "manual_status") {
            connection
                .execute_batch("ALTER TABLE workspaces DROP COLUMN manual_status")
                .context("Failed to drop workspace manual_status column")?;
        }
        if has_column(connection, "workspaces", "derived_status") {
            connection
                .execute_batch("ALTER TABLE workspaces DROP COLUMN derived_status")
                .context("Failed to drop workspace derived_status column")?;
        }
    }

    drop_dead_schema(connection)?;

    // Migration: remap legacy "opus-1m" model ID — the CLI no longer accepts it.
    // "opus" still works as an alias, so only "opus-1m" needs remapping.
    connection
        .execute_batch("UPDATE sessions SET model = 'default' WHERE model = 'opus-1m'")
        .ok();

    // Migration: drop the old OAuth identity rows. The device-flow login
    // is gone — auth is now per-repo via the bundled `gh` CLI's own
    // credential store. Idempotent: DELETE on absent rows is a no-op.
    connection
        .execute_batch(
            "DELETE FROM settings WHERE key IN ('github_identity_meta', 'github_identity_secret');",
        )
        .ok();

    // Workspace `mode`: 'worktree' (existing — own dir, own branch) or
    // 'local' (operates on the source repo's root, no separate worktree).
    // Nullable + COALESCE'd at read sites so the conductor import flow
    // (which copies columns directly without applying NOT NULL defaults)
    // keeps working — NULL is treated as 'worktree' on read.
    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "mode") {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN mode TEXT DEFAULT 'worktree'")
            .context("Failed to add workspaces.mode column")?;
    }

    // Tracks the last successful run of the repo's setup script for this
    // workspace. NULL means "never ran" (or the workspace was created
    // before this column existed) — distinct from "ran but output got
    // dropped at restart". The Setup inspector tab uses this to show a
    // "ran in another session" notice instead of the default
    // never-run placeholder.
    if has_table(connection, "workspaces")
        && !has_column(connection, "workspaces", "setup_completed_at")
    {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN setup_completed_at TEXT")
            .context("Failed to add workspaces.setup_completed_at column")?;
    }

    Ok(())
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
    remote TEXT,
    custom_prompt_create_pr TEXT,
    custom_prompt_review TEXT,
    custom_prompt_rename_branch TEXT,
    custom_prompt_general TEXT,
    hidden INTEGER DEFAULT 0,
    custom_prompt_fix_errors TEXT,
    custom_prompt_resolve_merge_conflicts TEXT,
    auto_run_setup INTEGER DEFAULT 1,
    forge_provider TEXT,
    forge_login TEXT,
    branch_prefix_type TEXT,
    branch_prefix_custom TEXT,
    run_script_mode TEXT DEFAULT 'concurrent',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_cli_sends (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    model_id TEXT,
    permission_mode TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    repository_id TEXT,
    directory_name TEXT,
    active_session_id TEXT,
    branch TEXT,
    state TEXT DEFAULT 'active',
    status TEXT DEFAULT 'in-progress',
    unread INTEGER DEFAULT 0,
    initialization_parent_branch TEXT,
    pinned_at TEXT,
    intended_target_branch TEXT,
    pr_title TEXT,
    pr_sync_state TEXT DEFAULT 'none',
    pr_url TEXT,
    archive_commit TEXT,
    linked_directory_paths TEXT,
    mode TEXT DEFAULT 'worktree',
    setup_completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    status TEXT DEFAULT 'idle',
    provider_session_id TEXT,
    unread_count INTEGER DEFAULT 0,
    model TEXT,
    permission_mode TEXT DEFAULT 'default',
    last_user_message_at TEXT,
    is_hidden INTEGER DEFAULT 0,
    agent_type TEXT,
    title TEXT DEFAULT 'Untitled',
    effort_level TEXT DEFAULT 'high',
    fast_mode INTEGER DEFAULT 0,
    action_kind TEXT,
    context_usage_meta TEXT,
    codex_goal_meta TEXT,
    draft_state TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,
    content TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_session_messages_sent_at ON session_messages(session_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
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

    fn open_test_db() -> (Connection, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        (conn, dir)
    }

    #[test]
    fn ensure_schema_creates_tables() {
        let (connection, _dir) = open_test_db();
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
        assert!(tables.contains(&"settings".to_string()));
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        // Call again — should not error
        ensure_schema(&connection).unwrap();
    }

    #[test]
    fn migration_renames_claude_session_id_to_provider_session_id() {
        let (connection, _dir) = open_test_db();

        // Simulate old schema with claude_session_id.
        // session_messages must also exist because the wrap-user-prompts
        // migration runs unconditionally and would otherwise fail.
        connection
            .execute_batch(
                r#"
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT,
                    status TEXT DEFAULT 'idle',
                    claude_session_id TEXT,
                    unread_count INTEGER DEFAULT 0,
                    model TEXT,
                    permission_mode TEXT DEFAULT 'default',
                    last_user_message_at TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                );
                CREATE TABLE session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    role TEXT,
                    content TEXT
                );
                INSERT INTO sessions (id, claude_session_id) VALUES ('s1', 'old-uuid-123');
                "#,
            )
            .unwrap();

        // Run migration
        run_migrations(&connection).unwrap();

        // Verify column was renamed
        let has_old: bool = connection
            .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'")
            .unwrap()
            .exists([])
            .unwrap();
        assert!(!has_old, "claude_session_id should no longer exist");

        let has_new: bool = connection
            .prepare(
                "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'provider_session_id'",
            )
            .unwrap()
            .exists([])
            .unwrap();
        assert!(has_new, "provider_session_id should exist");

        // Verify data preserved
        let value: String = connection
            .query_row(
                "SELECT provider_session_id FROM sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value, "old-uuid-123");
    }

    #[test]
    fn migration_is_idempotent_on_new_schema() {
        // When the table already has provider_session_id (fresh install),
        // the migration should be a no-op.
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();

        // Run migrations again — should not error
        run_migrations(&connection).unwrap();

        let has_new: bool = connection
            .prepare(
                "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'provider_session_id'",
            )
            .unwrap()
            .exists([])
            .unwrap();
        assert!(has_new);
    }

    #[test]
    fn migration_wraps_plain_text_user_prompts_as_json() {
        let (connection, _dir) = open_test_db();

        connection
            .execute_batch(
                r#"
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    effort_level TEXT
                );
                CREATE TABLE session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    role TEXT,
                    content TEXT,
                    created_at TEXT
                );

                -- Plain-text user prompt — needs wrapping.
                INSERT INTO session_messages VALUES
                  ('m1', 's1', 'user', 'hello world', '2026-01-01');

                -- User prompt that starts with `{` (latent-bug case) — also wraps.
                INSERT INTO session_messages VALUES
                  ('m2', 's1', 'user', '{"foo":"bar"}', '2026-01-01');

                -- Already-wrapped user_prompt — must be skipped.
                INSERT INTO session_messages VALUES
                  ('m3', 's1', 'user',
                   '{"type":"user_prompt","text":"already done"}',
                   '2026-01-01');

                -- SDK tool_result wrapped as user (type=user) — must be skipped.
                INSERT INTO session_messages VALUES
                  ('m4', 's1', 'user',
                   '{"type":"user","message":{"role":"user","content":[]}}',
                   '2026-01-01');

                -- Assistant row — never touched.
                INSERT INTO session_messages VALUES
                  ('m5', 's1', 'assistant',
                   '{"type":"assistant","message":{}}',
                   '2026-01-01');
                "#,
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        let read = |id: &str| -> String {
            connection
                .query_row(
                    "SELECT content FROM session_messages WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        };

        // m1: plain text wrapped
        assert_eq!(read("m1"), r#"{"type":"user_prompt","text":"hello world"}"#);

        // m2: literal `{"foo":"bar"}` preserved as a string inside the wrapper.
        // This is the latent-bug fix — pre-migration this row would have been
        // miscategorized as a system "Event" because it parses as JSON but
        // lacks a `type` field.
        assert_eq!(
            read("m2"),
            r#"{"type":"user_prompt","text":"{\"foo\":\"bar\"}"}"#
        );

        // m3: already-wrapped, untouched
        assert_eq!(
            read("m3"),
            r#"{"type":"user_prompt","text":"already done"}"#
        );

        // m4: SDK tool_result wrapper, untouched
        assert_eq!(
            read("m4"),
            r#"{"type":"user","message":{"role":"user","content":[]}}"#
        );

        // m5: assistant row, untouched
        assert_eq!(read("m5"), r#"{"type":"assistant","message":{}}"#);

        // Idempotent on second run
        run_migrations(&connection).unwrap();
        assert_eq!(read("m1"), r#"{"type":"user_prompt","text":"hello world"}"#);
        assert_eq!(
            read("m2"),
            r#"{"type":"user_prompt","text":"{\"foo\":\"bar\"}"}"#
        );
    }

    #[test]
    fn migration_drops_full_message_column() {
        let (connection, _dir) = open_test_db();

        // Simulate an existing DB whose schema predates the full_message
        // drop. The other migrations need a sessions table to exist, so we
        // create both tables with the older shape.
        connection
            .execute_batch(
                r#"
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    effort_level TEXT
                );
                CREATE TABLE session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    role TEXT,
                    content TEXT,
                    full_message TEXT,
                    created_at TEXT
                );
                INSERT INTO session_messages (id, session_id, role, content, full_message)
                VALUES ('m1', 's1', 'user', 'kept', 'should-be-dropped');
                "#,
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        // full_message column is gone
        let has_full_message: bool = connection
            .prepare(
                "SELECT 1 FROM pragma_table_info('session_messages') WHERE name = 'full_message'",
            )
            .unwrap()
            .exists([])
            .unwrap();
        assert!(!has_full_message, "full_message column should be dropped");

        // Data in `content` is preserved (now wrapped by the user_prompt
        // migration that also runs in this batch).
        let content: String = connection
            .query_row(
                "SELECT content FROM session_messages WHERE id = 'm1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(content, r#"{"type":"user_prompt","text":"kept"}"#);

        // Idempotent on second run
        run_migrations(&connection).unwrap();
    }

    /// Construct the full pre-drop legacy DDL once. Each migration test
    /// below seeds against this so we exercise the production drop path
    /// against schemas that actually carry every dead column we care about.
    fn create_legacy_schema(connection: &Connection) {
        connection
            .execute_batch(
                r#"
                CREATE TABLE repos (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    root_path TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    storage_version INTEGER DEFAULT 1,
                    run_script_mode TEXT DEFAULT 'concurrent',
                    custom_prompt_code_review TEXT,
                    conductor_config TEXT,
                    icon TEXT
                );
                CREATE TABLE workspaces (
                    id TEXT PRIMARY KEY,
                    repository_id TEXT,
                    placeholder_branch_name TEXT,
                    big_terminal_mode INTEGER DEFAULT 0,
                    initialization_files_copied INTEGER,
                    linked_workspace_ids TEXT,
                    notes TEXT,
                    pr_description TEXT,
                    secondary_directory_name TEXT
                );
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    effort_level TEXT,
                    freshly_compacted INTEGER DEFAULT 0,
                    context_token_count INTEGER DEFAULT 0,
                    is_compacting INTEGER DEFAULT 0,
                    context_used_percent REAL,
                    thinking_enabled INTEGER DEFAULT 1,
                    agent_personality TEXT,
                    resume_session_at TEXT
                );
                CREATE TABLE session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    role TEXT,
                    content TEXT,
                    sent_at TEXT,
                    cancelled_at TEXT,
                    model TEXT,
                    sdk_message_id TEXT,
                    last_assistant_message_id TEXT,
                    turn_id TEXT,
                    is_resumable_message INTEGER
                );
                CREATE INDEX idx_session_messages_cancelled_at
                    ON session_messages(session_id, cancelled_at);
                CREATE INDEX idx_session_messages_turn_id
                    ON session_messages(turn_id);
                CREATE TABLE attachments (
                    id TEXT PRIMARY KEY,
                    session_id TEXT
                );
                CREATE INDEX idx_attachments_session_id ON attachments(session_id);
                CREATE TABLE diff_comments (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT
                );
                CREATE INDEX idx_diff_comments_workspace ON diff_comments(workspace_id);
                "#,
            )
            .unwrap();
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
        connection
            .prepare(&format!(
                "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
            ))
            .unwrap()
            .exists([column])
            .unwrap()
    }

    fn table_exists(connection: &Connection, table: &str) -> bool {
        connection
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
            .unwrap()
            .exists([table])
            .unwrap()
    }

    fn index_exists(connection: &Connection, index: &str) -> bool {
        connection
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1")
            .unwrap()
            .exists([index])
            .unwrap()
    }

    #[test]
    fn migration_drops_dead_columns_across_all_tables() {
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        // Seed live (kept) columns so we can prove the drops don't take
        // them down with the dead ones.
        connection
            .execute(
                "INSERT INTO sessions (id, effort_level) VALUES ('s1', 'high')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_messages (id, session_id, role, content) \
                 VALUES ('m1', 's1', 'user', '{\"type\":\"user_prompt\",\"text\":\"hi\"}')",
                [],
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        for &(table, column) in DEAD_COLUMNS {
            assert!(
                !column_exists(&connection, table, column),
                "{table}.{column} should be dropped"
            );
        }
        for &(table, column, _index) in DEAD_INDEXED_COLUMNS {
            assert!(
                !column_exists(&connection, table, column),
                "{table}.{column} should be dropped"
            );
        }

        // Live columns survived.
        assert!(column_exists(&connection, "sessions", "effort_level"));
        assert!(column_exists(&connection, "session_messages", "content"));

        // Live data survived.
        let effort: String = connection
            .query_row(
                "SELECT effort_level FROM sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(effort, "high");

        // Idempotent on second run.
        run_migrations(&connection).unwrap();
    }

    #[test]
    fn migration_drops_indexes_alongside_columns() {
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);

        // Pre-condition: indexes exist before migration.
        assert!(index_exists(
            &connection,
            "idx_session_messages_cancelled_at"
        ));
        assert!(index_exists(&connection, "idx_session_messages_turn_id"));
        assert!(index_exists(&connection, "idx_attachments_session_id"));
        assert!(index_exists(&connection, "idx_diff_comments_workspace"));

        run_migrations(&connection).unwrap();

        // Post-condition: indexes are gone (otherwise sqlite_master would
        // still reference them and the next CREATE INDEX with the same name
        // would conflict).
        assert!(!index_exists(
            &connection,
            "idx_session_messages_cancelled_at"
        ));
        assert!(!index_exists(&connection, "idx_session_messages_turn_id"));
        assert!(!index_exists(&connection, "idx_attachments_session_id"));
        assert!(!index_exists(&connection, "idx_diff_comments_workspace"));
    }

    #[test]
    fn migration_drops_attachments_and_diff_comments_tables() {
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        // Non-empty rows: catch any bug that makes us bail when the table
        // has data instead of executing the DROP.
        connection
            .execute(
                "INSERT INTO attachments (id, session_id) VALUES ('a1', 's1')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO diff_comments (id, workspace_id) VALUES ('dc1', 'w1')",
                [],
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        assert!(!table_exists(&connection, "attachments"));
        assert!(!table_exists(&connection, "diff_comments"));

        // Idempotent: second run on a schema that no longer has the tables.
        run_migrations(&connection).unwrap();
    }

    #[test]
    fn drop_dead_schema_is_idempotent_on_fresh_install() {
        // After ensure_schema runs against an empty DB, none of the dead
        // columns/tables exist. drop_dead_schema must be a clean no-op.
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        drop_dead_schema(&connection).unwrap();
        drop_dead_schema(&connection).unwrap();
    }

    #[test]
    fn context_usage_meta_added_to_legacy_and_idempotent() {
        // Legacy schema (pre-feature) has no context_usage_meta column.
        // The migration must add it, preserve existing rows, and survive
        // a second run.
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        assert!(!column_exists(
            &connection,
            "sessions",
            "context_usage_meta"
        ));

        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "sessions", "context_usage_meta"));

        // Re-run is a no-op (no error, column still there).
        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "sessions", "context_usage_meta"));
    }

    #[test]
    fn context_usage_meta_present_on_fresh_install() {
        // Fresh DB created via ensure_schema includes the column without
        // needing a separate migration pass.
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        assert!(column_exists(&connection, "sessions", "context_usage_meta"));
    }

    #[test]
    fn forge_provider_added_to_legacy_and_idempotent() {
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        assert!(!column_exists(&connection, "repos", "forge_provider"));

        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "forge_provider"));

        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "forge_provider"));
    }

    #[test]
    fn forge_provider_present_on_fresh_install() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "forge_provider"));
    }

    #[test]
    fn forge_login_added_to_legacy_and_idempotent() {
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        assert!(!column_exists(&connection, "repos", "forge_login"));

        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "forge_login"));

        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "forge_login"));
    }

    #[test]
    fn forge_login_present_on_fresh_install() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "forge_login"));
    }

    #[test]
    fn run_script_mode_present_on_fresh_install() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "run_script_mode"));
    }

    #[test]
    fn run_script_mode_retained_from_legacy_schema() {
        // Conductor DBs already carry this column. Migration must keep it
        // (and any persisted value) rather than dropping it.
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        connection
            .execute(
                "INSERT INTO repos (id, name, run_script_mode) VALUES ('r1', 'x', 'non-concurrent')",
                [],
            )
            .unwrap();

        run_migrations(&connection).unwrap();
        assert!(column_exists(&connection, "repos", "run_script_mode"));

        let mode: String = connection
            .query_row(
                "SELECT run_script_mode FROM repos WHERE id = 'r1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mode, "non-concurrent");
    }

    #[test]
    fn context_usage_meta_round_trips_opaque_json() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO sessions (id, context_usage_meta) VALUES ('s1', ?1)",
                [r#"{"totalTokens":12,"maxTokens":100}"#],
            )
            .unwrap();
        let stored: Option<String> = connection
            .query_row(
                "SELECT context_usage_meta FROM sessions WHERE id = 's1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some(r#"{"totalTokens":12,"maxTokens":100}"#)
        );
    }
}
