//! Tauri commands backing the mobile-companion Settings panel.
//!
//! These wire the UI to the companion server (`crate::companion`), the
//! cloudflared tunnel (quick or named/stable), and the `paired_devices` store.
//! Enabling starts a loopback server plus a tunnel; pairing mints a per-device
//! PAT and returns the QR payload the phone scans; the stable-URL commands
//! provision a permanent `remote-*.helmor.ai` hostname.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::companion::{self, stable_url, CompanionState, TunnelState};
use crate::models::paired_devices::{self, PairedDevice};
use crate::ui_sync::{self, UiMutationEvent};

use super::common::{run_blocking, CmdResult};

/// Companion server + tunnel status surfaced to the Settings panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub running: bool,
    /// Loopback address the server is bound to (`127.0.0.1:<port>`).
    pub addr: Option<String>,
    /// Public tunnel URL, when a tunnel is up.
    pub public_url: Option<String>,
    /// `"named"` (stable URL), `"quick"` (ephemeral), or `"none"`.
    pub mode: String,
    /// Provisioned stable hostname, if any — independent of running state.
    pub stable_host: Option<String>,
    /// Whether the user has signed in to Cloudflare (`~/.cloudflared/cert.pem`).
    pub signed_in: bool,
}

/// One-time payload returned when a device is paired. The phone scans `url`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPayload {
    pub device_id: String,
    pub label: String,
    /// Plaintext PAT — shown once, never persisted in plaintext.
    pub pat: String,
    /// Full pairing URL to encode as a QR: `<origin>/#pair=<pat>`.
    pub url: String,
}

async fn build_status(
    companion: &CompanionState,
    tunnel: &TunnelState,
) -> CmdResult<CompanionStatus> {
    let info = companion.info().await;
    let public_url = tunnel.public_url();
    let stable_host = run_blocking(stable_url::load).await?.map(|p| p.hostname);
    let mode = match &public_url {
        Some(url) if url.contains(".trycloudflare.com") => "quick",
        Some(_) => "named",
        None => "none",
    };
    Ok(CompanionStatus {
        running: info.is_some(),
        addr: info.map(|i| i.addr.to_string()),
        public_url,
        mode: mode.to_string(),
        stable_host,
        signed_in: companion::is_signed_in(),
    })
}

/// Current companion status (server + tunnel + stable-URL provisioning).
#[tauri::command]
pub async fn companion_status(
    companion: State<'_, CompanionState>,
    tunnel: State<'_, TunnelState>,
) -> CmdResult<CompanionStatus> {
    build_status(&companion, &tunnel).await
}

/// Start the loopback server + a tunnel (named when a stable URL is
/// provisioned, else quick). All-or-nothing: rolls back on failure.
#[tauri::command]
pub async fn companion_enable(
    app: AppHandle,
    companion: State<'_, CompanionState>,
    tunnel: State<'_, TunnelState>,
) -> CmdResult<CompanionStatus> {
    if let Err(error) = companion::start_with_tunnel(app, &companion, &tunnel).await {
        tunnel.shutdown();
        companion.shutdown().await;
        return Err(error.into());
    }
    build_status(&companion, &tunnel).await
}

/// Stop the tunnel and the companion server (leaves any stable-URL
/// provisioning intact — it auto-starts again on next launch).
#[tauri::command]
pub async fn companion_disable(
    companion: State<'_, CompanionState>,
    tunnel: State<'_, TunnelState>,
) -> CmdResult<()> {
    tunnel.shutdown();
    companion.shutdown().await;
    Ok(())
}

/// Open the Cloudflare sign-in flow (browser). One-time; writes `cert.pem`.
#[tauri::command]
pub async fn companion_sign_in_cloudflare() -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(companion::sign_in_cloudflare)
        .await
        .map_err(|e| anyhow::anyhow!("sign-in task join failed: {e}"))??;
    Ok(())
}

