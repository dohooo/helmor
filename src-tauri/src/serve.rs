//! Headless `helmor serve` host wiring.
//!
//! `serve` runs the same companion server the desktop exposes, but as a
//! windowless Wry app inside a container (see the S1 spike). This module owns
//! the serve-specific `setup` step: the "functional trio" — the sidecar
//! reverse dispatcher, the UI-sync socket listener, and the git watcher — plus
//! the companion server bound to `0.0.0.0:$PORT` with a capability token
//! injected via the environment. No tunnel, no desktop background workers.

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use tauri::Manager;

use crate::{companion, git_watcher, sidecar_host, ui_sync};

/// Environment variable carrying the bearer / capability token serve accepts.
const TOKEN_ENV: &str = "HELMOR_COMPANION_TOKEN";
/// Environment variable overriding the listen port.
const PORT_ENV: &str = "HELMOR_SERVE_PORT";
/// Default listen port when `HELMOR_SERVE_PORT` is unset.
const DEFAULT_PORT: u16 = 8080;

/// Listen port from `HELMOR_SERVE_PORT`, falling back to [`DEFAULT_PORT`].
pub fn port_from_env() -> u16 {
    std::env::var(PORT_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

/// Capability token from `HELMOR_COMPANION_TOKEN`. Required: serve refuses to
/// start without it so a container can never expose an unauthenticated surface.
fn token_from_env() -> Result<String> {
    let token = std::env::var(TOKEN_ENV)
        .unwrap_or_default()
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(anyhow!(
            "{TOKEN_ENV} must be set (serve refuses to expose an unauthenticated surface)"
        ));
    }
    Ok(token)
}

/// Wire the headless serve host: functional trio + companion server. Called
/// from the serve-mode `setup` hook (which has already run `init_core`).
pub fn setup(app: &tauri::App) -> Result<()> {
    let handle = app.handle().clone();

    // 1. Sidecar reverse-IPC dispatcher (agent turns issue hostRequests).
    sidecar_host::spawn_host_dispatcher(handle.clone());

    // 2. UI-sync socket listener so same-container CLI invocations (the PR6
    //    boot orchestration: clone / repo add / workspace new) can push
    //    cache-invalidation events into this running serve process.
    if let Err(error) = ui_sync::start_listener(handle.clone()) {
        tracing::error!(error = %error, "serve: failed to start UI sync listener");
    }

    // 3. Git watcher so the inspector "changes" view updates live as the
    //    agent edits files in the workspace.
    {
        let watcher_handle = handle.clone();
        std::thread::Builder::new()
            .name("git-watcher-init".into())
            .spawn(move || {
                let manager = watcher_handle.state::<git_watcher::GitWatcherManager>();
                if let Err(error) = manager.sync_from_db(watcher_handle.clone()) {
                    tracing::error!(
                        error = %format!("{error:#}"),
                        "serve: git watcher init failed"
                    );
                }
            })
            .ok();
    }

    // 4. Companion server bound to 0.0.0.0:$PORT with the env capability token.
    //    No tunnel — the CF Worker / reverse proxy fronts it.
    let token = token_from_env()?;
    let port = port_from_env();
    let companion_handle = handle.clone();
    tauri::async_runtime::block_on(async move {
        let streamer = companion::build_stream_starter(companion_handle.clone());
        let dispatcher = companion::build_dispatcher(companion_handle.clone());
        // Phase 0 accepts only the injected capability token; per-device PATs
        // (paired_devices) land in Phase 1, so the verifier rejects everything
        // else.
        let verifier: companion::Verifier = Arc::new(|_| false);
        let state = companion_handle.state::<companion::CompanionState>();
        state
            .start_serve(
                companion_handle.clone(),
                "0.0.0.0",
                port,
                token,
                streamer,
                dispatcher,
                verifier,
            )
            .await
    })
    .context("serve: companion server failed to start")?;

    tracing::info!(port, "helmor serve: companion listening on 0.0.0.0");
    Ok(())
}
