//! Read/write custom providers in an opencode-protocol family's global config.
//! Writes go through the jsonc CST to preserve comments/formatting outside the
//! edited `provider.<id>` block.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use jsonc_parser::ParseOptions;
use serde::{Deserialize, Serialize};

pub use super::types::{
    InterleavedConfig, ModelCost, ModelLimit, ModelModalities, ModelStatus,
};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeCustomModel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    // `reasoning: true` makes opencode compute effort variants.
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub tool_call: bool,
    #[serde(default)]
    pub temperature: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<ModelLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModelModalities>,
    #[serde(default)]
    pub attachment: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ModelStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<ModelCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interleaved: Option<InterleavedConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variants: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    // Preserve the file's declaration order so a newly-appended provider lands
    // last (serde_json's map sorts keys; the CST keeps file order).
    let order = provider_key_order(&text);
    out.sort_by_key(|p| {
        order
            .iter()
            .position(|id| *id == p.id)
            .unwrap_or(usize::MAX)
    });
    Ok(out)
}

// Provider ids in the order they appear in the config file.
fn provider_key_order(text: &str) -> Vec<String> {
    let Ok(root) = CstRootNode::parse(text, &ParseOptions::default()) else {
        return Vec::new();
    };
    let Some(provider_obj) = root
        .object_value()
        .and_then(|root_obj| root_obj.object_value("provider"))
    else {
        return Vec::new();
    };
    provider_obj
        .properties()
        .into_iter()
        .filter_map(|prop| prop.name().and_then(|name| name.decoded_value().ok()))
        .collect()
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
        .map(|(model_id, block)| {
            OpencodeCustomModel {
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
                tool_call: block
                    .get("tool_call")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                temperature: block
                    .get("temperature")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                attachment: block
                    .get("attachment")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                family: block
                    .get("family")
                    .and_then(serde_json::Value::as_str)
                    .map(String::from),
                release_date: block
                    .get("release_date")
                    .and_then(serde_json::Value::as_str)
                    .map(String::from),
                status: block
                    .get("status")
                    .and_then(|v| serde_json::from_value(v.clone()).ok()),
                cost: block
                    .get("cost")
                    .and_then(|v| serde_json::from_value(v.clone()).ok()),
                interleaved: block
                    .get("interleaved")
                    .and_then(|v| serde_json::from_value(v.clone()).ok()),
                variants: block
                    .get("variants")
                    .and_then(serde_json::Value::as_object)
                    .map(|obj| {
                        obj.iter()
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect()
                    }),
                limit: block.get("limit").and_then(|v| {
                    let obj = v.as_object()?;
                    Some(ModelLimit {
                        context: obj.get("context")?.as_u64()?,
                        output: obj.get("output")?.as_u64()?,
                    })
                }),
                modalities: block.get("modalities").and_then(|v| {
                    let obj = v.as_object()?;
                    Some(ModelModalities {
                        input: obj
                            .get("input")
                            .and_then(|a| a.as_array())
                            .map(|a| {
                                a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                            })
                            .unwrap_or_default(),
                        output: obj
                            .get("output")
                            .and_then(|a| a.as_array())
                            .map(|a| {
                                a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                            })
                            .unwrap_or_default(),
                    })
                }),
            }
        })
        .collect()
}

