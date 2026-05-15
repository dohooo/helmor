//! Dashboard read model — a typed kanban projection over the same
//! workspace + session aggregates the sidebar uses.
//!
//! The dashboard view (#482) wants the same data the sidebar already
//! renders, just reshuffled into wider lanes. Rather than push that
//! re-shape into React, we expose it as a backend command so the
//! grouping rules + active-stream overlay live in one place and the
//! frontend can render dumb cards.
//!
//! Scope is deliberately narrow:
//! - one read-only command, no mutation;
//! - reuses `load_workspace_records` + `load_archived_workspace_records`
//!   so the dashboard never disagrees with the sidebar about a row's
//!   status / pr metadata / message counts;
//! - no expensive per-workspace git work (change line counts come from
//!   `workspace_action_status`, which is heavy and per-workspace —
//!   leave that to follow-up hover/lazy fetches).

use std::collections::HashSet;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::agents::streaming::ActiveStreamSummary;
use crate::models::workspaces as workspace_models;
use crate::workspace_state::WorkspaceState;
use crate::workspace_status::WorkspaceStatus;

use super::workspaces::{record_to_summary, WorkspaceSummary};

/// Dashboard lane discriminator. The five status values mirror
/// [`WorkspaceStatus`] one-for-one (so the dashboard never drifts from
/// the sidebar's grouping); the additional `Archived` lane surfaces
/// workspaces that have transitioned to `WorkspaceState::Archived`.
///
/// Wire format is kebab-case to match the existing
/// `WorkspaceStatus` serialization, so the frontend can branch on the
/// same string literals it already knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DashboardLaneId {
    InProgress,
    Review,
    Done,
    Backlog,
    Canceled,
    Archived,
}

impl DashboardLaneId {
    pub const fn label(&self) -> &'static str {
        match self {
            Self::InProgress => "In progress",
            Self::Review => "In review",
            Self::Done => "Done",
            Self::Backlog => "Backlog",
            Self::Canceled => "Canceled",
            Self::Archived => "Archived",
        }
    }

    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::InProgress => "in-progress",
            Self::Review => "review",
            Self::Done => "done",
            Self::Backlog => "backlog",
            Self::Canceled => "canceled",
            Self::Archived => "archived",
        }
    }

    const fn from_status(status: WorkspaceStatus) -> Self {
        match status {
            WorkspaceStatus::InProgress => Self::InProgress,
            WorkspaceStatus::Review => Self::Review,
            WorkspaceStatus::Done => Self::Done,
            WorkspaceStatus::Backlog => Self::Backlog,
            WorkspaceStatus::Canceled => Self::Canceled,
        }
    }
}

/// One workspace card on the dashboard. Carries the full
/// [`WorkspaceSummary`] (so the frontend can render the same metadata
/// it already uses for sidebar hover-cards) plus a single live
/// overlay: whether any Helmor session in this workspace currently
/// has an active stream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardCard {
    #[serde(flatten)]
    pub workspace: WorkspaceSummary,
    /// True when an `ActiveStreams` handle reports this workspace as
    /// the target of an in-flight stream. Drives the per-card "busy"
    /// indicator without forcing the frontend to cross-reference
    /// `list_active_streams` itself.
    pub is_streaming: bool,
}

/// A single column on the kanban board.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLane {
    pub id: DashboardLaneId,
    pub label: String,
    pub cards: Vec<DashboardCard>,
}

/// Snapshot of the entire dashboard. Lanes are returned in a fixed
/// display order; the frontend renders columns in iteration order
/// and never needs to sort.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub lanes: Vec<DashboardLane>,
}

/// Build the dashboard snapshot from current DB state plus an
/// `ActiveStreams` snapshot. Pure modulo the two DB reads — accepts
/// the streams as an injected slice so unit tests don't need to spin
/// up the `ActiveStreams` registry.
pub fn build_dashboard_snapshot(
    active_streams: &[ActiveStreamSummary],
) -> Result<DashboardSnapshot> {
    let active = workspace_models::load_workspace_records()?;
    let archived = workspace_models::load_archived_workspace_records()?;
    Ok(assemble_snapshot(active, archived, active_streams))
}

