use anyhow::Context as _;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::{
    commands::common::{run_blocking, CmdResult},
    data_dir, downloads, local_llm,
};

#[tauri::command]
pub async fn get_local_llm_status(
    manager: State<'_, local_llm::Manager>,
) -> CmdResult<local_llm::Status> {
    Ok(manager.status())
}

/// Read-only curated catalog of supported GGUF models.
#[tauri::command]
pub async fn list_local_llm_catalog() -> CmdResult<Vec<local_llm::CatalogEntry>> {
    Ok(local_llm::catalog::catalog())
}

/// Inspect an arbitrary `.gguf` file on disk and return its trained
/// context window + estimated fp16 KV cache cost per token. The settings
/// panel calls this for the user's Custom model path so the context
/// slider can render real limits.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInspection {
    pub architecture: String,
    pub name: Option<String>,
    pub context_length: u32,
    pub kv_bytes_per_token: u32,
    /// Pre-computed default with the current hardware tier, ready to
    /// drop straight into the slider as the "Reset" target.
    pub default_context_tokens: u32,
}

#[tauri::command]
pub async fn inspect_local_llm_model(path: String) -> CmdResult<ModelInspection> {
    run_blocking(move || {
        // Users routinely paste paths with stray whitespace (drag-drop on
        // some terminals, copy from a quoted log line, …). Trim once
        // here so every downstream check (extension sniff, exists, magic)
        // sees the canonical form.
        let trimmed = path.trim();
        if trimmed.is_empty() {
            anyhow::bail!("Model path is empty");
        }
        build_inspection(std::path::Path::new(trimmed))
    })
    .await
}

/// Same inspection as `inspect_local_llm_model`, but keyed by catalog
/// entry id — the panel uses this to read real GGUF metadata for an
/// already-downloaded catalog model. Returns `None` when the file isn't
/// downloaded yet (so the panel falls back to the catalog estimate).
/// A parse error still bubbles up so the user sees the actual reason.
#[tauri::command]
pub async fn inspect_local_llm_catalog_entry(
    entry_id: String,
) -> CmdResult<Option<ModelInspection>> {
    run_blocking(move || {
        let entry = local_llm::catalog::catalog()
            .into_iter()
            .find(|e| e.id == entry_id)
            .with_context(|| format!("unknown catalog entry id: {entry_id}"))?;
        let first_file = entry.files.first().context("catalog entry has no files")?;
        let path = data_dir::local_llm_models_dir()?.join(first_file);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(build_inspection(&path)?))
    })
    .await
}

fn build_inspection(path: &std::path::Path) -> anyhow::Result<ModelInspection> {
    let meta = local_llm::gguf::read_metadata(path)?;
    let hw = local_llm::hardware::detect();
    let default_context_tokens =
        local_llm::compute_default_context_for_meta(&meta, hw.total_ram_gb);
    Ok(ModelInspection {
        architecture: meta.architecture.clone(),
        name: meta.name.clone(),
        context_length: meta.context_length,
        kv_bytes_per_token: meta.kv_bytes_per_token(),
        default_context_tokens,
    })
}

/// Local-machine snapshot — CPU brand, total RAM, OS version, arch,
/// and the catalog entry id we'd recommend for this RAM tier.
#[tauri::command]
pub async fn detect_local_llm_hardware() -> CmdResult<local_llm::HardwareSnapshot> {
    Ok(local_llm::hardware::detect())
}

/// Subscribe to per-entry download status events and return the
/// initial snapshot in one round-trip.
#[tauri::command]
pub async fn subscribe_local_llm_downloads(
    manager: State<'_, downloads::DownloadsManager>,
    on_event: Channel<downloads::AssetEvent>,
) -> CmdResult<Vec<downloads::AssetStatus>> {
    Ok(manager.subscribe(on_event))
}

/// Read-only snapshot — used to bootstrap a panel that already has a
/// subscription, or just to debug from devtools.
#[tauri::command]
pub async fn list_local_llm_downloads(
    manager: State<'_, downloads::DownloadsManager>,
) -> CmdResult<Vec<downloads::AssetStatus>> {
    Ok(manager.snapshot())
}

