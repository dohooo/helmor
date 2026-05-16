//! Spawn the real `helmor-server` binary and drive it through
//! `RpcClient`. Proves the full vertical works end-to-end: the
//! binary's stdin/stdout plumbing, the codec across a real OS pipe
//! boundary, the handshake gate, dispatch, and the `LocalRuntime`
//! `workspace_status` implementation against a real git repo.
//!
//! Why an integration test (not a unit test): unit tests can't see
//! `env!("CARGO_BIN_EXE_helmor-server")` — Cargo only sets that for
//! integration test crates. Putting this here also means it
//! automatically rebuilds the binary when the test runs, so a stale
//! binary can't mask a regression in the source.

use std::path::Path;
use std::process::Command;

use helmor_lib::remote::{
    RemoteRuntime, RemoteSshRuntime, RpcClient, RuntimeKind, WorkspaceStatusMethod,
    WorkspaceStatusParams,
};

/// Path to the just-built `helmor-server` binary. Provided by Cargo
/// when building integration tests for this crate.
const HELMOR_SERVER_BIN: &str = env!("CARGO_BIN_EXE_helmor-server");

fn run_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap_or_else(|e| panic!("git {args:?} failed to spawn: {e}"));
    assert!(
        output.status.success(),
        "git {args:?} in {} failed: {}",
        repo.display(),
        String::from_utf8_lossy(&output.stderr),
    );
}

fn init_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("create temp dir");
    run_git(dir.path(), &["init"]);
    run_git(dir.path(), &["checkout", "-b", "main"]);
    run_git(dir.path(), &["config", "user.email", "helmor@example.com"]);
    run_git(dir.path(), &["config", "user.name", "Helmor Test"]);
    run_git(dir.path(), &["config", "commit.gpgsign", "false"]);
    std::fs::write(dir.path().join("file.txt"), "base\n").unwrap();
    run_git(dir.path(), &["add", "file.txt"]);
    run_git(dir.path(), &["commit", "-m", "initial"]);
    dir
}

#[test]
fn spawned_helmor_server_completes_handshake_via_rpc_client() {
    let cmd = Command::new(HELMOR_SERVER_BIN);
    let client = RpcClient::connect_command(cmd, "helmor-server-test".into())
        .expect("handshake against spawned helmor-server should succeed");

    let info = client.server_info();
    assert_eq!(info.protocol_version, helmor_lib::remote::PROTOCOL_VERSION);
    assert!(
        !info.server_version.is_empty(),
        "server should report a non-empty version"
    );
    assert!(
        !info.hostname.is_empty(),
        "server should report a non-empty hostname"
    );
}

#[test]
fn spawned_helmor_server_returns_clean_workspace_status_for_fresh_repo() {
    let repo = init_repo();
    let cmd = Command::new(HELMOR_SERVER_BIN);
    let client = RpcClient::connect_command(cmd, "helmor-server-test".into())
        .expect("handshake against spawned helmor-server should succeed");

    let status = client
        .call::<WorkspaceStatusMethod>(WorkspaceStatusParams {
            workspace_dir: repo.path().display().to_string(),
        })
        .expect("workspace.status RPC should succeed against fresh repo");

    assert!(status.is_clean, "fresh init_repo should report clean");
    assert!(status.changed_paths.is_empty());
}

#[test]
fn spawned_helmor_server_surfaces_dirty_paths_via_remote_ssh_runtime_trait() {
    // Exercises the full RemoteRuntime trait surface — same code
    // path the desktop app uses when it routes a workspace through
    // a remote registry entry.
    let repo = init_repo();
    std::fs::write(repo.path().join("file.txt"), "changed\n").unwrap();
    std::fs::write(repo.path().join("new.txt"), "new\n").unwrap();

    let cmd = Command::new(HELMOR_SERVER_BIN);
    let client = RpcClient::connect_command(cmd, "helmor-server-test".into())
        .expect("handshake against spawned helmor-server should succeed");
    let runtime = RemoteSshRuntime::new(client, "helmor-server-test");

    // runtime_health pulls from the cached InitializeResult — no
    // round-trip — but with a Remote kind because RemoteSshRuntime
    // always reports remote even when the child is local.
    let health = runtime.runtime_health().unwrap();
    assert!(
        matches!(health.kind, RuntimeKind::Remote { .. }),
        "RemoteSshRuntime should report Remote kind: {health:?}",
    );

    let status = runtime
        .workspace_status(repo.path())
        .expect("workspace_status round-trip should succeed");
    assert!(!status.is_clean);
    assert_eq!(
        status.changed_paths,
        vec!["file.txt".to_string(), "new.txt".to_string()],
        "porcelain output should round-trip through the binary verbatim",
    );
}

#[test]
fn helmor_server_version_flag_prints_version_and_exits_zero() {
    // The auto-install probe runs `ssh host '<binary> --version'`
    // and treats a non-empty first stdout line as "binary present".
    // Running it locally proves the binary itself supports the flag
    // without booting the RPC loop — a missing `--version` would
    // hang the probe waiting for JSON-RPC bytes that never come.
    let output = Command::new(HELMOR_SERVER_BIN)
        .arg("--version")
        .output()
        .expect("failed to spawn helmor-server --version");

    assert!(
        output.status.success(),
        "helmor-server --version must exit 0 for the probe to read it: {:?}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("helmor-server"),
        "version output should name the binary: {stdout:?}"
    );
    assert!(
        stdout.contains("protocol"),
        "version output should advertise the protocol version: {stdout:?}"
    );
}
