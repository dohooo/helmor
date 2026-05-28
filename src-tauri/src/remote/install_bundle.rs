//! Auto-install of the agent-runtime bundle (sidecar + claude binary +
//! daemon wrapper) on an SSH-reachable remote.
//!
//! The shape of an industrial remote-dev tool's first connect: zero
//! manual steps. The desktop already auto-installs `helmor-server`
//! itself (see [`super::install`]); this module installs everything the
//! daemon needs to *spawn the agent in the container* — the headline
//! that makes "your workspace lives on the remote" actually equivalent
//! to Cursor / Antigravity / Zed Remote / VS Code Remote.
//!
//! ## What we put on the remote, and where
//!
//! Every file lands under `$HOME/.helmor/server/` — the same managed
//! directory the daemon auto-install uses. We never touch the user's
//! shell rc files, never run with sudo, never need write access
//! outside this directory.
//!
//! ```text
//! $HOME/.helmor/server/
//!   helmor-server.real          (the daemon itself; from super::install)
//!   helmor-server               (wrapper script we generate, exports
//!                                HELMOR_SIDECAR_PATH +
//!                                HELMOR_CLAUDE_CODE_BIN_PATH then
//!                                execs helmor-server.real)
//!   helmor-sidecar              (cross-compiled bun --compile ELF)
//!   claude                      (claude-code CLI for this Linux arch)
//!   MANIFEST.json               (sha256 of every file we placed +
//!                                staged-at timestamp + agent SDK
//!                                version; commit marker)
//! ```
//!
//! ## Install lifecycle — atomic, idempotent, restartable
//!
//! 1. Detect the remote's `uname -m` / `uname -s` → pick the matching
//!    local bundle directory under `sidecar/dist/remote-bundles/`.
//! 2. Probe `$HOME/.helmor/server/MANIFEST.json` on the remote (best
//!    effort: a missing file means "fresh host").
//! 3. Diff the local manifest against the remote one. For each file
//!    whose SHA differs (or is missing on the remote): scp it to a
//!    `.staging/` sibling, verify the on-remote SHA, then atomically
//!    `mv` it onto its final path. The manifest itself is pushed LAST,
//!    so an interrupted run leaves a half-installed bundle whose
//!    manifest still describes the *previous* state — the next run
//!    notices the mismatch and retries cleanly.
//! 4. The daemon-side process tree (`helmor-server.real --daemon`)
//!    survives all of this because the wrapper script's `exec`
//!    happens fresh on every `--ensure-daemon` invocation; replacing
//!    the wrapper has no effect on the already-running daemon, and
//!    the next reconnect picks up the new wrapper naturally.
//!
//! ## What this module deliberately does NOT do
//!
//! - It does not chmod, scp, or rm anything outside `$HOME/.helmor/
//!   server/`. Callers should treat this as the binding contract.
//! - It does not regenerate / overwrite the user's `helmor-server.real`
//!   binary; that's [`super::install`]'s concern. The two modules
//!   compose: `super::install` first lands the daemon, then this
//!   module lands the agent runtime around it.
//! - It does not auto-trigger anywhere that hasn't been explicitly
//!   wired (today: the [`crate::commands::remote_commands::
//!   install_remote_bundle`] command + a follow-up hook in
//!   `connect_remote_runtime`). Background installs would be a
//!   surprising side effect of a "what's on the remote?" RPC.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::install::SshRunner;

/// Remote install dir relative to `$HOME` — mirrors [`super::install`]'s
/// `.helmor/server/helmor-server` scp convention. We use relative paths
/// (not `$HOME/...`) because OpenSSH's scp doesn't shell-expand the
/// destination; relative paths land under the remote `$HOME` by default,
/// which is the only thing we want to depend on.
///
/// SSH commands DO go through the remote login shell, so they use
/// `$HOME/...` (or `~/...`) freely — but the constants here are the
/// scp-friendly form, and the ssh paths just prepend `$HOME/` at the
/// call site.
pub const REMOTE_INSTALL_DIR_REL: &str = ".helmor/server";
pub const REMOTE_STAGING_DIR_REL: &str = ".helmor/server/.staging";