fn upsert_custom_provider_at(path: &Path, provider: &OpencodeCustomProvider) -> Result<()> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|_| format!("{{\n  \"$schema\": \"{SCHEMA_URL}\"\n}}\n"));

    let provider = provider.clone();

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
                if m.tool_call {
                    fields.push(("tool_call".to_string(), CstInputValue::Bool(true)));
                }
                if m.temperature {
                    fields.push(("temperature".to_string(), CstInputValue::Bool(true)));
                }
                if m.attachment {
                    fields.push(("attachment".to_string(), CstInputValue::Bool(true)));
                }
                if let Some(family) = &m.family {
                    fields.push(("family".to_string(), CstInputValue::String(family.clone())));
                }
                if let Some(release_date) = &m.release_date {
                    fields.push(("release_date".to_string(), CstInputValue::String(release_date.clone())));
                }
                if let Some(status) = &m.status {
                    let s = serde_json::to_string(status).unwrap_or_default();
                    fields.push(("status".to_string(), CstInputValue::String(s.trim_matches('"').to_string())));
                }
                if let Some(cost) = &m.cost {
                    if let Ok(json) = serde_json::to_value(cost) {
                        if let Some(obj) = json.as_object() {
                            let cost_fields: Vec<(String, CstInputValue)> = obj.iter().map(|(k, v)| {
                                (k.clone(), json_to_cst(v))
                            }).collect();
                            fields.push(("cost".to_string(), CstInputValue::Object(cost_fields)));
                        }
                    }
                }
                if let Some(interleaved) = &m.interleaved {
                    match interleaved {
                        InterleavedConfig::Flag(true) => {
                            fields.push(("interleaved".to_string(), CstInputValue::Bool(true)));
                        }
                        InterleavedConfig::Flag(false) => {}
                        InterleavedConfig::Object { field } => {
                            fields.push(("interleaved".to_string(), CstInputValue::Object(
                                vec![("field".to_string(), CstInputValue::String(field.clone()))],
                            )));
                        }
                    }
                }
                if let Some(variants) = &m.variants {
                    if let Ok(json) = serde_json::to_value(variants) {
                        if let Some(obj) = json.as_object() {
                            let var_fields: Vec<(String, CstInputValue)> = obj.iter()
                                .map(|(k, v)| (k.clone(), json_to_cst(v)))
                                .collect();
                            fields.push(("variants".to_string(), CstInputValue::Object(var_fields)));
                        }
                    }
                }
                if let Some(limit) = &m.limit {
                    fields.push((
                        "limit".to_string(),
                        CstInputValue::Object(vec![
                            (
                                "context".to_string(),
                                CstInputValue::Number(limit.context.to_string()),
                            ),
                            (
                                "output".to_string(),
                                CstInputValue::Number(limit.output.to_string()),
                            ),
                        ]),
                    ));
                }
                if let Some(modalities) = &m.modalities {
                    let mut mod_fields: Vec<(String, CstInputValue)> = Vec::new();
                    if !modalities.input.is_empty() {
                        mod_fields.push((
                            "input".to_string(),
                            CstInputValue::Array(
                                modalities
                                    .input
                                    .iter()
                                    .map(|s| CstInputValue::String(s.clone()))
                                    .collect(),
                            ),
                        ));
                    }
                    if !modalities.output.is_empty() {
                        mod_fields.push((
                            "output".to_string(),
                            CstInputValue::Array(
                                modalities
                                    .output
                                    .iter()
                                    .map(|s| CstInputValue::String(s.clone()))
                                    .collect(),
                            ),
                        ));
                    }
                    if !mod_fields.is_empty() {
                        fields.push(("modalities".to_string(), CstInputValue::Object(mod_fields)));
                    }
                }
                (m.id.clone(), CstInputValue::Object(fields))
            })
            .collect(),
    )
}

// Convert a serde_json::Value to CstInputValue for models_to_cst
fn json_to_cst(value: &serde_json::Value) -> CstInputValue {
    match value {
        serde_json::Value::Null => CstInputValue::Null,
        serde_json::Value::Bool(b) => CstInputValue::Bool(*b),
        serde_json::Value::Number(n) => CstInputValue::Number(n.to_string()),
        serde_json::Value::String(s) => CstInputValue::String(s.clone()),
        serde_json::Value::Array(arr) => {
            CstInputValue::Array(arr.iter().map(json_to_cst).collect())
        }
        serde_json::Value::Object(obj) => {
            CstInputValue::Object(
                obj.iter().map(|(k, v)| (k.clone(), json_to_cst(v))).collect(),
            )
        }
    }
}

