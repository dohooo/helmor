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

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use helmor_lib::remote::{
    methods::{
        PingMethod, PingParams, TerminalAttachParams, TerminalCloseParams, TerminalEventKind,
        TerminalEventNotification, TerminalListParams, TerminalOpenParams, TerminalWriteParams,
        WorkspaceBundleBeginMethod, WorkspaceBundleBeginParams, WorkspaceBundleChunkMethod,
        WorkspaceBundleChunkParams, WorkspaceBundleEndMethod, WorkspaceBundleEndParams,
        WorkspaceBundleMethod, WorkspaceBundleParams, WorkspaceChangesParams,
        WorkspaceFileTreeParams, WorkspaceMutateFileAction, WorkspaceMutateFileParams,
        WorkspaceReadFileAtRefParams, WorkspaceReadFileParams, WorkspaceStatFileParams,
        WorkspaceUnbundleBeginMethod, WorkspaceUnbundleBeginParams, WorkspaceUnbundleChunkMethod,
        WorkspaceUnbundleChunkParams, WorkspaceUnbundleFinishMethod, WorkspaceUnbundleFinishParams,
        WorkspaceUnbundleMethod, WorkspaceUnbundleParams,
    },
    CommandTransport, OwnedTerminals, RemoteRuntime, RemoteSshRuntime, RemoteTransport, RpcClient,
    RuntimeKind, WorkspaceStatusMethod, WorkspaceStatusParams,
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
fn spawned_helmor_server_completes_handshake_via_command_transport() {
    // Phase 21b end-to-end: drive the real binary through the new
    // `CommandTransport` instead of the ad-hoc `connect_command` path.
    // Proves the trait dispatch lands on the same dispatcher (same
    // handshake, same wire shape) so the registry's command-transport
    // entries actually work — and that the persisted Command variant
    // round-trips through `connect_from_config` without surprise.
    let transport: Arc<dyn RemoteTransport> =
        Arc::new(CommandTransport::new(vec![HELMOR_SERVER_BIN.to_string()]));
    let client = RpcClient::connect_with_transport(transport)
        .expect("handshake through CommandTransport should succeed");

    let info = client.server_info();
    assert_eq!(info.protocol_version, helmor_lib::remote::PROTOCOL_VERSION);
    // A real workspace.status round-trip through the same pipe — proves
    // the trait isn't just a connect-time hook.
    let repo = init_repo();
    let status = client
        .call::<WorkspaceStatusMethod>(WorkspaceStatusParams {
            workspace_dir: repo.path().display().to_string(),
        })
        .expect("workspace.status round-trip via CommandTransport");
    assert!(
        status.is_clean,
        "fresh repo via CommandTransport should report clean"
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
fn spawned_helmor_server_exercises_every_workspace_inspector_method() {
    // End-to-end vertical for phase 20b: spawn the real binary, drive
    // every new inspector method against a real git repo, and assert
    // the bytes round-trip correctly. If `LocalRuntime`'s impls or the
    // _inner helpers in `workspace::files::*` regress, this test fails
    // *before* the desktop's IPC layer notices.
    let repo = init_repo();
    let workspace_dir = repo.path().display().to_string();
    // Add a nested file so file_tree has something to recurse into,
    // and a second file we can mutate without conflicting with the
    // baseline.
    std::fs::create_dir(repo.path().join("sub")).unwrap();
    std::fs::write(repo.path().join("sub").join("nested.txt"), "n\n").unwrap();
    std::fs::write(repo.path().join("scratch.txt"), "throwaway\n").unwrap();

    let cmd = Command::new(HELMOR_SERVER_BIN);
    let client = RpcClient::connect_command(cmd, "helmor-server-inspector-test".into())
        .expect("handshake should succeed");
    let runtime = RemoteSshRuntime::new(client, "helmor-server-inspector-test");

    // ── workspace.fileTree ────────────────────────────────────────
    let tree = runtime
        .workspace_file_tree(WorkspaceFileTreeParams {
            workspace_dir: workspace_dir.clone(),
        })
        .expect("file tree call");
    let paths: Vec<_> = tree.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(
        paths.contains(&"file.txt"),
        "tracked file should appear in the tree: {paths:?}",
    );
    assert!(
        paths.contains(&"sub/nested.txt"),
        "nested file should appear in the tree: {paths:?}",
    );

    // ── workspace.statFile ────────────────────────────────────────
    let stat = runtime
        .workspace_stat_file(WorkspaceStatFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "file.txt".into(),
        })
        .expect("stat call");
    assert!(stat.exists);
    assert!(stat.is_file);
    assert_eq!(stat.size, Some(5)); // "base\n"

    let missing_stat = runtime
        .workspace_stat_file(WorkspaceStatFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "does-not-exist.rs".into(),
        })
        .expect("stat on missing path returns Ok(exists=false)");
    assert!(!missing_stat.exists);

    // ── workspace.readFile ───────────────────────────────────────
    let read = runtime
        .workspace_read_file(WorkspaceReadFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "file.txt".into(),
        })
        .expect("read call");
    assert_eq!(read.content, "base\n");

    // Sandbox escape — must surface as HANDLER_FAILED with the seam
    // helper's message preserved.
    let escape = runtime
        .workspace_read_file(WorkspaceReadFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "../escape".into(),
        })
        .expect_err("`..` must be rejected on the seam");
    let escape_msg = format!("{escape}");
    assert!(
        escape_msg.contains("HANDLER_FAILED") && escape_msg.contains("`..`"),
        "sandbox-escape error should carry both the wire code and the seam message: {escape_msg}",
    );

    // ── workspace.readFileAtRef ──────────────────────────────────
    // Modify the working tree so HEAD differs.
    std::fs::write(repo.path().join("file.txt"), "edited\n").unwrap();
    let at_ref = runtime
        .workspace_read_file_at_ref(WorkspaceReadFileAtRefParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "file.txt".into(),
            git_ref: "HEAD".into(),
        })
        .expect("read-at-ref call");
    assert_eq!(at_ref.content, Some("base\n".into()));

    let missing_at_ref = runtime
        .workspace_read_file_at_ref(WorkspaceReadFileAtRefParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "never.rs".into(),
            git_ref: "HEAD".into(),
        })
        .expect("missing path at ref is Ok(None), not error");
    assert!(missing_at_ref.content.is_none());

    // ── workspace.changes (no content) ───────────────────────────
    let changes = runtime
        .workspace_changes(WorkspaceChangesParams {
            workspace_dir: workspace_dir.clone(),
            include_content: false,
        })
        .expect("changes call");
    assert!(
        changes.items.iter().any(|i| i.path == "file.txt"),
        "modified path should surface in changes: {changes:?}",
    );
    assert!(
        changes.prefetched.is_empty(),
        "include_content=false should omit prefetched bodies",
    );

    // ── workspace.changes (with content) ─────────────────────────
    let changes_with = runtime
        .workspace_changes(WorkspaceChangesParams {
            workspace_dir: workspace_dir.clone(),
            include_content: true,
        })
        .expect("changes with content");
    assert!(!changes_with.prefetched.is_empty());

    // ── workspace.mutateFile: Write ──────────────────────────────
    let write = runtime
        .workspace_mutate_file(WorkspaceMutateFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "file.txt".into(),
            action: WorkspaceMutateFileAction::Write {
                content: "via-wire\n".into(),
            },
        })
        .expect("mutate write");
    assert!(write.mtime_ms.is_some());
    let on_disk = std::fs::read_to_string(repo.path().join("file.txt")).unwrap();
    assert_eq!(on_disk, "via-wire\n");

    // ── workspace.mutateFile: Stage + Unstage ────────────────────
    runtime
        .workspace_mutate_file(WorkspaceMutateFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "file.txt".into(),
            action: WorkspaceMutateFileAction::Stage,
        })
        .expect("mutate stage");
    let cached = run_git_capture(repo.path(), &["diff", "--cached", "--name-only"]);
    assert!(
        cached.contains("file.txt"),
        "stage should put file in index: {cached:?}"
    );

    runtime
        .workspace_mutate_file(WorkspaceMutateFileParams {
            workspace_dir: workspace_dir.clone(),
            relative_path: "file.txt".into(),
            action: WorkspaceMutateFileAction::Unstage,
        })
        .expect("mutate unstage");
    let cached_after = run_git_capture(repo.path(), &["diff", "--cached", "--name-only"]);
    assert!(
        cached_after.is_empty(),
        "unstage should empty the index: {cached_after:?}"
    );

    // ── workspace.mutateFile: Discard untracked ──────────────────
    runtime
        .workspace_mutate_file(WorkspaceMutateFileParams {
            workspace_dir,
            relative_path: "scratch.txt".into(),
            action: WorkspaceMutateFileAction::Discard,
        })
        .expect("mutate discard untracked");
    assert!(
        !repo.path().join("scratch.txt").exists(),
        "discard should remove the untracked file"
    );
}

