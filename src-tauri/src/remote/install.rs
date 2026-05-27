//! Auto-install of `helmor-server` on an SSH-reachable remote.
//!
//! When the desktop's `connect_remote_runtime` command points at a
//! host that doesn't have `helmor-server` on `$PATH` yet, this module
//! probes for it and either (a) reuses the binary already deployed
//! under `$HOME/.helmor/server/`, (b) downloads a release tarball
//! from the GitHub release matching the desktop's expected
//! `PROTOCOL_VERSION`, or (c) falls back to `scp`ing the locally-built
//! binary up (dev path / no network). Mirrors the UX in #453:
//! "Helmor installs/updates a small headless helmor-server binary on
//! the remote on first connect."
//!
//! ## Probe / install protocol
//!
//! - Probe → `ssh <host> '<binary> --version'`. The binary's
//!   [`crate::bin::helmor-server`] honours `--version`/`-V` and prints
//!   `helmor-server <semver>\nprotocol <semver>`. Phase D4 (Track D)
//!   parses the second line and forces a re-install when the protocol
//!   version doesn't match the desktop's expected value, so older
//!   binaries left over from a previous Helmor install can't drift
//!   silently against a newer wire protocol.
//! - Download install path (default) → run a shell script on the
//!   remote that `curl`s `helmor-server-<version>-<target>.tar.gz`
//!   from the GitHub release, verifies the SHA256 against the release
//!   `SHA256SUMS` manifest, extracts to `$HOME/.helmor/server/`. Phase
//!   D3 — fixes the architecture-mismatch bug where the desktop's
//!   locally-built binary couldn't run on a remote with a different
//!   arch (macOS arm64 desktop → Linux x64 remote).
//! - Scp fallback (no release available / dev build) →
//!   `mkdir -p $HOME/.helmor/server` → `scp` the local binary →
//!   `chmod +x`. Honours `HELMOR_DAEMON_INSTALL_STRATEGY=scp` to
//!   bypass the download path entirely for offline / air-gapped use.
//!
//! ## What's *not* in scope
//!
//! - No credential capture. Auth flows through `ssh-agent` / keys
//!   exactly like the live connect path.
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

/// GitHub repo to pull `helmor-server` releases from. Defaults to the
/// upstream; overridable at build time so a fork's release pipeline
/// (e.g. `david-engelmann/helmor`) can flow through without code
/// changes. Set via `HELMOR_RELEASE_REPO=<org>/<repo>` during
/// `cargo build`.
pub const RELEASE_REPO: &str = match option_env!("HELMOR_RELEASE_REPO") {
    Some(repo) => repo,
    None => "dohooo/helmor",
};

/// Strategy override. `HELMOR_DAEMON_INSTALL_STRATEGY=scp` forces the
/// legacy local-binary-upload path even when a download URL is
/// available — used for air-gapped hosts + dev builds where the
/// desktop has a freshly-rebuilt local binary that hasn't been
/// released yet.
const INSTALL_STRATEGY_ENV: &str = "HELMOR_DAEMON_INSTALL_STRATEGY";

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
    let strategy = resolve_install_strategy();
    ensure_remote_helmor_server_with_strategy(runner, host, requested, local_binary, strategy)
}

/// Strategy-injectable variant. Used by tests to drive a deterministic
/// path without depending on the `HELMOR_DAEMON_INSTALL_STRATEGY` env
/// var (which is process-wide + would leak across parallel tests).
/// Production callers go through [`ensure_remote_helmor_server`].
pub fn ensure_remote_helmor_server_with_strategy<R: SshRunner>(
    runner: &R,
    host: &str,
    requested: &str,
    local_binary: &Path,
    strategy: InstallStrategy,
) -> Result<String> {
    let expected_protocol = super::PROTOCOL_VERSION;
    // The probe is best-effort: if the remote shell rejects (auth
    // failure, host down, ...) we'd rather surface that here than
    // bury it behind a scp call. But a *missing* binary should NOT
    // bubble up — it's the trigger for install.
    match probe_remote_version(runner, host, requested) {
        ProbeOutcome::Found(version) if version_matches_protocol(&version, expected_protocol) => {
            tracing::info!(
                host = %host,
                binary = %requested,
                version = %version.binary_version,
                protocol = ?version.protocol_version,
                "remote-runner: helmor-server present at requested path"
            );
            return Ok(requested.to_string());
        }
        ProbeOutcome::Found(version) => {
            tracing::info!(
                host = %host,
                binary = %requested,
                installed_protocol = ?version.protocol_version,
                expected_protocol = %expected_protocol,
                "remote-runner: requested binary's protocol doesn't match; re-installing"
            );
            // Fall through to managed-location probe + install.
        }
        ProbeOutcome::Missing => {
            // Continue to step 2.
        }
        ProbeOutcome::TransportError(err) => {
            return Err(err.context(format!("probe failed for `{requested}` on `{host}`")));
        }
    }

    // Step 2: maybe the managed location already has it AND its
    // protocol matches. A version-mismatched managed binary forces
    // a re-install (the install path overwrites cleanly).
    if requested != REMOTE_INSTALL_BINARY {
        match probe_remote_version(runner, host, REMOTE_INSTALL_BINARY) {
            ProbeOutcome::Found(version)
                if version_matches_protocol(&version, expected_protocol) =>
            {
                tracing::info!(
                    host = %host,
                    binary = %REMOTE_INSTALL_BINARY,
                    version = %version.binary_version,
                    "remote-runner: using previously-installed helmor-server"
                );
                return Ok(REMOTE_INSTALL_BINARY.to_string());
            }
            ProbeOutcome::Found(version) => {
                tracing::info!(
                    host = %host,
                    binary = %REMOTE_INSTALL_BINARY,
                    installed_protocol = ?version.protocol_version,
                    expected_protocol = %expected_protocol,
                    "remote-runner: managed binary's protocol stale; re-installing"
                );
            }
            ProbeOutcome::Missing => {}
            ProbeOutcome::TransportError(err) => return Err(err),
        }
    }

    // Step 3: fresh install. Prefer the download path so a desktop
    // running on a different arch than the remote (macOS arm64 →
    // Linux x64) gets the right binary; fall back to scp when the
    // download path can't satisfy the request.
    install_remote(runner, host, local_binary, expected_protocol, strategy)
        .with_context(|| format!("auto-install of helmor-server on `{host}` failed"))?;

    // Sanity-check the install actually landed runnable + at the
    // protocol version we expected.
    match probe_remote_version(runner, host, REMOTE_INSTALL_BINARY) {
        ProbeOutcome::Found(version) if version_matches_protocol(&version, expected_protocol) => {
            tracing::info!(
                host = %host,
                binary = %REMOTE_INSTALL_BINARY,
                version = %version.binary_version,
                "remote-runner: helmor-server installed and verified"
            );
            Ok(REMOTE_INSTALL_BINARY.to_string())
        }
        ProbeOutcome::Found(version) => {
            bail!(
                "auto-install completed but the installed binary's protocol \
                 ({:?}) doesn't match the desktop's expected protocol ({})",
                version.protocol_version,
                expected_protocol,
            )
        }
        ProbeOutcome::Missing => {
            bail!(
                "auto-install reported success but binary still missing at `{REMOTE_INSTALL_BINARY}`"
            )
        }
        ProbeOutcome::TransportError(err) => Err(err),
    }
}

