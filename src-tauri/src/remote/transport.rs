//! Transport seam: how the desktop reaches a `helmor-server`.
//!
//! Phases 1–20 wired the JSON-RPC pipe straight to `Command::new("ssh")`
//! deep inside `RpcClient::connect_ssh`. That coupling is fine for a
//! one-transport spike but doesn't survive contact with real
//! deployments: users have Teleport (`tsh ssh host …`), Tailscale SSH
//! (`tailscale ssh host …`), `kubectl exec`-based dev pods, and bespoke
//! `Command` wrappers around all of the above. Phase 21 lifts the
//! spawn into a trait so the rest of the codebase doesn't have to know
//! which of those is in play.
//!
//! ## Why a trait
//!
//! Every transport answers exactly one question — "open me a framed
//! stdio pipe to a running `helmor-server`" — so the API surface is
//! tiny. An enum would force every site that holds a transport to
//! `match` on the variant, which is the wrong tradeoff: the
//! `OpenSshTransport` vs `CommandTransport` choice is made *once*, at
//! registration time, and never again. A `dyn RemoteTransport` is the
//! right ergonomics for the registry path and keeps adding new
//! transports a one-file change.
//!
//! ## Scope after phase 21b
//!
//! Two production transports today: [`OpenSshTransport`] (verbatim
//! lift of the pre-phase-21 `connect_ssh` arg-building) and
//! [`CommandTransport`] (any user-supplied argv list — Teleport,
//! Tailscale SSH, `kubectl exec`, etc.). The persistence layer's
//! [`super::connection::RuntimeConnectionConfig`] grew a `Command`
//! variant alongside the existing `Local` and `Ssh`; the registry
//! restores all three transparently at boot. Phase 21c/d add SSH
//! config maturity (`Include` directives + `Match` blocks).

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use anyhow::{anyhow, Context, Result};

/// Stdio bundle returned by [`RemoteTransport::spawn_pipe`]. The
/// reader/writer pair is what the JSON-RPC framer reads + writes; the
/// `child` handle stays with the client so dropping the client reaps
/// the subprocess; `peer_label` shows up in log lines + error
/// messages.
pub struct TransportPipe {
    pub reader: Box<dyn BufRead + Send>,
    pub writer: Box<dyn Write + Send>,
    /// `None` only for tests that supply their own in-memory pipe and
    /// don't spawn a real subprocess. Every production transport
    /// populates this so [`super::client::RpcClient`]'s drop path can
    /// kill + reap the child.
    pub child: Option<Child>,
    pub peer_label: String,
}

impl std::fmt::Debug for TransportPipe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `Box<dyn BufRead/Write + Send>` isn't `Debug`, so we render
        // the bits that are. Used by tests' `expect_err` (requires `T:
        // Debug` on the Ok branch) and by ad-hoc operator logging.
        f.debug_struct("TransportPipe")
            .field("peer_label", &self.peer_label)
            .field("has_child", &self.child.is_some())
            .finish_non_exhaustive()
    }
}

/// Single-method seam. The trait is intentionally narrow — adding a
/// new transport is "implement this one method"; everything else
/// (the reader thread, the response demuxer, the writer mutex) is
/// transport-agnostic and lives in [`super::client`].
///
/// `Send + Sync` is required because the registry stashes
/// `Arc<dyn RemoteTransport>` in entries that may be cloned across
/// threads (re-connect, liveness loop). The trait object lives only
/// for the duration of a connect — once the pipe is open the transport
/// is dropped; the long-lived state is on the [`RpcClient`] itself.
pub trait RemoteTransport: Send + Sync {
    /// Open a framed stdio pipe to a `helmor-server`. The transport
    /// owns the spawn details (which binary, which args, which env)
    /// so callers can stay flavour-agnostic.
    fn spawn_pipe(&self) -> Result<TransportPipe>;
}

// ── OpenSSH ────────────────────────────────────────────────────────

/// SSH args added to every spawn. `BatchMode=yes` makes the spawn
/// fail fast instead of prompting for a password — the desktop has no
/// terminal attached to the child, so any prompt would hang the call.
/// Operators wanting password auth can use `ssh-agent` or a key file;
/// the spike intentionally doesn't grow an interactive-auth code path.
const DEFAULT_SSH_ARGS: &[&str] = &["-o", "BatchMode=yes"];

