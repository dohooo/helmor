//! Shared llama-server process primitives. Owns the bits that are
//! identical across any future on-device model manager: spawning the
//! bundled `llama-server` binary, waiting for it to become healthy,
//! piping its logs through tracing, and reaping orphans across
//! restarts.
//!
//! Manager-specific bits — which alias, which CLI flags, which pid file
//! path — are passed in via `SpawnArgs`.

use std::{
    fs,
    io::{BufRead, BufReader},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context, Result};

/// A running `llama-server` child + its connection params, plus the
/// pid file the manager owns on disk. `Drop` kills the child AND
/// removes the pid file — this is the single invariant that keeps us
/// leak-free across replacement / `Option::take` / panic-unwind / app
/// exit.
#[derive(Debug)]
pub struct ServerInstance {
    pub child: Child,
    pub port: u16,
    pub token: String,
    pub model_path: String,
    pub pid_path: PathBuf,
    pub log_tag: &'static str,
}

impl Drop for ServerInstance {
    fn drop(&mut self) {
        if let Err(error) = self.child.kill() {
            tracing::debug!(tag = self.log_tag, error = %error, "ServerInstance.drop: kill failed (already gone?)");
        }
        let _ = self.child.wait();
        let _ = fs::remove_file(&self.pid_path);
    }
}

/// Everything the caller wants the shared spawn helper to know about.
/// `llama_args` is the full args vector handed to `llama-server`
/// (the manager controls every flag — alias, ngl, jinja, reasoning,
/// etc); this struct deliberately does NOT inject defaults. `hf_home`
/// and `logs_dir` are set up by the caller because the LLM and STT
/// managers share the same cache dir but write to different log paths.
pub struct SpawnArgs {
    pub model_path: String,
    pub llama_args: Vec<String>,
    pub pid_path: PathBuf,
    pub hf_home: PathBuf,
    pub logs_dir: PathBuf,
    pub log_tag: &'static str,
}

/// Bind to an OS-assigned port and immediately drop the listener so
/// llama-server can re-bind it. Used by both managers.
pub fn free_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).context("bind local AI port")?;
    Ok(listener.local_addr()?.port())
}

