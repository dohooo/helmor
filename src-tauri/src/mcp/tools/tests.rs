use super::super::catalog::tool_catalog;
use super::super::response::{format_json_response, REPO_COMPACT_FIELDS};
use super::common::workspace_status_matches;
use super::*;
use crate::workspace::status::WorkspaceStatus;
use serde_json::json;

#[test]
fn tool_catalog_lists_expected_names() {
    let catalog = tool_catalog();
    let names: Vec<&str> = catalog
        .iter()
        .map(|t| t["name"].as_str().expect("each tool has a name"))
        .collect();
    // Frozen list — drift between this and `dispatch_tool` would be a bug.
    let expected = vec![
        "helmor_data_info",
        "helmor_repo_list",
        "helmor_repo_add",
        "helmor_workspace_list",
        "helmor_workspace_show",
        "helmor_workspace_create",
        "helmor_workspace_set_status",
        "helmor_workspace_archive",
        "helmor_workspace_permanently_delete",
        "helmor_workspace_run_action",
        "helmor_session_list",
        "helmor_session_create",
        "helmor_session_search",
        "helmor_session_get_messages",
        "helmor_send",
    ];
    assert_eq!(names, expected);
}

#[test]
fn tool_catalog_entries_have_object_schemas() {
    for tool in tool_catalog() {
        let name = tool["name"].as_str().unwrap();
        let schema = &tool["inputSchema"];
        assert_eq!(
            schema["type"].as_str(),
            Some("object"),
            "tool `{name}` inputSchema.type must be \"object\""
        );
    }
}

#[test]
fn dispatch_unknown_tool_returns_error() {
    let err = dispatch_tool("not_a_real_tool", &json!({})).unwrap_err();
    assert!(format!("{err:#}").contains("Unknown tool"));
}

#[test]
fn workspace_list_schema_advertises_filter_props() {
    let catalog = tool_catalog();
    let list = catalog
        .iter()
        .find(|t| t["name"] == "helmor_workspace_list")
        .expect("helmor_workspace_list present");
    let props = &list["inputSchema"]["properties"];
    assert!(props.get("status").is_some());
    assert!(props.get("repo").is_some());
    assert!(props.get("archived").is_some());
    assert!(props.get("limit").is_some());
}

#[test]
fn every_tool_schema_advertises_response_options() {
    for tool in tool_catalog() {
        let name = tool["name"].as_str().unwrap();
        let props = &tool["inputSchema"]["properties"];
        assert!(
            props.get("response_mode").is_some(),
            "{name} missing response_mode"
        );
        assert!(props.get("fields").is_some(), "{name} missing fields");
        assert!(
            props.get("include_icon").is_some(),
            "{name} missing include_icon"
        );
    }
}

#[test]
fn compact_response_strips_icons_and_filters_fields() {
    let data = json!([{
        "id": "repo-1",
        "name": "helmor",
        "remoteUrl": "git@github.com:dohooo/helmor.git",
        "repoIconSrc": "data:image/png;base64,AAAA",
        "unused": "drop-me"
    }]);
    let rendered = format_json_response(
        &json!({
            "fields": ["name", "remoteUrl"]
        }),
        &data,
        Some(REPO_COMPACT_FIELDS),
    )
    .unwrap();
    assert!(rendered.contains("helmor"));
    assert!(rendered.contains("remoteUrl"));
    assert!(!rendered.contains("repoIconSrc"));
    assert!(!rendered.contains("drop-me"));
}

#[test]
fn workspace_set_status_requires_both_args() {
    // Missing status
    let err = workspace::tool_workspace_set_status(&json!({ "ref": "abc" })).unwrap_err();
    assert!(format!("{err:#}").contains("status"));
    // Missing ref
    let err = workspace::tool_workspace_set_status(&json!({ "status": "done" })).unwrap_err();
    assert!(format!("{err:#}").contains("ref"));
}

#[test]
fn workspace_permanently_delete_requires_explicit_confirmation() {
    let err = workspace::tool_workspace_permanently_delete(&json!({
        "workspace": "any-ref",
        "confirmed": false
    }))
    .unwrap_err();
    let msg = format!("{err:#}");
    assert!(msg.contains("confirmed"));
}

#[test]
fn session_search_requires_query_or_status() {
    let err = session::tool_session_search(&json!({})).unwrap_err();
    assert!(format!("{err:#}").contains("query"));
}

#[test]
fn workspace_run_action_rejects_unknown_actions() {
    let err = workspace::tool_workspace_run_action(&json!({
        "workspace": "irrelevant",
        "action": "publish_release",
    }))
    .unwrap_err();

    let msg = format!("{err:#}");
    assert!(msg.contains("unknown action"), "unexpected error: {msg}");
}

#[test]
fn workspace_status_matches_accepts_kanban_and_canonical() {
    // group_id form
    assert!(workspace_status_matches(
        &WorkspaceStatus::InProgress,
        "progress"
    ));
    assert!(workspace_status_matches(&WorkspaceStatus::Done, "done"));
    // canonical kebab form
    assert!(workspace_status_matches(
        &WorkspaceStatus::InProgress,
        "in-progress"
    ));
    // case-insensitive
    assert!(workspace_status_matches(&WorkspaceStatus::Review, "Review"));
    assert!(!workspace_status_matches(&WorkspaceStatus::Done, "review"));
}
