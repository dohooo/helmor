//! Bundled `llama-server` lifecycle: spawn / health-check / stop /
//! orphan reaping. Public `Manager` is what the rest of the crate
//! holds (registered as Tauri state in `lib.rs`); everything else here
//! is private plumbing.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::Result;
use serde_json::json;

use super::{
    context::resolve_context_for_path,
    server,
    settings::{load_settings, normalize_model, Endpoint, Status},
    API_MODEL, GPU_LAYERS, LOG_TAG, REASONING_MODE, WARMUP_TIMEOUT,
};

#[derive(Default)]
pub struct Manager {
    /// Serializes `ensure_started` / `stop` so two concurrent starts
    /// can't both spawn a child. Held across the entire spawn +
    /// health-check window. `status()` must NOT take this lock — the UI
    /// polls `status` while a slow cold-load is in flight.
    start_lock: Mutex<()>,
    server: Mutex<Option<server::ServerInstance>>,
    starting: Mutex<bool>,
    /// Arc-wrapped so warmup + healthcheck background threads can write
    /// failures back from outside the Manager (CUDA hang post-spawn,
    /// alias mismatch surfacing only on first request, etc).
    last_error: Arc<Mutex<Option<String>>>,
}

impl Manager {
    pub fn status(&self) -> Status {
        let settings = load_settings();
        let runtime_path = server::resolve_llama_server_path().ok();
        let mut server = self.server.lock().unwrap_or_else(|p| p.into_inner());
        let running = if let Some(running) = server.as_mut() {
            if server::child_is_running(&mut running.child) {
                true
            } else {
                *server = None;
                false
            }
        } else {
            false
        };
        let endpoint = server
            .as_ref()
            .filter(|_| running)
            .map(|server| format!("http://127.0.0.1:{}", server.port));
        let starting = *self.starting.lock().unwrap_or_else(|p| p.into_inner());
        Status {
            enabled: settings.enabled,
            runtime_found: runtime_path.is_some(),
            runtime_path: runtime_path.map(|path| path.display().to_string()),
            starting,
            running,
            model: normalize_model(&settings.model),
            api_model: API_MODEL.to_string(),
            context_size: resolve_context_for_path(&normalize_model(&settings.model)),
            gpu_layers: GPU_LAYERS.parse().unwrap_or(99),
            reasoning_mode: REASONING_MODE.to_string(),
            endpoint,
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        }
    }

    pub fn start(&self) -> Result<Status> {
        let settings = load_settings();
        self.ensure_started(&normalize_model(&settings.model))?;
        Ok(self.status())
    }

    pub fn stop(&self) {
        let _guard = self.start_lock.lock().unwrap_or_else(|p| p.into_inner());
        self.kill_server();
        // Clear last_error so a restart doesn't flash a stale banner.
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// Connection params for the running server — `None` while stopped
    /// / starting / crashed. Voice Pilot calls this to POST chat
    /// completions directly.
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.with_live_server(|s| Endpoint {
            url: format!("http://127.0.0.1:{}", s.port),
            token: s.token.clone(),
            api_model: API_MODEL.to_string(),
        })
    }

    /// Active model's runtime `-c` value (token count). `0` when no
    /// model is selected, so callers can branch instead of dividing by
    /// zero.
    pub fn current_context_tokens(&self) -> u32 {
        let settings = load_settings();
        let model_path = normalize_model(&settings.model);
        if model_path.is_empty() {
            return 0;
        }
        resolve_context_for_path(&model_path)
    }

    /// Internal helper for `chat.rs` — fishes out endpoint + token in a
    /// single lock window.
    pub(super) fn current_endpoint_and_token(&self) -> Option<(String, String)> {
        self.with_live_server(|s| (format!("http://127.0.0.1:{}", s.port), s.token.clone()))
    }

    /// Lock the server slot, reap it if the child has died, then run `f`
    /// on the live instance. Centralizes the "crashed → None" invariant
    /// so every reader sees the same view as `status()` (which already
    /// inlines this same check).
    fn with_live_server<R>(&self, f: impl FnOnce(&server::ServerInstance) -> R) -> Option<R> {
        let mut server = self.server.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(running) = server.as_mut() {
            if server::child_is_running(&mut running.child) {
                return Some(f(running));
            }
            *server = None;
        }
        None
    }

    /// Drop the current server, letting `ServerInstance::drop` kill the
    /// child and remove the pid file. Caller is responsible for
    /// serializing — `stop()` holds `start_lock`.
    fn kill_server(&self) {
        let mut server = self.server.lock().unwrap_or_else(|p| p.into_inner());
        let _ = server.take();
    }

