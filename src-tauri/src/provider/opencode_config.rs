//! Read/write custom providers in an opencode-protocol family's global config
//! (opencode or the MiMo fork). Writes go through the jsonc CST to preserve
//! comments/formatting outside the edited `provider.<id>` block.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use jsonc_parser::ParseOptions;
use serde::{Deserialize, Serialize};

// MiMo Code declares opencode's schema URL too, so both families share it.
const SCHEMA_URL: &str = "https://opencode.ai/config.json";
const DEFAULT_NPM: &str = "@ai-sdk/openai-compatible";

/// `file_candidates` is the lookup precedence; index 0 is the default filename.
struct FamilyConfig {
    /// Subdir under `$XDG_CONFIG_HOME` / `~/.config`.
    xdg_dir: &'static str,
    file_candidates: [&'static str; 3],
}

const OPENCODE_FAMILY: FamilyConfig = FamilyConfig {
    xdg_dir: "opencode",
    file_candidates: ["opencode.jsonc", "opencode.json", "config.json"],
};

// mimo checks `mimocode.json` BEFORE `mimocode.jsonc`; mirror that order.
const MIMO_FAMILY: FamilyConfig = FamilyConfig {
    xdg_dir: "mimocode",
    file_candidates: ["mimocode.json", "mimocode.jsonc", "config.json"],
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCustomModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    // `reasoning: true` makes opencode compute effort variants.
    #[serde(default)]
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCustomProvider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_npm")]
    pub npm: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub models: Vec<OpencodeCustomModel>,
}

fn default_npm() -> String {
    DEFAULT_NPM.to_string()
}

fn config_dir(family: &FamilyConfig) -> Result<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Ok(PathBuf::from(xdg).join(family.xdg_dir));
        }
    }
    crate::platform::paths::xdg_config_dir(family.xdg_dir).context("HOME is not set")
}

