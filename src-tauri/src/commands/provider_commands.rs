//! Tauri commands for custom providers, parameterized by `family`.

use super::common::{run_blocking, CmdResult};
use crate::provider::{self, CustomProvider, CustomProviderBackend, CustomProviderModel};

fn parse_family(family: &str) -> anyhow::Result<provider::ProviderFamily> {
    provider::ProviderFamily::parse(family)
        .ok_or_else(|| anyhow::anyhow!("unknown provider family: {family}"))
}

fn backend(family: provider::ProviderFamily) -> anyhow::Result<Box<dyn CustomProviderBackend>> {
    provider::backend_for(family)
        .ok_or_else(|| anyhow::anyhow!("custom-provider config not supported for this family"))
}

#[tauri::command]
pub async fn list_custom_providers(family: String) -> CmdResult<Vec<CustomProvider>> {
    let family = parse_family(&family)?;
    run_blocking(move || Ok(backend(family)?.list())).await
}

#[tauri::command]
pub async fn upsert_custom_provider(family: String, provider: CustomProvider) -> CmdResult<()> {
    let family = parse_family(&family)?;
    run_blocking(move || {
        let _guard = provider::lock_writes();
        backend(family)?.upsert(provider)
    })
    .await
}

#[tauri::command]
pub async fn remove_custom_provider(family: String, id: String) -> CmdResult<()> {
    let family = parse_family(&family)?;
    run_blocking(move || {
        let _guard = provider::lock_writes();
        backend(family)?.remove(&id)
    })
    .await
}

#[tauri::command]
pub async fn fetch_provider_models(
    family: String,
    base_url: String,
    api_key: String,
    api_style: Option<String>,
) -> CmdResult<Vec<CustomProviderModel>> {
    let family = parse_family(&family)?;
    Ok(provider::fetch_models(family, &base_url, &api_key, api_style.as_deref()).await?)
}
