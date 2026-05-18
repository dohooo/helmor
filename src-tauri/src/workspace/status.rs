//! Workspace status enum — drives the kanban lanes (Done / In Review /
//! In Progress / Backlog / Canceled) in the sidebar. Stored in
//! `workspaces.status`.
//!
//! Historical data may carry `"in-review"` or `"cancelled"` (British) — the
//! parser canonicalises both on read. Writers always emit the canonical
//! American form (`"review"`, `"canceled"`).

use std::fmt;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceStatus {
    #[default]
    InProgress,
    Done,
    Review,
    Backlog,
    Canceled,
}

impl WorkspaceStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::InProgress => "in-progress",
            Self::Done => "done",
            Self::Review => "review",
            Self::Backlog => "backlog",
            Self::Canceled => "canceled",
        }
    }

    /// Sidebar kanban lane. Note: `InProgress` maps to `"progress"` — the
    /// stored value has a hyphen, the lane id does not.
    pub const fn group_id(&self) -> &'static str {
        match self {
            Self::InProgress => "progress",
            Self::Done => "done",
            Self::Review => "review",
            Self::Backlog => "backlog",
            Self::Canceled => "canceled",
        }
    }

    /// Sort rank: done first, review/progress/backlog next, canceled last.
    pub const fn sort_rank(&self) -> usize {
        match self {
            Self::Done => 0,
            Self::Review => 1,
            Self::InProgress => 2,
            Self::Backlog => 3,
            Self::Canceled => 4,
        }
    }
}

impl fmt::Display for WorkspaceStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct UnknownWorkspaceStatus(pub String);

impl fmt::Display for UnknownWorkspaceStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown workspace status: {:?}", self.0)
    }
}

impl std::error::Error for UnknownWorkspaceStatus {}

impl FromStr for WorkspaceStatus {
    type Err = UnknownWorkspaceStatus;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "in-progress" => Ok(Self::InProgress),
            "done" => Ok(Self::Done),
            "review" | "in-review" => Ok(Self::Review),
            "backlog" => Ok(Self::Backlog),
            "canceled" | "cancelled" => Ok(Self::Canceled),
            _ => Err(UnknownWorkspaceStatus(s.to_string())),
        }
    }
}

impl FromSql for WorkspaceStatus {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse()
            .map_err(|e: UnknownWorkspaceStatus| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for WorkspaceStatus {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_spellings_canonicalise() {
        assert_eq!(
            WorkspaceStatus::from_str("in-review").unwrap(),
            WorkspaceStatus::Review
        );
        assert_eq!(
            WorkspaceStatus::from_str("cancelled").unwrap(),
            WorkspaceStatus::Canceled
        );
        assert_eq!(
            WorkspaceStatus::from_str("CANCELED").unwrap(),
            WorkspaceStatus::Canceled
        );
        assert_eq!(
            WorkspaceStatus::from_str(" done ").unwrap(),
            WorkspaceStatus::Done
        );
    }

    #[test]
    fn round_trips_canonical_form() {
        for s in [
            WorkspaceStatus::InProgress,
            WorkspaceStatus::Done,
            WorkspaceStatus::Review,
            WorkspaceStatus::Backlog,
            WorkspaceStatus::Canceled,
        ] {
            assert_eq!(WorkspaceStatus::from_str(s.as_str()).unwrap(), s);
        }
    }

    #[test]
    fn json_serializes_to_kebab_case_literals() {
        assert_eq!(
            serde_json::to_string(&WorkspaceStatus::InProgress).unwrap(),
            "\"in-progress\""
        );
        assert_eq!(
            serde_json::to_string(&WorkspaceStatus::Done).unwrap(),
            "\"done\""
        );
        assert_eq!(
            serde_json::to_string(&WorkspaceStatus::Review).unwrap(),
            "\"review\""
        );
        assert_eq!(
            serde_json::to_string(&WorkspaceStatus::Backlog).unwrap(),
            "\"backlog\""
        );
        assert_eq!(
            serde_json::to_string(&WorkspaceStatus::Canceled).unwrap(),
            "\"canceled\""
        );
    }

    #[test]
    fn group_id_differs_from_stored_str() {
        // Only deviation from `as_str` is InProgress → "progress".
        assert_eq!(WorkspaceStatus::InProgress.group_id(), "progress");
        assert_ne!(
            WorkspaceStatus::InProgress.as_str(),
            WorkspaceStatus::InProgress.group_id()
        );
    }
}
