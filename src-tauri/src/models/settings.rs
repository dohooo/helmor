use std::str::FromStr;

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use super::db;

/// Persisted choice for how new-workspace branch names are prefixed
/// for a repo. Stored on `repos.branch_prefix_type` as a lowercase
/// string. NULL columns are treated as `Username` by
/// [`crate::workspace::helpers::branch_name_for_directory`] so legacy
/// rows behave consistently with the explicit default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BranchPrefixType {
    /// `<forge_login>/<dir>` — use the bound gh/glab account login.
    Username,
    /// `<branch_prefix_custom><dir>` — user-supplied literal prefix.
    Custom,
    /// `<dir>` — no prefix at all.
    None,
}

impl BranchPrefixType {
    pub fn as_storage_str(self) -> &'static str {
        match self {
            BranchPrefixType::Username => "username",
            BranchPrefixType::Custom => "custom",
            BranchPrefixType::None => "none",
        }
    }
}

impl FromStr for BranchPrefixType {
    type Err = ();

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "username" => Ok(BranchPrefixType::Username),
            "custom" => Ok(BranchPrefixType::Custom),
            "none" => Ok(BranchPrefixType::None),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EffectiveBranchPrefixSettings {
    /// Resolved enum value parsed from `repos.branch_prefix_type`.
    /// NULL / unrecognised columns parse to `None`, which the resolver
    /// in [`crate::workspace::helpers::branch_name_for_directory`]
    /// treats as `Username` (the default).
    pub branch_prefix_type: Option<BranchPrefixType>,
    pub branch_prefix_custom: Option<String>,
    pub forge_provider: Option<String>,
    pub remote_url: Option<String>,
    /// gh/glab account login bound to this repo. Drives the
    /// `<login>/<dir>` shape under the `Username` mode.
    pub forge_login: Option<String>,
}

pub fn load_setting_value(key: &str) -> Result<Option<String>> {
    let connection = db::read_conn()?;
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
    let connection = db::write_conn()?;
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
    let connection = db::write_conn()?;
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

const AUTO_CLOSE_ACTION_KINDS_KEY: &str = "auto_close_action_kinds";
const AUTO_CLOSE_OPT_IN_ASKED_KEY: &str = "auto_close_opt_in_asked";

/// Account-global rate-limit snapshots: the raw upstream response body
/// is stored verbatim (no shape mapping) by the corresponding
/// `get_*_rate_limits` Tauri command after a live OAuth fetch, and read
/// back by the same command as the cache-fallback when a fresh fetch
/// fails. The frontend's `parse{Codex,Claude}RateLimits` does the
/// shape work, so a schema change at the provider only needs a parser
/// tweak — not a DB migration.
pub const CODEX_RATE_LIMITS_KEY: &str = "app.codex_rate_limits";
pub const CLAUDE_RATE_LIMITS_KEY: &str = "app.claude_rate_limits";

/// Action kinds the user has opted-in to auto-close. Action sessions whose
/// `action_kind` appears in this list are hidden automatically after their
/// verifier reports `Success`.
pub fn load_auto_close_action_kinds() -> Result<Vec<crate::agents::ActionKind>> {
    load_setting_json::<Vec<crate::agents::ActionKind>>(AUTO_CLOSE_ACTION_KINDS_KEY)
        .map(|opt| opt.unwrap_or_default())
}

pub fn save_auto_close_action_kinds(kinds: &[crate::agents::ActionKind]) -> Result<()> {
    upsert_setting_json(AUTO_CLOSE_ACTION_KINDS_KEY, &kinds)
}

/// Action kinds for which we've already shown the first-time opt-in prompt.
/// Separate from the opt-in list so "dismissed" and "enabled" are distinct
/// states — a dismissed kind stays in this list so we don't nag.
pub fn load_auto_close_opt_in_asked() -> Result<Vec<crate::agents::ActionKind>> {
    load_setting_json::<Vec<crate::agents::ActionKind>>(AUTO_CLOSE_OPT_IN_ASKED_KEY)
        .map(|opt| opt.unwrap_or_default())
}

pub fn save_auto_close_opt_in_asked(kinds: &[crate::agents::ActionKind]) -> Result<()> {
    upsert_setting_json(AUTO_CLOSE_OPT_IN_ASKED_KEY, &kinds)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use rusqlite::Connection;

    use super::BranchPrefixType;

    fn test_db() -> (Connection, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = Connection::open(&db_path).unwrap();
        crate::schema::ensure_schema(&conn).unwrap();
        (conn, dir)
    }

    #[test]
    fn branch_prefix_type_parses_canonical_variants() {
        assert_eq!(
            BranchPrefixType::from_str("username").unwrap(),
            BranchPrefixType::Username
        );
        assert_eq!(
            BranchPrefixType::from_str("custom").unwrap(),
            BranchPrefixType::Custom
        );
        assert_eq!(
            BranchPrefixType::from_str("none").unwrap(),
            BranchPrefixType::None
        );
    }

    #[test]
    fn branch_prefix_type_is_case_insensitive_and_trims_whitespace() {
        assert_eq!(
            BranchPrefixType::from_str("  USERNAME  ").unwrap(),
            BranchPrefixType::Username
        );
        assert_eq!(
            BranchPrefixType::from_str("Custom").unwrap(),
            BranchPrefixType::Custom
        );
        assert_eq!(
            BranchPrefixType::from_str("\tNone\n").unwrap(),
            BranchPrefixType::None
        );
    }

    #[test]
    fn branch_prefix_type_rejects_garbage() {
        assert!(BranchPrefixType::from_str("").is_err());
        assert!(BranchPrefixType::from_str("github").is_err());
        assert!(BranchPrefixType::from_str("gitlab").is_err());
        assert!(BranchPrefixType::from_str("default").is_err());
        assert!(BranchPrefixType::from_str("user").is_err());
    }

    #[test]
    fn branch_prefix_type_round_trips_storage_strings() {
        for variant in [
            BranchPrefixType::Username,
            BranchPrefixType::Custom,
            BranchPrefixType::None,
        ] {
            let stored = variant.as_storage_str();
            assert_eq!(
                BranchPrefixType::from_str(stored).unwrap(),
                variant,
                "{stored:?} did not round-trip"
            );
        }
    }

    #[test]
    fn settings_crud() {
        let (conn, _dir) = test_db();

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
        let (conn, _dir) = test_db();
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
    fn app_settings_roundtrip() {
        let (conn, _dir) = test_db();

        // Insert app settings
        conn.execute(
            "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('app.font_size', '16', datetime('now'), datetime('now'))",
            [],
        ).unwrap();

        // Read back
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings WHERE key LIKE 'app.%'")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "app.font_size");
        assert_eq!(rows[0].1, "16");
    }

    #[test]
    fn app_settings_upsert() {
        let (conn, _dir) = test_db();

        // Insert then update
        conn.execute(
            "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('app.font_size', '14', datetime('now'), datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('app.font_size', '18', datetime('now'), datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        ).unwrap();

        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app.font_size'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, "18");
    }
}
