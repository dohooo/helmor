//! The runtime-abstraction seam for the remote-workspace feature.
//!
//! `RemoteRuntime` is the trait every command path that *might*
//! eventually run on a remote machine routes through. Two impls
//! cohabit:
//!
//! - [`LocalRuntime`] — wraps the current direct-call codebase.
//!   This is the production default and the only path with full
//!   behaviour today.
//! - `RemoteRuntime` (future, phase 3+) — dispatches over the
//!   JSON-RPC client to a `helmor-server` running on another
//!   host.
//!
//! This phase only lands the trait, the local impl, and **one**
//! method (`runtime_health`) so the seam is real and exercised.
//! Migrating actual workspace / git / script ops onto it is the
//! work of the following phases — each one moves a small set of
//! methods over, with the local impl always staying a thin wrapper
//! around the existing module functions.
//!
//! ## Why a trait instead of an enum
//!
//! An `enum { Local(...), Remote(...) }` would force every site that
//! takes a runtime to match on both variants. The dispatch pattern
//! we want is "look up the runtime for this workspace and call a
//! method on it" — that's a trait object's job. The `&dyn`
//! indirection adds a vtable lookup per call, but the per-method
//! work is always either a function call (local) or a JSON-RPC
//! round-trip (remote), so the overhead is in the noise either way.

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::methods::{WorkspaceBranchInfoResult, WorkspaceStatusResult};

/// Snapshot returned by [`RemoteRuntime::runtime_health`]. Carries
/// just enough for the UI to render a "connected to X" indicator
/// without forcing the caller to deserialize a richer envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub kind: RuntimeKind,
    /// Friendly hostname. Always set, even for the local runtime
    /// (so a header chip can read it unconditionally).
    pub hostname: String,
    /// Helmor build version of the runtime. For local that's the
    /// running app; for remote that's whatever `helmor-server`
    /// binary the operator installed there.
    pub version: String,
}

/// Discriminates the local-vs-remote nature of a runtime. Kept as a
/// separate enum (rather than `Option<String>`-style hostnaming) so
/// new variants can carry distinct metadata without breaking serde.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum RuntimeKind {
    /// The host process is doing the work itself — no RPC client
    /// in the loop.
    Local,
    /// Workspace state lives on `host`; calls translate into JSON-RPC
    /// requests over an SSH-tunneled stdio pipe.
    Remote { host: String },
}

/// Every command path that might eventually have a non-local
/// counterpart routes through this trait. Today it only exposes
/// `runtime_health`; subsequent phases add the workspace / git /
/// script / sidecar / terminal methods.
///
/// Implementations must be `Send + Sync` because the Tauri command
/// layer keeps a single trait object behind `tauri::State` and
/// reaches it from arbitrary blocking-pool threads.
pub trait RemoteRuntime: Send + Sync {
    /// Cheap, side-effect-free probe. Implementations should respond
    /// without acquiring DB locks or touching the network, so the
    /// frontend can poll it on a focus tick without worrying about
    /// latency budget.
    fn runtime_health(&self) -> Result<RuntimeHealth>;

    /// Project the workspace's `git status --porcelain` output into
    /// a wire-friendly shape. First *real* method on the seam: the
    /// local impl shells out to `git`; the future remote impl
    /// translates it into a `workspace.status` JSON-RPC request.
    ///
    /// `workspace_dir` is interpreted on the runtime's *own*
    /// filesystem. The local impl reads it directly; the remote
    /// impl will pass it verbatim and expect the server to resolve
    /// it under its own root.
    fn workspace_status(&self, workspace_dir: &Path) -> Result<WorkspaceStatusResult>;

    /// Read-only "where am I?" projection — current branch, head
    /// commit, and upstream tracking ref. The local impl shells out
    /// to a couple of `git` invocations; the remote impl translates
    /// it into a `workspace.branchInfo` JSON-RPC request.
    ///
    /// `workspace_dir` interpretation matches [`workspace_status`]:
    /// the runtime's own filesystem.
    fn workspace_branch_info(&self, workspace_dir: &Path) -> Result<WorkspaceBranchInfoResult>;