/// Cheap "is the child still alive" check — `try_wait` returns
/// `Ok(None)` when the child hasn't exited.
pub fn child_is_running(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

/// Resolve the bundled `llama-server` binary, honouring the dev
/// override env var first, then the macOS Resources/ path, then the
/// `sidecar/dist/vendor` path used in `bun run dev`. Single
/// resolution function for the whole crate so the LLM and STT
/// managers can't drift out of sync.
pub fn resolve_llama_server_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("HELMOR_LLAMA_SERVER_BIN_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            let path = contents
                .join("Resources")
                .join("vendor/llama-cpp/llama-server");
            if path.is_file() {
                return Ok(path);
            }
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for path in [
        manifest_dir.join("../sidecar/dist/vendor/llama-cpp/llama-server"),
        manifest_dir.join("../../sidecar/dist/vendor/llama-cpp/llama-server"),
    ] {
        if path.is_file() {
            return Ok(path);
        }
    }

    anyhow::bail!("Bundled llama-server was not found")
}

/// Spawn the bundled `llama-server` with the supplied args and wait
/// for `/v1/models` to return 2xx. On success, writes the pid file
/// and returns a `ServerInstance` whose Drop reaps everything.
pub fn spawn(args: SpawnArgs) -> Result<ServerInstance> {
    let bin = resolve_llama_server_path()?;
    let port = free_port()?;
    let token = format!("helmor-local-{}", uuid::Uuid::new_v4());

    fs::create_dir_all(&args.hf_home).context("create local AI HF cache dir")?;
    fs::create_dir_all(&args.logs_dir).context("create local AI logs dir")?;

    // Inject the host / port / api-key into the caller-supplied flag
    // list. The caller already provided every other flag they want
    // (model path, alias, jinja, ngl, etc).
    let mut full_args = args.llama_args.clone();
    full_args.extend([
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--api-key".to_string(),
        token.clone(),
    ]);

    tracing::info!(
        tag = args.log_tag,
        path = %bin.display(),
        port,
        cache = %args.hf_home.display(),
        "Starting bundled llama-server"
    );

    let mut child = Command::new(&bin)
        .args(&full_args)
        .env("HF_HOME", &args.hf_home)
        .env("LLAMA_CACHE", args.hf_home.join("llama.cpp"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("spawn bundled llama-server at {}", bin.display()))?;

    let pid = child.id();
    let last_stderr = pipe_child_logs(args.log_tag, &mut child);

    if let Err(error) = wait_for_server(port, &token, &mut child, &last_stderr) {
        // Health check failed — kill the child we just spawned so it
        // doesn't linger when we return Err to the caller. Without this
        // an unhealthy server would orphan since `ServerInstance` is
        // never constructed.
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    write_pid_file(&args.pid_path, pid);

    Ok(ServerInstance {
        child,
        port,
        token,
        model_path: args.model_path,
        pid_path: args.pid_path,
        log_tag: args.log_tag,
    })
}

/// Pipe stdout/stderr to the tracing log and ALSO remember the most
/// recent non-empty stderr line in a shared slot, so a startup failure
/// can quote the actual llama-server error message instead of leaving
/// the user with "Timed out". Returns the slot so the health-check
/// loop can read it.
fn pipe_child_logs(tag: &'static str, child: &mut Child) -> Arc<Mutex<Option<String>>> {
    let last_stderr = Arc::new(Mutex::new(None::<String>));
    if let Some(stdout) = child.stdout.take() {
        std::thread::Builder::new()
            .name(format!("{tag}-stdout"))
            .spawn(move || {
                for line in BufReader::new(stdout)
                    .lines()
                    .map_while(std::result::Result::ok)
                {
                    tracing::debug!(tag, "stdout: {line}");
                }
            })
            .ok();
    }
    if let Some(stderr) = child.stderr.take() {
        let last_stderr_clone = last_stderr.clone();
        std::thread::Builder::new()
            .name(format!("{tag}-stderr"))
            .spawn(move || {
                for line in BufReader::new(stderr)
                    .lines()
                    .map_while(std::result::Result::ok)
                {
                    tracing::debug!(tag, "stderr: {line}");
                    if !line.trim().is_empty() {
                        *last_stderr_clone.lock().unwrap_or_else(|p| p.into_inner()) = Some(line);
                    }
                }
            })
            .ok();
    }
    last_stderr
}

fn wait_for_server(
    port: u16,
    token: &str,
    child: &mut Child,
    last_stderr: &Arc<Mutex<Option<String>>>,
) -> Result<()> {
    let endpoint = format!("http://127.0.0.1:{port}/v1/models");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .context("build local AI health client")?;
    // 60s is plenty for cold-load of a single-file model. Multi-part
    // GGUFs mmap'd from disk can take a beat longer the first time;
    // 180s was excessive and left the UI in "Starting" purgatory when
    // the spawn was actually doomed.
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last_error: Option<String> = None;
    while Instant::now() < deadline {
        // Early-exit: if the child has already died (model file missing,
        // bad args, etc.) there's no point polling HTTP for another
        // minute. Quote the last stderr line so the caller has
        // something actionable to show the user.
        match child.try_wait() {
            Ok(Some(status)) => {
                let stderr_tail = last_stderr
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone()
                    .unwrap_or_else(|| "no stderr captured".to_string());
                anyhow::bail!("llama-server exited early (status {status}): {stderr_tail}");
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(error = %error, "try_wait on llama-server failed");
            }
        }
        match client.get(&endpoint).bearer_auth(token).send() {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => last_error = Some(format!("HTTP {}", response.status())),
            Err(error) => last_error = Some(error.to_string()),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    anyhow::bail!(
        "Timed out waiting for local AI server at {endpoint} ({})",
        last_error.unwrap_or_else(|| "no response".to_string())
    )
}

fn write_pid_file(path: &Path, pid: u32) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = fs::write(path, pid.to_string()) {
        tracing::warn!(error = %error, path = %path.display(), "Failed to write pid file");
    }
}

/// Reap an orphan llama-server left behind by a prior Helmor process
/// that was force-quit / crashed / hot-reloaded without running `Drop`.
/// Called from the app setup hook before the auto-start, so we never
/// spawn alongside a stale one. Verifies the pid is still ours by
/// asking `ps` for its command name.
pub fn sweep_orphan_pid(pid_path: &Path, tag: &str) {
    let Ok(contents) = fs::read_to_string(pid_path) else {
        return;
    };
    let Ok(pid) = contents.trim().parse::<i32>() else {
        let _ = fs::remove_file(pid_path);
        return;
    };
    if is_llama_server_pid(pid)
        && Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .is_ok()
    {
        tracing::info!(tag, pid, "Reaped orphan llama-server from previous run");
        // Give it a moment, then SIGKILL if still alive.
        std::thread::sleep(Duration::from_millis(300));
        if is_llama_server_pid(pid) {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
    }
    let _ = fs::remove_file(pid_path);
}

fn is_llama_server_pid(pid: i32) -> bool {
    let Ok(output) = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let cmd = String::from_utf8_lossy(&output.stdout);
    cmd.contains("llama-server")
}
