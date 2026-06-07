//! Provider capability contract.
//!
//! Encodes "does this provider support feature X?" as data instead of
//! `provider == "codex"` checks scattered across the codebase. The
//! frontend and the streaming layer both read off the same shape so
//! adding a new provider (Copilot/ACP via #511, Pi via #321, …) is a
//! single edit here plus a row in the test matrix below.
//!
//! Scope of this slice is intentionally narrow:
//! - shape + helper only; no new provider, no behavior change for the
//!   three providers Helmor ships today;
//! - capabilities are the ones that have real call sites today
//!   (active-goal, plan-mode, slash commands, context usage, steer,
//!   display name, permission modes). Adding a new field is cheap;
//!   adding a field with no call site is noise.

use serde::{Deserialize, Serialize};

/// Permission-mode literals the composer's dropdown surfaces. Carried
/// as `&'static str` so the order is stable and the values match the
/// SDK strings the sidecars expect on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    BypassPermissions,
}

impl PermissionMode {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

/// Static capability table for a single provider. Carried in
/// [`AgentModelSection`] etc. so the frontend can branch on data
/// rather than on the provider id string. The fields are the union of
/// the in-tree call sites that previously hard-coded
/// `provider === "<x>"` checks; new fields land next to the call site
/// that needs them and ship with a matrix entry covering all known
/// providers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    /// Stable provider id — `"claude"`, `"codex"`, `"cursor"`, …. Same
    /// string the rest of the codebase uses on `AgentModelOption`.
    pub provider: String,
    /// Human-readable label used in confirmation dialogs, status copy,
    /// etc. Lets us rename "Codex" to "OpenAI" (or vice versa) in one
    /// place without grepping for every string literal.
    pub display_name: String,
    /// Provider emits a "current plan" artefact the frontend can pin —
    /// either Codex `turn/plan/updated` or Claude `ExitPlanMode`. The
    /// pipeline maps both onto the same projection (see
    /// `agents::session_plan`).
    pub supports_plan_mode: bool,
    /// Provider has a long-running goal/autopilot loop the frontend
    /// needs to special-case during composer submit + stop (today:
    /// Codex `/goal …`). Frontend uses this to decide whether to fire
    /// the `getSessionCodexGoal` query and intercept `/goal` prompts.
    pub supports_active_goal: bool,
    /// Provider reports a live context-usage signal we surface in the
    /// composer ring. Matches the per-model `supports_context_usage`
    /// flag on [`super::catalog::AgentModelOption`] — duplicated here
    /// as a provider-level default so frontends without a selected
    /// model can still light the ring up.
    pub supports_context_usage: bool,
    /// Provider supports mid-turn "steer" follow-ups (queueing a new
    /// prompt before the current one finishes).
    pub supports_steer: bool,
    /// Provider has slash-command discovery (`list_slash_commands`
    /// returns a meaningful list, not an empty stub).
    pub supports_slash_commands: bool,
    /// Provider authenticates via an in-app key entry rather than the
    /// embedded login terminal flow. True for Cursor; false for Claude
    /// + Codex.
    pub requires_api_key: bool,
    /// Permission modes the composer's permission-mode dropdown should
    /// offer for this provider, in display order. The first entry is
    /// the default selection for new sessions.
    pub permission_modes: Vec<PermissionMode>,
}

