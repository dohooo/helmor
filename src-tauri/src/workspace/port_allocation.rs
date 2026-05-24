//! Per-workspace port range allocation.
//!
//! Each workspace gets a deterministic, non-overlapping block of TCP ports
//! that scripts and embedded terminals can bind without clashing with other
//! workspaces. The range is exposed as `HELMOR_PORT` / `HELMOR_PORT_COUNT`
//! in the script env (see [`crate::workspace::scripts`]).
//!
//! Allocation is **lazy** and **stable**:
//!   - lazy: a workspace gets a range the first time it asks for one, so
//!     existing rows don't need a backfill migration;
//!   - stable: once assigned, `port_base` is never reshuffled — the value
//!     survives restarts, archive/restore, and concurrent script runs.
//!
//! Active and archived workspaces both contribute to the high-water mark,
//! so an archived workspace's range will not be reused by a fresh
//! allocation; that keeps the active set guaranteed non-overlapping.

use anyhow::{Context, Result};
use rusqlite::OptionalExtension;

use crate::models::db;

/// First port handed out to the first workspace that asks. Chosen high
/// enough to clear common dev-server defaults (3000/5173/8080/etc.) so
/// `HELMOR_PORT` is unlikely to collide with whatever the user is also
/// running outside Helmor.
pub const DEFAULT_PORT_BASE: u16 = 55_100;

/// Default size of a workspace's port block. Matches the
/// `runtime-process-registry-and-port-ranges` plan; small enough that
/// thousands of workspaces fit under the 65_535 ceiling, large enough
/// for a typical multi-service dev stack.
pub const DEFAULT_PORT_COUNT: u16 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortRange {
    pub base: u16,
    pub count: u16,
}