/// Pure shaping function — given the loaded workspace records and
/// the active-stream snapshot, produce the lane projection. Split
/// from `build_dashboard_snapshot` so tests can feed synthetic
/// records without touching the DB pool.
pub fn assemble_snapshot(
    active_records: Vec<workspace_models::WorkspaceRecord>,
    archived_records: Vec<workspace_models::WorkspaceRecord>,
    active_streams: &[ActiveStreamSummary],
) -> DashboardSnapshot {
    let streaming_workspaces: HashSet<String> = active_streams
        .iter()
        .filter_map(|s| s.workspace_id.clone())
        .collect();

    let mut lanes: [(DashboardLaneId, Vec<DashboardCard>); 6] = [
        (DashboardLaneId::InProgress, Vec::new()),
        (DashboardLaneId::Review, Vec::new()),
        (DashboardLaneId::Done, Vec::new()),
        (DashboardLaneId::Backlog, Vec::new()),
        (DashboardLaneId::Canceled, Vec::new()),
        (DashboardLaneId::Archived, Vec::new()),
    ];

    for record in active_records {
        // `load_workspace_records` returns every row regardless of
        // state. Archived rows are handled by the dedicated pass
        // below — skip them here so they don't double-count under
        // their old `status` value.
        if record.state == WorkspaceState::Archived {
            continue;
        }
        let lane_id = DashboardLaneId::from_status(record.status);
        let card = card_from_record(record, &streaming_workspaces);
        push_into_lane(&mut lanes, lane_id, card);
    }
    for record in archived_records {
        let card = card_from_record(record, &streaming_workspaces);
        push_into_lane(&mut lanes, DashboardLaneId::Archived, card);
    }

    DashboardSnapshot {
        lanes: lanes
            .into_iter()
            .map(|(id, cards)| DashboardLane {
                id,
                label: id.label().to_string(),
                cards,
            })
            .collect(),
    }
}

fn push_into_lane(
    lanes: &mut [(DashboardLaneId, Vec<DashboardCard>); 6],
    target: DashboardLaneId,
    card: DashboardCard,
) {
    if let Some((_, cards)) = lanes.iter_mut().find(|(id, _)| *id == target) {
        cards.push(card);
    }
}

