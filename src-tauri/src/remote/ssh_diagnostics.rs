//! Tracks B3 + B4: surface SSH key + agent state to the desktop's
//! Add-Server wizard and Remote Servers settings panel.
//!
//! - **B3 (key visibility)** — enumerate `~/.ssh/*.pub` files whose
//!   matching private key also exists. The wizard renders the list
//!   as a hint ("Your keys: id_ed25519, work_rsa"); we intentionally
//!   don't let the user *pick* a key — ssh reads `~/.ssh/config` +
//!   `~/.ssh/identity*` itself, and overriding via `-i` would force
//!   us to bypass the operator's existing config. The point is to
//!   show that the desktop *can* see the keys ssh would use.
//!
//! - **B4 (agent diagnostics)** — detect whether `SSH_AUTH_SOCK` is
//!   set and the socket answers `ssh-add -l`. Three outcomes:
//!     - `Ok` with `keys` count if the agent answered. Banner is
//!       green.
//!     - `NotConfigured` if the env var is missing. Banner is amber,
//!       hint says "Run `ssh-add` to load keys".
//!     - `Stale` if the env var points at a socket that doesn't
//!       answer. Banner is red; usually means the agent was killed
//!       since the desktop launched (or a fresh login shell needs to
//!       export `SSH_AUTH_SOCK` again).
//!
//! Both checks are *best-effort* — they never error to the caller.
//! A missing `$HOME`, a permissions denial, an `ssh-add` binary the
//! user doesn't have all surface as empty / `NotConfigured` rather
//! than failing the whole settings panel.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// One entry in the user's `~/.ssh` directory that looks like an
/// identity key pair. `name` is the file stem (`id_ed25519`,
/// `work_rsa`); the desktop renders these as bullet points without
/// the full path so a screenshot can be shared without leaking the
/// user's $HOME structure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshIdentity {
    /// Display name — file stem of the public key (e.g. `id_ed25519`).
    pub name: String,
    /// Absolute path to the public key file. The desktop shows this
    /// on hover so an operator can copy the path if they need it,
    /// but isn't rendered inline.
    pub public_key_path: String,
    /// `true` when the matching private key also exists on disk.
    /// We deliberately don't read the private key (would require
    /// passphrase handling); we just stat-check that the path
    /// exists so the wizard can warn "public key without a private
    /// key — won't authenticate".
    pub has_private_key: bool,
}

/// Snapshot returned by [`ssh_agent_status`]. The frontend renders
/// one of three chips based on `state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum SshAgentStatus {
    /// Agent is running + reachable. `keysLoaded` reports the
    /// count from `ssh-add -l` (0 is legal — agent's running but no
    /// keys added yet).
    Available {
        socket_path: String,
        keys_loaded: u32,
    },
    /// `SSH_AUTH_SOCK` isn't set in the desktop's environment. Most
    /// commonly the user launched Helmor from a Finder/Spotlight
    /// click rather than a shell with their agent set up.
    NotConfigured,
    /// `SSH_AUTH_SOCK` is set but the socket doesn't answer. Usually
    /// the agent was killed (or restarted with a new socket) since
    /// the desktop launched. The chip prompts the user to relaunch
    /// the app from a fresh shell.
    Stale {
        socket_path: String,
        /// Human-readable error from the probe; surfaced verbatim
        /// in the chip's tooltip.
        reason: String,
    },
}

/// Where `ssh-add -l` lives. Plumbed so tests can drive a shim binary
/// (echoes scripted output) without depending on the host's real
/// ssh-add.
pub trait SshAddRunner: Send + Sync {
    /// Run `ssh-add -l` with the desktop's current environment plus
    /// `SSH_AUTH_SOCK=<socket>`. Returns the stdout (combined with
    /// stderr if needed) and the exit code so the parser can tell
    /// "agent answered with 0 keys" (exit 1, stdout "The agent has no
    /// identities.") from "agent unreachable" (exit 2, stderr
    /// "Could not open a connection...").
    fn list_keys(&self, socket: &str) -> SshAddOutcome;
}