/// Capabilities for the three providers Helmor ships today.
///
/// New providers (e.g. Copilot via #511, Pi via #321) land here with a
/// matrix entry in [`tests::capabilities_table`] documenting every
/// flag against the Claude reference row — keeps the contract honest.
pub fn capabilities_for_provider(provider: &str) -> ProviderCapabilities {
    match provider {
        "codex" => ProviderCapabilities {
            provider: "codex".into(),
            display_name: "Codex".into(),
            supports_plan_mode: true,
            supports_active_goal: true,
            supports_context_usage: true,
            supports_steer: true,
            supports_slash_commands: true,
            requires_api_key: false,
            permission_modes: vec![PermissionMode::Default, PermissionMode::BypassPermissions],
        },
        // Plan mode runs Cursor's read-only `plan` conversation mode; the
        // `createPlan` tool it ends with is surfaced as an ExitPlanMode-style
        // plan-review card (see cursor sidecar `planCaptured`). Cursor's SDK
        // only has agent/plan modes, so the dropdown offers just those two.
        "cursor" => ProviderCapabilities {
            provider: "cursor".into(),
            display_name: "Cursor".into(),
            supports_plan_mode: true,
            supports_active_goal: false,
            supports_context_usage: false,
            supports_steer: false,
            supports_slash_commands: true,
            requires_api_key: true,
            permission_modes: vec![PermissionMode::Default, PermissionMode::Plan],
        },
        // Plan mode runs the read-only `plan` agent (approval rides the question
        // flow). No /goal loop; has the context ring, steer, and slash commands.
        // Logs in via the embedded flow (not an API-key entry).
        "opencode" => ProviderCapabilities {
            provider: "opencode".into(),
            display_name: "OpenCode".into(),
            supports_plan_mode: true,
            supports_active_goal: false,
            supports_context_usage: true,
            supports_steer: true,
            supports_slash_commands: true,
            requires_api_key: false,
            permission_modes: vec![
                PermissionMode::Default,
                PermissionMode::AcceptEdits,
                PermissionMode::Plan,
                PermissionMode::BypassPermissions,
            ],
        },
        // Default arm covers "claude" and anything we haven't onboarded
        // yet — keeping the safe defaults equal to Claude's behaviour
        // means an unknown id never accidentally disables the
        // composer's full feature surface.
        _ => ProviderCapabilities {
            provider: "claude".into(),
            display_name: "Claude".into(),
            supports_plan_mode: true,
            supports_active_goal: false,
            supports_context_usage: true,
            supports_steer: true,
            supports_slash_commands: true,
            requires_api_key: false,
            permission_modes: vec![
                PermissionMode::Default,
                PermissionMode::AcceptEdits,
                PermissionMode::Plan,
                PermissionMode::BypassPermissions,
            ],
        },
    }
}