    /// Liveness probe. Distinct from [`runtime_health`] — that method
    /// returns a *cached* snapshot for cheap UI rendering, whereas
    /// `ping` actually round-trips through the transport so a dead
    /// pipe (SSH dropped, server crashed) surfaces as `Err`. Used by
    /// the registry's background poller to drive the connection-state
    /// chip.
    ///
    /// The local impl returns `Ok(())` unconditionally — the
    /// in-process runtime can't be "disconnected".
    fn ping(&self) -> Result<()>;
}

/// The default runtime — does the work in-process. Every existing
/// command path can be migrated onto this without changing behaviour
/// because each method just calls the same free function the
/// command used to call directly.
pub struct LocalRuntime {
    /// Captured once at construction so the hot path doesn't shell
    /// out to `uname -n` per request.
    hostname: String,
    /// Captured from `CARGO_PKG_VERSION` so the binary version and
    /// the runtime version are guaranteed to agree without a cross-
    /// crate include.
    version: &'static str,
}

impl LocalRuntime {
    /// Read the hostname once and stash it. Failures fall back to
    /// `"localhost"` rather than propagating — `runtime_health` is
    /// supposed to be fail-safe.
    pub fn new() -> Self {
        Self::with_hostname(read_local_hostname())
    }

    /// Construct with a caller-supplied hostname. Useful for tests
    /// where shelling out to `uname` is overkill / non-deterministic.
    pub fn with_hostname(hostname: String) -> Self {
        Self {
            hostname,
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}

impl Default for LocalRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteRuntime for LocalRuntime {
    fn runtime_health(&self) -> Result<RuntimeHealth> {
        Ok(RuntimeHealth {
            kind: RuntimeKind::Local,
            hostname: self.hostname.clone(),
            version: self.version.to_string(),
        })
    }

    fn ping(&self) -> Result<()> {
        // In-process runtime is always alive by construction. Liveness
        // probes against `local` are effectively no-ops; the registry's
        // poller skips them entirely, but the method still has to exist
        // for trait-object dispatch.
        Ok(())
    }

    fn workspace_status(&self, workspace_dir: &Path) -> Result<WorkspaceStatusResult> {
        let workspace_str = workspace_dir.display().to_string();
        // `run_git_capture` returns stdout verbatim. We can't use the
        // standard `run_git` here because it trims the result, and
        // porcelain v1 *encodes the staging state in the leading
        // space* — a stripped leading byte means `line[3..]` slices
        // off the first byte of the path on unstaged modifications.
        let output = crate::git_ops::run_git_capture(
            [
                "-C",
                workspace_str.as_str(),
                "status",
                "--porcelain",
                "--untracked-files=normal",
            ],
            None,
        )
        .with_context(|| format!("Failed to read workspace status for {workspace_str}"))?;
        Ok(parse_porcelain_status(&output))
    }

    fn workspace_branch_info(&self, workspace_dir: &Path) -> Result<WorkspaceBranchInfoResult> {
        // `current_branch_name` errors on a fresh repo with no
        // commits / detached HEAD in some cases — for branch-info
        // we want a sensible empty-string fallback rather than
        // a hard failure, so the UI can still render "(detached)"
        // alongside a real HEAD commit.
        let current_branch = crate::git_ops::current_branch_name(workspace_dir).unwrap_or_default();
        let head_commit = crate::git_ops::current_workspace_head_commit(workspace_dir)
            .with_context(|| {
                format!("Failed to read HEAD commit for {}", workspace_dir.display())
            })?;
        let upstream_ref = crate::git_ops::current_upstream_ref_name(workspace_dir);
        Ok(WorkspaceBranchInfoResult {
            current_branch,
            head_commit,
            upstream_ref,
        })
    }
}

/// Turn `git status --porcelain` output into the wire-shaped
/// projection. Kept here (not in `git/ops.rs`) so the parsing
/// rules live next to the trait method that emits the result —
/// future schema changes touch one place.
fn parse_porcelain_status(output: &str) -> WorkspaceStatusResult {
    use std::collections::BTreeSet;
    // Porcelain v1 format: `XY<space>path` where X is staged status,
    // Y is unstaged status. Paths beyond column 3. Renames produce
    // `R  old -> new` — we keep the trailing portion as the canonical
    // path (matches what git/ops.rs's parse does today).
    let paths: BTreeSet<String> = output
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let path = line[3..].trim();
            if path.is_empty() {
                return None;
            }
            Some(path.to_string())
        })
        .collect();
    let is_clean = paths.is_empty();
    WorkspaceStatusResult {
        is_clean,
        changed_paths: paths.into_iter().collect(),
    }
}