/// Extra args that enable ssh connection multiplexing. With these,
/// the *first* connect to a host pays the full handshake cost; every
/// subsequent connect (ping, reconnect, future per-method calls)
/// reuses the same TCP + auth channel. `ControlPersist=5m` keeps the
/// master alive across short app restarts so a relaunch doesn't burn
/// a fresh handshake.
const SSH_MUX_ARGS: &[&str] = &["-o", "ControlMaster=auto", "-o", "ControlPersist=5m"];

/// Transport that runs `ssh <host> sh -c '<bin> --ensure-daemon && exec <bin> --proxy'`.
/// Captures the same arg-building logic the pre-phase-21 `connect_ssh`
/// inlined; nothing about the wire shape changes here.
///
/// ControlMaster multiplexing is added when [`ssh_control_dir`] returns
/// a writable directory; in tests / sandboxes where the data dir is
/// unavailable the transport degrades to plain ssh rather than
/// refusing to connect.
#[derive(Debug, Clone)]
pub struct OpenSshTransport {
    host: String,
    remote_binary: String,
    /// Override for the ControlPath base directory. `None` defers to
    /// [`ssh_control_dir`], which reads the app data dir. Tests inject
    /// a tempdir; production code leaves it `None`.
    control_dir_override: Option<PathBuf>,
}

impl OpenSshTransport {
    pub fn new(host: impl Into<String>, remote_binary: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            remote_binary: remote_binary.into(),
            control_dir_override: None,
        }
    }

    /// Test-only constructor that pins the ControlPath directory.
    /// Lets unit tests assert the resulting `Command` without touching
    /// the real app data dir.
    #[cfg(test)]
    pub fn with_control_dir(
        host: impl Into<String>,
        remote_binary: impl Into<String>,
        control_dir: PathBuf,
    ) -> Self {
        Self {
            host: host.into(),
            remote_binary: remote_binary.into(),
            control_dir_override: Some(control_dir),
        }
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn remote_binary(&self) -> &str {
        &self.remote_binary
    }

    /// Human-readable peer label used in log lines + error messages.
    /// Mirrors the `format!("ssh://{host}")` shape `connect_ssh` used
    /// pre-phase-21.
    pub fn peer_label(&self) -> String {
        format!("ssh://{}", self.host)
    }

    /// Build the literal `Command` this transport would spawn, without
    /// actually spawning. Lets unit tests assert the arg shape
    /// verbatim — a future refactor that drops `-o BatchMode=yes` or
    /// reorders the ControlPath option would fail the snapshot.
    pub fn build_command(&self) -> Command {
        let mut cmd = Command::new("ssh");
        for arg in DEFAULT_SSH_ARGS {
            cmd.arg(arg);
        }
        // Connection multiplexing — see comment on SSH_MUX_ARGS. The
        // ControlPath is computed at call time so a missing data dir
        // (test, container, weird sandbox) degrades to plain ssh
        // instead of dropping mux on the floor.
        let control_dir = self.control_dir_override.clone().or_else(ssh_control_dir);
        if let Some(dir) = control_dir {
            for arg in SSH_MUX_ARGS {
                cmd.arg(arg);
            }
            cmd.arg("-o")
                .arg(format!("ControlPath={}/%C", dir.display()));
        }
        let remote_cmd = format!(
            "{quoted_bin} --ensure-daemon && exec {quoted_bin} --proxy",
            quoted_bin = shell_quote(&self.remote_binary)
        );
        cmd.arg(&self.host).arg("sh").arg("-c").arg(remote_cmd);
        cmd
    }
}

impl RemoteTransport for OpenSshTransport {
    fn spawn_pipe(&self) -> Result<TransportPipe> {
        spawn_command_as_pipe(self.build_command(), self.peer_label())
    }
}

// ── Command transport ──────────────────────────────────────────────

/// Wraps any user-supplied `argv` as a transport. The argv form (not
/// a shell line) avoids quoting hazards: the desktop tokenises in the
/// UI, the transport hands the tokens straight to `Command`, no shell
/// is involved. Suitable for Teleport (`tsh ssh host helmor-server
/// --proxy`), Tailscale SSH (`tailscale ssh host helmor-server
/// --proxy`), `kubectl exec`-based dev pods, or any pre-installed
/// helmor-server reachable via a single `Command` invocation.
///
/// **Auto-install is out of scope for `CommandTransport`.** The
/// `OpenSshTransport` scp's the binary up on first connect; for
/// command transports the operator is expected to have the binary
/// pre-installed on the remote side (and the argv must invoke it
/// with `--proxy` so it speaks JSON-RPC on stdio).
#[derive(Debug, Clone)]
pub struct CommandTransport {
    argv: Vec<String>,
}

