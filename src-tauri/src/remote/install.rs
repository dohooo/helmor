//! Auto-install of `helmor-server` on an SSH-reachable remote.
//!
//! When the desktop's `connect_remote_runtime` command points at a
//! host that doesn't have `helmor-server` on `$PATH` yet, this module
//! probes for it, falls back to a managed install location, and (if
//! still missing) `scp`s the locally-built binary up before
//! retrying. Mirrors the UX in #453: "Helmor installs/updates a small
//! headless helmor-server binary on the remote on first connect."
//!
//! ## Probe / install protocol
//!
//! - Probe → `ssh <host> '<binary> --version'`. The binary's
//!   [`crate::bin::helmor-server`] honours `--version`/`-V` and prints
//!   `helmor-server <semver>\nprotocol <semver>`.
//! - Install path → `$HOME/.helmor/server/helmor-server`. The remote
//!   shell expands `$HOME`; scp drops the file under the destination's
//!   `$HOME` by default.
//! - Install steps → `mkdir -p $HOME/.helmor/server` → `scp` the local
//!   binary → `chmod +x`. Each step bails on non-zero exit.
//!
//! ## What's *not* in scope
//!
//! - No credential capture. Auth flows through `ssh-agent` / keys
//!   exactly like the live connect path.
//! - No version-skew handling beyond "compatible enough to run". If
//!   the probe succeeds we trust it; a later phase can layer protocol
//!   compatibility checks on top.
//! - No remove / clean-up. The install dir stays put across runs.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

/// Remote shell expression that resolves to the managed install
/// directory under the operator's home. ssh runs commands through the
/// remote login shell, which expands `$HOME` for us.
pub const REMOTE_INSTALL_DIR: &str = "$HOME/.helmor/server";

/// Full path of the installed binary. Passed to `connect_ssh` as the
/// `remote_binary` argument when auto-install fires.
pub const REMOTE_INSTALL_BINARY: &str = "$HOME/.helmor/server/helmor-server";

/// SSH args that mirror [`crate::remote::client`]'s defaults so probes
/// share the same auth surface as the real connect path. `BatchMode=yes`
/// matters here too — a prompt would hang the install with no UI to
/// surface it through.
const PROBE_SSH_ARGS: &[&str] = &["-o", "BatchMode=yes"];

/// Resolve a working `helmor-server` on the remote, installing the
/// local binary if necessary. Returns the path the desktop should
/// pass to `connect_ssh`'s `remote_binary` argument.
///
/// Resolution order:
///   1. `requested` (operator-supplied path, defaults to plain
///      `helmor-server` so `$PATH` resolution kicks in).
///   2. [`REMOTE_INSTALL_BINARY`] — maybe a previous Helmor session
///      installed it under the managed location.
///   3. Fresh install: scp the local helmor-server binary up.
pub fn ensure_remote_helmor_server<R: SshRunner>(
    runner: &R,
    host: &str,
    requested: &str,
    local_binary: &Path,
) -> Result<String> {
    // The probe is best-effort: if the remote shell rejects (auth
    // failure, host down, ...) we'd rather surface that here than
    // bury it behind a scp call. But a *missing* binary should NOT
    // bubble up — it's the trigger for install.
    match probe_remote_version(runner, host, requested) {
        ProbeOutcome::Found(version) => {
            tracing::info!(
                host = %host,
                binary = %requested,
                version = %version,
                "remote-runner: helmor-server present at requested path"
            );
            return Ok(requested.to_string());
        }
        ProbeOutcome::Missing => {
            // Continue to step 2.
        }
        ProbeOutcome::TransportError(err) => {
            return Err(err.context(format!("probe failed for `{requested}` on `{host}`")));
        }
    }

    // Step 2: maybe the managed location already has it.
    if requested != REMOTE_INSTALL_BINARY {
        if let ProbeOutcome::Found(version) =
            probe_remote_version(runner, host, REMOTE_INSTALL_BINARY)
        {
            tracing::info!(
                host = %host,
                binary = %REMOTE_INSTALL_BINARY,
                version = %version,
                "remote-runner: using previously-installed helmor-server"
            );
            return Ok(REMOTE_INSTALL_BINARY.to_string());
        }
    }

    // Step 3: fresh install.
    install_remote(runner, host, local_binary)
        .with_context(|| format!("auto-install of helmor-server on `{host}` failed"))?;

    // Sanity-check the install actually landed runnable.
    match probe_remote_version(runner, host, REMOTE_INSTALL_BINARY) {
        ProbeOutcome::Found(version) => {
            tracing::info!(
                host = %host,
                binary = %REMOTE_INSTALL_BINARY,
                version = %version,
                "remote-runner: helmor-server installed and verified"
            );
            Ok(REMOTE_INSTALL_BINARY.to_string())
        }
        ProbeOutcome::Missing => {
            bail!(
                "auto-install reported success but binary still missing at `{REMOTE_INSTALL_BINARY}`"
            )
        }
        ProbeOutcome::TransportError(err) => Err(err),
    }
}

