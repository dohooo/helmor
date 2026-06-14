//! Database schema initialization for Helmor.
//!
//! Creates all required tables if they don't exist, matching the Conductor
//! schema for data compatibility.

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::workspace::sidebar_order;

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
    // `branch_prefix_type` was once a stub here. It has since been
    // revived as a real per-repo column (multi-account refactor) — keep
    // it OUT of this list so it survives startup.
    ("repos", "storage_version"),
    // Retired with the multi run-action migration. Each repo now stores
    // its run scripts as rows in `repo_run_actions`; the legacy single
    // `run_script` + `run_script_mode` columns are backfilled in
    // `run_migrations` and then dropped here.
    ("repos", "run_script"),
    ("repos", "run_script_mode"),
    // workspaces: legacy fields with no read path in production.
    ("workspaces", "big_terminal_mode"),
    ("workspaces", "initialization_files_copied"),
    ("workspaces", "linked_workspace_ids"),
    ("workspaces", "notes"),
    ("workspaces", "placeholder_branch_name"),
    ("workspaces", "pr_description"),
    ("workspaces", "secondary_directory_name"),
    // The repo-grouped DnD prototype split sidebar order into two columns;
    // we collapsed back to a single `display_order` before shipping.
    ("workspaces", "repo_display_order"),
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
/// Re-point every stacked child's `intended_target_branch` at its parent's
/// current branch. Idempotent: only rows whose cached target differs from the
/// parent's live branch are touched (dangling parents are skipped). Mirrors
/// the write-layer cascade in `models::workspaces::update_workspace_branch`
/// so rows that predate it self-heal on startup.
fn backfill_stacked_target_branches(connection: &Connection) -> Result<()> {
    if !has_table(connection, "workspaces")
        || !has_column(connection, "workspaces", "parent_workspace_id")
        || !has_column(connection, "workspaces", "branch")
        || !has_column(connection, "workspaces", "intended_target_branch")
    {
        return Ok(());
    }
    connection
        .execute(
            "UPDATE workspaces
             SET intended_target_branch = (
                 SELECT p.branch FROM workspaces p WHERE p.id = workspaces.parent_workspace_id
             )
             WHERE parent_workspace_id IS NOT NULL
               AND (SELECT p.branch FROM workspaces p WHERE p.id = workspaces.parent_workspace_id) IS NOT NULL
               AND intended_target_branch IS NOT (
                   SELECT p.branch FROM workspaces p WHERE p.id = workspaces.parent_workspace_id
               )",
            [],
        )
        .context("Failed to re-point stacked target branches")?;
    Ok(())
}

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

    // Migration: stacked PRs. `parent_workspace_id` links a workspace to the
    // one below it in a PR stack (its base). NULL = bottom of stack or a
    // non-stacked workspace. No SQL foreign key — consistent with
    // `repository_id` (and SQLite can't ALTER ADD CONSTRAINT); integrity is
    // enforced in the Rust write layer. No back-fill — existing rows are
    // non-stacked.
    if has_table(connection, "workspaces")
        && !has_column(connection, "workspaces", "parent_workspace_id")
    {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN parent_workspace_id TEXT")
            .context("Failed to add workspaces.parent_workspace_id column")?;
    }

    // Stacked-PR invariant: a child's `intended_target_branch` caches its
    // parent's branch. Re-assert it so rows that predate the write-layer
    // cascade (or drifted when a parent was renamed before the cascade
    // existed) self-heal. Idempotent + cheap — only mismatched linked
    // children are touched.
    backfill_stacked_target_branches(connection)
        .context("Failed to backfill stacked-PR target branches")?;

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

        // Normalize legacy status spellings on existing rows. Older builds
        // wrote "in-review" / "cancelled"; the canonical form is
        // "review" / "canceled". The SELECT-time COALESCE only handles
        // NULL, so without this the legacy string survives and the
        // frontend's status-dot dict lookup misses (rendering a
        // transparent, visually grey-white dot).
        connection
            .execute_batch(
                "UPDATE workspaces SET status = 'review' WHERE status = 'in-review';\
                 UPDATE workspaces SET status = 'canceled' WHERE status = 'cancelled';\
                 UPDATE workspaces SET status = 'in-progress' WHERE status NOT IN ('in-progress', 'done', 'review', 'backlog', 'canceled');",
            )
            .context("Failed to normalize workspace status values")?;
    }

    // Multi run-action support: each repo gets a list of named run scripts
    // instead of a single `run_script`. The migration must run BEFORE
    // `drop_dead_schema` so the backfill can still read the legacy
    // `repos.run_script` / `run_script_mode` columns — `drop_dead_schema`
    // is what actually retires them (see `DEAD_COLUMNS`).
    if has_table(connection, "workspaces")
        && !has_column(connection, "workspaces", "active_run_action_id")
    {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN active_run_action_id TEXT")
            .context("Failed to add workspaces.active_run_action_id column")?;
    }

    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS repo_run_actions (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'concurrent',
                display_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_repo_run_actions_repo
                ON repo_run_actions(repo_id, display_order);
            CREATE TRIGGER IF NOT EXISTS update_repo_run_actions_updated_at
                AFTER UPDATE ON repo_run_actions
                BEGIN
                    UPDATE repo_run_actions SET updated_at = datetime('now')
                    WHERE id = NEW.id;
                END;
            "#,
        )
        .context("Failed to create repo_run_actions table")?;

    // Optional graceful-stop command per run action. `stop_command` is a
    // shell snippet helmor runs when the user clicks Stop, blocking the
    // SIGTERM/SIGKILL of the main process until it exits (Force Stop
    // re-click short-circuits). Nullable — existing rows are unaffected
    // and continue to use today's `escalating_kill` flow.
    if has_table(connection, "repo_run_actions")
        && !has_column(connection, "repo_run_actions", "stop_command")
    {
        connection
            .execute_batch("ALTER TABLE repo_run_actions ADD COLUMN stop_command TEXT")
            .context("Failed to add repo_run_actions.stop_command column")?;
    }

    // Backfill: every repo that has a non-empty `run_script` but no row in
    // `repo_run_actions` yet gets a single migrated action carrying the old
    // command + mode. Deterministic id (`legacy:<repo_id>`) keeps the
    // migration idempotent across restarts and stable for any active-id
    // references we later add. After this block both legacy columns are
    // listed in `DEAD_COLUMNS` and get dropped by `drop_dead_schema` below.
    if has_table(connection, "repos")
        && has_table(connection, "repo_run_actions")
        && has_column(connection, "repos", "run_script")
    {
        let has_mode = has_column(connection, "repos", "run_script_mode");
        let mode_expr = if has_mode {
            "COALESCE(NULLIF(run_script_mode, ''), 'concurrent')"
        } else {
            "'concurrent'"
        };
        connection
            .execute_batch(&format!(
                r#"
                INSERT INTO repo_run_actions (id, repo_id, name, command, mode, display_order)
                SELECT
                    'legacy:' || id,
                    id,
                    'Default',
                    run_script,
                    {mode_expr},
                    0
                FROM repos
                WHERE run_script IS NOT NULL
                  AND TRIM(run_script) != ''
                  AND NOT EXISTS (
                    SELECT 1 FROM repo_run_actions WHERE repo_run_actions.repo_id = repos.id
                  );
                "#
            ))
            .context("Failed to backfill repo_run_actions from repos.run_script")?;

        // One-shot rename for installs that backfilled with the earlier
        // label ("Run"). Targeted by id pattern + exact-match name so it
        // never touches a row the user manually renamed.
        connection
            .execute_batch(
                r#"
                UPDATE repo_run_actions
                SET name = 'Default'
                WHERE id LIKE 'legacy:%' AND name = 'Run';
                "#,
            )
            .context("Failed to rename legacy run actions to 'Default'")?;
    }

    drop_dead_schema(connection)?;

    // Migration: remap legacy "opus-1m" model ID — the CLI no longer accepts it.
    // "opus" still works as an alias, so only "opus-1m" needs remapping.
    connection
        .execute_batch("UPDATE sessions SET model = 'default' WHERE model = 'opus-1m'")
        .ok();

    // Migration: claude retired the floating `default` sentinel — every model
    // is now pinned to its explicit wire id, and the app default is
    // `claude-opus-4-8[1m]` (same Opus 4.8 1M the CLI's `default` resolved to,
    // so historical users see no change). This block is the ONE place that
    // knows about the legacy id; runtime code never special-cases it. Three
    // storage surfaces, all idempotent:
    //
    //   1. sessions.model — the pinned model of past runs.
    //   2. The "Models" settings (`default`/`review`/`pr` model) — stored as
    //      either a `{provider,modelId}` JSON object or a bare legacy id.
    //   3. The provider "enabled models" list (`claude_enabled_model_ids`,
    //      a JSON array) — else the picker drops Opus / shows a stale chip.
    //
    // Scoped to claude: cursor's `default` is its real "Auto" id (and appears
    // only as the quote-safe `cursor-default`), so it is never touched. The
    // `"default"` substring is precise — no other claude id contains it.
    connection
        .execute_batch(
            "UPDATE sessions SET model = 'claude-opus-4-8[1m]' \
             WHERE model = 'default' \
             AND (agent_type IS NULL OR agent_type = '' OR agent_type = 'claude');\n\
             UPDATE settings \
             SET value = REPLACE(value, '\"default\"', '\"claude-opus-4-8[1m]\"') \
             WHERE key IN ('app.claude_enabled_model_ids', 'app.default_model_id', \
                           'app.review_model_id', 'app.pr_model_id') \
             AND value LIKE '%\"default\"%';\n\
             UPDATE settings SET value = 'claude-opus-4-8[1m]' \
             WHERE key IN ('app.default_model_id', 'app.review_model_id', \
                           'app.pr_model_id') \
             AND value = 'default';",
        )
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

    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "display_order")
    {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN display_order INTEGER DEFAULT 0")
            .context("Failed to add workspaces.display_order column")?;
    }

    seed_workspace_display_orders(connection)?;

    // Per-workspace port range. `port_base`/`port_count` get assigned the
    // first time a script env is built for the workspace (lazy allocation
    // in `workspace::port_allocation`). NULL means "not yet allocated" —
    // legacy rows stay NULL until they next run a script.
    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "port_base") {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN port_base INTEGER")
            .context("Failed to add workspaces.port_base column")?;
    }
    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "port_count") {
        connection
            .execute_batch("ALTER TABLE workspaces ADD COLUMN port_count INTEGER")
            .context("Failed to add workspaces.port_count column")?;
    }

    // Runtime process registry. Tracks every PTY-backed script /
    // terminal Helmor spawns so a crash recovery sweep on next launch
    // can detect rows whose process is still alive and report them.
    // `ended_at` IS NULL while a process is live; the post-exit code
    // path in `workspace::scripts::run_script_with_shell` stamps it
    // on natural completion / kill / graceful quit. Idempotent
    // CREATE TABLE so legacy DBs pick it up on next startup.
    connection
        .execute_batch(RUNTIME_PROCESSES_DDL)
        .context("Failed to create runtime_processes table")?;

    // 'from_branch' = fork a new branch; 'use_branch' = attach as-is.
    if has_table(connection, "workspaces") && !has_column(connection, "workspaces", "branch_intent")
    {
        connection
            .execute_batch(
                "ALTER TABLE workspaces ADD COLUMN branch_intent TEXT DEFAULT 'from_branch'",
            )
            .context("Failed to add workspaces.branch_intent column")?;
    }

    materialize_review_pr_model_defaults(connection)?;

    // Smart Triage columns (idempotent ALTERs for pre-triage upgrades).
    if has_table(connection, "workspaces") {
        // Match the fresh schema so a manual INSERT (which omits `kind`)
        // resolves to 'manual' on upgraded and fresh DBs alike.
        add_column_if_missing(
            connection,
            "workspaces",
            "kind",
            "TEXT NOT NULL DEFAULT 'manual'",
        )?;
        // Backfill rows the earlier nullable-`TEXT` migration left as NULL.
        connection
            .execute_batch("UPDATE workspaces SET kind = 'manual' WHERE kind IS NULL")
            .context("Failed to backfill workspaces.kind NULLs")?;
        add_column_if_missing(
            connection,
            "workspaces",
            "ai_priming_consumed",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        // Triage source provenance: `(source_type, source_ref)` dedups across ticks.
        add_column_if_missing(connection, "workspaces", "triage_source_type", "TEXT")?;
        add_column_if_missing(connection, "workspaces", "triage_source_ref", "TEXT")?;
        // Index goes after the ALTER above — else old DBs would index a missing column.
        connection
            .execute_batch("CREATE INDEX IF NOT EXISTS idx_workspaces_kind ON workspaces(kind)")
            .context("Failed to create idx_workspaces_kind")?;
        connection
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_workspaces_triage_source
                 ON workspaces(triage_source_type, triage_source_ref)
                 WHERE triage_source_type IS NOT NULL",
            )
            .context("Failed to create idx_workspaces_triage_source")?;
    }
    if has_table(connection, "session_messages") {
        add_column_if_missing(
            connection,
            "session_messages",
            "is_ai_priming",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    if has_table(connection, "sessions") {
        // Terminal sessions render a live PTY in the message area instead of an
        // SDK chat thread. 'gui' = existing SDK sessions.
        add_column_if_missing(
            connection,
            "sessions",
            "session_kind",
            "TEXT NOT NULL DEFAULT 'gui'",
        )?;
    }
    if has_table(connection, "triage_candidate") {
        // Why an item surfaced for the user (review_requested / assigned /
        // mentioned / author / owned_issue). Nullable — older rows + sources
        // that don't stamp a reason stay NULL.
        add_column_if_missing(connection, "triage_candidate", "involvement_reason", "TEXT")?;
    }

    // Per-session "active plan" projection. Provider plan/todo events
    // (Codex `turn/plan/updated`, Claude `ExitPlanMode`) are normalised
    // by `agents::session_plan` into a typed plan and upserted here so
    // the frontend can render a pinned plan without scanning scrollback.
    // Idempotent: re-running creates a no-op when the table exists.
    connection
        .execute_batch(SESSION_PLAN_STATE_DDL)
        .context("Failed to create session_plan_state table")?;

    Ok(())
}

const RUNTIME_PROCESSES_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS runtime_processes (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    workspace_id TEXT,
    script_type TEXT NOT NULL,
    pid INTEGER NOT NULL,
    pgid INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runtime_processes_ended_at
    ON runtime_processes(ended_at);
"#;

const SESSION_PLAN_STATE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS session_plan_state (
    session_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_message_id TEXT,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

// Idempotent `ALTER TABLE ... ADD COLUMN`; no-op when the column already exists.
fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    column_def: &str,
) -> Result<()> {
    let exists: bool = connection
        .prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"
        ))
        .and_then(|mut stmt| stmt.exists([column]))
        .unwrap_or(false);
    if !exists {
        connection
            .execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {column_def}"
            ))
            .with_context(|| format!("Failed to add {table}.{column} column"))?;
    }
    Ok(())
}