/// What `ssh-add -l` produced. Mirrors `process::Output` minus the
/// raw bytes the parser doesn't need — `status_code` is the only
/// field the state machine consults; `stdout` is parsed only when
/// the call succeeded.
pub struct SshAddOutcome {
    /// Exit code. `Some(0)` means keys are listed; `Some(1)` means
    /// "no identities" (still a healthy agent); other codes / spawn
    /// failures fold to `None` so the caller can flag as stale.
    pub status_code: Option<i32>,
    /// Combined stdout. The parser counts non-empty lines for the
    /// "keys loaded" stat.
    pub stdout: String,
}

/// Real `ssh-add -l` runner. Used in production. Tests substitute
/// [`SshAddRunner`] impls that return pre-baked outputs.
pub struct ProcessSshAddRunner;

impl SshAddRunner for ProcessSshAddRunner {
    fn list_keys(&self, socket: &str) -> SshAddOutcome {
        // 750ms is way more than enough for ssh-add -l against a
        // healthy agent (couple ms locally). The point is to fail
        // fast on a wedged socket so the settings panel refresh
        // doesn't stall behind a hung Unix-socket connect.
        let mut cmd = Command::new("ssh-add");
        cmd.arg("-l").env("SSH_AUTH_SOCK", socket);
        run_with_timeout(cmd, Duration::from_millis(750)).unwrap_or(SshAddOutcome {
            status_code: None,
            stdout: String::new(),
        })
    }
}

/// Local "spawn child, poll with deadline, kill on hang" helper.
/// Duplicates the shape of the one in `rate_limits::claude::process`
/// (which is `pub(super)`, not reachable from here) but folds stdout
/// + status into [`SshAddOutcome`] directly.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<SshAddOutcome> {
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                use std::io::Read;
                let mut stdout = String::new();
                if let Some(mut handle) = child.stdout.take() {
                    let _ = handle.read_to_string(&mut stdout);
                }
                return Some(SshAddOutcome {
                    status_code: status.code(),
                    stdout,
                });
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

/// Public production entry point: read `$HOME/.ssh` for visible
/// identities, returning them sorted by `name` for a stable UI.
pub fn list_ssh_identities() -> Vec<SshIdentity> {
    let Some(ssh_dir) = ssh_dir_from_env() else {
        return Vec::new();
    };
    list_ssh_identities_in(&ssh_dir)
}

/// Listing variant taking an explicit directory. Lets tests drop
/// fixtures into a tempdir.
pub fn list_ssh_identities_in(ssh_dir: &Path) -> Vec<SshIdentity> {
    let read = match std::fs::read_dir(ssh_dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let mut identities: Vec<SshIdentity> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            // Pub key files must end with `.pub` AND have a name we
            // recognise as an identity (not e.g. `known_hosts.pub`,
            // though that's vanishingly rare).
            let extension = path.extension().and_then(|s| s.to_str())?;
            if extension != "pub" {
                return None;
            }
            // The stem must not look like a known non-identity file
            // (defensive — currently we filter `authorized_keys.pub`
            // and `known_hosts.pub`).
            let stem = path.file_stem().and_then(|s| s.to_str())?;
            if matches!(stem, "authorized_keys" | "known_hosts" | "ssh_known_hosts") {
                return None;
            }
            let private_path = path.with_extension("");
            Some(SshIdentity {
                name: stem.to_string(),
                public_key_path: path.display().to_string(),
                has_private_key: private_path.exists(),
            })
        })
        .collect();
    identities.sort_by(|a, b| a.name.cmp(&b.name));
    identities
}

/// Public production entry point for the agent chip. Defers to the
/// process-backed runner; tests use [`ssh_agent_status_with`] with a
/// scripted runner.
pub fn ssh_agent_status() -> SshAgentStatus {
    ssh_agent_status_with(&ProcessSshAddRunner)
}

/// Agent-status variant that takes a runner. Splits IO from policy
/// so the state machine is unit-testable.
pub fn ssh_agent_status_with<R: SshAddRunner + ?Sized>(runner: &R) -> SshAgentStatus {
    let Some(socket) = std::env::var("SSH_AUTH_SOCK")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return SshAgentStatus::NotConfigured;
    };
    let outcome = runner.list_keys(&socket);
    classify_ssh_add_outcome(&socket, outcome)
}

