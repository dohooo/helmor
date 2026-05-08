//! Integration test — repo preferences resolution.
//!
//! Exercises the full flow: insert a repo, save global preferences, save
//! per-repo overrides with mixed inherit flags, load resolved preferences,
//! assert effective values match expectations per field.
//!
//! Mirrors the TestEnv pattern established in `streaming_send_params.rs`.

use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use helmor_lib::data_dir;
use helmor_lib::db;
use helmor_lib::models::repos::{InheritFlags, RepoPreferences};
use tempfile::TempDir;

/// Serialize intra-binary access to the process-wide `HELMOR_DATA_DIR`
/// env var. Cargo runs each test binary in its own OS process, so this
/// lock only needs to coordinate tests within this binary.
static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// RAII test env: takes the env-var lock, overrides `HELMOR_DATA_DIR`,
/// runs migrations, rebuilds DB pools, and cleans up on drop.
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
        // Rebuild the connection pool so `read_conn()`/`write_conn()` see
        // the fresh data dir. Integration tests link against the lib in
        // non-test mode where the prod fast path caches the pool path.
        db::init_pools().unwrap();
        // Insert a minimal repo row.
        conn.execute(
            "INSERT INTO repos (id, name, default_branch, root_path) VALUES ('repo-1', 'Test Repo', 'main', '/tmp/test-repo')",
            [],
        )
        .unwrap();
        // Default all inherit flags to 1 (same as insert_repository does).
        conn.execute(
            r#"UPDATE repos SET
                 inherit_global_create_pr = 1,
                 inherit_global_review = 1,
                 inherit_global_fix_errors = 1,
                 inherit_global_resolve_conflicts = 1,
                 inherit_global_rename_branch = 1,
                 inherit_global_general = 1
               WHERE id = 'repo-1'"#,
            [],
        )
        .unwrap();
        Self {
            _dir: dir,
            _lock: lock,
        }
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        std::env::remove_var("HELMOR_DATA_DIR");
    }
}

/// Save global preferences, then set per-repo overrides for some fields
/// while leaving others on inherit. Assert that:
///   - inherited fields resolve to the global value,
///   - overridden fields resolve to the per-repo value,
///   - the `overrides` and `inherit` slots on the resolved struct are correct.
#[test]
fn mixed_inherit_and_override_resolves_correctly() {
    let _env = TestEnv::new();

    // Save a global template with values for three fields.
    let global = RepoPreferences {
        review: Some("Global: focus on correctness".to_string()),
        fix_errors: Some("Global: auto-fix lint errors".to_string()),
        general: Some("Global: be concise".to_string()),
        ..RepoPreferences::default()
    };
    helmor_lib::models::settings::save_global_repo_preferences(&global).unwrap();

    // Per-repo: override `review` and `create_pr`; inherit `fix_errors` and `general`.
    let overrides = RepoPreferences {
        create_pr: Some("Per-repo: include ticket number".to_string()),
        review: Some("Per-repo: focus on SQL injection".to_string()),
        ..RepoPreferences::default()
    };
    let inherit = InheritFlags {
        create_pr: false,         // explicit per-repo override
        review: false,            // explicit per-repo override
        fix_errors: true,         // inherit from global
        resolve_conflicts: false, // no global, no override → None
        branch_rename: false,     // no global, no override → None
        general: true,            // inherit from global
    };
    helmor_lib::models::repos::update_repo_preferences("repo-1", &overrides, &inherit).unwrap();

    // Load resolved preferences.
    let resolved = helmor_lib::models::repos::load_repo_preferences("repo-1").unwrap();

    // --- effective values ---

    // create_pr: inherit=false, per-repo override is set → per-repo wins.
    assert_eq!(
        resolved.effective.create_pr.as_deref(),
        Some("Per-repo: include ticket number"),
        "create_pr: per-repo override should win when inherit=false"
    );

    // review: inherit=false, per-repo override is set → per-repo wins.
    assert_eq!(
        resolved.effective.review.as_deref(),
        Some("Per-repo: focus on SQL injection"),
        "review: per-repo override should win when inherit=false"
    );

    // fix_errors: inherit=true, global has a value → global wins.
    assert_eq!(
        resolved.effective.fix_errors.as_deref(),
        Some("Global: auto-fix lint errors"),
        "fix_errors: global should be used when inherit=true"
    );

    // resolve_conflicts: inherit=false, no per-repo override, no global → None.
    assert_eq!(
        resolved.effective.resolve_conflicts, None,
        "resolve_conflicts: no override and no global → effective should be None"
    );

    // branch_rename: inherit=false, no per-repo override → None.
    assert_eq!(
        resolved.effective.branch_rename, None,
        "branch_rename: no override → effective should be None"
    );

    // general: inherit=true, global has a value → global wins.
    assert_eq!(
        resolved.effective.general.as_deref(),
        Some("Global: be concise"),
        "general: global should be used when inherit=true"
    );

    // --- override slot ---

    assert_eq!(
        resolved.overrides.create_pr.as_deref(),
        Some("Per-repo: include ticket number")
    );
    assert_eq!(
        resolved.overrides.review.as_deref(),
        Some("Per-repo: focus on SQL injection")
    );
    assert_eq!(resolved.overrides.fix_errors, None);
    assert_eq!(resolved.overrides.general, None);

    // --- inherit flags stored correctly ---

    assert!(!resolved.inherit.create_pr);
    assert!(!resolved.inherit.review);
    assert!(resolved.inherit.fix_errors);
    assert!(!resolved.inherit.resolve_conflicts);
    assert!(!resolved.inherit.branch_rename);
    assert!(resolved.inherit.general);

    // --- global snapshot in the resolved struct ---

    assert_eq!(
        resolved.global.review.as_deref(),
        Some("Global: focus on correctness")
    );
    assert_eq!(
        resolved.global.fix_errors.as_deref(),
        Some("Global: auto-fix lint errors")
    );
    assert_eq!(
        resolved.global.general.as_deref(),
        Some("Global: be concise")
    );
}