/// Force-reinstall variant: skip the "binary already present and
/// protocol-compatible" probe and go straight to a fresh install at
/// the managed location. Used by the "Reinstall daemon" action the
/// desktop surfaces when it detects version drift — the operator
/// explicitly asked for the binary to be replaced even though the
/// protocol still matches.
///
/// Identical to [`ensure_remote_helmor_server`] from step 3 onward
/// (install plus post-install verify); just bypasses the early-return
/// when the existing install passes the protocol check.
pub fn force_reinstall_remote_helmor_server<R: SshRunner>(
    runner: &R,
    host: &str,
    local_binary: &Path,
) -> Result<String> {
    let strategy = resolve_install_strategy();
    let expected_protocol = super::PROTOCOL_VERSION;
    install_remote(runner, host, local_binary, expected_protocol, strategy)
        .with_context(|| format!("force re-install of helmor-server on `{host}` failed"))?;
    // Same post-install verify as `ensure_remote_helmor_server` —
    // confirm the new binary runs + reports the expected protocol.
    match probe_remote_version(runner, host, REMOTE_INSTALL_BINARY) {
        ProbeOutcome::Found(version) if version_matches_protocol(&version, expected_protocol) => {
            tracing::info!(
                host = %host,
                binary = %REMOTE_INSTALL_BINARY,
                version = %version.binary_version,
                "remote-runner: forced re-install completed; new binary verified"
            );
            Ok(REMOTE_INSTALL_BINARY.to_string())
        }
        ProbeOutcome::Found(version) => {
            bail!(
                "force re-install completed but the new binary's protocol \
                 ({:?}) doesn't match the desktop's expected protocol ({})",
                version.protocol_version,
                expected_protocol,
            )
        }
        ProbeOutcome::Missing => {
            bail!(
                "force re-install reported success but binary still missing at `{REMOTE_INSTALL_BINARY}`"
            )
        }
        ProbeOutcome::TransportError(err) => Err(err),
    }
}