/// Pure decision over `ssh-add -l`'s output. Extracted so unit tests
/// don't have to shell out to assert the state mapping.
pub(crate) fn classify_ssh_add_outcome(socket: &str, outcome: SshAddOutcome) -> SshAgentStatus {
    match outcome.status_code {
        // Exit 0: agent answered, output lists keys (one per line).
        Some(0) => SshAgentStatus::Available {
            socket_path: socket.to_string(),
            keys_loaded: count_keys(&outcome.stdout),
        },
        // Exit 1: agent answered, "The agent has no identities." —
        // still healthy, just empty. Show as Available with 0 keys
        // so the chip surfaces the agent at all.
        Some(1) => SshAgentStatus::Available {
            socket_path: socket.to_string(),
            keys_loaded: 0,
        },
        // Anything else (including spawn failures + timeouts that
        // produced no exit code): treat the socket as stale.
        other => SshAgentStatus::Stale {
            socket_path: socket.to_string(),
            reason: stale_reason(other),
        },
    }
}

fn count_keys(stdout: &str) -> u32 {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as u32
}

fn stale_reason(status_code: Option<i32>) -> String {
    match status_code {
        Some(code) => format!("ssh-add -l exited with status {code}"),
        None => "ssh-add -l did not return (binary missing or timed out)".to_string(),
    }
}

