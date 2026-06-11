//! Manage Kimi Code's LLM providers. Discovery (`list`), catalog import
//! (`catalog add`), registry import (`add`) and removal (`remove`) all delegate
//! to the `kimi provider` CLI. The one case the CLI does NOT cover — a raw
//! OpenAI/Anthropic-compatible endpoint (base URL + key + model) — is written
//! directly into `${KIMI_CODE_HOME:-~/.kimi-code}/config.toml` in the exact
//! `[providers.<id>]` / `[models."<id>/<model>"]` shape Kimi itself emits, then
//! managed back through the CLI (`list` / `remove`).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use toml_edit::{DocumentMut, Item, Table};

/// A configured provider, surfaced in the Settings "Custom Providers" list.
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

// Mirrors `system_commands::resolve_agent_binary("kimi")` — not shared because
// that helper is private to the commands layer (agents must not depend on it).
fn kimi_bin() -> PathBuf {
    crate::sidecar::resolve_bundled_agent_paths()
        .kimi_bin
        .unwrap_or_else(|| crate::platform::executable::resolve_for_spawn("kimi"))
}

fn run_kimi(args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new(kimi_bin());
    crate::platform::process::configure_background_cli(&mut command);
    command
        .args(args)
        .output()
        .context("failed to run the kimi CLI — is it installed / on PATH?")
}

fn require_success(output: &std::process::Output, action: &str) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        &stdout
    } else {
        &stderr
    };
    // Full output (often a 30-line Node stack trace) goes to the log only;
    // the UI gets the one meaningful line.
    tracing::warn!("kimi {action} failed:\n{detail}");
    anyhow::bail!("kimi {action} failed: {}", error_summary(detail));
}

/// First meaningful line of CLI failure output: the `KimiError: …` line when
/// present, else the first non-empty line.
fn error_summary(detail: &str) -> &str {
    let lines = || detail.lines().map(str::trim);
    lines()
        .find(|line| line.contains("KimiError:"))
        .or_else(|| lines().find(|line| !line.is_empty()))
        .unwrap_or("(no output)")
}

/// `kimi provider list --json` → configured providers + models.
pub fn read_provider_config() -> Result<KimiProviderConfig> {
    let output = run_kimi(&["provider", "list", "--json"])?;
    require_success(&output, "provider list")?;
    parse_provider_config(&String::from_utf8_lossy(&output.stdout))
}

/// Import a known provider from the public models.dev catalog by id.
pub fn add_catalog_provider(provider_id: &str, api_key: &str) -> Result<()> {
    let output = run_kimi(&[
        "provider",
        "catalog",
        "add",
        provider_id,
        "--api-key",
        api_key,
    ])?;
    require_success(&output, "provider catalog add")
}

/// Import every provider listed in a custom registry (`api.json`) URL. The
/// CLI exits 1 without a key ("Missing API key"), so it is required here.
pub fn add_registry(url: &str, api_key: &str) -> Result<()> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        anyhow::bail!("an API key is required to import a registry");
    }
    let output = run_kimi(&["provider", "add", url, "--api-key", api_key])?;
    require_success(&output, "provider add")
}

/// Remove a provider and every model alias that referenced it.
pub fn remove_provider(provider_id: &str) -> Result<()> {
    let output = run_kimi(&["provider", "remove", provider_id])?;
    require_success(&output, "provider remove")
}

