//! Kimi Code custom-provider backend. File-backed (mirrors OpenCode): list /
//! upsert / remove read & write `${KIMI_CODE_HOME:-~/.kimi-code}/config.toml`
//! directly via the toml_edit CST, in the `[providers.<id>]` /
//! `[models."<id>/<model>"]` shape Kimi itself emits. No dependency on the
//! `kimi provider` CLI — so it tolerates the unified card's optimistic,
//! incrementally-filled writes exactly like the OpenCode config backend.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use toml_edit::{DocumentMut, Item, Table};

use super::types::{CustomProvider, CustomProviderModel};
use super::CustomProviderBackend;

/// A configured provider, surfaced in the composer model picker grouping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiProviderInfo {
    pub id: String,
    pub label: String,
    pub model_count: usize,
}

/// A configured model, surfaced in the composer model picker. `id` is the
/// Kimi model alias (what `session/set_model` / `--model` accept).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiModelInfo {
    pub id: String,
    pub label: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiProviderConfig {
    pub providers: Vec<KimiProviderInfo>,
    pub models: Vec<KimiModelInfo>,
}

/// Kimi REQUIRES a positive `max_context_size` per model or it rejects the
/// whole config — default when the endpoint doesn't report one.
const DEFAULT_MAX_CONTEXT_SIZE: i64 = 128_000;

// ── Paths ─────────────────────────────────────────────────────────────────

/// `$KIMI_CODE_HOME` (an empty value counts as unset), else `~/.kimi-code`.
/// Shared with `system_commands::kimi_login_ready` so both resolve identically.
pub(crate) fn kimi_code_home() -> Option<PathBuf> {
    std::env::var_os("KIMI_CODE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::platform::paths::home_dir().map(|h| h.join(".kimi-code")))
}

fn config_path() -> Result<PathBuf> {
    let home = kimi_code_home().context("could not resolve the kimi-code home directory")?;
    Ok(home.join("config.toml"))
}

/// Serializes config.toml read-modify-write cycles within this process. The
/// unified `provider::lock_writes()` already guards command-level writes; this
/// is the module-local backstop for any direct caller.
static CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

// ── Read ──────────────────────────────────────────────────────────────────

fn read_document() -> Result<DocumentMut> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(DocumentMut::new());
    }
    std::fs::read_to_string(&path)
        .context("reading kimi config.toml")?
        .parse()
        .context("parsing kimi config.toml")
}

/// Parse the config into the composer-facing `{providers, models}` view (model
/// ids keyed `<provider>/<model>`). Reused by the Settings "Models" row.
pub fn read_provider_config() -> Result<KimiProviderConfig> {
    let doc = read_document()?;
    let json = toml_doc_to_json(&doc)?;
    parse_provider_config(&json)
}

/// toml_edit `DocumentMut` → JSON string, so the existing `{providers, models}`
/// parser (and its tests) work unchanged on file-sourced config.
fn toml_doc_to_json(doc: &DocumentMut) -> Result<String> {
    let value: toml::Value = doc
        .to_string()
        .parse()
        .context("re-parsing kimi config.toml")?;
    serde_json::to_string(&value).context("serializing kimi config.toml to json")
}

