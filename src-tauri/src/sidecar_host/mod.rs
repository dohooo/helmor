//! Reverse IPC — sidecar `hostRequest` on stdout, Rust `hostResponse` on stdin.

pub mod handlers;
pub mod protocol;

use anyhow::Result;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

pub use protocol::{HostRequest, HostResponse};

pub async fn dispatch<R: Runtime>(app: AppHandle<R>, method: &str, params: Value) -> Result<Value> {
    handlers::route(app, method, params).await
}

/// Install the sidecar reverse-IPC dispatcher and spawn the worker thread that
/// turns each `hostRequest` envelope into a `hostResponse` written back over
/// the sidecar's stdin. Shared verbatim by the desktop `setup()` hook and the
/// headless `helmor serve` host. Called once per process; later calls to
/// `install_host_dispatcher` are no-ops.
pub fn spawn_host_dispatcher<R: Runtime>(app: AppHandle<R>) {
    let host_rx = app
        .state::<crate::sidecar::ManagedSidecar>()
        .install_host_dispatcher();
    std::thread::Builder::new()
        .name("sidecar-host-dispatcher".into())
        .spawn(move || {
            while let Ok(env) = host_rx.recv() {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    let response = match dispatch(app_clone.clone(), &env.method, env.params).await
                    {
                        Ok(value) => HostResponse::success(env.callback_id.clone(), value),
                        Err(error) => {
                            HostResponse::failure(env.callback_id.clone(), format!("{error:#}"))
                        }
                    };
                    let sidecar_state = app_clone.state::<crate::sidecar::ManagedSidecar>();
                    if let Err(error) = sidecar_state.send_host_response(&response) {
                        tracing::warn!(
                            error = %format!("{error:#}"),
                            method = %env.method,
                            "hostResponse write failed"
                        );
                    }
                });
            }
            tracing::debug!("host dispatcher channel closed");
        })
        .ok();
}

pub fn unknown_method(method: &str) -> anyhow::Error {
    anyhow::anyhow!("unknown host method: {method}")
}