    fn ensure_started(&self, model: &str) -> Result<()> {
        let _start_guard = self.start_lock.lock().unwrap_or_else(|p| p.into_inner());
        {
            let mut server = self.server.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(running) = server.as_mut() {
                if running.model_path == model && server::child_is_running(&mut running.child) {
                    return Ok(());
                }
                // Stale (different model or dead) — drop reaps it.
                let _ = server.take();
            }
        }

        let _starting = StartingFlag::new(&self.starting);
        let instance = spawn_llm_server(model).inspect_err(|error| {
            *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(format!("{error:#}"));
        })?;
        let endpoint = format!("http://127.0.0.1:{}", instance.port);
        let token = instance.token.clone();
        *self.server.lock().unwrap_or_else(|p| p.into_inner()) = Some(instance);
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // Fire-and-forget warmup so the first real request hits a hot
        // model. Cold load can take 5–10s on first run. Failures here
        // (alias mismatch, post-spawn OOM, CUDA init failure) write
        // back to `last_error` so the UI surfaces a real reason
        // instead of a green "Running" pill that never replies.
        spawn_warmup(
            endpoint.clone(),
            token.clone(),
            Arc::clone(&self.last_error),
        );
        // Continuous healthcheck: catches post-warmup hangs (CUDA
        // driver wedge, swap thrash) that `child_is_running` can't
        // see. Exits when the server dies or the model changes.
        spawn_healthcheck(endpoint, token, Arc::clone(&self.last_error));
        Ok(())
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        // App is exiting — no concurrent starts. ServerInstance::drop
        // kills the child + removes the pid file.
        self.kill_server();
    }
}

struct StartingFlag<'a> {
    starting: &'a Mutex<bool>,
}

impl<'a> StartingFlag<'a> {
    fn new(starting: &'a Mutex<bool>) -> Self {
        *starting.lock().unwrap_or_else(|p| p.into_inner()) = true;
        Self { starting }
    }
}

impl Drop for StartingFlag<'_> {
    fn drop(&mut self) {
        *self.starting.lock().unwrap_or_else(|p| p.into_inner()) = false;
    }
}

/// Reap an orphan llama-server left by a prior Helmor process.
pub fn sweep_orphan_server() {
    let Ok(data_dir) = crate::data_dir::data_dir() else {
        return;
    };
    server::sweep_orphan_pid(&data_dir.join("local-llm").join("server.pid"), LOG_TAG);
}

fn spawn_warmup(endpoint: String, token: String, last_error: Arc<Mutex<Option<String>>>) {
    std::thread::Builder::new()
        .name("local-llm-warmup".to_string())
        .spawn(move || {
            let started = Instant::now();
            let client = match reqwest::blocking::Client::builder()
                .timeout(WARMUP_TIMEOUT)
                .build()
            {
                Ok(c) => c,
                Err(error) => {
                    let msg = format!("Local LLM warmup client build failed: {error}");
                    tracing::warn!(error = %error, "Local LLM warmup: build client failed");
                    *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
                    return;
                }
            };
            match client
                .post(format!("{endpoint}/v1/chat/completions"))
                .bearer_auth(token)
                .json(&json!({
                    "model": API_MODEL,
                    "messages": [
                        { "role": "user", "content": "ping" }
                    ],
                    "temperature": 0.0,
                    "max_tokens": 1
                }))
                .send()
            {
                Ok(response) if response.status().is_success() => {
                    tracing::info!(
                        duration_ms = started.elapsed().as_millis() as u64,
                        "Local LLM warmup completed"
                    );
                }
                Ok(response) => {
                    let status = response.status();
                    let body_preview = response
                        .text()
                        .ok()
                        .map(|b| crate::local_llm::text::truncate_middle(&b, 240))
                        .unwrap_or_default();
                    let msg = if body_preview.is_empty() {
                        format!("Local LLM warmup returned HTTP {status}")
                    } else {
                        format!("Local LLM warmup returned HTTP {status} — {body_preview}")
                    };
                    tracing::warn!(%status, body = %body_preview, "Local LLM warmup non-2xx");
                    *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
                }
                Err(error) => {
                    let msg = format!("Local LLM warmup failed: {error}");
                    tracing::warn!(error = %error, "Local LLM warmup failed");
                    *last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(msg);
                }
            }
        })
        .ok();
}

const HEALTHCHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);
const HEALTHCHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Background poll of `/v1/models` so a server that's "alive" at the
/// process level but wedged at the model level (CUDA hang, swap
/// thrash) flips `last_error` instead of showing a permanent green
/// "Running" pill. Exits when the endpoint stops answering at all —
/// the next `start()` spawns a fresh watcher.
fn spawn_healthcheck(endpoint: String, token: String, last_error: Arc<Mutex<Option<String>>>) {
    std::thread::Builder::new()
        .name("local-llm-healthcheck".to_string())
        .spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .timeout(HEALTHCHECK_TIMEOUT)
                .build()
            {
                Ok(c) => c,
                Err(error) => {
                    tracing::warn!(error = %error, "Local LLM healthcheck client build failed");
                    return;
                }
            };
            // Two-strikes: a single hiccup (rate-limit blip, brief GC
            // pause) shouldn't repaint the pill. Two failures in a row
            // are real.
            let mut consecutive_failures = 0u32;
            loop {
                std::thread::sleep(HEALTHCHECK_INTERVAL);
                let outcome = client
                    .get(format!("{endpoint}/v1/models"))
                    .bearer_auth(&token)
                    .send();
                match outcome {
                    Ok(response) if response.status().is_success() => {
                        if consecutive_failures > 0 {
                            tracing::info!("Local LLM healthcheck recovered");
                        }
                        consecutive_failures = 0;
                        // Don't clobber a still-relevant warmup error.
                        let mut guard = last_error.lock().unwrap_or_else(|p| p.into_inner());
                        if guard
                            .as_deref()
                            .is_some_and(|e| e.starts_with("Local LLM unresponsive"))
                        {
                            *guard = None;
                        }
                    }
                    Ok(response) => {
                        consecutive_failures += 1;
                        if consecutive_failures >= 2 {
                            let status = response.status();
                            tracing::warn!(%status, "Local LLM healthcheck non-2xx");
                            *last_error.lock().unwrap_or_else(|p| p.into_inner()) =
                                Some(format!("Local LLM unresponsive (HTTP {status})"));
                        }
                    }
                    Err(error) => {
                        consecutive_failures += 1;
                        if consecutive_failures >= 2 {
                            // Connect refused → server is gone; exit
                            // the watcher so we don't loop forever.
                            if error.is_connect() {
                                tracing::info!("Local LLM healthcheck: server gone, exiting");
                                return;
                            }
                            tracing::warn!(error = %error, "Local LLM healthcheck failed");
                            *last_error.lock().unwrap_or_else(|p| p.into_inner()) =
                                Some(format!("Local LLM unresponsive: {error}"));
                        }
                    }
                }
            }
        })
        .ok();
}

/// Build the `llama-server` arg vector for the LLM brain and spawn it
/// through the shared helper. Keeps the LLM-specific flags (alias,
/// reasoning off, log-disable) in one place.
fn spawn_llm_server(model: &str) -> Result<server::ServerInstance> {
    let context_size = resolve_context_for_path(model);
    let mut args = llama_model_args(model)?;
    args.extend([
        "--alias".to_string(),
        API_MODEL.to_string(),
        "-c".to_string(),
        context_size.to_string(),
        "-ngl".to_string(),
        GPU_LAYERS.to_string(),
        "--reasoning".to_string(),
        REASONING_MODE.to_string(),
        "--log-disable".to_string(),
    ]);

    let data_dir = crate::data_dir::data_dir()?.join("local-llm");
    server::spawn(server::SpawnArgs {
        model_path: model.to_string(),
        llama_args: args,
        pid_path: data_dir.join("server.pid"),
        hf_home: data_dir.join("hf"),
        logs_dir: data_dir.join("logs"),
        log_tag: LOG_TAG,
    })
}

/// Resolve `model` to llama-server `--model` args. Local file path only;
/// curated catalog flows through our own download manager so `-hf` would
/// bypass it. Auto-appends `--mmproj` when the matching projector is on
/// disk — for catalog entries that's the per-repo `mmproj_local_name`,
/// for custom paths it's any sibling `mmproj-*.gguf`.
fn llama_model_args(model: &str) -> Result<Vec<String>> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        anyhow::bail!("No model selected. Pick a curated model or set a custom path.");
    }
    let pb = PathBuf::from(trimmed);
    if !pb.is_file() {
        anyhow::bail!(
            "Model file not found: {trimmed}. Pick a curated model in Settings or point Custom model path at a real `.gguf` file."
        );
    }
    let mut args = vec!["--model".to_string(), trimmed.to_string()];
    if let Some(mmproj) = resolve_mmproj_for_model(&pb) {
        tracing::info!(model = trimmed, mmproj = %mmproj.display(), "vision mmproj detected");
        args.push("--mmproj".to_string());
        args.push(mmproj.to_string_lossy().into_owned());
    }
    Ok(args)
}

/// Pick the right mmproj for `model_path`. Catalog matches use the exact
/// per-repo `mmproj_local_name` so a 9B projector never gets paired with
/// 35B-A3B weights (different embedding dims → llama-server crash on
/// load). Custom paths fall back to "any sibling `mmproj-*.gguf`" since
/// the user can pick whatever filename they want.
fn resolve_mmproj_for_model(model_path: &std::path::Path) -> Option<PathBuf> {
    let parent = model_path.parent()?;
    let file_name = model_path.file_name().and_then(|n| n.to_str())?;
    for entry in super::catalog::catalog() {
        if entry.files.iter().any(|f| f == file_name) {
            let mmproj_remote = entry.mmproj_file.as_deref()?;
            let local_name = super::asset_provider::mmproj_local_name(mmproj_remote, &entry.repo);
            let path = parent.join(local_name);
            return path.is_file().then_some(path);
        }
    }
    find_sibling_mmproj(parent)
}

/// Scan a directory for any `mmproj-*.gguf`. Preference order:
/// F16 > BF16 > F32 > anything else.
fn find_sibling_mmproj(parent: &std::path::Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(parent).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|name| {
                name.starts_with("mmproj-") && name.to_lowercase().ends_with(".gguf")
            })
        })
        .collect();
    candidates.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name.contains("f16") && !name.contains("bf16") {
            0
        } else if name.contains("bf16") {
            1
        } else if name.contains("f32") {
            2
        } else {
            3
        }
    });
    candidates.into_iter().next()
}