/// Parse a `{providers, models}` config body (the shape Kimi emits, whether
/// from the CLI's `--json` or our TOML round-tripped to JSON).
pub fn parse_provider_config(raw: &str) -> Result<KimiProviderConfig> {
    let body = if raw.trim().is_empty() { "{}" } else { raw };
    let value: Value = serde_json::from_str(body).context("parsing kimi provider config")?;

    let mut models = Vec::new();
    let mut model_count: std::collections::HashMap<String, usize> = Default::default();
    if let Some(map) = value.get("models").and_then(Value::as_object) {
        for (key, entry) in map {
            let provider_id = entry
                .get("provider")
                .or_else(|| entry.get("providerId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let label = entry
                .get("display_name")
                .or_else(|| entry.get("displayName"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(key)
                .to_string();
            if !provider_id.is_empty() {
                *model_count.entry(provider_id.clone()).or_default() += 1;
            }
            models.push(KimiModelInfo {
                id: key.clone(),
                label,
                provider_id,
            });
        }
    }
    models.sort_by_cached_key(|m| m.label.to_lowercase());

    let mut providers = Vec::new();
    if let Some(map) = value.get("providers").and_then(Value::as_object) {
        for (id, entry) in map {
            let label = entry
                .get("display_name")
                .or_else(|| entry.get("displayName"))
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(id)
                .to_string();
            providers.push(KimiProviderInfo {
                id: id.clone(),
                label,
                model_count: model_count.get(id).copied().unwrap_or(0),
            });
        }
    }
    providers.sort_by_cached_key(|p| p.label.to_lowercase());

    Ok(KimiProviderConfig { providers, models })
}

/// Config → unified `CustomProvider[]` for the Settings "Custom Providers" UI:
/// one entry per `[providers.<id>]`, its models gathered from `[models.*]`
/// whose `provider == id`. Everything is treated as a manual provider (Kimi's
/// schema carries no preset marker; the card just shows the base URL field).
fn read_custom_providers() -> Result<Vec<CustomProvider>> {
    let doc = read_document()?;

    // provider id → its models, from `[models."<provider>/<model>"]`.
    let mut models_by_provider: std::collections::HashMap<String, Vec<CustomProviderModel>> =
        Default::default();
    if let Some(models) = doc.get("models").and_then(Item::as_table) {
        for (key, item) in models.iter() {
            let Some(entry) = item.as_table() else {
                continue;
            };
            let provider_id = entry
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            // Wire model name is the explicit `model`, else the part after `/`.
            let slug = entry
                .get("model")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| key.rsplit('/').next().unwrap_or(key).to_string());
            if provider_id.is_empty() || slug.is_empty() {
                continue;
            }
            let label = entry
                .get("display_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&slug)
                .to_string();
            models_by_provider
                .entry(provider_id.to_string())
                .or_default()
                .push(CustomProviderModel {
                    slug,
                    label,
                    effort_levels: Vec::new(),
                });
        }
    }

    // Iterate in document (insertion) order so a freshly-added provider lands
    // at the bottom of the list — matching every other family's card order.
    let mut providers = Vec::new();
    if let Some(table) = doc.get("providers").and_then(Item::as_table) {
        for (id, item) in table.iter() {
            let Some(entry) = item.as_table() else {
                continue;
            };
            let field = |key: &str, alt: &str| {
                entry
                    .get(key)
                    .or_else(|| entry.get(alt))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            providers.push(CustomProvider {
                id: id.to_string(),
                // Empty (not the id) when unnamed → the card shows its placeholder.
                name: field("name", "display_name"),
                preset_key: None,
                base_url: field("base_url", "baseUrl"),
                api_key: field("api_key", "apiKey"),
                // Surface the provider `type` so the card's style selector reflects config.
                api_style: entry
                    .get("type")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                headers: None,
                models: models_by_provider.remove(id).unwrap_or_default(),
                enabled_model_ids: None,
                ..Default::default()
            });
        }
    }
    Ok(providers)
}

// ── Write ─────────────────────────────────────────────────────────────────

/// Kimi provider `type` values that fit the unified card (api_key + optional
/// base_url). Mirrors the frontend adapter's `styleOptions`. `google-genai` /
/// `vertexai` need a different input flow (env table / no key) and aren't here.
const KIMI_WIRE_TYPES: &[&str] = &["openai", "openai_responses", "anthropic", "kimi"];

/// Map the card's selected style to a valid Kimi `type` (default `openai`).
fn kimi_wire_type(api_style: Option<&str>) -> &'static str {
    let want = api_style.map(str::trim).unwrap_or("openai");
    KIMI_WIRE_TYPES
        .iter()
        .copied()
        .find(|&t| t == want)
        .unwrap_or("openai")
}

/// Valid as a TOML bare-ish table key + Kimi provider id.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Temp file in the same dir + fsync + rename, so a crash mid-write can never
/// leave a truncated config.toml.
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("toml.tmp");
    let mut file = std::fs::File::create(&tmp).context("creating kimi config.toml temp file")?;
    file.write_all(contents.as_bytes())
        .context("writing kimi config.toml temp file")?;
    file.sync_all()
        .context("syncing kimi config.toml temp file")?;
    drop(file);
    std::fs::rename(&tmp, path).context("replacing kimi config.toml")
}

fn save_document(doc: &DocumentMut) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("creating kimi-code home")?;
    }
    write_atomic(&path, &doc.to_string())
}

/// Top-level table, created implicit when absent so no bare `[providers]`
/// header is emitted — matching Kimi's own dotted-section output.
fn ensure_table<'a>(doc: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table> {
    doc.as_table_mut()
        .entry(key)
        .or_insert_with(|| {
            let mut table = Table::new();
            table.set_implicit(true);
            Item::Table(table)
        })
        .as_table_mut()
        .with_context(|| format!("kimi config.toml `{key}` is not a table"))
}

