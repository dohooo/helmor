//! Typed wrappers around `lark-cli contact` subcommands.

use std::sync::OnceLock;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::Mutex;

use super::cli::run;

/// Process-wide `open_id` cache; CLI is ~200ms and auth-login restarts the app.
fn cached() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Open-id of the authed user.
pub async fn self_open_id() -> Result<String> {
    let mut guard = cached().lock().await;
    if let Some(id) = guard.as_ref() {
        return Ok(id.clone());
    }
    let raw = run(
        &[
            "contact",
            "+get-user",
            "--format",
            "json",
            "--user-id-type",
            "open_id",
        ],
        "contact get-user (self)",
    )
    .await?;
    let open_id = extract_open_id(&raw)
        .ok_or_else(|| anyhow!("lark contact +get-user response missing open_id"))?;
    *guard = Some(open_id.clone());
    Ok(open_id)
}

/// Lark response shape bounced between `data.user.open_id` and `data.open_id`; walk both then deep-search.
fn extract_open_id(raw: &Value) -> Option<String> {
    if let Some(s) = raw
        .pointer("/data/user/open_id")
        .or_else(|| raw.pointer("/data/open_id"))
        .or_else(|| raw.pointer("/open_id"))
        .and_then(Value::as_str)
    {
        return Some(s.to_string());
    }
    deep_find_string(raw, "open_id")
}

fn deep_find_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(s)) = map.get(key) {
                return Some(s.clone());
            }
            for v in map.values() {
                if let Some(found) = deep_find_string(v, key) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(arr) => {
            for v in arr {
                if let Some(found) = deep_find_string(v, key) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_open_id_from_nested_user() {
        let raw = json!({ "data": { "user": { "open_id": "ou_abc", "name": "x" } } });
        assert_eq!(extract_open_id(&raw).as_deref(), Some("ou_abc"));
    }

    #[test]
    fn extracts_open_id_from_flat_data() {
        let raw = json!({ "data": { "open_id": "ou_xyz", "name": "y" } });
        assert_eq!(extract_open_id(&raw).as_deref(), Some("ou_xyz"));
    }

    #[test]
    fn deep_search_fallback() {
        let raw = json!({
            "data": { "items": [{ "user_info": { "open_id": "ou_deep" } }] }
        });
        assert_eq!(extract_open_id(&raw).as_deref(), Some("ou_deep"));
    }

    #[test]
    fn returns_none_when_absent() {
        let raw = json!({ "data": { "name": "y" } });
        assert!(extract_open_id(&raw).is_none());
    }
}
