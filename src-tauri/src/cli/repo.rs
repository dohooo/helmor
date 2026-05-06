//! `helmor repo` — repository management.

use anyhow::Result;

use crate::repos;
use crate::service;
use crate::ui_sync::UiMutationEvent;

use super::args::{Cli, RepoAction};
use super::{notify_ui_event, notify_ui_events, output};

pub fn dispatch(action: &RepoAction, cli: &Cli) -> Result<()> {
    match action {
        RepoAction::List => list(cli),
        RepoAction::Show { repo_ref } => show(repo_ref, cli),
        RepoAction::Add { path } => add(path, cli),
        RepoAction::Delete { repo_ref } => delete(repo_ref, cli),
        RepoAction::DefaultBranch { repo_ref, branch } => default_branch(repo_ref, branch, cli),
        RepoAction::Remote { repo_ref, remote } => update_remote(repo_ref, remote, cli),
        RepoAction::Remotes { repo_ref } => list_remotes(repo_ref, cli),
        RepoAction::Scripts {
            repo_ref,
            workspace,
        } => show_scripts(repo_ref, workspace.as_deref(), cli),
        RepoAction::UpdateScripts {
            repo_ref,
            setup,
            run,
            archive,
            clear,
        } => update_scripts(
            repo_ref,
            setup.as_deref(),
            run.as_deref(),
            archive.as_deref(),
            clear,
            cli,
        ),
        RepoAction::Prefs { repo_ref } => show_prefs(repo_ref, cli),
        RepoAction::UpdatePrefs {
            repo_ref,
            create_pr,
            fix_errors,
            resolve_conflicts,
            branch_rename,
            general,
        } => update_prefs(
            repo_ref,
            create_pr.as_deref(),
            fix_errors.as_deref(),
            resolve_conflicts.as_deref(),
            branch_rename.as_deref(),
            general.as_deref(),
            cli,
        ),
    }
}

