//! "Current Helmor" snapshot — what repo / workspace / session the
//! user has selected right now, so the voice pipeline can resolve
//! deictic references ("this repo", "current workspace", "the latest")
//! without asking back.
//!
//! Originally lived in `settings_commands.rs` (only injected into the
//! rt voice prompt). Promoted here in Phase 1 so the planner shares the
//! same view of "where the user is standing" — when the planner gets
//! Helmor tools in Phase 2 it can resolve refs the same way rt does.

use anyhow::Result;
use rusqlite;

use crate::models::{db, settings, workspaces};

#[derive(Debug, Clone, Default)]
pub struct CurrentHelmorContext {
    pub repository_slug: Option<String>,
    pub workspace_ref: Option<String>,
    pub active_session: Option<String>,
}

impl CurrentHelmorContext {
    /// Render the block we paste into a system prompt. Returns `None`
    /// when nothing is selected — callers should NOT emit an empty
    /// "# Helmor context" header in that case (it'd just confuse the
    /// model).
    pub fn to_instruction_block(&self) -> String {
        let mut lines = vec!["# Helmor context".to_string()];
        if let Some(slug) = &self.repository_slug {
            lines.push(format!("- Repo slug: {slug}"));
        }
        if let Some(workspace_ref) = &self.workspace_ref {
            lines.push(format!("- Workspace ref: {workspace_ref}"));
        }
        if let Some(active_session) = &self.active_session {
            lines.push(format!("- Active session: {active_session}"));
        }
        lines.push("- Prefer this for current, this, here, latest, or it.".to_string());
        lines.join("\n")
    }

    pub fn is_empty(&self) -> bool {
        self.repository_slug.is_none()
            && self.workspace_ref.is_none()
            && self.active_session.is_none()
    }
}

/// Resolve the user's currently-selected workspace/session into a
/// compact context block. Returns `Ok(None)` when nothing is selected
/// or the persisted workspace id no longer resolves to a row.
pub fn current_helmor_context() -> Result<Option<CurrentHelmorContext>> {
    let Some(workspace_id) = settings::load_setting_value("app.last_workspace_id")? else {
        return Ok(None);
    };
    let Some(workspace) = workspaces::load_workspace_record_by_id(&workspace_id)? else {
        return Ok(None);
    };

    let repository_slug = crate::forge::accounts::forge_target_from(
        workspace.forge_provider.as_deref(),
        workspace.remote_url.as_deref(),
    )
    .map(|target| {
        format!(
            "{}:{}/{}",
            target.provider.as_storage_str(),
            target.owner,
            target.name
        )
    });
    let workspace_ref = clean_context_value(workspace.branch.as_deref())
        .or_else(|| clean_context_value(Some(&workspace.directory_name)))
        .or_else(|| clean_context_value(Some(&workspace.id)));
    let active_session = current_active_session_for_context(
        &workspace.id,
        workspace.active_session_id.as_deref(),
        workspace.active_session_title.as_deref(),
    )?;

    let context = CurrentHelmorContext {
        repository_slug,
        workspace_ref,
        active_session,
    };
    if context.is_empty() {
        return Ok(None);
    }
    Ok(Some(context))
}

fn current_active_session_for_context(
    workspace_id: &str,
    fallback_session_id: Option<&str>,
    fallback_title: Option<&str>,
) -> Result<Option<String>> {
    let last_session_id = settings::load_setting_value("app.last_session_id")?;
    let selected_session = match last_session_id.as_deref() {
        Some(session_id) => load_session_context_label(workspace_id, session_id)?,
        None => None,
    };
    if selected_session.is_some() {
        return Ok(selected_session);
    }
    Ok(format_session_context_label(
        fallback_session_id,
        fallback_title,
    ))
}

fn load_session_context_label(workspace_id: &str, session_id: &str) -> Result<Option<String>> {
    let conn = db::read_conn()?;
    let mut stmt =
        conn.prepare("SELECT title FROM sessions WHERE id = ?1 AND workspace_id = ?2 LIMIT 1")?;
    let mut rows = stmt.query(rusqlite::params![session_id, workspace_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let title: Option<String> = row.get(0)?;
    Ok(format_session_context_label(
        Some(session_id),
        title.as_deref(),
    ))
}

fn format_session_context_label(session_id: Option<&str>, title: Option<&str>) -> Option<String> {
    match (clean_context_value(title), clean_context_value(session_id)) {
        (Some(title), Some(id)) => Some(format!("{title} [{id}]")),
        (Some(title), None) => Some(title),
        (None, Some(id)) => Some(id),
        (None, None) => None,
    }
}

fn clean_context_value(value: Option<&str>) -> Option<String> {
    let value = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(96).collect())
}