/// Promote NULL review_*/pr_* rows to explicit copies of the current
/// defaults, so changing the default later doesn't drag them along.
/// Idempotent via anti-join; gated on `app.default_model_id` being set.
fn materialize_review_pr_model_defaults(connection: &Connection) -> Result<()> {
    if !has_table(connection, "settings") {
        return Ok(());
    }
    connection
        .execute_batch(
            r#"
            INSERT INTO settings (key, value)
            SELECT 'app.review_model_id', value FROM settings
            WHERE key = 'app.default_model_id' AND value != ''
              AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app.review_model_id');

            INSERT INTO settings (key, value)
            SELECT 'app.pr_model_id', value FROM settings
            WHERE key = 'app.default_model_id' AND value != ''
              AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app.pr_model_id');

            INSERT INTO settings (key, value)
            SELECT 'app.review_effort', value FROM settings
            WHERE key = 'app.default_effort' AND value != ''
              AND EXISTS (SELECT 1 FROM settings WHERE key = 'app.default_model_id' AND value != '')
              AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app.review_effort');

            INSERT INTO settings (key, value)
            SELECT 'app.pr_effort', value FROM settings
            WHERE key = 'app.default_effort' AND value != ''
              AND EXISTS (SELECT 1 FROM settings WHERE key = 'app.default_model_id' AND value != '')
              AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app.pr_effort');

            INSERT INTO settings (key, value)
            SELECT 'app.review_fast_mode', value FROM settings
            WHERE key = 'app.default_fast_mode'
              AND EXISTS (SELECT 1 FROM settings WHERE key = 'app.default_model_id' AND value != '')
              AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app.review_fast_mode');

            INSERT INTO settings (key, value)
            SELECT 'app.pr_fast_mode', value FROM settings
            WHERE key = 'app.default_fast_mode'
              AND EXISTS (SELECT 1 FROM settings WHERE key = 'app.default_model_id' AND value != '')
              AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'app.pr_fast_mode');
            "#,
        )
        .context("Failed to materialize review/pr model defaults")
}

