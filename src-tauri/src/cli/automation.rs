//! `helmor automation` — scheduled automations (recurring prompts).
//!
//! Mutations write the shared SQLite DB directly and nudge a running app via
//! `AutomationsChanged`. Note `run`: the CLI never dispatches a turn itself —
//! it marks the automation due (`next_run_at = now`) and lets the app's
//! scheduler tick (≤30s) fire it, so runs always stream through the app's
//! shared sidecar without stealing UI focus. With the app closed, the due
//! row simply fires on next launch — same catch-up path as a missed slot.

use anyhow::{bail, Context, Result};

use crate::automations::ops;
use crate::automations::schedule::Schedule;
use crate::models::automations::{
    self, AutomationRecord, RUNS_IN_CHAT, RUNS_IN_WORKSPACE, STATUS_ACTIVE, STATUS_PAUSED,
};
use crate::service;
use crate::ui_sync::UiMutationEvent;

use super::args::{AutomationAction, Cli};
use super::notify_ui_event;
use super::output;

pub fn dispatch(action: &AutomationAction, cli: &Cli) -> Result<()> {
    match action {
        AutomationAction::List => list(cli),
        AutomationAction::Show { automation } => show(automation, cli),
        AutomationAction::Create {
            title,
            prompt,
            chat,
            workspace,
            hourly,
            daily,
            weekly,
            every,
        } => create(
            title,
            prompt,
            chat.as_deref(),
            workspace.as_deref(),
            *hourly,
            daily.as_deref(),
            weekly.as_deref(),
            every.as_deref(),
            cli,
        ),
        AutomationAction::Pause { automation } => set_status(automation, STATUS_PAUSED, cli),
        AutomationAction::Resume { automation } => set_status(automation, STATUS_ACTIVE, cli),
        AutomationAction::Delete { automation } => delete(automation, cli),
        AutomationAction::Run { automation } => run(automation, cli),
    }
}