/// `true` when the binary's protocol line matches our compiled-in
/// `PROTOCOL_VERSION`. Pre-D4 binaries (no protocol line at all)
/// never match — forces them to be replaced.
/// Parse a release version string like "0.22.1" or "1.0.0-beta" into
/// its three numeric components. Pre-release / build suffixes are
/// ignored (the suffix after `-` or `+` is dropped before parsing).
///
/// Returns `None` for malformed input — callers treat that as "skip
/// the comparison" rather than blowing up the connect flow.
pub fn parse_semver_triple(version: &str) -> Option<(u32, u32, u32)> {
    let base = version
        .split(['-', '+'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let mut parts = base.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    let patch: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

/// `true` when `daemon_version` is strictly older than
/// `desktop_version`. Used by the version-drift detector to decide
/// whether to surface a "reinstall recommended" banner.
///
/// `Some(false)` covers equal and newer-daemon cases (a daemon that
/// got ahead of the desktop isn't a drift the desktop should warn
/// about). `None` from a malformed string short-circuits to false
/// — we'd rather miss a warning than fire one on garbage input.
pub fn daemon_version_is_older(daemon_version: &str, desktop_version: &str) -> bool {
    match (
        parse_semver_triple(daemon_version),
        parse_semver_triple(desktop_version),
    ) {
        (Some(daemon), Some(desktop)) => daemon < desktop,
        _ => false,
    }
}

fn version_matches_protocol(probed: &ProbedVersion, expected: &str) -> bool {
    probed
        .protocol_version
        .as_deref()
        .is_some_and(|installed| installed == expected)
}

/// Result of a `--version` probe. Distinguishes "binary not on the
/// remote" (an expected, handleable case — trigger install) from
/// "ssh itself failed" (auth, network, host-down — bubble up).
#[derive(Debug)]
enum ProbeOutcome {
    /// `<binary> --version` printed something — binary is reachable.
    /// Carries the parsed semver tuple so the caller can gate on
    /// `protocol_version` matching the desktop's expected value.
    Found(ProbedVersion),
    /// Exit code suggests "command not found" or the binary errored
    /// in a way consistent with absence. We treat any non-zero exit
    /// from the probe as "missing" — the install step is idempotent
    /// enough to overwrite a junk binary safely.
    Missing,
    /// Couldn't run the probe at all (ssh failed to dial). Bubbles up
    /// so the operator gets a real error instead of a useless retry.
    TransportError(anyhow::Error),
}

/// Parsed `helmor-server --version` output. The binary prints:
///
/// ```text
/// helmor-server <semver>
/// protocol <semver>
/// ```
///
/// We keep both lines — the binary version is for logging, the
/// protocol version drives the "is this binary compatible with our
/// current PROTOCOL_VERSION?" gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbedVersion {
    pub binary_version: String,
    /// `None` for legacy binaries (pre-D4) that didn't print the
    /// protocol line. Treat as a forced upgrade trigger.
    pub protocol_version: Option<String>,
}

impl ProbedVersion {
    /// Parse the raw stdout from `helmor-server --version`.
    pub fn parse(stdout: &str) -> Option<Self> {
        let mut lines = stdout.lines();
        let binary_version = lines.next()?.trim().to_string();
        if binary_version.is_empty() {
            return None;
        }
        let protocol_version = lines.next().and_then(|line| {
            // The line shape is `protocol <semver>`. Tolerate
            // trailing whitespace; reject any other prefix so we
            // don't accidentally treat a stray log line as a
            // protocol claim.
            let rest = line.trim().strip_prefix("protocol ")?;
            let s = rest.trim().to_string();
            (!s.is_empty()).then_some(s)
        });
        Some(Self {
            binary_version,
            protocol_version,
        })
    }
}

fn probe_remote_version<R: SshRunner>(runner: &R, host: &str, binary: &str) -> ProbeOutcome {
    let remote_command = format!("{binary} --version");
    match runner.run_ssh(host, &remote_command) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            match ProbedVersion::parse(&stdout) {
                Some(v) => ProbeOutcome::Found(v),
                None => ProbeOutcome::Missing,
            }
        }
        Ok(output) => {
            // Non-zero exit. The binary IS present + correct-arch but
            // its dynamic loader can't resolve a NEEDED library (the
            // daemon links the GTK/webkit stack) → surface that as a
            // distinct, actionable error rather than treating it as
            // "missing" and re-installing the same binary into the
            // same broken state forever.
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some(missing_lib) = missing_shared_library(&stderr) {
                return ProbeOutcome::TransportError(anyhow::anyhow!(
                    "`{binary}` is installed on `{host}` but can't start: missing shared \
                     library `{missing_lib}`. The helmor-server daemon links the GTK/webkit \
                     runtime; install it on the remote (Debian/Ubuntu: `sudo apt-get install \
                     libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2 \
                     libsoup-3.0-0`). See docs/remote-server-user-guide.md → Prerequisites."
                ));
            }
            // Otherwise: "command not found" (127), a segfault, a
            // stdout write error, etc. Treat as missing — the install
            // step overwrites cleanly.
            ProbeOutcome::Missing
        }
        Err(err) => ProbeOutcome::TransportError(err),
    }
}

/// Pull the offending library name out of a dynamic-loader failure
/// like `…: error while loading shared libraries: libwebkit2gtk-4.1.so.0:
/// cannot open shared object file: No such file or directory`.
/// Returns `None` when the stderr isn't a loader error.
fn missing_shared_library(stderr: &str) -> Option<String> {
    if !stderr.contains("cannot open shared object file") {
        return None;
    }
    // The lib name precedes the `: cannot open …` clause.
    stderr
        .split("cannot open shared object file")
        .next()
        .and_then(|prefix| prefix.rsplit(['\n', ' ']).find(|t| t.contains(".so")))
        .map(|t| t.trim_end_matches(':').to_string())
}

/// Policy for the install step. Operator override
/// (`HELMOR_DAEMON_INSTALL_STRATEGY=scp`) pins to `Scp`; default is
/// `DownloadFallbackScp` which tries the GitHub release path first
/// and only scps the local binary when the download fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallStrategy {
    /// Try `install_via_download`; on failure, fall back to
    /// `install_via_scp`. The download path runs on the remote so it
    /// fetches the correct architecture even when the desktop's local
    /// binary doesn't match.
    DownloadFallbackScp,
    /// Skip the download path entirely; only `install_via_scp`. Used
    /// for offline / air-gapped hosts + dev builds where the desktop's
    /// local binary is newer than any published release.
    Scp,
}

fn resolve_install_strategy() -> InstallStrategy {
    match std::env::var(INSTALL_STRATEGY_ENV) {
        Ok(v) if v.eq_ignore_ascii_case("scp") => {
            tracing::info!(
                env = %INSTALL_STRATEGY_ENV,
                "remote-runner: install strategy pinned to scp via env",
            );
            InstallStrategy::Scp
        }
        _ => InstallStrategy::DownloadFallbackScp,
    }
}

