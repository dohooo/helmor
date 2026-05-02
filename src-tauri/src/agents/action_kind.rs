//! Action-kind enum — single source of truth for `sessions.action_kind`.
//!
//! An "action session" is a one-off dispatch from the inspector commit
//! button (create-PR, push, merge, …) rather than a user-driven chat. The
//! column is `NULL` for ordinary sessions and carries one of the enum
//! values below for action dispatches.
//!
//! Persistence: JSON / TypeScript use kebab-case (e.g. `"create-pr"`), so
//! `#[serde(rename_all = "kebab-case")]` gives byte-identical output to
//! the pre-refactor string form.

use std::fmt;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionKind {
    CreatePr,
    ReviewPr,
    CommitAndPush,
    Push,
    Fix,
    ResolveConflicts,
    Merge,
    OpenPr,
    Merged,
    Closed,
}

impl ActionKind {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::CreatePr => "create-pr",
            Self::ReviewPr => "review-pr",
            Self::CommitAndPush => "commit-and-push",
            Self::Push => "push",
            Self::Fix => "fix",
            Self::ResolveConflicts => "resolve-conflicts",
            Self::Merge => "merge",
            Self::OpenPr => "open-pr",
            Self::Merged => "merged",
            Self::Closed => "closed",
        }
    }

    /// The human-facing default title for a session created with this
    /// action kind. Used by `default_session_title_for_action_kind`.
    /// Defaults to "PR" terminology — callers with forge context should
    /// prefer `default_title_for_change_request` to get "MR" on GitLab.
    pub const fn default_title(&self) -> &'static str {
        match self {
            Self::CreatePr => "Create PR",
            Self::ReviewPr => "Review PR",
            Self::CommitAndPush => "Commit and Push",
            Self::Push => "Push",
            Self::Fix => "Fix CI",
            Self::ResolveConflicts => "Resolve Conflicts",
            Self::Merge => "Merge",
            Self::OpenPr => "Open PR",
            Self::Merged => "Merged",
            Self::Closed => "Closed",
        }
    }

    /// Forge-aware default title. Pass the workspace's change-request
    /// noun ("PR" for GitHub, "MR" for GitLab) — everything else uses the
    /// same wording as `default_title`.
    pub fn default_title_for_change_request(&self, change_request_name: &str) -> String {
        match self {
            Self::CreatePr => format!("Create {change_request_name}"),
            Self::ReviewPr => format!("Review {change_request_name}"),
            Self::OpenPr => format!("Open {change_request_name}"),
            _ => self.default_title().to_string(),
        }
    }
}

impl fmt::Display for ActionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug)]
pub struct UnknownActionKind(pub String);

impl fmt::Display for UnknownActionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown action_kind: {:?}", self.0)
    }
}

impl std::error::Error for UnknownActionKind {}

impl FromStr for ActionKind {
    type Err = UnknownActionKind;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "create-pr" => Ok(Self::CreatePr),
            "review-pr" => Ok(Self::ReviewPr),
            "commit-and-push" => Ok(Self::CommitAndPush),
            "push" => Ok(Self::Push),
            "fix" => Ok(Self::Fix),
            "resolve-conflicts" => Ok(Self::ResolveConflicts),
            "merge" => Ok(Self::Merge),
            "open-pr" => Ok(Self::OpenPr),
            "merged" => Ok(Self::Merged),
            "closed" => Ok(Self::Closed),
            _ => Err(UnknownActionKind(s.to_string())),
        }
    }
}

impl FromSql for ActionKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value
            .as_str()?
            .parse()
            .map_err(|e: UnknownActionKind| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for ActionKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: &[ActionKind] = &[
        ActionKind::CreatePr,
        ActionKind::ReviewPr,
        ActionKind::CommitAndPush,
        ActionKind::Push,
        ActionKind::Fix,
        ActionKind::ResolveConflicts,
        ActionKind::Merge,
        ActionKind::OpenPr,
        ActionKind::Merged,
        ActionKind::Closed,
    ];

    #[test]
    fn round_trips_through_string() {
        for k in ALL {
            assert_eq!(ActionKind::from_str(k.as_str()).unwrap(), *k);
        }
    }

    #[test]
    fn json_serialization_is_kebab_case() {
        for k in ALL {
            let json = serde_json::to_string(k).unwrap();
            assert_eq!(json, format!("\"{}\"", k.as_str()));
        }
    }

    #[test]
    fn unknown_values_fail_parse() {
        assert!(ActionKind::from_str("rebase").is_err());
        assert!(ActionKind::from_str("").is_err());
    }
}