/// One-shot init for rows that still carry `display_order = 0` — the column
/// is freshly added or imported. Lays them out on the sparse 1024-step grid
/// in a stable order (pinned first, then by recency). Subsequent reorders
/// keep the gaps wide so a normal move is a single UPDATE.
///
/// Tolerant of legacy schemas that predate `pinned_at` / `created_at` so
/// the migration test bench (which seeds bare-bones tables) can run it.
fn seed_workspace_display_orders(connection: &Connection) -> Result<()> {
    if !has_table(connection, "workspaces") {
        return Ok(());
    }
    let zero_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM workspaces WHERE COALESCE(display_order, 0) <= 0",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if zero_rows == 0 {
        return Ok(());
    }
    let pinned_priority = if has_column(connection, "workspaces", "pinned_at") {
        "CASE WHEN pinned_at IS NOT NULL THEN 0 ELSE 1 END,
                        datetime(COALESCE(pinned_at, created_at)) DESC,"
    } else if has_column(connection, "workspaces", "created_at") {
        "datetime(created_at) DESC,"
    } else {
        ""
    };
    connection
        .execute_batch(&format!(
            r#"
            WITH ranked AS (
                SELECT id, ROW_NUMBER() OVER (
                    ORDER BY
                        {pinned_priority}
                        id DESC
                ) AS rn
                FROM workspaces
            )
            UPDATE workspaces
            SET display_order = (SELECT rn * {step} FROM ranked WHERE ranked.id = workspaces.id)
            WHERE COALESCE(display_order, 0) <= 0
              AND EXISTS (SELECT 1 FROM ranked WHERE ranked.id = workspaces.id);
            "#,
            pinned_priority = pinned_priority,
            step = sidebar_order::ORDER_STEP,
        ))
        .context("Failed to seed initial workspace display orders")
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
    display_order INTEGER NOT NULL DEFAULT 0,
    port_base INTEGER,
    port_count INTEGER,
    branch_intent TEXT DEFAULT 'from_branch',
    active_run_action_id TEXT,
    kind TEXT NOT NULL DEFAULT 'manual',
    ai_priming_consumed INTEGER NOT NULL DEFAULT 0,
    triage_source_type TEXT,
    triage_source_ref TEXT,
    parent_workspace_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repo_run_actions (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'concurrent',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_run_actions_repo
    ON repo_run_actions(repo_id, display_order);

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
    session_kind TEXT NOT NULL DEFAULT 'gui',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,
    content TEXT,
    sent_at TEXT,
    is_ai_priming INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_plan_state (
    session_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_message_id TEXT,
    plan_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_processes (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    workspace_id TEXT,
    script_type TEXT NOT NULL,
    pid INTEGER NOT NULL,
    pgid INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);

-- Connected Slack workspaces (one row per workspace the user has
-- imported). Credentials (xoxc + xoxd) live in the macOS Keychain via
-- `crate::slack::credentials`, never here. This table is just
-- non-secret metadata so the sidebar can list "which workspaces am I
-- connected to" without doing a keychain probe per render.
CREATE TABLE IF NOT EXISTS slack_workspaces (
    team_id TEXT PRIMARY KEY,
    team_name TEXT NOT NULL,
    team_domain TEXT NOT NULL,
    my_user_id TEXT NOT NULL,
    added_at INTEGER NOT NULL
);

-- AI triage fetcher: pre-computed candidate index.
-- Background fetchers write rows here. The local-LLM Layer-2 tick reads
-- `decision IS NULL` rows in batches. Heavy payloads live on disk under
-- `cache/triage/`, only `payload_path` is stored here.
CREATE TABLE IF NOT EXISTS triage_candidate (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    source_time TEXT NOT NULL,
    sender TEXT,
    title TEXT,
    preview TEXT,
    external_url TEXT,
    involvement_reason TEXT,
    payload_path TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL DEFAULT 0,
    decision TEXT,
    UNIQUE(source, source_ref)
);

-- Per-(source, source_parent) fetch checkpoint. Only IM-class fetchers
-- write rows here; forge fetchers don't use the cursor (gh/glab inbox
-- APIs do their own "what's new" filtering server-side).
CREATE TABLE IF NOT EXISTS triage_fetch_cursor (
    source TEXT NOT NULL,
    source_parent TEXT NOT NULL,
    last_source_time TEXT,
    PRIMARY KEY (source, source_parent)
);

-- Mobile browser companion: paired phones. Stores only a SHA-256 of the PAT,
-- never the plaintext. Survives desktop restarts so a phone never re-scans.
CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    pat_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_session_messages_sent_at ON session_messages(session_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_repository_id ON workspaces(repository_id);
CREATE INDEX IF NOT EXISTS idx_runtime_processes_ended_at ON runtime_processes(ended_at);
CREATE INDEX IF NOT EXISTS idx_triage_candidate_open ON triage_candidate(source_time DESC) WHERE decision IS NULL;
CREATE INDEX IF NOT EXISTS idx_triage_candidate_source ON triage_candidate(source, source_time DESC);
-- idx_workspaces_kind + idx_workspaces_triage_source are created in
-- `run_migrations` (after the ALTERs on upgraded DBs).

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

CREATE TRIGGER IF NOT EXISTS update_repo_run_actions_updated_at
    AFTER UPDATE ON repo_run_actions
    BEGIN
        UPDATE repo_run_actions SET updated_at = datetime('now')
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
        assert!(tables.contains(&"slack_workspaces".to_string()));
    }

    #[test]
    fn ensure_schema_is_idempotent() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        // Call again — should not error
        ensure_schema(&connection).unwrap();
    }

    fn insert_ws(
        connection: &Connection,
        id: &str,
        branch: &str,
        target: Option<&str>,
        parent: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO workspaces (id, repository_id, directory_name, state, status, branch, intended_target_branch, parent_workspace_id, display_order)
                 VALUES (?1, 'repo', ?1, 'ready', 'in-progress', ?2, ?3, ?4, 0)",
                rusqlite::params![id, branch, target, parent],
            )
            .unwrap();
    }

    fn target_of(connection: &Connection, id: &str) -> Option<String> {
        connection
            .query_row(
                "SELECT intended_target_branch FROM workspaces WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn backfill_repoints_stale_child_targets_at_parent_branch() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();

        // child's target is a stale snapshot of the parent's old branch name.
        insert_ws(&connection, "root", "feat/root", Some("main"), None);
        insert_ws(
            &connection,
            "child",
            "feat/child",
            Some("feat/root-OLD"),
            Some("root"),
        );
        insert_ws(&connection, "solo", "feat/solo", Some("main"), None);

        backfill_stacked_target_branches(&connection).unwrap();

        // Child now tracks the parent's LIVE branch; root + non-stacked untouched.
        assert_eq!(
            target_of(&connection, "child").as_deref(),
            Some("feat/root")
        );
        assert_eq!(target_of(&connection, "root").as_deref(), Some("main"));
        assert_eq!(target_of(&connection, "solo").as_deref(), Some("main"));

        // Idempotent: a second pass is a no-op.
        backfill_stacked_target_branches(&connection).unwrap();
        assert_eq!(
            target_of(&connection, "child").as_deref(),
            Some("feat/root")
        );
    }

    #[test]
    fn backfill_leaves_dangling_parent_targets_untouched() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        // parent id 'gone' does not exist — must NOT null out the target.
        insert_ws(
            &connection,
            "orphan",
            "feat/x",
            Some("stale-base"),
            Some("gone"),
        );

        backfill_stacked_target_branches(&connection).unwrap();

        assert_eq!(
            target_of(&connection, "orphan").as_deref(),
            Some("stale-base")
        );
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
    fn migration_remaps_claude_default_sentinel_to_pinned_opus_id() {
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();

        connection
            .execute_batch(
                r#"
                -- Claude session pinned to the legacy "default" sentinel.
                INSERT INTO sessions (id, model, agent_type) VALUES
                  ('claude-sess', 'default', 'claude');
                -- Legacy claude session with no agent_type (infers to claude).
                INSERT INTO sessions (id, model, agent_type) VALUES
                  ('legacy-sess', 'default', NULL);
                -- Cursor's "default" is its real Auto id — must stay put.
                INSERT INTO sessions (id, model, agent_type) VALUES
                  ('cursor-sess', 'default', 'cursor');
                -- Provider "enabled models" list still holding the sentinel.
                INSERT INTO settings (key, value) VALUES
                  ('app.claude_enabled_model_ids',
                   '["claude-fable-5[1m]","default","sonnet"]');
                -- "Models" settings: new JSON form, legacy bare form, and a
                -- cursor value that must survive ("cursor-default" has no
                -- quote-adjacent "default" substring).
                INSERT INTO settings (key, value) VALUES
                  ('app.default_model_id',
                   '{"provider":"claude","modelId":"default"}'),
                  ('app.review_model_id', 'default'),
                  ('app.pr_model_id',
                   '{"provider":"cursor","modelId":"cursor-default"}');
                "#,
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        let model = |id: &str| -> String {
            connection
                .query_row("SELECT model FROM sessions WHERE id = ?1", [id], |r| {
                    r.get(0)
                })
                .unwrap()
        };
        let setting = |key: &str| -> String {
            connection
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                    r.get(0)
                })
                .unwrap()
        };

        assert_eq!(model("claude-sess"), "claude-opus-4-8[1m]");
        assert_eq!(model("legacy-sess"), "claude-opus-4-8[1m]");
        assert_eq!(model("cursor-sess"), "default", "cursor Auto untouched");

        assert_eq!(
            setting("app.claude_enabled_model_ids"),
            r#"["claude-fable-5[1m]","claude-opus-4-8[1m]","sonnet"]"#
        );
        assert_eq!(
            setting("app.default_model_id"),
            r#"{"provider":"claude","modelId":"claude-opus-4-8[1m]"}"#,
            "JSON modelId rewritten"
        );
        assert_eq!(
            setting("app.review_model_id"),
            "claude-opus-4-8[1m]",
            "bare legacy id rewritten"
        );
        assert_eq!(
            setting("app.pr_model_id"),
            r#"{"provider":"cursor","modelId":"cursor-default"}"#,
            "cursor model preference untouched"
        );

        // Idempotent: re-running is a no-op on already-migrated rows.
        run_migrations(&connection).unwrap();
        assert_eq!(model("claude-sess"), "claude-opus-4-8[1m]");
        assert_eq!(
            setting("app.claude_enabled_model_ids"),
            r#"["claude-fable-5[1m]","claude-opus-4-8[1m]","sonnet"]"#
        );
        assert_eq!(
            setting("app.default_model_id"),
            r#"{"provider":"claude","modelId":"claude-opus-4-8[1m]"}"#
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

    #[test]
    fn migration_seeds_display_orders_for_unset_rows_and_is_idempotent() {
        let (connection, _dir) = open_test_db();
        connection
            .execute_batch(
                r#"
                CREATE TABLE repos (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    root_path TEXT,
                    created_at TEXT DEFAULT '2024-01-01T00:00:00Z'
                );
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    workspace_id TEXT,
                    status TEXT,
                    provider_session_id TEXT,
                    unread_count INTEGER DEFAULT 0,
                    model TEXT,
                    permission_mode TEXT DEFAULT 'default',
                    is_hidden INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT '2024-01-01T00:00:00Z',
                    updated_at TEXT DEFAULT '2024-01-01T00:00:00Z'
                );
                CREATE TABLE session_messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT,
                    role TEXT,
                    content TEXT,
                    sent_at TEXT
                );
                CREATE TABLE workspaces (
                    id TEXT PRIMARY KEY,
                    repository_id TEXT,
                    directory_name TEXT,
                    state TEXT DEFAULT 'ready',
                    status TEXT DEFAULT 'in-progress',
                    pinned_at TEXT,
                    mode TEXT DEFAULT 'worktree',
                    display_order INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT '2024-01-01T00:00:00Z',
                    updated_at TEXT DEFAULT '2024-01-01T00:00:00Z'
                );
                INSERT INTO repos (id, name, root_path) VALUES ('r1', 'repo', '/tmp/repo');
                INSERT INTO workspaces (id, repository_id, directory_name, status, display_order, created_at)
                VALUES
                    ('w-keep', 'r1', 'keep', 'in-progress', 1500, '2024-01-01T00:00:00Z'),
                    ('w-zero', 'r1', 'zero', 'in-progress', 0, '2024-01-02T00:00:00Z');
                "#,
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        let read_order = |id: &str| -> i64 {
            connection
                .query_row(
                    "SELECT display_order FROM workspaces WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap()
        };

        // Existing positive order is preserved untouched.
        assert_eq!(read_order("w-keep"), 1500);
        // Zero rows get seeded onto the sparse grid.
        assert!(read_order("w-zero") > 0);

        // Second run is a no-op.
        let before = read_order("w-zero");
        run_migrations(&connection).unwrap();
        assert_eq!(read_order("w-zero"), before);
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
                    run_script TEXT,
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
    fn legacy_run_script_columns_are_dropped_on_fresh_install() {
        // New installs never carry the retired columns. SCHEMA_SQL omits
        // them and `drop_dead_schema` would clean them up anyway.
        let (connection, _dir) = open_test_db();
        ensure_schema(&connection).unwrap();
        assert!(!column_exists(&connection, "repos", "run_script"));
        assert!(!column_exists(&connection, "repos", "run_script_mode"));
    }

    #[test]
    fn legacy_run_script_columns_backfill_into_repo_run_actions_then_drop() {
        // Legacy DBs carry `run_script` + `run_script_mode`. Migration
        // must move their values into `repo_run_actions` before
        // `drop_dead_schema` retires the columns.
        let (connection, _dir) = open_test_db();
        create_legacy_schema(&connection);
        connection
            .execute(
                "INSERT INTO repos (id, name, run_script, run_script_mode) VALUES ('r1', 'x', 'npm dev', 'non-concurrent')",
                [],
            )
            .unwrap();

        run_migrations(&connection).unwrap();

        assert!(!column_exists(&connection, "repos", "run_script"));
        assert!(!column_exists(&connection, "repos", "run_script_mode"));

        let (id, name, command, mode): (String, String, String, String) = connection
            .query_row(
                "SELECT id, name, command, mode FROM repo_run_actions WHERE repo_id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(id, "legacy:r1");
        assert_eq!(name, "Default");
        assert_eq!(command, "npm dev");
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

    fn read_setting(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok()
    }

    fn insert_setting(conn: &Connection, key: &str, value: &str) {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .unwrap();
    }

    #[test]
    fn review_pr_defaults_materialized_when_default_model_set() {
        let (conn, _dir) = open_test_db();
        ensure_schema(&conn).unwrap();
        insert_setting(&conn, "app.default_model_id", "claude-sonnet-4");
        insert_setting(&conn, "app.default_effort", "high");
        insert_setting(&conn, "app.default_fast_mode", "false");

        run_migrations(&conn).unwrap();

        assert_eq!(
            read_setting(&conn, "app.review_model_id").as_deref(),
            Some("claude-sonnet-4")
        );
        assert_eq!(
            read_setting(&conn, "app.pr_model_id").as_deref(),
            Some("claude-sonnet-4")
        );
        assert_eq!(
            read_setting(&conn, "app.review_effort").as_deref(),
            Some("high")
        );
        assert_eq!(
            read_setting(&conn, "app.pr_effort").as_deref(),
            Some("high")
        );
        assert_eq!(
            read_setting(&conn, "app.review_fast_mode").as_deref(),
            Some("false")
        );
        assert_eq!(
            read_setting(&conn, "app.pr_fast_mode").as_deref(),
            Some("false")
        );

        // Idempotent — second run is a no-op.
        run_migrations(&conn).unwrap();
        assert_eq!(
            read_setting(&conn, "app.review_model_id").as_deref(),
            Some("claude-sonnet-4")
        );
    }

    #[test]
    fn review_pr_defaults_skip_when_default_model_absent() {
        // No default_model_id → no promotion (consumers handle the fallback).
        let (conn, _dir) = open_test_db();
        ensure_schema(&conn).unwrap();
        insert_setting(&conn, "app.default_effort", "high");
        insert_setting(&conn, "app.default_fast_mode", "true");

        run_migrations(&conn).unwrap();

        assert!(read_setting(&conn, "app.review_model_id").is_none());
        assert!(read_setting(&conn, "app.pr_model_id").is_none());
        assert!(read_setting(&conn, "app.review_effort").is_none());
        assert!(read_setting(&conn, "app.pr_effort").is_none());
        assert!(read_setting(&conn, "app.review_fast_mode").is_none());
        assert!(read_setting(&conn, "app.pr_fast_mode").is_none());
    }

    #[test]
    fn review_pr_defaults_preserve_existing_user_overrides() {
        let (conn, _dir) = open_test_db();
        ensure_schema(&conn).unwrap();
        insert_setting(&conn, "app.default_model_id", "claude-sonnet-4");
        insert_setting(&conn, "app.default_effort", "high");
        insert_setting(&conn, "app.default_fast_mode", "false");
        // User already decoupled review_model_id explicitly.
        insert_setting(&conn, "app.review_model_id", "gpt-5");
        insert_setting(&conn, "app.review_effort", "low");

        run_migrations(&conn).unwrap();

        // User overrides untouched.
        assert_eq!(
            read_setting(&conn, "app.review_model_id").as_deref(),
            Some("gpt-5")
        );
        assert_eq!(
            read_setting(&conn, "app.review_effort").as_deref(),
            Some("low")
        );
        // Other unset fields still get materialized.
        assert_eq!(
            read_setting(&conn, "app.pr_model_id").as_deref(),
            Some("claude-sonnet-4")
        );
        assert_eq!(
            read_setting(&conn, "app.pr_effort").as_deref(),
            Some("high")
        );
    }

    #[test]
    fn review_pr_defaults_skip_empty_default_model_id() {
        // Empty string == null sentinel.
        let (conn, _dir) = open_test_db();
        ensure_schema(&conn).unwrap();
        insert_setting(&conn, "app.default_model_id", "");
        insert_setting(&conn, "app.default_effort", "high");

        run_migrations(&conn).unwrap();

        assert!(read_setting(&conn, "app.review_model_id").is_none());
        assert!(read_setting(&conn, "app.pr_model_id").is_none());
        assert!(read_setting(&conn, "app.review_effort").is_none());
    }
}