/// Same paths as above but rooted under `$HOME/` for SSH commands. The
/// remote shell expands these to absolute paths before running the
/// command, so `mkdir -p $HOME/.helmor/...` does what it says.
pub const REMOTE_INSTALL_DIR_SH: &str = "$HOME/.helmor/server";
pub const REMOTE_STAGING_DIR_SH: &str = "$HOME/.helmor/server/.staging";

/// The wrapper-script path the SSH transport invokes as `helmor-server`.
/// `helmor-server.real` is the actual daemon binary alongside it.
pub const REMOTE_WRAPPER_PATH_SH: &str = "$HOME/.helmor/server/helmor-server";
pub const REMOTE_DAEMON_BINARY_SH: &str = "$HOME/.helmor/server/helmor-server.real";

pub const REMOTE_MANIFEST_PATH_SH: &str = "$HOME/.helmor/server/MANIFEST.json";

/// Linux target the bundle was assembled for. Maps 1:1 to the
/// `stage-vendor.ts` `RemoteTargetKey` enum on the desktop side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteTargetKey {
    LinuxArm64,
    LinuxX64,
}

impl RemoteTargetKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LinuxArm64 => "linux-arm64",
            Self::LinuxX64 => "linux-x64",
        }
    }

    /// Parse a `uname -s`/`uname -m` pair into the bundle key.
    pub fn from_uname(uname_s: &str, uname_m: &str) -> Result<Self> {
        let os = uname_s.trim().to_ascii_lowercase();
        let arch = uname_m.trim().to_ascii_lowercase();
        if os != "linux" {
            bail!(
                "remote bundle install only supports Linux daemons today; uname -s reported `{uname_s}` (uname -m `{uname_m}`)",
            );
        }
        match arch.as_str() {
            "aarch64" | "arm64" => Ok(Self::LinuxArm64),
            "x86_64" | "amd64" => Ok(Self::LinuxX64),
            other => bail!(
                "unsupported Linux architecture for remote bundle: `{other}` (uname -m). Helmor ships bundles for arm64 + x64",
            ),
        }
    }
}

/// One file in a bundle. Mirrors the JSON written by `stage-vendor.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ManifestEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Top-level bundle manifest — the source of truth on what should be
/// installed on the remote, sha-pinned. Bytes are advisory (used for
/// progress reporting; the install will still verify SHAs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleManifest {
    pub schema_version: u32,
    pub target: RemoteTargetKey,
    pub staged_at: String,
    pub claude_code_version: String,
    pub files: Vec<ManifestEntry>,
}

impl BundleManifest {
    pub fn find(&self, path: &str) -> Option<&ManifestEntry> {
        self.files.iter().find(|e| e.path == path)
    }
}

/// Outcome of an `ensure_remote_bundle` run, surfaced to the caller so
/// the UI can render "fresh install" vs. "already current" vs. "patched
/// 1 file."
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureRemoteBundleOutcome {
    pub manifest: BundleManifest,
    pub installed_files: Vec<String>,
    pub already_current: bool,
}

/// Read the local bundle manifest the desktop will push. `bundle_dir`
/// is `<sidecar-root>/dist/remote-bundles/<target>/`; the manifest lives
/// at `<bundle_dir>/MANIFEST.json`.
pub fn read_local_manifest(bundle_dir: &Path) -> Result<BundleManifest> {
    let manifest_path = bundle_dir.join("MANIFEST.json");
    let body = std::fs::read_to_string(&manifest_path).with_context(|| {
        format!(
            "read local bundle manifest at {} — did you run \
             `HELMOR_REMOTE_BUNDLES=<target> bun run scripts/stage-vendor.ts` in sidecar/?",
            manifest_path.display(),
        )
    })?;
    let manifest: BundleManifest = serde_json::from_str(&body)
        .with_context(|| format!("parse local bundle manifest at {}", manifest_path.display(),))?;
    if manifest.schema_version != 1 {
        bail!(
            "unsupported bundle schema version {} (desktop only knows v1); upgrade Helmor or regenerate the bundle",
            manifest.schema_version,
        );
    }
    Ok(manifest)
}

