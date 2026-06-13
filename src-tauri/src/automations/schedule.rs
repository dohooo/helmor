//! Schedule spec + next-run computation.
//!
//! `next_run_after` is a pure function of (schedule, now) so it needs no
//! clock mocking in tests. Interval kinds are plain UTC arithmetic; daily and
//! weekly resolve the next *local wall-clock* occurrence (generic over
//! `chrono::TimeZone` — production passes `Local`, tests pass `FixedOffset`).
//! Crucially the result is always computed from "now", never incremented from
//! the previous value, so a machine that slept through N slots schedules
//! exactly one catch-up run and falls back into cadence.

use anyhow::{bail, Context, Result};
use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDateTime, NaiveTime, SecondsFormat, TimeZone,
    Utc, Weekday,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Schedule {
    /// Every hour, anchored to the moment of (re)computation.
    Hourly,
    /// Every day at a local wall-clock time, `"HH:MM"`.
    Daily { time: String },
    /// Every week on `weekday` (0 = Sunday … 6 = Saturday, JS convention)
    /// at a local wall-clock time, `"HH:MM"`.
    Weekly { weekday: u8, time: String },
    /// Every N minutes/hours, anchored to the moment of (re)computation.
    Every { amount: u32, unit: EveryUnit },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EveryUnit {
    Minutes,
    Hours,
}

impl Schedule {
    pub fn validate(&self) -> Result<()> {
        match self {
            Schedule::Hourly => Ok(()),
            Schedule::Daily { time } => parse_hhmm(time).map(|_| ()),
            Schedule::Weekly { weekday, time } => {
                weekday_from_index(*weekday)?;
                parse_hhmm(time).map(|_| ())
            }
            Schedule::Every { amount, .. } => {
                if *amount == 0 {
                    bail!("Custom interval must be at least 1");
                }
                Ok(())
            }
        }
    }

    /// Human summary for list rows and chat badges ("Hourly", "Daily at 09:00").
    pub fn summary(&self) -> String {
        match self {
            Schedule::Hourly => "Hourly".to_string(),
            Schedule::Daily { time } => format!("Daily at {time}"),
            Schedule::Weekly { weekday, time } => {
                let day = weekday_from_index(*weekday)
                    .map(weekday_label)
                    .unwrap_or("?");
                format!("Weekly on {day} at {time}")
            }
            Schedule::Every { amount, unit } => match unit {
                EveryUnit::Minutes => format!("Every {amount}m"),
                EveryUnit::Hours => format!("Every {amount}h"),
            },
        }
    }
}

/// Next fire instant strictly after `now`, in the local timezone.
pub fn next_run_after(schedule: &Schedule, now: DateTime<Utc>) -> Result<DateTime<Utc>> {
    next_run_after_in(schedule, now, &chrono::Local)
}

/// Timezone-generic core of [`next_run_after`] — unit-testable with
/// `FixedOffset`.
pub fn next_run_after_in<Tz: TimeZone>(
    schedule: &Schedule,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Result<DateTime<Utc>> {
    schedule.validate()?;
    Ok(match schedule {
        Schedule::Hourly => now + Duration::hours(1),
        Schedule::Every { amount, unit } => {
            now + match unit {
                EveryUnit::Minutes => Duration::minutes(i64::from(*amount)),
                EveryUnit::Hours => Duration::hours(i64::from(*amount)),
            }
        }
        Schedule::Daily { time } => next_local_occurrence(now, tz, parse_hhmm(time)?, None),
        Schedule::Weekly { weekday, time } => next_local_occurrence(
            now,
            tz,
            parse_hhmm(time)?,
            Some(weekday_from_index(*weekday)?),
        ),
    })
}

/// Storage format for `automations.next_run_at` — matches
/// `db::current_timestamp()` (RFC3339 UTC millis) so strings compare
/// chronologically.
pub fn format_utc(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Next local wall-clock occurrence of `time` (optionally constrained to a
/// weekday) strictly after `now`. Recomputed from scratch every call, so DST
/// shifts self-correct on the following cycle.
fn next_local_occurrence<Tz: TimeZone>(
    now: DateTime<Utc>,
    tz: &Tz,
    time: NaiveTime,
    weekday: Option<Weekday>,
) -> DateTime<Utc> {
    let local_now = now.with_timezone(tz);
    let mut date = local_now.date_naive();
    // 8 days covers a full weekday cycle plus the "today's slot already
    // passed" case; the unreachable fallback below is pure defense.
    for _ in 0..=8 {
        let weekday_matches = weekday.is_none_or(|w| date.weekday() == w);
        if weekday_matches {
            if let Some(candidate) = resolve_local(tz, date.and_time(time)) {
                if candidate > now {
                    return candidate;
                }
            }
        }
        match date.succ_opt() {
            Some(next) => date = next,
            None => break,
        }
    }
    now + Duration::days(1)
}

/// Resolve a naive local datetime to UTC. DST fold (ambiguous) takes the
/// earliest instant; DST gap (nonexistent) advances minute-by-minute to the
/// first valid instant after the gap.
fn resolve_local<Tz: TimeZone>(tz: &Tz, naive: NaiveDateTime) -> Option<DateTime<Utc>> {
    let mut probe = naive;
    // Bounded walk: real DST gaps are ≤ 2h; 240 minutes is generous.
    for _ in 0..240 {
        match tz.from_local_datetime(&probe) {
            LocalResult::Single(dt) => return Some(dt.with_timezone(&Utc)),
            LocalResult::Ambiguous(earliest, _) => return Some(earliest.with_timezone(&Utc)),
            LocalResult::None => probe += Duration::minutes(1),
        }
    }
    None
}

fn parse_hhmm(time: &str) -> Result<NaiveTime> {
    NaiveTime::parse_from_str(time, "%H:%M")
        .with_context(|| format!("Invalid time {time:?} — expected HH:MM"))
}

fn weekday_from_index(weekday: u8) -> Result<Weekday> {
    Ok(match weekday {
        0 => Weekday::Sun,
        1 => Weekday::Mon,
        2 => Weekday::Tue,
        3 => Weekday::Wed,
        4 => Weekday::Thu,
        5 => Weekday::Fri,
        6 => Weekday::Sat,
        other => bail!("Invalid weekday {other} — expected 0 (Sunday) … 6 (Saturday)"),
    })
}

fn weekday_label(weekday: Weekday) -> &'static str {
    match weekday {
        Weekday::Sun => "Sunday",
        Weekday::Mon => "Monday",
        Weekday::Tue => "Tuesday",
        Weekday::Wed => "Wednesday",
        Weekday::Thu => "Thursday",
        Weekday::Fri => "Friday",
        Weekday::Sat => "Saturday",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn utc(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    /// UTC+8 — no DST, deterministic across test machines.
    fn tz_plus8() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }

    #[test]
    fn hourly_and_every_are_anchored_to_now() {
        let now = utc("2026-06-11T10:00:00Z");
        assert_eq!(
            next_run_after_in(&Schedule::Hourly, now, &tz_plus8()).unwrap(),
            utc("2026-06-11T11:00:00Z")
        );
        let every = Schedule::Every {
            amount: 5,
            unit: EveryUnit::Minutes,
        };
        assert_eq!(
            next_run_after_in(&every, now, &tz_plus8()).unwrap(),
            utc("2026-06-11T10:05:00Z")
        );
        let every_hours = Schedule::Every {
            amount: 3,
            unit: EveryUnit::Hours,
        };
        assert_eq!(
            next_run_after_in(&every_hours, now, &tz_plus8()).unwrap(),
            utc("2026-06-11T13:00:00Z")
        );
    }

    #[test]
    fn daily_today_when_time_not_yet_passed() {
        // 2026-06-11 10:00 UTC = 18:00 local (+8). Daily at 21:00 local →
        // today 21:00 local = 13:00 UTC.
        let now = utc("2026-06-11T10:00:00Z");
        let schedule = Schedule::Daily {
            time: "21:00".into(),
        };
        assert_eq!(
            next_run_after_in(&schedule, now, &tz_plus8()).unwrap(),
            utc("2026-06-11T13:00:00Z")
        );
    }

    #[test]
    fn daily_tomorrow_when_time_already_passed() {
        // 18:00 local, daily at 09:00 → tomorrow 09:00 local = 01:00 UTC.
        let now = utc("2026-06-11T10:00:00Z");
        let schedule = Schedule::Daily {
            time: "09:00".into(),
        };
        assert_eq!(
            next_run_after_in(&schedule, now, &tz_plus8()).unwrap(),
            utc("2026-06-12T01:00:00Z")
        );
    }

    #[test]
    fn daily_exact_boundary_rolls_to_next_day() {
        // Exactly 09:00 local: "strictly after now" → tomorrow.
        let now = utc("2026-06-11T01:00:00Z"); // 09:00 local (+8)
        let schedule = Schedule::Daily {
            time: "09:00".into(),
        };
        assert_eq!(
            next_run_after_in(&schedule, now, &tz_plus8()).unwrap(),
            utc("2026-06-12T01:00:00Z")
        );
    }

    #[test]
    fn weekly_same_day_later_time_fires_today() {
        // 2026-06-11 is a Thursday. 18:00 local, weekly Thu 20:00 → today.
        let now = utc("2026-06-11T10:00:00Z");
        let schedule = Schedule::Weekly {
            weekday: 4,
            time: "20:00".into(),
        };
        assert_eq!(
            next_run_after_in(&schedule, now, &tz_plus8()).unwrap(),
            utc("2026-06-11T12:00:00Z")
        );
    }

    #[test]
    fn weekly_wraps_to_next_week() {
        // Thursday 18:00 local, weekly Thu 09:00 → next Thursday.
        let now = utc("2026-06-11T10:00:00Z");
        let schedule = Schedule::Weekly {
            weekday: 4,
            time: "09:00".into(),
        };
        assert_eq!(
            next_run_after_in(&schedule, now, &tz_plus8()).unwrap(),
            utc("2026-06-18T01:00:00Z")
        );
    }

    #[test]
    fn weekly_crosses_into_earlier_weekday_next_week() {
        // Thursday, weekly Monday 08:00 → the coming Monday (Jun 15).
        let now = utc("2026-06-11T10:00:00Z");
        let schedule = Schedule::Weekly {
            weekday: 1,
            time: "08:00".into(),
        };
        assert_eq!(
            next_run_after_in(&schedule, now, &tz_plus8()).unwrap(),
            utc("2026-06-15T00:00:00Z")
        );
    }

    #[test]
    fn result_is_always_strictly_after_now() {
        let schedules = [
            Schedule::Hourly,
            Schedule::Daily {
                time: "00:00".into(),
            },
            Schedule::Weekly {
                weekday: 0,
                time: "23:59".into(),
            },
            Schedule::Every {
                amount: 1,
                unit: EveryUnit::Minutes,
            },
        ];
        let nows = [
            utc("2026-06-11T00:00:00Z"),
            utc("2026-06-11T23:59:00Z"),
            utc("2026-12-31T23:59:59Z"),
        ];
        for schedule in &schedules {
            for now in nows {
                let next = next_run_after_in(schedule, now, &tz_plus8()).unwrap();
                assert!(next > now, "{schedule:?} at {now} produced {next}");
            }
        }
    }

    #[test]
    fn validation_rejects_bad_inputs() {
        assert!(next_run_after_in(
            &Schedule::Daily {
                time: "25:00".into()
            },
            utc("2026-06-11T00:00:00Z"),
            &tz_plus8(),
        )
        .is_err());
        assert!(Schedule::Weekly {
            weekday: 7,
            time: "09:00".into()
        }
        .validate()
        .is_err());
        assert!(Schedule::Every {
            amount: 0,
            unit: EveryUnit::Hours
        }
        .validate()
        .is_err());
    }

    #[test]
    fn schedule_json_shape_is_stable() {
        // The JSON tag shape is the storage + IPC contract.
        let weekly = Schedule::Weekly {
            weekday: 4,
            time: "09:30".into(),
        };
        assert_eq!(
            serde_json::to_value(&weekly).unwrap(),
            serde_json::json!({"kind": "weekly", "weekday": 4, "time": "09:30"})
        );
        let every: Schedule = serde_json::from_value(
            serde_json::json!({"kind": "every", "amount": 15, "unit": "minutes"}),
        )
        .unwrap();
        assert_eq!(
            every,
            Schedule::Every {
                amount: 15,
                unit: EveryUnit::Minutes
            }
        );
    }

    #[test]
    fn format_utc_matches_db_timestamp_shape() {
        let formatted = format_utc(utc("2026-06-11T10:00:00Z"));
        assert_eq!(formatted, "2026-06-11T10:00:00.000Z");
    }
}
