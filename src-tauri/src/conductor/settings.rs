use super::db;

#[derive(Debug, Clone)]
pub struct BranchPrefixSettings {
    pub branch_prefix_type: Option<String>,
    pub branch_prefix_custom: Option<String>,
}

pub fn load_setting_value(key: &str) -> Result<Option<String>, String> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|error| format!("Failed to prepare settings lookup for {key}: {error}"))?;
    let mut rows = statement
        .query_map([key], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Failed to query settings value for {key}: {error}"))?;

    match rows.next() {
        Some(result) => result
            .map(Some)
            .map_err(|error| format!("Failed to deserialize settings value for {key}: {error}")),
        None => Ok(None),
    }
}

pub fn upsert_setting_value(key: &str, value: &str) -> Result<(), String> {
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
        .map_err(|error| format!("Failed to store setting {key}: {error}"))?;

    Ok(())
}

pub fn load_branch_prefix_settings() -> Result<BranchPrefixSettings, String> {
    let connection = db::open_connection(false)?;
    let mut statement = connection
        .prepare(
            "SELECT key, value FROM settings WHERE key IN ('branch_prefix_type', 'branch_prefix_custom')",
        )
        .map_err(|error| format!("Failed to prepare branch settings query: {error}"))?;

    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Failed to query branch settings: {error}"))?;

    let mut settings = BranchPrefixSettings {
        branch_prefix_type: None,
        branch_prefix_custom: None,
    };

    for row in rows {
        let (key, value) =
            row.map_err(|error| format!("Failed to read branch settings row: {error}"))?;
        match key.as_str() {
            "branch_prefix_type" => settings.branch_prefix_type = Some(value),
            "branch_prefix_custom" => settings.branch_prefix_custom = Some(value),
            _ => {}
        }
    }

    Ok(settings)
}