fn install_remote<R: SshRunner>(
    runner: &R,
    host: &str,
    local_binary: &Path,
    expected_protocol: &str,
    strategy: InstallStrategy,
) -> Result<()> {
    // 1. mkdir -p the managed dir up-front so both strategies can
    // assume the directory exists.
    let mkdir = runner
        .run_ssh(host, &format!("mkdir -p {REMOTE_INSTALL_DIR}"))
        .context("ssh mkdir -p")?;
    if !mkdir.status.success() {
        bail!(
            "mkdir -p {REMOTE_INSTALL_DIR} on {host} failed: exit {}",
            mkdir.status
        );
    }

    // 2. Strategy dispatch.
    match strategy {
        InstallStrategy::Scp => install_via_scp(runner, host, local_binary),
        InstallStrategy::DownloadFallbackScp => {
            match install_via_download(runner, host, expected_protocol) {
                Ok(()) => Ok(()),
                Err(err) => {
                    tracing::warn!(
                        host = %host,
                        error = %format!("{err:#}"),
                        "remote-runner: download install failed; falling back to scp",
                    );
                    install_via_scp(runner, host, local_binary)
                }
            }
        }
    }
}

fn install_via_scp<R: SshRunner>(runner: &R, host: &str, local_binary: &Path) -> Result<()> {
    // scp the local binary up. `host:path` form puts the file under
    // the remote `$HOME` (scp default for relative paths).
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
    // chmod +x — scp respects local mode bits only if the source has
    // them; make it explicit.
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

/// Phase D3 download install. Detects the remote arch via `uname -sm`,
/// composes the GitHub release URL for that target, pipes a single
/// bash script that downloads + verifies + extracts.
///
/// **Hash-mismatch retry**: the script emits the distinctive sentinel
/// [`CHECKSUM_MISMATCH_MARKER`] on stderr when `shasum -c` rejects the
/// tarball. If we see that marker on the first attempt we re-run the
/// script once before bubbling — a CDN serving a stale or corrupted
/// byte run is the canonical reason this would happen, and a retry
/// is cheaper + safer than falling through to scp (which would happily
/// install the wrong-arch local binary).
///
/// Any *other* failure (network, extract, missing release artefact)
/// bubbles immediately so the outer `install_remote` can fall back to
/// scp without burning a second download attempt.
fn install_via_download<R: SshRunner>(
    runner: &R,
    host: &str,
    expected_protocol: &str,
) -> Result<()> {
    let arch_output = runner
        .run_ssh(host, "uname -sm")
        .context("probe remote uname")?;
    if !arch_output.status.success() {
        bail!("uname -sm on {host} failed: exit {}", arch_output.status);
    }
    let arch_line = String::from_utf8_lossy(&arch_output.stdout)
        .trim()
        .to_string();
    let target = remote_target_triple(&arch_line).with_context(|| {
        format!("can't map remote `uname -sm` output `{arch_line}` to a download target")
    })?;

    let script = build_download_script(expected_protocol, target);

    // First attempt.
    let first = runner
        .run_ssh(host, &script)
        .context("ssh download install script")?;
    if first.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&first.stderr);
    if !stderr.contains(CHECKSUM_MISMATCH_MARKER) {
        // Network failure, missing release artefact, extract failure,
        // etc. — none of those get better by trying again. Bubble so
        // the caller falls through to scp.
        bail!(
            "download install on {host} failed (exit {}): {}",
            first.status,
            stderr.trim()
        );
    }

    tracing::warn!(
        host = %host,
        "remote-runner: checksum mismatch on first download attempt; retrying once before scp fallback"
    );
    let second = runner
        .run_ssh(host, &script)
        .context("ssh download install script (retry)")?;
    if second.status.success() {
        return Ok(());
    }
    let retry_stderr = String::from_utf8_lossy(&second.stderr);
    bail!(
        "download install on {host} failed twice (exit {}): {}",
        second.status,
        retry_stderr.trim()
    )
}

/// Sentinel the install script emits on checksum mismatch. Grep'd by
/// [`install_via_download`] to decide whether to retry. Lives in code
/// rather than in the docs because the script is *generated* — the
/// constant + the script have to move together.
const CHECKSUM_MISMATCH_MARKER: &str = "HELMOR_INSTALL_CHECKSUM_MISMATCH";

