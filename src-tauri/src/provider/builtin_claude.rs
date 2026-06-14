//! Built-in Claude provider presets, loaded from `provider-catalog.json`.

use std::sync::OnceLock;

use serde::Deserialize;

const CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src/shared/provider-catalog.json"
));

#[derive(Debug, Clone, Deserialize)]
struct ProviderCatalog {
    claude: Vec<BuiltinClaudeProvider>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinClaudeProvider {
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub base_url: String,
}

pub fn builtin_claude_providers() -> &'static [BuiltinClaudeProvider] {
    static PROVIDERS: OnceLock<Vec<BuiltinClaudeProvider>> = OnceLock::new();
    PROVIDERS
        .get_or_init(|| {
            let catalog: ProviderCatalog = serde_json::from_str(CATALOG_JSON)
                .expect("src/shared/provider-catalog.json must be valid");
            catalog.claude
        })
        .as_slice()
}
