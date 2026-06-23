use anyhow::{Context, Result};

use crate::models::{repos, sessions, settings};
use crate::service::{self, SendMessageParams};

use super::prompts::{build_agent_action_prompt, PromptContext};
use super::{
    DispatchedShipAction, OwnedSessionOverrides, WorkspaceShipActionKind, WorkspaceShipActionResult,
};

pub fn run_workspace_ship_action(
    workspace_ref: &str,
    action: WorkspaceShipActionKind,
) -> Result<WorkspaceShipActionResult> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;

    match action {
        WorkspaceShipActionKind::MergePr => {
            let info = crate::forge::merge_workspace_change_request(&workspace_id)?;
            Ok(WorkspaceShipActionResult::Direct {
                action,
                workspace_id,
                result: serde_json::to_value(info)?,
            })
        }
        WorkspaceShipActionKind::PullLatest => {
            let result = crate::workspaces::sync_workspace_with_target_branch(&workspace_id)?;
            Ok(WorkspaceShipActionResult::Direct {
                action,
                workspace_id,
                result: serde_json::to_value(result)?,
            })
        }
        WorkspaceShipActionKind::CommitAndPush
        | WorkspaceShipActionKind::CreatePr
        | WorkspaceShipActionKind::FixErrors
        | WorkspaceShipActionKind::ResolveConflicts => {
            let detail = service::get_workspace(&workspace_id)?;
            let repo_preferences = repos::load_repo_preferences(&detail.repo_id)?;
            let target_branch = detail
                .intended_target_branch
                .as_deref()
                .or(detail.default_branch.as_deref());
            let prompt = build_agent_action_prompt(
                action,
                PromptContext {
                    repo_preferences: &repo_preferences,
                    target_branch,
                    remote: detail.remote.as_deref(),
                    forge_provider: detail.forge_provider.as_deref(),
                },
            )?;
            let overrides = action_session_overrides(action)?;
            let action_kind = action
                .action_kind()
                .context("missing action kind for agent-dispatched ship action")?;
            let session = sessions::create_session(
                &workspace_id,
                Some(action_kind),
                None,
                overrides.as_create_session_overrides(),
            )?;

            let response = service::send_message(
                SendMessageParams {
                    workspace_ref: workspace_id.clone(),
                    session_id: Some(session.session_id.clone()),
                    prompt,
                    model: None,
                    permission_mode: Some("auto".to_string()),
                    linked_directories: Vec::new(),
                },
                &mut |_event| {},
            )?;

            Ok(WorkspaceShipActionResult::Dispatched {
                action,
                workspace_id,
                dispatch: DispatchedShipAction {
                    session_id: response.session_id,
                    provider: response.provider,
                    model: response.model,
                },
            })
        }
    }
}

fn action_session_overrides(action: WorkspaceShipActionKind) -> Result<OwnedSessionOverrides> {
    if !action.uses_action_model_override() {
        return Ok(OwnedSessionOverrides::default());
    }

    // The model pref carries its provider (new `{provider, modelId}` form);
    // pin it as the session's agent_type so a non-default provider (e.g. opencode)
    // isn't misresolved from the bare slug. Legacy bare ids leave it None.
    let model_pref =
        load_model_pref("app.pr_model_id")?.or(load_model_pref("app.default_model_id")?);
    Ok(OwnedSessionOverrides {
        agent_type: model_pref.as_ref().and_then(|p| p.provider.clone()),
        model: model_pref.map(|p| p.model_id),
        effort_level: load_setting_trimmed("app.pr_effort")?
            .or(load_setting_trimmed("app.default_effort")?),
        fast_mode: load_setting_bool("app.pr_fast_mode")?
            .or(load_setting_bool("app.default_fast_mode")?),
    })
}

fn load_model_pref(key: &str) -> Result<Option<crate::agents::model_ref::StoredModel>> {
    Ok(settings::load_setting_value(key)?
        .and_then(|raw| crate::agents::model_ref::parse_stored_model(&raw)))
}

fn load_setting_trimmed(key: &str) -> Result<Option<String>> {
    Ok(settings::load_setting_value(key)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn load_setting_bool(key: &str) -> Result<Option<bool>> {
    Ok(
        settings::load_setting_value(key)?.and_then(|value| match value.as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        }),
    )
}