fn card_from_record(
    record: workspace_models::WorkspaceRecord,
    streaming_workspaces: &HashSet<String>,
) -> DashboardCard {
    let workspace_id = record.id.clone();
    let workspace = record_to_summary(record);
    DashboardCard {
        is_streaming: streaming_workspaces.contains(&workspace_id),
        workspace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{insert_repo, insert_workspace, TestEnv, WorkspaceFixture};

    /// Update a workspace's status column post-insert. The `testkit`
    /// fixture inserts every row as `in-progress` (the production
    /// default); the dashboard test cases need a way to set an
    /// alternative status without duplicating that helper.
    fn set_status(env: &TestEnv, workspace_id: &str, status: &str) {
        env.db_connection()
            .execute(
                "UPDATE workspaces SET status = ?2 WHERE id = ?1",
                rusqlite::params![workspace_id, status],
            )
            .unwrap();
    }

    fn set_state(env: &TestEnv, workspace_id: &str, state: &str) {
        env.db_connection()
            .execute(
                "UPDATE workspaces SET state = ?2 WHERE id = ?1",
                rusqlite::params![workspace_id, state],
            )
            .unwrap();
    }

    fn cards_in(snapshot: &DashboardSnapshot, lane: DashboardLaneId) -> Vec<String> {
        snapshot
            .lanes
            .iter()
            .find(|l| l.id == lane)
            .map(|l| l.cards.iter().map(|c| c.workspace.id.clone()).collect())
            .unwrap_or_default()
    }

    #[test]
    fn snapshot_always_returns_all_six_lanes_in_stable_order() {
        let _env = TestEnv::new("dashboard-empty");
        let snapshot = build_dashboard_snapshot(&[]).unwrap();
        assert_eq!(snapshot.lanes.len(), 6);
        let ids: Vec<DashboardLaneId> = snapshot.lanes.iter().map(|l| l.id).collect();
        assert_eq!(
            ids,
            vec![
                DashboardLaneId::InProgress,
                DashboardLaneId::Review,
                DashboardLaneId::Done,
                DashboardLaneId::Backlog,
                DashboardLaneId::Canceled,
                DashboardLaneId::Archived,
            ]
        );
        // Empty dashboard — every lane has zero cards. The frontend
        // renders empty-state placeholders, so it relies on lanes
        // showing up even when nothing matches.
        assert!(snapshot.lanes.iter().all(|l| l.cards.is_empty()));
    }

    #[test]
    fn workspaces_are_grouped_by_status_and_archived_split_into_own_lane() {
        let env = TestEnv::new("dashboard-grouping");
        insert_repo(&env.db_connection(), "r1", "demo", None);
        for (id, status, state) in [
            ("w-progress", "in-progress", "ready"),
            ("w-review", "review", "ready"),
            ("w-done", "done", "ready"),
            ("w-backlog", "backlog", "ready"),
            ("w-canceled", "canceled", "ready"),
            ("w-archived-1", "in-progress", "archived"),
            ("w-archived-2", "done", "archived"),
        ] {
            insert_workspace(
                &env.db_connection(),
                &WorkspaceFixture {
                    id,
                    repo_id: "r1",
                    directory_name: id,
                    state: "ready",
                    branch: Some("main"),
                    intended_target_branch: Some("main"),
                },
            );
            set_status(&env, id, status);
            set_state(&env, id, state);
        }

        let snapshot = build_dashboard_snapshot(&[]).unwrap();

        assert_eq!(
            cards_in(&snapshot, DashboardLaneId::InProgress),
            vec!["w-progress"]
        );
        assert_eq!(
            cards_in(&snapshot, DashboardLaneId::Review),
            vec!["w-review"]
        );
        assert_eq!(cards_in(&snapshot, DashboardLaneId::Done), vec!["w-done"]);
        assert_eq!(
            cards_in(&snapshot, DashboardLaneId::Backlog),
            vec!["w-backlog"]
        );
        assert_eq!(
            cards_in(&snapshot, DashboardLaneId::Canceled),
            vec!["w-canceled"]
        );

        // Archived lane should include BOTH archived rows regardless
        // of the status column they had before archival — the lane
        // is keyed off `state`, not `status`.
        let archived = cards_in(&snapshot, DashboardLaneId::Archived);
        assert_eq!(archived.len(), 2);
        assert!(archived.contains(&"w-archived-1".to_string()));
        assert!(archived.contains(&"w-archived-2".to_string()));
    }

    #[test]
    fn is_streaming_overlays_active_workspaces_only() {
        let env = TestEnv::new("dashboard-streaming");
        insert_repo(&env.db_connection(), "r1", "demo", None);
        for id in ["w-a", "w-b", "w-c"] {
            insert_workspace(
                &env.db_connection(),
                &WorkspaceFixture {
                    id,
                    repo_id: "r1",
                    directory_name: id,
                    state: "ready",
                    branch: Some("main"),
                    intended_target_branch: Some("main"),
                },
            );
        }
        // Two streams: one targets `w-a`, one has no `workspace_id`
        // (the bootstrap race the snapshot guards against). `w-b` and
        // `w-c` should both report `is_streaming: false`.
        let streams = vec![
            ActiveStreamSummary {
                session_id: "s-a".into(),
                workspace_id: Some("w-a".into()),
                provider: "claude".into(),
            },
            ActiveStreamSummary {
                session_id: "s-orphan".into(),
                workspace_id: None,
                provider: "codex".into(),
            },
        ];

        let snapshot = build_dashboard_snapshot(&streams).unwrap();
        let cards: Vec<(String, bool)> = snapshot
            .lanes
            .iter()
            .find(|l| l.id == DashboardLaneId::InProgress)
            .unwrap()
            .cards
            .iter()
            .map(|c| (c.workspace.id.clone(), c.is_streaming))
            .collect();

        let by_id: std::collections::HashMap<_, _> = cards.into_iter().collect();
        assert_eq!(by_id.get("w-a"), Some(&true));
        assert_eq!(by_id.get("w-b"), Some(&false));
        assert_eq!(by_id.get("w-c"), Some(&false));
    }

    #[test]
    fn lane_id_kebab_case_serialization_matches_workspace_status() {
        // The frontend's `WorkspaceStatus` type already uses kebab-case
        // strings ("in-progress", "review", …). Locking down the same
        // wire format on `DashboardLaneId` means the dashboard view
        // can reuse the existing status-color / status-label helpers
        // without a separate translation layer.
        for (lane, wire) in [
            (DashboardLaneId::InProgress, "in-progress"),
            (DashboardLaneId::Review, "review"),
            (DashboardLaneId::Done, "done"),
            (DashboardLaneId::Backlog, "backlog"),
            (DashboardLaneId::Canceled, "canceled"),
            (DashboardLaneId::Archived, "archived"),
        ] {
            assert_eq!(lane.as_str(), wire);
            let json = serde_json::to_string(&lane).unwrap();
            assert_eq!(json, format!("\"{wire}\""));
        }
    }
}