/// Result of a `--version` probe. Distinguishes "binary not on the
/// remote" (an expected, handleable case — trigger install) from
/// "ssh itself failed" (auth, network, host-down — bubble up).
#[derive(Debug)]
enum ProbeOutcome {
    /// `<binary> --version` printed something — binary is reachable.
    /// The string is the raw first line (logged but not parsed; a
    /// later phase can layer semver checks on top).
    Found(String),
    /// Exit code suggests "command not found" or the binary errored
    /// in a way consistent with absence. We treat any non-zero exit
    /// from the probe as "missing" — the install step is idempotent
    /// enough to overwrite a junk binary safely.
    Missing,
    /// Couldn't run the probe at all (ssh failed to dial). Bubbles up
    /// so the operator gets a real error instead of a useless retry.
    TransportError(anyhow::Error),
}

fn probe_remote_version<R: SshRunner>(runner: &R, host: &str, binary: &str) -> ProbeOutcome {
    let remote_command = format!("{binary} --version");
    match runner.run_ssh(host, &remote_command) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if stdout.is_empty() {
                ProbeOutcome::Missing
            } else {
                ProbeOutcome::Found(stdout)
            }
        }
        Ok(_) => {
            // Non-zero exit. Could be "command not found" (127),
            // could be the binary segfaulting, could be a write
            // error on stdout. Either way, treat as missing — the
            // install step will overwrite cleanly.
            ProbeOutcome::Missing
        }
        Err(err) => ProbeOutcome::TransportError(err),
    }
}

fn install_remote<R: SshRunner>(runner: &R, host: &str, local_binary: &Path) -> Result<()> {
    // 1. mkdir -p the managed dir. `$HOME` expands on the remote.
    let mkdir = runner
        .run_ssh(host, &format!("mkdir -p {REMOTE_INSTALL_DIR}"))
        .context("ssh mkdir -p")?;
    if !mkdir.status.success() {
        bail!(
            "mkdir -p {REMOTE_INSTALL_DIR} on {host} failed: exit {}",
            mkdir.status
        );
    }

    // 2. scp the local binary up. `host:path` form puts the file
    // under the remote `$HOME` (scp default for relative paths).
    let scp = runner
        .run_scp(local_binary, host, ".helmor/server/helmor-server")
        .context("scp helmor-server")?;
    if !scp.status.success() {
        bail!(
            "scp {} -> {host}:.helmor/server/helmor-server failed: exit {}",
            local_binary.display(),
            scp.status
        );
    }

    // 3. chmod +x so it's actually executable. scp respects the
    // local mode bits but only if the source file has them — we
    // make it explicit.
    let chmod = runner
        .run_ssh(host, &format!("chmod +x {REMOTE_INSTALL_BINARY}"))
        .context("ssh chmod +x")?;
    if !chmod.status.success() {
        bail!(
            "chmod +x {REMOTE_INSTALL_BINARY} on {host} failed: exit {}",
            chmod.status
        );
    }
    Ok(())
}

/// Abstraction over the ssh / scp subprocesses so tests can drive the
/// install logic without spawning anything. Implementations capture
/// stdout/stderr + the exit status so the caller can inspect them.
pub trait SshRunner {
    fn run_ssh(&self, host: &str, remote_command: &str) -> Result<std::process::Output>;
    fn run_scp(
        &self,
        local_path: &Path,
        host: &str,
        remote_path: &str,
    ) -> Result<std::process::Output>;
}