// Order-independent equality.
fn models_equal(a: &[OpencodeCustomModel], b: &[OpencodeCustomModel]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut a_sorted: Vec<&OpencodeCustomModel> = a.iter().collect();
    let mut b_sorted: Vec<&OpencodeCustomModel> = b.iter().collect();
    a_sorted.sort_by(|a, b| a.id.trim().cmp(b.id.trim()));
    b_sorted.sort_by(|a, b| a.id.trim().cmp(b.id.trim()));
    a_sorted.into_iter().zip(b_sorted).all(|(a, b)| {
        a.id.trim() == b.id.trim()
            && a.name.trim() == b.name.trim()
            && a.reasoning == b.reasoning
            && a.tool_call == b.tool_call
            && a.temperature == b.temperature
            && a.attachment == b.attachment
            && a.family == b.family
            && a.release_date == b.release_date
            && a.status == b.status
            && a.cost == b.cost
            && a.limit == b.limit
            && a.modalities == b.modalities
            && a.interleaved == b.interleaved
            && a.variants == b.variants
    })
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
                tool_call: true,
                temperature: true,
                attachment: false,
                family: None,
                release_date: None,
                status: None,
                cost: None,
                interleaved: None,
                variants: None,
                limit: Some(ModelLimit {
                    context: 1000000,
                    output: 384000,
                }),
                modalities: None,
            }],
        }
    }

    #[test]
    fn roundtrip_with_all_capabilities() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");

        let provider = OpencodeCustomProvider {
            id: "acme".to_string(),
            name: "Acme".to_string(),
            npm: "@ai-sdk/openai-compatible".to_string(),
            base_url: "https://acme.example.com/v1".to_string(),
            api_key: "{env:MY_KEY}".to_string(),
            headers: BTreeMap::new(),
            models: vec![
                OpencodeCustomModel {
                    id: "deepseek-v4-pro-fusion".to_string(),
                    name: "DeepSeek V4 Pro Fusion".to_string(),
                    reasoning: true,
                    tool_call: true,
                    temperature: true,
                    attachment: false,
                    family: None,
                    release_date: None,
                    status: None,
                    cost: None,
                    interleaved: None,
                    variants: None,
                    limit: Some(ModelLimit {
                        context: 1000000,
                        output: 384000,
                    }),
                    modalities: Some(ModelModalities {
                        input: vec!["text".to_string(), "image".to_string()],
                        output: vec!["text".to_string()],
                    }),
                },
                OpencodeCustomModel {
                    id: "deepseek-v4-flash-fusion".to_string(),
                    name: "DeepSeek V4 Flash Fusion".to_string(),
                    reasoning: true,
                    tool_call: true,
                    temperature: true,
                    attachment: false,
                    family: None,
                    release_date: None,
                    status: None,
                    cost: None,
                    interleaved: None,
                    variants: None,
                    limit: Some(ModelLimit {
                        context: 1000000,
                        output: 384000,
                    }),
                    modalities: Some(ModelModalities {
                        input: vec!["text".to_string(), "image".to_string()],
                        output: vec!["text".to_string()],
                    }),
                },
            ],
        };

        upsert_custom_provider_at(&path, &provider).unwrap();

        // Verify written JSON contains all capability fields
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"tool_call\": true"));
        assert!(written.contains("\"temperature\": true"));
        assert!(written.contains("\"context\": 1000000"));
        assert!(written.contains("\"output\": 384000"));
        assert!(written.contains("\"input\""));
        assert!(written.contains("\"image\""));

        // Verify read matches the original (models may reorder by id during JSON round-trip)
        let mut original = provider;
        let mut read = read_custom_providers_at(&path).unwrap();
        original.models.sort_by(|a, b| a.id.cmp(&b.id));
        read[0].models.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(read, vec![original]);
    }

    #[test]
    fn roundtrip_vision_model_with_modalities() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");

        let provider = OpencodeCustomProvider {
            id: "acme".to_string(),
            name: "Acme".to_string(),
            npm: "@ai-sdk/openai-compatible".to_string(),
            base_url: "https://acme.example.com/v1".to_string(),
            api_key: "{env:MY_KEY}".to_string(),
            headers: BTreeMap::new(),
            models: vec![OpencodeCustomModel {
                id: "cmc/xiaomi/mimo-v2.5".to_string(),
                name: "MiMo V2.5".to_string(),
                reasoning: true,
                tool_call: true,
                temperature: true,
                attachment: false,
                family: None,
                release_date: None,
                status: None,
                cost: None,
                interleaved: None,
                variants: None,
                limit: Some(ModelLimit {
                    context: 1000000,
                    output: 128000,
                }),
                modalities: Some(ModelModalities {
                    input: vec!["text".to_string(), "image".to_string()],
                    output: vec!["text".to_string()],
                }),
            }],
        };

        upsert_custom_provider_at(&path, &provider).unwrap();
        let read = read_custom_providers_at(&path).unwrap();
        assert_eq!(read, vec![provider]);
    }

    #[test]
    fn read_model_without_optional_fields_defaults_to_false() {
        let json = serde_json::json!({
            "m": { "name": "M" }
        });
        let models = read_models(Some(&json));
        assert_eq!(models.len(), 1);
        let m = &models[0];
        assert_eq!(m.id, "m");
        assert_eq!(m.name, "M");
        assert!(!m.reasoning);
        assert!(!m.tool_call);
        assert!(!m.temperature);
        assert_eq!(m.limit, None);
        assert_eq!(m.modalities, None);
    }

    #[test]
    fn read_model_with_partial_limit_defaults_missing_fields() {
        let json = serde_json::json!({
            "m": {
                "name": "M",
                "limit": { "context": 256000 }
            }
        });
        let models = read_models(Some(&json));
        assert_eq!(models.len(), 1);
        // missing "output" in limit → None because the inner `?` short-circuits
        assert_eq!(models[0].limit, None);
    }

    #[test]
    fn upsert_overwrites_with_provider_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(
            &path,
            r#"{
  "provider": {
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://acme.example.com/v1", "apiKey": "old" },
      "models": {
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro",
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 1000000, "output": 384000 },
          "cost": { "input": 1.74, "output": 3.48, "cache_read": 0.17 },
          "family": "claude",
          "status": "active"
        }
      }
    }
  }
}"#,
        )
        .unwrap();

        let updated = OpencodeCustomProvider {
            id: "acme".to_string(),
            name: "Acme".to_string(),
            npm: "@ai-sdk/openai-compatible".to_string(),
            base_url: "https://acme.example.com/v2".to_string(),
            api_key: "new".to_string(),
            headers: BTreeMap::new(),
            models: vec![OpencodeCustomModel {
                id: "deepseek-v4-pro".to_string(),
                name: "DeepSeek V4 Pro".to_string(),
                reasoning: false,
                tool_call: false,
                temperature: false,
                attachment: false,
                family: None,
                release_date: None,
                status: None,
                cost: None,
                interleaved: None,
                variants: None,
                limit: None,
                modalities: None,
            }],
        };
        upsert_custom_provider_at(&path, &updated).unwrap();

        let read = read_custom_providers_at(&path).unwrap();
        let model = &read[0].models[0];

        assert!(!model.tool_call, "tool_call should be false (provider value)");
        assert!(!model.temperature, "temperature should be false (provider value)");
        assert!(!model.attachment, "attachment should be false (provider value)");
        assert!(!model.reasoning, "reasoning should be false (provider value)");
        assert!(model.family.is_none());
        assert!(model.limit.is_none());
        assert!(model.modalities.is_none());
        assert!(model.cost.is_none());
        assert!(model.status.is_none());
        assert_eq!(read[0].base_url, "https://acme.example.com/v2");
        assert_eq!(read[0].api_key, "new");
    }



    #[test]
    fn read_model_from_jsonc_text() {
        let text = r#"{
  "provider": {
    "acme": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Acme",
      "options": {
        "baseURL": "https://acme.example.com/v1",
        "apiKey": "{env:MY_KEY}"
      },
      "models": {
        "deepseek-v4-pro": {
          "name": "DeepSeek V4 Pro",
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": { "context": 1000000, "output": 384000 }
        },
        "mimo-v2.5": {
          "name": "MiMo V2.5",
          "reasoning": true,
          "tool_call": true,
          "temperature": true,
          "limit": { "context": 1000000, "output": 128000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
"#;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        std::fs::write(&path, text).unwrap();

        let providers = read_custom_providers_at(&path).unwrap();
        assert_eq!(providers.len(), 1);
        let m0 = &providers[0].models[0];
        assert_eq!(m0.id, "deepseek-v4-pro");
        assert!(m0.reasoning);
        assert!(m0.tool_call);
        assert!(m0.temperature);
        let limit = m0.limit.as_ref().unwrap();
        assert_eq!(limit.context, 1_000_000);
        assert_eq!(limit.output, 384_000);
        assert_eq!(m0.modalities, None);

        let m1 = &providers[0].models[1];
        assert_eq!(m1.id, "mimo-v2.5");
        let mods = m1.modalities.as_ref().unwrap();
        assert_eq!(mods.input, vec!["text", "image"]);
        assert_eq!(mods.output, vec!["text"]);
    }

    #[test]
    fn models_equal_compares_new_fields() {
        let a = vec![OpencodeCustomModel {
            id: "m".to_string(),
            name: "M".to_string(),
            reasoning: true,
            tool_call: true,
            temperature: false,
            attachment: false,
            family: None,
            release_date: None,
            status: None,
            cost: None,
            interleaved: None,
            variants: None,
            limit: Some(ModelLimit { context: 1000, output: 500 }),
            modalities: None,
        }];
        let b = vec![OpencodeCustomModel {
            id: " m ".to_string(),
            name: " M ".to_string(),
            reasoning: true,
            tool_call: true,
            temperature: false,
            attachment: false,
            family: None,
            release_date: None,
            status: None,
            cost: None,
            interleaved: None,
            variants: None,
            limit: Some(ModelLimit { context: 1000, output: 500 }),
            modalities: None,
        }];
        let c = vec![OpencodeCustomModel {
            id: "m".to_string(),
            name: "M".to_string(),
            reasoning: true,
            tool_call: true,
            temperature: true,
            attachment: false,
            family: None,
            release_date: None,
            status: None,
            cost: None,
            interleaved: None,
            variants: None,
            limit: Some(ModelLimit { context: 1000, output: 500 }),
            modalities: None,
        }];
        assert!(models_equal(&a, &b), "identical models should be equal");
        assert!(!models_equal(&a, &c), "different temperature should not match");
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
        assert_eq!(ids, vec!["other", "hundun"], "file order preserved");
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
        assert_eq!(
            ids,
            vec!["deepseek", "custom"],
            "bare block skipped, file order preserved"
        );
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
                tool_call: false,
                temperature: false,
                attachment: false,
                family: None,
                release_date: None,
                status: None,
                cost: None,
                interleaved: None,
                variants: None,
                limit: None,
                modalities: None,
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
