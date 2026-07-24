//! R4-A lazy-rematerialize tests. All remotes are local bare repos on disk
//! (no network); `member_creds` has no tokens in tests, so the auth
//! injection path stays empty — exactly the public-repo/desktop shape.

use std::fs;
use std::path::{Path, PathBuf};

use super::*;
use crate::error::extract_code;
use crate::testkit::TestEnv;

fn run_git(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git spawn");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Bare origin with one commit on `main`; returns its path.
fn init_bare_origin(env: &TestEnv) -> PathBuf {
    let origin = env.root.join("origin.git");
    let seed = env.root.join("seed");
    fs::create_dir_all(&seed).unwrap();
    run_git(&seed, &["init", "-b", "main"]);
    run_git(&seed, &["config", "user.email", "test@helmor.test"]);
    run_git(&seed, &["config", "user.name", "Test"]);
    fs::write(seed.join("README.md"), "hello").unwrap();
    run_git(&seed, &["add", "."]);
    run_git(&seed, &["commit", "-m", "init"]);
    run_git(&seed, &["clone", "--bare", ".", origin.to_str().unwrap()]);
    origin
}

fn seed_repo_row(env: &TestEnv, repo_id: &str, root_path: &Path, remote_url: &str) {
    let conn = env.db_connection();
    conn.execute(
        "INSERT INTO repos (id, name, root_path, remote_url, remote, default_branch) \
         VALUES (?1, 'repo', ?2, ?3, 'origin', 'main')",
        rusqlite::params![repo_id, root_path.to_str().unwrap(), remote_url],
    )
    .unwrap();
}

fn seed_worktree_workspace(env: &TestEnv, workspace_id: &str, repo_id: &str, branch: &str) {
    let conn = env.db_connection();
    conn.execute(
        "INSERT INTO workspaces (id, repository_id, directory_name, state, status, mode, \
         branch, display_order) \
         VALUES (?1, ?2, ?3, 'ready', 'in-progress', 'worktree', ?4, 0)",
        rusqlite::params![workspace_id, repo_id, format!("dir-{workspace_id}"), branch],
    )
    .unwrap();
}

fn assert_tmp_free(parent: &Path) {
    if !parent.exists() {
        return;
    }
    for entry in fs::read_dir(parent).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.contains(".tmp-"), "temp clone residue: {name}");
    }
}

#[test]
fn ensure_repo_source_reclones_missing_repo_with_clean_origin() {
    let env = TestEnv::new("remat-reclone");
    let origin = init_bare_origin(&env);
    let root = env.root.join("clones").join("repo");
    seed_repo_row(&env, "r1", &root, origin.to_str().unwrap());
    assert!(!root.exists());

    let resolved = ensure_repo_source("r1").unwrap();
    assert_eq!(resolved, root);
    assert!(root.join(".git").exists());
    // Remote-tracking refs restored by the full-refspec fetch.
    run_git(
        &root,
        &["rev-parse", "--verify", "refs/remotes/origin/main"],
    );
    // Architect-mandated regression: origin URL must be the clean stored
    // remote_url — no userinfo / token ever persisted into git config.
    let url = run_git(&root, &["remote", "get-url", "origin"]);
    assert_eq!(url, origin.to_str().unwrap());
    assert!(
        !url.contains('@'),
        "origin URL must carry no userinfo: {url}"
    );
    // No temp-clone residue.
    assert_tmp_free(root.parent().unwrap());
}

#[test]
fn ensure_workspace_materialized_rebuilds_pushed_branch_worktree() {
    let env = TestEnv::new("remat-worktree");
    let origin = init_bare_origin(&env);
    // Push a feature branch to the origin.
    let seed = env.root.join("seed");
    run_git(
        &seed,
        &["remote", "add", "origin", origin.to_str().unwrap()],
    );
    run_git(&seed, &["checkout", "-b", "feat/x"]);
    fs::write(seed.join("f.txt"), "x").unwrap();
    run_git(&seed, &["add", "."]);
    run_git(&seed, &["commit", "-m", "feat"]);
    run_git(&seed, &["push", "origin", "feat/x"]);
    let pushed_sha = run_git(&seed, &["rev-parse", "feat/x"]);

    let root = env.root.join("clones").join("repo");
    seed_repo_row(&env, "r1", &root, origin.to_str().unwrap());
    seed_worktree_workspace(&env, "w1", "r1", "feat/x");

    let path = ensure_workspace_materialized("w1").unwrap();
    assert!(path.is_dir());
    assert_eq!(run_git(&path, &["rev-parse", "HEAD"]), pushed_sha);
    assert_eq!(
        run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feat/x"
    );
    // Second call is the fast path.
    assert_eq!(ensure_workspace_materialized("w1").unwrap(), path);
}

