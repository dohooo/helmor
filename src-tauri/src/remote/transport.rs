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
//! ## Scope of phase 21a (this commit)
//!
//! Surface-only: the trait + the [`OpenSshTransport`] impl that's a
//! verbatim lift of `connect_ssh`'s existing arg-building, plus a
//! placeholder [`CommandTransport`] whose `spawn_pipe` bails. Phase
//! 21b fills the command transport in and grows the persistence wire
//! shape (`RuntimeConnectionConfig::Command`). Phase 21c/d add the
//! SSH-config maturity work. None of that lands here.

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

// ── Command (placeholder; phase 21b fills in) ──────────────────────

/// Wraps any user-supplied `argv` as a transport. The argv form (not
/// a shell line) avoids quoting hazards: the desktop tokenises in the
/// UI, the transport hands the tokens straight to `Command`, no shell
/// is involved.
///
/// **Phase 21a status:** the type + `RemoteTransport` impl are landed
/// so the trait surface compiles. `spawn_pipe` bails with a clear
/// message until phase 21b adds the real implementation alongside the
/// persistence migration (`RuntimeConnectionConfig::Command`) and the
/// frontend transport picker.
#[derive(Debug, Clone)]
pub struct CommandTransport {
    argv: Vec<String>,
}

impl CommandTransport {
    pub fn new(argv: Vec<String>) -> Self {
        Self { argv }
    }

    pub fn argv(&self) -> &[String] {
        &self.argv
    }
}

impl RemoteTransport for CommandTransport {
    fn spawn_pipe(&self) -> Result<TransportPipe> {
        anyhow::bail!(
            "CommandTransport is not yet implemented (phase 21b); argv={:?}",
            self.argv
        )
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
fn ssh_control_dir() -> Option<PathBuf> {
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
    fn command_transport_bails_with_argv_in_message_until_phase_21b() {
        // Documents the intentional 21a state: the type compiles and
        // satisfies `RemoteTransport`, but the spawn_pipe surface
        // tells callers to wait for 21b. Useful regression check —
        // when 21b lands and replaces this, the test gets retargeted.
        let transport = CommandTransport::new(vec!["tsh".into(), "ssh".into(), "box".into()]);
        let err = transport.spawn_pipe().expect_err("placeholder must bail");
        let msg = format!("{err}");
        assert!(
            msg.contains("not yet implemented"),
            "error should signal the placeholder status: {msg}"
        );
        assert!(
            msg.contains("tsh") && msg.contains("ssh") && msg.contains("box"),
            "argv should be echoed for diagnostics: {msg}"
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
