//! Bundled `llama-server` lifecycle: spawn / health-check / stop /
//! orphan reaping. Public `Manager` is what the rest of the crate
//! holds (registered as Tauri state in `lib.rs`); everything else here
//! is private plumbing.

use std::{path::PathBuf, sync::Mutex, time::Instant};

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
    last_error: Mutex<Option<String>>,
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
        // model. Cold load can take 5–10s on first run.
        spawn_warmup(endpoint, token);
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

fn spawn_warmup(endpoint: String, token: String) {
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
                    tracing::warn!(error = %error, "Local LLM warmup: build client failed");
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
                    tracing::warn!(
                        status = %response.status(),
                        "Local LLM warmup returned non-2xx"
                    );
                }
                Err(error) => {
                    tracing::warn!(error = %error, "Local LLM warmup failed");
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
/// bypass it. Auto-appends `--mmproj` when a sibling `mmproj-*.gguf` is
/// present so vision-capable models boot with their projector loaded.
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
    if let Some(mmproj) = find_sibling_mmproj(&pb) {
        tracing::info!(model = trimmed, mmproj = %mmproj.display(), "vision mmproj detected");
        args.push("--mmproj".to_string());
        args.push(mmproj.to_string_lossy().into_owned());
    }
    Ok(args)
}

/// Scan the model file's parent dir for any `mmproj-*.gguf`. Preference
/// order: F16 > BF16 > F32 > anything else, picking the first match so
/// catalog downloads (which ship F16) light up vision automatically while
/// custom-path users can drop whichever precision they have.
fn find_sibling_mmproj(model_path: &std::path::Path) -> Option<PathBuf> {
    let parent = model_path.parent()?;
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