/// Parse `kimi provider list --json`. Observed shape:
/// ```json
/// { "providers": { "deepseek": { "type": "openai", "apiKey": "...", "baseUrl": "..." } },
///   "models": { "deepseek/deepseek-v4-pro": { "provider": "deepseek", "model": "...",
///                                             "displayName": "DeepSeek V4 Pro" } } }
/// ```
/// The model map key (`<provider>/<model>`) is the selection id; the provider
/// entry carries no friendly name, so the provider label falls back to its id.
pub fn parse_provider_config(raw: &str) -> Result<KimiProviderConfig> {
    let body = if raw.trim().is_empty() { "{}" } else { raw };
    let value: Value =
        serde_json::from_str(body).context("parsing `kimi provider list --json` output")?;

    // Models first — they carry the per-provider grouping the model-count needs.
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
                .get("displayName")
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
            // Provider entries are `{type, apiKey, baseUrl}` — no friendly name.
            let label = entry
                .get("displayName")
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

/// A raw OpenAI/Anthropic-compatible endpoint, written straight into
/// `config.toml` (the `kimi provider` CLI has no command for this case).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderInput {
    pub id: String,
    pub base_url: String,
    pub api_key: String,
    /// `"openai"` (default) or `"anthropic"`.
    pub wire_type: String,
    pub models: Vec<CustomModelInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomModelInput {
    pub id: String,
    /// Kimi REQUIRES a positive `max_context_size` per model or it rejects the
    /// whole config — default to a safe window when the caller omits it.
    pub max_context_size: Option<u64>,
}

/// Fallback model context window (tokens) when the user doesn't specify one.
const DEFAULT_MAX_CONTEXT_SIZE: i64 = 128_000;

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

/// Serializes config.toml read-modify-write cycles within this process.
static CONFIG_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Write a `[providers.<id>]` + `[models."<id>/<model>"]` block into
/// `config.toml`, merging into (never clobbering) any existing config. Re-run
/// for the same id overwrites that provider's block. Comments and unrelated
/// sections are preserved verbatim (toml_edit CST), and the file is replaced
/// atomically (temp file + rename).
pub fn add_custom_provider(input: &CustomProviderInput) -> Result<()> {
    let _guard = CONFIG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = config_path()?;
    let mut doc: DocumentMut = if path.exists() {
        std::fs::read_to_string(&path)
            .context("reading kimi config.toml")?
            .parse()
            .context("parsing kimi config.toml")?
    } else {
        DocumentMut::new()
    };
    merge_custom_provider(&mut doc, input)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("creating kimi-code home")?;
    }
    write_atomic(&path, &doc.to_string())
}

/// Temp file in the same directory + fsync + rename, so a crash mid-write can
/// never leave a truncated config.toml.
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

