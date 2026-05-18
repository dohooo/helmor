//! Per-workspace forge operations.
//!
//! Thin router layer: given a `workspace_id`, resolve its forge provider
//! and dispatch third-column forge capabilities to the right backend.

use std::path::Path;
use std::str::FromStr;

use anyhow::{bail, Result};

use crate::{
    error::{extract_code, ErrorCode},
    models::repos as repo_models,
    models::workspaces as workspace_models,
};

use super::detect::build_detection_for_remote;
use super::provider::{backend_for, WorkspaceForgeBackend};
use super::types::{ChangeRequestInfo, ForgeActionStatus, ForgeDetection, ForgeProvider};

pub fn get_workspace_forge(workspace_id: &str) -> Result<ForgeDetection> {
    let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };
    let stored_provider = record
        .forge_provider
        .as_deref()
        .and_then(|value| ForgeProvider::from_str(value).ok());
    let repo_root = record.root_path.as_deref().map(Path::new);
    let stored_is_concrete = matches!(
        stored_provider,
        Some(ForgeProvider::Github) | Some(ForgeProvider::Gitlab)
    );
    if !stored_is_concrete {
        tracing::debug!(
            workspace_id,
            repo_id = %record.repo_id,
            remote_url = ?record.remote_url,
            "Workspace has no cached forge provider; running detection"
        );
    }
    let detection =
        build_detection_for_remote(record.remote_url.as_deref(), stored_provider, repo_root);

    if !stored_is_concrete && detection.provider != ForgeProvider::Unknown {
        if let Err(error) = repo_models::update_repository_forge_provider(
            &record.repo_id,
            detection.provider.as_storage_str(),
        ) {
            tracing::warn!(
                "Failed to cache forge_provider for repo {}: {error:#}",
                record.repo_id
            );
        } else {
            tracing::debug!(
                workspace_id,
                repo_id = %record.repo_id,
                provider = ?detection.provider,
                "Cached detected forge provider for legacy repo"
            );
        }
    } else if !stored_is_concrete {
        tracing::debug!(
            workspace_id,
            repo_id = %record.repo_id,
            "Workspace forge detection stayed unknown"
        );
    }

    Ok(detection)
}

pub fn refresh_workspace_change_request(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some((detection, backend)) = resolve_backend(workspace_id, "lookup_change_request")? else {
        return Ok(None);
    };
    let result = backend
        .lookup_change_request(workspace_id)
        .inspect_err(|error| {
            log_forge_backend_error(
                error,
                workspace_id,
                &detection,
                "Forge change request lookup failed",
            )
        })?;
    tracing::debug!(
        workspace_id,
        provider = ?detection.provider,
        host = ?detection.host,
        found = result.is_some(),
        number = result.as_ref().map(|pr| pr.number),
        "Forge change request lookup completed"
    );
    Ok(result)
}

pub fn lookup_workspace_forge_action_status(workspace_id: &str) -> Result<ForgeActionStatus> {
    let Some((detection, backend)) = resolve_backend(workspace_id, "action_status")? else {
        return Ok(ForgeActionStatus::unavailable(
            "Workspace remote is not a supported forge repository",
        ));
    };
    let status = backend.action_status(workspace_id).inspect_err(|error| {
        log_forge_backend_error(
            error,
            workspace_id,
            &detection,
            "Forge action status lookup failed",
        )
    })?;
    tracing::debug!(
        workspace_id,
        provider = ?detection.provider,
        host = ?detection.host,
        remote_state = ?status.remote_state,
        checks = status.checks.len(),
        deployments = status.deployments.len(),
        "Forge action status lookup completed"
    );
    Ok(status)
}

pub fn lookup_workspace_forge_check_insert_text(
    workspace_id: &str,
    item_id: &str,
) -> Result<String> {
    let Some((detection, backend)) = resolve_backend(workspace_id, "check_insert_text")? else {
        bail!("Workspace remote is not a supported forge repository");
    };
    let text = backend
        .check_insert_text(workspace_id, item_id)
        .inspect_err(|error| {
            log_forge_backend_error(
                error,
                workspace_id,
                &detection,
                "Forge check insert text lookup failed",
            )
        })?;
    tracing::debug!(
        workspace_id,
        provider = ?detection.provider,
        host = ?detection.host,
        item_id,
        bytes = text.len(),
        "Forge check insert text lookup completed"
    );
    Ok(text)
}