/// Merge a provider + its models into the config CST. Tolerant of an
/// incomplete provider (empty base URL / no models) so the unified card's
/// incremental, fill-as-you-go writes don't error — mirrors the OpenCode
/// file backend. Re-writing the same id replaces that provider's blocks;
/// comments and unrelated sections are preserved (toml_edit CST).
fn merge_provider(doc: &mut DocumentMut, provider: &CustomProvider) -> Result<()> {
    let id = provider.id.trim();
    if !is_valid_id(id) {
        anyhow::bail!("provider id may only contain letters, digits, `-` and `_`");
    }
    let wire = kimi_wire_type(provider.api_style.as_deref());

    let providers = ensure_table(doc, "providers")?;
    let mut block = Table::new();
    block["type"] = toml_edit::value(wire);
    // Persist the display name so it round-trips (Kimi ignores unknown keys).
    let name = provider.name.trim();
    if !name.is_empty() {
        block["name"] = toml_edit::value(name);
    }
    block["api_key"] = toml_edit::value(provider.api_key.trim());
    block["base_url"] = toml_edit::value(provider.base_url.trim());
    providers.insert(id, Item::Table(block));

    // Drop this provider's prior model rows, then re-add the current set.
    remove_models_for(doc, id)?;
    let models = ensure_table(doc, "models")?;
    let mut seen = std::collections::HashSet::new();
    for model in &provider.models {
        let slug = model.slug.trim();
        // Kimi's `<id>/<model>` alias key can't contain `/` or whitespace; skip
        // models that can't be represented rather than corrupt the config.
        if slug.is_empty()
            || slug.contains('/')
            || slug.chars().any(char::is_whitespace)
            || !seen.insert(slug.to_string())
        {
            continue;
        }
        let label = if model.label.trim().is_empty() {
            slug
        } else {
            model.label.trim()
        };
        let mut entry = Table::new();
        entry["provider"] = toml_edit::value(id);
        entry["model"] = toml_edit::value(slug);
        entry["display_name"] = toml_edit::value(label);
        entry["max_context_size"] = toml_edit::value(DEFAULT_MAX_CONTEXT_SIZE);
        models.insert(&format!("{id}/{slug}"), Item::Table(entry));
    }
    Ok(())
}

/// Drop every `[models."<id>/*"]` whose `provider == id`.
fn remove_models_for(doc: &mut DocumentMut, id: &str) -> Result<()> {
    let Some(models) = doc
        .as_table_mut()
        .get_mut("models")
        .and_then(Item::as_table_mut)
    else {
        return Ok(());
    };
    let to_remove: Vec<String> = models
        .iter()
        .filter(|(_, item)| {
            item.as_table()
                .and_then(|t| t.get("provider"))
                .and_then(|v| v.as_str())
                == Some(id)
        })
        .map(|(k, _)| k.to_string())
        .collect();
    for key in to_remove {
        models.remove(&key);
    }
    Ok(())
}

// ── Backend ─────────────────────────────────────────────────────────────────

pub struct KimiBackend;

impl CustomProviderBackend for KimiBackend {
    fn list(&self) -> Vec<CustomProvider> {
        read_custom_providers().unwrap_or_default()
    }

    fn upsert(&self, provider: CustomProvider) -> Result<()> {
        let _guard = CONFIG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut doc = read_document()?;
        merge_provider(&mut doc, &provider)?;
        save_document(&doc)
    }

    fn remove(&self, id: &str) -> Result<()> {
        let _guard = CONFIG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut doc = read_document()?;
        remove_models_for(&mut doc, id)?;
        if let Some(providers) = doc
            .as_table_mut()
            .get_mut("providers")
            .and_then(Item::as_table_mut)
        {
            providers.remove(id);
        }
        save_document(&doc)
    }
}

/// Which model-listing API a provider `type` speaks. The two shapes differ in
/// path AND auth, so picking wrong yields a 404 (or 401).
#[derive(Debug, PartialEq, Eq)]
enum ModelsApi {
    /// `GET {base}/v1/models` + `x-api-key` / `anthropic-version`.
    Anthropic,
    /// `GET {base}/models` + `Authorization: Bearer` (base_url includes `/v1`).
    OpenAiCompatible,
}