/// Process-lifetime singleton for the local runtime. Tauri command
/// handlers reach this when they want the "this machine" runtime
/// without juggling a per-call construction.
pub fn local_runtime() -> &'static (dyn RemoteRuntime + 'static) {
    static INSTANCE: OnceLock<LocalRuntime> = OnceLock::new();
    INSTANCE.get_or_init(LocalRuntime::new)
}

/// Best-effort local hostname read. Mirrors the resolver the
/// `helmor-server` binary uses so a local <-> remote pair report
/// hostnames the same way. Failure → `"localhost"`.
fn read_local_hostname() -> String {
    if let Ok(host) = std::env::var("HOSTNAME") {
        if !host.is_empty() {
            return host;
        }
    }
    match std::process::Command::new("uname").arg("-n").output() {
        Ok(output) if output.status.success() => {
            let raw = String::from_utf8_lossy(&output.stdout);
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                "localhost".to_string()
            } else {
                trimmed.to_string()
            }
        }
        _ => "localhost".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for the future SSH-backed impl. Lets us prove the
    /// trait is object-safe and the dispatch surface compiles for
    /// non-local impls *now*, before the SSH transport lands.
    struct FakeRemoteRuntime {
        host: String,
        version: String,
    }

    impl RemoteRuntime for FakeRemoteRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            Ok(RuntimeHealth {
                kind: RuntimeKind::Remote {
                    host: self.host.clone(),
                },
                hostname: self.host.clone(),
                version: self.version.clone(),
            })
        }

        fn workspace_status(&self, _workspace_dir: &Path) -> Result<WorkspaceStatusResult> {
            // The fake exists only to prove dispatch — return a stub
            // that's distinguishable from a real local-runtime result.
            Ok(WorkspaceStatusResult {
                is_clean: true,
                changed_paths: vec![],
            })
        }
        fn workspace_branch_info(&self, _: &Path) -> Result<WorkspaceBranchInfoResult> {
            Ok(WorkspaceBranchInfoResult {
                current_branch: format!("fake-branch-on-{}", self.host),
                head_commit: "fake-sha".into(),
                upstream_ref: None,
            })
        }
        fn ping(&self) -> Result<()> {
            Ok(())
        }
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
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
        let dir = tempfile::tempdir().unwrap();
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

    // ── LocalRuntime ─────────────────────────────────────────────

    #[test]
    fn local_runtime_health_reports_local_kind_and_captured_hostname() {
        let runtime = LocalRuntime::with_hostname("test-host".into());
        let health = runtime.runtime_health().unwrap();
        assert_eq!(health.kind, RuntimeKind::Local);
        assert_eq!(health.hostname, "test-host");
        // The build version flows from CARGO_PKG_VERSION; just
        // assert it's non-empty so a future Cargo bump doesn't
        // pin the assertion to a moving target.
        assert!(!health.version.is_empty());
    }

    #[test]
    fn local_runtime_default_constructor_works() {
        let runtime = LocalRuntime::default();
        let health = runtime.runtime_health().unwrap();
        assert_eq!(health.kind, RuntimeKind::Local);
        // We don't assert the literal hostname — the test runner
        // hostname is environment-dependent. We just assert that
        // *some* non-empty hostname comes back (the fallback case
        // returns "localhost").
        assert!(!health.hostname.is_empty());
    }

    #[test]
    fn local_runtime_singleton_is_stable_across_calls() {
        let first = local_runtime();
        let second = local_runtime();
        // The trait-object pointers from `OnceLock` should be the
        // same instance — singleton, not per-call reinit.
        assert!(std::ptr::eq(
            first as *const _ as *const (),
            second as *const _ as *const (),
        ));
    }

    // ── trait object safety ──────────────────────────────────────

    #[test]
    fn trait_is_object_safe_and_swappable_between_impls() {
        // Vec of trait objects exercises both `Send + Sync` bounds
        // and the dyn-dispatch slot. If a future method added to
        // the trait broke object safety, this stops compiling.
        let runtimes: Vec<Box<dyn RemoteRuntime>> = vec![
            Box::new(LocalRuntime::with_hostname("local-1".into())),
            Box::new(FakeRemoteRuntime {
                host: "remote-1".into(),
                version: "0.22.1".into(),
            }),
        ];
        let kinds: Vec<RuntimeKind> = runtimes
            .iter()
            .map(|r| r.runtime_health().unwrap().kind)
            .collect();
        assert_eq!(kinds[0], RuntimeKind::Local);
        assert_eq!(
            kinds[1],
            RuntimeKind::Remote {
                host: "remote-1".into(),
            }
        );
    }

    // ── RuntimeKind wire format ──────────────────────────────────

    #[test]
    fn runtime_kind_serializes_with_camel_case_type_tag() {
        // The frontend will branch on `kind.type === "local" | "remote"`
        // for the connection-status chip. Lock the wire format down
        // now so a stray rename doesn't silently make the chip dead
        // until someone notices.
        let local = serde_json::to_value(RuntimeKind::Local).unwrap();
        assert_eq!(local["type"], "local");

        let remote = serde_json::to_value(RuntimeKind::Remote {
            host: "ec2-1.example.com".into(),
        })
        .unwrap();
        assert_eq!(remote["type"], "remote");
        assert_eq!(remote["host"], "ec2-1.example.com");
    }

    #[test]
    fn runtime_health_round_trips_through_serde() {
        let original = RuntimeHealth {
            kind: RuntimeKind::Remote {
                host: "dev.box".into(),
            },
            hostname: "dev.box".into(),
            version: "0.22.1".into(),
        };
        let wire = serde_json::to_string(&original).unwrap();
        let restored: RuntimeHealth = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored, original);
    }

    // ── LocalRuntime::workspace_status ───────────────────────────

    #[test]
    fn local_runtime_workspace_status_reports_clean_repo() {
        let dir = init_repo();
        let runtime = LocalRuntime::with_hostname("test-host".into());

        let status = runtime.workspace_status(dir.path()).unwrap();

        assert!(status.is_clean, "fresh init_repo should be clean");
        assert!(status.changed_paths.is_empty());
    }

    #[test]
    fn local_runtime_workspace_status_surfaces_modified_and_untracked_paths() {
        let dir = init_repo();
        std::fs::write(dir.path().join("file.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        let runtime = LocalRuntime::with_hostname("test-host".into());

        let status = runtime.workspace_status(dir.path()).unwrap();

        assert!(!status.is_clean);
        // Sorted + deduped, both files surfaced regardless of staging
        // state. `untracked-files=normal` means `new.txt` shows up.
        assert_eq!(
            status.changed_paths,
            vec!["file.txt".to_string(), "new.txt".to_string()],
        );
    }

    #[test]
    fn local_runtime_workspace_branch_info_reports_current_branch_and_head() {
        let dir = init_repo();
        let runtime = LocalRuntime::with_hostname("test-host".into());

        let info = runtime.workspace_branch_info(dir.path()).unwrap();

        assert_eq!(info.current_branch, "main");
        // Fresh init_repo has one commit; SHA-1 hash is 40 hex chars.
        assert_eq!(
            info.head_commit.len(),
            40,
            "expected a full 40-char SHA-1 hash, got `{}`",
            info.head_commit
        );
        // No remote / upstream configured on the fresh repo.
        assert!(
            info.upstream_ref.is_none(),
            "fresh repo has no upstream tracking ref: {:?}",
            info.upstream_ref
        );
    }

    // ── porcelain parser ─────────────────────────────────────────

    #[test]
    fn parse_porcelain_status_handles_typical_status_codes() {
        // Mix of modified, untracked, deleted. The parser strips the
        // 3-char status prefix and sorts the result.
        let raw = " M src/foo.rs\n?? new.txt\n D removed.rs\n";
        let parsed = parse_porcelain_status(raw);
        assert!(!parsed.is_clean);
        assert_eq!(
            parsed.changed_paths,
            vec![
                "new.txt".to_string(),
                "removed.rs".to_string(),
                "src/foo.rs".to_string(),
            ]
        );
    }

    #[test]
    fn parse_porcelain_status_treats_empty_output_as_clean() {
        let parsed = parse_porcelain_status("");
        assert!(parsed.is_clean);
        assert!(parsed.changed_paths.is_empty());
    }
}
