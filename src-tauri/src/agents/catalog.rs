use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub cli_model: String,
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelSection {
    pub id: String,
    pub label: String,
    pub options: Vec<AgentModelOption>,
}

#[derive(Debug, Clone, Copy)]
pub struct AgentModelDefinition {
    pub id: &'static str,
    pub provider: &'static str,
    pub label: &'static str,
    pub cli_model: &'static str,
    pub badge: Option<&'static str>,
}

const CLAUDE_MODEL_DEFINITIONS: &[AgentModelDefinition] = &[
    AgentModelDefinition {
        id: "opus-1m",
        provider: "claude",
        label: "Opus 4.6 1M",
        cli_model: "opus[1m]",
        badge: Some("NEW"),
    },
    AgentModelDefinition {
        id: "opus",
        provider: "claude",
        label: "Opus 4.6",
        cli_model: "opus",
        badge: None,
    },
    AgentModelDefinition {
        id: "sonnet",
        provider: "claude",
        label: "Sonnet 4.6",
        cli_model: "sonnet",
        badge: None,
    },
    AgentModelDefinition {
        id: "haiku",
        provider: "claude",
        label: "Haiku 4.5",
        cli_model: "haiku",
        badge: None,
    },
];

const CODEX_MODEL_DEFINITIONS: &[AgentModelDefinition] = &[
    AgentModelDefinition {
        id: "gpt-5.4",
        provider: "codex",
        label: "GPT-5.4",
        cli_model: "gpt-5.4",
        badge: Some("NEW"),
    },
    AgentModelDefinition {
        id: "gpt-5.4-mini",
        provider: "codex",
        label: "GPT-5.4-Mini",
        cli_model: "gpt-5.4-mini",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.3-codex",
        provider: "codex",
        label: "GPT-5.3-Codex",
        cli_model: "gpt-5.3-codex",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.2-codex",
        provider: "codex",
        label: "GPT-5.2-Codex",
        cli_model: "gpt-5.2-codex",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.2",
        provider: "codex",
        label: "GPT-5.2",
        cli_model: "gpt-5.2",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.1-codex-max",
        provider: "codex",
        label: "GPT-5.1-Codex-Max",
        cli_model: "gpt-5.1-codex-max",
        badge: None,
    },
    AgentModelDefinition {
        id: "gpt-5.1-codex-mini",
        provider: "codex",
        label: "GPT-5.1-Codex-Mini",
        cli_model: "gpt-5.1-codex-mini",
        badge: None,
    },
];

pub fn list_agent_model_sections() -> Vec<AgentModelSection> {
    vec![
        AgentModelSection {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            options: CLAUDE_MODEL_DEFINITIONS
                .iter()
                .map(model_definition_to_option)
                .collect(),
        },
        AgentModelSection {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            options: CODEX_MODEL_DEFINITIONS
                .iter()
                .map(model_definition_to_option)
                .collect(),
        },
    ]
}

pub fn find_model_definition(model_id: &str) -> Option<&'static AgentModelDefinition> {
    CLAUDE_MODEL_DEFINITIONS
        .iter()
        .chain(CODEX_MODEL_DEFINITIONS.iter())
        .find(|model| model.id == model_id)
}

fn model_definition_to_option(model: &AgentModelDefinition) -> AgentModelOption {
    AgentModelOption {
        id: model.id.to_string(),
        provider: model.provider.to_string(),
        label: model.label.to_string(),
        cli_model: model.cli_model.to_string(),
        badge: model.badge.map(str::to_string),
    }
}
