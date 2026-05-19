//! Sidecar process spawning abstraction. The trait separates the
//! production path (spawn a real `helmor-sidecar` binary) from tests
//! (drive a canned event stream via [`super::mock::MockAgentSpawner`]).
//!
//! Resolved via `HELMOR_SIDECAR_PATH` on the daemon side — see
//! `bin/helmor-server.rs` for the wiring.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use anyhow::{anyhow, Context, Result};

/// Spawn the sidecar process and return its stdio pipes. Production
/// uses [`BinaryAgentSpawner`] against `HELMOR_SIDECAR_PATH`; tests
/// use `super::mock::MockAgentSpawner` to drive a canned event stream
/// without a real binary.
///
/// `Send + Sync` so the spawner can be stashed in `Arc<dyn
/// AgentSpawner>` and shared across threads.
pub trait AgentSpawner: Send + Sync {
    fn spawn(&self) -> Result<SidecarPipe>;
}

/// Stdio bundle returned by [`AgentSpawner::spawn`]. The reader/writer
/// pair is what the bridge owns; `child` is `Some(_)` for real
/// subprocess spawns (so dropping the bridge kills + reaps the
/// sidecar) and `None` for in-memory test pipes.
pub struct SidecarPipe {
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn BufRead + Send>,
    pub child: Option<Child>,
    pub label: String,
}

impl std::fmt::Debug for SidecarPipe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SidecarPipe")
            .field("label", &self.label)
            .field("has_child", &self.child.is_some())
            .finish_non_exhaustive()
    }
}

/// Resolves the sidecar binary via the `HELMOR_SIDECAR_PATH` env var
/// only. Bundling on the remote side is in phase 23e; until then the
/// operator places `helmor-sidecar` somewhere on disk and points the
/// env var at it. Returns a wrapped error explaining the env-var
/// requirement when the path isn't set or doesn't exist — that's the
/// most common operator misconfiguration and the message needs to be
/// legible from a connection-failure toast.
pub struct BinaryAgentSpawner {
    binary_path: PathBuf,
}

impl BinaryAgentSpawner {
    pub fn new(binary_path: PathBuf) -> Self {
        Self { binary_path }
    }

    /// Resolve the sidecar binary from environment + filesystem.
    /// Returns `None` if the env var isn't set; the caller's
    /// "agent.send not configured" error is built from that.
    pub fn resolve_from_env() -> Option<PathBuf> {
        let raw = std::env::var("HELMOR_SIDECAR_PATH")
            .ok()
            .filter(|s| !s.is_empty())?;
        let path = PathBuf::from(raw);
        path.is_file().then_some(path)
    }
}

impl AgentSpawner for BinaryAgentSpawner {
    fn spawn(&self) -> Result<SidecarPipe> {
        let mut cmd = Command::new(&self.binary_path);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Inherit so operator-facing tracing from the sidecar
            // shows up alongside the daemon's own logs. Future
            // slices can capture this into a tracing channel.
            .stderr(Stdio::inherit());
        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawn sidecar at {}", self.binary_path.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("sidecar provided no stdin pipe"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sidecar provided no stdout pipe"))?;
        let label = self.binary_path.display().to_string();
        Ok(SidecarPipe {
            stdin: Box::new(stdin),
            stdout: Box::new(BufReader::new(stdout)),
            child: Some(child),
            label,
        })
    }
}
