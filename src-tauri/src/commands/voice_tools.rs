//! Tool declarations for the voice-mode agent (`gpt-realtime-2`).
//!
//! Each tool maps to a `helmor` CLI subcommand. The function-name +
//! parameter JSON Schema is hand-written here (the model needs typed
//! argument names, and clap doesn't project flag names cleanly onto JSON
//! field names). The *description* — what the tool does, what its flags
//! mean — is pulled from the CLI's own clap help text via
//! [`subcommand_help`], so the spoken-side description and the
//! `helmor <cmd> --help` output never drift apart. Edit the help in
//! `src-tauri/src/cli/args.rs` and both surfaces update.
//!
//! Each description is structured the same way: a short voice-context
//! "USE WHEN…" wrapper that tells the model when to fire the tool and
//! roughly what to say while waiting (preamble samples), followed by
//! the raw CLI usage block so the model sees flag semantics in the
//! exact words the human reads.

use clap::CommandFactory;
use serde_json::{json, Value};

use crate::cli::Cli;

/// Render the long-form help of a nested subcommand path. `path` is the
/// argv tail you would type after `helmor`: e.g. `["workspace","list"]`
/// or `["workspace","set-status","set"]`.
///
/// Returns the help body as plain text (clap's `StyledStr::to_string()`
/// strips ANSI). On a lookup miss we return a stub so a typo in `path`
/// fails loudly at runtime rather than silently shipping an empty
/// description.
fn subcommand_help(path: &[&str]) -> String {
    let mut cmd = Cli::command();
    let mut walked: Vec<&str> = Vec::with_capacity(path.len());
    for segment in path {
        walked.push(segment);
        let next = cmd.find_subcommand(segment).cloned();
        cmd = match next {
            Some(sub) => sub,
            None => {
                return format!(
                    "[voice-tools: subcommand path `{}` not found while resolving `{}`]",
                    walked.join(" "),
                    path.join(" ")
                );
            }
        };
    }
    cmd.render_long_help().to_string()
}

/// Format a tool description: a one-line spoken-context preamble plus
/// the raw clap `--help` output, separated by a divider the model can
/// visually parse. Indented Markdown headers would be nicer but the
/// fenced-divider form mirrors how OpenAI's own cookbook structures
/// agent tool descriptions.
fn describe(use_when: &str, cli_path: &[&str]) -> String {
    format!(
        "{use_when}\n\n--- helmor {cmd} --help ---\n{help}",
        cmd = cli_path.join(" "),
        help = subcommand_help(cli_path).trim_end()
    )
}