/// Merge a `[providers.<id>]` + `[models."<id>/<model>"]` block into `doc`
/// (the parsed config CST), leaving everything else untouched. Split out from
/// the file I/O so it's unit-testable without touching disk or `$KIMI_CODE_HOME`.
fn merge_custom_provider(doc: &mut DocumentMut, input: &CustomProviderInput) -> Result<()> {
    let id = input.id.trim();
    if id.is_empty() {
        anyhow::bail!("provider id is required");
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        anyhow::bail!("provider id may only contain letters, digits, `-` and `_`");
    }
    let base_url = input.base_url.trim();
    if base_url.is_empty() {
        anyhow::bail!("base URL is required");
    }
    let model_inputs: Vec<&CustomModelInput> = input
        .models
        .iter()
        .filter(|m| !m.id.trim().is_empty())
        .collect();
    if model_inputs.is_empty() {
        anyhow::bail!("at least one model id is required");
    }
    for model in &model_inputs {
        let model_id = model.id.trim();
        if model_id.contains('/') || model_id.chars().any(char::is_whitespace) {
            anyhow::bail!("model id must not contain `/` or whitespace: `{model_id}`");
        }
    }
    let wire = if input.wire_type.trim() == "anthropic" {
        "anthropic"
    } else {
        "openai"
    };

    let providers = ensure_table(doc, "providers")?;
    let mut provider_block = Table::new();
    provider_block["type"] = toml_edit::value(wire);
    provider_block["api_key"] = toml_edit::value(input.api_key.trim());
    provider_block["base_url"] = toml_edit::value(base_url);
    providers.insert(id, Item::Table(provider_block));

    let models = ensure_table(doc, "models")?;
    for model in model_inputs {
        let model_id = model.id.trim();
        let max_context = model
            .max_context_size
            .map(|n| n as i64)
            .filter(|&n| n > 0)
            .unwrap_or(DEFAULT_MAX_CONTEXT_SIZE);
        let mut entry = Table::new();
        entry["provider"] = toml_edit::value(id);
        entry["model"] = toml_edit::value(model_id);
        // Kimi requires the field; derived from the model id (no input field).
        entry["display_name"] = toml_edit::value(model_id);
        entry["max_context_size"] = toml_edit::value(max_context);
        models.insert(&format!("{id}/{model_id}"), Item::Table(entry));
    }
    Ok(())
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
    fn blank_output_is_treated_as_empty() {
        let cfg = parse_provider_config("   ").unwrap();
        assert!(cfg.providers.is_empty());
        assert!(cfg.models.is_empty());
    }

    #[test]
    fn parses_real_provider_list_shape() {
        // Exactly the shape `kimi provider list --json` emits (observed from a
        // real `provider catalog add`): models keyed `<provider>/<model>` with a
        // `provider` field; provider entries carry no name; model count is
        // derived from the models map.
        let raw = r#"{
            "providers": {
                "deepseek": { "type": "openai", "apiKey": "sk", "baseUrl": "https://api.deepseek.com" }
            },
            "models": {
                "deepseek/deepseek-v4-pro": { "provider": "deepseek", "model": "deepseek-v4-pro", "displayName": "DeepSeek V4 Pro" },
                "deepseek/deepseek-chat": { "provider": "deepseek", "model": "deepseek-chat", "displayName": "DeepSeek Chat" }
            }
        }"#;
        let cfg = parse_provider_config(raw).unwrap();
        assert_eq!(cfg.providers.len(), 1);
        let deepseek = &cfg.providers[0];
        assert_eq!(deepseek.id, "deepseek");
        // No friendly name in the provider entry → label falls back to the id.
        assert_eq!(deepseek.label, "deepseek");
        assert_eq!(deepseek.model_count, 2);

        assert_eq!(cfg.models.len(), 2);
        let pro = cfg
            .models
            .iter()
            .find(|m| m.id == "deepseek/deepseek-v4-pro")
            .unwrap();
        assert_eq!(pro.label, "DeepSeek V4 Pro");
        assert_eq!(pro.provider_id, "deepseek");
    }

    fn hundun_input() -> CustomProviderInput {
        CustomProviderInput {
            id: "hundun".into(),
            base_url: "http://rmb.hundun.cn/v1".into(),
            api_key: "ea509e".into(),
            wire_type: "openai".into(),
            models: vec![CustomModelInput {
                id: "deepseek-v4-pro".into(),
                max_context_size: None,
            }],
        }
    }

    #[test]
    fn merge_custom_provider_writes_kimi_schema_and_preserves_existing() {
        // Pre-existing provider from a prior `catalog add` must survive the merge.
        let mut doc: DocumentMut = r#"
[providers.anthropic]
type = "anthropic"
api_key = "sk-existing"
base_url = "https://api.anthropic.com"

[models."anthropic/claude-opus-4-8"]
provider = "anthropic"
model = "claude-opus-4-8"
display_name = "Claude Opus 4.8"
"#
        .parse()
        .unwrap();

        merge_custom_provider(&mut doc, &hundun_input()).unwrap();

        // The custom provider block matches Kimi's own emitted schema.
        let provider = &doc["providers"]["hundun"];
        assert_eq!(provider["type"].as_str(), Some("openai"));
        assert_eq!(provider["api_key"].as_str(), Some("ea509e"));
        assert_eq!(
            provider["base_url"].as_str(),
            Some("http://rmb.hundun.cn/v1")
        );
        let model = &doc["models"]["hundun/deepseek-v4-pro"];
        assert_eq!(model["provider"].as_str(), Some("hundun"));
        assert_eq!(model["model"].as_str(), Some("deepseek-v4-pro"));
        // No display-name input — derived from the model id.
        assert_eq!(model["display_name"].as_str(), Some("deepseek-v4-pro"));
        // Kimi rejects a model without a positive max_context_size, so it must
        // always be written (default when the caller omits one).
        assert!(model["max_context_size"]
            .as_integer()
            .is_some_and(|n| n > 0));

        // The pre-existing anthropic provider + model are untouched.
        assert_eq!(
            doc["providers"]["anthropic"]["api_key"].as_str(),
            Some("sk-existing")
        );
        assert!(doc["models"]
            .as_table()
            .unwrap()
            .contains_key("anthropic/claude-opus-4-8"));

        // It round-trips through serialize → reparse → parse_provider_config.
        let reparsed: toml::Table = toml::from_str(&doc.to_string()).unwrap();
        let as_json = serde_json::to_string(&reparsed).unwrap();
        let cfg = parse_provider_config(&as_json).unwrap();
        assert_eq!(cfg.providers.len(), 2);
        assert!(cfg.models.iter().any(|m| m.id == "hundun/deepseek-v4-pro"));
    }

    #[test]
    fn merge_custom_provider_preserves_comments_and_unrelated_sections() {
        // A realistic user config: comments, default_model, a section Helmor
        // doesn't know about. The write must not reformat or reorder any of it.
        let original = r#"# managed by kimi — edited by hand
default_model = "kimi-for-coding"

[providers.anthropic] # imported via catalog add
type = "anthropic"
api_key = "sk-existing" # rotate quarterly
base_url = "https://api.anthropic.com"

[some_future_section]
keep = true
"#;
        let mut doc: DocumentMut = original.parse().unwrap();
        merge_custom_provider(&mut doc, &hundun_input()).unwrap();
        let written = doc.to_string();
        // Every original line — comments included — survives byte-for-byte.
        for line in original.lines() {
            assert!(written.contains(line), "lost original line: {line:?}");
        }
        assert!(written.contains("[providers.hundun]"));
        assert!(written.contains(r#"[models."hundun/deepseek-v4-pro"]"#));
    }

    #[test]
    fn merge_custom_provider_rejects_missing_fields() {
        let mut doc = DocumentMut::new();
        let base = hundun_input();
        assert!(merge_custom_provider(
            &mut doc,
            &CustomProviderInput {
                id: "  ".into(),
                ..base.clone()
            }
        )
        .is_err());
        assert!(merge_custom_provider(
            &mut doc,
            &CustomProviderInput {
                base_url: "".into(),
                ..base.clone()
            }
        )
        .is_err());
        assert!(merge_custom_provider(
            &mut doc,
            &CustomProviderInput {
                models: vec![],
                ..base
            }
        )
        .is_err());
    }

    #[test]
    fn merge_custom_provider_rejects_invalid_ids() {
        let base = hundun_input();
        // Provider id is restricted to `[A-Za-z0-9_-]+`.
        for bad in ["has space", "a/b", "ütf", "semi;colon"] {
            assert!(
                merge_custom_provider(
                    &mut DocumentMut::new(),
                    &CustomProviderInput {
                        id: bad.into(),
                        ..base.clone()
                    }
                )
                .is_err(),
                "provider id {bad:?} should be rejected"
            );
        }
        // Model ids must not smuggle `/` (the alias separator) or whitespace.
        for bad in ["a/b", "a b", "a\tb"] {
            assert!(
                merge_custom_provider(
                    &mut DocumentMut::new(),
                    &CustomProviderInput {
                        models: vec![CustomModelInput {
                            id: bad.into(),
                            max_context_size: None
                        }],
                        ..base.clone()
                    }
                )
                .is_err(),
                "model id {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn error_summary_surfaces_one_line_not_the_node_stack() {
        let dump = "node:internal/modules/run_main:122\nKimiError: Missing API key\n    at run (cli.js:10:3)";
        assert_eq!(error_summary(dump), "KimiError: Missing API key");
        assert_eq!(error_summary("\n  plain failure\nmore"), "plain failure");
        assert_eq!(error_summary("  \n"), "(no output)");
    }
}
