use anyhow::{bail, Result};

use crate::forge::branch::forge_head_branch_for;
use crate::forge::remote::{parse_remote, ParsedRemote};
use crate::models::workspaces as workspace_models;
use crate::workspace_state::WorkspaceState;

pub(super) struct GiteaContext {
    pub(super) remote: ParsedRemote,
    pub(super) branch: String,
    pub(super) published: bool,
    pub(super) login: String,
}

pub(super) enum GiteaResolution {
    Ready(GiteaContext),
    Initializing,
    Unavailable(&'static str),
    Unauthenticated,
}

pub(super) fn load_gitea_context(workspace_id: &str) -> Result<GiteaResolution> {
    let Some(record) = workspace_models::load_workspace_record_by_id(workspace_id)? else {
        bail!("Workspace not found: {workspace_id}");
    };
    if record.state == WorkspaceState::Initializing {
        return Ok(GiteaResolution::Initializing);
    }

    let Some(remote_url) = record.remote_url.as_deref() else {
        return Ok(GiteaResolution::Unavailable("Workspace has no remote"));
    };
    let Some(remote) = parse_remote(remote_url) else {
        return Ok(GiteaResolution::Unavailable(
            "Workspace remote is not a Gitea repository",
        ));
    };
    let Some(branch) = record
        .branch
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Ok(GiteaResolution::Unavailable(
            "Workspace has no current branch",
        ));
    };
    let Some(login) = record
        .forge_login
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
    else {
        return Ok(GiteaResolution::Unauthenticated);
    };

    let (branch, published) = forge_head_branch_for(&record, &branch);
    Ok(GiteaResolution::Ready(GiteaContext {
        remote,
        branch,
        published,
        login,
    }))
}