/// Production ssh runner. Spawns `ssh` / `scp` from `$PATH` with the
/// same `BatchMode=yes` arg the live connect path uses.
pub struct ProcessSshRunner;

impl SshRunner for ProcessSshRunner {
    fn run_ssh(&self, host: &str, remote_command: &str) -> Result<std::process::Output> {
        Command::new("ssh")
            .args(PROBE_SSH_ARGS)
            .arg(host)
            .arg(remote_command)
            .output()
            .with_context(|| format!("failed to spawn ssh probing {host}"))
    }

    fn run_scp(
        &self,
        local_path: &Path,
        host: &str,
        remote_path: &str,
    ) -> Result<std::process::Output> {
        Command::new("scp")
            .args(PROBE_SSH_ARGS)
            .arg(local_path)
            .arg(format!("{host}:{remote_path}"))
            .output()
            .with_context(|| format!("failed to spawn scp to {host}:{remote_path}"))
    }
}

/// Resolve a local `helmor-server` to upload. Resolution mirrors the
/// `connect_local_runtime` resolver: `$HELMOR_SERVER_PATH` →
/// `<exe_dir>/helmor-server[.exe]`. Lifts out the same logic to keep
/// the auto-install flow independent of the command layer.
pub fn resolve_local_helmor_server_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("HELMOR_SERVER_PATH") {
        let path = PathBuf::from(&p);
        if path.is_file() {
            return Ok(path);
        }
        bail!(
            "HELMOR_SERVER_PATH points to `{p}` which is not a file; \
             unset the var or point it at the built helmor-server binary"
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) {
                "helmor-server.exe"
            } else {
                "helmor-server"
            };
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    bail!(
        "helmor-server binary not found next to the running app. \
         Build it with `cargo build --bin helmor-server` or set HELMOR_SERVER_PATH."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::sync::Mutex;

    /// Captures everything an `SshRunner` is asked to do so tests can
    /// assert on the sequence of calls (e.g. "probe → mkdir → scp →
    /// chmod → probe").
    #[derive(Default)]
    struct RecordingRunner {
        ssh_calls: Mutex<Vec<(String, String)>>,
        scp_calls: Mutex<Vec<(PathBuf, String, String)>>,
        /// Override per-call: each `run_ssh` pops the next entry and
        /// returns it. Empty queue → "binary found" stub via
        /// `default_ssh_response`.
        ssh_responses: Mutex<Vec<std::process::Output>>,
        scp_responses: Mutex<Vec<std::process::Output>>,
    }

    impl RecordingRunner {
        fn queue_ssh(&self, output: std::process::Output) {
            self.ssh_responses.lock().unwrap().push(output);
        }
        fn queue_scp(&self, output: std::process::Output) {
            self.scp_responses.lock().unwrap().push(output);
        }
    }

    impl SshRunner for RecordingRunner {
        fn run_ssh(&self, host: &str, remote_command: &str) -> Result<std::process::Output> {
            self.ssh_calls
                .lock()
                .unwrap()
                .push((host.to_string(), remote_command.to_string()));
            Ok(self.ssh_responses.lock().unwrap().remove(0))
        }

        fn run_scp(
            &self,
            local_path: &Path,
            host: &str,
            remote_path: &str,
        ) -> Result<std::process::Output> {
            self.scp_calls.lock().unwrap().push((
                local_path.to_path_buf(),
                host.to_string(),
                remote_path.to_string(),
            ));
            Ok(self.scp_responses.lock().unwrap().remove(0))
        }
    }

    fn ok_output(stdout: &str) -> std::process::Output {
        std::process::Output {
            status: std::process::ExitStatus::from_raw(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn err_output(code: i32) -> std::process::Output {
        std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: Vec::new(),
            stderr: b"bash: helmor-server: command not found\n".to_vec(),
        }
    }

    // ── ensure: existing binary at requested path ────────────────

    #[test]
    fn ensure_returns_requested_path_when_initial_probe_succeeds() {
        let runner = RecordingRunner::default();
        runner.queue_ssh(ok_output("helmor-server 0.22.1\nprotocol 0.1.0\n"));
        let resolved = ensure_remote_helmor_server(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
        )
        .unwrap();
        assert_eq!(resolved, "helmor-server");
        // Exactly one ssh call, no scp.
        assert_eq!(runner.ssh_calls.lock().unwrap().len(), 1);
        assert!(runner.scp_calls.lock().unwrap().is_empty());
    }

    // ── ensure: managed-path fallback discovers prior install ────

    #[test]
    fn ensure_falls_back_to_managed_install_path_when_requested_is_missing() {
        let runner = RecordingRunner::default();
        // 1. Probe requested ("helmor-server") → 127, missing.
        runner.queue_ssh(err_output(127));
        // 2. Probe REMOTE_INSTALL_BINARY → found.
        runner.queue_ssh(ok_output("helmor-server 0.22.1\n"));

        let resolved = ensure_remote_helmor_server(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        assert_eq!(runner.ssh_calls.lock().unwrap().len(), 2);
        assert!(runner.scp_calls.lock().unwrap().is_empty());
    }

    // ── ensure: full install fires when nothing exists ───────────

    #[test]
    fn ensure_runs_full_install_when_no_binary_anywhere_on_remote() {
        let runner = RecordingRunner::default();
        // 1. Probe requested → missing.
        runner.queue_ssh(err_output(127));
        // 2. Probe managed path → missing.
        runner.queue_ssh(err_output(127));
        // 3. mkdir -p → success.
        runner.queue_ssh(ok_output(""));
        // 4. scp → success.
        runner.queue_scp(ok_output(""));
        // 5. chmod +x → success.
        runner.queue_ssh(ok_output(""));
        // 6. Post-install probe → success.
        runner.queue_ssh(ok_output("helmor-server 0.22.1\n"));

        let resolved = ensure_remote_helmor_server(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);

        let ssh_calls = runner.ssh_calls.lock().unwrap();
        assert_eq!(
            ssh_calls.len(),
            5,
            "expected probe, probe, mkdir, chmod, probe (5 calls); got {:?}",
            ssh_calls
        );
        // mkdir + chmod use the install dir/binary expressions.
        assert!(ssh_calls[2].1.contains("mkdir -p"));
        assert!(ssh_calls[3].1.contains("chmod +x"));

        let scp_calls = runner.scp_calls.lock().unwrap();
        assert_eq!(scp_calls.len(), 1);
        assert_eq!(scp_calls[0].1, "dev.box");
        assert_eq!(scp_calls[0].2, ".helmor/server/helmor-server");
    }

    // ── ensure: install ran but post-probe still misses ─────────

    #[test]
    fn ensure_surfaces_clear_error_when_install_succeeds_but_binary_still_missing() {
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127)); // requested probe
        runner.queue_ssh(err_output(127)); // managed probe
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_scp(ok_output("")); // scp
        runner.queue_ssh(ok_output("")); // chmod
        runner.queue_ssh(err_output(127)); // post-install probe still 127

        let err = ensure_remote_helmor_server(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("still missing"),
            "should describe the post-install miss: {msg}"
        );
    }

    // ── ensure: scp itself fails ────────────────────────────────

    #[test]
    fn ensure_propagates_scp_failure_with_path_in_message() {
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127)); // requested probe
        runner.queue_ssh(err_output(127)); // managed probe
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_scp(err_output(1)); // scp fails

        let err = ensure_remote_helmor_server(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("scp"), "should mention scp: {msg}");
    }

    // ── version parsing on the probe boundary ───────────────────

    #[test]
    fn probe_returns_first_line_only_so_protocol_footer_doesnt_leak() {
        // helmor-server --version prints two lines; we only stash
        // the first to keep the diagnostic surface tight.
        let runner = RecordingRunner::default();
        runner.queue_ssh(ok_output(
            "helmor-server 0.22.1\nprotocol 0.1.0\nextra noise\n",
        ));
        let outcome = probe_remote_version(&runner, "dev.box", "helmor-server");
        match outcome {
            ProbeOutcome::Found(v) => assert_eq!(v, "helmor-server 0.22.1"),
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn probe_treats_empty_stdout_as_missing() {
        let runner = RecordingRunner::default();
        runner.queue_ssh(ok_output(""));
        assert!(matches!(
            probe_remote_version(&runner, "dev.box", "helmor-server"),
            ProbeOutcome::Missing
        ));
    }
}