/// Start (or resume) downloading the asset for `entry_id`. Idempotent.
#[tauri::command]
pub async fn start_local_llm_download(app: AppHandle, entry_id: String) -> CmdResult<()> {
    let manager = app.state::<downloads::DownloadsManager>();
    manager.start(app.clone(), &entry_id)?;
    Ok(())
}

/// Stop an in-flight download but keep the `.part` on disk so it can
/// be resumed later. No-op if the worker isn't running.
#[tauri::command]
pub async fn pause_local_llm_download(
    manager: State<'_, downloads::DownloadsManager>,
    entry_id: String,
) -> CmdResult<()> {
    manager.pause(&entry_id);
    Ok(())
}

/// Stop an in-flight download AND wipe the `.part` + final files from
/// disk. Used by both the panel's Cancel and Delete affordances.
#[tauri::command]
pub async fn cancel_local_llm_download(
    manager: State<'_, downloads::DownloadsManager>,
    entry_id: String,
) -> CmdResult<()> {
    manager.cancel_and_delete(&entry_id)?;
    Ok(())
}

/// Persist a per-model `-c` (runtime context tokens) override. The
/// value is clamped to `[4096, entry.model_max_context_tokens]` and
/// removed if it equals the catalog default. Restarts the server when
/// it's running so the new context allocation takes effect.
#[tauri::command]
pub async fn set_local_llm_context_override(
    app: AppHandle,
    entry_id: String,
    context_tokens: u32,
) -> CmdResult<local_llm::Status> {
    run_blocking(move || {
        local_llm::set_context_override(&entry_id, context_tokens)?;
        let manager = app.state::<local_llm::Manager>();
        let prior = manager.status();
        if prior.running || prior.starting {
            // Fire-and-forget restart on a blocking thread. `ensure_started`
            // short-circuits when the same model is live, so stop first —
            // otherwise the new `-c` would never reach llama-server.
            let app_clone = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let manager = app_clone.state::<local_llm::Manager>();
                manager.stop();
                if let Err(error) = manager.start() {
                    tracing::warn!(
                        error = ?error,
                        "auto-restart after context override failed"
                    );
                }
            });
        }
        Ok(manager.status())
    })
    .await
}

/// Switch the bundled llama-server over to the GGUF managed by the
/// given catalog entry. File must already be downloaded. Fires a
/// (re)start when Local LLM is enabled so the new model loads right
/// away; the UI's polled status query surfaces Starting → Running.
#[tauri::command]
pub async fn activate_local_llm_model(
    app: AppHandle,
    entry_id: String,
) -> CmdResult<local_llm::Status> {
    run_blocking(move || {
        let entry = local_llm::catalog::catalog()
            .into_iter()
            .find(|e| e.id == entry_id)
            .with_context(|| format!("unknown catalog entry id: {entry_id}"))?;
        let first_file = entry.files.first().context("catalog entry has no files")?;
        let path = data_dir::local_llm_models_dir()?.join(first_file);
        if !path.exists() {
            anyhow::bail!("model file not yet downloaded: {}", path.display());
        }
        local_llm::set_active_model_path(path.display().to_string())?;

        let manager = app.state::<local_llm::Manager>();
        if local_llm::load_settings().enabled {
            let app_clone = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let manager = app_clone.state::<local_llm::Manager>();
                if let Err(error) = manager.start() {
                    tracing::warn!(
                        error = ?error,
                        "auto-start after activate_local_llm_model failed"
                    );
                }
            });
        }
        Ok(manager.status())
    })
    .await
}

#[tauri::command]
pub async fn start_local_llm(app: AppHandle) -> CmdResult<local_llm::Status> {
    run_blocking(move || {
        let manager = app.state::<local_llm::Manager>();
        manager.start()
    })
    .await
}

#[tauri::command]
pub async fn stop_local_llm(app: AppHandle) -> CmdResult<()> {
    run_blocking(move || {
        let manager = app.state::<local_llm::Manager>();
        manager.stop();
        Ok(())
    })
    .await
}

/// Connection params for the running server (URL + bearer token + alias).
/// `None` while stopped / starting / crashed. Voice Pilot reads this to
/// POST chat completions directly into the user's configured brain.
#[tauri::command]
pub async fn get_local_llm_endpoint(
    manager: State<'_, local_llm::Manager>,
) -> CmdResult<Option<local_llm::Endpoint>> {
    Ok(manager.endpoint())
}
