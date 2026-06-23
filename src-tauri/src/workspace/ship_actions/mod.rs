use serde::Serialize;
use serde_json::Value;

use crate::agents::ActionKind;
use crate::models::sessions::CreateSessionOverrides;
use crate::ui_sync::UiMutationEvent;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceShipActionKind {
    MergePr,
    PullLatest,
    CommitAndPush,
    CreatePr,
    FixErrors,
    ResolveConflicts,
}

impl WorkspaceShipActionKind {
    pub const fn cli_label(self) -> &'static str {
        match self {
            Self::MergePr => "merge-pr",
            Self::PullLatest => "pull-latest",
            Self::CommitAndPush => "commit-and-push",
            Self::CreatePr => "create-pr",
            Self::FixErrors => "fix-errors",
            Self::ResolveConflicts => "resolve-conflicts",
        }
    }

    pub const fn mcp_label(self) -> &'static str {
        match self {
            Self::MergePr => "merge_pr",
            Self::PullLatest => "pull_latest",
            Self::CommitAndPush => "commit_and_push",
            Self::CreatePr => "create_pr",
            Self::FixErrors => "fix_errors",
            Self::ResolveConflicts => "resolve_conflicts",
        }
    }

    const fn action_kind(self) -> Option<ActionKind> {
        match self {
            Self::CommitAndPush => Some(ActionKind::CommitAndPush),
            Self::CreatePr => Some(ActionKind::CreatePr),
            Self::FixErrors => Some(ActionKind::Fix),
            Self::ResolveConflicts => Some(ActionKind::ResolveConflicts),
            Self::MergePr | Self::PullLatest => None,
        }
    }

    const fn uses_action_model_override(self) -> bool {
        matches!(self, Self::CommitAndPush | Self::CreatePr)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchedShipAction {
    pub session_id: String,
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone)]
pub enum WorkspaceShipActionResult {
    Direct {
        action: WorkspaceShipActionKind,
        workspace_id: String,
        result: Value,
    },
    Dispatched {
        action: WorkspaceShipActionKind,
        workspace_id: String,
        dispatch: DispatchedShipAction,
    },
}

impl WorkspaceShipActionResult {
    pub fn workspace_id(&self) -> &str {
        match self {
            Self::Direct { workspace_id, .. } | Self::Dispatched { workspace_id, .. } => {
                workspace_id
            }
        }
    }

    pub fn ui_events(&self) -> Vec<UiMutationEvent> {
        let workspace_id = self.workspace_id().to_string();
        match self {
            Self::Direct { .. } => vec![UiMutationEvent::WorkspaceChanged { workspace_id }],
            Self::Dispatched { .. } => vec![
                UiMutationEvent::SessionListChanged {
                    workspace_id: workspace_id.clone(),
                },
                UiMutationEvent::WorkspaceChanged { workspace_id },
            ],
        }
    }
}

#[derive(Debug, Default)]
struct OwnedSessionOverrides {
    model: Option<String>,
    effort_level: Option<String>,
    fast_mode: Option<bool>,
    /// Provider pinned from the model pref so a slug-based provider (opencode)
    /// isn't misresolved from the bare model id.
    agent_type: Option<String>,
}

impl OwnedSessionOverrides {
    fn as_create_session_overrides(&self) -> CreateSessionOverrides<'_> {
        CreateSessionOverrides {
            model: self.model.as_deref(),
            effort_level: self.effort_level.as_deref(),
            fast_mode: self.fast_mode,
            seed_session_id: None,
            session_kind: None,
            agent_type: self.agent_type.as_deref(),
        }
    }
}

mod prompts;
mod runner;

pub use runner::run_workspace_ship_action;

#[cfg(test)]
mod tests {
    use super::prompts::{build_agent_action_prompt, PromptContext};
    use super::*;
    use crate::models::repos::RepoPreferences;

    fn prefs() -> RepoPreferences {
        RepoPreferences::default()
    }

    #[test]
    fn agent_actions_map_to_persisted_action_kind() {
        assert_eq!(
            WorkspaceShipActionKind::CommitAndPush.action_kind(),
            Some(ActionKind::CommitAndPush)
        );
        assert_eq!(
            WorkspaceShipActionKind::CreatePr.action_kind(),
            Some(ActionKind::CreatePr)
        );
        assert_eq!(
            WorkspaceShipActionKind::FixErrors.action_kind(),
            Some(ActionKind::Fix)
        );
        assert_eq!(
            WorkspaceShipActionKind::ResolveConflicts.action_kind(),
            Some(ActionKind::ResolveConflicts)
        );
    }

    #[test]
    fn create_pr_prompt_uses_gitlab_dialect_and_custom_preferences() {
        let repo_preferences = RepoPreferences {
            create_pr: Some("Prefer squashable commits.".to_string()),
            ..prefs()
        };
        let prompt = build_agent_action_prompt(
            WorkspaceShipActionKind::CreatePr,
            PromptContext {
                repo_preferences: &repo_preferences,
                target_branch: Some("main"),
                remote: Some("upstream"),
                forge_provider: Some("gitlab"),
            },
        )
        .unwrap();

        assert!(prompt.contains("Create a merge request"));
        assert!(prompt.contains("glab mr create --target-branch main"));
        assert!(prompt.contains("git push -u upstream HEAD"));
        assert!(prompt.contains("Prefer squashable commits."));
    }

    #[test]
    fn create_pr_prompt_requires_target_branch() {
        let repo_preferences = prefs();
        let error = build_agent_action_prompt(
            WorkspaceShipActionKind::CreatePr,
            PromptContext {
                repo_preferences: &repo_preferences,
                target_branch: None,
                remote: None,
                forge_provider: None,
            },
        )
        .unwrap_err();

        assert!(format!("{error:#}").contains("Missing workspace target branch"));
    }

    #[test]
    fn fix_errors_prompt_uses_forge_ci_dialect() {
        let repo_preferences = prefs();
        let prompt = build_agent_action_prompt(
            WorkspaceShipActionKind::FixErrors,
            PromptContext {
                repo_preferences: &repo_preferences,
                target_branch: None,
                remote: None,
                forge_provider: Some("gitlab"),
            },
        )
        .unwrap();

        assert!(prompt.contains("GitLab CI is failing"));
        assert!(prompt.contains("glab ci list"));
        assert!(prompt.contains("pipeline"));
    }
}
