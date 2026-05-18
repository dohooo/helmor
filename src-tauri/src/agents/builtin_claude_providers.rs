use std::sync::OnceLock;

use serde::Deserialize;

const CATALOG_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../src/shared/builtin-claude-providers.json"
));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinClaudeProvider {
    pub key: String,
    pub base_url: String,
    pub models: Vec<BuiltinClaudeModel>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BuiltinClaudeModel {
    pub id: String,
    pub label: String,
}

pub fn builtin_claude_providers() -> &'static [BuiltinClaudeProvider] {
    static PROVIDERS: OnceLock<Vec<BuiltinClaudeProvider>> = OnceLock::new();
    PROVIDERS
        .get_or_init(|| {
            serde_json::from_str(CATALOG_JSON)
                .expect("src/shared/builtin-claude-providers.json must be valid")
        })
        .as_slice()
}