/// Build the install shell script. Extracted so retries re-run the
/// same script verbatim and tests can assert structure without
/// re-spawning ssh.
///
/// The script drops `set -e` because we want to detect specific
/// failure modes and emit distinguishing sentinels rather than
/// have the shell exit on the first non-zero status. `set -u -o
/// pipefail` stays — unset vars are real bugs, and we want pipe
/// failures to surface as a non-zero exit on the relevant line.
///
/// Cross-platform tool dispatch:
///   * **Downloader**: prefer `curl` (default on macOS + most
///     Linux distros), fall back to `wget` (Alpine-minimal +
///     some legacy images).
///   * **SHA256 verification**: prefer `sha256sum` (GNU coreutils,
///     default on virtually every Linux distro), fall back to
///     `shasum -a 256` (macOS BSD default; also present on some
///     Linux distros via Perl). The script function below tries
///     both and reports a distinct failure mode if neither is on
///     `$PATH`.
///   * **Install**: `cp` + `chmod` rather than `install(1)` —
///     `cp` is in coreutils, `install` is sometimes split out
///     (e.g. `coreutils` vs `coreutils-base` on some musl images).
fn build_download_script(expected_protocol: &str, target: &str) -> String {
    let tarball = format!("helmor-server-{expected_protocol}-{target}.tar.gz");
    let tag = format!("helmor-server-v{expected_protocol}");
    let release_base = format!(
        "https://github.com/{repo}/releases/download/{tag}",
        repo = RELEASE_REPO,
    );
    let tarball_url = format!("{release_base}/{tarball}");
    let sums_url = format!("{release_base}/SHA256SUMS");
    format!(
        r#"set -uo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Downloader dispatch — curl preferred, wget as a fallback.
download() {{
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$1" "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$1" "$2"
  else
    echo "HELMOR_INSTALL_DOWNLOAD_FAILED no_downloader" >&2
    return 1
  fi
}}

# SHA-256 dispatch — sha256sum (GNU coreutils, Linux default)
# preferred, shasum -a 256 (BSD / macOS default) as fallback. The
# stdin format both accept is `<hex>  <filename>` per line.
verify_sha256() {{
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c -
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c -
  else
    echo "HELMOR_INSTALL_NO_SHA256_TOOL" >&2
    return 2
  fi
}}

if ! download "$tmp/{tarball}" "{tarball_url}"; then
  echo "HELMOR_INSTALL_DOWNLOAD_FAILED tarball" >&2
  exit 70
fi
if ! download "$tmp/SHA256SUMS" "{sums_url}"; then
  echo "HELMOR_INSTALL_DOWNLOAD_FAILED sums" >&2
  exit 70
fi
cd "$tmp"
if ! grep -F " {tarball}" SHA256SUMS | verify_sha256 >/dev/null 2>&1; then
  echo "{CHECKSUM_MISMATCH_MARKER} {tarball}" >&2
  exit 65
fi
if ! tar xzf {tarball}; then
  echo "HELMOR_INSTALL_EXTRACT_FAILED" >&2
  exit 71
fi
# `cp` + `chmod` rather than `install(1)` — `install` is sometimes
# split out of the base coreutils package on minimal images.
if ! cp helmor-server-{expected_protocol}-{target}/helmor-server "{REMOTE_INSTALL_BINARY}"; then
  echo "HELMOR_INSTALL_INSTALL_FAILED cp" >&2
  exit 72
fi
if ! chmod 0755 "{REMOTE_INSTALL_BINARY}"; then
  echo "HELMOR_INSTALL_INSTALL_FAILED chmod" >&2
  exit 72
fi
"#
    )
}