/// Shell out to git, return captured stdout. Tiny helper used by the
/// inspector-method integration test above to assert side effects on
/// the underlying repo without re-implementing porcelain parsing.
fn run_git_capture(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"));
    assert!(
        output.status.success(),
        "git {args:?} in {} failed: {}",
        repo.display(),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout).expect("git output is utf-8")
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

#[test]
fn spawned_helmor_server_opens_terminal_streams_stdout_and_closes_cleanly() {
    // Full vertical: spawn the real binary, subscribe to terminal
    // events, open a PTY, write a command, observe the marker bytes
    // arriving as Stdout notifications, then close. Proves the
    // phase-14 reader thread, phase-18 PTY plumbing, and the new
    // terminal.* RPC methods all line up across a real OS pipe.
    let cmd = Command::new(HELMOR_SERVER_BIN);
    let client = RpcClient::connect_command(cmd, "remote-terminal-test".into())
        .expect("handshake should succeed");

    let collected: Arc<Mutex<Vec<TerminalEventNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    let _subscription = client.subscribe_terminal_events(move |event| {
        sink.lock().unwrap().push(event);
    });

    // Subscription must outlive the call sequence below; the
    // NotificationSubscription drop unregisters the callback, so
    // hold the binding alive until we explicitly close.
    let runtime = RemoteSshRuntime::new(client, "remote-terminal-test");

    let open = runtime
        .terminal_open(TerminalOpenParams {
            terminal_id: "t-pty-1".into(),
            workspace_dir: "/tmp".into(),
            shell: Some("/bin/sh".into()),
            cols: 80,
            rows: 24,
        })
        .expect("terminal.open should succeed");
    assert!(open.pid > 0);

    // Wait briefly for the shell's initial prompt to land — proves
    // the server's reader thread is delivering bytes before we feed
    // it anything.
    wait_for(
        &collected,
        |e| matches!(&e.event, TerminalEventKind::Stdout { .. }),
        Duration::from_secs(2),
    );

    runtime
        .terminal_write(TerminalWriteParams {
            terminal_id: "t-pty-1".into(),
            data: "echo helmor-remote-marker\n".into(),
        })
        .expect("terminal.write should succeed");

    // The marker bytes arrive as stdout (the shell echoes the input
    // + the program output). Either matches.
    let marker = wait_for(
        &collected,
        |e| match &e.event {
            TerminalEventKind::Stdout { data } => data.contains("helmor-remote-marker"),
            _ => false,
        },
        Duration::from_secs(2),
    );
    assert_eq!(marker.terminal_id, "t-pty-1");

    runtime
        .terminal_close(TerminalCloseParams {
            terminal_id: "t-pty-1".into(),
        })
        .expect("terminal.close should succeed");

    // The Exited event lands once the shell reaps. SIGTERM-killed
    // shells report `code: None` on Unix.
    let exited = wait_for(
        &collected,
        |e| matches!(&e.event, TerminalEventKind::Exited { .. }),
        Duration::from_secs(2),
    );
    assert_eq!(exited.terminal_id, "t-pty-1");
}

/// Poll the collected inbox until the predicate finds a match or
/// the deadline passes. Same shape as the server-side test helper —
/// duplicated here because integration tests can't see private
/// helpers from the lib's test module.
fn wait_for(
    inbox: &Arc<Mutex<Vec<TerminalEventNotification>>>,
    pred: impl Fn(&TerminalEventNotification) -> bool,
    timeout: Duration,
) -> TerminalEventNotification {
    let start = Instant::now();
    loop {
        {
            let guard = inbox.lock().unwrap();
            for event in guard.iter() {
                if pred(event) {
                    return event.clone();
                }
            }
        }
        if start.elapsed() >= timeout {
            let snapshot = inbox.lock().unwrap().clone();
            panic!(
                "timed out waiting for terminal event after {timeout:?}; \
                 collected so far: {snapshot:#?}"
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn spawned_helmor_server_lists_and_reattaches_to_running_terminal() {
    // Foundation test for the phase-19 reattach story: spawn the
    // binary, open a terminal, drive some output into it, run
    // `terminal.list` and confirm the entry's metadata, then
    // `terminal.attach` from a *second* subscription and confirm
    // (a) the scrollback comes back and (b) subsequent output flows
    // through the new subscription.
    //
    // This is still within a single binary process — phase 19b adds
    // the daemon mode that lets the terminal survive across binary
    // restarts. This test just validates the list/attach surface
    // works end-to-end through the wire.
    let cmd = Command::new(HELMOR_SERVER_BIN);
    let client =
        RpcClient::connect_command(cmd, "phase-19a-test".into()).expect("handshake should succeed");

    let first: Arc<Mutex<Vec<TerminalEventNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_first = Arc::clone(&first);
    let _sub_first = client.subscribe_terminal_events(move |event| {
        sink_first.lock().unwrap().push(event);
    });

    let runtime = RemoteSshRuntime::new(client, "phase-19a-test");
    runtime
        .terminal_open(TerminalOpenParams {
            terminal_id: "t-reattach".into(),
            workspace_dir: "/tmp".into(),
            shell: Some("/bin/sh".into()),
            cols: 80,
            rows: 24,
        })
        .expect("terminal.open");

    // Wait for the initial prompt so the scrollback buffer has
    // bytes before we attach.
    wait_for(
        &first,
        |e| matches!(&e.event, TerminalEventKind::Stdout { .. }),
        Duration::from_secs(2),
    );

    runtime
        .terminal_write(TerminalWriteParams {
            terminal_id: "t-reattach".into(),
            data: "echo helmor-pre-attach\n".into(),
        })
        .unwrap();
    wait_for(
        &first,
        |e| match &e.event {
            TerminalEventKind::Stdout { data } => data.contains("helmor-pre-attach"),
            _ => false,
        },
        Duration::from_secs(2),
    );

    // terminal.list — should surface the running session.
    let list = runtime
        .terminal_list(TerminalListParams {})
        .expect("terminal.list");
    assert_eq!(list.terminals.len(), 1);
    let entry = &list.terminals[0];
    assert_eq!(entry.terminal_id, "t-reattach");
    assert_eq!(entry.workspace_dir, "/tmp");
    assert_eq!(entry.cols, 80);
    assert_eq!(entry.rows, 24);
    assert!(entry.opened_at_ms > 0);
    assert!(entry.pid > 0);

    // terminal.attach — bring the existing terminal under this
    // connection (no-op on the single-client path, but exercises
    // the API + verifies scrollback).
    let attach = runtime
        .terminal_attach(TerminalAttachParams {
            terminal_id: "t-reattach".into(),
        })
        .expect("terminal.attach");
    assert!(
        attach.scrollback.contains("helmor-pre-attach"),
        "scrollback should include pre-attach output: {:?}",
        attach.scrollback
    );
    assert_eq!(attach.cols, 80);
    assert_eq!(attach.rows, 24);

    // Drive new output post-attach; the existing subscription
    // (which was the only one and is *still* the attached one)
    // continues to see the events.
    runtime
        .terminal_write(TerminalWriteParams {
            terminal_id: "t-reattach".into(),
            data: "echo helmor-post-attach\n".into(),
        })
        .unwrap();
    wait_for(
        &first,
        |e| match &e.event {
            TerminalEventKind::Stdout { data } => data.contains("helmor-post-attach"),
            _ => false,
        },
        Duration::from_secs(2),
    );

    runtime
        .terminal_close(TerminalCloseParams {
            terminal_id: "t-reattach".into(),
        })
        .expect("terminal.close");
}

// ── phase 19b: daemon-mode reattach across client lifetime ──────────

/// Connect to the running daemon via `helmor-server --proxy`, the
/// same path the desktop's `connect_ssh` takes (modulo SSH). The
/// proxy is a per-client child process that bridges its stdio to
/// the daemon's Unix socket — its Drop tears down the bridge
/// cleanly, which is how the daemon learns the client went away.
///
/// Direct `UnixStream::connect` would also work, but produces a
/// classic half-close deadlock on `RpcClient::Drop`: the writer
/// drops while the reader still holds a `try_clone()`'d socket
/// fd, so the daemon's read end never sees EOF and the reader
/// thread never returns. The `--proxy` child sidesteps all of
/// that because the OS reaps the pipe pair when the child exits.
fn connect_via_proxy(home: &Path, peer_label: &str) -> RpcClient {
    let mut cmd = Command::new(HELMOR_SERVER_BIN);
    cmd.arg("--proxy").env("HOME", home);
    RpcClient::connect_command(cmd, peer_label.into())
        .unwrap_or_else(|e| panic!("connect via --proxy: {e:#}"))
}

/// Wait for the daemon to bind. The `--ensure-daemon` shim already
/// polls internally with a 3s budget, but the integration test
/// spawns the daemon *directly* (no shim) so it has to do its own
/// wait.
fn wait_for_socket(socket: &Path, deadline: Duration) {
    let start = Instant::now();
    while start.elapsed() < deadline {
        if socket.exists() && UnixStream::connect(socket).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!(
        "daemon socket at {} never came up within {deadline:?}",
        socket.display()
    );
}

#[test]
fn daemon_mode_terminal_survives_client_disconnect_and_reattach() {
    // The phase-19 moat in test form. Steps:
    //   1. Boot `helmor-server --daemon` with HOME isolated to a
    //      tempdir so we don't fight other daemons.
    //   2. Connect via the Unix socket, open a terminal, write a
    //      marker.
    //   3. Drop the client (the daemon's per-connection handler
    //      sees EOF and exits its loop; the PTY keeps running).
    //   4. New client connects to the same daemon, calls
    //      `terminal.list`, finds the surviving session, attaches.
    //   5. Scrollback contains the marker from the previous client.
    //   6. New client closes the terminal; daemon stays running.
    let tmp = tempfile::tempdir().expect("tempdir for HOME isolation");
    let home = tmp.path().to_path_buf();
    let socket: PathBuf = home.join(".helmor/server/sock");

    // The double-fork in `daemonize()` means the spawned process
    // *exits* after forking the real daemon. So we spawn + wait
    // for the fork's exit, then probe the socket.
    let status = Command::new(HELMOR_SERVER_BIN)
        .arg("--daemon")
        .env("HOME", &home)
        .status()
        .expect("spawn helmor-server --daemon");
    assert!(
        status.success(),
        "daemon spawn returned {status:?} (the first fork should exit 0)"
    );

    wait_for_socket(&socket, Duration::from_secs(3));

    // ── client 1: open + write ───────────────────────────────
    let inbox_1: Arc<Mutex<Vec<TerminalEventNotification>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let client_1 = connect_via_proxy(&home, "daemon-test-c1");
        let sink_1 = Arc::clone(&inbox_1);
        let _sub_1 = client_1.subscribe_terminal_events(move |event| {
            sink_1.lock().unwrap().push(event);
        });
        let runtime_1 = RemoteSshRuntime::new(client_1, "daemon-test-c1");
        runtime_1
            .terminal_open(TerminalOpenParams {
                terminal_id: "t-survive".into(),
                workspace_dir: "/tmp".into(),
                shell: Some("/bin/sh".into()),
                cols: 80,
                rows: 24,
            })
            .expect("terminal.open on c1");
        wait_for(
            &inbox_1,
            |e| matches!(&e.event, TerminalEventKind::Stdout { .. }),
            Duration::from_secs(2),
        );
        runtime_1
            .terminal_write(TerminalWriteParams {
                terminal_id: "t-survive".into(),
                data: "echo helmor-survives-c1\n".into(),
            })
            .expect("terminal.write on c1");
        wait_for(
            &inbox_1,
            |e| match &e.event {
                TerminalEventKind::Stdout { data } => data.contains("helmor-survives-c1"),
                _ => false,
            },
            Duration::from_secs(2),
        );
        // Client 1 drops here — Arc/Drop closes the UnixStream,
        // which the daemon's per-connection handler sees as EOF.
    }

    // Give the daemon a tick to notice the disconnect; not
    // strictly necessary (`terminal.list` should still surface the
    // PTY regardless) but rules out a "connection still half-open"
    // false positive.
    std::thread::sleep(Duration::from_millis(100));

    // ── client 2: list + attach + close ───────────────────────
    let client_2 = connect_via_proxy(&home, "daemon-test-c2");
    let inbox_2: Arc<Mutex<Vec<TerminalEventNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_2 = Arc::clone(&inbox_2);
    let _sub_2 = client_2.subscribe_terminal_events(move |event| {
        sink_2.lock().unwrap().push(event);
    });
    let runtime_2 = RemoteSshRuntime::new(client_2, "daemon-test-c2");

    let list = runtime_2
        .terminal_list(TerminalListParams {})
        .expect("terminal.list on c2");
    assert_eq!(
        list.terminals.len(),
        1,
        "daemon should have one orphan terminal across the disconnect; got {:?}",
        list.terminals
    );
    assert_eq!(list.terminals[0].terminal_id, "t-survive");
    assert_eq!(list.terminals[0].workspace_dir, "/tmp");

    let attach = runtime_2
        .terminal_attach(TerminalAttachParams {
            terminal_id: "t-survive".into(),
        })
        .expect("terminal.attach on c2");
    assert!(
        attach.scrollback.contains("helmor-survives-c1"),
        "client-2 should see the marker client-1 wrote: scrollback={:?}",
        attach.scrollback
    );

    runtime_2
        .terminal_close(TerminalCloseParams {
            terminal_id: "t-survive".into(),
        })
        .expect("terminal.close on c2");
}

#[test]
fn owned_terminals_persistence_round_trips_with_daemon_list_and_attach() {
    // The phase 19c integration: simulate the desktop side around
    // a real daemon. Walks through the exact flow the Tauri
    // commands wire up:
    //
    //   1. Boot daemon (isolated HOME), open a terminal via
    //      client 1, write a marker.
    //   2. *Persist* the terminal_id in a separate `OwnedTerminals`
    //      data dir — this is the bit `open_remote_terminal` does
    //      after a successful open.
    //   3. Drop client 1. Reload `OwnedTerminals` from disk to
    //      simulate desktop restart.
    //   4. Connect client 2. `terminal.list` → still there. Cross-
    //      reference with reloaded owned set → confirms we know
    //      we opened it.
    //   5. `terminal.attach` → scrollback includes the marker.
    //   6. Close → daemon evicts; the reloaded owned set still has
    //      the id locally, mirroring how the close command then
    //      removes it.
    let tmp_home = tempfile::tempdir().expect("daemon HOME");
    let home = tmp_home.path().to_path_buf();
    let socket: PathBuf = home.join(".helmor/server/sock");

    let status = Command::new(HELMOR_SERVER_BIN)
        .arg("--daemon")
        .env("HOME", &home)
        .status()
        .expect("spawn daemon");
    assert!(status.success());
    wait_for_socket(&socket, Duration::from_secs(3));

    let tmp_desktop_data = tempfile::tempdir().expect("desktop data dir");
    let desktop_data_dir = tmp_desktop_data.path();

    // Client 1: open + write + persist ownership.
    {
        let inbox: Arc<Mutex<Vec<TerminalEventNotification>>> = Arc::new(Mutex::new(Vec::new()));
        let client_1 = connect_via_proxy(&home, "phase-19c-c1");
        let sink = Arc::clone(&inbox);
        let _sub = client_1.subscribe_terminal_events(move |event| {
            sink.lock().unwrap().push(event);
        });
        let runtime_1 = RemoteSshRuntime::new(client_1, "phase-19c-c1");

        runtime_1
            .terminal_open(TerminalOpenParams {
                terminal_id: "t-19c".into(),
                workspace_dir: "/tmp".into(),
                shell: Some("/bin/sh".into()),
                cols: 80,
                rows: 24,
            })
            .expect("open");
        wait_for(
            &inbox,
            |e| matches!(&e.event, TerminalEventKind::Stdout { .. }),
            Duration::from_secs(2),
        );
        runtime_1
            .terminal_write(TerminalWriteParams {
                terminal_id: "t-19c".into(),
                data: "echo phase19c-marker\n".into(),
            })
            .expect("write");
        wait_for(
            &inbox,
            |e| match &e.event {
                TerminalEventKind::Stdout { data } => data.contains("phase19c-marker"),
                _ => false,
            },
            Duration::from_secs(2),
        );

        // Desktop-side: record ownership + persist. Mirrors the
        // `open_remote_terminal` command path post-success.
        let owned = OwnedTerminals::new();
        assert!(owned.insert("daemon-under-test", "t-19c"));
        owned.save_to_disk(desktop_data_dir);
    }

    // Simulate desktop restart: client 1 + its OwnedTerminals are
    // gone, only the sidecar JSON survives.
    std::thread::sleep(Duration::from_millis(100));

    // Reload ownership from disk. This is what the desktop's
    // boot hook does (`OwnedTerminals::load_from_disk`).
    let reloaded = OwnedTerminals::load_from_disk(desktop_data_dir);
    let owned_set = reloaded.list_for_runtime("daemon-under-test");
    assert_eq!(owned_set.len(), 1, "owned set should survive restart");
    assert!(owned_set.contains("t-19c"));

    // Client 2: list + cross-ref + attach + verify scrollback.
    let client_2 = connect_via_proxy(&home, "phase-19c-c2");
    let inbox_2: Arc<Mutex<Vec<TerminalEventNotification>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&inbox_2);
    let _sub_2 = client_2.subscribe_terminal_events(move |event| {
        sink.lock().unwrap().push(event);
    });
    let runtime_2 = RemoteSshRuntime::new(client_2, "phase-19c-c2");

    let live = runtime_2
        .terminal_list(TerminalListParams {})
        .expect("list");
    assert_eq!(live.terminals.len(), 1);
    let entry = &live.terminals[0];
    assert_eq!(entry.terminal_id, "t-19c");
    // Cross-reference: terminal_id is in both the daemon-side list
    // and the desktop-side owned set. That's the predicate the
    // Reattach UI uses to render the "yours" badge.
    assert!(
        owned_set.contains(&entry.terminal_id),
        "live terminal should be recognised as owned"
    );

    let attach = runtime_2
        .terminal_attach(TerminalAttachParams {
            terminal_id: "t-19c".into(),
        })
        .expect("attach");
    assert!(
        attach.scrollback.contains("phase19c-marker"),
        "scrollback should preserve the marker across restart: {:?}",
        attach.scrollback
    );

    // Desktop-side close path: remove from owned set + delete the
    // server-side PTY.
    runtime_2
        .terminal_close(TerminalCloseParams {
            terminal_id: "t-19c".into(),
        })
        .expect("close");
    assert!(reloaded.remove("daemon-under-test", "t-19c"));
    reloaded.save_to_disk(desktop_data_dir);

    let after_close = OwnedTerminals::load_from_disk(desktop_data_dir);
    assert!(
        after_close.list_for_runtime("daemon-under-test").is_empty(),
        "close should drop ownership from disk"
    );
}

// ── Track C3 integration: half-open socket force_close ───────────────
//
// Track C3 added `RpcClient::force_close` so the liveness loop can
// kill a wedged pipe instead of letting it hang for the kernel's TCP
// keepalive window. Unit tests cover the seam in isolation; this
// test proves the full vertical works on a real OS pipe boundary:
// spawn the binary, suspend it with SIGSTOP (the closest reliable
// reproduction of "TCP socket alive in the kernel but the peer
// process is stuck"), issue an in-flight ping, force_close from
// another thread, and verify both the in-flight call AND any
// subsequent call fail fast with the close reason rather than
// blocking forever.

#[test]
#[cfg(unix)]
fn force_close_unblocks_in_flight_call_against_a_suspended_peer() {
    use std::io::BufReader;
    use std::process::Stdio;

    // Spawn the binary ourselves (rather than connect_command's
    // convenience wrapper) so we can capture the PID for SIGSTOP
    // before the Child gets consumed by RpcClient.
    let mut cmd = Command::new(HELMOR_SERVER_BIN);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().expect("spawn helmor-server");
    let pid: libc::pid_t = child.id() as libc::pid_t;

    let stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let reader: Box<dyn std::io::BufRead + Send> = Box::new(BufReader::new(stdout));
    let writer: Box<dyn std::io::Write + Send> = Box::new(stdin);
    let client = Arc::new(
        RpcClient::connect_with_pipe(reader, writer, Some(child), "half-open-test".into())
            .expect("handshake before SIGSTOP should succeed"),
    );

    // Sanity: a ping works while the peer is healthy. Establishes
    // the baseline so a failure after SIGSTOP is unambiguously
    // attributable to the suspension.
    client
        .call::<PingMethod>(PingParams::default())
        .expect("pre-suspend ping should succeed");

    // Half-open simulation: SIGSTOP suspends the child process.
    // Kernel buffers our future writes; no reads ever happen. From
    // the client's perspective the pipe is alive at the OS level
    // but nothing will ever respond — exactly the failure mode C3
    // exists to detect.
    let stop_result = unsafe { libc::kill(pid, libc::SIGSTOP) };
    assert_eq!(
        stop_result,
        0,
        "kill(SIGSTOP) should succeed; errno-as-i32 = {}",
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    );

    // Fire an in-flight ping on a worker thread. Without the
    // force_close call below it would hang here forever.
    let in_flight_client = Arc::clone(&client);
    let in_flight =
        std::thread::spawn(move || in_flight_client.call::<PingMethod>(PingParams::default()));

    // Give the worker a moment to actually send the request +
    // register its pending oneshot. 100ms is plenty — the writer
    // mutex is uncontended and the codec is two pipe writes.
    std::thread::sleep(Duration::from_millis(100));

    // Watchdog kill — the operation under test. force_close should
    // drop the writer (which Drops the suspended child, sending
    // SIGKILL via std::process::Child::kill) and mark state closed.
    client.force_close("watchdog: simulated half-open ssh pipe");

    // The in-flight call must return Err within a reasonable
    // deadline; if force_close didn't actually unblock the reader,
    // the loop below would spin past this timeout.
    let join_deadline = Instant::now() + Duration::from_secs(3);
    while !in_flight.is_finished() {
        if Instant::now() >= join_deadline {
            panic!("force_close did not unblock the in-flight ping within 3s");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let in_flight_result = in_flight.join().expect("in-flight thread panicked");
    let err = in_flight_result.expect_err("in-flight ping must fail after force_close");
    let err_msg = format!("{err:#}");
    assert!(
        err_msg.contains("watchdog"),
        "in-flight error should carry the force_close reason: {err_msg}",
    );

    // Subsequent calls also fail fast — no hang waiting for a
    // response that will never come.
    let post_start = Instant::now();
    let post_err = client
        .call::<PingMethod>(PingParams::default())
        .expect_err("post-close ping must fail");
    assert!(
        post_start.elapsed() < Duration::from_secs(1),
        "post-close ping should fail within 1s, took {:?}",
        post_start.elapsed(),
    );
    let post_msg = format!("{post_err:#}");
    assert!(
        post_msg.contains("watchdog") || post_msg.contains("closed"),
        "post-close error should reference the close reason: {post_msg}",
    );

    // The Child object was consumed by force_close's writer-drop,
    // so SIGKILL/wait already happened on the suspended process —
    // nothing left to clean up here.
}

// ── Track F3: cross-host bundle + unbundle through real daemons ─────
//
// The runtime-level unit tests prove the bundle/unbundle pair
// works against a real git repo. This integration test proves the
// same pair survives the full RPC wire: spawn two `helmor-server`
// processes, bundle on the first, ship the base64 + sha across the
// wire (no chunking), unbundle on the second, verify the cloned
// workspace's HEAD matches. Same shape as the desktop's cross-host
// move flow.

#[test]
fn workspace_bundle_round_trips_through_two_spawned_daemons() {
    // ── source side: spawn a daemon + create a real repo to bundle.
    let source_repo = init_repo();
    let source_cmd = Command::new(HELMOR_SERVER_BIN);
    let source_client = RpcClient::connect_command(source_cmd, "source-daemon".into())
        .expect("source daemon handshake");

    let bundle = source_client
        .call::<WorkspaceBundleMethod>(WorkspaceBundleParams {
            workspace_dir: source_repo.path().display().to_string(),
        })
        .expect("workspace.bundle should round-trip through the source daemon");
    assert!(bundle.size_bytes > 0);
    assert_eq!(
        bundle.sha256_hex.len(),
        64,
        "sha256_hex must be 64 chars: {}",
        bundle.sha256_hex,
    );
    assert!(
        !bundle.bundle_base64.is_empty(),
        "bundle_base64 must carry payload bytes",
    );

    // ── destination side: spawn a *different* daemon process so
    // the test exercises the wire boundary on both sides.
    let dest_cmd = Command::new(HELMOR_SERVER_BIN);
    let dest_client =
        RpcClient::connect_command(dest_cmd, "dest-daemon".into()).expect("dest daemon handshake");
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("cloned");
    let unbundle = dest_client
        .call::<WorkspaceUnbundleMethod>(WorkspaceUnbundleParams {
            target_dir: target.display().to_string(),
            bundle_base64: bundle.bundle_base64.clone(),
            expected_sha256: bundle.sha256_hex.clone(),
        })
        .expect("workspace.unbundle should round-trip through the dest daemon");
    assert!(unbundle.cloned);
    assert_eq!(unbundle.head_branch, "main");

    // Cloned workspace has the same head commit as the source.
    let source_head = helmor_lib::git_ops::current_workspace_head_commit(source_repo.path())
        .expect("source HEAD");
    let cloned_head =
        helmor_lib::git_ops::current_workspace_head_commit(&target).expect("cloned HEAD");
    assert_eq!(
        source_head, cloned_head,
        "cloned workspace must land on the same commit the source had",
    );
    // The committed file lands in the working tree.
    assert!(target.join("file.txt").exists());
}

#[test]
fn chunked_bundle_round_trips_through_two_spawned_daemons() {
    // End-to-end chunked transfer: spawn source + destination
    // daemons, run the full bundleBegin/Chunk/End cycle on source,
    // run unbundleBegin/Chunk/Finish on destination, verify the
    // cloned repo's HEAD matches. Same shape as the single-shot
    // integration test but exercises the chunk-splitting code +
    // server-side BundleTransferStore.
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;

    let source_repo = init_repo();
    let source_cmd = Command::new(HELMOR_SERVER_BIN);
    let source_client = RpcClient::connect_command(source_cmd, "source-daemon".into())
        .expect("source daemon handshake");
    let dest_cmd = Command::new(HELMOR_SERVER_BIN);
    let dest_client =
        RpcClient::connect_command(dest_cmd, "dest-daemon".into()).expect("dest daemon handshake");

    // Force a tiny chunk size so the test actually exercises the
    // multi-chunk path even on a small repo.
    let chunk_size: u64 = 1024;

    // ── Source: begin + chunk + end.
    let begin = source_client
        .call::<WorkspaceBundleBeginMethod>(WorkspaceBundleBeginParams {
            workspace_dir: source_repo.path().display().to_string(),
            chunk_size_bytes: Some(chunk_size),
        })
        .expect("bundleBegin");
    assert!(!begin.transfer_id.is_empty());
    assert!(begin.total_size_bytes > 0);
    assert_eq!(begin.sha256_hex.len(), 64);
    assert!(
        begin.total_chunks > 0,
        "small chunk size should produce multiple chunks: {:?}",
        begin,
    );
    assert!(
        begin.chunk_size_bytes <= chunk_size,
        "server should respect or clamp the requested chunk size: {:?}",
        begin,
    );

    let mut assembled: Vec<u8> = Vec::with_capacity(begin.total_size_bytes as usize);
    for chunk_index in 0..begin.total_chunks {
        let chunk = source_client
            .call::<WorkspaceBundleChunkMethod>(WorkspaceBundleChunkParams {
                transfer_id: begin.transfer_id.clone(),
                chunk_index,
                chunk_size_bytes: begin.chunk_size_bytes,
            })
            .unwrap_or_else(|err| panic!("bundleChunk {chunk_index}: {err:#}"));
        let bytes = STANDARD
            .decode(chunk.chunk_base64.as_bytes())
            .expect("chunk decoded");
        assembled.extend_from_slice(&bytes);
    }
    assert_eq!(
        assembled.len() as u64,
        begin.total_size_bytes,
        "assembled size should match bundleBegin's declared size",
    );

    // Sanity: SHA matches.
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&assembled);
    let assembled_sha = format!("{:x}", hasher.finalize());
    assert_eq!(
        assembled_sha, begin.sha256_hex,
        "reassembled bundle's sha should match the server's announcement",
    );

    // Release the outbound transfer.
    source_client
        .call::<WorkspaceBundleEndMethod>(WorkspaceBundleEndParams {
            transfer_id: begin.transfer_id.clone(),
        })
        .expect("bundleEnd should succeed");

    // ── Destination: unbundleBegin + chunk + finish.
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("cloned");
    let inbound = dest_client
        .call::<WorkspaceUnbundleBeginMethod>(WorkspaceUnbundleBeginParams {
            target_dir: target.display().to_string(),
            total_size_bytes: assembled.len() as u64,
            sha256_hex: assembled_sha.clone(),
        })
        .expect("unbundleBegin");
    assert!(!inbound.transfer_id.is_empty());

    // Push the assembled buffer back across the wire in the SAME
    // chunk size so we exercise the multi-chunk inbound path too.
    let chunk_size_usize = begin.chunk_size_bytes as usize;
    let mut chunk_index: u32 = 0;
    let mut offset = 0;
    while offset < assembled.len() {
        let end = (offset + chunk_size_usize).min(assembled.len());
        let slice = &assembled[offset..end];
        let chunk_b64 = STANDARD.encode(slice);
        dest_client
            .call::<WorkspaceUnbundleChunkMethod>(WorkspaceUnbundleChunkParams {
                transfer_id: inbound.transfer_id.clone(),
                chunk_index,
                chunk_base64: chunk_b64,
            })
            .unwrap_or_else(|err| panic!("unbundleChunk {chunk_index}: {err:#}"));
        offset = end;
        chunk_index += 1;
    }

    let finish = dest_client
        .call::<WorkspaceUnbundleFinishMethod>(WorkspaceUnbundleFinishParams {
            transfer_id: inbound.transfer_id,
        })
        .expect("unbundleFinish");
    assert!(finish.cloned);
    assert_eq!(finish.head_branch, "main");

    // The cloned workspace's HEAD matches the source.
    let source_head = helmor_lib::git_ops::current_workspace_head_commit(source_repo.path())
        .expect("source HEAD");
    let cloned_head =
        helmor_lib::git_ops::current_workspace_head_commit(&target).expect("cloned HEAD");
    assert_eq!(source_head, cloned_head);
    assert!(target.join("file.txt").exists());
}

#[test]
fn chunked_unbundle_finish_rejects_short_transfer_via_wire() {
    // Announce 10 MiB but only push 6 bytes → unbundleFinish must
    // bail with a clean error. Exercises the server-side size-mismatch
    // check end-to-end.
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let dest_cmd = Command::new(HELMOR_SERVER_BIN);
    let dest_client =
        RpcClient::connect_command(dest_cmd, "dest-daemon".into()).expect("dest handshake");
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("cloned");
    let inbound = dest_client
        .call::<WorkspaceUnbundleBeginMethod>(WorkspaceUnbundleBeginParams {
            target_dir: target.display().to_string(),
            total_size_bytes: 10 * 1024 * 1024, // claim 10 MiB
            sha256_hex: "0".repeat(64),
        })
        .expect("unbundleBegin");
    dest_client
        .call::<WorkspaceUnbundleChunkMethod>(WorkspaceUnbundleChunkParams {
            transfer_id: inbound.transfer_id.clone(),
            chunk_index: 0,
            chunk_base64: STANDARD.encode(b"only-6"),
        })
        .expect("unbundleChunk");
    let err = dest_client
        .call::<WorkspaceUnbundleFinishMethod>(WorkspaceUnbundleFinishParams {
            transfer_id: inbound.transfer_id,
        })
        .expect_err("short transfer must bail on finish");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("declared 10485760") || msg.contains("only"),
        "error should call out the size mismatch: {msg}",
    );
    assert!(!target.exists(), "target dir must not be created");
}

#[test]
fn workspace_unbundle_surfaces_handler_failed_on_sha_mismatch_via_wire() {
    // Proves the JsonRpcError shape (HANDLER_FAILED code +
    // human-readable message) makes it through the wire when the
    // daemon refuses a bad bundle. The desktop relies on the
    // message verbatim for its toast.
    let source_repo = init_repo();
    let source_cmd = Command::new(HELMOR_SERVER_BIN);
    let source_client =
        RpcClient::connect_command(source_cmd, "source-daemon".into()).expect("source handshake");
    let bundle = source_client
        .call::<WorkspaceBundleMethod>(WorkspaceBundleParams {
            workspace_dir: source_repo.path().display().to_string(),
        })
        .expect("bundle");

    let dest_cmd = Command::new(HELMOR_SERVER_BIN);
    let dest_client =
        RpcClient::connect_command(dest_cmd, "dest-daemon".into()).expect("dest handshake");
    let scratch = tempfile::tempdir().unwrap();
    let target = scratch.path().join("cloned");
    let err = dest_client
        .call::<WorkspaceUnbundleMethod>(WorkspaceUnbundleParams {
            target_dir: target.display().to_string(),
            bundle_base64: bundle.bundle_base64,
            expected_sha256: "0".repeat(64),
        })
        .expect_err("sha mismatch must surface as RPC error");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("SHA-256 mismatch") || msg.contains("workspace.unbundle failed"),
        "error message should reach the desktop verbatim: {msg}",
    );
    assert!(
        !target.exists(),
        "target dir must not be created on a sha mismatch"
    );
}