fn ssh_dir_from_env() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|s| !s.is_empty())?;
    Some(PathBuf::from(home).join(".ssh"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── list_ssh_identities_in ─────────────────────────────────────

    #[test]
    fn list_returns_empty_when_ssh_dir_missing() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("no-such");
        assert!(list_ssh_identities_in(&missing).is_empty());
    }

    #[test]
    fn list_picks_up_pub_key_with_matching_private_key() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("id_ed25519"), b"private").unwrap();
        fs::write(dir.path().join("id_ed25519.pub"), b"ssh-ed25519 AAAA...").unwrap();
        let identities = list_ssh_identities_in(dir.path());
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].name, "id_ed25519");
        assert!(identities[0].has_private_key);
    }

    #[test]
    fn list_marks_orphan_pub_keys_without_private() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("orphan.pub"), b"ssh-rsa AAAA...").unwrap();
        let identities = list_ssh_identities_in(dir.path());
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[0].name, "orphan");
        assert!(!identities[0].has_private_key);
    }

    #[test]
    fn list_returns_alphabetised_entries_for_stable_ui() {
        let dir = TempDir::new().unwrap();
        for stem in ["zeta", "alpha", "middle"] {
            fs::write(dir.path().join(stem), b"k").unwrap();
            fs::write(dir.path().join(format!("{stem}.pub")), b"ssh-ed25519 AAAA").unwrap();
        }
        let names: Vec<_> = list_ssh_identities_in(dir.path())
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(names, vec!["alpha", "middle", "zeta"]);
    }

    #[test]
    fn list_filters_authorised_and_known_hosts_pub_variants() {
        // Defensive: these aren't identity keys even though they end
        // in `.pub`. We don't want them to clutter the suggestion
        // list.
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("authorized_keys.pub"), b"...").unwrap();
        fs::write(dir.path().join("known_hosts.pub"), b"...").unwrap();
        fs::write(dir.path().join("ssh_known_hosts.pub"), b"...").unwrap();
        fs::write(dir.path().join("id_ed25519"), b"priv").unwrap();
        fs::write(dir.path().join("id_ed25519.pub"), b"pub").unwrap();
        let names: Vec<_> = list_ssh_identities_in(dir.path())
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(names, vec!["id_ed25519"]);
    }

    #[test]
    fn list_ignores_non_pub_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("config"), b"# ssh config").unwrap();
        fs::write(dir.path().join("known_hosts"), b"...").unwrap();
        fs::write(dir.path().join("id_rsa"), b"priv").unwrap();
        // No .pub file → no identity.
        let identities = list_ssh_identities_in(dir.path());
        assert!(identities.is_empty(), "{identities:?}");
    }

    // ── classify_ssh_add_outcome ──────────────────────────────────

    #[test]
    fn classify_exit_0_with_one_key_per_line_counts_them() {
        let outcome = SshAddOutcome {
            status_code: Some(0),
            stdout: "256 SHA256:abc /Users/d/.ssh/a (ED25519)\n\
                     256 SHA256:def /Users/d/.ssh/b (ED25519)\n"
                .into(),
        };
        let status = classify_ssh_add_outcome("/tmp/agent.sock", outcome);
        assert_eq!(
            status,
            SshAgentStatus::Available {
                socket_path: "/tmp/agent.sock".into(),
                keys_loaded: 2,
            }
        );
    }

    #[test]
    fn classify_exit_1_reports_zero_keys_but_still_available() {
        // ssh-add exits 1 with "The agent has no identities." when
        // the agent is running but empty. That's still a healthy
        // agent — the chip should be green with "0 keys".
        let outcome = SshAddOutcome {
            status_code: Some(1),
            stdout: "The agent has no identities.\n".into(),
        };
        let status = classify_ssh_add_outcome("/tmp/agent.sock", outcome);
        assert_eq!(
            status,
            SshAgentStatus::Available {
                socket_path: "/tmp/agent.sock".into(),
                keys_loaded: 0,
            }
        );
    }

    #[test]
    fn classify_exit_2_marks_stale_with_legible_reason() {
        let outcome = SshAddOutcome {
            status_code: Some(2),
            stdout: String::new(),
        };
        let status = classify_ssh_add_outcome("/tmp/agent.sock", outcome);
        match status {
            SshAgentStatus::Stale {
                socket_path,
                reason,
            } => {
                assert_eq!(socket_path, "/tmp/agent.sock");
                assert!(reason.contains("status 2"), "{reason}");
            }
            other => panic!("expected Stale, got {other:?}"),
        }
    }

    #[test]
    fn classify_spawn_failure_marks_stale_with_timeout_hint() {
        // status_code = None mirrors "couldn't even spawn" / timeout.
        let outcome = SshAddOutcome {
            status_code: None,
            stdout: String::new(),
        };
        let status = classify_ssh_add_outcome("/tmp/agent.sock", outcome);
        match status {
            SshAgentStatus::Stale { reason, .. } => {
                assert!(reason.contains("did not return"), "{reason}");
            }
            other => panic!("expected Stale, got {other:?}"),
        }
    }

    // ── ssh_agent_status_with: env gating + plumbing ──────────────

    struct ScriptedRunner {
        outcome: SshAddOutcome,
    }

    impl SshAddRunner for ScriptedRunner {
        fn list_keys(&self, _: &str) -> SshAddOutcome {
            SshAddOutcome {
                status_code: self.outcome.status_code,
                stdout: self.outcome.stdout.clone(),
            }
        }
    }

    #[test]
    fn agent_status_returns_not_configured_when_env_unset() {
        // SAFETY: serial across tests via the env mutex below.
        let _guard = ENV_LOCK.lock().unwrap();
        let prior = std::env::var("SSH_AUTH_SOCK").ok();
        // SAFETY: Tests run single-threaded under cargo test --test
        // for env mutations.
        unsafe {
            std::env::remove_var("SSH_AUTH_SOCK");
        }
        let runner = ScriptedRunner {
            outcome: SshAddOutcome {
                status_code: Some(0),
                stdout: "should-not-be-read".into(),
            },
        };
        let status = ssh_agent_status_with(&runner);
        unsafe {
            if let Some(v) = prior {
                std::env::set_var("SSH_AUTH_SOCK", v);
            }
        }
        assert_eq!(status, SshAgentStatus::NotConfigured);
    }

    #[test]
    fn agent_status_routes_to_runner_when_env_set() {
        let _guard = ENV_LOCK.lock().unwrap();
        let prior = std::env::var("SSH_AUTH_SOCK").ok();
        unsafe {
            std::env::set_var("SSH_AUTH_SOCK", "/tmp/probe.sock");
        }
        let runner = ScriptedRunner {
            outcome: SshAddOutcome {
                status_code: Some(0),
                stdout: "256 SHA256:abc id (ED25519)\n".into(),
            },
        };
        let status = ssh_agent_status_with(&runner);
        unsafe {
            match prior {
                Some(v) => std::env::set_var("SSH_AUTH_SOCK", v),
                None => std::env::remove_var("SSH_AUTH_SOCK"),
            }
        }
        assert_eq!(
            status,
            SshAgentStatus::Available {
                socket_path: "/tmp/probe.sock".into(),
                keys_loaded: 1,
            }
        );
    }

    use std::sync::Mutex;
    // Serialise env-mutating tests so they don't race each other.
    static ENV_LOCK: Mutex<()> = Mutex::new(());
}