/// Map `uname -sm` output (one of `Linux x86_64`, `Linux aarch64`,
/// `Darwin x86_64`, `Darwin arm64`) to the Rust target triple the CI
/// pipeline names tarballs after.
fn remote_target_triple(uname_sm: &str) -> Result<&'static str> {
    let trimmed = uname_sm.trim();
    let target = match trimmed {
        "Linux x86_64" => "x86_64-unknown-linux-gnu",
        "Linux aarch64" => "aarch64-unknown-linux-gnu",
        "Darwin x86_64" => "x86_64-apple-darwin",
        // macOS reports `arm64` from `uname -m`, not aarch64.
        "Darwin arm64" => "aarch64-apple-darwin",
        other => bail!("unsupported remote platform `{other}` (expected Linux x86_64/aarch64 or Darwin x86_64/arm64)"),
    };
    Ok(target)
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

    // ── version drift comparator ──────────────────────────────────

    #[test]
    fn parse_semver_triple_handles_release_form() {
        assert_eq!(parse_semver_triple("0.22.1"), Some((0, 22, 1)));
        assert_eq!(parse_semver_triple("1.0.0"), Some((1, 0, 0)));
        assert_eq!(parse_semver_triple("10.20.30"), Some((10, 20, 30)));
    }

    #[test]
    fn parse_semver_triple_drops_prerelease_and_build_suffixes() {
        // Drift detection cares only about the X.Y.Z base; pre-release
        // / build metadata is irrelevant.
        assert_eq!(parse_semver_triple("0.22.1-beta"), Some((0, 22, 1)));
        assert_eq!(parse_semver_triple("0.22.1+sha.abc"), Some((0, 22, 1)));
        assert_eq!(parse_semver_triple("0.22.1-rc.4+sha.abc"), Some((0, 22, 1)));
    }

    #[test]
    fn parse_semver_triple_defaults_missing_patch_to_zero() {
        // Some upstream releases tag as "0.22" without a patch.
        assert_eq!(parse_semver_triple("0.22"), Some((0, 22, 0)));
    }

    #[test]
    fn parse_semver_triple_rejects_garbage() {
        assert_eq!(parse_semver_triple(""), None);
        assert_eq!(parse_semver_triple("not-a-version"), None);
        assert_eq!(parse_semver_triple("0..1"), None);
        assert_eq!(parse_semver_triple("0.x.1"), None);
    }

    #[test]
    fn daemon_version_is_older_compares_each_component_lexicographically() {
        assert!(daemon_version_is_older("0.21.0", "0.22.0"));
        assert!(daemon_version_is_older("0.22.0", "0.22.1"));
        assert!(daemon_version_is_older("0.22.1", "1.0.0"));
    }

    #[test]
    fn daemon_version_is_older_returns_false_when_equal_or_newer() {
        assert!(!daemon_version_is_older("0.22.1", "0.22.1"));
        assert!(!daemon_version_is_older("0.22.2", "0.22.1"));
        assert!(!daemon_version_is_older("1.0.0", "0.22.1"));
    }

    #[test]
    fn daemon_version_is_older_returns_false_on_malformed_input() {
        // Garbage input short-circuits to false — we'd rather miss
        // a warning than fire one on a parse failure.
        assert!(!daemon_version_is_older("garbage", "0.22.1"));
        assert!(!daemon_version_is_older("0.22.1", "garbage"));
        assert!(!daemon_version_is_older("", ""));
    }

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

    /// Variant of [`err_output`] that lets a test specify the exact
    /// stderr bytes — needed to drive the hash-mismatch retry path
    /// which keys off [`CHECKSUM_MISMATCH_MARKER`].
    fn err_output_with_stderr(code: i32, stderr: &str) -> std::process::Output {
        std::process::Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    // ── ensure: existing binary at requested path ────────────────

    /// Shorthand for probe stdout that matches the current
    /// `PROTOCOL_VERSION` — keeps tests stable when the constant moves.
    fn matching_probe() -> String {
        format!(
            "helmor-server 0.22.1\nprotocol {}\n",
            super::super::PROTOCOL_VERSION
        )
    }

    #[test]
    fn ensure_returns_requested_path_when_initial_probe_succeeds() {
        let runner = RecordingRunner::default();
        runner.queue_ssh(ok_output(&matching_probe()));
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
        // 2. Probe REMOTE_INSTALL_BINARY → found AND protocol matches.
        runner.queue_ssh(ok_output(&matching_probe()));

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
        // The download path needs to fail (no real network in tests)
        // so we can assert the scp fallback fires. Force scp via the
        // strategy hook so the test stays deterministic.
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
        // 6. Post-install probe → success at matching protocol.
        runner.queue_ssh(ok_output(&matching_probe()));

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::Scp,
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

        let err = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::Scp,
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

        let err = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::Scp,
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("scp"), "should mention scp: {msg}");
    }

    // ── version parsing on the probe boundary ───────────────────

    #[test]
    fn probe_parses_binary_and_protocol_lines() {
        // helmor-server --version prints two lines; the ProbedVersion
        // struct captures both so the caller can gate on the protocol
        // line.
        let runner = RecordingRunner::default();
        runner.queue_ssh(ok_output(
            "helmor-server 0.22.1\nprotocol 0.1.0\nextra noise\n",
        ));
        let outcome = probe_remote_version(&runner, "dev.box", "helmor-server");
        match outcome {
            ProbeOutcome::Found(v) => {
                assert_eq!(v.binary_version, "helmor-server 0.22.1");
                assert_eq!(v.protocol_version.as_deref(), Some("0.1.0"));
            }
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

    #[test]
    fn probe_surfaces_missing_gtk_runtime_lib_as_actionable_error() {
        // The binary is present + correct-arch but the GTK runtime
        // libs aren't installed on the remote → the loader fails.
        // This must NOT be treated as "missing" (which would loop on
        // reinstalling the same un-loadable binary); it must bubble a
        // clear "install the runtime libs" error.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output_with_stderr(
            127,
            "/home/e2e/.helmor/server/helmor-server: error while loading shared \
             libraries: libwebkit2gtk-4.1.so.0: cannot open shared object file: \
             No such file or directory\n",
        ));
        match probe_remote_version(&runner, "dev.box", "helmor-server") {
            ProbeOutcome::TransportError(err) => {
                let msg = format!("{err:#}");
                assert!(msg.contains("libwebkit2gtk-4.1.so.0"), "{msg}");
                assert!(msg.contains("apt-get install"), "{msg}");
            }
            other => panic!("expected TransportError with a libs hint, got {other:?}"),
        }
    }

    #[test]
    fn missing_shared_library_extracts_lib_name() {
        let stderr = "helmor-server: error while loading shared libraries: \
                      libgtk-3.so.0: cannot open shared object file: No such file";
        assert_eq!(
            missing_shared_library(stderr).as_deref(),
            Some("libgtk-3.so.0")
        );
        // A plain non-zero exit (no loader error) → None, so the
        // caller still treats it as "missing" + reinstalls.
        assert_eq!(
            missing_shared_library("bash: helmor-server: not found"),
            None
        );
    }

    // ── Phase D4: protocol-version gating ───────────────────────

    #[test]
    fn ensure_reinstalls_when_requested_binary_has_stale_protocol() {
        // The binary exists but reports a protocol version the
        // desktop doesn't recognise — force a re-install at the
        // managed location. Mirrors the upgrade flow: user updates
        // the desktop, daemon binary stays behind, ensure_* swaps
        // it out.
        let runner = RecordingRunner::default();
        // 1. Probe requested → found at stale protocol.
        runner.queue_ssh(ok_output("helmor-server 0.20.0\nprotocol 0.0.99\n"));
        // 2. Probe managed → missing.
        runner.queue_ssh(err_output(127));
        // 3. mkdir
        runner.queue_ssh(ok_output(""));
        // 4. scp
        runner.queue_scp(ok_output(""));
        // 5. chmod
        runner.queue_ssh(ok_output(""));
        // 6. Post-install probe → matching protocol.
        runner.queue_ssh(ok_output(&matching_probe()));

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::Scp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        // The scp call IS made — proves the stale-protocol path
        // triggered the install, not the unchanged path.
        assert_eq!(runner.scp_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn ensure_reinstalls_when_pre_d4_binary_has_no_protocol_line() {
        // Legacy binary (pre-D4) prints only the binary version
        // line, no protocol footer. Treated as forced upgrade.
        let runner = RecordingRunner::default();
        runner.queue_ssh(ok_output("helmor-server 0.18.0\n"));
        runner.queue_ssh(err_output(127));
        runner.queue_ssh(ok_output(""));
        runner.queue_scp(ok_output(""));
        runner.queue_ssh(ok_output(""));
        runner.queue_ssh(ok_output(&matching_probe()));

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::Scp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        assert_eq!(runner.scp_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn ensure_bails_when_post_install_protocol_still_doesnt_match() {
        // Install reported success but the resulting binary still
        // serves the wrong protocol — surface a clear error so an
        // operator can see the version mismatch rather than failing
        // later inside the connect path.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127));
        runner.queue_ssh(err_output(127));
        runner.queue_ssh(ok_output(""));
        runner.queue_scp(ok_output(""));
        runner.queue_ssh(ok_output(""));
        runner.queue_ssh(ok_output("helmor-server 0.22.1\nprotocol 0.0.99\n"));

        let err = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::Scp,
        )
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("doesn't match"),
            "should surface the protocol mismatch: {msg}"
        );
    }

    // ── Phase D3: target-triple mapping ─────────────────────────

    #[test]
    fn remote_target_triple_maps_supported_platforms() {
        assert_eq!(
            remote_target_triple("Linux x86_64").unwrap(),
            "x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            remote_target_triple("Linux aarch64").unwrap(),
            "aarch64-unknown-linux-gnu"
        );
        assert_eq!(
            remote_target_triple("Darwin x86_64").unwrap(),
            "x86_64-apple-darwin"
        );
        assert_eq!(
            remote_target_triple("Darwin arm64").unwrap(),
            "aarch64-apple-darwin"
        );
        // Trailing whitespace is tolerated (uname output has a
        // newline; we trim before passing in but defensive).
        assert_eq!(
            remote_target_triple("  Linux x86_64\n  ").unwrap(),
            "x86_64-unknown-linux-gnu"
        );
    }

    #[test]
    fn remote_target_triple_rejects_unsupported_platform() {
        let err = remote_target_triple("FreeBSD amd64").unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains("unsupported remote platform"),
            "should explain why we can't pick a target: {msg}"
        );
    }

    // ── Phase D3: download install path ─────────────────────────

    #[test]
    fn ensure_uses_download_path_when_strategy_is_download() {
        // Walk the full flow:
        //   1. requested probe → missing
        //   2. managed probe → missing
        //   3. mkdir
        //   4. uname (download path's first ssh call)
        //   5. download script (curl + sha256 -c + tar + install)
        //   6. post-install probe → matching
        // No scp call — download path satisfies the install.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127));
        runner.queue_ssh(err_output(127));
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_ssh(ok_output("Linux x86_64\n")); // uname
        runner.queue_ssh(ok_output("")); // download script
        runner.queue_ssh(ok_output(&matching_probe()));

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::DownloadFallbackScp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        // Crucially, scp was NOT invoked.
        assert!(
            runner.scp_calls.lock().unwrap().is_empty(),
            "download path should satisfy the install without scp",
        );
        // The download script ran (4th ssh after the two probes
        // + mkdir + uname).
        let ssh_calls = runner.ssh_calls.lock().unwrap();
        assert!(
            ssh_calls[4].1.contains("curl") && ssh_calls[4].1.contains("shasum"),
            "expected download script with curl + shasum verification; got: {}",
            ssh_calls[4].1,
        );
        // The URL inside the script references RELEASE_REPO + the
        // matching target triple.
        assert!(ssh_calls[4].1.contains(RELEASE_REPO));
        assert!(ssh_calls[4].1.contains("x86_64-unknown-linux-gnu"));
    }

    #[test]
    fn ensure_falls_back_to_scp_when_download_script_fails() {
        // Download path picks the right URL but the remote curl
        // fails (network down, host firewalled, release missing).
        // Verify the scp fallback kicks in.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127)); // requested probe
        runner.queue_ssh(err_output(127)); // managed probe
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_ssh(ok_output("Linux x86_64\n")); // uname
        runner.queue_ssh(err_output(22)); // download script fails (curl 22 = HTTP 4xx)
        runner.queue_scp(ok_output("")); // scp fallback
        runner.queue_ssh(ok_output("")); // chmod
        runner.queue_ssh(ok_output(&matching_probe()));

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::DownloadFallbackScp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        // Both download AND scp ran — the fallback chain.
        assert_eq!(runner.scp_calls.lock().unwrap().len(), 1);
    }

    // ── Phase D3: hash-mismatch retry ───────────────────────────

    #[test]
    fn download_retries_once_on_checksum_mismatch_and_succeeds() {
        // First download script attempt fails with the checksum
        // sentinel; the retry succeeds. No scp fallback should run —
        // a CDN serving stale bytes shouldn't push the wrong-arch
        // local binary onto the remote.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127)); // requested probe
        runner.queue_ssh(err_output(127)); // managed probe
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_ssh(ok_output("Linux x86_64\n")); // uname
        runner.queue_ssh(err_output_with_stderr(
            65,
            "HELMOR_INSTALL_CHECKSUM_MISMATCH helmor-server-0.1.0-x86_64-unknown-linux-gnu.tar.gz\n",
        )); // download script: 1st attempt → checksum mismatch
        runner.queue_ssh(ok_output("")); // download script: 2nd attempt → success
        runner.queue_ssh(ok_output(&matching_probe())); // post-install probe

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::DownloadFallbackScp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        assert!(
            runner.scp_calls.lock().unwrap().is_empty(),
            "retry succeeded — scp must not run"
        );
        // Two download script invocations (the 5th + 6th ssh calls
        // after requested probe + managed probe + mkdir + uname).
        let ssh_calls = runner.ssh_calls.lock().unwrap();
        assert!(
            ssh_calls[4].1.contains("curl") && ssh_calls[4].1.contains("shasum"),
            "5th ssh call should be the first download attempt"
        );
        assert_eq!(
            ssh_calls[4].1, ssh_calls[5].1,
            "retry must run the EXACT same script — anything else would risk \
             a different artefact landing on the remote"
        );
    }

    #[test]
    fn download_falls_back_to_scp_when_checksum_mismatch_persists() {
        // Both download attempts come back with the checksum
        // sentinel (e.g. the release artefact + SHA256SUMS got
        // mis-published together). The install_remote dispatcher
        // catches the bubbled error and falls through to scp.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127)); // requested probe
        runner.queue_ssh(err_output(127)); // managed probe
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_ssh(ok_output("Linux x86_64\n")); // uname
        runner.queue_ssh(err_output_with_stderr(
            65,
            "HELMOR_INSTALL_CHECKSUM_MISMATCH a\n",
        )); // 1st attempt → checksum mismatch
        runner.queue_ssh(err_output_with_stderr(
            65,
            "HELMOR_INSTALL_CHECKSUM_MISMATCH a\n",
        )); // 2nd attempt → checksum mismatch again
        runner.queue_scp(ok_output("")); // scp fallback
        runner.queue_ssh(ok_output("")); // chmod
        runner.queue_ssh(ok_output(&matching_probe())); // post-install probe

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::DownloadFallbackScp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        assert_eq!(
            runner.scp_calls.lock().unwrap().len(),
            1,
            "two checksum failures must fall through to scp"
        );
    }

    #[test]
    fn download_does_not_retry_on_non_checksum_failure() {
        // First attempt fails with a network error (curl 22, no
        // checksum sentinel). The retry path is gated on the
        // sentinel — without it, scp fallback kicks in immediately
        // so we don't burn the wall clock on a second download
        // that's just as doomed.
        let runner = RecordingRunner::default();
        runner.queue_ssh(err_output(127)); // requested probe
        runner.queue_ssh(err_output(127)); // managed probe
        runner.queue_ssh(ok_output("")); // mkdir
        runner.queue_ssh(ok_output("Linux x86_64\n")); // uname
        runner.queue_ssh(err_output_with_stderr(
            70,
            "HELMOR_INSTALL_DOWNLOAD_FAILED tarball\n",
        )); // download script: network failure
            // ↑ note: only ONE download attempt. If a retry slipped in
            // here the next ssh call would be the script again, not
            // the scp.
        runner.queue_scp(ok_output("")); // scp fallback
        runner.queue_ssh(ok_output("")); // chmod
        runner.queue_ssh(ok_output(&matching_probe())); // post-install probe

        let resolved = ensure_remote_helmor_server_with_strategy(
            &runner,
            "dev.box",
            "helmor-server",
            Path::new("/local/helmor-server"),
            InstallStrategy::DownloadFallbackScp,
        )
        .unwrap();
        assert_eq!(resolved, REMOTE_INSTALL_BINARY);
        // Confirm the script ran exactly once before scp kicked in.
        let ssh_calls = runner.ssh_calls.lock().unwrap();
        let download_attempts = ssh_calls
            .iter()
            .filter(|(_, cmd)| cmd.contains("HELMOR_INSTALL_CHECKSUM_MISMATCH"))
            .count();
        assert_eq!(
            download_attempts, 1,
            "network failures must not retry the download script"
        );
        assert_eq!(runner.scp_calls.lock().unwrap().len(), 1);
    }

    #[test]
    fn download_script_emits_checksum_mismatch_marker_in_source() {
        // Belt-and-braces: the retry logic depends on the script
        // emitting the exact marker constant. Regression-guard
        // against an editing accident.
        let script = build_download_script("0.1.0", "x86_64-unknown-linux-gnu");
        assert!(
            script.contains(CHECKSUM_MISMATCH_MARKER),
            "install script must echo the checksum marker on shasum failure"
        );
        // And the other distinguishing sentinels stay in lockstep —
        // if any of these regress to plain bash error text the
        // retry classifier can't tell them apart from a checksum
        // failure.
        assert!(script.contains("HELMOR_INSTALL_DOWNLOAD_FAILED"));
        assert!(script.contains("HELMOR_INSTALL_EXTRACT_FAILED"));
        assert!(script.contains("HELMOR_INSTALL_INSTALL_FAILED"));
    }

    #[test]
    fn download_script_uses_portable_tool_dispatch_for_curl_and_sha256() {
        // Cross-platform audit: minimal Linux images (Alpine,
        // some Debian variants) ship only `wget`/`sha256sum` while
        // macOS ships `curl`/`shasum`. The script must try both
        // pairs so the auto-install works on the long tail of
        // remote shapes — not just the macOS-runs-CI default.
        let script = build_download_script("0.1.0", "x86_64-unknown-linux-gnu");
        // Downloader: curl preferred, wget fallback, both referenced.
        assert!(
            script.contains("command -v curl") && script.contains("command -v wget"),
            "script must probe for curl then wget"
        );
        // SHA-256: sha256sum preferred (Linux), shasum fallback (macOS).
        assert!(
            script.contains("command -v sha256sum") && script.contains("command -v shasum"),
            "script must probe for sha256sum then shasum"
        );
        // Both checks must surface a distinct error if neither
        // tool is available — so the desktop's failure path can
        // log "you need a downloader" not "checksum mismatch".
        assert!(script.contains("HELMOR_INSTALL_NO_SHA256_TOOL"));
        // Install step uses cp + chmod (not `install(1)`) so the
        // script works on minimal images where install is split
        // out of the base coreutils package.
        assert!(
            script.contains("cp helmor-server-") && script.contains("chmod 0755"),
            "install step must use cp + chmod rather than install(1)"
        );
    }
}
