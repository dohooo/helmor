use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};

use super::db;

#[derive(Debug, Clone)]
pub struct BranchPrefixSettings {
    pub branch_prefix_type: Option<String>,
    pub branch_prefix_custom: Option<String>,
}

pub fn load_setting_value(key: &str) -> Result<Option<String>> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .with_context(|| format!("Failed to prepare settings lookup for {key}"))?;
    let mut rows = statement
        .query_map([key], |row| row.get::<_, String>(0))
        .with_context(|| format!("Failed to query settings value for {key}"))?;

    match rows.next() {
        Some(result) => result
            .map(Some)
            .with_context(|| format!("Failed to deserialize settings value for {key}")),
        None => Ok(None),
    }
}

pub fn upsert_setting_value(key: &str, value: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute(
            r#"
            INSERT INTO settings (key, value, created_at, updated_at)
            VALUES (?1, ?2, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = datetime('now')
            "#,
            (key, value),
        )
        .with_context(|| format!("Failed to store setting {key}"))?;

    Ok(())
}

pub fn delete_setting_value(key: &str) -> Result<()> {
    let connection = db::open_connection(true)?;
    connection
        .execute("DELETE FROM settings WHERE key = ?1", [key])
        .with_context(|| format!("Failed to delete setting {key}"))?;

    Ok(())
}

pub fn load_setting_json<T: DeserializeOwned>(key: &str) -> Result<Option<T>> {
    let Some(value) = load_setting_value(key)? else {
        return Ok(None);
    };

    let parsed = serde_json::from_str::<T>(&value)
        .with_context(|| format!("Failed to deserialize JSON setting {key}"))?;

    Ok(Some(parsed))
}

pub fn upsert_setting_json<T: Serialize>(key: &str, value: &T) -> Result<()> {
    let serialized = serde_json::to_string(value)
        .with_context(|| format!("Failed to serialize JSON setting {key}"))?;
    upsert_setting_value(key, &serialized)
}

pub fn load_branch_prefix_settings() -> Result<BranchPrefixSettings> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
            "SELECT key, value FROM settings WHERE key IN ('branch_prefix_type', 'branch_prefix_custom')",
        )
        .context("Failed to prepare branch settings query")?;

    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .context("Failed to query branch settings")?;

    let mut settings = BranchPrefixSettings {
        branch_prefix_type: None,
        branch_prefix_custom: None,
    };

    for row in rows {
        let (key, value) = row.context("Failed to read branch settings row")?;
        match key.as_str() {
            "branch_prefix_type" => settings.branch_prefix_type = Some(value),
            "branch_prefix_custom" => settings.branch_prefix_custom = Some(value),
            _ => {}
        }
    }

    Ok(settings)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn settings_crud() {
        let conn = test_db();

        // Missing key returns no rows
        let mut stmt = conn
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .unwrap();
        let result: Option<String> = stmt
            .query_map(["nonexistent"], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .next();
        assert!(result.is_none());

        // Insert
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('test_key', 'test_value')",
            [],
        )
        .unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'test_key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "test_value");
    }

    #[test]
    fn settings_upsert_overwrites() {
        let conn = test_db();
        conn.execute("INSERT INTO settings (key, value) VALUES ('k', 'v1')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('k', 'v2') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        ).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(value, "v2");
    }

    #[test]
    fn branch_prefix_settings_query() {
        let conn = test_db();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('branch_prefix_type', 'custom')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('branch_prefix_custom', 'feat/')",
            [],
        )
        .unwrap();

        let mut stmt = conn.prepare(
            "SELECT key, value FROM settings WHERE key IN ('branch_prefix_type', 'branch_prefix_custom')"
        ).unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|(k, v)| k == "branch_prefix_type" && v == "custom"));
        assert!(rows
            .iter()
            .any(|(k, v)| k == "branch_prefix_custom" && v == "feat/"));
    }
}