fn config_file_path(family: &FamilyConfig) -> Result<PathBuf> {
    let dir = config_dir(family)?;
    for name in family.file_candidates {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Ok(dir.join(family.file_candidates[0]))
}

pub fn read_custom_providers() -> Result<Vec<OpencodeCustomProvider>> {
    read_custom_providers_at(&config_file_path(&OPENCODE_FAMILY)?)
}

pub fn upsert_custom_provider(provider: &OpencodeCustomProvider, preset: bool) -> Result<()> {
    upsert_for_family(&OPENCODE_FAMILY, provider, preset)
}

pub fn delete_custom_provider(id: &str) -> Result<()> {
    delete_custom_provider_at(&config_file_path(&OPENCODE_FAMILY)?, id)
}

pub fn read_mimo_custom_providers() -> Result<Vec<OpencodeCustomProvider>> {
    read_custom_providers_at(&config_file_path(&MIMO_FAMILY)?)
}

pub fn upsert_mimo_custom_provider(provider: &OpencodeCustomProvider, preset: bool) -> Result<()> {
    upsert_for_family(&MIMO_FAMILY, provider, preset)
}

pub fn delete_mimo_custom_provider(id: &str) -> Result<()> {
    delete_custom_provider_at(&config_file_path(&MIMO_FAMILY)?, id)
}

fn upsert_for_family(
    family: &FamilyConfig,
    provider: &OpencodeCustomProvider,
    preset: bool,
) -> Result<()> {
    let path = config_file_path(family)?;
    if preset {
        upsert_preset_key_at(&path, &provider.id, &provider.api_key)
    } else {
        upsert_custom_provider_at(&path, provider)
    }
}

fn read_custom_providers_at(path: &Path) -> Result<Vec<OpencodeCustomProvider>> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let value: serde_json::Value =
        jsonc_parser::parse_to_serde_value(&text, &ParseOptions::default())
            .unwrap_or(None)
            .unwrap_or(serde_json::Value::Null);
    let Some(providers) = value.get("provider").and_then(serde_json::Value::as_object) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for (id, block) in providers {
        // Skip blocks with no apiKey/baseURL (built-ins, bare overrides).
        let options = block.get("options").and_then(serde_json::Value::as_object);
        let api_key = options
            .and_then(|o| o.get("apiKey"))
            .and_then(serde_json::Value::as_str);
        let base_url = options
            .and_then(|o| o.get("baseURL"))
            .and_then(serde_json::Value::as_str);
        if api_key.is_none() && base_url.is_none() {
            continue;
        }
        out.push(OpencodeCustomProvider {
            id: id.clone(),
            name: block
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(id)
                .to_string(),
            npm: block
                .get("npm")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
            base_url: base_url.unwrap_or_default().to_string(),
            api_key: api_key.unwrap_or_default().to_string(),
            headers: read_headers(options),
            models: read_models(block.get("models")),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn read_headers(
    options: Option<&serde_json::Map<String, serde_json::Value>>,
) -> BTreeMap<String, String> {
    options
        .and_then(|o| o.get("headers"))
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn read_models(models: Option<&serde_json::Value>) -> Vec<OpencodeCustomModel> {
    let Some(map) = models.and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    map.iter()
        .map(|(model_id, block)| OpencodeCustomModel {
            id: model_id.clone(),
            name: block
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(model_id)
                .to_string(),
            reasoning: block
                .get("reasoning")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
        .collect()
}

fn upsert_custom_provider_at(path: &Path, provider: &OpencodeCustomProvider) -> Result<()> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| format!("{{\n  \"$schema\": \"{SCHEMA_URL}\"\n}}\n"));
    // Only rewrite `models` when changed, to preserve comments in it.
    let models_unchanged = read_custom_providers_at(path)
        .ok()
        .and_then(|list| list.into_iter().find(|p| p.id == provider.id))
        .is_some_and(|existing| models_equal(&existing.models, &provider.models));

    let root = CstRootNode::parse(&text, &ParseOptions::default())
        .context("parse opencode config (is it valid JSON/JSONC?)")?;
    let root_obj = root.object_value_or_set();
    if root_obj.get("$schema").is_none() {
        root_obj.append("$schema", CstInputValue::String(SCHEMA_URL.to_string()));
    }
    // Field-by-field, not a full set_value replace (that drops block comments).
    let block = root_obj
        .object_value_or_set("provider")
        .object_value_or_set(&provider.id);
    set_string(&block, "npm", &provider.npm);
    set_string(&block, "name", &provider.name);
    let options = block.object_value_or_set("options");
    set_string(&options, "baseURL", &provider.base_url);
    set_or_remove_string(&options, "apiKey", provider.api_key.trim());
    set_headers(&options, &provider.headers);
    if !models_unchanged {
        set_object(&block, "models", models_to_cst(&provider.models));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, root.to_string())
        .with_context(|| format!("write opencode config at {}", path.display()))?;
    Ok(())
}

// Replace existing value (keeps surrounding comments) or append.
fn set_object(obj: &CstObject, key: &str, value: CstInputValue) {
    match obj.get(key) {
        Some(prop) => prop.set_value(value),
        None => {
            obj.append(key, value);
        }
    }
}

fn set_string(obj: &CstObject, key: &str, value: &str) {
    set_object(obj, key, CstInputValue::String(value.to_string()));
}

fn set_or_remove_string(obj: &CstObject, key: &str, value: &str) {
    if value.is_empty() {
        if let Some(prop) = obj.get(key) {
            prop.remove();
        }
        return;
    }
    set_string(obj, key, value);
}

fn set_headers(options: &CstObject, headers: &BTreeMap<String, String>) {
    if headers.is_empty() {
        if let Some(prop) = options.get("headers") {
            prop.remove();
        }
        return;
    }
    let value = CstInputValue::Object(
        headers
            .iter()
            .map(|(k, v)| (k.clone(), CstInputValue::String(v.clone())))
            .collect(),
    );
    set_object(options, "headers", value);
}

fn models_to_cst(models: &[OpencodeCustomModel]) -> CstInputValue {
    CstInputValue::Object(
        models
            .iter()
            .map(|m| {
                let mut fields: Vec<(String, CstInputValue)> = vec![(
                    "name".to_string(),
                    CstInputValue::String(if m.name.trim().is_empty() {
                        m.id.clone()
                    } else {
                        m.name.clone()
                    }),
                )];
                if m.reasoning {
                    fields.push(("reasoning".to_string(), CstInputValue::Bool(true)));
                }
                (m.id.clone(), CstInputValue::Object(fields))
            })
            .collect(),
    )
}

// Order-independent equality.
fn models_equal(a: &[OpencodeCustomModel], b: &[OpencodeCustomModel]) -> bool {
    let key = |models: &[OpencodeCustomModel]| {
        let mut out: Vec<(String, String, bool)> = models
            .iter()
            .map(|m| {
                (
                    m.id.trim().to_string(),
                    m.name.trim().to_string(),
                    m.reasoning,
                )
            })
            .collect();
        out.sort();
        out
    };
    key(a) == key(b)
}

// Preset providers only need an apiKey; set just that, preserve the rest.
fn upsert_preset_key_at(path: &Path, id: &str, api_key: &str) -> Result<()> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| format!("{{\n  \"$schema\": \"{SCHEMA_URL}\"\n}}\n"));
    let root = CstRootNode::parse(&text, &ParseOptions::default())
        .context("parse opencode config (is it valid JSON/JSONC?)")?;
    let root_obj = root.object_value_or_set();
    if root_obj.get("$schema").is_none() {
        root_obj.append("$schema", CstInputValue::String(SCHEMA_URL.to_string()));
    }
    let options = root_obj
        .object_value_or_set("provider")
        .object_value_or_set(id)
        .object_value_or_set("options");
    match options.get("apiKey") {
        Some(existing) => existing.set_value(CstInputValue::String(api_key.to_string())),
        None => {
            options.append("apiKey", CstInputValue::String(api_key.to_string()));
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(path, root.to_string())
        .with_context(|| format!("write opencode config at {}", path.display()))?;
    Ok(())
}

fn delete_custom_provider_at(path: &Path, id: &str) -> Result<()> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(());
    };
    // Confirm it exists first, to avoid creating an empty `provider` block.
    let exists = read_custom_providers_at(path)?.iter().any(|p| p.id == id);
    if !exists {
        return Ok(());
    }
    let root =
        CstRootNode::parse(&text, &ParseOptions::default()).context("parse opencode config")?;
    let provider_obj = root.object_value_or_set().object_value_or_set("provider");
    if let Some(entry) = provider_obj.get(id) {
        entry.remove();
    }
    std::fs::write(path, root.to_string())
        .with_context(|| format!("write opencode config at {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> OpencodeCustomProvider {
        OpencodeCustomProvider {
            id: "hundun".to_string(),
            name: "DeepSeek (Hundun)".to_string(),
            npm: DEFAULT_NPM.to_string(),
            base_url: "http://rmb.hundun.cn/v1".to_string(),
            api_key: "secret-key".to_string(),
            headers: BTreeMap::new(),
            models: vec![OpencodeCustomModel {
                id: "deepseek-v4-pro".to_string(),
                name: "DeepSeek V4 Pro".to_string(),
                reasoning: true,
            }],
        }
    }

    #[test]
    fn upsert_creates_file_with_schema_and_block() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        upsert_custom_provider_at(&path, &sample()).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"$schema\""));
        assert!(written.contains("\"hundun\""));
        assert!(written.contains("\"baseURL\": \"http://rmb.hundun.cn/v1\""));
        assert!(written.contains("\"apiKey\": \"secret-key\""));
        assert!(written.contains("\"reasoning\": true"));

        let read = read_custom_providers_at(&path).unwrap();
        assert_eq!(read, vec![sample()]);
    }

    #[test]
    fn upsert_preserves_comments_and_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(
            &path,
            "{\n  // keep me\n  \"$schema\": \"x\",\n  \"theme\": \"dark\"\n}\n",
        )
        .unwrap();

        upsert_custom_provider_at(&path, &sample()).unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("// keep me"), "comment must survive");
        assert!(written.contains("\"theme\": \"dark\""), "other keys kept");
        assert!(written.contains("\"hundun\""));
    }

    #[test]
    fn upsert_replaces_existing_block_and_keeps_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(
            &path,
            "{\n  \"provider\": {\n    \"other\": { \"npm\": \"@ai-sdk/openai-compatible\", \"options\": { \"baseURL\": \"http://other/v1\" }, \"models\": {} },\n    \"hundun\": { \"npm\": \"@ai-sdk/openai-compatible\", \"name\": \"old\", \"options\": { \"baseURL\": \"http://old/v1\" }, \"models\": {} }\n  }\n}\n",
        )
        .unwrap();

        upsert_custom_provider_at(&path, &sample()).unwrap();
        let read = read_custom_providers_at(&path).unwrap();
        let ids: Vec<&str> = read.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["hundun", "other"]);
        let hundun = read.iter().find(|p| p.id == "hundun").unwrap();
        assert_eq!(hundun.base_url, "http://rmb.hundun.cn/v1");
        assert_eq!(hundun.name, "DeepSeek (Hundun)");
    }

    #[test]
    fn delete_removes_block_and_preserves_comment() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        upsert_custom_provider_at(&path, &sample()).unwrap();
        let with_comment =
            std::fs::read_to_string(&path)
                .unwrap()
                .replacen('{', "{\n  // top comment", 1);
        std::fs::write(&path, with_comment).unwrap();

        delete_custom_provider_at(&path, "hundun").unwrap();
        let read = read_custom_providers_at(&path).unwrap();
        assert!(read.is_empty());
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            written.contains("// top comment"),
            "comment must survive delete"
        );
    }

    #[test]
    fn read_includes_preset_and_custom_skips_bare_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(
            &path,
            "{\n  \"provider\": {\n    \"deepseek\": { \"options\": { \"apiKey\": \"sk-x\" } },\n    \"custom\": { \"npm\": \"@ai-sdk/openai-compatible\", \"options\": { \"baseURL\": \"http://c/v1\" }, \"models\": { \"m\": {} } },\n    \"bare\": { \"options\": { \"headers\": { \"X\": \"y\" } } }\n  }\n}\n",
        )
        .unwrap();

        let read = read_custom_providers_at(&path).unwrap();
        let ids: Vec<&str> = read.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["custom", "deepseek"], "bare block skipped");
        let deepseek = read.iter().find(|p| p.id == "deepseek").unwrap();
        assert_eq!(deepseek.api_key, "sk-x");
        assert_eq!(deepseek.base_url, "", "preset block has no baseURL");
    }

    #[test]
    fn upsert_preset_writes_only_apikey_and_preserves_block() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(
            &path,
            "{\n  // c\n  \"provider\": {\n    \"deepseek\": {\n      \"models\": { \"deepseek-chat\": { \"name\": \"x\" } }\n    }\n  }\n}\n",
        )
        .unwrap();

        upsert_preset_key_at(&path, "deepseek", "sk-new").unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("// c"), "comment survives");
        assert!(written.contains("deepseek-chat"), "existing block kept");
        assert!(written.contains("\"apiKey\": \"sk-new\""));
        assert!(!written.contains("\"npm\""), "preset writes no npm");
        assert!(!written.contains("\"baseURL\""), "preset writes no baseURL");

        let read = read_custom_providers_at(&path).unwrap();
        let deepseek = read.iter().find(|p| p.id == "deepseek").unwrap();
        assert_eq!(deepseek.api_key, "sk-new");
        assert_eq!(deepseek.base_url, "");
    }

    #[test]
    fn upsert_custom_edit_preserves_inline_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(
            &path,
            r#"{
  // top comment
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    // before hundun
    "hundun": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek (Hundun)",
      "options": {
        // inside options
        "baseURL": "http://rmb.hundun.cn/v1",
        "apiKey": "old-key"
      },
      "models": {
        // inside models
        "deepseek-v4-pro": { "name": "DeepSeek V4 Pro" }
      }
    }
  }
}
"#,
        )
        .unwrap();

        let edited = OpencodeCustomProvider {
            id: "hundun".to_string(),
            name: "DeepSeek (Hundun)".to_string(),
            npm: DEFAULT_NPM.to_string(),
            base_url: "http://rmb.hundun.cn/v1".to_string(),
            api_key: "new-key".to_string(),
            headers: BTreeMap::new(),
            models: vec![OpencodeCustomModel {
                id: "deepseek-v4-pro".to_string(),
                name: "DeepSeek V4 Pro".to_string(),
                reasoning: false,
            }],
        };
        upsert_custom_provider_at(&path, &edited).unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        for comment in [
            "// top comment",
            "// before hundun",
            "// inside options",
            "// inside models",
        ] {
            assert!(
                written.contains(comment),
                "comment lost: {comment}\n{written}"
            );
        }
        assert!(written.contains("\"apiKey\": \"new-key\""));
        assert!(!written.contains("old-key"));
        let read = read_custom_providers_at(&path).unwrap();
        let hundun = read.iter().find(|p| p.id == "hundun").unwrap();
        assert_eq!(hundun.api_key, "new-key");
        assert_eq!(hundun.models.len(), 1);
    }
}
