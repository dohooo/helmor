use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub cli_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_key: Option<String>,
    /// Always serialized (even when empty) so the frontend can
    /// distinguish "model doesn't support effort" (`[]`) from "model
    /// metadata not loaded yet" (`undefined`). The settings panel uses
    /// the empty case to disable the effort dropdown.
    #[serde(default)]
    pub effort_levels: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub supports_fast_mode: bool,
    pub supports_context_usage: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentModelSectionStatus {
    Ready,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSection {
    pub id: String,
    pub label: String,
    pub status: AgentModelSectionStatus,
    pub options: Vec<AgentModelOption>,
}

/// The composer/CLI picker catalog: full catalog with the user's model
/// selection applied. Empty sections are omitted.
pub fn static_model_sections() -> Vec<AgentModelSection> {
    let claude_enabled = load_enabled_model_ids("app.claude_enabled_model_ids");
    let codex_enabled = load_enabled_model_ids("app.codex_enabled_model_ids");
    // Each custom Codex provider gets its own `codex:<id>` section, not merged
    // into Codex; all gated by the unified `codex_enabled` list.
    let mut sections = apply_official_enabled_filter(
        model_sections_for_inputs(
            crate::provider::claude::configured_models(),
            Vec::new(),
            load_cursor_prefs(),
            load_opencode_prefs(),
            load_mimo_prefs(),
        ),
        claude_enabled.as_deref(),
        codex_enabled.as_deref(),
    );
    let custom = codex_custom_sections(
        crate::provider::codex::load_providers(),
        codex_enabled.as_deref(),
    );
    if !custom.is_empty() {
        let at = sections
            .iter()
            .position(|section| section.id == "codex")
            .or_else(|| sections.iter().position(|section| section.id == "claude"))
            .map(|i| i + 1)
            .unwrap_or(sections.len());
        for (offset, section) in custom.into_iter().enumerate() {
            sections.insert(at + offset, section);
        }
    }
    drop_empty_sections(sections)
}

/// Full unfiltered catalog for the Settings "Models" multi-selects. Custom
/// Codex providers are merged into the Codex section here (unlike the composer).
pub fn full_catalog_sections() -> Vec<AgentModelSection> {
    model_sections_for_inputs(
        crate::provider::claude::configured_models(),
        codex_custom_catalog_options(crate::provider::codex::load_providers()),
        load_cursor_prefs(),
        load_opencode_prefs(),
        load_mimo_prefs(),
    )
}

fn load_enabled_model_ids(key: &str) -> Option<Vec<String>> {
    // null/absent → None (all enabled); `[]` → Some(empty) (none enabled).
    crate::settings::load_setting_json::<Vec<String>>(key)
        .ok()
        .flatten()
}

/// Apply each official family's enabled-id filter to its own section's options.
/// `claude`/`codex` track separate enabled lists; other sections pass through.
/// Sections left without models are hidden later by `drop_empty_sections`.
fn apply_official_enabled_filter(
    sections: Vec<AgentModelSection>,
    claude_enabled: Option<&[String]>,
    codex_enabled: Option<&[String]>,
) -> Vec<AgentModelSection> {
    sections
        .into_iter()
        .map(|mut section| {
            match section.id.as_str() {
                "claude" => section
                    .options
                    .retain(|opt| crate::provider::is_enabled(claude_enabled, &opt.id)),
                "codex" => section
                    .options
                    .retain(|opt| crate::provider::is_enabled(codex_enabled, &opt.id)),
                _ => {}
            }
            section
        })
        .collect()
}

/// Hide every section with no models, regardless of provider, so the composer
/// never renders an empty group.
fn drop_empty_sections(sections: Vec<AgentModelSection>) -> Vec<AgentModelSection> {
    sections
        .into_iter()
        .filter(|section| !section.options.is_empty())
        .collect()
}

/// One section per custom Codex provider, filtered by `codex_enabled` (full
/// `codex:<id>|<wire>` ids). Providers with no enabled models are omitted.
fn codex_custom_sections(
    providers: Vec<crate::provider::CustomProvider>,
    codex_enabled: Option<&[String]>,
) -> Vec<AgentModelSection> {
    let mut sections = Vec::new();
    for provider in providers {
        let instance_id = provider.id.trim();
        if instance_id.is_empty() || provider.base_url.trim().is_empty() {
            continue;
        }
        let provider_id = crate::provider::codex::provider_id(instance_id);
        let label = if provider.name.trim().is_empty() {
            format!("Codex · {instance_id}")
        } else {
            provider.name.trim().to_string()
        };
        let mut options = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for model in &provider.models {
            let wire = model.slug.trim();
            if wire.is_empty() || !seen.insert(wire.to_string()) {
                continue;
            }
            let model_id = crate::provider::codex::model_id(instance_id, wire);
            if !crate::provider::is_enabled(codex_enabled, &model_id) {
                continue;
            }
            let model_label = if model.label.trim().is_empty() {
                wire
            } else {
                model.label.trim()
            };
            options.push(codex_custom_model(
                instance_id,
                &provider_id,
                wire,
                model_label,
            ));
        }
        if options.is_empty() {
            continue;
        }
        sections.push(AgentModelSection {
            id: provider_id,
            label,
            status: AgentModelSectionStatus::Ready,
            options,
        });
    }
    sections
}

/// Flat unfiltered list of every custom Codex model, for the Settings picker.
/// Custom models merge into the Codex section here, so each label is prefixed
/// with its provider name (`Name · model`) — otherwise a custom `gpt-5.5` is
/// indistinguishable from the official one. Mirrors OpenCode's labelling.
fn codex_custom_catalog_options(
    providers: Vec<crate::provider::CustomProvider>,
) -> Vec<AgentModelOption> {
    let mut out = Vec::new();
    for provider in providers {
        let instance_id = provider.id.trim();
        if instance_id.is_empty() || provider.base_url.trim().is_empty() {
            continue;
        }
        let provider_id = crate::provider::codex::provider_id(instance_id);
        let prefix = if provider.name.trim().is_empty() {
            instance_id
        } else {
            provider.name.trim()
        };
        let mut seen = std::collections::HashSet::new();
        for model in &provider.models {
            let wire = model.slug.trim();
            if wire.is_empty() || !seen.insert(wire.to_string()) {
                continue;
            }
            let model_label = if model.label.trim().is_empty() {
                wire
            } else {
                model.label.trim()
            };
            out.push(codex_custom_model(
                instance_id,
                &provider_id,
                wire,
                &format!("{prefix} · {model_label}"),
            ));
        }
    }
    out
}

fn codex_custom_model(
    instance_id: &str,
    provider_id: &str,
    wire_model: &str,
    label: &str,
) -> AgentModelOption {
    AgentModelOption {
        id: crate::provider::codex::model_id(instance_id, wire_model),
        provider: provider_id.to_string(),
        label: label.to_string(),
        cli_model: wire_model.to_string(),
        provider_key: None,
        effort_levels: ["low", "medium", "high", "xhigh"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        // serviceTier=fast is a ChatGPT-only feature; custom endpoints ignore/reject it.
        supports_fast_mode: false,
        supports_context_usage: true,
    }
}

/// Inputs-driven helper used by tests; production goes through
/// `static_model_sections`.
fn model_sections_for_inputs(
    custom: Vec<crate::provider::claude::ClaudeProviderModel>,
    codex_custom: Vec<AgentModelOption>,
    cursor_prefs: Option<CursorPrefs>,
    opencode_prefs: Option<OpencodePrefs>,
    mimo_prefs: Option<OpencodePrefs>,
) -> Vec<AgentModelSection> {
    let mut claude_section = official_claude_section();
    claude_section
        .options
        .extend(custom_provider_options(custom));
    let mut sections = vec![claude_section];
    let mut codex = codex_section();
    codex.options.extend(codex_custom);
    sections.push(codex);
    sections.push(opencode_section_from_prefs(opencode_prefs));
    sections.push(mimo_section_from_prefs(mimo_prefs));
    if let Some(cursor) = cursor_section_from_prefs(cursor_prefs) {
        sections.push(cursor);
    }

    sections
}

fn official_claude_section() -> AgentModelSection {
    AgentModelSection {
        id: "claude".to_string(),
        label: "Claude Code".to_string(),
        status: AgentModelSectionStatus::Ready,
        options: vec![
            // Fable 5 leads the list as the most capable pick, but it burns
            // limits ~2x faster than Opus — `useEnsureDefaultModel` therefore
            // pins the app default to the Opus 4.8 entry below, NOT
            // to options[0]. No fast mode (Opus 4.6+ only).
            claude_model(
                "claude-fable-5[1m]",
                "Fable 5 1M",
                &["low", "medium", "high", "xhigh", "max"],
                false,
            ),
            // App default selection (see `useEnsureDefaultModel`, which pins
            // this id). Pinned to the explicit `claude-opus-4-8[1m]` wire id —
            // the `[1m]` suffix selects the 1M-context variant, matching the
            // label. We do NOT use the CLI's `default` sentinel: it resolves to
            // whatever the bundled claude-code decides (non-deterministic
            // across CLI bumps), whereas a pinned id is stable. Bump when a
            // newer Opus ships. MUST stay in sync with
            // `sidecar/src/model-catalog.ts`.
            claude_model(
                "claude-opus-4-8[1m]",
                "Opus 4.8 1M",
                &["low", "medium", "high", "xhigh", "max"],
                true,
            ),
            // Explicit 4.7 pin, above 4.6.
            claude_model(
                "claude-opus-4-7[1m]",
                "Opus 4.7 1M",
                &["low", "medium", "high", "xhigh", "max"],
                false,
            ),
            claude_model(
                "claude-opus-4-6[1m]",
                "Opus 4.6 1M",
                &["low", "medium", "high", "max"],
                true,
            ),
            claude_model("sonnet", "Sonnet", &["low", "medium", "high", "max"], false),
            claude_model("haiku", "Haiku", &[], false),
        ],
    }
}

fn codex_section() -> AgentModelSection {
    AgentModelSection {
        id: "codex".to_string(),
        label: "Codex".to_string(),
        status: AgentModelSectionStatus::Ready,
        options: vec![
            codex_model("gpt-5.5", "GPT-5.5"),
            codex_model("gpt-5.4", "GPT-5.4"),
            codex_model("gpt-5.4-mini", "GPT-5.4-Mini"),
        ],
    }
}

// Fully dynamic from `app.opencode_provider`; no static seed. Empty `connected` → Unavailable.
fn opencode_section_from_prefs(prefs: Option<OpencodePrefs>) -> AgentModelSection {
    slug_section_from_prefs(prefs, "opencode", "OpenCode")
}

// MiMo Code (opencode fork) — same shape, driven by `app.mimo_provider`.
fn mimo_section_from_prefs(prefs: Option<OpencodePrefs>) -> AgentModelSection {
    slug_section_from_prefs(prefs, "mimo", "MiMo Code")
}

fn slug_section_from_prefs(
    prefs: Option<OpencodePrefs>,
    provider: &str,
    label: &str,
) -> AgentModelSection {
    let (status, options) = match prefs {
        Some(prefs) if !prefs.connected.is_empty() => (
            AgentModelSectionStatus::Ready,
            expand_slug_options(provider, prefs),
        ),
        _ => (AgentModelSectionStatus::Unavailable, Vec::new()),
    };
    AgentModelSection {
        id: provider.to_string(),
        label: label.to_string(),
        status,
        options,
    }
}

/// Prefs shape shared by the opencode-protocol providers (opencode + mimo);
/// both persist the same JSON under their own settings key.
#[derive(Debug, Clone)]
struct OpencodePrefs {
    connected: Vec<String>,
    enabled_ids: Option<Vec<String>>,
    cached_models: Option<Vec<OpencodeCachedModelEntry>>,
}

#[derive(Debug, Clone)]
struct OpencodeCachedModelEntry {
    slug: String,
    label: String,
    // opencode `variants` keys; empty ⟺ no effort dropdown.
    effort_levels: Vec<String>,
}

fn load_opencode_prefs() -> Option<OpencodePrefs> {
    load_slug_prefs("app.opencode_provider")
}

fn load_mimo_prefs() -> Option<OpencodePrefs> {
    load_slug_prefs("app.mimo_provider")
}

fn load_slug_prefs(setting_key: &str) -> Option<OpencodePrefs> {
    let raw = crate::models::settings::load_setting_value(setting_key)
        .ok()
        .flatten()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let connected = match parsed.get("connected") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    let enabled_ids = match parsed.get("enabledModelIds") {
        Some(serde_json::Value::Array(arr)) => Some(
            arr.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    };
    let cached_models = match parsed.get("cachedModels") {
        Some(serde_json::Value::Array(arr)) => {
            let mut out: Vec<OpencodeCachedModelEntry> = Vec::with_capacity(arr.len());
            for item in arr {
                let Some(slug) = item.get("slug").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let label = item
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(slug)
                    .to_string();
                let effort_levels = item
                    .get("effortLevels")
                    .and_then(serde_json::Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(OpencodeCachedModelEntry {
                    slug: slug.to_string(),
                    label,
                    effort_levels,
                });
            }
            Some(out)
        }
        _ => None,
    };

    Some(OpencodePrefs {
        connected,
        enabled_ids,
        cached_models,
    })
}

// `enabledModelIds == null` → default-all cached models; explicit empty list → no options.
fn expand_slug_options(provider: &str, prefs: OpencodePrefs) -> Vec<AgentModelOption> {
    let cache = prefs.cached_models.unwrap_or_default();
    match prefs.enabled_ids {
        None => cache
            .iter()
            .map(|entry| {
                slug_model(
                    provider,
                    &entry.slug,
                    &entry.label,
                    entry.effort_levels.clone(),
                )
            })
            .collect(),
        Some(enabled) => enabled
            .iter()
            .map(|slug| {
                let entry = cache.iter().find(|entry| &entry.slug == slug);
                let label = entry
                    .map(|e| e.label.clone())
                    .unwrap_or_else(|| slug.clone());
                let effort_levels = entry.map(|e| e.effort_levels.clone()).unwrap_or_default();
                slug_model(provider, slug, &label, effort_levels)
            })
            .collect(),
    }
}

/// Cursor picker section, driven by `app.cursor_provider`. Mirrors the Settings
/// list: present only when an API key is set AND at least one model resolves.
/// No key (or an emptied pick list) → omitted, so the composer stays in sync.
fn cursor_section_from_prefs(prefs: Option<CursorPrefs>) -> Option<AgentModelSection> {
    let prefs = prefs?;
    prefs.api_key.as_ref()?;
    let options = expand_cursor_options(prefs);
    if options.is_empty() {
        return None;
    }
    Some(AgentModelSection {
        id: "cursor".to_string(),
        label: "Cursor".to_string(),
        status: AgentModelSectionStatus::Ready,
        options,
    })
}

#[derive(Debug, Clone)]
struct CursorCachedModelEntry {
    label: String,
    /// Raw `parameters[]`. `None` on legacy entries (no toolbar UI until refresh).
    parameters: Option<Vec<CursorCachedParameter>>,
}

#[derive(Debug, Clone)]
struct CursorCachedParameter {
    id: String,
    values: Vec<String>,
}

#[derive(Debug, Clone)]
struct CursorPrefs {
    api_key: Option<String>,
    enabled_ids: Option<Vec<String>>,
    cached_models: Option<Vec<(String, CursorCachedModelEntry)>>,
}

fn load_cursor_prefs() -> Option<CursorPrefs> {
    let raw = crate::models::settings::load_setting_value("app.cursor_provider")
        .ok()
        .flatten()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let api_key = parsed
        .get("apiKey")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string);
    let enabled_ids = match parsed.get("enabledModelIds") {
        Some(serde_json::Value::Array(arr)) => Some(
            arr.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
        ),
        _ => None,
    };
    let cached_models = match parsed.get("cachedModels") {
        Some(serde_json::Value::Array(arr)) => {
            let mut out: Vec<(String, CursorCachedModelEntry)> = Vec::with_capacity(arr.len());
            for item in arr {
                let Some(id) = item.get("id").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let label = item
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(id)
                    .to_string();
                let parameters = item
                    .get("parameters")
                    .and_then(serde_json::Value::as_array)
                    .map(|values| parse_cached_parameters(values.as_slice()));
                out.push((id.to_string(), CursorCachedModelEntry { label, parameters }));
            }
            Some(out)
        }
        _ => None,
    };

    Some(CursorPrefs {
        api_key,
        enabled_ids,
        cached_models,
    })
}

fn parse_cached_parameters(arr: &[serde_json::Value]) -> Vec<CursorCachedParameter> {
    arr.iter()
        .filter_map(|entry| {
            let id = entry
                .get("id")
                .and_then(serde_json::Value::as_str)?
                .to_string();
            let values = entry
                .get("values")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|v| {
                            v.get("value")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string)
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(CursorCachedParameter { id, values })
        })
        .collect()
}

fn expand_cursor_options(prefs: CursorPrefs) -> Vec<AgentModelOption> {
    // No user picks yet (auto-selection hasn't fired) → degrade to Auto.
    let Some(enabled) = prefs.enabled_ids else {
        return vec![cursor_default_auto()];
    };
    if enabled.is_empty() {
        // User explicitly emptied the list — respect it.
        return Vec::new();
    }
    // `enabled`/`cache` store wire ids verbatim; `cursor_model` namespaces.
    let cache = prefs.cached_models.unwrap_or_default();
    enabled
        .iter()
        .map(|wire_id| {
            let entry = cache.iter().find(|(cid, _)| cid == wire_id).map(|(_, e)| e);
            let label = entry
                .map(|e| e.label.clone())
                .unwrap_or_else(|| wire_id.clone());
            let caps = entry
                .and_then(|e| e.parameters.as_deref())
                .map(derive_capabilities)
                .unwrap_or_default();
            let effort_refs: Vec<&str> = caps.effort_levels.iter().map(String::as_str).collect();
            cursor_model(wire_id, &label, &effort_refs, caps.supports_fast_mode)
        })
        .collect()
}

#[derive(Debug, Default, Clone)]
struct CursorCapabilities {
    effort_levels: Vec<String>,
    supports_fast_mode: bool,
}

/// Derive toolbar capabilities. `effort` (Claude) wins over `reasoning`
/// (GPT). `thinking` is auto-enabled sidecar-side, not surfaced here.
fn derive_capabilities(parameters: &[CursorCachedParameter]) -> CursorCapabilities {
    let mut caps = CursorCapabilities::default();
    let mut effort_via_reasoning: Option<Vec<String>> = None;
    for param in parameters {
        match param.id.as_str() {
            "effort" => caps.effort_levels = param.values.clone(),
            "reasoning" if effort_via_reasoning.is_none() => {
                effort_via_reasoning = Some(param.values.clone());
            }
            "fast" => caps.supports_fast_mode = true,
            _ => {}
        }
    }
    if caps.effort_levels.is_empty() {
        if let Some(levels) = effort_via_reasoning {
            caps.effort_levels = levels;
        }
    }
    caps
}

fn cursor_default_auto() -> AgentModelOption {
    cursor_model("default", "Auto", &[], false)
}

fn custom_provider_options(
    custom: Vec<crate::provider::claude::ClaudeProviderModel>,
) -> Vec<AgentModelOption> {
    custom
        .into_iter()
        .map(|model| AgentModelOption {
            id: model.id,
            provider: "claude".to_string(),
            label: model.label,
            cli_model: model.cli_model,
            provider_key: Some(model.provider_key),
            effort_levels: claude_effort_levels(),
            supports_fast_mode: false,
            supports_context_usage: false,
        })
        .collect()
}

fn claude_model(
    id: &str,
    label: &str,
    effort_levels: &[&str],
    supports_fast_mode: bool,
) -> AgentModelOption {
    AgentModelOption {
        id: id.to_string(),
        provider: "claude".to_string(),
        label: label.to_string(),
        cli_model: id.to_string(),
        provider_key: None,
        effort_levels: effort_levels
            .iter()
            .map(|level| level.to_string())
            .collect(),
        supports_fast_mode,
        supports_context_usage: true,
    }
}

fn codex_model(id: &str, label: &str) -> AgentModelOption {
    AgentModelOption {
        id: id.to_string(),
        provider: "codex".to_string(),
        label: label.to_string(),
        cli_model: id.to_string(),
        provider_key: None,
        effort_levels: ["low", "medium", "high", "xhigh"]
            .into_iter()
            .map(str::to_string)
            .collect(),
        supports_fast_mode: true,
        supports_context_usage: true,
    }
}

// `id`/`cli_model` are both the `provider/model` slug; `effort_levels` map to opencode `variants`.
fn slug_model(
    provider: &str,
    slug: &str,
    label: &str,
    effort_levels: Vec<String>,
) -> AgentModelOption {
    AgentModelOption {
        id: slug.to_string(),
        provider: provider.to_string(),
        label: label.to_string(),
        cli_model: slug.to_string(),
        provider_key: None,
        effort_levels,
        supports_fast_mode: false,
        supports_context_usage: true,
    }
}

/// Build a Cursor option. Cursor wire ids collide with claude/codex
/// (e.g. `default` = Claude Opus), so Helmor `id` is namespaced
/// `cursor-<wire>`; `cli_model` keeps the bare wire id for `agent.send`.
fn cursor_model(
    wire_id: &str,
    label: &str,
    effort_levels: &[&str],
    supports_fast_mode: bool,
) -> AgentModelOption {
    AgentModelOption {
        id: namespaced_cursor_id(wire_id),
        provider: "cursor".to_string(),
        label: label.to_string(),
        cli_model: wire_id.to_string(),
        provider_key: None,
        effort_levels: effort_levels
            .iter()
            .map(|level| level.to_string())
            .collect(),
        supports_fast_mode,
        // No context-usage endpoint in Cursor SDK; hide the ring.
        supports_context_usage: false,
    }
}

/// Idempotent `cursor-` prefix.
fn namespaced_cursor_id(wire_id: &str) -> String {
    if wire_id.starts_with("cursor-") {
        wire_id.to_string()
    } else {
        format!("cursor-{wire_id}")
    }
}

fn claude_effort_levels() -> Vec<String> {
    ["low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// Custom Codex provider config injected per-thread by the sidecar.
#[derive(Debug, Clone)]
pub struct CodexProviderConfig {
    /// Bare provider id used as Codex `modelProvider`.
    pub id: String,
    pub base_url: String,
    pub api_key: String,
    pub wire_api: String,
    /// Wire model name sent verbatim to the endpoint.
    pub wire_model: String,
}

/// Resolved model info needed by the streaming path.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub id: String,
    pub provider: String,
    pub cli_model: String,
    pub supports_effort: bool,
    pub claude_base_url: Option<String>,
    pub claude_auth_token: Option<String>,
    pub codex_provider: Option<CodexProviderConfig>,
}

impl ResolvedModel {
    /// Sidecar manager key. All Codex-family providers collapse to `"codex"`.
    pub fn sidecar_provider(&self) -> &str {
        if self.provider.starts_with("codex") {
            "codex"
        } else {
            &self.provider
        }
    }
}

/// Resolve a Helmor model id to provider + cli_model. `provider_hint`
/// is the inbound request's provider field (tie-breaker for ambiguous
/// ids); falls back to prefix inference (`cursor-`/`composer-` →
/// cursor, `gpt-` → codex, else claude). For cursor, strips the
/// `cursor-` namespace before handing `cli_model` to the SDK.
pub fn resolve_model(model_id: &str, provider_hint: Option<&str>) -> ResolvedModel {
    if let Some(model) = crate::provider::claude::resolve(model_id) {
        return ResolvedModel {
            id: model.id,
            provider: "claude".to_string(),
            cli_model: model.cli_model,
            supports_effort: true,
            claude_base_url: Some(model.base_url),
            claude_auth_token: Some(model.api_key),
            codex_provider: None,
        };
    }

    if let Some(model) = crate::provider::codex::resolve(model_id) {
        return ResolvedModel {
            id: model.id,
            provider: model.provider,
            cli_model: model.cli_model.clone(),
            supports_effort: true,
            claude_base_url: None,
            claude_auth_token: None,
            codex_provider: Some(CodexProviderConfig {
                id: model.instance_id,
                base_url: model.base_url,
                api_key: model.api_key,
                wire_api: "responses".to_string(),
                wire_model: model.cli_model,
            }),
        };
    }

    let codex_prefix = crate::provider::codex::PROVIDER_PREFIX;
    let provider = match provider_hint {
        Some("cursor") => "cursor",
        Some("codex") => "codex",
        Some("claude") => "claude",
        Some("opencode") => "opencode",
        Some("mimo") => "mimo",
        // `codex:<id>` reaches here only when its settings were removed;
        // route to codex so the `/` doesn't mis-infer to opencode.
        Some(hint) if hint.starts_with(codex_prefix) => "codex",
        _ if model_id.starts_with(codex_prefix) => "codex",
        _ if model_id.starts_with("cursor-") => "cursor",
        _ if model_id.starts_with("composer-") => "cursor",
        // `/` marks an opencode-protocol slug (claude uses `|`, codex/cursor
        // have none). Hint-less `/` ids default to opencode — mimo sessions
        // always carry the provider hint, so this fallback never fires for
        // them in practice.
        _ if model_id.contains('/') => "opencode",
        _ if model_id.starts_with("gpt-") => "codex",
        _ => "claude",
    };

    // Strip `cursor-` for SDK; `composer-*` had no prefix.
    let cli_model = if provider == "cursor" {
        model_id
            .strip_prefix("cursor-")
            .unwrap_or(model_id)
            .to_string()
    } else {
        model_id.to_string()
    };

    ResolvedModel {
        id: model_id.to_string(),
        provider: provider.to_string(),
        cli_model,
        supports_effort: true,
        claude_base_url: None,
        claude_auth_token: None,
        codex_provider: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_model_sections_returns_hardcoded_catalog() {
        // `None` cursor_prefs (no API key) → cursor section omitted entirely.
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, None, None);

        assert_eq!(sections.len(), 4);
        assert_eq!(sections[0].id, "claude");
        assert_eq!(sections[0].status, AgentModelSectionStatus::Ready);
        assert_eq!(
            sections[0]
                .options
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "claude-fable-5[1m]",
                "claude-opus-4-8[1m]",
                "claude-opus-4-7[1m]",
                "claude-opus-4-6[1m]",
                "sonnet",
                "haiku"
            ]
        );
        assert!(sections[0]
            .options
            .iter()
            .any(|model| model.id == "claude-opus-4-6[1m]" && model.supports_fast_mode));

        assert_eq!(sections[1].id, "codex");
        assert_eq!(sections[1].status, AgentModelSectionStatus::Ready);
        assert_eq!(
            sections[1]
                .options
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.5", "gpt-5.4", "gpt-5.4-mini",]
        );
        assert!(sections[1]
            .options
            .iter()
            .all(|model| model.supports_fast_mode));

        // No opencode prefs row → Unavailable, no options.
        assert_eq!(sections[2].id, "opencode");
        assert_eq!(sections[2].status, AgentModelSectionStatus::Unavailable);
        assert!(sections[2].options.is_empty());

        // No mimo prefs row → Unavailable, no options.
        assert_eq!(sections[3].id, "mimo");
        assert_eq!(sections[3].label, "MiMo Code");
        assert_eq!(sections[3].status, AgentModelSectionStatus::Unavailable);
        assert!(sections[3].options.is_empty());

        // No `app.cursor_provider` row → no API key → no Cursor section.
        assert!(sections.iter().all(|s| s.id != "cursor"));
    }

    #[test]
    fn custom_provider_models_append_to_official_claude_section() {
        let sections = model_sections_for_inputs(
            vec![crate::provider::claude::ClaudeProviderModel {
                id: "claude-custom|minimax|MiniMax-M2.7".to_string(),
                provider_key: "minimax".to_string(),
                label: "MiniMax M2.7".to_string(),
                cli_model: "MiniMax-M2.7".to_string(),
                base_url: "https://api.minimax.io/anthropic".to_string(),
                api_key: "sk-test".to_string(),
            }],
            Vec::new(),
            None,
            None,
            None,
        );

        assert_eq!(sections.len(), 4);
        assert_eq!(sections[0].id, "claude");
        assert_eq!(sections[0].label, "Claude Code");
        assert_eq!(
            sections[0]
                .options
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "claude-fable-5[1m]",
                "claude-opus-4-8[1m]",
                "claude-opus-4-7[1m]",
                "claude-opus-4-6[1m]",
                "sonnet",
                "haiku",
                "claude-custom|minimax|MiniMax-M2.7",
            ]
        );
        assert_eq!(
            sections[0].options[6].provider_key.as_deref(),
            Some("minimax")
        );
        assert_eq!(
            sections[0].options[6].effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert!(!sections[0].options[6].supports_context_usage);
        assert_eq!(sections[1].id, "codex");
    }

    #[test]
    fn resolve_claude_model() {
        let _env = crate::testkit::TestEnv::new("resolve-claude-model");
        // The pinned Opus 4.8 1M id resolves to itself.
        let m = resolve_model("claude-opus-4-8[1m]", None);
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "claude-opus-4-8[1m]");
        assert_eq!(m.id, "claude-opus-4-8[1m]");
        assert!(m.supports_effort);
    }

    #[test]
    fn resolve_opus_model() {
        let _env = crate::testkit::TestEnv::new("resolve-opus-model");
        let m = resolve_model("opus", None);
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "opus");
    }

    #[test]
    fn resolve_sonnet_model() {
        let _env = crate::testkit::TestEnv::new("resolve-sonnet-model");
        let m = resolve_model("sonnet", None);
        assert_eq!(m.provider, "claude");
    }

    #[test]
    fn resolve_gpt_model_routes_to_codex() {
        let _env = crate::testkit::TestEnv::new("resolve-gpt-model-routes-to-codex");
        let m = resolve_model("gpt-4o", None);
        assert_eq!(m.provider, "codex");
        assert_eq!(m.cli_model, "gpt-4o");
    }

    #[test]
    fn resolve_gpt_5_4_routes_to_codex() {
        let _env = crate::testkit::TestEnv::new("resolve-gpt-5-4-routes-to-codex");
        let m = resolve_model("gpt-5.4", None);
        assert_eq!(m.provider, "codex");
    }

    fn codex_custom(id: &str, name: &str, models: &[&str]) -> crate::provider::CustomProvider {
        crate::provider::CustomProvider {
            id: id.to_string(),
            name: name.to_string(),
            base_url: "http://example.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            models: models
                .iter()
                .map(|m| crate::provider::CustomProviderModel {
                    slug: m.to_string(),
                    label: String::new(),
                    ..Default::default()
                })
                .collect(),
            enabled_model_ids: None,
            ..Default::default()
        }
    }

    #[test]
    fn codex_custom_sections_one_per_provider() {
        let sections = codex_custom_sections(
            vec![codex_custom(
                "hundun",
                "Codex (Hundun)",
                &["gpt-5.5", "gpt-5.4"],
            )],
            None,
        );
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].id, "codex:hundun");
        assert_eq!(sections[0].label, "Codex (Hundun)");
        assert_eq!(sections[0].status, AgentModelSectionStatus::Ready);
        let opt = &sections[0].options[0];
        assert_eq!(opt.id, "codex:hundun|gpt-5.5");
        assert_eq!(opt.provider, "codex:hundun");
        assert_eq!(opt.cli_model, "gpt-5.5");
        assert!(!opt.supports_fast_mode);
        assert!(opt.supports_context_usage);
        assert_eq!(opt.effort_levels, vec!["low", "medium", "high", "xhigh"]);
    }

    #[test]
    fn codex_custom_section_skips_provider_without_models() {
        let sections = codex_custom_sections(vec![codex_custom("empty", "Empty", &[])], None);
        assert!(sections.is_empty());
    }

    #[test]
    fn codex_custom_section_label_falls_back_to_id() {
        let sections = codex_custom_sections(vec![codex_custom("hundun", "", &["gpt-5.5"])], None);
        assert_eq!(sections[0].label, "Codex · hundun");
    }

    #[test]
    fn codex_custom_section_respects_enabled_subset() {
        let provider = codex_custom("hundun", "Hundun", &["gpt-5.5", "gpt-5.4"]);
        let sections =
            codex_custom_sections(vec![provider], Some(&["codex:hundun|gpt-5.4".to_string()]));
        assert_eq!(sections.len(), 1);
        assert_eq!(
            sections[0]
                .options
                .iter()
                .map(|o| o.cli_model.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.4"]
        );
    }

    #[test]
    fn codex_custom_catalog_options_prefixes_label_with_provider_name() {
        // Merged into the Codex section, so the name prefix disambiguates a
        // custom `gpt-5.5` from the official one.
        let opts =
            codex_custom_catalog_options(vec![codex_custom("hundun", "Hundun", &["gpt-5.5"])]);
        assert_eq!(opts.len(), 1);
        assert_eq!(opts[0].label, "Hundun · gpt-5.5");
        assert_eq!(opts[0].id, "codex:hundun|gpt-5.5");
    }

    #[test]
    fn codex_custom_catalog_options_prefix_falls_back_to_id() {
        let opts = codex_custom_catalog_options(vec![codex_custom("hundun", "", &["gpt-5.5"])]);
        assert_eq!(opts[0].label, "hundun · gpt-5.5");
    }

    #[test]
    fn official_filter_keeps_enabled_subset() {
        let base = model_sections_for_inputs(Vec::new(), Vec::new(), None, None, None);
        let filtered = apply_official_enabled_filter(base, None, Some(&["gpt-5.5".to_string()]));
        let codex = filtered.iter().find(|s| s.id == "codex").unwrap();
        assert_eq!(
            codex
                .options
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.5"]
        );
        let claude = filtered.iter().find(|s| s.id == "claude").unwrap();
        assert!(claude.options.len() > 1, "claude untouched when None");
    }

    #[test]
    fn official_filter_empty_list_empties_options() {
        let base = model_sections_for_inputs(Vec::new(), Vec::new(), None, None, None);
        let filtered = apply_official_enabled_filter(base, Some(&[]), None);
        // The filter only empties options; hiding the now-empty section is
        // `drop_empty_sections`' job (tested separately).
        let claude = filtered.iter().find(|s| s.id == "claude").unwrap();
        assert!(
            claude.options.is_empty(),
            "claude emptied when enabled = []"
        );
        let codex = filtered.iter().find(|s| s.id == "codex").unwrap();
        assert!(!codex.options.is_empty(), "codex untouched (None = all)");
    }

    #[test]
    fn drop_empty_sections_hides_any_section_without_models() {
        let section = |id: &str, options: Vec<AgentModelOption>| AgentModelSection {
            id: id.to_string(),
            label: id.to_string(),
            status: AgentModelSectionStatus::Ready,
            options,
        };
        let kept = drop_empty_sections(vec![
            section("alpha", vec![codex_model("m1", "M1")]),
            section("beta", Vec::new()),
            section("gamma", vec![codex_model("m2", "M2")]),
        ]);
        assert_eq!(
            kept.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "gamma"],
        );
    }

    #[test]
    fn sidecar_provider_collapses_codex_family() {
        let mk = |provider: &str| ResolvedModel {
            id: "x".into(),
            provider: provider.into(),
            cli_model: "x".into(),
            supports_effort: true,
            claude_base_url: None,
            claude_auth_token: None,
            codex_provider: None,
        };
        assert_eq!(mk("codex").sidecar_provider(), "codex");
        assert_eq!(mk("codex:hundun").sidecar_provider(), "codex");
        assert_eq!(mk("claude").sidecar_provider(), "claude");
        assert_eq!(mk("opencode").sidecar_provider(), "opencode");
        assert_eq!(mk("cursor").sidecar_provider(), "cursor");
    }

    #[test]
    fn resolve_codex_custom_prefix_without_settings_routes_to_codex() {
        let _env = crate::testkit::TestEnv::new("resolve-codex-custom-prefix-routes");
        // No settings → resolve() misses → must route to codex, not opencode via `/`.
        let m = resolve_model("codex:ppio|ppio/pa/gpt-5.5", Some("codex:ppio"));
        assert_eq!(m.sidecar_provider(), "codex");
    }

    #[test]
    fn resolve_unknown_model_defaults_to_claude() {
        let _env = crate::testkit::TestEnv::new("resolve-unknown-model-defaults-to-claude");
        let m = resolve_model("some-future-model", None);
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "some-future-model");
    }

    #[test]
    fn resolve_opencode_slug_routes_to_opencode() {
        let _env = crate::testkit::TestEnv::new("resolve-opencode-slug-routes-to-opencode");
        // Explicit hint.
        let m = resolve_model("anthropic/claude-opus-4-5", Some("opencode"));
        assert_eq!(m.provider, "opencode");
        assert_eq!(m.cli_model, "anthropic/claude-opus-4-5");
        assert_eq!(m.id, "anthropic/claude-opus-4-5");
        let m = resolve_model("openai/gpt-5-codex", None);
        assert_eq!(m.provider, "opencode");
        assert_eq!(m.cli_model, "openai/gpt-5-codex");
    }

    #[test]
    fn resolve_mimo_hint_routes_to_mimo() {
        let _env = crate::testkit::TestEnv::new("resolve-mimo-hint-routes-to-mimo");
        let m = resolve_model("xiaomi/mimo-v2.5-pro", Some("mimo"));
        assert_eq!(m.provider, "mimo");
        assert_eq!(m.cli_model, "xiaomi/mimo-v2.5-pro");
        assert_eq!(m.id, "xiaomi/mimo-v2.5-pro");
        // Hint-less `/` slug falls back to opencode by design — mimo sessions
        // always carry the hint (see resolve_model comment).
        let m = resolve_model("xiaomi/mimo-v2.5-pro", None);
        assert_eq!(m.provider, "opencode");
    }

    #[test]
    fn mimo_section_emits_cached_models_when_connected() {
        let prefs = OpencodePrefs {
            connected: vec!["xiaomi".to_string()],
            enabled_ids: None,
            cached_models: Some(vec![opencode_cache(
                "xiaomi/mimo-v2.5-pro",
                "Xiaomi · MiMo V2.5 Pro",
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, None, Some(prefs));
        let mimo = sections.iter().find(|s| s.id == "mimo").unwrap();
        assert_eq!(mimo.label, "MiMo Code");
        assert_eq!(mimo.status, AgentModelSectionStatus::Ready);
        let first = &mimo.options[0];
        assert_eq!(first.provider, "mimo");
        assert_eq!(first.cli_model, "xiaomi/mimo-v2.5-pro");
        assert_eq!(first.label, "Xiaomi · MiMo V2.5 Pro");
        assert!(first.supports_context_usage);
    }

    fn opencode_cache(slug: &str, label: &str) -> OpencodeCachedModelEntry {
        OpencodeCachedModelEntry {
            slug: slug.to_string(),
            label: label.to_string(),
            effort_levels: Vec::new(),
        }
    }

    fn opencode_cache_effort(
        slug: &str,
        label: &str,
        efforts: &[&str],
    ) -> OpencodeCachedModelEntry {
        OpencodeCachedModelEntry {
            slug: slug.to_string(),
            label: label.to_string(),
            effort_levels: efforts.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn opencode_section_default_all_emits_every_cached_model() {
        let prefs = OpencodePrefs {
            connected: vec!["opencode".to_string()],
            enabled_ids: None,
            cached_models: Some(vec![
                opencode_cache("opencode/big-pickle", "OpenCode Zen · Big Pickle"),
                opencode_cache("hundun/deepseek-v4-pro", "Hundun · DeepSeek V4 Pro"),
            ]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, Some(prefs), None);
        let opencode = sections.iter().find(|s| s.id == "opencode").unwrap();
        assert_eq!(opencode.status, AgentModelSectionStatus::Ready);
        assert_eq!(
            opencode
                .options
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            vec!["opencode/big-pickle", "hundun/deepseek-v4-pro"]
        );
        let first = &opencode.options[0];
        assert_eq!(first.provider, "opencode");
        assert_eq!(first.cli_model, "opencode/big-pickle");
        assert_eq!(first.label, "OpenCode Zen · Big Pickle");
        assert!(first.effort_levels.is_empty());
        assert!(!first.supports_fast_mode);
        assert!(first.supports_context_usage);
    }

    #[test]
    fn opencode_section_carries_per_model_effort_levels() {
        let prefs = OpencodePrefs {
            connected: vec!["opencode".to_string(), "hundun".to_string()],
            enabled_ids: None,
            cached_models: Some(vec![
                opencode_cache("opencode/big-pickle", "OpenCode Zen · Big Pickle"),
                opencode_cache_effort(
                    "hundun/deepseek-v4-pro",
                    "Hundun · DeepSeek V4 Pro",
                    &["low", "medium", "high", "max"],
                ),
            ]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, Some(prefs), None);
        let opencode = sections.iter().find(|s| s.id == "opencode").unwrap();
        let zen = opencode
            .options
            .iter()
            .find(|o| o.id == "opencode/big-pickle")
            .unwrap();
        let deepseek = opencode
            .options
            .iter()
            .find(|o| o.id == "hundun/deepseek-v4-pro")
            .unwrap();
        assert!(
            zen.effort_levels.is_empty(),
            "no-effort model → no dropdown"
        );
        assert_eq!(deepseek.effort_levels, vec!["low", "medium", "high", "max"]);
    }

    #[test]
    fn opencode_section_respects_enabled_subset() {
        let prefs = OpencodePrefs {
            connected: vec!["opencode".to_string(), "hundun".to_string()],
            enabled_ids: Some(vec!["hundun/deepseek-v4-pro".to_string()]),
            cached_models: Some(vec![
                opencode_cache("opencode/big-pickle", "OpenCode Zen · Big Pickle"),
                opencode_cache("hundun/deepseek-v4-pro", "Hundun · DeepSeek V4 Pro"),
            ]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, Some(prefs), None);
        let opencode = sections.iter().find(|s| s.id == "opencode").unwrap();
        assert_eq!(opencode.status, AgentModelSectionStatus::Ready);
        assert_eq!(opencode.options.len(), 1);
        assert_eq!(opencode.options[0].id, "hundun/deepseek-v4-pro");
        assert_eq!(opencode.options[0].label, "Hundun · DeepSeek V4 Pro");
    }

    #[test]
    fn opencode_section_explicit_empty_enabled_list_yields_no_options() {
        let prefs = OpencodePrefs {
            connected: vec!["opencode".to_string()],
            enabled_ids: Some(Vec::new()),
            cached_models: Some(vec![opencode_cache(
                "opencode/big-pickle",
                "OpenCode Zen · Big Pickle",
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, Some(prefs), None);
        let opencode = sections.iter().find(|s| s.id == "opencode").unwrap();
        assert_eq!(opencode.status, AgentModelSectionStatus::Ready);
        assert!(opencode.options.is_empty());
    }

    #[test]
    fn opencode_section_no_connected_providers_is_unavailable() {
        let prefs = OpencodePrefs {
            connected: Vec::new(),
            enabled_ids: None,
            cached_models: Some(vec![opencode_cache(
                "opencode/big-pickle",
                "OpenCode Zen · Big Pickle",
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, Some(prefs), None);
        let opencode = sections.iter().find(|s| s.id == "opencode").unwrap();
        assert_eq!(opencode.status, AgentModelSectionStatus::Unavailable);
        assert!(opencode.options.is_empty());
    }

    #[test]
    fn opencode_section_unknown_enabled_slug_falls_back_to_slug_label() {
        let prefs = OpencodePrefs {
            connected: vec!["opencode".to_string()],
            enabled_ids: Some(vec!["mystery/model".to_string()]),
            cached_models: Some(Vec::new()),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, Some(prefs), None);
        let opencode = sections.iter().find(|s| s.id == "opencode").unwrap();
        assert_eq!(opencode.options.len(), 1);
        assert_eq!(opencode.options[0].id, "mystery/model");
        assert_eq!(opencode.options[0].label, "mystery/model");
    }

    #[test]
    fn resolve_composer_routes_to_cursor() {
        let _env = crate::testkit::TestEnv::new("resolve-composer-routes-to-cursor");
        let m = resolve_model("composer-2", None);
        assert_eq!(m.provider, "cursor");
        assert_eq!(m.cli_model, "composer-2");
    }

    #[test]
    fn cursor_namespaced_id_strips_to_wire_for_cli_model() {
        let _env = crate::testkit::TestEnv::new("cursor-namespaced-id-strips-to-wire-for-");
        // Composer's selected model id from the picker is `cursor-default`
        // (Helmor namespace). Resolver must emit `cli_model = "default"`
        // so the SDK's `Cursor.models.list` token survives the round-trip.
        let m = resolve_model("cursor-default", Some("cursor"));
        assert_eq!(m.provider, "cursor");
        assert_eq!(m.id, "cursor-default");
        assert_eq!(m.cli_model, "default");

        // Without explicit hint, prefix inference still routes to cursor.
        let m = resolve_model("cursor-default", None);
        assert_eq!(m.provider, "cursor");
        assert_eq!(m.cli_model, "default");

        // Other namespaced cursor ids — including the ones that COLLIDE
        // with claude/codex catalog ids — strip the prefix correctly.
        let m = resolve_model("cursor-claude-sonnet-4-5", Some("cursor"));
        assert_eq!(m.provider, "cursor");
        assert_eq!(m.cli_model, "claude-sonnet-4-5");

        let m = resolve_model("cursor-gpt-5.3-codex", Some("cursor"));
        assert_eq!(m.provider, "cursor");
        assert_eq!(m.cli_model, "gpt-5.3-codex");
    }

    #[test]
    fn official_claude_section_surfaces_fable_5_above_opus_lineage() {
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), None, None, None);
        let claude = sections.iter().find(|s| s.id == "claude").unwrap();
        let ids: Vec<&str> = claude.options.iter().map(|o| o.id.as_str()).collect();
        // User-facing ordering: Fable 5 on top, then 4.8 (default), 4.7, 4.6.
        assert_eq!(
            &ids[..4],
            &[
                "claude-fable-5[1m]",
                "claude-opus-4-8[1m]",
                "claude-opus-4-7[1m]",
                "claude-opus-4-6[1m]"
            ],
            "Fable 5 must lead, with Opus 4.8 (default) / 4.7 / 4.6 beneath it"
        );

        // Fable 5: most capable, leads the list, but is NOT the app default
        // (too expensive) — `useEnsureDefaultModel` pins to the Opus 4.8 id.
        // No fast mode (Opus 4.6+ only); full effort tiers incl. xhigh.
        let fable = &claude.options[0];
        assert_eq!(fable.label, "Fable 5 1M");
        assert_eq!(fable.cli_model, "claude-fable-5[1m]");
        assert!(!fable.supports_fast_mode);
        assert_eq!(
            fable.effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );

        // Opus 4.8: the app default selection, supports fast mode, and keeps
        // the xhigh effort tier. Pinned to its explicit `[1m]` wire id.
        let default = &claude.options[1];
        assert_eq!(default.label, "Opus 4.8 1M");
        assert_eq!(default.cli_model, "claude-opus-4-8[1m]");
        assert!(default.supports_fast_mode, "Opus 4.8 supports fast mode");
        assert_eq!(
            default.effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );

        // Explicit 4.7 pin: same effort tiers as before, still no fast mode.
        let opus47 = &claude.options[2];
        assert_eq!(opus47.label, "Opus 4.7 1M");
        assert_eq!(opus47.cli_model, "claude-opus-4-7[1m]");
        assert!(!opus47.supports_fast_mode);
        assert_eq!(
            opus47.effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );

        // 4.6 unchanged.
        let opus46 = &claude.options[3];
        assert_eq!(opus46.label, "Opus 4.6 1M");
        assert!(opus46.supports_fast_mode);
    }

    #[test]
    fn claude_default_no_longer_collides_with_cursor_auto() {
        let _env = crate::testkit::TestEnv::new("claude-default-no-longer-collides-with-c");
        // A hint-less bare `default` still infers to claude; cursor's Auto is
        // the namespaced `cursor-default`. They MUST resolve to different
        // providers even without a hint — the regression the namespace prefix
        // exists to prevent. (Claude no longer ships a `default` model id; any
        // legacy occurrence is normalized by the DB migration before it gets
        // here, so resolve_model just passes it through.)
        let claude = resolve_model("default", None);
        assert_eq!(claude.provider, "claude");
        assert_eq!(claude.cli_model, "default");

        let cursor = resolve_model("cursor-default", None);
        assert_eq!(cursor.provider, "cursor");
        assert_eq!(cursor.cli_model, "default");
    }

    fn cursor_param(id: &str, values: &[&str]) -> CursorCachedParameter {
        CursorCachedParameter {
            id: id.to_string(),
            values: values.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn cursor_cache(
        wire: &str,
        label: &str,
        parameters: Option<Vec<CursorCachedParameter>>,
    ) -> (String, CursorCachedModelEntry) {
        (
            wire.to_string(),
            CursorCachedModelEntry {
                label: label.to_string(),
                parameters,
            },
        )
    }

    #[test]
    fn cursor_section_omitted_without_api_key() {
        // Key deleted in Settings → no Cursor section in the composer, even
        // though stale cached models / picks linger in the prefs.
        let prefs = CursorPrefs {
            api_key: None,
            enabled_ids: Some(vec!["gpt-5.3-codex".to_string()]),
            cached_models: Some(vec![cursor_cache("gpt-5.3-codex", "Codex 5.3", None)]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        assert!(sections.iter().all(|s| s.id != "cursor"));
    }

    #[test]
    fn cursor_section_omitted_when_picks_emptied() {
        // Key present but the user unchecked every model → omitted, matching
        // the empty Settings list (no bare "Cursor" header in the picker).
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(Vec::new()),
            cached_models: Some(vec![cursor_cache("gpt-5.3-codex", "Codex 5.3", None)]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        assert!(sections.iter().all(|s| s.id != "cursor"));
    }

    #[test]
    fn cursor_section_derives_effort_levels_from_cached_parameters() {
        // Real-world shape: gpt-5.3-codex via Cursor exposes a `reasoning`
        // enum but no `fast`. The composer should show the effort
        // dropdown with exactly those levels, and no Fast toggle.
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["gpt-5.3-codex".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "gpt-5.3-codex",
                "Codex 5.3",
                Some(vec![cursor_param("reasoning", &["low", "medium", "high"])]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let cursor = sections.iter().find(|s| s.id == "cursor").unwrap();
        assert_eq!(cursor.options.len(), 1);
        let opt = &cursor.options[0];
        assert_eq!(opt.cli_model, "gpt-5.3-codex");
        assert_eq!(opt.label, "Codex 5.3");
        assert_eq!(opt.effort_levels, vec!["low", "medium", "high"]);
        assert!(!opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_derives_fast_mode_from_cached_parameters() {
        // Composer 2: only `fast`, no reasoning. Composer toolbar should
        // show the Fast toggle but no effort dropdown.
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["composer-2".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "composer-2",
                "Composer 2",
                Some(vec![cursor_param("fast", &["true", "false"])]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let cursor = sections.iter().find(|s| s.id == "cursor").unwrap();
        let opt = &cursor.options[0];
        assert!(opt.effort_levels.is_empty());
        assert!(opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_thinking_param_does_not_surface_to_toolbar() {
        // `thinking` is Cursor's per-model boolean for Claude's extended
        // thinking. We auto-enable it sidecar-side when the model exposes
        // it; the catalog must NOT treat it as a toolbar dimension —
        // composer has no Thinking button.
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["claude-haiku".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "claude-haiku",
                "Haiku",
                Some(vec![cursor_param("thinking", &["false", "true"])]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert!(opt.effort_levels.is_empty());
        assert!(!opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_claude_lineage_exposes_effort_and_fast_only() {
        // Opus 4.6 has `effort` + `thinking` + `fast`. Catalog should
        // surface effort + fast for the toolbar; `thinking` is invisible
        // here (auto-enabled sidecar-side, no UI).
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["claude-opus-4-6".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "claude-opus-4-6",
                "Opus 4.6",
                Some(vec![
                    cursor_param("thinking", &["false", "true"]),
                    cursor_param("effort", &["low", "medium", "high", "max"]),
                    cursor_param("fast", &["false", "true"]),
                ]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert_eq!(opt.effort_levels, vec!["low", "medium", "high", "max"]);
        assert!(opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_effort_takes_precedence_over_reasoning_when_both_present() {
        // Defensive: if both `effort` (Claude shape) and `reasoning`
        // (GPT shape) somehow appear on the same model, `effort` wins.
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["weird".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "weird",
                "Weird",
                Some(vec![
                    cursor_param("effort", &["max"]),
                    cursor_param("reasoning", &["low", "medium"]),
                ]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert_eq!(opt.effort_levels, vec!["max"]);
    }

    #[test]
    fn cursor_section_supports_both_effort_and_fast_when_present() {
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["claude-sonnet-4-5".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "claude-sonnet-4-5",
                "Sonnet 4.5",
                Some(vec![
                    cursor_param("reasoning", &["low", "medium", "high"]),
                    cursor_param("fast", &["true", "false"]),
                ]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert_eq!(opt.effort_levels, vec!["low", "medium", "high"]);
        assert!(opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_degrades_when_parameters_missing_from_cache() {
        // Settings persisted before the parameters plumbing shipped have
        // `parameters: None`. We must NOT crash and we must NOT surface
        // a fake effort dropdown — the user gets the picker entry with
        // no effort/fast UI until they hit Refresh.
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["legacy".to_string()]),
            cached_models: Some(vec![cursor_cache("legacy", "Legacy Cached", None)]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert!(opt.effort_levels.is_empty());
        assert!(!opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_unknown_wire_id_falls_back_without_metadata() {
        // The user's `enabledModelIds` references a wire id that's no
        // longer in the cache (e.g. they hit Refresh after Cursor
        // retired the model). Show the bare id as label, no effort.
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(vec!["mystery-model".to_string()]),
            cached_models: Some(Vec::new()),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert_eq!(opt.cli_model, "mystery-model");
        assert_eq!(opt.label, "mystery-model");
        assert!(opt.effort_levels.is_empty());
        assert!(!opt.supports_fast_mode);
    }

    /// Pull the real `Cursor.models.list` snapshot off disk and
    /// stuff it through `load_cursor_prefs`'s parser to derive the
    /// catalog the composer would see. Pinning a few high-traffic
    /// models against the real shapes catches future regressions
    /// without relying on synthetic fixtures.
    #[test]
    fn cursor_section_matches_real_upstream_catalog_shapes() {
        let raw = include_str!("../../tests/fixtures/cursor-models/list.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).unwrap();
        let arr = parsed.as_array().unwrap();
        // Wire ids covering each capability shape.
        let pick = [
            "default",
            "composer-2",
            "gpt-5.3-codex",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-haiku-4-5",
        ];
        let cached_models: Vec<(String, CursorCachedModelEntry)> = arr
            .iter()
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?.to_string();
                let label = item.get("label")?.as_str()?.to_string();
                let parameters = item
                    .get("parameters")
                    .and_then(|v| v.as_array())
                    .map(|a| parse_cached_parameters(a.as_slice()));
                Some((id, CursorCachedModelEntry { label, parameters }))
            })
            .collect();
        let prefs = CursorPrefs {
            api_key: Some("sk-test".to_string()),
            enabled_ids: Some(pick.iter().map(|s| s.to_string()).collect()),
            cached_models: Some(cached_models),
        };
        let sections = model_sections_for_inputs(Vec::new(), Vec::new(), Some(prefs), None, None);
        let cursor = sections.iter().find(|s| s.id == "cursor").unwrap();
        let by_wire: std::collections::HashMap<String, &AgentModelOption> = cursor
            .options
            .iter()
            .map(|o| (o.cli_model.clone(), o))
            .collect();

        // Auto: nothing.
        let auto = by_wire.get("default").unwrap();
        assert!(auto.effort_levels.is_empty());
        assert!(!auto.supports_fast_mode);

        // Composer 2: only fast.
        let c2 = by_wire.get("composer-2").unwrap();
        assert!(c2.effort_levels.is_empty());
        assert!(c2.supports_fast_mode);

        // Codex 5.3: reasoning levels + fast.
        let codex = by_wire.get("gpt-5.3-codex").unwrap();
        assert_eq!(
            codex.effort_levels,
            vec!["low", "medium", "high", "extra-high"]
        );
        assert!(codex.supports_fast_mode);

        // Opus 4.7: effort levels, no fast (thinking auto-enabled sidecar-side).
        let opus47 = by_wire.get("claude-opus-4-7").unwrap();
        assert_eq!(
            opus47.effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert!(!opus47.supports_fast_mode);

        // Opus 4.6: effort + fast (thinking auto-enabled sidecar-side).
        let opus46 = by_wire.get("claude-opus-4-6").unwrap();
        assert_eq!(opus46.effort_levels, vec!["low", "medium", "high", "max"]);
        assert!(opus46.supports_fast_mode);

        // Haiku 4.5: only thinking → no toolbar dimensions visible.
        let haiku = by_wire.get("claude-haiku-4-5").unwrap();
        assert!(haiku.effort_levels.is_empty());
        assert!(!haiku.supports_fast_mode);
    }

    #[test]
    fn provider_hint_disambiguates_overlapping_ids() {
        let _env = crate::testkit::TestEnv::new("provider-hint-disambiguates-overlapping-");
        // A bare `gpt-`-prefixed id routes to Codex by prefix, but a
        // provider hint overrides that: the same id resolves to Cursor when
        // hinted. (Cursor's namespaced form `cursor-gpt-5.3-codex` obviates
        // the hint, but bare ids may still arrive via legacy / external callers.)
        let codex = resolve_model("gpt-5.3-codex", Some("codex"));
        assert_eq!(codex.provider, "codex");
        let cursor = resolve_model("gpt-5.3-codex", Some("cursor"));
        assert_eq!(cursor.provider, "cursor");

        // Same for claude-sonnet-4-5 across Claude and Cursor.
        let claude = resolve_model("claude-sonnet-4-5", Some("claude"));
        assert_eq!(claude.provider, "claude");
        let cursor = resolve_model("claude-sonnet-4-5", Some("cursor"));
        assert_eq!(cursor.provider, "cursor");
    }
}
