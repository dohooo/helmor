use std::collections::HashSet;

use anyhow::Result;
use serde_json::Value;

pub(super) const REPO_COMPACT_FIELDS: &[&str] = &[
    "id",
    "name",
    "remote",
    "remoteUrl",
    "defaultBranch",
    "forgeProvider",
    "forgeLogin",
    "repoInitials",
];

pub(super) const WORKSPACE_COMPACT_FIELDS: &[&str] = &[
    "id",
    "repo",
    "repoId",
    "repoName",
    "directory",
    "directoryName",
    "title",
    "status",
    "state",
    "branch",
    "remote",
    "remoteUrl",
    "defaultBranch",
    "rootPath",
    "activeSessionId",
    "activeSessionTitle",
    "primarySessionId",
    "primarySessionTitle",
    "sessionCount",
    "messageCount",
    "prTitle",
    "prUrl",
    "forgeProvider",
    "forgeLogin",
];

pub(super) const SESSION_COMPACT_FIELDS: &[&str] = &[
    "sessionId",
    "id",
    "workspaceId",
    "workspaceRef",
    "workspaceDirectory",
    "workspaceStatus",
    "repo",
    "title",
    "sessionStatus",
    "status",
    "active",
    "agentType",
    "model",
    "permissionMode",
    "updatedAt",
    "lastUserMessageAt",
    "actionKind",
];

pub(super) fn format_json_response<T: serde::Serialize>(
    args: &Value,
    data: &T,
    default_compact_fields: Option<&[&str]>,
) -> Result<String> {
    let mut value = serde_json::to_value(data)?;
    let compact = is_compact_response(args);
    let include_icon = args
        .get("include_icon")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !include_icon {
        strip_keys_recursive(&mut value, &["repoIconSrc"]);
    }
    if compact {
        remove_nulls_recursive(&mut value);
        truncate_long_strings(&mut value, 2_000);
        let fields = selected_fields(args).or_else(|| {
            default_compact_fields
                .map(|items| items.iter().map(|item| (*item).to_string()).collect())
        });
        if let Some(fields) = fields.as_ref() {
            apply_field_filter(&mut value, fields);
        }
    }

    Ok(serde_json::to_string_pretty(&value)?)
}

fn selected_fields(args: &Value) -> Option<HashSet<String>> {
    let values = args.get("fields")?.as_array()?;
    let fields: HashSet<String> = values
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|field| !field.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    (!fields.is_empty()).then_some(fields)
}

pub(super) fn is_compact_response(args: &Value) -> bool {
    !matches!(
        args.get("response_mode").and_then(Value::as_str),
        Some("full")
    )
}

fn strip_keys_recursive(value: &mut Value, keys: &[&str]) {
    match value {
        Value::Object(map) => {
            for key in keys {
                map.remove(*key);
            }
            for child in map.values_mut() {
                strip_keys_recursive(child, keys);
            }
        }
        Value::Array(items) => {
            for item in items {
                strip_keys_recursive(item, keys);
            }
        }
        _ => {}
    }
}

fn remove_nulls_recursive(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|_, child| !child.is_null());
            for child in map.values_mut() {
                remove_nulls_recursive(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                remove_nulls_recursive(item);
            }
        }
        _ => {}
    }
}

fn truncate_long_strings(value: &mut Value, max_chars: usize) {
    match value {
        Value::String(text) if text.chars().count() > max_chars => {
            *text = truncate_text(text, max_chars);
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                truncate_long_strings(child, max_chars);
            }
        }
        Value::Array(items) => {
            for item in items {
                truncate_long_strings(item, max_chars);
            }
        }
        _ => {}
    }
}

pub(super) fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

fn apply_field_filter(value: &mut Value, fields: &HashSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                filter_object_to_fields(item, fields);
            }
        }
        Value::Object(map) => {
            let list_keys = ["repositories", "workspaces", "sessions"];
            let mut filtered_nested = false;
            for key in list_keys {
                if let Some(child) = map.get_mut(key) {
                    apply_field_filter(child, fields);
                    filtered_nested = true;
                }
            }
            if !filtered_nested {
                map.retain(|key, _| fields.contains(key));
            }
        }
        _ => {}
    }
}

fn filter_object_to_fields(value: &mut Value, fields: &HashSet<String>) {
    if let Value::Object(map) = value {
        map.retain(|key, _| fields.contains(key));
    }
}
