//! Mobile browser companion.
//!
//! A localhost-bound axum server that mirrors the Tauri IPC surface over
//! HTTP/SSE so the SAME responsive frontend can be served to — and driven
//! from — a phone browser over a public tunnel (Cloudflare). This keeps the
//! desktop and mobile experiences on a single codebase: the frontend's
//! `invoke()` / `Channel` / `listen` primitives are re-pointed at HTTP in
//! `src/lib/ipc.ts` when the page is served by this server.
//!
//! ## Slice 0 scope (this module today)
//! - Server lifecycle (`start` / `shutdown`), bound to `127.0.0.1:0`.
//! - Bearer-token auth (in-memory dev token; the SHA-256 `paired_devices`
//!   table + rotating pairing codes land in a later slice).
//! - `GET /v1/health`, a generic `POST /rpc/{cmd}` dispatcher for pure read
//!   commands, and an SSE keep-alive skeleton at `GET /v1/stream`.
//!
//! Deliberately **not** here yet (later slices): serving the embedded SPA via
//! `AssetResolver`, the public Cloudflare tunnel, agent-stream SSE wiring, and
//! per-device PATs. The whole server is gated behind the `HELMOR_COMPANION`
//! env var so default app behaviour is unchanged.

mod auth;
pub mod registry;
mod rpc;
mod server;
pub mod stable_url;
mod stream;
mod tunnel;

pub use rpc::build_dispatcher;
pub use server::{Dispatcher, StreamStarter};
pub use stream::build_stream_starter;
pub use tunnel::{
    create_named_tunnel, delete_named_tunnel, is_signed_in, sign_in_cloudflare, TunnelState,
};

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use base64::Engine;
use tokio::sync::{oneshot, RwLock};

/// Verifies a bearer token (beyond the dev token). Type-erased so the HTTP
/// layer never touches the database directly.
pub type Verifier = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Production verifier: accept any non-revoked paired-device PAT (and bump its
/// `last_seen_at`).
pub fn paired_device_verifier() -> Verifier {
    Arc::new(|bearer: &str| {
        crate::models::paired_devices::verify_and_touch(bearer).unwrap_or(false)
    })
}

/// Bring the companion fully up: start the loopback server, then a public
/// tunnel — **named** (stable `remote-*.helmor.ai`) when a stable URL has been
/// provisioned, otherwise a **quick** ephemeral tunnel. Idempotent on the
/// server; replaces any running tunnel. Shared by the `companion_enable`
/// command and launch-time auto-start. Concrete `AppHandle` (Wry) because the
/// streaming bridge is Wry-specific; both callers are on the real runtime.
pub async fn start_with_tunnel(
    app: tauri::AppHandle,
    companion: &CompanionState,
    tunnel: &TunnelState,
) -> Result<()> {
    let streamer = build_stream_starter(app.clone());
    let dispatcher = build_dispatcher(app.clone());
    let verifier = paired_device_verifier();
    let info = companion.start(app, streamer, dispatcher, verifier).await?;
    let port = info.addr.port();

    let provisioning = tauri::async_runtime::spawn_blocking(stable_url::load)
        .await
        .map_err(|e| anyhow!("settings task join failed: {e}"))??;

    let tunnel = tunnel.clone();
    tauri::async_runtime::spawn_blocking(move || match provisioning {
        Some(p) => tunnel
            .start_named(port, &p.tunnel_uuid, &p.creds_path, &p.hostname)
            .map(|_| ()),
        None => tunnel.start_quick(port).map(|_| ()),
    })
    .await
    .map_err(|e| anyhow!("tunnel task join failed: {e}"))?
}

/// Public connection details for a running companion server. Returned to the
/// Tauri layer so the dev/settings surface can render a pairing target.
#[derive(Clone, Debug)]
pub struct CompanionInfo {
    pub addr: SocketAddr,
    /// Plaintext dev bearer token. In-memory only; never persisted in Slice 0.
    pub token: String,
}

struct Running {
    addr: SocketAddr,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

/// Tauri-managed state holding the running server (if any).
pub struct CompanionState {
    inner: Arc<RwLock<Option<Running>>>,
}

impl Default for CompanionState {
    fn default() -> Self {
        Self::new()
    }
}

impl CompanionState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(None)),
        }
    }

    /// Start the server if it isn't already running. Idempotent: a second call
    /// returns the existing connection details. Generic over the Tauri runtime
    /// so tests can drive it with a mock app; the `streamer` is built from the
    /// concrete `AppHandle` by the caller (see [`build_agent_streamer`]).
    pub async fn start<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        streamer: StreamStarter,
        dispatcher: Dispatcher,
        verifier: Verifier,
    ) -> Result<CompanionInfo> {
        let mut guard = self.inner.write().await;
        if let Some(running) = guard.as_ref() {
            return Ok(CompanionInfo {
                addr: running.addr,
                token: running.token.clone(),
            });
        }

        let token = generate_token();
        // Capture the asset resolver behind a type-erased closure so the HTTP
        // layer never names a Tauri runtime.
        let asset_app = app.clone();
        let assets: server::AssetLoader = Arc::new(move |path: &str| {
            let resolver = asset_app.asset_resolver();
            resolver
                .get(format!("/{path}"))
                .or_else(|| resolver.get(path.to_string()))
                .map(|asset| (asset.bytes, asset.mime_type))
        });
        let state = server::AppState {
            token: Arc::new(token.clone()),
            assets,
            streamer,
            dispatcher,
            verifier,
        };
        let router = server::router(state);

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;

        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = rx.await;
            });
            if let Err(error) = server.await {
                tracing::error!(error = %error, "companion server exited with error");
            }
        });

        tracing::info!(%addr, "companion server listening on loopback");
        *guard = Some(Running {
            addr,
            token: token.clone(),
            shutdown: Some(tx),
        });
        Ok(CompanionInfo { addr, token })
    }

    /// Current connection details, if the server is running.
    pub async fn info(&self) -> Option<CompanionInfo> {
        self.inner.read().await.as_ref().map(|r| CompanionInfo {
            addr: r.addr,
            token: r.token.clone(),
        })
    }

    /// Signal graceful shutdown. Best-effort; the task also dies with the
    /// process at exit.
    pub async fn shutdown(&self) {
        if let Some(mut running) = self.inner.write().await.take() {
            if let Some(tx) = running.shutdown.take() {
                let _ = tx.send(());
            }
        }
    }
}

/// Generate a 32-byte random bearer token rendered as `hlm_<base64url>`.
fn generate_token() -> String {
    let bytes: [u8; 32] = rand::random();
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!("hlm_{body}")
}
