//! Domain operations shared by the Tauri commands and the `helmor
//! automation` CLI. Pure validation + persistence — UI notification
//! (`ui_sync::publish` vs `notify_running_app`) stays with the callers.

use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde_json::Value;

use super::schedule::{format_utc, next_run_after, Schedule};
use crate::models::automations::{
    self, AutomationRecord, NewAutomation, RUNS_IN_CHAT, RUNS_IN_WORKSPACE, STATUS_ACTIVE,
    STATUS_PAUSED,
};

pub struct CreateAutomationInput {
    pub title: String,
    pub prompt: String,
    pub runs_in: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub schedule: Value,
}

#[derive(Default)]
pub struct UpdateAutomationInput {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub runs_in: Option<String>,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub schedule: Option<Value>,
}

pub fn create_automation(input: CreateAutomationInput) -> Result<AutomationRecord> {
    let title = input.title.trim();
    let prompt = input.prompt.trim();
    if title.is_empty() {
        bail!("Automation title cannot be empty");
    }
    if prompt.is_empty() {
        bail!("Automation prompt cannot be empty");
    }
    let schedule = parse_schedule(&input.schedule)?;
    validate_target(
        &input.runs_in,
        input.session_id.as_deref(),
        input.workspace_id.as_deref(),
    )?;
    let next_run_at = format_utc(next_run_after(&schedule, Utc::now())?);
    // Store the canonical serde form, not caller-provided JSON verbatim.
    let canonical = serde_json::to_value(&schedule)?;
    automations::insert_automation(&NewAutomation {
        title,
        prompt,
        runs_in: &input.runs_in,
        session_id: input.session_id.as_deref(),
        workspace_id: input.workspace_id.as_deref(),
        schedule: &canonical,
        next_run_at: &next_run_at,
    })
}

/// Read-modify-write edit. A schedule change recomputes `next_run_at` from
/// now; binding changes are re-validated as a whole.
pub fn update_automation(id: &str, input: UpdateAutomationInput) -> Result<AutomationRecord> {
    let mut record =
        automations::get_automation(id)?.with_context(|| format!("Automation {id} not found"))?;

    if let Some(title) = input.title {
        let title = title.trim().to_string();
        if title.is_empty() {
            bail!("Automation title cannot be empty");
        }
        record.title = title;
    }
    if let Some(prompt) = input.prompt {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() {
            bail!("Automation prompt cannot be empty");
        }
        record.prompt = prompt;
    }
    if let Some(runs_in) = input.runs_in {
        record.runs_in = runs_in;
    }
    if let Some(session_id) = input.session_id {
        record.session_id = Some(session_id);
    }
    if let Some(workspace_id) = input.workspace_id {
        record.workspace_id = Some(workspace_id);
    }
    validate_target(
        &record.runs_in,
        record.session_id.as_deref(),
        record.workspace_id.as_deref(),
    )?;

    if let Some(schedule_json) = input.schedule {
        let schedule = parse_schedule(&schedule_json)?;
        record.schedule = serde_json::to_value(&schedule)?;
        record.next_run_at = format_utc(next_run_after(&schedule, Utc::now())?);
    }

    automations::update_automation_record(&record)?;
    automations::get_automation(id)?.with_context(|| format!("Automation {id} not found"))
}

/// Pause or resume. Resume recomputes `next_run_at` from now so a
/// long-paused automation never fires immediately.
pub fn set_status(id: &str, status: &str) -> Result<AutomationRecord> {
    let record =
        automations::get_automation(id)?.with_context(|| format!("Automation {id} not found"))?;
    match status {
        STATUS_PAUSED => automations::set_automation_status(id, STATUS_PAUSED, None)?,
        STATUS_ACTIVE => {
            // Re-validate the binding: resuming onto a session/workspace that
            // was deleted while paused would just dispatch-fail and re-pause.
            validate_target(
                &record.runs_in,
                record.session_id.as_deref(),
                record.workspace_id.as_deref(),
            )?;
            let schedule: Schedule = serde_json::from_value(record.schedule.clone())
                .context("Automation has an unparseable schedule")?;
            let next_run_at = format_utc(next_run_after(&schedule, Utc::now())?);
            automations::set_automation_status(id, STATUS_ACTIVE, Some(&next_run_at))?;
        }
        other => bail!("Invalid status {other:?} — expected active or paused"),
    }
    automations::get_automation(id)?.with_context(|| format!("Automation {id} not found"))
}

