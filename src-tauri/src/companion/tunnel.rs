//! cloudflared tunnel lifecycle for the mobile companion.
//!
//! Two modes:
//!   - **quick tunnel** (`cloudflared tunnel --url …`): no account, ephemeral
//!     `https://<random>.trycloudflare.com` URL. Default before the user opts
//!     into a stable URL.
//!   - **named tunnel** (`cloudflared tunnel run …`): a permanent
//!     `remote-<random>.helmor.ai` URL backed by the user's Cloudflare account
//!     (see `sign_in_cloudflare` / `create_named_tunnel` + the registry).
//!
//! Process supervision mirrors `sidecar.rs`: children are spawned into their
//! own process group so SIGTERM/SIGKILL reach the whole tree, and `shutdown`
//! walks the SIGTERM → wait → SIGKILL ladder.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};

/// How long to wait for cloudflared to announce it is ready before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for the interactive `tunnel login` to complete.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

struct RunningTunnel {
    child: Child,
    public_url: String,
}

/// Tauri-managed handle to the running cloudflared tunnel (if any). Cloneable —
/// it is just a shared pointer — so commands can hand an owned copy to
/// `spawn_blocking` without borrowing `tauri::State`.
#[derive(Clone)]
pub struct TunnelState {
    inner: Arc<Mutex<Option<RunningTunnel>>>,
}

impl Default for TunnelState {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }

    /// Whether a tunnel process is currently tracked.
    pub fn is_running(&self) -> bool {
        self.lock().is_some()
    }

    /// The current public URL, if a tunnel is up.
    pub fn public_url(&self) -> Option<String> {
        self.lock().as_ref().map(|t| t.public_url.clone())
    }

    /// Start a quick tunnel pointing at `http://127.0.0.1:<port>` and block
    /// until cloudflared announces the public URL. Idempotent: if a tunnel is
    /// already running, returns its URL without spawning another.
    ///
    /// Reads cloudflared's stderr synchronously, so callers on an async runtime
    /// should wrap it in `spawn_blocking`. The lock is **not** held during the
    /// wait, so `status` stays responsive while enabling.
    pub fn start_quick(&self, port: u16) -> Result<String> {
        if let Some(url) = self.public_url() {
            return Ok(url);
        }
        let args = vec![
            "tunnel".to_string(),
            "--no-autoupdate".to_string(),
            "--url".to_string(),
            format!("http://127.0.0.1:{port}"),
        ];
        let (child, url) = spawn_and_await(&args, extract_trycloudflare_url)?;
        tracing::info!(url = %url, "cloudflared quick tunnel established");
        self.store(child, url.clone());
        Ok(url)
    }

    /// Start a named tunnel (stable URL) pointing at `http://127.0.0.1:<port>`
    /// and block until a connection registers. `hostname` is the known
    /// `remote-<random>.helmor.ai`; we return `https://<hostname>`.
    pub fn start_named(
        &self,
        port: u16,
        tunnel_uuid: &str,
        creds_path: &str,
        hostname: &str,
    ) -> Result<String> {
        let desired = format!("https://{hostname}");
        if self.public_url().as_deref() == Some(desired.as_str()) {
            return Ok(desired);
        }
        let args = vec![
            "tunnel".to_string(),
            "--no-autoupdate".to_string(),
            "run".to_string(),
            "--cred-file".to_string(),
            creds_path.to_string(),
            "--url".to_string(),
            format!("http://127.0.0.1:{port}"),
            tunnel_uuid.to_string(),
        ];
        // cloudflared logs "Registered tunnel connection" once a connection is
        // live — that's our readiness signal (the URL is already known).
        let (child, _) = spawn_and_await(&args, |line| {
            line.contains("Registered tunnel connection")
                .then(String::new)
        })?;
        tracing::info!(url = %desired, "cloudflared named tunnel established");
        self.store(child, desired.clone());
        Ok(desired)
    }

    /// Stop the tunnel (SIGTERM → wait → SIGKILL). No-op when nothing is running.
    pub fn shutdown(&self) {
        if let Some(mut running) = self.lock().take() {
            kill_process_group(&mut running.child);
        }
    }

    fn store(&self, child: Child, public_url: String) {
        let mut guard = self.lock();
        if let Some(running) = guard.as_mut() {
            // Lost a race / replacing: kill the previous child first.
            kill_process_group(&mut running.child);
        }
        *guard = Some(RunningTunnel { child, public_url });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<RunningTunnel>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------
// One-shot cloudflared commands (account sign-in + named-tunnel provisioning)
// ---------------------------------------------------------------------------

/// Whether the user has signed in to Cloudflare (`~/.cloudflared/cert.pem`).
pub fn is_signed_in() -> bool {
    cloudflared_home()
        .map(|home| home.join("cert.pem").is_file())
        .unwrap_or(false)
}

/// Run the interactive `cloudflared tunnel login` (opens a browser; the user
/// picks a zone and authorizes). Blocks until it completes or times out.
pub fn sign_in_cloudflare() -> Result<()> {
    let status = run_oneshot_interactive(&["tunnel".into(), "login".into()], LOGIN_TIMEOUT)?;
    if !status {
        bail!("cloudflared sign-in did not complete");
    }
    if !is_signed_in() {
        bail!("cloudflared sign-in finished but no certificate was written");
    }
    Ok(())
}

/// Create a named tunnel and return `(uuid, creds_path)`. Requires a prior
/// sign-in. The credentials file is cloudflared's default
/// `~/.cloudflared/<uuid>.json`.
pub fn create_named_tunnel(name: &str) -> Result<(String, String)> {
    let bin = resolve_cloudflared();
    let output = Command::new(&bin)
        .args(["tunnel", "create", name])
        .output()
        .with_context(|| format!("failed to run cloudflared ({})", bin.display()))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        bail!("cloudflared tunnel create failed: {}", combined.trim());
    }
    let uuid = parse_tunnel_uuid(&combined)
        .ok_or_else(|| anyhow!("could not parse tunnel id from cloudflared output"))?;
    let creds_path = cloudflared_home()
        .ok_or_else(|| anyhow!("could not resolve ~/.cloudflared"))?
        .join(format!("{uuid}.json"))
        .to_string_lossy()
        .into_owned();
    Ok((uuid, creds_path))
}

