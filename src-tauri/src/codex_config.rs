//! Parsing helpers for the user's `~/.codex/config.toml`.
//!
//! Used in two places:
//!  - `commands::system_commands::get_agent_login_status` — detect whether
//!    Codex is reachable via an API-key provider (e.g. Azure) when the
//!    user hasn't run `codex login`.
//!  - `shell_env::inherit_login_shell_env` — extend the env-var
//!    inheritance whitelist with whichever `env_key` names the user has
//!    declared, so a Finder-launched Helmor.app sees the same API keys
//!    as a terminal session.

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiKeyProvider {
    pub name: String,
    pub env_key: String,
}

/// Resolve `~/.codex/config.toml`, honouring `$CODEX_HOME` if set.
pub fn config_path() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".codex"))
        .join("config.toml")
}

/// The provider currently selected by `model_provider`, if it declares an
/// `env_key`. Returns `None` when no provider is active, the active
/// provider isn't an API-key flavour, or the config can't be parsed.
pub fn active_api_key_provider(config: &str) -> Option<ApiKeyProvider> {
    let value = toml::from_str::<toml::Value>(config).ok()?;
    let provider = value
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|provider| !provider.is_empty())?;
    let env_key = value
        .get("model_providers")
        .and_then(|providers| providers.get(provider))
        .and_then(|provider_config| provider_config.get("env_key"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|env_key| !env_key.is_empty())?;

    Some(ApiKeyProvider {
        name: provider.to_string(),
        env_key: env_key.to_string(),
    })
}

/// Every `env_key` declared under `[model_providers.*]` — regardless of
/// which provider is currently active. We surface them all so the user
/// can switch providers in `config.toml` without restarting Helmor.
///
/// Returns an empty vec on parse failure or when no providers declare an
/// `env_key`.
pub fn declared_env_keys(config: &str) -> Vec<String> {
    let Ok(value) = toml::from_str::<toml::Value>(config) else {
        return Vec::new();
    };
    let Some(providers) = value.get("model_providers").and_then(toml::Value::as_table) else {
        return Vec::new();
    };

    let mut keys = Vec::new();
    for provider in providers.values() {
        let Some(env_key) = provider
            .get("env_key")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
        else {
            continue;
        };
        let env_key = env_key.to_string();
        if !keys.contains(&env_key) {
            keys.push(env_key);
        }
    }
    keys
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_provider_reads_azure_env_key() {
        let provider = active_api_key_provider(
            r#"
model = "gpt-5.5"
model_provider = "azure"

[model_providers.azure]
name = "Azure"
base_url = "https://example.openai.azure.com/openai/v1"
env_key = "AZURE_OPENAI_API_KEY"
wire_api = "responses"
"#,
        );

        assert_eq!(
            provider,
            Some(ApiKeyProvider {
                name: "azure".to_string(),
                env_key: "AZURE_OPENAI_API_KEY".to_string(),
            })
        );
    }

    #[test]
    fn active_provider_returns_none_when_section_missing() {
        let provider = active_api_key_provider(
            r#"
model_provider = "azure"

[model_providers.openai]
env_key = "OPENAI_API_KEY"
"#,
        );

        assert_eq!(provider, None);
    }

    #[test]
    fn active_provider_returns_none_without_env_key() {
        let provider = active_api_key_provider(
            r#"
model_provider = "azure"

[model_providers.azure]
base_url = "https://example.openai.azure.com/openai/v1"
"#,
        );

        assert_eq!(provider, None);
    }

    #[test]
    fn declared_env_keys_collects_every_provider() {
        let keys = declared_env_keys(
            r#"
model_provider = "azure"

[model_providers.azure]
env_key = "AZURE_OPENAI_API_KEY"

[model_providers.openai]
env_key = "OPENAI_API_KEY"

[model_providers.no_key]
base_url = "https://example.com"
"#,
        );

        assert_eq!(keys, vec!["AZURE_OPENAI_API_KEY", "OPENAI_API_KEY"]);
    }

    #[test]
    fn declared_env_keys_deduplicates() {
        let keys = declared_env_keys(
            r#"
[model_providers.a]
env_key = "SHARED_KEY"

[model_providers.b]
env_key = "SHARED_KEY"
"#,
        );

        assert_eq!(keys, vec!["SHARED_KEY"]);
    }

    #[test]
    fn declared_env_keys_handles_empty_config() {
        assert!(declared_env_keys("").is_empty());
        assert!(declared_env_keys("not valid toml = [").is_empty());
        assert!(declared_env_keys("[other]\nfoo = 1").is_empty());
    }
}