/// Manual "Run now": dispatch immediately, record `last_run_at`, leave the
/// schedule (`next_run_at`) untouched. Returns the session the run landed in.
pub fn run_now(app: &tauri::AppHandle, id: &str) -> Result<String> {
    let record =
        automations::get_automation(id)?.with_context(|| format!("Automation {id} not found"))?;
    let started =
        super::dispatch::run_automation_now(app, &record).map_err(|error| match error {
            super::dispatch::RunError::SessionBusy => anyhow::anyhow!(
                "A turn is already running in this automation's chat. Wait for it to finish."
            ),
            super::dispatch::RunError::TargetMissing(reason) => {
                anyhow::anyhow!("Automation target is gone: {reason}")
            }
            super::dispatch::RunError::Other(error) => error,
        })?;
    automations::set_last_run_at(id, &crate::models::db::current_timestamp()?)?;
    Ok(started.session_id)
}

pub fn parse_schedule(value: &Value) -> Result<Schedule> {
    let schedule: Schedule = serde_json::from_value(value.clone())
        .context("Invalid schedule — expected {kind: hourly|daily|weekly|every, ...}")?;
    schedule.validate()?;
    Ok(schedule)
}

fn validate_target(
    runs_in: &str,
    session_id: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<()> {
    match runs_in {
        RUNS_IN_CHAT => {
            let session_id =
                session_id.context("runs_in=chat requires a bound session (sessionId)")?;
            let exists = crate::models::sessions::get_session_workspace_and_permission(session_id)?
                .is_some();
            if !exists {
                bail!("Session {session_id} does not exist");
            }
        }
        RUNS_IN_WORKSPACE => {
            let workspace_id =
                workspace_id.context("runs_in=workspace requires a workspace (workspaceId)")?;
            crate::workspaces::get_workspace(workspace_id)
                .with_context(|| format!("Workspace {workspace_id} does not exist"))?;
        }
        other => bail!("Invalid runs_in {other:?} — expected chat or workspace"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::automations::STATUS_ACTIVE;

    fn workspace_fixture() -> (String, String) {
        // Minimal repo+workspace+session rows so target validation passes.
        let conn = crate::models::db::write_conn().unwrap();
        conn.execute_batch(
            r#"
            INSERT INTO repos (id, name, root_path) VALUES ('repo-1', 'demo', '/tmp/demo');
            INSERT INTO workspaces (id, repository_id, directory_name) VALUES ('ws-1', 'repo-1', 'demo-ws');
            INSERT INTO sessions (id, workspace_id, title) VALUES ('sess-1', 'ws-1', 'Chat');
            "#,
        )
        .unwrap();
        ("ws-1".into(), "sess-1".into())
    }

    fn chat_input(session_id: &str) -> CreateAutomationInput {
        CreateAutomationInput {
            title: "Order monitor".into(),
            prompt: "check the thing".into(),
            runs_in: RUNS_IN_CHAT.into(),
            session_id: Some(session_id.to_string()),
            workspace_id: None,
            schedule: serde_json::json!({"kind": "hourly"}),
        }
    }

    #[test]
    fn create_validates_and_computes_next_run() {
        let _env = crate::testkit::TestEnv::new("automation-ops-create");
        let (_ws, session) = workspace_fixture();

        let record = create_automation(chat_input(&session)).unwrap();
        assert_eq!(record.status, STATUS_ACTIVE);
        assert!(record.next_run_at > crate::models::db::current_timestamp().unwrap());

        // Missing session → rejected.
        let bad = create_automation(chat_input("nope"));
        assert!(bad.is_err());

        // Garbage schedule → rejected.
        let mut input = chat_input(&session);
        input.schedule = serde_json::json!({"kind": "fortnightly"});
        assert!(create_automation(input).is_err());
    }

    #[test]
    fn resume_recomputes_next_run_from_now() {
        let _env = crate::testkit::TestEnv::new("automation-ops-resume");
        let (_ws, session) = workspace_fixture();
        let record = create_automation(chat_input(&session)).unwrap();

        set_status(&record.id, STATUS_PAUSED).unwrap();
        // Make the stored next_run_at stale, as after a long pause.
        crate::models::automations::set_automation_status(
            &record.id,
            STATUS_PAUSED,
            Some("2000-01-01T00:00:00.000Z"),
        )
        .unwrap();

        let resumed = set_status(&record.id, STATUS_ACTIVE).unwrap();
        assert_eq!(resumed.status, STATUS_ACTIVE);
        // No immediate fire: next_run_at is in the future again.
        assert!(resumed.next_run_at > crate::models::db::current_timestamp().unwrap());
    }

    #[test]
    fn update_schedule_recomputes_but_title_edit_does_not() {
        let _env = crate::testkit::TestEnv::new("automation-ops-update");
        let (_ws, session) = workspace_fixture();
        let record = create_automation(chat_input(&session)).unwrap();
        let original_next = record.next_run_at.clone();

        let renamed = update_automation(
            &record.id,
            UpdateAutomationInput {
                title: Some("Renamed".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(renamed.title, "Renamed");
        assert_eq!(renamed.next_run_at, original_next);

        let rescheduled = update_automation(
            &record.id,
            UpdateAutomationInput {
                schedule: Some(
                    serde_json::json!({"kind": "every", "amount": 5, "unit": "minutes"}),
                ),
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(rescheduled.next_run_at, original_next);
        assert_eq!(rescheduled.schedule["kind"], "every");
    }

    #[test]
    fn resume_revalidates_missing_target() {
        let _env = crate::testkit::TestEnv::new("automation-ops-resume-validate");
        // A paused chat automation pointing at a session that doesn't exist
        // (target deleted via some path). Resume must refuse rather than
        // reactivate a guaranteed-to-dispatch-fail automation.
        let record = automations::insert_automation(&NewAutomation {
            title: "orphan",
            prompt: "check",
            runs_in: RUNS_IN_CHAT,
            session_id: Some("ghost-session"),
            workspace_id: None,
            schedule: &serde_json::json!({"kind": "hourly"}),
            next_run_at: "2026-01-01T00:00:00.000Z",
        })
        .unwrap();
        automations::set_automation_status(&record.id, STATUS_PAUSED, None).unwrap();

        assert!(set_status(&record.id, STATUS_ACTIVE).is_err());
    }

    #[test]
    fn delete_session_cascades_chat_automation() {
        let _env = crate::testkit::TestEnv::new("automation-ops-cascade-session");
        let (_ws, session) = workspace_fixture();
        let record = create_automation(chat_input(&session)).unwrap();

        crate::models::sessions::delete_session(&session).unwrap();
        assert!(automations::get_automation(&record.id).unwrap().is_none());
    }

    #[test]
    fn delete_workspace_cascades_automations() {
        let _env = crate::testkit::TestEnv::new("automation-ops-cascade-workspace");
        let (ws, session) = workspace_fixture();
        // One workspace-mode row + one chat row whose session lives in the
        // workspace; both must be cascaded. Inserted directly to bypass the
        // create-time target validation (irrelevant to the cascade).
        let ws_auto = automations::insert_automation(&NewAutomation {
            title: "ws monitor",
            prompt: "check",
            runs_in: RUNS_IN_WORKSPACE,
            session_id: None,
            workspace_id: Some(&ws),
            schedule: &serde_json::json!({"kind": "hourly"}),
            next_run_at: "2026-01-01T00:00:00.000Z",
        })
        .unwrap();
        let chat_auto = automations::insert_automation(&NewAutomation {
            title: "chat monitor",
            prompt: "check",
            runs_in: RUNS_IN_CHAT,
            session_id: Some(&session),
            workspace_id: None,
            schedule: &serde_json::json!({"kind": "hourly"}),
            next_run_at: "2026-01-01T00:00:00.000Z",
        })
        .unwrap();

        crate::models::workspaces::delete_workspace_and_session_rows(&ws).unwrap();
        assert!(automations::get_automation(&ws_auto.id).unwrap().is_none());
        assert!(automations::get_automation(&chat_auto.id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn workspace_run_session_does_not_steal_active_session() {
        let _env = crate::testkit::TestEnv::new("automation-skip-active");
        let (ws, session) = workspace_fixture();
        // Pin `session` as the workspace's active selection.
        crate::models::db::write_conn()
            .unwrap()
            .execute(
                "UPDATE workspaces SET active_session_id = ?1 WHERE id = ?2",
                [session.as_str(), ws.as_str()],
            )
            .unwrap();

        // A skip-active create (what automation workspace runs use) must leave
        // the active selection where the user left it.
        let created = crate::models::sessions::create_session(
            &ws,
            None,
            None,
            crate::models::sessions::CreateSessionOverrides {
                skip_active_session: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(created.session_id, session);

        let active: Option<String> = crate::models::db::read_conn()
            .unwrap()
            .query_row(
                "SELECT active_session_id FROM workspaces WHERE id = ?1",
                [ws.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active.as_deref(), Some(session.as_str()));
    }
}