/// Read the remote bundle manifest if one is present. `Ok(None)` means
/// "no manifest on the remote — fresh install needed." Any other failure
/// (auth, transport, malformed JSON) propagates.
pub fn probe_remote_manifest<R: SshRunner>(
    runner: &R,
    host: &str,
) -> Result<Option<BundleManifest>> {
    // `2>/dev/null` swallows the "No such file" stderr so we get a
    // clean empty stdout on first install. The exit code is also 1 in
    // that case, but the contract is "empty stdout" → None.
    let out = runner.run_ssh(host, &format!("cat {REMOTE_MANIFEST_PATH_SH} 2>/dev/null"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let manifest: BundleManifest = serde_json::from_str(trimmed).with_context(|| {
        format!("remote bundle manifest at {REMOTE_MANIFEST_PATH_SH} is malformed")
    })?;
    Ok(Some(manifest))
}

/// Detect which `RemoteTargetKey` matches the remote host. Asks ssh
/// for `uname -s && uname -m`; the daemon-install path has already
/// authenticated the connection by the time this runs, so any error
/// here is transport — not "I couldn't find a binary" — and bubbles up.
pub fn detect_remote_target<R: SshRunner>(runner: &R, host: &str) -> Result<RemoteTargetKey> {
    let out = runner.run_ssh(host, "uname -s; uname -m")?;
    if !out.status.success() {
        bail!(
            "ssh `uname -s; uname -m` against `{host}` failed: {}",
            String::from_utf8_lossy(&out.stderr).trim(),
        );
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    let uname_s = lines.next().unwrap_or("").trim().to_string();
    let uname_m = lines.next().unwrap_or("").trim().to_string();
    if uname_s.is_empty() || uname_m.is_empty() {
        bail!("ssh `uname` returned unexpected output (`{stdout}`); expected two lines",);
    }
    RemoteTargetKey::from_uname(&uname_s, &uname_m)
}

/// Compute the list of file names that need to be pushed: every entry
/// in the local manifest whose SHA differs from the remote (or whose
/// path isn't present in the remote manifest at all). Returns the
/// names — the actual push happens in [`push_file`].
fn diff_install_plan(local: &BundleManifest, remote: Option<&BundleManifest>) -> Vec<String> {
    let mut needed = Vec::new();
    for entry in &local.files {
        let already_current = remote
            .and_then(|m| m.find(&entry.path))
            .map(|r| r.sha256 == entry.sha256)
            .unwrap_or(false);
        if !already_current {
            needed.push(entry.path.clone());
        }
    }
    needed
}

/// Some bundle members install at a different filename on the remote.
/// The wrapper script ships as `helmor-server-wrapper.sh` for clarity
/// in the local bundle dir, but the SSH transport invokes it as
/// `helmor-server` (the same path the daemon-install routine uses for
/// the bare binary). The pre-install hook in [`ensure_remote_bundle`]
/// moves any unwrapped binary aside to `helmor-server.real` first so
/// our wrapper can `exec` it.
fn remote_install_filename(bundle_path: &str) -> &str {
    match bundle_path {
        "helmor-server-wrapper.sh" => "helmor-server",
        other => other,
    }
}

/// Push one file via scp → verify sha256 on the remote → atomic `mv`
/// onto the final path. Idempotent; safe to retry. Files known to be
/// executable (the sidecar, claude, the wrapper) are chmod-ed to 0755
/// after the move; the manifest itself stays 0644.
fn push_file<R: SshRunner>(
    runner: &R,
    host: &str,
    bundle_dir: &Path,
    entry: &ManifestEntry,
) -> Result<()> {
    let local_path = bundle_dir.join(&entry.path);
    if !local_path.is_file() {
        bail!(
            "bundle file {} listed in MANIFEST but missing on disk at {}",
            entry.path,
            local_path.display(),
        );
    }
    // Staging name keeps the source filename so a `ls .staging/` is
    // legible during debugging; the post-verify rename lands at the
    // bundle's *install* path, which may differ (see `remote_install_filename`).
    // scp uses paths relative to `$HOME` (its default working dir) so
    // we don't have to rely on shell expansion at the scp layer; ssh
    // commands use the $HOME-rooted form because they DO get the
    // remote login shell to expand them.
    let scp_dest = format!("{REMOTE_STAGING_DIR_REL}/{}", entry.path);
    let staging_path = format!("{REMOTE_STAGING_DIR_SH}/{}", entry.path);
    let final_name = remote_install_filename(&entry.path);
    let final_path = format!("{REMOTE_INSTALL_DIR_SH}/{final_name}");

    // `mkdir -p` first — staging dir might not exist on a fresh host.
    let mkdir = runner.run_ssh(host, &format!("mkdir -p {REMOTE_STAGING_DIR_SH}"))?;
    if !mkdir.status.success() {
        bail!(
            "mkdir -p {REMOTE_STAGING_DIR_SH} failed on `{host}`: {}",
            String::from_utf8_lossy(&mkdir.stderr).trim(),
        );
    }

    // scp local → staging. We can't scp directly to the final path
    // because a half-written file would survive a Ctrl-C and pretend
    // to be valid.
    let scp_out = runner.run_scp(&local_path, host, &scp_dest)?;
    if !scp_out.status.success() {
        bail!(
            "scp {} → {host}:{scp_dest} failed: {}",
            local_path.display(),
            String::from_utf8_lossy(&scp_out.stderr).trim(),
        );
    }

    // Verify the SHA on the remote — defends against truncated copies
    // *and* a transport tampering with the bytes mid-flight (cheap, and
    // it's the only way to be sure the on-disk file matches what the
    // local manifest said it should).
    let verify_cmd = format!("sha256sum {staging_path} | cut -d ' ' -f 1",);
    let verify_out = runner.run_ssh(host, &verify_cmd)?;
    if !verify_out.status.success() {
        bail!(
            "remote sha256sum on {staging_path} failed: {}",
            String::from_utf8_lossy(&verify_out.stderr).trim(),
        );
    }
    let observed_sha = String::from_utf8_lossy(&verify_out.stdout)
        .trim()
        .to_string();
    if observed_sha != entry.sha256 {
        // Clean up the bad staged file so it doesn't poison a retry.
        let _ = runner.run_ssh(host, &format!("rm -f {staging_path}"));
        bail!(
            "sha256 mismatch for {} after upload:\n  expected: {}\n  observed: {}",
            entry.path,
            entry.sha256,
            observed_sha,
        );
    }

    // Atomic mv onto the final path. `mv` is atomic within a single
    // filesystem (POSIX `rename(2)`), so a crash either leaves the
    // OLD file at `final_path` or the NEW file — never a half-written
    // hybrid. The daemon's process is unaffected by the rename
    // because it's already memory-mapped its current binary.
    let mv_cmd = format!("mv -f {staging_path} {final_path}");
    let mv_out = runner.run_ssh(host, &mv_cmd)?;
    if !mv_out.status.success() {
        bail!(
            "atomic mv `{staging_path}` → `{final_path}` failed on `{host}`: {}",
            String::from_utf8_lossy(&mv_out.stderr).trim(),
        );
    }

    // chmod +x for the executable members. The manifest itself is
    // data, so it stays whatever umask the user has set.
    if is_executable_bundle_entry(&entry.path) {
        let chmod_out = runner.run_ssh(host, &format!("chmod 0755 {final_path}"))?;
        if !chmod_out.status.success() {
            bail!(
                "chmod 0755 {final_path} failed: {}",
                String::from_utf8_lossy(&chmod_out.stderr).trim(),
            );
        }
    }

    Ok(())
}

/// Names of bundle files that should be `chmod 0755` after install.
/// Wrapper scripts + the cross-compiled ELFs are executables; the
/// JSON manifest stays a regular file.
fn is_executable_bundle_entry(name: &str) -> bool {
    matches!(name, "helmor-sidecar" | "claude")
        || name.ends_with(".sh")
        || name == "helmor-server-wrapper.sh"
}

/// The orchestrator. Mirrors the contract of
/// [`super::install::ensure_remote_helmor_server`]: idempotent, returns
/// the manifest that's now installed.
///
/// Step order is load-detect-diff-push-commit:
///   1. Load the local manifest (errors are caller's problem — usually
///      "did you stage the bundle?").
///   2. Detect the remote target. We don't trust `local.target` against
///      it: if `uname -m` says `aarch64` but the bundle is x64, that's a
///      precondition failure that should surface here, not after we've
///      shipped 200 MB of the wrong binary.
///   3. Probe the remote manifest. Missing = fresh install.
///   4. Diff → push each missing/mismatched file.
///   5. Push the manifest last as the commit marker.
pub fn ensure_remote_bundle<R: SshRunner>(
    runner: &R,
    host: &str,
    bundle_dir: &Path,
) -> Result<EnsureRemoteBundleOutcome> {
    let local = read_local_manifest(bundle_dir)?;
    let remote_target =
        detect_remote_target(runner, host).with_context(|| format!("detect target of `{host}`"))?;
    if remote_target != local.target {
        bail!(
            "bundle target mismatch: local bundle is for {:?} but remote `{host}` is {:?} (uname -m).\n\
             Stage a bundle for the right target with `HELMOR_REMOTE_BUNDLES={} bun run scripts/stage-vendor.ts` in sidecar/",
            local.target.as_str(),
            remote_target.as_str(),
            remote_target.as_str(),
        );
    }

    let remote = probe_remote_manifest(runner, host).unwrap_or_else(|err| {
        // A malformed remote manifest is logged loudly but treated as
        // "no manifest" — we'll overwrite it with the local one and
        // everything will be sha-verified along the way.
        tracing::warn!(
            host = %host,
            error = ?err,
            "remote bundle manifest unreadable; treating as missing",
        );
        None
    });

    let plan = diff_install_plan(&local, remote.as_ref());
    if plan.is_empty() {
        tracing::info!(
            host = %host,
            target = %local.target.as_str(),
            "remote bundle already current — skipping install",
        );
        return Ok(EnsureRemoteBundleOutcome {
            manifest: local,
            installed_files: Vec::new(),
            already_current: true,
        });
    }

    tracing::info!(
        host = %host,
        target = %local.target.as_str(),
        files = ?plan,
        "remote bundle install: pushing {} file(s)",
        plan.len(),
    );

    // Make the dir exists (also enforces 0755 if it was created with a
    // tighter umask). Defensive — the daemon-install path already does
    // this, but a stand-alone `install_remote_bundle` callout should
    // not assume that.
    let mkdir = runner.run_ssh(host, &format!("mkdir -p {REMOTE_INSTALL_DIR_SH}"))?;
    if !mkdir.status.success() {
        bail!(
            "mkdir -p {REMOTE_INSTALL_DIR_SH} failed on `{host}`: {}",
            String::from_utf8_lossy(&mkdir.stderr).trim(),
        );
    }

    // Preserve the unwrapped daemon binary as `helmor-server.real` so
    // our wrapper script can `exec` it. Cases:
    //   - Fresh host: neither file exists → command is a no-op.
    //   - Daemon installed earlier (no bundle yet): `helmor-server` is
    //     the 40 MB ELF → move it to `helmor-server.real`.
    //   - Bundle previously installed: `.real` exists → no-op.
    // The condition runs in the remote shell so we never read/write the
    // file from the desktop side; the file we then push as
    // `helmor-server` will atomically replace whatever sits there.
    let preserve_cmd = format!(
        "test -f {REMOTE_DAEMON_BINARY_SH} || ([ -f {REMOTE_WRAPPER_PATH_SH} ] && mv -f {REMOTE_WRAPPER_PATH_SH} {REMOTE_DAEMON_BINARY_SH}) || true"
    );
    let preserve = runner.run_ssh(host, &preserve_cmd)?;
    if !preserve.status.success() {
        bail!(
            "preserve daemon binary as {REMOTE_DAEMON_BINARY_SH} failed on `{host}`: {}",
            String::from_utf8_lossy(&preserve.stderr).trim(),
        );
    }

    for path in &plan {
        let entry = local
            .find(path)
            .ok_or_else(|| anyhow::anyhow!("planned file `{path}` missing from local manifest"))?;
        push_file(runner, host, bundle_dir, entry)
            .with_context(|| format!("push bundle file `{path}` to `{host}`"))?;
        tracing::info!(host = %host, file = %path, "remote bundle: pushed");
    }

    // MANIFEST.json is the commit marker — push it last so a partial
    // run leaves the *prior* manifest in place; the next attempt will
    // notice the mismatch and only push what's still missing.
    let manifest_path = bundle_dir.join("MANIFEST.json");
    let manifest_entry = ManifestEntry {
        path: "MANIFEST.json".into(),
        sha256: sha256_of_path(&manifest_path)?,
        bytes: std::fs::metadata(&manifest_path)?.len(),
    };
    push_file(runner, host, bundle_dir, &manifest_entry)
        .with_context(|| "push MANIFEST.json (commit marker)")?;

    // Tidy: empty out the staging dir. Best-effort — leaving leftovers
    // is correctness-safe, only wastes disk on the remote.
    let _ = runner.run_ssh(host, &format!("rm -rf {REMOTE_STAGING_DIR_SH}"));

    Ok(EnsureRemoteBundleOutcome {
        manifest: local,
        installed_files: plan,
        already_current: false,
    })
}

fn sha256_of_path(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes =
        std::fs::read(path).with_context(|| format!("read {} for sha256", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Resolve the local bundle directory for `target`. Honors
/// `HELMOR_REMOTE_BUNDLES_DIR` (operators / CI) first; falls back to
/// `<exe_parent>/../sidecar/dist/remote-bundles/<target>/` which is the
/// layout `bun run build` + `HELMOR_REMOTE_BUNDLES=<target> bun run
/// scripts/stage-vendor.ts` produces during dev.
pub fn resolve_local_bundle_dir(target: RemoteTargetKey) -> Result<std::path::PathBuf> {
    if let Ok(root) = std::env::var("HELMOR_REMOTE_BUNDLES_DIR") {
        let dir = std::path::PathBuf::from(&root).join(target.as_str());
        if dir.is_dir() {
            return Ok(dir);
        }
        bail!(
            "HELMOR_REMOTE_BUNDLES_DIR is set to `{root}` but `{}` doesn't exist as a directory",
            dir.display(),
        );
    }
    let exe = std::env::current_exe().context("resolve current_exe")?;
    let exe_dir = exe.parent().context("current_exe has no parent")?;
    // Walk up looking for `sidecar/dist/remote-bundles/<target>/`. The
    // dev binary lives at `src-tauri/target/debug/helmor` so 3 levels
    // up is the repo root; the release bundle's structure is different
    // but in that case `HELMOR_REMOTE_BUNDLES_DIR` should be set.
    for candidate in [
        exe_dir.join("../../../sidecar/dist/remote-bundles"),
        exe_dir.join("../../sidecar/dist/remote-bundles"),
        exe_dir.join("../sidecar/dist/remote-bundles"),
    ] {
        let dir = candidate.join(target.as_str());
        if dir.is_dir() {
            return Ok(dir);
        }
    }
    bail!(
        "could not locate remote bundle for {} — stage one with \
         `HELMOR_REMOTE_BUNDLES={} bun run scripts/stage-vendor.ts` in sidecar/, \
         or set HELMOR_REMOTE_BUNDLES_DIR to the directory containing the target subdirs",
        target.as_str(),
        target.as_str(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uname_into_known_targets() {
        assert_eq!(
            RemoteTargetKey::from_uname("Linux", "aarch64").unwrap(),
            RemoteTargetKey::LinuxArm64,
        );
        assert_eq!(
            RemoteTargetKey::from_uname("Linux", "arm64").unwrap(),
            RemoteTargetKey::LinuxArm64,
        );
        assert_eq!(
            RemoteTargetKey::from_uname("linux", "x86_64").unwrap(),
            RemoteTargetKey::LinuxX64,
        );
        assert_eq!(
            RemoteTargetKey::from_uname("Linux", "amd64").unwrap(),
            RemoteTargetKey::LinuxX64,
        );
    }

    #[test]
    fn rejects_non_linux_targets() {
        let err = RemoteTargetKey::from_uname("Darwin", "arm64")
            .unwrap_err()
            .to_string();
        assert!(err.contains("only supports Linux"), "{err}");
    }

    #[test]
    fn rejects_unknown_linux_arch() {
        let err = RemoteTargetKey::from_uname("Linux", "ppc64le")
            .unwrap_err()
            .to_string();
        assert!(err.contains("unsupported Linux architecture"), "{err}");
    }

    #[test]
    fn diff_returns_only_changed_files() {
        let local = BundleManifest {
            schema_version: 1,
            target: RemoteTargetKey::LinuxArm64,
            staged_at: "now".into(),
            claude_code_version: "2.1.139".into(),
            files: vec![
                ManifestEntry {
                    path: "helmor-sidecar".into(),
                    sha256: "aaaa".into(),
                    bytes: 100,
                },
                ManifestEntry {
                    path: "claude".into(),
                    sha256: "bbbb".into(),
                    bytes: 200,
                },
                ManifestEntry {
                    path: "helmor-server-wrapper.sh".into(),
                    sha256: "cccc".into(),
                    bytes: 300,
                },
            ],
        };
        let remote = BundleManifest {
            schema_version: 1,
            target: RemoteTargetKey::LinuxArm64,
            staged_at: "earlier".into(),
            claude_code_version: "2.1.139".into(),
            files: vec![
                // sidecar matches → skipped
                ManifestEntry {
                    path: "helmor-sidecar".into(),
                    sha256: "aaaa".into(),
                    bytes: 100,
                },
                // claude differs → push
                ManifestEntry {
                    path: "claude".into(),
                    sha256: "DIFFERENT".into(),
                    bytes: 200,
                },
                // wrapper missing on remote → push
            ],
        };
        let plan = diff_install_plan(&local, Some(&remote));
        assert_eq!(plan, vec!["claude", "helmor-server-wrapper.sh"]);
    }

    #[test]
    fn diff_with_no_remote_manifest_pushes_everything() {
        let local = BundleManifest {
            schema_version: 1,
            target: RemoteTargetKey::LinuxArm64,
            staged_at: "now".into(),
            claude_code_version: "2.1.139".into(),
            files: vec![
                ManifestEntry {
                    path: "x".into(),
                    sha256: "1".into(),
                    bytes: 1,
                },
                ManifestEntry {
                    path: "y".into(),
                    sha256: "2".into(),
                    bytes: 2,
                },
            ],
        };
        let plan = diff_install_plan(&local, None);
        assert_eq!(plan, vec!["x", "y"]);
    }

    #[test]
    fn is_executable_classifies_payload_correctly() {
        assert!(is_executable_bundle_entry("helmor-sidecar"));
        assert!(is_executable_bundle_entry("claude"));
        assert!(is_executable_bundle_entry("helmor-server-wrapper.sh"));
        assert!(!is_executable_bundle_entry("MANIFEST.json"));
    }
}
