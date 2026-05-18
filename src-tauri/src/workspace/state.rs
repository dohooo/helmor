//! Workspace state enum — single source of truth for the `workspaces.state`
//! column. JSON serialization uses snake_case to match the existing frontend
//! expectations (`"initializing" | "setup_pending" | "ready" | "archived"`).

use std::fmt;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceState {
    Initializing,
    SetupPending,
    Ready,
    Archived,
}

impl WorkspaceState {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::SetupPending => "setup_pending",
            Self::Ready => "ready",
            Self::Archived => "archived",
        }
    }

    /// A workspace is operational when git/branch/sync ops are allowed.
    /// `setup_pending` is operational — it's a UI hint, not a lock.
    pub const fn is_operational(&self) -> bool {
        !matches!(self, Self::Archived | Self::Initializing)
    }
}

impl fmt::Display for WorkspaceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct UnknownWorkspaceState(pub String);

impl fmt::Display for UnknownWorkspaceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown workspace state: {:?}", self.0)
    }
}

impl std::error::Error for UnknownWorkspaceState {}

impl FromStr for WorkspaceState {
    type Err = UnknownWorkspaceState;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "initializing" => Ok(Self::Initializing),
            "setup_pending" => Ok(Self::SetupPending),
            "ready" => Ok(Self::Ready),
            "archived" => Ok(Self::Archived),
            other => Err(UnknownWorkspaceState(other.to_string())),
        }
    }
}

impl FromSql for WorkspaceState {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse()
            .map_err(|e: UnknownWorkspaceState| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for WorkspaceState {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

/// SQL WHERE-clause fragment selecting "operational" workspaces. Use as
/// `format!("... WHERE w.state {}", workspace::state::OPERATIONAL_FILTER)`.
/// MUST stay in sync with [`WorkspaceState::is_operational`] —
/// enforced by `sql_filter_agrees_with_rust_predicate` below.
pub const OPERATIONAL_FILTER: &str = "NOT IN ('archived', 'initializing')";

/// How the workspace's filesystem is provisioned. `Worktree` = a
/// dedicated `git worktree` directory with its own auto-named branch
/// (default + most-common). `Local` = operate directly on the source
/// repo's root path; multiple Local workspaces can coexist as parallel
/// conversations over the same disk.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceMode {
    #[default]
    Worktree,
    Local,
}

impl WorkspaceMode {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Worktree => "worktree",
            Self::Local => "local",
        }
    }
}

impl fmt::Display for WorkspaceMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct UnknownWorkspaceMode(pub String);

impl fmt::Display for UnknownWorkspaceMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown workspace mode: {:?}", self.0)
    }
}

impl std::error::Error for UnknownWorkspaceMode {}

impl FromStr for WorkspaceMode {
    type Err = UnknownWorkspaceMode;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "worktree" => Ok(Self::Worktree),
            "local" => Ok(Self::Local),
            other => Err(UnknownWorkspaceMode(other.to_string())),
        }
    }
}

impl FromSql for WorkspaceMode {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse()
            .map_err(|e: UnknownWorkspaceMode| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for WorkspaceMode {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    const ALL: &[WorkspaceState] = &[
        WorkspaceState::Initializing,
        WorkspaceState::SetupPending,
        WorkspaceState::Ready,
        WorkspaceState::Archived,
    ];

    #[test]
    fn round_trips_through_string() {
        for s in ALL {
            assert_eq!(WorkspaceState::from_str(s.as_str()).unwrap(), *s);
        }
    }

    #[test]
    fn json_serialization_matches_legacy_literals() {
        for s in ALL {
            let json = serde_json::to_string(s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()));
            let round: WorkspaceState = serde_json::from_str(&json).unwrap();
            assert_eq!(round, *s);
        }
    }

    #[test]
    fn workspace_mode_round_trips_through_string() {
        for mode in [WorkspaceMode::Worktree, WorkspaceMode::Local] {
            assert_eq!(WorkspaceMode::from_str(mode.as_str()).unwrap(), mode);
        }
    }

    #[test]
    fn workspace_mode_default_is_worktree() {
        assert_eq!(WorkspaceMode::default(), WorkspaceMode::Worktree);
    }

    #[test]
    fn workspace_mode_serializes_as_snake_case() {
        for mode in [WorkspaceMode::Worktree, WorkspaceMode::Local] {
            let json = serde_json::to_string(&mode).unwrap();
            assert_eq!(json, format!("\"{}\"", mode.as_str()));
            let round: WorkspaceMode = serde_json::from_str(&json).unwrap();
            assert_eq!(round, mode);
        }
    }

    #[test]
    fn workspace_mode_rejects_unknown_strings() {
        assert!(WorkspaceMode::from_str("worktree").is_ok());
        assert!(WorkspaceMode::from_str("local").is_ok());
        assert!(WorkspaceMode::from_str("WORKTREE").is_err());
        assert!(WorkspaceMode::from_str("hybrid").is_err());
        assert!(WorkspaceMode::from_str("").is_err());
    }

    #[test]
    fn workspace_mode_round_trips_through_sqlite() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (mode TEXT NOT NULL)", [])
            .unwrap();
        for mode in [WorkspaceMode::Worktree, WorkspaceMode::Local] {
            conn.execute("INSERT INTO t (mode) VALUES (?1)", [mode])
                .unwrap();
        }
        let mut rows: Vec<WorkspaceMode> = conn
            .prepare("SELECT mode FROM t ORDER BY mode")
            .unwrap()
            .query_map([], |r| r.get::<_, WorkspaceMode>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows.sort_by_key(|m| m.as_str());
        assert_eq!(rows, vec![WorkspaceMode::Local, WorkspaceMode::Worktree]);
    }

    #[test]
    fn sql_filter_agrees_with_rust_predicate() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (state TEXT NOT NULL)", [])
            .unwrap();
        for s in ALL {
            conn.execute("INSERT INTO t (state) VALUES (?1)", [s])
                .unwrap();
        }

        let sql = format!("SELECT state FROM t WHERE state {OPERATIONAL_FILTER}");
        let mut rows: Vec<WorkspaceState> = conn
            .prepare(&sql)
            .unwrap()
            .query_map([], |r| r.get::<_, WorkspaceState>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows.sort_by_key(|s| s.as_str());

        let mut expected: Vec<WorkspaceState> =
            ALL.iter().copied().filter(|s| s.is_operational()).collect();
        expected.sort_by_key(|s| s.as_str());

        assert_eq!(
            rows, expected,
            "OPERATIONAL_FILTER and is_operational() disagree"
        );
    }
}