/// Provision a permanent `remote-*.helmor.ai` URL: create a named tunnel,
/// register the hostname, persist it, and bring the named tunnel up now.
#[tauri::command]
pub async fn companion_allocate_stable_url(
    app: AppHandle,
    companion: State<'_, CompanionState>,
    tunnel: State<'_, TunnelState>,
) -> CmdResult<CompanionStatus> {
    if !companion::is_signed_in() {
        return Err(anyhow::anyhow!("sign in to Cloudflare first").into());
    }

    let name = format!("helmor-{}", short_id());
    let (uuid, creds_path) =
        tauri::async_runtime::spawn_blocking(move || companion::create_named_tunnel(&name))
            .await
            .map_err(|e| anyhow::anyhow!("tunnel create task join failed: {e}"))??;

    let registered = companion::registry::register(&uuid).await?;

    let record = stable_url::StableUrl {
        device_id: registered.device_id,
        hostname: registered.hostname,
        secret: registered.secret,
        tunnel_uuid: uuid,
        creds_path,
    };
    run_blocking(move || stable_url::save(&record)).await?;

    // Switch the live tunnel over to the named one immediately.
    tunnel.shutdown();
    if let Err(error) = companion::start_with_tunnel(app, &companion, &tunnel).await {
        tunnel.shutdown();
        companion.shutdown().await;
        return Err(error.into());
    }
    build_status(&companion, &tunnel).await
}

/// Forget the permanent URL: revoke the hostname, delete the tunnel, clear
/// persistence, and tear the companion down (re-enabling falls back to quick).
#[tauri::command]
pub async fn companion_destroy_stable_url(
    companion: State<'_, CompanionState>,
    tunnel: State<'_, TunnelState>,
) -> CmdResult<CompanionStatus> {
    if let Some(record) = run_blocking(stable_url::load).await? {
        // Best-effort external cleanup — local state is cleared regardless.
        let _ = companion::registry::revoke(&record.device_id, &record.secret).await;
        let uuid = record.tunnel_uuid.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || companion::delete_named_tunnel(&uuid))
            .await;
        run_blocking(stable_url::clear).await?;
    }
    tunnel.shutdown();
    companion.shutdown().await;
    build_status(&companion, &tunnel).await
}

/// Mint a per-device PAT and return the QR pairing payload.
#[tauri::command]
pub async fn companion_pair_device(
    app: AppHandle,
    label: String,
    companion: State<'_, CompanionState>,
    tunnel: State<'_, TunnelState>,
) -> CmdResult<PairingPayload> {
    // The phone needs a reachable origin. Prefer the public tunnel URL; fall
    // back to the loopback addr (only useful for same-machine browser testing).
    let origin = match tunnel.public_url() {
        Some(url) => url,
        None => match companion.info().await {
            Some(info) => format!("http://{}", info.addr),
            None => {
                return Err(anyhow::anyhow!("enable the companion before pairing a device").into())
            }
        },
    };

    let label_for_db = label.clone();
    let (device, pat) =
        run_blocking(move || paired_devices::create_paired_device(&label_for_db)).await?;

    ui_sync::publish(&app, UiMutationEvent::PairedDevicesChanged);

    let url = format!("{}/#pair={}", origin.trim_end_matches('/'), pat);
    Ok(PairingPayload {
        device_id: device.id,
        label: device.label,
        pat,
        url,
    })
}

/// List active (non-revoked) paired devices.
#[tauri::command]
pub async fn companion_list_devices() -> CmdResult<Vec<PairedDevice>> {
    run_blocking(paired_devices::list_paired_devices).await
}

/// Revoke a paired device. Its PAT stops authenticating immediately.
#[tauri::command]
pub async fn companion_revoke_device(app: AppHandle, device_id: String) -> CmdResult<()> {
    let id = device_id.clone();
    run_blocking(move || paired_devices::revoke_paired_device(&id)).await?;
    ui_sync::publish(&app, UiMutationEvent::PairedDevicesChanged);
    Ok(())
}

/// Short random suffix for the named-tunnel name (`helmor-<8 hex>`).
fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}