/// Build the full `tools` array for the OpenAI Realtime session.update
/// payload. Pulled out of `settings_commands.rs` so we can call clap's
/// `render_long_help` at runtime without leaving giant string literals
/// inline in a `serde_json::json!` macro.
pub fn build_tools_array() -> Vec<Value> {
    vec![
        json!({
            "type": "function",
            "name": "list_workspaces",
            "description": describe(
                "USE WHEN: user asks 'show/list/what workspaces do I have'. \
                 Preamble samples (only if a noticeable delay seems likely): \
                 'let me check.' / 'one sec.' / 'hmm, looking now.'",
                &["workspace", "list"],
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["done", "review", "progress", "backlog", "canceled"],
                        "description": "Optional filter by workspace status."
                    },
                    "repo": {
                        "type": "string",
                        "description": "Optional filter by repo name or UUID."
                    },
                    "archived": {
                        "type": "boolean",
                        "description": "Include archived workspaces. Default false."
                    }
                },
                "required": []
            }
        }),
        json!({
            "type": "function",
            "name": "show_workspace",
            "description": describe(
                "USE WHEN: user asks 'what's the status of X', 'show me X', 'how's X doing'. \
                 Preamble samples (only if it might be slow): 'let me look.' / 'one sec.' / 'checking.'",
                &["workspace", "show"],
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Workspace UUID or `repo-name/dir-name` shorthand."
                    }
                },
                "required": ["ref"]
            }
        }),
        json!({
            "type": "function",
            "name": "create_workspace",
            "description": describe(
                "USE WHEN: user says 'create/new/start a workspace for repo X'. \
                 Call immediately — no confirmation needed (creation is reversible via delete). \
                 If the repo name is unclear, run list_repos first to find the right one. \
                 After success, report the repo name, not the new ID. \
                 Preamble samples (creation can take a moment, a short preamble is fine): \
                 'ok, on it.' / 'sure, doing that now.' / 'one sec.'",
                &["workspace", "new"],
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "repo": {
                        "type": "string",
                        "description": "Repo name or UUID. Must already be registered; check list_repos first if unsure."
                    }
                },
                "required": ["repo"]
            }
        }),
        json!({
            "type": "function",
            "name": "set_workspace_status",
            "description": describe(
                "Mark a workspace done / review / progress / backlog / canceled. \
                 USE WHEN: user says 'mark X done', 'move X to review', etc. \
                 **CONFIRM ONLY when status='canceled' (destructive — cannot be undone without recreating).** \
                 For all other status changes, call immediately without confirmation. \
                 Status changes return fast — usually no preamble needed; just call and report briefly \
                 ('done.' / 'moved to review.').",
                &["workspace", "set-status", "set"],
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Workspace UUID or `repo/dir`."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["done", "review", "progress", "backlog", "canceled"]
                    }
                },
                "required": ["ref", "status"]
            }
        }),
        json!({
            "type": "function",
            "name": "list_sessions",
            "description": describe(
                "USE WHEN: user asks 'show sessions in X', 'what have we worked on in X'. \
                 Preamble samples (only if slow): 'let me check.' / 'one sec.'",
                &["session", "list"],
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace": {
                        "type": "string",
                        "description": "Workspace UUID or `repo/dir`."
                    }
                },
                "required": ["workspace"]
            }
        }),
        json!({
            "type": "function",
            "name": "send_prompt",
            "description": describe(
                "Send a prompt to the AI agent inside a workspace's session. \
                 USE WHEN: user says 'tell agent in X to do Y' or 'have agent fix the bug'. \
                 Call immediately — no confirmation needed. After success, report 'sent' without \
                 reading the session ID. Use show_workspace later to check status. \
                 Preamble samples (a short heads-up is appropriate): \
                 'sending.' / 'on it.' / 'ok, sending now.'",
                &["send"],
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "workspace": {
                        "type": "string",
                        "description": "Workspace UUID or `repo/dir`."
                    },
                    "session": {
                        "type": "string",
                        "description": "Optional existing session UUID to append to. Omit to start a fresh session."
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The instruction to send to the agent."
                    },
                    "plan_mode": {
                        "type": "boolean",
                        "description": "Run agent in plan mode (no edits). Default false."
                    }
                },
                "required": ["workspace", "prompt"]
            }
        }),
        json!({
            "type": "function",
            "name": "list_repos",
            "description": describe(
                "USE WHEN: user asks 'what repos do I have', or before create_workspace to find \
                 the right repo. Preamble samples (only if slow): 'let me check.' / 'one sec.'",
                &["repo", "list"],
            ),
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "type": "function",
            "name": "wait_for_user",
            "description": "Call when the latest audio is silence, background noise, hold music, \
                or a side conversation that doesn't need a response. Produces no audio output. \
                Not a CLI command — this is a synthetic 'stay silent' signal handled inside the \
                voice tool dispatcher.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guard against typos in the `cli_path` arguments above. If any
    /// subcommand rename in `cli/args.rs` desyncs from a tool wiring
    /// here, the description silently degrades to the
    /// `[voice-tools: ... not found]` stub — which the model would
    /// then ship to the user verbatim. This test catches that at build
    /// time instead.
    #[test]
    fn every_tool_resolves_a_real_subcommand() {
        for tool in build_tools_array() {
            let name = tool["name"].as_str().unwrap_or("<unnamed>").to_string();
            let description = tool["description"].as_str().unwrap_or("").to_string();
            assert!(
                !description.contains("[voice-tools:"),
                "tool `{name}` references a missing subcommand: {description}"
            );
        }
    }
}
