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
        TerminalAttachParams, TerminalCloseParams, TerminalEventKind, TerminalEventNotification,
        TerminalListParams, TerminalOpenParams, TerminalWriteParams,
    },
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
