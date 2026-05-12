//! Integration snapshot coverage for `build_send_message_params`.
//!
//! Touches the `agents/` persistence layer (reads `linked_directory_paths`
//! via the configured data-dir DB), so the project's test policy
//! (CLAUDE.md) requires snapshot coverage under `src-tauri/tests/`.
//!
//! We exercise the full workspace → streaming bridge: seed a DB with a
//! workspace + session + linked-directory rows, call the public param
//! builder, and snapshot the outgoing sidecar JSON.

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use helmor_lib::agents::{build_send_message_params, BuildSendMessageParamsInput};
use helmor_lib::data_dir;
use helmor_lib::db;
use insta::assert_yaml_snapshot;
use serde_json::Value;
use tempfile::TempDir;

/// Serialize intra-binary access to the process-wide `HELMOR_DATA_DIR`
/// env var. Cargo runs each test binary in its own OS process, so we
/// don't need to coordinate with the unit-test crate's own lock.
static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// RAII test env: takes the env-var lock, overrides `HELMOR_DATA_DIR`,
/// runs migrations, and cleans up on drop.
struct TestEnv {
    _dir: TempDir,
    _lock: MutexGuard<'static, ()>,
}

impl TestEnv {
    fn new() -> Self {
        let lock = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HELMOR_DATA_DIR", dir.path());
        data_dir::ensure_directory_structure().unwrap();
        let conn = rusqlite::Connection::open(data_dir::db_path().unwrap()).unwrap();
        helmor_lib::schema::ensure_schema(&conn).unwrap();
        // Rebuild the connection pool so `read_conn()` sees the fresh
        // data dir. The lib's prod fast path caches the pool path, and
        // integration tests link against the lib in non-test mode.
        db::init_pools().unwrap();
        conn.execute(
            "INSERT INTO repos (id, name, default_branch) VALUES ('r-1', 'Repo One', 'main')",
            [],
        )
        .unwrap();
        Self {
            _dir: dir,
            _lock: lock,
        }
    }

    fn connection(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(data_dir::db_path().unwrap()).unwrap()
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        std::env::remove_var("HELMOR_DATA_DIR");
    }
}

fn seed_workspace_session(
    conn: &rusqlite::Connection,
    ws_id: &str,
    session_id: &str,
    linked: Option<&str>,
) {
    conn.execute(
        "INSERT INTO workspaces (id, repository_id, directory_name, state,
         status, linked_directory_paths)
         VALUES (?1, 'r-1', 'example', 'ready', 'in-progress', ?2)",
        rusqlite::params![ws_id, linked],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO sessions (id, workspace_id, status)
         VALUES (?1, ?2, 'idle')",
        [session_id, ws_id],
    )
    .unwrap();
}

fn build(input: BuildSendMessageParamsInput<'_>) -> Value {
    build_send_message_params(input)
}

fn base_input<'a>(session_id: Option<&'a str>) -> BuildSendMessageParamsInput<'a> {
    BuildSendMessageParamsInput {
        sidecar_session_id: "sidecar-sess-1",
        prompt: "hello",
        cli_model: "claude-opus-4",
        cwd: "/abs/workspace",
        resume_session_id: None,
        provider: "claude",
        effort_level: Some("high"),
        permission_mode: Some("bypassPermissions"),
        fast_mode: false,
        helmor_session_id: session_id,
        claude_base_url: None,
        claude_auth_token: None,
        claude_thinking_display: None,
        images: &[],
    }
}

#[test]
fn omits_additional_directories_when_session_has_none() {
    let env = TestEnv::new();
    seed_workspace_session(&env.connection(), "w-1", "s-1", None);

    let params = build(base_input(Some("s-1")));
    assert_yaml_snapshot!("params_without_linked_dirs", &params);
}

#[test]
fn includes_additional_directories_from_workspace() {
    let env = TestEnv::new();
    seed_workspace_session(
        &env.connection(),
        "w-2",
        "s-2",
        Some(r#"["/abs/claw-code","/abs/rust"]"#),
    );

    let params = build(base_input(Some("s-2")));
    assert_yaml_snapshot!("params_with_linked_dirs", &params);
}

#[test]
fn includes_claude_environment_for_custom_provider() {
    let env = TestEnv::new();
    seed_workspace_session(&env.connection(), "w-3", "s-3", None);

    let mut input = base_input(Some("s-3"));
    input.claude_base_url = Some("https://api.example.com/anthropic");
    input.claude_auth_token = Some("sk-test");

    let params = build(input);
    assert_yaml_snapshot!("params_with_claude_environment", &params);
}

#[test]
fn omits_additional_directories_when_helmor_session_id_is_absent() {
    // New session that hasn't been written to the DB yet — common for the
    // first turn. Must not emit additionalDirectories.
    let env = TestEnv::new();
    seed_workspace_session(&env.connection(), "w-3", "s-3", Some(r#"["/abs/a"]"#));

    let params = build(base_input(None));
    assert_yaml_snapshot!("params_for_new_session", &params);
}

#[test]
fn malformed_linked_column_falls_back_to_no_directories() {
    let env = TestEnv::new();
    seed_workspace_session(&env.connection(), "w-4", "s-4", Some("not-valid-json"));

    let params = build(base_input(Some("s-4")));
    assert_yaml_snapshot!("params_malformed_linked_column", &params);
}

#[test]
fn includes_source_repo_path_when_repo_has_root_path() {
    let env = TestEnv::new();
    let conn = env.connection();
    conn.execute(
        "UPDATE repos SET root_path = '/Users/me/repos/my-repo' WHERE id = 'r-1'",
        [],
    )
    .unwrap();
    seed_workspace_session(&conn, "w-5", "s-5", None);

    let params = build(base_input(Some("s-5")));
    assert_yaml_snapshot!("params_with_source_repo_path", &params);
}
