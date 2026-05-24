//! Per-provider time checkpoint. One row per provider; updated after a
//! successful tick scans that provider.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use chrono::{DateTime, Local, SecondsFormat};

use crate::models::db;

pub fn load_sync_map() -> Result<BTreeMap<String, String>> {
    let connection = db::read_conn()?;
    let mut stmt = connection
        .prepare("SELECT provider_id, last_triaged_at FROM triage_sync")
        .context("prepare load_sync_map")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .context("query load_sync_map")?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (k, v) = row?;
        out.insert(k, v);
    }
    Ok(out)
}

pub fn advance_sync(provider_id: &str, at: DateTime<Local>) -> Result<()> {
    // Persist as RFC3339 with the local UTC offset (e.g. "+08:00") instead
    // of the bare `Z` so anyone eyeballing the DB sees their wall-clock time.
    let ts = at.to_rfc3339_opts(SecondsFormat::Secs, false);
    let now = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    let connection = db::write_conn()?;
    connection
        .execute(
            "INSERT INTO triage_sync (provider_id, last_triaged_at, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(provider_id) DO UPDATE SET
                last_triaged_at = excluded.last_triaged_at,
                updated_at = excluded.updated_at",
            rusqlite::params![provider_id, ts, now],
        )
        .context("upsert triage_sync")?;
    Ok(())
}