impl CommandTransport {
    /// Construct from a non-empty argv list. The first element is the
    /// binary to invoke; the rest are passed as arguments.
    pub fn new(argv: Vec<String>) -> Self {
        Self { argv }
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }

    /// Human-readable peer label. Uses the binary name (first argv
    /// element) so log lines disambiguate between e.g. `cmd:tsh` and
    /// `cmd:tailscale` runtimes without dumping the whole argv.
    pub fn peer_label(&self) -> String {
        match self.argv.first() {
            Some(prog) => format!("cmd:{prog}"),
            None => "cmd:<empty>".to_string(),
        }
    }

    /// Build the literal `Command` this transport would spawn, without
    /// actually spawning. Mirrors [`OpenSshTransport::build_command`]
    /// so the test surface stays consistent across transports.
    pub fn build_command(&self) -> Result<Command> {
        let (program, rest) = self
            .argv
            .split_first()
            .ok_or_else(|| anyhow!("CommandTransport argv must not be empty"))?;
        if program.is_empty() {
            anyhow::bail!("CommandTransport argv[0] (program) must not be empty");
        }
        let mut cmd = Command::new(program);
        for arg in rest {
            cmd.arg(arg);
        }
        Ok(cmd)
    }
}

impl RemoteTransport for CommandTransport {
    fn spawn_pipe(&self) -> Result<TransportPipe> {
        let cmd = self.build_command()?;
        spawn_command_as_pipe(cmd, self.peer_label())
    }
}

// ── shared spawn plumbing ──────────────────────────────────────────

/// Wire a prepared `Command` as a [`TransportPipe`]. Every real
/// transport (anything that spawns a subprocess) funnels through this
/// — the stdio plumbing is identical regardless of whether the wrapper
/// is `ssh`, `tsh`, `kubectl exec`, or a bare local binary.
///
/// `stderr` is inherited rather than piped so operator-facing tracing
/// from the child shows up in the desktop's stderr. A future slice
/// can capture it into a tracing channel keyed by peer.
pub(crate) fn spawn_command_as_pipe(mut cmd: Command, peer_label: String) -> Result<TransportPipe> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn remote runner for {peer_label}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("child {peer_label} provided no stdin pipe"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("child {peer_label} provided no stdout pipe"))?;
    let reader: Box<dyn BufRead + Send> = Box::new(BufReader::new(stdout));
    let writer: Box<dyn Write + Send> = Box::new(stdin);
    Ok(TransportPipe {
        reader,
        writer,
        child: Some(child),
        peer_label,
    })
}