pub fn merge_workspace_change_request(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some((detection, backend)) = resolve_backend(workspace_id, "merge_change_request")? else {
        return Ok(None);
    };
    let result = backend
        .merge_change_request(workspace_id)
        .inspect_err(|error| {
            log_forge_backend_error(error, workspace_id, &detection, "Forge merge failed")
        })?;
    tracing::info!(
        workspace_id,
        provider = ?detection.provider,
        host = ?detection.host,
        number = result.as_ref().map(|pr| pr.number),
        "Forge merge completed"
    );
    Ok(result)
}

pub fn close_workspace_change_request(workspace_id: &str) -> Result<Option<ChangeRequestInfo>> {
    let Some((detection, backend)) = resolve_backend(workspace_id, "close_change_request")? else {
        return Ok(None);
    };
    let result = backend
        .close_change_request(workspace_id)
        .inspect_err(|error| {
            log_forge_backend_error(error, workspace_id, &detection, "Forge close failed")
        })?;
    tracing::info!(
        workspace_id,
        provider = ?detection.provider,
        host = ?detection.host,
        number = result.as_ref().map(|pr| pr.number),
        "Forge close completed"
    );
    Ok(result)
}

fn resolve_backend(
    workspace_id: &str,
    operation: &'static str,
) -> Result<Option<(ForgeDetection, &'static dyn WorkspaceForgeBackend)>> {
    let detection = get_workspace_forge(workspace_id).inspect_err(|error| {
        tracing::error!(workspace_id, operation, error = %error, "Forge detection failed");
    })?;
    tracing::debug!(
        workspace_id,
        operation,
        provider = ?detection.provider,
        host = ?detection.host,
        namespace = ?detection.namespace,
        repo = ?detection.repo,
        "Resolved workspace forge"
    );
    let Some(backend) = backend_for(detection.provider) else {
        tracing::debug!(workspace_id, operation, "No forge backend for workspace");
        return Ok(None);
    };
    Ok(Some((detection, backend)))
}

fn log_forge_backend_error(
    error: &anyhow::Error,
    workspace_id: &str,
    detection: &ForgeDetection,
    message: &'static str,
) {
    let error_text = format!("{error:#}");
    if extract_code(error) == ErrorCode::ForgeOnboarding {
        tracing::warn!(
            workspace_id,
            provider = ?detection.provider,
            host = ?detection.host,
            error = %error_text,
            operation = message,
            "Forge backend operation failed"
        );
    } else {
        tracing::error!(
            workspace_id,
            provider = ?detection.provider,
            host = ?detection.host,
            error = %error_text,
            operation = message,
            "Forge backend operation failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use anyhow::anyhow;

    use super::*;
    use crate::error::AnyhowCodedExt;

    fn gitlab_detection() -> ForgeDetection {
        build_detection_for_remote(
            Some("git@gitlab.example.com:acme/repo.git"),
            Some(ForgeProvider::Gitlab),
            None,
        )
    }

    #[test]
    fn backend_error_preserves_onboarding_code() {
        let error = anyhow!("glab is missing").with_code(ErrorCode::ForgeOnboarding);
        log_forge_backend_error(
            &error,
            "workspace-1",
            &gitlab_detection(),
            "Forge action status lookup failed",
        );

        assert_eq!(extract_code(&error), ErrorCode::ForgeOnboarding);
    }

    #[test]
    fn backend_error_does_not_classify_by_message_text() {
        let error = anyhow!("GitLab CLI authentication required");
        log_forge_backend_error(
            &error,
            "workspace-1",
            &gitlab_detection(),
            "Forge action status lookup failed",
        );

        assert_eq!(extract_code(&error), ErrorCode::Unknown);
    }
}
