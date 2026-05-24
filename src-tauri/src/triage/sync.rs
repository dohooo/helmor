//! Per-provider time checkpoint. One row per provider; updated after a
//! successful tick scans that provider.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};

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

pub fn advance_sync(provider_id: &str, at: DateTime<Utc>) -> Result<()> {
    let ts = at.to_rfc3339_opts(SecondsFormat::Secs, true);
    let connection = db::write_conn()?;
    connection
        .execute(
            "INSERT INTO triage_sync (provider_id, last_triaged_at, updated_at)
             VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(provider_id) DO UPDATE SET
                last_triaged_at = excluded.last_triaged_at,
                updated_at = datetime('now')",
            rusqlite::params![provider_id, ts],
        )
        .context("upsert triage_sync")?;
    Ok(())
}
