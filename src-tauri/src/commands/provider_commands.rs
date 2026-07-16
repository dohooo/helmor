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

// ── Keychain store terminal ────────────────────────────────────────────────
// In-app terminal that runs `security add-generic-password … -U -w` so the
// user types the Vertex gateway token straight into macOS Keychain — the
// token never passes through Helmor. Mirrors the agent-login terminal
// plumbing (same ScriptProcessManager, per-instance script type).

const KEYCHAIN_REPO_ID: &str = "__helmor_keychain__";

fn keychain_script_type(instance_id: &str) -> String {
    format!("keychain-store:{instance_id}")
}

fn keychain_key(instance_id: &str) -> (String, String, Option<String>) {
    (
        KEYCHAIN_REPO_ID.to_string(),
        keychain_script_type(instance_id),
        None,
    )
}

#[tauri::command]
pub async fn spawn_keychain_store_terminal(
    manager: tauri::State<'_, crate::workspace::scripts::ScriptProcessManager>,
    service: String,
    account: String,
    instance_id: String,
    channel: tauri::ipc::Channel<crate::workspace::scripts::ScriptEvent>,
) -> CmdResult<()> {
    use crate::workspace::scripts::{ScriptContext, ScriptEvent};

    // `-U` updates an existing item in place; `-w` prompts for the secret
    // interactively so it never lands in shell history or process args.
    let command = format!(
        "security add-generic-password -s {} -a {} -U -w",
        crate::platform::shell::quote_posix_arg(service.trim()),
        crate::platform::shell::quote_posix_arg(account.trim()),
    );
    let working_dir = crate::platform::paths::home_dir_or_current_or_root()
        .display()
        .to_string();
    let context = ScriptContext {
        root_path: working_dir.clone(),
        workspace_path: None,
        workspace_name: None,
        default_branch: None,
        port_base: None,
        port_count: None,
    };
    let mgr = manager.inner().clone();

    tauri::async_runtime::spawn_blocking(move || {
        let boot_input = crate::platform::shell::boot_input(&command);
        if let Err(error) = crate::workspace::scripts::run_terminal_session(
            &mgr,
            KEYCHAIN_REPO_ID,
            &keychain_script_type(&instance_id),
            None,
            &working_dir,
            &context,
            channel.clone(),
            Some(&boot_input),
            None,
        ) {
            tracing::warn!(
                error = %format!("{error:#}"),
                "spawn_keychain_store_terminal: run_terminal_session failed"
            );
            let _ = channel.send(ScriptEvent::Error {
                message: error.to_string(),
            });
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_keychain_store_terminal(
    manager: tauri::State<'_, crate::workspace::scripts::ScriptProcessManager>,
    instance_id: String,
) -> CmdResult<bool> {
    Ok(manager.kill(&keychain_key(&instance_id)))
}

#[tauri::command]
pub async fn write_keychain_store_terminal_stdin(
    manager: tauri::State<'_, crate::workspace::scripts::ScriptProcessManager>,
    instance_id: String,
    data: String,
) -> CmdResult<bool> {
    Ok(manager.write_stdin(&keychain_key(&instance_id), data.as_bytes())?)
}

#[tauri::command]
pub async fn resize_keychain_store_terminal(
    manager: tauri::State<'_, crate::workspace::scripts::ScriptProcessManager>,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<bool> {
    Ok(manager.resize(&keychain_key(&instance_id), cols, rows)?)
}