/// Delete a named tunnel. Best-effort: a missing tunnel is treated as success.
pub fn delete_named_tunnel(tunnel_uuid: &str) -> Result<()> {
    let bin = resolve_cloudflared();
    let _ = Command::new(&bin)
        .args(["tunnel", "delete", tunnel_uuid])
        .output();
    Ok(())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Spawn cloudflared with `args`, draining stderr on a background thread.
/// `extract` is applied to each stderr line; the first `Some(_)` it returns is
/// the readiness payload (e.g. the public URL). Returns the live child once
/// ready, or errors on early exit / timeout.
fn spawn_and_await(
    args: &[String],
    extract: impl Fn(&str) -> Option<String> + Send + 'static,
) -> Result<(Child, String)> {
    let bin = resolve_cloudflared();
    let mut command = Command::new(&bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // Own process tree so later termination reaches child processes.
    crate::platform::process::configure_tree_root(&mut command);

    let mut child = command.spawn().with_context(|| {
        format!(
            "failed to spawn cloudflared ({}) — is it installed?",
            bin.display()
        )
    })?;
    let stderr = child
        .stderr
        .take()
        .context("failed to capture cloudflared stderr")?;

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::Builder::new()
        .name("cloudflared-stderr".into())
        .spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            let mut announced = false;
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let trimmed = line.trim_end();
                        tracing::debug!(target: "cloudflared", "{trimmed}");
                        if !announced {
                            if let Some(payload) = extract(trimmed) {
                                announced = tx.send(payload).is_ok();
                            }
                        }
                    }
                }
            }
        })
        .context("failed to spawn cloudflared reader thread")?;

    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(payload) => return Ok((child, payload)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(anyhow!("cloudflared exited before it was ready ({status})"));
                }
                if Instant::now() >= deadline {
                    kill_process_group(&mut child);
                    return Err(anyhow!("timed out waiting for cloudflared to be ready"));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.try_wait();
                kill_process_group(&mut child);
                return Err(anyhow!("cloudflared closed stderr before it was ready"));
            }
        }
    }
}

