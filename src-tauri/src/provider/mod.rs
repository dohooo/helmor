//! Unified custom-provider backend: one trait per family + a `backend_for` router.

pub mod builtin_claude;
pub mod claude;
pub mod codex;
pub mod opencode;
pub mod opencode_config;
pub mod types;

pub use types::{is_enabled, CustomProvider, CustomProviderModel, ProviderFamily};

/// Serializes custom-provider config writes so concurrent upsert/remove (each a
/// read-modify-write of the whole settings key / config file) can't drop one.
pub fn lock_writes() -> std::sync::MutexGuard<'static, ()> {
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub trait CustomProviderBackend {
    /// All configured providers, unfiltered.
    fn list(&self) -> Vec<CustomProvider>;
    fn upsert(&self, provider: CustomProvider) -> anyhow::Result<()>;
    fn remove(&self, id: &str) -> anyhow::Result<()>;
}

pub fn backend_for(family: ProviderFamily) -> Option<Box<dyn CustomProviderBackend>> {
    match family {
        ProviderFamily::Claude => Some(Box::new(claude::ClaudeBackend)),
        ProviderFamily::Codex => Some(Box::new(codex::CodexBackend)),
        ProviderFamily::Opencode | ProviderFamily::Mimo => {
            Some(Box::new(opencode::OpencodeBackend { family }))
        }
    }
}

/// Fetch a provider's available models from its endpoint.
pub async fn fetch_models(
    family: ProviderFamily,
    base_url: &str,
    api_key: &str,
) -> anyhow::Result<Vec<CustomProviderModel>> {
    match family {
        ProviderFamily::Claude => claude::fetch_models(base_url, api_key).await,
        ProviderFamily::Codex => codex::fetch_models(base_url, api_key).await,
        ProviderFamily::Opencode | ProviderFamily::Mimo => {
            opencode::fetch_models(base_url, api_key).await
        }
    }
}