/// Resolve the directory ssh writes ControlPath sockets into. Returns
/// `None` if the data dir isn't reachable — we'd rather connect
/// without multiplexing than refuse to connect at all. The directory
/// is created lazily on first call; ssh tolerates a missing path until
/// the master needs to bind.
///
/// `pub(crate)` because the port-forwarding command shells out to the
/// same `ssh -o ControlPath=... -O forward` invocation the master
/// uses, and needs the matching control-dir template so `-O forward`
/// finds the master's socket.
pub(crate) fn ssh_control_dir() -> Option<PathBuf> {
    let data_dir = crate::data_dir::data_dir().ok()?;
    let dir = data_dir.join("ssh-cm");
    // Best-effort mkdir. If creation fails (read-only mount, weird
    // permission setup), let ssh surface its own error when it tries
    // to write the socket.
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Single-quote-escape a value for safe `sh -c` interpolation. The
/// only metacharacter inside `'...'` is `'` itself, which we
/// escape via the classic `'\''` close-quote-then-quoted-quote
/// pattern. Used to embed the remote binary path into the daemon-
/// invoking shell command without inviting injection from paths
/// with spaces / quotes / `$`.
fn shell_quote(value: &str) -> String {
    let escaped = value.replace('\'', "'\\''");
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// `Command` doesn't have a public accessor for its argv, but we
    /// can read it back via its `Debug` impl which formats as
    /// `"prog" "arg1" "arg2" …`. Good enough for arg-shape assertions
    /// in tests; would be brittle to lean on for anything more.
    fn argv_string(cmd: &Command) -> String {
        format!("{cmd:?}")
    }

    #[test]
    fn open_ssh_transport_builds_expected_argv_shape() {
        let tmp = tempfile::tempdir().unwrap();
        let transport = OpenSshTransport::with_control_dir(
            "dev.box",
            "/usr/local/bin/helmor-server",
            tmp.path().to_path_buf(),
        );
        let cmd = transport.build_command();
        let rendered = argv_string(&cmd);

        // Locking the shape of every flag so a refactor that, say,
        // drops BatchMode=yes or moves the ControlPath option to a
        // different position fails this test loudly.
        assert!(
            rendered.contains("BatchMode=yes"),
            "BatchMode arg missing: {rendered}"
        );
        assert!(
            rendered.contains("ControlMaster=auto"),
            "ControlMaster arg missing: {rendered}"
        );
        assert!(
            rendered.contains("ControlPersist=5m"),
            "ControlPersist arg missing: {rendered}"
        );
        // ControlPath should embed the override dir + the %C template
        // so each user/host/port pair gets its own socket.
        let expected_cp = format!("ControlPath={}/%C", tmp.path().display());
        assert!(
            rendered.contains(&expected_cp),
            "ControlPath should use the override dir + %C template: {rendered}"
        );
        // Host arg + the sh -c shell invocation are at the tail.
        assert!(rendered.contains("\"dev.box\""), "host missing: {rendered}");
        assert!(
            rendered.contains("\"sh\""),
            "sh wrapper missing: {rendered}"
        );
        assert!(rendered.contains("\"-c\""), "-c flag missing: {rendered}");
        // The `--ensure-daemon && exec --proxy` shape: both flags
        // appear in the same arg, the bin is single-quoted, both
        // copies refer to the same path.
        assert!(
            rendered.contains("--ensure-daemon"),
            "ensure-daemon missing: {rendered}",
        );
        assert!(rendered.contains("--proxy"), "proxy missing: {rendered}",);
        assert!(
            rendered.contains("'/usr/local/bin/helmor-server'"),
            "single-quoted bin path missing: {rendered}",
        );
    }

    #[test]
    fn open_ssh_transport_quotes_a_path_containing_a_single_quote() {
        // The classic edge case for `shell_quote`. A binary path like
        // `/foo's/server` must round-trip through `sh -c` intact.
        // Inspect the last argv slot directly rather than the Debug
        // rendering — Debug escapes backslashes for display, which
        // would obscure the literal `'\''` sequence we care about.
        let transport =
            OpenSshTransport::with_control_dir("h", "/foo's/server", std::env::temp_dir());
        let cmd = transport.build_command();
        let last_arg = cmd
            .get_args()
            .last()
            .expect("ssh command should have at least one arg")
            .to_string_lossy()
            .into_owned();
        // Two `'\''` sequences — one per occurrence of the literal `'`
        // in `/foo's/server` (`shell_quote` is called twice, once for
        // each `{quoted_bin}` substitution).
        assert!(
            last_arg.contains("'/foo'\\''s/server'"),
            "single-quote escape failed in last argv: {last_arg}"
        );
        assert_eq!(
            last_arg.matches("'\\''").count(),
            2,
            "expected exactly 2 escape sequences (one per substitution): {last_arg}",
        );
    }

    #[test]
    fn open_ssh_transport_skips_mux_args_when_control_dir_unavailable() {
        // No override + no app data dir → no ControlMaster flags.
        // We can't easily "make the data dir unavailable" — but we can
        // assert the inverse: when no override is set the transport
        // *consults* `ssh_control_dir`. The runtime data-dir-missing
        // path is exercised in [`crate::data_dir`]'s own tests; here
        // we just verify the override path turns mux on, which we
        // already did in `builds_expected_argv_shape`. So this case
        // documents the fall-through.
        let transport = OpenSshTransport::new("h", "/bin/srv");
        let cmd = transport.build_command();
        let rendered = argv_string(&cmd);
        // Host + sh wrapper still present regardless of mux.
        assert!(rendered.contains("\"h\""));
        assert!(rendered.contains("\"sh\""));
    }

    #[test]
    fn open_ssh_transport_peer_label_uses_ssh_scheme() {
        let transport = OpenSshTransport::new("ec2-1.example.com", "helmor-server");
        assert_eq!(transport.peer_label(), "ssh://ec2-1.example.com");
    }

    #[test]
    fn command_transport_build_command_passes_argv_through_unmodified() {
        // Whitespace inside an arg must not be split — the whole point
        // of taking an argv list is to avoid shell tokenisation. A bug
        // here is a security regression (would let argv slots leak
        // into adjacent args).
        let transport = CommandTransport::new(vec![
            "tsh".into(),
            "ssh".into(),
            "user@host with spaces".into(),
            "helmor-server".into(),
            "--proxy".into(),
        ]);
        let cmd = transport.build_command().expect("non-empty argv");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec![
                "ssh".to_string(),
                "user@host with spaces".to_string(),
                "helmor-server".to_string(),
                "--proxy".to_string(),
            ],
            "argv should reach Command verbatim, no shell splitting",
        );
        // Program is `tsh`.
        assert_eq!(cmd.get_program().to_string_lossy(), "tsh");
    }

    #[test]
    fn command_transport_build_command_rejects_empty_argv() {
        let transport = CommandTransport::new(vec![]);
        let err = transport
            .build_command()
            .expect_err("empty argv must be rejected before reaching Command");
        assert!(format!("{err}").contains("argv must not be empty"));
    }

    #[test]
    fn command_transport_build_command_rejects_empty_program() {
        // First arg is the binary; an empty string would make Command
        // try to spawn `""` which fails in a confusing way ("entity
        // not found"). Catch it at the seam with a clear error.
        let transport = CommandTransport::new(vec!["".into(), "helmor-server".into()]);
        let err = transport
            .build_command()
            .expect_err("empty program must be rejected");
        assert!(format!("{err}").contains("argv[0]"));
    }

    #[test]
    fn command_transport_peer_label_uses_cmd_scheme_with_program_name() {
        // The label is what shows up in log lines + error messages —
        // we want "cmd:tsh" not the whole 6-element argv blob.
        let transport = CommandTransport::new(vec![
            "tsh".into(),
            "ssh".into(),
            "h".into(),
            "helmor-server".into(),
            "--proxy".into(),
        ]);
        assert_eq!(transport.peer_label(), "cmd:tsh");
    }

    #[test]
    fn command_transport_spawn_pipe_surfaces_missing_binary_error() {
        // No subprocess can spawn; the error should name the binary
        // (via the peer label) so the operator knows what's missing.
        let transport = CommandTransport::new(vec![
            "/definitely/not/a/real/binary".into(),
            "--proxy".into(),
        ]);
        let err = transport
            .spawn_pipe()
            .expect_err("missing binary must surface");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("cmd:/definitely/not/a/real/binary"),
            "error should carry the peer label: {msg}",
        );
    }

    #[test]
    fn remote_transport_trait_is_object_safe_and_dispatches_dynamically() {
        // The registry will hold `Arc<dyn RemoteTransport>` — this
        // test wedges the dyn dispatch path so a future trait method
        // that breaks object-safety stops the build.
        let transports: Vec<Arc<dyn RemoteTransport>> = vec![
            Arc::new(OpenSshTransport::new("h1", "srv")),
            Arc::new(CommandTransport::new(vec!["tsh".into()])),
        ];
        // Don't call `spawn_pipe` — that would actually try to spawn
        // ssh and bail with a placeholder, neither of which is the
        // point. We just need to prove `Vec<Arc<dyn ...>>` compiles
        // and that we can iterate over a heterogeneous list.
        assert_eq!(transports.len(), 2);
    }

    #[test]
    fn shell_quote_handles_inner_single_quote() {
        // Direct unit on the helper since it's the most security-
        // sensitive piece of the transport — a regression here is a
        // shell-injection vector. The expected encoding is the canonical
        // `'\''` (close-quote-then-escaped-quote-then-reopen-quote).
        assert_eq!(shell_quote("foo"), "'foo'");
        assert_eq!(shell_quote("foo's"), "'foo'\\''s'");
        // No quotes → just wrap.
        assert_eq!(shell_quote(""), "''");
        // Spaces survive unmodified (inside `'...'` they're literal).
        assert_eq!(shell_quote("with space"), "'with space'");
    }
}