fn list(cli: &Cli) -> Result<()> {
    let repos = service::list_repositories()?;
    output::print(cli, &repos, |items| {
        if items.is_empty() {
            return "No repositories.".to_string();
        }
        items
            .iter()
            .map(|r| {
                format!(
                    "{}\t{}\t{}",
                    r.id,
                    r.name,
                    r.default_branch.as_deref().unwrap_or("-")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn show(repo_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let repos = service::list_repositories()?;
    let repo = repos
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| anyhow::anyhow!("Repository not found: {id}"))?;
    output::print(cli, &repo, |r| {
        format!(
            "ID:             {}\n\
             Name:           {}\n\
             Remote:         {}\n\
             Default branch: {}",
            r.id,
            r.name,
            r.remote.as_deref().unwrap_or("-"),
            r.default_branch.as_deref().unwrap_or("-"),
        )
    })
}

fn add(path: &str, cli: &Cli) -> Result<()> {
    let response = service::add_repository_from_local_path(path)?;
    let mut events = vec![UiMutationEvent::RepositoryListChanged];
    if let Some(workspace_id) = response.selected_workspace_id.clone() {
        events.push(UiMutationEvent::WorkspaceChanged { workspace_id });
    }
    notify_ui_events(events);
    output::print(cli, &response, |r| {
        let mut lines = Vec::new();
        if r.created_repository {
            lines.push(format!("Created repository {}", r.repository_id));
        } else {
            lines.push(format!("Repository already exists: {}", r.repository_id));
        }
        match r.selected_workspace_id.as_deref() {
            Some(ws_id) => lines.push(format!("Selected workspace {ws_id}")),
            None => lines.push(
                "No workspace selected — use `helmor workspace create` to start one.".to_string(),
            ),
        }
        lines.join("\n")
    })
}

fn delete(repo_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    repos::delete_repository_cascade(&id)?;
    notify_ui_events([
        UiMutationEvent::RepositoryListChanged,
        UiMutationEvent::WorkspaceListChanged,
    ]);
    output::print_ok(cli, &format!("Deleted repository {id}"));
    Ok(())
}

fn default_branch(repo_ref: &str, branch: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    repos::update_repository_default_branch(&id, branch)?;
    notify_ui_event(UiMutationEvent::RepositoryChanged { repo_id: id });
    output::print_ok(cli, &format!("Default branch set to {branch}"));
    Ok(())
}

fn update_remote(repo_ref: &str, remote: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let response = repos::update_repository_remote(&id, remote)?;
    notify_ui_event(UiMutationEvent::RepositoryChanged { repo_id: id });
    output::print(cli, &response, |r| {
        format!(
            "Remote set to {remote}. Orphaned workspace target branches: {}",
            r.orphaned_workspace_count
        )
    })
}

fn list_remotes(repo_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let remotes = repos::list_repo_remotes(&id)?;
    output::print(cli, &remotes, |items| {
        if items.is_empty() {
            "No remotes.".to_string()
        } else {
            items.join("\n")
        }
    })
}

fn show_scripts(repo_ref: &str, workspace: Option<&str>, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let workspace_id = match workspace {
        Some(r) => Some(service::resolve_workspace_ref(r)?),
        None => None,
    };
    let scripts = repos::load_repo_scripts(&id, workspace_id.as_deref())?;
    output::print(cli, &scripts, |s| {
        format!(
            "setup    (project={}): {}\nrun      (project={}): {}\narchive  (project={}): {}",
            s.setup_from_project,
            s.setup_script.as_deref().unwrap_or("-"),
            s.run_from_project,
            s.run_script.as_deref().unwrap_or("-"),
            s.archive_from_project,
            s.archive_script.as_deref().unwrap_or("-"),
        )
    })
}

fn update_scripts(
    repo_ref: &str,
    setup: Option<&str>,
    run: Option<&str>,
    archive: Option<&str>,
    clear: &[String],
    cli: &Cli,
) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    // Load current to preserve unspecified fields.
    let existing = repos::load_repo_scripts(&id, None)?;
    let mut setup_val = existing.setup_script;
    let mut run_val = existing.run_script;
    let mut archive_val = existing.archive_script;
    if let Some(v) = setup {
        setup_val = Some(v.to_string());
    }
    if let Some(v) = run {
        run_val = Some(v.to_string());
    }
    if let Some(v) = archive {
        archive_val = Some(v.to_string());
    }
    for kind in clear {
        match kind.as_str() {
            "setup" => setup_val = None,
            "run" => run_val = None,
            "archive" => archive_val = None,
            other => anyhow::bail!("Unknown script kind to clear: {other}"),
        }
    }
    repos::update_repo_scripts(
        &id,
        setup_val.as_deref(),
        run_val.as_deref(),
        archive_val.as_deref(),
    )?;
    notify_ui_event(UiMutationEvent::RepositoryChanged { repo_id: id });
    output::print_ok(cli, "Scripts updated");
    Ok(())
}

fn show_prefs(repo_ref: &str, cli: &Cli) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let prefs = repos::load_repo_preferences(&id)?;
    output::print(cli, &prefs, |p| {
        format!(
            "create-pr:          {}\nfix-errors:         {}\nresolve-conflicts:  {}\nbranch-rename:      {}\ngeneral:            {}",
            p.create_pr.as_deref().unwrap_or("-"),
            p.fix_errors.as_deref().unwrap_or("-"),
            p.resolve_conflicts.as_deref().unwrap_or("-"),
            p.branch_rename.as_deref().unwrap_or("-"),
            p.general.as_deref().unwrap_or("-"),
        )
    })
}

fn update_prefs(
    repo_ref: &str,
    create_pr: Option<&str>,
    fix_errors: Option<&str>,
    resolve_conflicts: Option<&str>,
    branch_rename: Option<&str>,
    general: Option<&str>,
    cli: &Cli,
) -> Result<()> {
    let id = service::resolve_repo_ref(repo_ref)?;
    let mut prefs = repos::load_repo_preferences(&id)?;
    if let Some(v) = create_pr {
        prefs.create_pr = Some(v.to_string());
    }
    if let Some(v) = fix_errors {
        prefs.fix_errors = Some(v.to_string());
    }
    if let Some(v) = resolve_conflicts {
        prefs.resolve_conflicts = Some(v.to_string());
    }
    if let Some(v) = branch_rename {
        prefs.branch_rename = Some(v.to_string());
    }
    if let Some(v) = general {
        prefs.general = Some(v.to_string());
    }
    repos::update_repo_preferences(&id, &prefs)?;
    notify_ui_event(UiMutationEvent::RepositoryChanged { repo_id: id });
    output::print_ok(cli, "Preferences updated");
    Ok(())
}