#[test]
fn ensure_workspace_materialized_rebuilds_unpushed_branch_from_default_with_trace() {
    let env = TestEnv::new("remat-unpushed");
    let origin = init_bare_origin(&env);
    let root = env.root.join("clones").join("repo");
    seed_repo_row(&env, "r1", &root, origin.to_str().unwrap());
    seed_worktree_workspace(&env, "w1", "r1", "feat/never-pushed");
    {
        let conn = env.db_connection();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, status) VALUES ('s1', 'w1', 'idle')",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE workspaces SET active_session_id = 's1' WHERE id = 'w1'",
            [],
        )
        .unwrap();
    }

    let path = ensure_workspace_materialized("w1").unwrap();
    assert!(path.is_dir());
    assert_eq!(
        run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feat/never-pushed"
    );
    // Rebuilt from the default branch tip.
    assert_eq!(
        run_git(&path, &["rev-parse", "HEAD"]),
        run_git(&root, &["rev-parse", "refs/remotes/origin/main"]),
    );
    // Honest trace persisted into the active session.
    let conn = env.db_connection();
    let (role, content): (String, String) = conn
        .query_row(
            "SELECT role, content FROM session_messages WHERE session_id = 's1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(role, "system");
    let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(parsed["subtype"], "workspace_rebuilt");
    assert!(parsed["message"]
        .as_str()
        .unwrap()
        .contains("Unpushed work is not recoverable"));
}

#[test]
fn concurrent_ensure_repo_source_clones_exactly_once() {
    let env = TestEnv::new("remat-concurrent");
    let origin = init_bare_origin(&env);
    let root = env.root.join("clones").join("repo");
    seed_repo_row(&env, "r1", &root, origin.to_str().unwrap());

    let results: Vec<_> = std::thread::scope(|scope| {
        (0..2)
            .map(|_| scope.spawn(|| ensure_repo_source("r1")))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    for result in results {
        assert_eq!(result.unwrap(), root);
    }
    // Exactly one clone landed: the parent holds only the final dir, no
    // `.tmp-*` residue from a second racing clone.
    let entries: Vec<_> = fs::read_dir(root.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["repo".to_string()]);
}

#[test]
fn ensure_repo_source_bad_url_is_typed_and_leaves_no_residue() {
    let env = TestEnv::new("remat-bad-url");
    let root = env.root.join("clones").join("repo");
    seed_repo_row(
        &env,
        "r1",
        &root,
        env.root.join("nonexistent.git").to_str().unwrap(),
    );

    let error = ensure_repo_source("r1").unwrap_err();
    assert_eq!(extract_code(&error), ErrorCode::RepoSourceUnavailable);
    assert!(!root.exists());
    assert_tmp_free(root.parent().unwrap());
}

#[test]
fn record_to_detail_reports_expected_path_and_materialized() {
    let env = TestEnv::new("remat-detail");
    let root = env.root.join("clones").join("repo");
    seed_repo_row(&env, "r1", &root, "https://example.com/o/r.git");
    seed_worktree_workspace(&env, "w1", "r1", "feat/x");

    let record = workspace_models::load_workspace_record_by_id("w1")
        .unwrap()
        .unwrap();
    let expected = helpers::workspace_path(&record).unwrap();
    let detail = crate::workspaces::record_to_detail(record);
    // Missing directory no longer nulls rootPath (R4-A) — PASSIVE reads
    // report the expected path plus materialized=false, without rebuilding.
    assert_eq!(detail.root_path.as_deref(), expected.to_str());
    assert!(!detail.materialized);
    assert!(!expected.exists(), "PASSIVE read must not materialize");

    // Archived workspaces still report no path.
    {
        let conn = env.db_connection();
        conn.execute(
            "UPDATE workspaces SET state = 'archived' WHERE id = 'w1'",
            [],
        )
        .unwrap();
    }
    let record = workspace_models::load_workspace_record_by_id("w1")
        .unwrap()
        .unwrap();
    let detail = crate::workspaces::record_to_detail(record);
    assert_eq!(detail.root_path, None);
    assert!(!detail.materialized);
}
