//! Collapse consecutive search/read tool calls into summary groups.
//!
//! Ported from `collapse-read-search.ts`. Operates on `ExtendedMessagePart`
//! slices within a single assistant message, replacing sequences of
//! collapsible tool-call parts with a `CollapsedGroupPart` summary.

use serde_json::Value;

use super::classify::{classify_tool, is_collapsible, ToolCategory};
use super::types::{
    CollapseCategory, CollapsedGroupPart, ExtendedMessagePart, MessagePart, MessageRole,
    ThreadMessageLike,
};

// ---------------------------------------------------------------------------
// Summary text generation
// ---------------------------------------------------------------------------

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max.saturating_sub(1);
    // Avoid splitting a multi-byte char
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\u{2026}", &s[..end])
}

/// Extract a search pattern string from tool args.
fn extract_pattern(args: &Value) -> Option<&str> {
    for key in &["pattern", "query", "search", "regex", "glob"] {
        if let Some(v) = args.get(key).and_then(Value::as_str) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// Extract a file path from tool args.
fn extract_file_path(args: &Value) -> Option<&str> {
    for key in &["file_path", "path", "file", "url"] {
        if let Some(v) = args.get(key).and_then(Value::as_str) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// Build a human-readable summary for a collapsed group.
///
/// Follows Claude Code TUI's `getSearchReadSummaryText` format:
/// - Active groups use present tense + "..."
/// - Completed groups use past tense
/// - Patterns are quoted and de-duplicated
/// - File counts are aggregated
pub fn build_group_summary(tools: &[MessagePart], active: bool) -> String {
    let mut search_tools: Vec<&MessagePart> = Vec::new();
    let mut read_tools: Vec<&MessagePart> = Vec::new();

    for t in tools {
        if let MessagePart::ToolCall { tool_name, .. } = t {
            match classify_tool(tool_name) {
                ToolCategory::Search => search_tools.push(t),
                _ => read_tools.push(t),
            }
        }
    }

    let mut parts: Vec<String> = Vec::new();

    // Search summary
    if !search_tools.is_empty() {
        let mut patterns = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for t in &search_tools {
            if let MessagePart::ToolCall { args, .. } = t {
                if let Some(p) = extract_pattern(args) {
                    let truncated = truncate(p, 40);
                    if seen.insert(truncated.clone()) {
                        patterns.push(truncated);
                    }
                }
            }
        }

        if patterns.len() == 1 {
            let verb = if active {
                "Searching for"
            } else {
                "Searched for"
            };
            let count_suffix = if search_tools.len() > 1 {
                format!(" ({}\u{00d7})", search_tools.len())
            } else {
                String::new()
            };
            parts.push(format!("{verb} '{}'{count_suffix}", patterns[0]));
        } else if patterns.len() > 1 {
            let verb = if active { "Searching" } else { "Searched" };
            parts.push(format!("{verb} {} patterns", search_tools.len()));
        } else {
            let verb = if active { "Searching" } else { "Searched" };
            let plural = if search_tools.len() > 1 { "s" } else { "" };
            parts.push(format!("{verb} {} time{plural}", search_tools.len()));
        }
    }

    // Read summary
    if !read_tools.is_empty() {
        let mut paths = std::collections::HashSet::new();
        for t in &read_tools {
            if let MessagePart::ToolCall { args, .. } = t {
                if let Some(p) = extract_file_path(args) {
                    paths.insert(p);
                }
            }
        }

        let count = if paths.is_empty() {
            read_tools.len()
        } else {
            paths.len()
        };
        let verb = if parts.is_empty() {
            if active {
                "Reading"
            } else {
                "Read"
            }
        } else if active {
            "reading"
        } else {
            "read"
        };
        let plural = if count > 1 { "s" } else { "" };
        parts.push(format!("{verb} {count} file{plural}"));
    }

    if parts.is_empty() {
        return if active {
            "Working...".to_string()
        } else {
            "Done".to_string()
        };
    }

    let joined = parts.join(", ");
    if active {
        format!("{joined}...")
    } else {
        joined
    }
}

// ---------------------------------------------------------------------------
// Core collapse algorithm
// ---------------------------------------------------------------------------

/// Collapse consecutive collapsible tool-call parts into `CollapsedGroupPart`.
///
/// Rules:
/// - Consecutive search/read tool-calls accumulate into a group
/// - A reasoning part passes through without breaking the group
/// - A text part or non-collapsible tool-call flushes the group
/// - Groups of >= 2 tools are collapsed; single tools are kept as-is
/// - The last group in a streaming message is marked active if its
///   last tool has no result yet
fn collapse_tool_calls_in_parts(
    parts: Vec<ExtendedMessagePart>,
    is_streaming: bool,
) -> Vec<ExtendedMessagePart> {
    let mut result: Vec<ExtendedMessagePart> = Vec::new();
    let mut current_group: Vec<MessagePart> = Vec::new();

    let flush_group =
        |group: &mut Vec<MessagePart>, out: &mut Vec<ExtendedMessagePart>, is_streaming: bool| {
            if group.is_empty() {
                return;
            }
            if group.len() >= 2 {
                let mut has_search = false;
                let mut has_read = false;
                for t in group.iter() {
                    if let MessagePart::ToolCall { tool_name, .. } = t {
                        match classify_tool(tool_name) {
                            ToolCategory::Search => has_search = true,
                            _ => has_read = true,
                        }
                    }
                }
                let category = match (has_search, has_read) {
                    (true, true) => CollapseCategory::Mixed,
                    (true, false) => CollapseCategory::Search,
                    _ => CollapseCategory::Read,
                };

                let active = is_streaming
                    && matches!(
                        group.last(),
                        Some(MessagePart::ToolCall { result: None, .. })
                    );

                let summary = build_group_summary(group, active);
                out.push(ExtendedMessagePart::CollapsedGroup(
                    CollapsedGroupPart::new(category, std::mem::take(group), active, summary),
                ));
            } else {
                for part in group.drain(..) {
                    out.push(ExtendedMessagePart::Basic(part));
                }
            }
        };

    for part in parts {
        match &part {
            ExtendedMessagePart::Basic(MessagePart::ToolCall { tool_name, .. })
                if is_collapsible(tool_name) =>
            {
                if let ExtendedMessagePart::Basic(mp) = part {
                    current_group.push(mp);
                }
            }
            ExtendedMessagePart::Basic(MessagePart::Reasoning { .. }) => {
                // Reasoning passes through without breaking the group
                result.push(part);
            }
            _ => {
                // Text or non-collapsible tool — flush current group
                flush_group(&mut current_group, &mut result, is_streaming);
                result.push(part);
            }
        }
    }

    // Flush trailing group (common during streaming)
    flush_group(&mut current_group, &mut result, is_streaming);

    // Recurse into children of non-collapsible tool-calls (Agent, Task, etc.)
    for part in &mut result {
        if let ExtendedMessagePart::Basic(MessagePart::ToolCall {
            children,
            tool_name,
            ..
        }) = part
        {
            if !children.is_empty() && !is_collapsible(tool_name) {
                let child_parts = std::mem::take(children);
                *children = collapse_tool_calls_in_parts(child_parts, is_streaming);
            }
        }
    }

    result
}

/// Apply the collapse pass to all assistant messages in the thread.
pub fn collapse_pass(messages: &mut [ThreadMessageLike]) {
    for msg in messages.iter_mut() {
        if msg.role != MessageRole::Assistant {
            continue;
        }
        let is_streaming = msg.streaming.unwrap_or(false);
        let parts = std::mem::take(&mut msg.content);
        msg.content = collapse_tool_calls_in_parts(parts, is_streaming);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tc(name: &str, args: Value, result: Option<Value>) -> ExtendedMessagePart {
        ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id: format!("tc_{name}"),
            tool_name: name.to_string(),
            args: args.clone(),
            args_text: serde_json::to_string(&args).unwrap(),
            result,
            streaming_status: None,
            children: Vec::new(),
        })
    }

    fn text(t: &str) -> ExtendedMessagePart {
        ExtendedMessagePart::Basic(MessagePart::Text {
            text: t.to_string(),
        })
    }

    fn reasoning(t: &str) -> ExtendedMessagePart {
        ExtendedMessagePart::Basic(MessagePart::Reasoning {
            text: t.to_string(),
            streaming: None,
        })
    }

    #[test]
    fn collapse_two_search_tools() {
        let parts = vec![
            tc("grep", json!({"pattern": "foo"}), Some(json!("result1"))),
            tc("grep", json!({"pattern": "foo"}), Some(json!("result2"))),
        ];
        let result = collapse_tool_calls_in_parts(parts, false);
        assert_eq!(result.len(), 1);
        if let ExtendedMessagePart::CollapsedGroup(g) = &result[0] {
            assert_eq!(g.category, CollapseCategory::Search);
            assert_eq!(g.tools.len(), 2);
            assert!(!g.active);
            assert!(g.summary.contains("Searched for 'foo'"));
            assert!(g.summary.contains("2\u{00d7}"));
        } else {
            panic!("expected collapsed group");
        }
    }

    #[test]
    fn single_tool_not_collapsed() {
        let parts = vec![tc("grep", json!({"pattern": "foo"}), Some(json!("result")))];
        let result = collapse_tool_calls_in_parts(parts, false);
        assert_eq!(result.len(), 1);
        assert!(matches!(result[0], ExtendedMessagePart::Basic(_)));
    }

    #[test]
    fn reasoning_does_not_break_group() {
        let parts = vec![
            tc("grep", json!({"pattern": "a"}), Some(json!("r1"))),
            reasoning("thinking..."),
            tc("grep", json!({"pattern": "a"}), Some(json!("r2"))),
        ];
        let result = collapse_tool_calls_in_parts(parts, false);
        // reasoning + collapsed group
        assert_eq!(result.len(), 2);
        assert!(matches!(
            result[0],
            ExtendedMessagePart::Basic(MessagePart::Reasoning { .. })
        ));
        assert!(matches!(result[1], ExtendedMessagePart::CollapsedGroup(_)));
    }

    #[test]
    fn text_breaks_group() {
        let parts = vec![
            tc("grep", json!({"pattern": "a"}), Some(json!("r1"))),
            text("some text"),
            tc("grep", json!({"pattern": "b"}), Some(json!("r2"))),
        ];
        let result = collapse_tool_calls_in_parts(parts, false);
        // single tool + text + single tool (groups of 1 not collapsed)
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn mixed_search_read() {
        let parts = vec![
            tc("grep", json!({"pattern": "x"}), Some(json!("r"))),
            tc(
                "read",
                json!({"file_path": "/a.txt"}),
                Some(json!("content")),
            ),
        ];
        let result = collapse_tool_calls_in_parts(parts, false);
        assert_eq!(result.len(), 1);
        if let ExtendedMessagePart::CollapsedGroup(g) = &result[0] {
            assert_eq!(g.category, CollapseCategory::Mixed);
        } else {
            panic!("expected collapsed group");
        }
    }

    #[test]
    fn streaming_active_flag() {
        let parts = vec![
            tc("grep", json!({"pattern": "x"}), Some(json!("r"))),
            tc("grep", json!({"pattern": "y"}), None), // no result yet
        ];
        let result = collapse_tool_calls_in_parts(parts, true);
        assert_eq!(result.len(), 1);
        if let ExtendedMessagePart::CollapsedGroup(g) = &result[0] {
            assert!(g.active);
            assert!(g.summary.ends_with("..."));
        } else {
            panic!("expected collapsed group");
        }
    }

    #[test]
    fn summary_read_files() {
        let tools = vec![
            MessagePart::ToolCall {
                tool_call_id: "1".to_string(),
                tool_name: "read".to_string(),
                args: json!({"file_path": "/a.txt"}),
                args_text: "{}".to_string(),
                result: Some(json!("content")),
                streaming_status: None,
                children: Vec::new(),
            },
            MessagePart::ToolCall {
                tool_call_id: "2".to_string(),
                tool_name: "read".to_string(),
                args: json!({"file_path": "/b.txt"}),
                args_text: "{}".to_string(),
                result: Some(json!("content")),
                streaming_status: None,
                children: Vec::new(),
            },
            MessagePart::ToolCall {
                tool_call_id: "3".to_string(),
                tool_name: "read".to_string(),
                args: json!({"file_path": "/c.txt"}),
                args_text: "{}".to_string(),
                result: Some(json!("content")),
                streaming_status: None,
                children: Vec::new(),
            },
        ];
        let summary = build_group_summary(&tools, false);
        assert_eq!(summary, "Read 3 files");
    }

    // -- Helpers for children tests ------------------------------------------

    fn tc_with_children(
        name: &str,
        args: Value,
        result: Option<Value>,
        children: Vec<ExtendedMessagePart>,
    ) -> ExtendedMessagePart {
        ExtendedMessagePart::Basic(MessagePart::ToolCall {
            tool_call_id: format!("tc_{name}"),
            tool_name: name.to_string(),
            args: args.clone(),
            args_text: serde_json::to_string(&args).unwrap(),
            result,
            streaming_status: None,
            children,
        })
    }

    fn unwrap_children(part: &ExtendedMessagePart) -> &Vec<ExtendedMessagePart> {
        match part {
            ExtendedMessagePart::Basic(MessagePart::ToolCall { children, .. }) => children,
            _ => panic!("expected ToolCall with children"),
        }
    }

    // -- Children collapse tests ---------------------------------------------

    #[test]
    fn agent_children_consecutive_reads_collapsed() {
        let children = vec![
            tc("Read", json!({"file_path": "/a.rs"}), Some(json!("a"))),
            tc("Read", json!({"file_path": "/b.rs"}), Some(json!("b"))),
            tc("Read", json!({"file_path": "/c.rs"}), Some(json!("c"))),
        ];
        let parts = vec![tc_with_children(
            "Agent",
            json!({"description": "explore"}),
            Some(json!("done")),
            children,
        )];
        let result = collapse_tool_calls_in_parts(parts, false);
        assert_eq!(result.len(), 1);
        let kids = unwrap_children(&result[0]);
        assert_eq!(kids.len(), 1);
        if let ExtendedMessagePart::CollapsedGroup(g) = &kids[0] {
            assert_eq!(g.category, CollapseCategory::Read);
            assert_eq!(g.tools.len(), 3);
            assert_eq!(g.summary, "Read 3 files");
        } else {
            panic!("expected collapsed group in children");
        }
    }

    #[test]
    fn agent_children_consecutive_searches_collapsed() {
        let children = vec![
            tc("Grep", json!({"pattern": "foo"}), Some(json!("r1"))),
            tc("Grep", json!({"pattern": "bar"}), Some(json!("r2"))),
        ];
        let parts = vec![tc_with_children(
            "Agent",
            json!({"description": "search"}),
            Some(json!("done")),
            children,
        )];
        let result = collapse_tool_calls_in_parts(parts, false);
        let kids = unwrap_children(&result[0]);
        assert_eq!(kids.len(), 1);
        if let ExtendedMessagePart::CollapsedGroup(g) = &kids[0] {
            assert_eq!(g.category, CollapseCategory::Search);
            assert_eq!(g.tools.len(), 2);
            assert!(g.summary.contains("Searched 2 patterns"));
        } else {
            panic!("expected collapsed group in children");
        }
    }

    #[test]
    fn agent_children_mixed_with_text_breaks_groups() {
        let children = vec![
            tc("Grep", json!({"pattern": "a"}), Some(json!("r1"))),
            tc("Grep", json!({"pattern": "b"}), Some(json!("r2"))),
            text("analyzing results..."),
            tc("Read", json!({"file_path": "/x.rs"}), Some(json!("x"))),
            tc("Read", json!({"file_path": "/y.rs"}), Some(json!("y"))),
        ];
        let parts = vec![tc_with_children(
            "Task",
            json!({"description": "work"}),
            Some(json!("done")),
            children,
        )];
        let result = collapse_tool_calls_in_parts(parts, false);
        let kids = unwrap_children(&result[0]);
        // collapsed search group + text + collapsed read group
        assert_eq!(kids.len(), 3);
        assert!(matches!(kids[0], ExtendedMessagePart::CollapsedGroup(_)));
        assert!(matches!(
            kids[1],
            ExtendedMessagePart::Basic(MessagePart::Text { .. })
        ));
        assert!(matches!(kids[2], ExtendedMessagePart::CollapsedGroup(_)));
    }

    #[test]
    fn agent_children_single_tool_not_collapsed() {
        let children = vec![tc(
            "Read",
            json!({"file_path": "/a.rs"}),
            Some(json!("a")),
        )];
        let parts = vec![tc_with_children(
            "Agent",
            json!({"description": "read"}),
            Some(json!("done")),
            children,
        )];
        let result = collapse_tool_calls_in_parts(parts, false);
        let kids = unwrap_children(&result[0]);
        assert_eq!(kids.len(), 1);
        assert!(matches!(kids[0], ExtendedMessagePart::Basic(_)));
    }

    #[test]
    fn agent_children_streaming_active() {
        let children = vec![
            tc("Read", json!({"file_path": "/a.rs"}), Some(json!("a"))),
            tc("Read", json!({"file_path": "/b.rs"}), None), // no result yet
        ];
        let parts = vec![tc_with_children(
            "Agent",
            json!({"description": "read"}),
            None,
            children,
        )];
        let result = collapse_tool_calls_in_parts(parts, true);
        let kids = unwrap_children(&result[0]);
        assert_eq!(kids.len(), 1);
        if let ExtendedMessagePart::CollapsedGroup(g) = &kids[0] {
            assert!(g.active);
            assert!(g.summary.ends_with("..."));
        } else {
            panic!("expected active collapsed group in children");
        }
    }

    #[test]
    fn empty_children_untouched() {
        let parts = vec![tc(
            "Agent",
            json!({"description": "noop"}),
            Some(json!("done")),
        )];
        let result = collapse_tool_calls_in_parts(parts, false);
        assert_eq!(result.len(), 1);
        let kids = unwrap_children(&result[0]);
        assert!(kids.is_empty());
    }

    #[test]
    fn collapsible_tool_children_not_recursed() {
        // Collapsible tools (Read, Grep) don't have meaningful children in
        // practice, but verify we don't recurse into them even if they did.
        let child_with_kids = tc_with_children(
            "Read",
            json!({"file_path": "/a.rs"}),
            Some(json!("a")),
            vec![
                tc("Read", json!({"file_path": "/nested1.rs"}), Some(json!("n1"))),
                tc("Read", json!({"file_path": "/nested2.rs"}), Some(json!("n2"))),
            ],
        );
        let parts = vec![
            child_with_kids,
            tc("Read", json!({"file_path": "/b.rs"}), Some(json!("b"))),
        ];
        let result = collapse_tool_calls_in_parts(parts, false);
        // Both reads collapse into a group; children inside Read are not touched
        assert_eq!(result.len(), 1);
        assert!(matches!(result[0], ExtendedMessagePart::CollapsedGroup(_)));
    }

    #[test]
    fn collapse_pass_recurses_children() {
        let children = vec![
            tc("Grep", json!({"pattern": "todo"}), Some(json!("r1"))),
            tc("Grep", json!({"pattern": "fixme"}), Some(json!("r2"))),
            tc("Read", json!({"file_path": "/c.rs"}), Some(json!("c"))),
        ];
        let mut messages = vec![ThreadMessageLike {
            role: MessageRole::Assistant,
            id: Some("m1".to_string()),
            created_at: None,
            content: vec![
                text("Let me investigate..."),
                tc_with_children(
                    "Agent",
                    json!({"description": "explore"}),
                    Some(json!("done")),
                    children,
                ),
                text("Found the issue."),
            ],
            status: None,
            streaming: None,
        }];
        collapse_pass(&mut messages);
        assert_eq!(messages[0].content.len(), 3); // text + Agent + text
        let kids = unwrap_children(&messages[0].content[1]);
        // 3 tools → collapsed group (Grep+Grep+Read ≥ 2 consecutive collapsible)
        assert_eq!(kids.len(), 1);
        assert!(matches!(kids[0], ExtendedMessagePart::CollapsedGroup(_)));
    }
}