/// Return the workspace's port range, allocating one if it has none yet.
///
/// The allocation runs in a single write transaction:
///   1. If the row already has a `port_base`, return it untouched.
///   2. Otherwise pick `max(port_base + port_count)` across every
///      workspace that has a range, fall back to [`DEFAULT_PORT_BASE`]
///      when no row has a range yet.
///
/// Because the write pool serialises writers (see `models::db`), two
/// concurrent callers for different workspaces cannot read the same
/// high-water mark — the second one sees the first one's commit.
///
/// Returns `Ok(None)` only if the workspace row does not exist.
pub fn ensure_workspace_port_range(workspace_id: &str) -> Result<Option<PortRange>> {
    let mut conn =
        db::write_conn().context("Failed to borrow write connection for port allocation")?;
    let tx = conn
        .transaction()
        .context("Failed to start port-allocation transaction")?;

    let existing = read_range(&tx, workspace_id)?;
    let row_exists = tx
        .prepare("SELECT 1 FROM workspaces WHERE id = ?1")
        .and_then(|mut stmt| stmt.exists([workspace_id]))
        .unwrap_or(false);
    if !row_exists {
        return Ok(None);
    }
    if let Some(range) = existing {
        return Ok(Some(range));
    }

    let high_water: Option<i64> = tx
        .query_row(
            "SELECT MAX(port_base + port_count) FROM workspaces \
             WHERE port_base IS NOT NULL AND port_count IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .optional()?
        .flatten();

    let next_base = match high_water {
        Some(hw) if hw >= DEFAULT_PORT_BASE as i64 => hw,
        _ => DEFAULT_PORT_BASE as i64,
    };
    let count = DEFAULT_PORT_COUNT as i64;

    if next_base + count > u16::MAX as i64 {
        anyhow::bail!(
            "Port range exhausted: next base {next_base} + count {count} would overflow u16"
        );
    }

    tx.execute(
        "UPDATE workspaces SET port_base = ?2, port_count = ?3 WHERE id = ?1 AND port_base IS NULL",
        rusqlite::params![workspace_id, next_base, count],
    )
    .with_context(|| format!("Failed to persist port range for workspace {workspace_id}"))?;

    let range = read_range(&tx, workspace_id)?;
    tx.commit()
        .context("Failed to commit port-allocation transaction")?;
    Ok(range)
}

fn read_range(tx: &rusqlite::Transaction<'_>, workspace_id: &str) -> Result<Option<PortRange>> {
    let row: Option<(Option<i64>, Option<i64>)> = tx
        .query_row(
            "SELECT port_base, port_count FROM workspaces WHERE id = ?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(base, count)| match (base, count) {
        (Some(b), Some(c)) if b >= 0 && c > 0 && b + c <= u16::MAX as i64 => Some(PortRange {
            base: b as u16,
            count: c as u16,
        }),
        _ => None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{insert_repo, insert_workspace, TestEnv, WorkspaceFixture};

    fn seed_ws(env: &TestEnv, repo_id: &str, workspace_id: &str) {
        let conn = env.db_connection();
        // Insert repo once; subsequent calls would conflict on PRIMARY KEY,
        // so swallow that error rather than racing on existence checks.
        let _ = conn.execute(
            "INSERT INTO repos (id, name, default_branch, remote)
             VALUES (?1, ?2, 'main', NULL)",
            rusqlite::params![repo_id, repo_id],
        );
        insert_workspace(
            &conn,
            &WorkspaceFixture {
                id: workspace_id,
                repo_id,
                directory_name: workspace_id,
                state: "ready",
                branch: Some("ws-branch"),
                intended_target_branch: Some("main"),
            },
        );
    }

    #[test]
    fn first_workspace_gets_default_base() {
        let env = TestEnv::new("port-alloc-first");
        insert_repo(&env.db_connection(), "r1", "r1", None);
        seed_ws(&env, "r1", "w1");

        let range = ensure_workspace_port_range("w1").unwrap().unwrap();
        assert_eq!(range.base, DEFAULT_PORT_BASE);
        assert_eq!(range.count, DEFAULT_PORT_COUNT);
    }

    #[test]
    fn second_workspace_does_not_overlap_first() {
        let env = TestEnv::new("port-alloc-overlap");
        seed_ws(&env, "r1", "w1");
        seed_ws(&env, "r1", "w2");

        let a = ensure_workspace_port_range("w1").unwrap().unwrap();
        let b = ensure_workspace_port_range("w2").unwrap().unwrap();

        assert_eq!(a.base, DEFAULT_PORT_BASE);
        assert_eq!(b.base, DEFAULT_PORT_BASE + DEFAULT_PORT_COUNT);
        // Ranges are disjoint half-open intervals [base, base + count).
        assert!(b.base >= a.base + a.count);
    }

    #[test]
    fn allocation_is_idempotent_across_calls() {
        let env = TestEnv::new("port-alloc-idempotent");
        seed_ws(&env, "r1", "w1");

        let first = ensure_workspace_port_range("w1").unwrap().unwrap();
        let second = ensure_workspace_port_range("w1").unwrap().unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn allocation_survives_intermediate_workspace_archival() {
        // Archiving a workspace must not free its range — otherwise a
        // restore would collide with whichever new workspace took its
        // ports, and HELMOR_PORT stops being stable.
        let env = TestEnv::new("port-alloc-archive");
        seed_ws(&env, "r1", "w1");
        seed_ws(&env, "r1", "w2");

        let a = ensure_workspace_port_range("w1").unwrap().unwrap();
        // Archive w1.
        env.db_connection()
            .execute(
                "UPDATE workspaces SET state = 'archived' WHERE id = ?1",
                ["w1"],
            )
            .unwrap();

        let b = ensure_workspace_port_range("w2").unwrap().unwrap();
        assert!(
            b.base >= a.base + a.count,
            "archived range {a:?} must not be reused for {b:?}"
        );
    }

    #[test]
    fn missing_workspace_returns_none() {
        let _env = TestEnv::new("port-alloc-missing");
        assert!(ensure_workspace_port_range("nope").unwrap().is_none());
    }
}
