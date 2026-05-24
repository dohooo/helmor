//! Persistence layer for the `slack_workspaces` table.
//!
//! Stores non-secret metadata about each connected Slack workspace. The
//! matching token + cookie live in the OS keychain via `crate::slack::
//! credentials`, keyed by `team_id` — never in this DB.

use anyhow::{Context, Result};
use rusqlite::params;

use super::db;
use crate::slack::types::SlackWorkspace;

pub fn list_workspaces() -> Result<Vec<SlackWorkspace>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT team_id, team_name, team_domain, my_user_id, added_at
            FROM slack_workspaces
            ORDER BY added_at ASC
            "#,
        )
        .context("Failed to prepare slack workspace list query")?;

    let rows = statement
        .query_map([], |row| {
            Ok(SlackWorkspace {
                team_id: row.get(0)?,
                team_name: row.get(1)?,
                team_domain: row.get(2)?,
                my_user_id: row.get(3)?,
                added_at: row.get(4)?,
            })
        })
        .context("Failed to load slack workspaces")?;

    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("Failed to deserialize slack workspaces")
}

/// Look up one workspace by `team_id`. `Ok(None)` means no such row.
pub fn get_workspace(team_id: &str) -> Result<Option<SlackWorkspace>> {
    let connection = db::read_conn()?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT team_id, team_name, team_domain, my_user_id, added_at
            FROM slack_workspaces
            WHERE team_id = ?1
            "#,
        )
        .context("Failed to prepare slack workspace lookup")?;

    let row = statement
        .query_row(params![team_id], |row| {
            Ok(SlackWorkspace {
                team_id: row.get(0)?,
                team_name: row.get(1)?,
                team_domain: row.get(2)?,
                my_user_id: row.get(3)?,
                added_at: row.get(4)?,
            })
        })
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .context("Failed to lookup slack workspace")?;
    Ok(row)
}

/// Upsert by `team_id`. Re-connecting the same workspace updates the
/// non-secret fields (team name / domain may change as Slack rebrands)
/// and refreshes `added_at` so the sidebar order surfaces recent
/// reconnects.
pub fn upsert_workspace(workspace: &SlackWorkspace) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            r#"
            INSERT INTO slack_workspaces (team_id, team_name, team_domain, my_user_id, added_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(team_id) DO UPDATE SET
              team_name = excluded.team_name,
              team_domain = excluded.team_domain,
              my_user_id = excluded.my_user_id,
              added_at = excluded.added_at
            "#,
            params![
                workspace.team_id,
                workspace.team_name,
                workspace.team_domain,
                workspace.my_user_id,
                workspace.added_at,
            ],
        )
        .context("Failed to upsert slack workspace")?;
    Ok(())
}

pub fn delete_workspace(team_id: &str) -> Result<()> {
    let connection = db::write_conn()?;
    connection
        .execute(
            "DELETE FROM slack_workspaces WHERE team_id = ?1",
            params![team_id],
        )
        .context("Failed to delete slack workspace")?;
    Ok(())
}
