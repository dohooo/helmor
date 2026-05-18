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

pub fn static_model_sections() -> Vec<AgentModelSection> {
    model_sections_for_inputs(
        super::custom_providers::configured_models(),
        load_cursor_prefs(),
    )
}

/// Inputs-driven helper used by tests; production goes through
/// `static_model_sections`.
fn model_sections_for_inputs(
    custom: Vec<super::custom_providers::ClaudeProviderModel>,
    cursor_prefs: Option<CursorPrefs>,
) -> Vec<AgentModelSection> {
    let mut claude_section = official_claude_section();
    claude_section
        .options
        .extend(custom_provider_options(custom));
    let mut sections = vec![claude_section];
    sections.push(codex_section());
    sections.push(cursor_section_from_prefs(cursor_prefs));

    sections
}

fn official_claude_section() -> AgentModelSection {
    AgentModelSection {
        id: "claude".to_string(),
        label: "Claude Code".to_string(),
        status: AgentModelSectionStatus::Ready,
        options: vec![
            claude_model(
                "default",
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
            codex_model("gpt-5.3-codex", "GPT-5.3-Codex"),
            codex_model("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"),
            codex_model("gpt-5.2", "GPT-5.2"),
        ],
    }
}

/// Cursor picker section, driven by `app.cursor_provider` settings:
/// `enabledModelIds` (user picks; `null` → auto-fill on next fetch) and
/// `cachedModels` (last `Cursor.models.list` snapshot). When both are
/// absent, fall back to the SDK-guaranteed `Auto` entry.
fn cursor_section_from_prefs(prefs: Option<CursorPrefs>) -> AgentModelSection {
    let options = match prefs {
        Some(prefs) => expand_cursor_options(prefs),
        None => vec![cursor_default_auto()],
    };
    AgentModelSection {
        id: "cursor".to_string(),
        label: "Cursor".to_string(),
        status: AgentModelSectionStatus::Ready,
        options,
    }
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
    enabled_ids: Option<Vec<String>>,
    cached_models: Option<Vec<(String, CursorCachedModelEntry)>>,
}

fn load_cursor_prefs() -> Option<CursorPrefs> {
    let raw = crate::models::settings::load_setting_value("app.cursor_provider")
        .ok()
        .flatten()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;

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
    custom: Vec<super::custom_providers::ClaudeProviderModel>,
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

/// Resolved model info needed by the streaming path.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub id: String,
    pub provider: String,
    pub cli_model: String,
    pub supports_effort: bool,
    pub claude_base_url: Option<String>,
    pub claude_auth_token: Option<String>,
}

/// Resolve a Helmor model id to provider + cli_model. `provider_hint`
/// is the inbound request's provider field (tie-breaker for ambiguous
/// ids); falls back to prefix inference (`cursor-`/`composer-` →
/// cursor, `gpt-` → codex, else claude). For cursor, strips the
/// `cursor-` namespace before handing `cli_model` to the SDK.
pub fn resolve_model(model_id: &str, provider_hint: Option<&str>) -> ResolvedModel {
    if let Some(model) = super::custom_providers::resolve(model_id) {
        return ResolvedModel {
            id: model.id,
            provider: "claude".to_string(),
            cli_model: model.cli_model,
            supports_effort: true,
            claude_base_url: Some(model.base_url),
            claude_auth_token: Some(model.api_key),
        };
    }

    let provider = match provider_hint {
        Some("cursor") => "cursor",
        Some("codex") => "codex",
        Some("claude") => "claude",
        _ if model_id.starts_with("cursor-") => "cursor",
        _ if model_id.starts_with("composer-") => "cursor",
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_model_sections_returns_hardcoded_catalog() {
        // `None` cursor_prefs → cursor section degrades to just Auto.
        let sections = model_sections_for_inputs(Vec::new(), None);

        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].id, "claude");
        assert_eq!(sections[0].status, AgentModelSectionStatus::Ready);
        assert_eq!(
            sections[0]
                .options
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["default", "claude-opus-4-6[1m]", "sonnet", "haiku"]
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
            vec![
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.3-codex",
                "gpt-5.3-codex-spark",
                "gpt-5.2",
            ]
        );
        assert!(sections[1]
            .options
            .iter()
            .all(|model| model.supports_fast_mode));

        assert_eq!(sections[2].id, "cursor");
        assert_eq!(sections[2].status, AgentModelSectionStatus::Ready);
        // Without an `app.cursor_provider` row in the test DB, the Cursor
        // section degrades to the hard fallback: a single Auto entry.
        // Helmor id is the namespaced `cursor-default`; cli_model is the
        // bare `default` Cursor's SDK expects.
        let auto = &sections[2].options[0];
        assert_eq!(auto.id, "cursor-default");
        assert_eq!(auto.cli_model, "default");
        assert_eq!(auto.provider, "cursor");
        assert_eq!(sections[2].options.len(), 1);
    }

    #[test]
    fn custom_provider_models_append_to_official_claude_section() {
        let sections = model_sections_for_inputs(
            vec![super::super::custom_providers::ClaudeProviderModel {
                id: "claude-custom|minimax|MiniMax-M2.7".to_string(),
                provider_key: "minimax".to_string(),
                label: "MiniMax M2.7".to_string(),
                cli_model: "MiniMax-M2.7".to_string(),
                base_url: "https://api.minimax.io/anthropic".to_string(),
                api_key: "sk-test".to_string(),
            }],
            None,
        );

        assert_eq!(sections.len(), 3);
        assert_eq!(sections[0].id, "claude");
        assert_eq!(sections[0].label, "Claude Code");
        assert_eq!(
            sections[0]
                .options
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "default",
                "claude-opus-4-6[1m]",
                "sonnet",
                "haiku",
                "claude-custom|minimax|MiniMax-M2.7",
            ]
        );
        assert_eq!(
            sections[0].options[4].provider_key.as_deref(),
            Some("minimax")
        );
        assert_eq!(
            sections[0].options[4].effort_levels,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert!(!sections[0].options[4].supports_context_usage);
        assert_eq!(sections[1].id, "codex");
    }

    #[test]
    fn resolve_claude_model() {
        let m = resolve_model("default", None);
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "default");
        assert_eq!(m.id, "default");
        assert!(m.supports_effort);
    }

    #[test]
    fn resolve_opus_model() {
        let m = resolve_model("opus", None);
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "opus");
    }

    #[test]
    fn resolve_sonnet_model() {
        let m = resolve_model("sonnet", None);
        assert_eq!(m.provider, "claude");
    }

    #[test]
    fn resolve_gpt_model_routes_to_codex() {
        let m = resolve_model("gpt-4o", None);
        assert_eq!(m.provider, "codex");
        assert_eq!(m.cli_model, "gpt-4o");
    }

    #[test]
    fn resolve_gpt_5_4_routes_to_codex() {
        let m = resolve_model("gpt-5.4", None);
        assert_eq!(m.provider, "codex");
    }

    #[test]
    fn resolve_unknown_model_defaults_to_claude() {
        let m = resolve_model("some-future-model", None);
        assert_eq!(m.provider, "claude");
        assert_eq!(m.cli_model, "some-future-model");
    }

    #[test]
    fn resolve_composer_routes_to_cursor() {
        let m = resolve_model("composer-2", None);
        assert_eq!(m.provider, "cursor");
        assert_eq!(m.cli_model, "composer-2");
    }

    #[test]
    fn cursor_namespaced_id_strips_to_wire_for_cli_model() {
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
    fn claude_default_no_longer_collides_with_cursor_auto() {
        // `default` belongs to Claude (Opus 4.7 1M). Cursor's Auto is
        // `cursor-default`. They MUST resolve to different providers
        // even when the picker / persistence flow doesn't pass a hint —
        // this is the regression the namespace prefix exists to prevent.
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
    fn cursor_section_derives_effort_levels_from_cached_parameters() {
        // Real-world shape: gpt-5.3-codex via Cursor exposes a `reasoning`
        // enum but no `fast`. The composer should show the effort
        // dropdown with exactly those levels, and no Fast toggle.
        let prefs = CursorPrefs {
            enabled_ids: Some(vec!["gpt-5.3-codex".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "gpt-5.3-codex",
                "Codex 5.3",
                Some(vec![cursor_param("reasoning", &["low", "medium", "high"])]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
            enabled_ids: Some(vec!["composer-2".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "composer-2",
                "Composer 2",
                Some(vec![cursor_param("fast", &["true", "false"])]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
            enabled_ids: Some(vec!["claude-haiku".to_string()]),
            cached_models: Some(vec![cursor_cache(
                "claude-haiku",
                "Haiku",
                Some(vec![cursor_param("thinking", &["false", "true"])]),
            )]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert_eq!(opt.effort_levels, vec!["low", "medium", "high", "max"]);
        assert!(opt.supports_fast_mode);
    }

    #[test]
    fn cursor_section_effort_takes_precedence_over_reasoning_when_both_present() {
        // Defensive: if both `effort` (Claude shape) and `reasoning`
        // (GPT shape) somehow appear on the same model, `effort` wins.
        let prefs = CursorPrefs {
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
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
        let opt = &sections.iter().find(|s| s.id == "cursor").unwrap().options[0];
        assert_eq!(opt.effort_levels, vec!["max"]);
    }

    #[test]
    fn cursor_section_supports_both_effort_and_fast_when_present() {
        let prefs = CursorPrefs {
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
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
            enabled_ids: Some(vec!["legacy".to_string()]),
            cached_models: Some(vec![cursor_cache("legacy", "Legacy Cached", None)]),
        };
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
            enabled_ids: Some(vec!["mystery-model".to_string()]),
            cached_models: Some(Vec::new()),
        };
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
            enabled_ids: Some(pick.iter().map(|s| s.to_string()).collect()),
            cached_models: Some(cached_models),
        };
        let sections = model_sections_for_inputs(Vec::new(), Some(prefs));
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
        // gpt-5.3-codex exists in both Codex and Cursor; the request's
        // provider field is the tie-break. (Cursor's namespaced form
        // would be `cursor-gpt-5.3-codex`, which obviates the hint —
        // but bare ids may still arrive via legacy / external callers.)
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