/// Run a one-shot cloudflared command to completion (stdio inherited so the
/// browser-open / prompts work), bounded by `timeout`. Returns whether it
/// exited successfully.
fn run_oneshot_interactive(args: &[String], timeout: Duration) -> Result<bool> {
    let bin = resolve_cloudflared();
    let mut command = Command::new(&bin);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    crate::platform::process::configure_tree_root(&mut command);
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to spawn cloudflared ({})", bin.display()))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => {}
            Err(e) => return Err(anyhow!("failed to wait on cloudflared: {e}")),
        }
        if Instant::now() >= deadline {
            kill_process_group(&mut child);
            return Err(anyhow!("cloudflared command timed out"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// `~/.cloudflared`.
fn cloudflared_home() -> Option<PathBuf> {
    crate::platform::paths::home_dir().map(|home| home.join(".cloudflared"))
}

/// Resolve the cloudflared binary: env override → bundled vendor copy → PATH.
fn resolve_cloudflared() -> PathBuf {
    if let Ok(path) = std::env::var("HELMOR_CLOUDFLARED_PATH") {
        let pb = PathBuf::from(path);
        if pb.is_file() {
            return pb;
        }
    }
    // Release builds stage cloudflared next to the other vendored CLIs under
    // `…/Contents/Resources/vendor/cloudflared/`.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|p| p.parent()) {
            let bundled = contents.join("Resources/vendor/cloudflared/cloudflared");
            if bundled.is_file() {
                return bundled;
            }
        }
    }
    PathBuf::from("cloudflared")
}

/// Pull the `https://<sub>.trycloudflare.com` URL out of a cloudflared log line.
fn extract_trycloudflare_url(line: &str) -> Option<String> {
    const MARKER: &str = ".trycloudflare.com";
    let start = line.find("https://")?;
    let rest = &line[start..];
    let marker = rest.find(MARKER)?;
    let url = &rest[..marker + MARKER.len()];
    // Reject anything with embedded whitespace (mis-parse) or an empty subdomain.
    if url.chars().any(char::is_whitespace) || url == "https://.trycloudflare.com" {
        return None;
    }
    Some(url.to_string())
}

/// Pull the tunnel UUID out of `Created tunnel <name> with id <uuid>`.
fn parse_tunnel_uuid(text: &str) -> Option<String> {
    const MARKER: &str = "with id ";
    let idx = text.find(MARKER)? + MARKER.len();
    let uuid: String = text[idx..]
        .chars()
        .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
        .collect();
    (uuid.len() >= 32).then_some(uuid)
}

/// SIGTERM the child's process group, wait briefly, then SIGKILL. Mirrors the
/// sidecar teardown ladder.
fn kill_process_group(child: &mut Child) {
    let tree = crate::platform::process::ProcessTree::from_child_pid(child.id());
    crate::platform::process::terminate_tree(tree);
    let deadline = Instant::now() + Duration::from_millis(2000);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    crate::platform::process::kill_tree(tree);
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::{extract_trycloudflare_url, parse_tunnel_uuid};

    #[test]
    fn extracts_url_from_banner_line() {
        let line = "2024-01-01T00:00:00Z INF |  https://blue-green-cat-42.trycloudflare.com  |";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://blue-green-cat-42.trycloudflare.com")
        );
    }

    #[test]
    fn extracts_bare_url() {
        let line = "https://foo-bar.trycloudflare.com";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://foo-bar.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert_eq!(extract_trycloudflare_url("INF Starting tunnel"), None);
        assert_eq!(
            extract_trycloudflare_url("visit https://dash.cloudflare.com to manage"),
            None
        );
    }

    #[test]
    fn rejects_empty_subdomain() {
        assert_eq!(
            extract_trycloudflare_url("https://.trycloudflare.com"),
            None
        );
    }

    #[test]
    fn parses_tunnel_uuid_from_create_output() {
        let out = "Tunnel credentials written to /Users/x/.cloudflared/2f9a…json\n\
                   Created tunnel helmor-abc with id 2f9a1b2c-3d4e-5f60-7081-92a3b4c5d6e7";
        assert_eq!(
            parse_tunnel_uuid(out).as_deref(),
            Some("2f9a1b2c-3d4e-5f60-7081-92a3b4c5d6e7")
        );
    }

    #[test]
    fn rejects_output_without_uuid() {
        assert_eq!(parse_tunnel_uuid("nothing useful here"), None);
    }
}
