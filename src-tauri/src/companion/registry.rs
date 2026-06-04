//! Client for the Helmor companion registry Worker (`apps/registry`).
//!
//! Called exactly twice per stable-URL lifecycle: once to allocate a
//! `remote-<random>.helmor.ai` hostname for this desktop's tunnel, and once to
//! tear it down. The Worker writes the CNAME; Helmor never sees user traffic.

use anyhow::{anyhow, Result};
use serde::Deserialize;

const DEFAULT_API: &str = "https://registry.helmor.ai";

/// Registry base URL. Overridable for self-hosting / local dev.
fn api_base() -> String {
    std::env::var("HELMOR_COMPANION_API_URL").unwrap_or_else(|_| DEFAULT_API.to_string())
}

/// The hostname + revocation secret allocated for a tunnel.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredHost {
    pub device_id: String,
    pub hostname: String,
    pub secret: String,
}

/// Allocate a stable hostname pointing at `<tunnel_uuid>.cfargotunnel.com`.
pub async fn register(tunnel_uuid: &str) -> Result<RegisteredHost> {
    let response = reqwest::Client::new()
        .post(format!("{}/api/devices/register", api_base()))
        .json(&serde_json::json!({ "tunnelUuid": tunnel_uuid }))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("registry register failed: {}", response.status()));
    }
    Ok(response.json().await?)
}

/// Delete a previously allocated hostname. A 404 (already gone) is success.
pub async fn revoke(device_id: &str, secret: &str) -> Result<()> {
    let response = reqwest::Client::new()
        .delete(format!("{}/api/devices/{device_id}", api_base()))
        .bearer_auth(secret)
        .send()
        .await?;
    let status = response.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    Err(anyhow!("registry revoke failed: {status}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{delete, post};
    use axum::{http::StatusCode, Json, Router};

    async fn spawn_stub() -> String {
        let app = Router::new()
            .route(
                "/api/devices/register",
                post(|| async {
                    Json(serde_json::json!({
                        "deviceId": "dev_1",
                        "hostname": "remote-abcd2345.helmor.ai",
                        "secret": "hsec_stub",
                    }))
                }),
            )
            .route(
                "/api/devices/{id}",
                delete(|| async { StatusCode::NO_CONTENT }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn register_then_revoke() {
        let base = spawn_stub().await;
        std::env::set_var("HELMOR_COMPANION_API_URL", &base);

        let host = register("12345678-1234-1234-1234-123456789abc")
            .await
            .expect("register");
        assert_eq!(host.hostname, "remote-abcd2345.helmor.ai");
        assert_eq!(host.device_id, "dev_1");
        assert_eq!(host.secret, "hsec_stub");

        revoke(&host.device_id, &host.secret).await.expect("revoke");

        std::env::remove_var("HELMOR_COMPANION_API_URL");
    }
}
