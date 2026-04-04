//! Manages the Bun sidecar process for Claude Agent SDK communication.
//!
//! The sidecar is a long-running Node.js/Bun process that wraps the
//! Claude Agent SDK. Communication happens via stdin/stdout JSON Lines.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SidecarRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Deserialize)]
pub struct SidecarEvent {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(flatten)]
    pub extra: Value,
}

// ---------------------------------------------------------------------------
// Sidecar process
// ---------------------------------------------------------------------------

pub struct SidecarProcess {
    child: Child,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
    stdout_reader: Arc<Mutex<BufReader<std::process::ChildStdout>>>,
}

impl SidecarProcess {
    /// Start the sidecar process and wait for the "ready" signal.
    pub fn start() -> Result<Self> {
        let sidecar_script = resolve_sidecar_path()?;

        let runtime = if which_exists("bun") {
            "bun"
        } else {
            "node"
        };

        let mut child = Command::new(runtime)
            .arg("run")
            .arg(&sidecar_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // debug logs go to terminal
            .spawn()
            .with_context(|| format!("Failed to start sidecar with {runtime}"))?;

        let stdin = child.stdin.take().context("Failed to capture sidecar stdin")?;
        let stdout = child.stdout.take().context("Failed to capture sidecar stdout")?;
        let mut reader = BufReader::new(stdout);

        // Wait for "ready" signal
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .context("Failed to read sidecar ready signal")?;

        let ready: Value =
            serde_json::from_str(line.trim()).context("Invalid sidecar ready signal")?;
        if ready.get("type").and_then(Value::as_str) != Some("ready") {
            bail!("Unexpected sidecar startup message: {line}");
        }

        eprintln!("[sidecar] Started (pid={})", child.id());

        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            stdout_reader: Arc::new(Mutex::new(reader)),
        })
    }

    /// Send a request to the sidecar.
    pub fn send(&self, request: &SidecarRequest) -> Result<()> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| anyhow::anyhow!("Sidecar stdin lock poisoned"))?;

        let json = serde_json::to_string(request).context("Failed to serialize request")?;
        writeln!(stdin, "{json}").context("Failed to write to sidecar stdin")?;
        stdin.flush().context("Failed to flush sidecar stdin")?;

        Ok(())
    }

    /// Read the next event from the sidecar (blocking).
    pub fn read_event(&self) -> Result<Option<SidecarEvent>> {
        let mut reader = self
            .stdout_reader
            .lock()
            .map_err(|_| anyhow::anyhow!("Sidecar stdout lock poisoned"))?;

        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .context("Failed to read from sidecar")?;

        if bytes == 0 {
            return Ok(None); // EOF — sidecar exited
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }

        let event: SidecarEvent =
            serde_json::from_str(trimmed).with_context(|| format!("Invalid sidecar event: {trimmed}"))?;

        Ok(Some(event))
    }

    /// Check if the sidecar is still alive.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Kill the sidecar process.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

// ---------------------------------------------------------------------------
// Managed sidecar with auto-restart
// ---------------------------------------------------------------------------

pub struct ManagedSidecar {
    process: Mutex<Option<SidecarProcess>>,
}

impl Default for ManagedSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl ManagedSidecar {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    /// Ensure sidecar is running and send a request.
    pub fn send(&self, request: &SidecarRequest) -> Result<()> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| anyhow::anyhow!("Sidecar lock poisoned"))?;

        // Start or restart if needed
        let needs_restart = match guard.as_mut() {
            None => true,
            Some(p) => !p.is_alive(),
        };

        if needs_restart {
            if let Some(mut old) = guard.take() {
                old.kill();
            }
            *guard = Some(SidecarProcess::start()?);
        }

        guard.as_ref().unwrap().send(request)
    }

    /// Read the next event (blocking). Caller should do this in a loop on a background thread.
    pub fn read_event(&self) -> Result<Option<SidecarEvent>> {
        let guard = self
            .process
            .lock()
            .map_err(|_| anyhow::anyhow!("Sidecar lock poisoned"))?;

        match guard.as_ref() {
            Some(p) => p.read_event(),
            None => bail!("Sidecar not started"),
        }
    }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

fn resolve_sidecar_path() -> Result<PathBuf> {
    // 1. Environment variable override
    if let Ok(path) = std::env::var("HELMOR_SIDECAR_PATH") {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 2. Development: sidecar/src/index.ts (for `bun run`)
    let dev_path = std::env::current_dir()
        .unwrap_or_default()
        .join("sidecar/src/index.ts");
    if dev_path.is_file() {
        return Ok(dev_path);
    }

    // 3. Built: sidecar/dist/sidecar.js
    let dist_path = std::env::current_dir()
        .unwrap_or_default()
        .join("sidecar/dist/sidecar.js");
    if dist_path.is_file() {
        return Ok(dist_path);
    }

    bail!("Sidecar script not found. Set HELMOR_SIDECAR_PATH or build with `cd sidecar && bun run build`.")
}

fn which_exists(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
