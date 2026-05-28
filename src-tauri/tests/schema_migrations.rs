use helmor_lib::schema;
use insta::assert_yaml_snapshot;

fn repos_branch_prefix_columns(connection: &rusqlite::Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT name, type FROM pragma_table_info('repos')
             WHERE name LIKE 'branch_prefix%'
             ORDER BY cid",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn repos_review_columns(connection: &rusqlite::Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT name, type FROM pragma_table_info('repos')
             WHERE name IN ('custom_prompt_review', 'custom_prompt_review_pr')
             ORDER BY cid",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn workspaces_setup_completed_at_columns(
    connection: &rusqlite::Connection,
) -> Vec<(String, String, i64, Option<String>)> {
    let mut statement = connection
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value
             FROM pragma_table_info('workspaces')
             WHERE name = 'setup_completed_at'",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn workspaces_port_columns(
    connection: &rusqlite::Connection,
) -> Vec<(String, String, i64, Option<String>)> {
    let mut statement = connection
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value
             FROM pragma_table_info('workspaces')
             WHERE name IN ('port_base', 'port_count')
             ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn repo_run_actions_stop_columns(
    connection: &rusqlite::Connection,
) -> Vec<(String, String, i64, Option<String>)> {
    let mut statement = connection
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value
             FROM pragma_table_info('repo_run_actions')
             WHERE name LIKE 'stop_%'
             ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn repos_branch_prefix_override_migration_is_idempotent() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE repos (
                id TEXT PRIMARY KEY,
                name TEXT,
                default_branch TEXT,
                root_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
        .unwrap();

    schema::ensure_schema(&connection).unwrap();
    schema::ensure_schema(&connection).unwrap();

    assert_yaml_snapshot!(
        "repos_branch_prefix_override_migration",
        repos_branch_prefix_columns(&connection)
    );
}

#[test]
fn repos_review_migration_adds_column_when_missing() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    // Bare repos table missing both the legacy and new review columns.
    connection
        .execute_batch(
            r#"
            CREATE TABLE repos (
                id TEXT PRIMARY KEY,
                name TEXT,
                default_branch TEXT,
                root_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            "#,
        )
        .unwrap();

    schema::ensure_schema(&connection).unwrap();
    // Second call must be a no-op — the migration guard checks pragma_table_info
    // before issuing ALTER TABLE.
    schema::ensure_schema(&connection).unwrap();

    assert_yaml_snapshot!(
        "repos_review_migration_add",
        repos_review_columns(&connection)
    );
}

#[test]
fn repos_review_migration_renames_legacy_column() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    // Old DB shape: legacy custom_prompt_review_pr is present, the new
    // custom_prompt_review is not. The migration must rename so any user
    // prompt persisted under the old column is preserved.
    connection
        .execute_batch(
            r#"
            CREATE TABLE repos (
                id TEXT PRIMARY KEY,
                name TEXT,
                default_branch TEXT,
                root_path TEXT,
                custom_prompt_review_pr TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO repos (id, name, custom_prompt_review_pr)
            VALUES ('r1', 'demo', 'keep me');
            "#,
        )
        .unwrap();

    schema::ensure_schema(&connection).unwrap();
    schema::ensure_schema(&connection).unwrap();

    let preserved: Option<String> = connection
        .query_row(
            "SELECT custom_prompt_review FROM repos WHERE id = 'r1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(preserved.as_deref(), Some("keep me"));

    assert_yaml_snapshot!(
        "repos_review_migration_rename",
        repos_review_columns(&connection)
    );
}

#[test]
fn workspaces_setup_completed_at_migration_adds_column_when_missing() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    // Pre-existing workspaces table from before the column existed.
    connection
        .execute_batch(
            r#"
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY,
                repository_id TEXT,
                directory_name TEXT,
                state TEXT DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO workspaces (id, repository_id, directory_name)
            VALUES ('w1', 'r1', 'demo');
            "#,
        )
        .unwrap();

    schema::ensure_schema(&connection).unwrap();
    // Idempotency: the guard MUST short-circuit on the second pass —
    // ALTER TABLE ADD COLUMN twice would fail otherwise.
    schema::ensure_schema(&connection).unwrap();

    // Existing rows get NULL (not "" or 0) — that's the value the inspector
    // uses to tell "ran in another session" apart from "never ran."
    let preserved: Option<String> = connection
        .query_row(
            "SELECT setup_completed_at FROM workspaces WHERE id = 'w1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(preserved.is_none());

    assert_yaml_snapshot!(
        "workspaces_setup_completed_at_migration",
        workspaces_setup_completed_at_columns(&connection)
    );
}

#[test]
fn workspaces_port_range_migration_adds_columns_when_missing() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    // Pre-existing workspaces table from before the port-range columns
    // existed. Carry one row so we can prove the migration leaves
    // legacy data NULL rather than back-filling — allocation is lazy.
    connection
        .execute_batch(
            r#"
            CREATE TABLE workspaces (
                id TEXT PRIMARY KEY,
                repository_id TEXT,
                directory_name TEXT,
                state TEXT DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO workspaces (id, repository_id, directory_name)
            VALUES ('w1', 'r1', 'demo');
            "#,
        )
        .unwrap();

    schema::ensure_schema(&connection).unwrap();
    // Idempotency: ALTER TABLE ADD COLUMN twice would error, so the
    // guard must short-circuit on the second pass.
    schema::ensure_schema(&connection).unwrap();

    let (base, count): (Option<i64>, Option<i64>) = connection
        .query_row(
            "SELECT port_base, port_count FROM workspaces WHERE id = 'w1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(
        base.is_none() && count.is_none(),
        "legacy workspace rows must stay NULL until lazy allocation runs"
    );

    assert_yaml_snapshot!(
        "workspaces_port_range_migration",
        workspaces_port_columns(&connection)
    );
}

#[test]
fn repo_run_actions_stop_command_migration_adds_column_when_missing() {
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    // Pre-existing repo_run_actions table from before stop_command — must
    // also have the parent `repos` row + `repos.id` PK so the FK in
    // repo_run_actions can resolve when ensure_schema rebuilds anything.
    // Seed one action so we can assert the migration leaves it intact
    // with a NULL stop_command (existing rows must not be back-filled).
    connection
        .execute_batch(
            r#"
            CREATE TABLE repos (
                id TEXT PRIMARY KEY,
                name TEXT,
                default_branch TEXT,
                root_path TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO repos (id, name) VALUES ('r1', 'demo');
            CREATE TABLE repo_run_actions (
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
            INSERT INTO repo_run_actions (id, repo_id, name, command)
            VALUES ('a1', 'r1', 'Dev', 'npm run dev');
            "#,
        )
        .unwrap();

    schema::ensure_schema(&connection).unwrap();
    // Idempotency: a second pass must NOT error, even though the column
    // now exists. The guard is `!has_column(...)`.
    schema::ensure_schema(&connection).unwrap();

    // The pre-existing row's stop_command must still be NULL — the
    // migration adds the column but never back-fills.
    let stop_command: Option<String> = connection
        .query_row(
            "SELECT stop_command FROM repo_run_actions WHERE id = 'a1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        stop_command.is_none(),
        "existing repo_run_actions rows must keep stop_command NULL after migration"
    );

    assert_yaml_snapshot!(
        "repo_run_actions_stop_command_migration",
        repo_run_actions_stop_columns(&connection)
    );
}
