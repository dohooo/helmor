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