fn list(cli: &Cli) -> Result<()> {
    let records = automations::list_automations()?;
    output::print(cli, &records, |records| {
        if records.is_empty() {
            return "No automations. Create one with `helmor automation create`.".to_string();
        }
        records
            .iter()
            .map(|r| {
                format!(
                    "{}  [{}] {} — {} · next {}",
                    r.id,
                    r.status,
                    r.title,
                    schedule_summary(r),
                    r.next_run_at
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn show(automation: &str, cli: &Cli) -> Result<()> {
    let record = get(automation)?;
    output::print(cli, &record, |r| {
        format!(
            "{}\n  id: {}\n  status: {}\n  runs in: {}\n  schedule: {}\n  next run: {}\n  last run: {}\n  prompt:\n{}",
            r.title,
            r.id,
            r.status,
            match r.runs_in.as_str() {
                RUNS_IN_CHAT => format!("chat {}", r.session_id.as_deref().unwrap_or("?")),
                _ => format!("workspace {}", r.workspace_id.as_deref().unwrap_or("?")),
            },
            schedule_summary(r),
            r.next_run_at,
            r.last_run_at.as_deref().unwrap_or("never"),
            indent(&r.prompt),
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn create(
    title: &str,
    prompt: &str,
    chat: Option<&str>,
    workspace: Option<&str>,
    hourly: bool,
    daily: Option<&str>,
    weekly: Option<&str>,
    every: Option<&str>,
    cli: &Cli,
) -> Result<()> {
    let schedule = parse_schedule_flags(hourly, daily, weekly, every)?;
    let (runs_in, session_id, workspace_id) = match (chat, workspace) {
        (Some(session), None) => (RUNS_IN_CHAT, Some(session.to_string()), None),
        (None, Some(reference)) => {
            let workspace_id = service::resolve_workspace_ref(reference)?;
            (RUNS_IN_WORKSPACE, None, Some(workspace_id))
        }
        _ => bail!("Pass exactly one of --chat <session-id> or --workspace <workspace>"),
    };

    let record = ops::create_automation(ops::CreateAutomationInput {
        title: title.to_string(),
        prompt: prompt.to_string(),
        runs_in: runs_in.to_string(),
        session_id,
        workspace_id,
        schedule: serde_json::to_value(&schedule)?,
    })?;
    notify_ui_event(UiMutationEvent::AutomationsChanged);
    output::print_id(cli, "automation_id", &record.id);
    Ok(())
}

fn set_status(automation: &str, status: &str, cli: &Cli) -> Result<()> {
    let record = get(automation)?;
    ops::set_status(&record.id, status)?;
    notify_ui_event(UiMutationEvent::AutomationsChanged);
    output::print_ok(
        cli,
        &format!("Automation {} is now {status}.", record.title),
    );
    Ok(())
}

fn delete(automation: &str, cli: &Cli) -> Result<()> {
    let record = get(automation)?;
    automations::delete_automation(&record.id)?;
    notify_ui_event(UiMutationEvent::AutomationsChanged);
    output::print_ok(cli, &format!("Deleted automation {}.", record.title));
    Ok(())
}

/// Mark the automation due now. The app's scheduler tick claims and fires it
/// (≤30s) without any UI focus change; if the app isn't running, it fires on
/// next launch via the normal catch-up path.
fn run(automation: &str, cli: &Cli) -> Result<()> {
    let record = get(automation)?;
    if record.status != STATUS_ACTIVE {
        bail!(
            "Automation {} is paused — `helmor automation resume {}` first.",
            record.title,
            record.id
        );
    }
    let now = crate::models::db::current_timestamp()?;
    automations::set_automation_status(&record.id, STATUS_ACTIVE, Some(&now))?;
    notify_ui_event(UiMutationEvent::AutomationsChanged);
    let human = if service::is_app_running() {
        format!(
            "Automation {} will run within ~30s (next scheduler tick).",
            record.title
        )
    } else {
        format!(
            "Automation {} is due now — Helmor isn't running, so it runs on next launch.",
            record.title
        )
    };
    output::print_ok(cli, &human);
    Ok(())
}

fn get(reference: &str) -> Result<AutomationRecord> {
    automations::get_automation(reference)?
        .with_context(|| format!("Automation {reference} not found — try `helmor automation list`"))
}

fn schedule_summary(record: &AutomationRecord) -> String {
    serde_json::from_value::<Schedule>(record.schedule.clone())
        .map(|s| s.summary())
        .unwrap_or_else(|_| "invalid schedule".to_string())
}

fn parse_schedule_flags(
    hourly: bool,
    daily: Option<&str>,
    weekly: Option<&str>,
    every: Option<&str>,
) -> Result<Schedule> {
    if hourly {
        return Ok(Schedule::Hourly);
    }
    if let Some(time) = daily {
        return Ok(Schedule::Daily {
            time: time.to_string(),
        });
    }
    if let Some(spec) = weekly {
        // "mon:09:30" — day prefix, rest is HH:MM.
        let (day, time) = spec
            .split_once(':')
            .context("Invalid --weekly — expected DAY:HH:MM (e.g. mon:09:30)")?;
        let weekday = match day.to_ascii_lowercase().as_str() {
            "sun" | "sunday" => 0,
            "mon" | "monday" => 1,
            "tue" | "tuesday" => 2,
            "wed" | "wednesday" => 3,
            "thu" | "thursday" => 4,
            "fri" | "friday" => 5,
            "sat" | "saturday" => 6,
            other => bail!("Invalid weekday {other:?} — expected sun|mon|tue|wed|thu|fri|sat"),
        };
        return Ok(Schedule::Weekly {
            weekday,
            time: time.to_string(),
        });
    }
    if let Some(spec) = every {
        let spec = spec.trim().to_ascii_lowercase();
        let (digits, unit) = spec.split_at(spec.len().saturating_sub(1));
        let amount: u32 = digits
            .parse()
            .with_context(|| format!("Invalid --every {spec:?} — expected e.g. 15m or 2h"))?;
        let unit = match unit {
            "m" => crate::automations::schedule::EveryUnit::Minutes,
            "h" => crate::automations::schedule::EveryUnit::Hours,
            _ => bail!("Invalid --every {spec:?} — unit must be m or h"),
        };
        return Ok(Schedule::Every { amount, unit });
    }
    bail!("Pass exactly one of --hourly, --daily HH:MM, --weekly DAY:HH:MM, --every Nm|Nh")
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automations::schedule::EveryUnit;

    #[test]
    fn schedule_flags_parse() {
        assert_eq!(
            parse_schedule_flags(true, None, None, None).unwrap(),
            Schedule::Hourly
        );
        assert_eq!(
            parse_schedule_flags(false, Some("09:00"), None, None).unwrap(),
            Schedule::Daily {
                time: "09:00".into()
            }
        );
        assert_eq!(
            parse_schedule_flags(false, None, Some("mon:09:30"), None).unwrap(),
            Schedule::Weekly {
                weekday: 1,
                time: "09:30".into()
            }
        );
        assert_eq!(
            parse_schedule_flags(false, None, None, Some("15m")).unwrap(),
            Schedule::Every {
                amount: 15,
                unit: EveryUnit::Minutes
            }
        );
        assert_eq!(
            parse_schedule_flags(false, None, None, Some("2h")).unwrap(),
            Schedule::Every {
                amount: 2,
                unit: EveryUnit::Hours
            }
        );
        assert!(parse_schedule_flags(false, None, None, None).is_err());
        assert!(parse_schedule_flags(false, None, Some("noday"), None).is_err());
        assert!(parse_schedule_flags(false, None, None, Some("15x")).is_err());
    }
}