/// Map a Kimi wire `type` to its model-listing API. `openai`, `openai_responses`
/// (Responses API shares `/v1/models`), and `kimi` (Moonshot's OpenAI-shaped
/// API) all list models the OpenAI way; only `anthropic` differs.
fn models_api_for(wire_type: &str) -> ModelsApi {
    match wire_type {
        "anthropic" => ModelsApi::Anthropic,
        _ => ModelsApi::OpenAiCompatible,
    }
}

/// Fetch a custom provider's models, using the listing API that matches its
/// configured `type` (see [`models_api_for`]).
pub async fn fetch_models(
    base_url: &str,
    api_key: &str,
    api_style: Option<&str>,
) -> Result<Vec<CustomProviderModel>> {
    match models_api_for(kimi_wire_type(api_style)) {
        ModelsApi::Anthropic => super::claude::fetch_models(base_url, api_key).await,
        ModelsApi::OpenAiCompatible => super::codex::fetch_models(base_url, api_key).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_empty_config() {
        let cfg = parse_provider_config(r#"{"providers":{},"models":{}}"#).unwrap();
        assert!(cfg.providers.is_empty());
        assert!(cfg.models.is_empty());
    }

    #[test]
    fn blank_body_is_treated_as_empty() {
        let cfg = parse_provider_config("   ").unwrap();
        assert!(cfg.providers.is_empty());
        assert!(cfg.models.is_empty());
    }

    #[test]
    fn parses_real_provider_config_shape() {
        let raw = r#"{
            "providers": {
                "deepseek": { "type": "openai", "api_key": "sk", "base_url": "https://api.deepseek.com" }
            },
            "models": {
                "deepseek/deepseek-v4-pro": { "provider": "deepseek", "model": "deepseek-v4-pro", "display_name": "DeepSeek V4 Pro" },
                "deepseek/deepseek-chat": { "provider": "deepseek", "model": "deepseek-chat", "display_name": "DeepSeek Chat" }
            }
        }"#;
        let cfg = parse_provider_config(raw).unwrap();
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].id, "deepseek");
        assert_eq!(cfg.providers[0].model_count, 2);
        assert_eq!(cfg.models.len(), 2);
    }

    fn doc_with_existing() -> DocumentMut {
        r#"# managed by kimi — edited by hand
default_model = "kimi-for-coding"

[providers.anthropic] # imported earlier
type = "anthropic"
api_key = "sk-existing"
base_url = "https://api.anthropic.com"

[models."anthropic/claude-opus-4-8"]
provider = "anthropic"
model = "claude-opus-4-8"
display_name = "Claude Opus 4.8"
max_context_size = 200000

[some_future_section]
keep = true
"#
        .parse()
        .unwrap()
    }

    fn hundun() -> CustomProvider {
        CustomProvider {
            id: "hundun".into(),
            name: "Hundun".into(),
            base_url: "http://rmb.hundun.cn/v1".into(),
            api_key: "ea509e".into(),
            models: vec![CustomProviderModel {
                slug: "deepseek-v4-pro".into(),
                label: "DeepSeek V4 Pro".into(),
                effort_levels: Vec::new(),
            }],
            ..Default::default()
        }
    }

    #[test]
    fn merge_writes_kimi_schema_and_preserves_existing() {
        let mut doc = doc_with_existing();
        merge_provider(&mut doc, &hundun()).unwrap();

        assert_eq!(doc["providers"]["hundun"]["type"].as_str(), Some("openai"));
        assert_eq!(
            doc["providers"]["hundun"]["base_url"].as_str(),
            Some("http://rmb.hundun.cn/v1")
        );
        let model = &doc["models"]["hundun/deepseek-v4-pro"];
        assert_eq!(model["provider"].as_str(), Some("hundun"));
        assert_eq!(model["display_name"].as_str(), Some("DeepSeek V4 Pro"));
        assert!(model["max_context_size"]
            .as_integer()
            .is_some_and(|n| n > 0));

        // Pre-existing anthropic provider + comments untouched.
        assert_eq!(
            doc["providers"]["anthropic"]["api_key"].as_str(),
            Some("sk-existing")
        );
        let written = doc.to_string();
        assert!(written.contains("# managed by kimi — edited by hand"));
        assert!(written.contains("[some_future_section]"));
    }

    #[test]
    fn merge_tolerates_incomplete_provider() {
        // The unified card writes a blank slot first, then fills it in. An empty
        // base URL / no models must NOT error (mirrors the OpenCode backend).
        let mut doc = DocumentMut::new();
        let blank = CustomProvider {
            id: "a1b2c3d4".into(),
            ..Default::default()
        };
        merge_provider(&mut doc, &blank).unwrap();
        assert_eq!(doc["providers"]["a1b2c3d4"]["base_url"].as_str(), Some(""));
    }

    #[test]
    fn merge_rejects_invalid_id() {
        for bad in ["has space", "a/b", "semi;colon", ""] {
            let mut doc = DocumentMut::new();
            assert!(
                merge_provider(
                    &mut doc,
                    &CustomProvider {
                        id: bad.into(),
                        ..hundun()
                    }
                )
                .is_err(),
                "id {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn merge_skips_unrepresentable_model_slugs() {
        let mut doc = DocumentMut::new();
        let p = CustomProvider {
            id: "ppio".into(),
            base_url: "http://x/v1".into(),
            models: vec![
                CustomProviderModel {
                    slug: "good-model".into(),
                    ..Default::default()
                },
                CustomProviderModel {
                    slug: "ppio/pa/slash".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        merge_provider(&mut doc, &p).unwrap();
        assert!(doc["models"]
            .as_table()
            .unwrap()
            .contains_key("ppio/good-model"));
        // The `/`-containing slug can't be a Kimi alias → skipped, not written.
        assert_eq!(doc["models"].as_table().unwrap().len(), 1);
    }

    #[test]
    fn re_upsert_replaces_models_not_appends() {
        let mut doc = DocumentMut::new();
        merge_provider(&mut doc, &hundun()).unwrap();
        let mut updated = hundun();
        updated.models = vec![CustomProviderModel {
            slug: "deepseek-chat".into(),
            ..Default::default()
        }];
        merge_provider(&mut doc, &updated).unwrap();
        let models = doc["models"].as_table().unwrap();
        assert!(models.contains_key("hundun/deepseek-chat"));
        assert!(
            !models.contains_key("hundun/deepseek-v4-pro"),
            "stale model row from the previous write must be dropped"
        );
    }

    #[test]
    fn remove_models_for_drops_only_matching_provider() {
        let mut doc = doc_with_existing();
        merge_provider(&mut doc, &hundun()).unwrap();
        remove_models_for(&mut doc, "hundun").unwrap();
        let models = doc["models"].as_table().unwrap();
        assert!(!models.contains_key("hundun/deepseek-v4-pro"));
        // The unrelated provider's model survives.
        assert!(models.contains_key("anthropic/claude-opus-4-8"));
    }

    #[test]
    fn merge_writes_selected_type_and_persists_name() {
        let mut doc = DocumentMut::new();
        let mut p = hundun();
        p.api_style = Some("anthropic".to_string());
        merge_provider(&mut doc, &p).unwrap();
        assert_eq!(
            doc["providers"]["hundun"]["type"].as_str(),
            Some("anthropic")
        );
        // Name persists so it round-trips instead of falling back to the id.
        assert_eq!(doc["providers"]["hundun"]["name"].as_str(), Some("Hundun"));

        // Unknown / unset style falls back to openai.
        let mut q = hundun();
        q.id = "q".into();
        q.api_style = Some("bogus".into());
        merge_provider(&mut doc, &q).unwrap();
        assert_eq!(doc["providers"]["q"]["type"].as_str(), Some("openai"));
    }

    #[test]
    fn wire_type_validates_against_known_set() {
        assert_eq!(kimi_wire_type(Some("anthropic")), "anthropic");
        assert_eq!(kimi_wire_type(Some("openai_responses")), "openai_responses");
        assert_eq!(kimi_wire_type(Some("vertexai")), "openai"); // unsupported → default
        assert_eq!(kimi_wire_type(None), "openai");
    }

    #[test]
    fn models_api_routes_each_supported_type() {
        // anthropic uses the Anthropic listing API; every other supported type
        // (openai / openai_responses / kimi) uses the OpenAI-compatible one.
        assert_eq!(models_api_for("anthropic"), ModelsApi::Anthropic);
        for t in ["openai", "openai_responses", "kimi"] {
            assert_eq!(models_api_for(t), ModelsApi::OpenAiCompatible, "{t}");
        }
        // Routing is driven through the same clamp fetch_models uses, so an
        // unknown style falls back to the OpenAI shape (not anthropic).
        assert_eq!(
            models_api_for(kimi_wire_type(Some("google-genai"))),
            ModelsApi::OpenAiCompatible,
        );
    }
}