/// Convenience: list every provider Helmor ships today. Frontends use
/// this to render the capability table in settings (eventually), and
/// tests use it to assert there are no holes in the matrix.
pub const KNOWN_PROVIDERS: &[&str] = &["claude", "codex", "cursor", "opencode"];

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-provider capability matrix. Locks down every flag for
    /// every shipping provider so the next person adding a feature
    /// flag is forced to fill in the matrix or break this test.
    #[test]
    fn capabilities_table() {
        for provider in KNOWN_PROVIDERS {
            let caps = capabilities_for_provider(provider);
            assert_eq!(
                caps.provider, *provider,
                "capabilities for `{provider}` returned a mismatched provider id"
            );
            assert!(
                !caps.display_name.is_empty(),
                "{provider}: display_name must not be empty"
            );
            assert!(
                caps.permission_modes.contains(&PermissionMode::Default),
                "{provider}: every provider must support the 'default' permission mode"
            );
        }
    }

    #[test]
    fn claude_capabilities() {
        let caps = capabilities_for_provider("claude");
        assert_eq!(caps.provider, "claude");
        assert!(caps.supports_plan_mode, "Claude has ExitPlanMode");
        assert!(
            !caps.supports_active_goal,
            "Claude has no long-running goal loop"
        );
        assert!(caps.supports_context_usage);
        assert!(caps.supports_steer);
        assert!(caps.supports_slash_commands);
        assert!(!caps.requires_api_key, "Claude uses embedded login");
        assert_eq!(
            caps.permission_modes,
            vec![
                PermissionMode::Default,
                PermissionMode::AcceptEdits,
                PermissionMode::Plan,
                PermissionMode::BypassPermissions,
            ]
        );
    }

    #[test]
    fn codex_capabilities() {
        let caps = capabilities_for_provider("codex");
        assert_eq!(caps.provider, "codex");
        assert!(caps.supports_plan_mode, "Codex emits turn/plan/updated");
        assert!(
            caps.supports_active_goal,
            "Codex has /goal — composer must intercept it"
        );
        assert!(caps.supports_context_usage);
        assert!(caps.supports_steer);
        assert!(caps.supports_slash_commands);
        assert!(!caps.requires_api_key, "Codex uses embedded login");
        // Codex doesn't expose `acceptEdits` / `plan` — only the two
        // bypass-or-default modes its sidecar understands.
        assert_eq!(
            caps.permission_modes,
            vec![PermissionMode::Default, PermissionMode::BypassPermissions]
        );
    }

    #[test]
    fn cursor_capabilities() {
        let caps = capabilities_for_provider("cursor");
        assert_eq!(caps.provider, "cursor");
        assert!(
            caps.supports_plan_mode,
            "Cursor plan mode surfaces createPlan as a plan-review card"
        );
        assert!(!caps.supports_active_goal);
        assert!(
            !caps.supports_context_usage,
            "Cursor doesn't surface context usage today"
        );
        assert!(!caps.supports_steer);
        assert!(caps.supports_slash_commands);
        assert!(caps.requires_api_key, "Cursor authenticates via API key");
        assert_eq!(
            caps.permission_modes,
            vec![PermissionMode::Default, PermissionMode::Plan]
        );
    }

    #[test]
    fn opencode_capabilities() {
        let caps = capabilities_for_provider("opencode");
        assert_eq!(caps.provider, "opencode");
        assert_eq!(
            caps.display_name, "OpenCode",
            "must not fall back to Claude"
        );
        assert!(
            caps.supports_plan_mode,
            "opencode runs the read-only plan agent"
        );
        assert!(!caps.supports_active_goal, "opencode has no /goal loop");
        assert!(caps.supports_context_usage);
        assert!(caps.supports_steer);
        assert!(caps.supports_slash_commands);
        assert!(!caps.requires_api_key, "opencode uses embedded login");
        assert_eq!(
            caps.permission_modes,
            vec![
                PermissionMode::Default,
                PermissionMode::AcceptEdits,
                PermissionMode::Plan,
                PermissionMode::BypassPermissions,
            ]
        );
    }

    #[test]
    fn unknown_provider_falls_back_to_claude_defaults() {
        // Forward-compat: a future provider id (e.g. "copilot") that
        // lands without a matrix update must not break composer UX —
        // we default to Claude's feature surface, which is the
        // broadest, until the matrix is updated.
        let caps = capabilities_for_provider("copilot");
        let claude = capabilities_for_provider("claude");
        assert_eq!(caps.provider, claude.provider);
        assert_eq!(caps.supports_plan_mode, claude.supports_plan_mode);
        assert_eq!(caps.permission_modes, claude.permission_modes);
    }

    /// Wire-format gate: the frontend reads the capability shape
    /// straight out of `getProviderCapabilities`, so a snake_case
    /// field leaking past `rename_all = "camelCase"` would silently
    /// break every consumer.
    #[test]
    fn serialization_uses_camel_case_fields() {
        let caps = capabilities_for_provider("claude");
        let json = serde_json::to_value(&caps).unwrap();
        assert!(json.get("displayName").is_some());
        assert!(json.get("supportsPlanMode").is_some());
        assert!(json.get("supportsActiveGoal").is_some());
        assert!(json.get("supportsContextUsage").is_some());
        assert!(json.get("supportsSteer").is_some());
        assert!(json.get("supportsSlashCommands").is_some());
        assert!(json.get("requiresApiKey").is_some());
        assert!(json.get("permissionModes").is_some());
        let raw = serde_json::to_string(&caps).unwrap();
        assert!(!raw.contains('_'), "snake_case field leaked: {raw}");
    }

    #[test]
    fn permission_mode_serializes_to_sdk_wire_strings() {
        for (mode, wire) in [
            (PermissionMode::Default, "default"),
            (PermissionMode::AcceptEdits, "acceptEdits"),
            (PermissionMode::Plan, "plan"),
            (PermissionMode::BypassPermissions, "bypassPermissions"),
        ] {
            assert_eq!(mode.as_str(), wire);
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, format!("\"{wire}\""));
        }
    }
}
