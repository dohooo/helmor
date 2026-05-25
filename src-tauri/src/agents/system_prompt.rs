//! Helmor-aware system prompt prepended to every user turn.
//!
//! ## What the agent sees
//!
//! Every send to Claude Code / Codex (and any future SDK we route
//! through `streaming::stream_via_sidecar`) gets a small "you are
//! inside Helmor" preamble stitched onto the front of the user's
//! prompt. The preamble:
//!
//! - Names the kanban card the agent is running on (so an agent
//!   spawned into a second workspace knows which one it is).
//! - Tells the agent where its working directory + target branch are,
//!   plus any `/add-dir`-linked directories.
//! - Points at the `.agent-contexts/` scratch dir as the canonical
//!   place to leave files for other sessions.
//! - Names the `helmor-cli` skill installed in the agent's skills
//!   directory — the agent will lazy-load the skill on demand when it
//!   needs to operate Helmor itself (spawn workspaces, dispatch ship
//!   actions, read other agents' transcripts). We deliberately do NOT
//!   inline the command reference here — the skill's `SKILL.md` is the
//!   single source of truth.
//! - Mentions the feedback button so the agent can correctly redirect
//!   "how do I report a bug?"-style asks.
//!
//! ## Why the user doesn't see this
//!
//! `streaming::stream_via_sidecar` already supports a hidden preamble
//! (`AgentSendRequest::prompt_prefix`). The wire payload to the SDK
//! sees the combined string; the chat bubble + DB row persist only the
//! user's typed text. Helmor's system prompt is appended in front of
//! whatever caller-supplied prefix already exists, so e.g. the
//! repo-preferences preamble from `use-streaming.ts` remains visible
//! to the agent as task-level guidance after Helmor's container-level
//! framing.
//!
//! ## Why we re-inject every turn
//!
//! SDK conversation history persists across turns, but only the
//! agent's internal context window — not Helmor's contract with the
//! agent. Re-injecting per turn is cheap (~600 chars / ~150 tokens),
//! immune to context-window truncation, and keeps the helmor-cli
//! skill cue visible at turn N when the user finally asks for
//! orchestration.

use std::fmt::Write;

/// Context the prompt template consumes. Construct once per send.
#[derive(Debug, Clone)]
pub struct HelmorSystemPromptContext {
    /// Human-friendly label for the current kanban card. Format
    /// `<repo>/<workspace-directory>` so the agent's self-locating
    /// statement matches what the user sees in the sidebar.
    pub workspace_label: String,
    /// Absolute on-disk path of the workspace worktree.
    pub workspace_root_path: String,
    /// Resolved target branch, e.g. `origin/main`. Used by the agent
    /// for `git diff` baselines and PR creation. `None` means we
    /// couldn't determine it — the prompt downgrades the surrounding
    /// hint into a "configure a target branch in the workspace
    /// settings" suggestion.
    pub target_branch: Option<String>,
    /// Plain branch name (no remote prefix) — what `gh pr create
    /// --base` wants.
    pub base_branch: Option<String>,
    /// Extra directories the user added via `/add-dir`. Empty list
    /// elides the entire linked-directories paragraph.
    pub linked_directories: Vec<String>,
    /// Name of the on-PATH CLI binary the agent should invoke. In
    /// release builds this is `helmor`; in dev builds it's
    /// `helmor-dev` (so a development install never shadows a
    /// release install on the same machine). The `helmor-cli`
    /// SKILL.md documents commands using the release name `helmor`,
    /// so we explicitly thread the resolved name through here to
    /// keep the agent from invoking a binary that doesn't exist on
    /// PATH for the build it's running in.
    pub cli_command_name: String,
}

/// Render the preamble. Deterministic, no I/O, side-effect-free —
/// safe to call from any context. The result already trims trailing
/// whitespace so the consumer can `format!("{prefix}\n\n{rest}")`
/// without doubling up newlines.
pub fn build_helmor_system_prompt(ctx: &HelmorSystemPromptContext) -> String {
    let mut out = String::with_capacity(640);

    out.push_str("<helmor_context>\n");
    out.push_str("You are running inside Helmor, a Mac app that lets the user run many coding agents in parallel.\n");
    let _ = writeln!(
        out,
        "You are working on the kanban card `{}`. The user is watching this conversation live in Helmor's GUI.",
        ctx.workspace_label,
    );
    let _ = writeln!(
        out,
        "Your working directory is `{}` (unless redirected). Stay inside it for file edits and shell commands unless the user opens a linked directory.",
        ctx.workspace_root_path,
    );

    match (ctx.target_branch.as_deref(), ctx.base_branch.as_deref()) {
        (Some(target), Some(base)) => {
            let _ = writeln!(
                out,
                "Target branch for this workspace: `{target}`. Use it for diffs (`git diff {target}...`) and PRs (`gh pr create --base {base}`).",
            );
        }
        _ => {
            out.push_str(
                "Target branch for this workspace is not configured — ask the user before opening a PR.\n",
            );
        }
    }

    if !ctx.linked_directories.is_empty() {
        out.push_str(
            "You also have read/write access to the following linked directories (added via `/add-dir`):\n",
        );
        for dir in &ctx.linked_directories {
            let _ = writeln!(out, "  - {dir}");
        }
        out.push_str(
            "Treat them as part of your working context — file references and shell commands should resolve there the same way they do inside the workspace.\n",
        );
    }

    out.push_str(
        "\nIf you need a scratch directory to leave files for other agents in this workspace (or for your own future sessions), use `<workspace_root>/.agent-contexts/`. It is gitignored at the worktree level, so anything you write there stays out of every diff.\n",
    );

    let _ = write!(
        out,
        "\nHelmor itself is scriptable. If the user has a clear intent that requires multiple workspaces, or asks you to operate Helmor (spawn workspaces, change kanban status, dispatch a ship action, read what another agent is doing, etc.), consult the `helmor-cli` skill installed in your skills directory — it documents the full command surface. Don't fabricate commands; let the skill be the source of truth. Invoke the CLI as `{}` on this build (the skill's SKILL.md shows `helmor` for release builds — substitute accordingly).\n",
        ctx.cli_command_name,
    );

    out.push_str(
        "\nIf the user asks for help with Helmor itself, point them at the feedback button at the bottom of Helmor's sidebar.\n",
    );

    out.push_str("</helmor_context>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with_defaults() -> HelmorSystemPromptContext {
        HelmorSystemPromptContext {
            workspace_label: "dohooo/feature-x".to_string(),
            workspace_root_path: "/Users/me/helmor/workspaces/dohooo/feature-x".to_string(),
            target_branch: Some("origin/main".to_string()),
            base_branch: Some("main".to_string()),
            linked_directories: Vec::new(),
            cli_command_name: "helmor".to_string(),
        }
    }

    /// Sanity: every kanban-aware field reaches the rendered prompt so
    /// the agent can self-locate.
    #[test]
    fn renders_workspace_label_and_root_path() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.contains("`dohooo/feature-x`"));
        assert!(prompt.contains("`/Users/me/helmor/workspaces/dohooo/feature-x`"));
    }

    /// Resolved target + base branch → the diff/PR commands are
    /// pre-substituted with the real branch names. This is the load-
    /// bearing line the agent uses to decide where to base PRs.
    #[test]
    fn target_branch_block_includes_diff_and_pr_commands() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.contains("`origin/main`"));
        assert!(prompt.contains("git diff origin/main..."));
        assert!(prompt.contains("gh pr create --base main"));
    }

    /// Missing target branch → the prompt switches to a "ask the user"
    /// fallback instead of generating broken commands. Pins the
    /// degraded behaviour so a future "always assume origin/main"
    /// regression shows up here.
    #[test]
    fn target_branch_unresolved_downgrades_to_ask_user_hint() {
        let mut ctx = ctx_with_defaults();
        ctx.target_branch = None;
        ctx.base_branch = None;
        let prompt = build_helmor_system_prompt(&ctx);
        assert!(prompt.contains("not configured"));
        assert!(!prompt.contains("git diff"));
        assert!(!prompt.contains("gh pr create"));
    }

    /// Empty linked-directories list → the whole paragraph is elided.
    /// Without this guarantee the agent would see a dangling
    /// "you also have access to:" sentence with no bullets.
    #[test]
    fn linked_directories_paragraph_is_elided_when_list_empty() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(!prompt.contains("linked directories"));
    }

    /// Non-empty list → the paragraph appears with each entry on its
    /// own bullet, and the trailing explanation sentence is present
    /// so the agent knows to treat them as in-scope.
    #[test]
    fn linked_directories_paragraph_renders_each_entry() {
        let mut ctx = ctx_with_defaults();
        ctx.linked_directories = vec!["/Users/me/lib-a".to_string(), "/Users/me/lib-b".to_string()];
        let prompt = build_helmor_system_prompt(&ctx);
        assert!(prompt.contains("linked directories"));
        assert!(prompt.contains("- /Users/me/lib-a"));
        assert!(prompt.contains("- /Users/me/lib-b"));
        assert!(prompt.contains("Treat them as part of your working context"));
    }

    /// The agent-contexts scratch-dir paragraph is always present —
    /// it's a feature contract, not a conditional. Pin so a future
    /// refactor that moves it behind a flag breaks loudly here.
    #[test]
    fn agent_contexts_scratch_paragraph_is_always_present() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.contains(".agent-contexts/"));
        assert!(prompt.contains("gitignored"));
    }

    /// The helmor-cli skill must be named (so Claude Code's skill
    /// auto-loader picks it up) and the prompt must defer to the
    /// skill rather than inline commands. This is the load-bearing
    /// invariant for the orchestration vision.
    #[test]
    fn helmor_cli_skill_is_named_and_not_inlined() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.contains("`helmor-cli` skill"));
        // Don't accidentally turn the prompt into a CLI cheat-sheet —
        // the skill's SKILL.md owns the canonical reference.
        assert!(
            !prompt.contains("helmor-cli workspace new"),
            "command listing should live in SKILL.md, not in the prompt prefix"
        );
    }

    /// Dev builds install the CLI as `helmor-dev` so a development
    /// copy doesn't shadow a release install on the same machine. The
    /// `helmor-cli` SKILL.md documents commands using the release
    /// name `helmor`, so the prompt MUST name the actual binary the
    /// agent should invoke — otherwise dev users get "command not
    /// found" the moment the agent tries to use the skill.
    #[test]
    fn cli_command_name_is_threaded_through_for_dev_builds() {
        let mut ctx = ctx_with_defaults();
        ctx.cli_command_name = "helmor-dev".to_string();
        let prompt = build_helmor_system_prompt(&ctx);
        assert!(
            prompt.contains("`helmor-dev`"),
            "dev builds must surface the `helmor-dev` binary name"
        );
        // Make sure the SKILL-vs-build disambiguation hint is also
        // present so a confused agent reading the skill docs knows
        // why they need to substitute.
        assert!(
            prompt.contains("SKILL.md"),
            "should explain the SKILL.md vs build-name mismatch"
        );
    }

    /// Release builds use the canonical `helmor` name — same as the
    /// SKILL.md docs, no substitution needed. Pin so a future refactor
    /// that always hardcodes `helmor-dev` regardless of build doesn't
    /// silently misadvise release agents.
    #[test]
    fn cli_command_name_uses_release_binary_in_release_builds() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.contains("Invoke the CLI as `helmor`"));
    }

    /// Feedback line points at the sidebar button — matches the real
    /// UI location (`shell-sidebar-pane.tsx:155`). Pin so a copy
    /// drift here doesn't send users hunting in a menu that doesn't
    /// exist.
    #[test]
    fn feedback_pointer_points_at_sidebar_button() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.contains("feedback button"));
        assert!(prompt.contains("sidebar"));
    }

    /// The whole thing is wrapped in a single `<helmor_context>` tag
    /// so the SDK / log viewer can spot Helmor's preamble at a glance.
    /// Keeping it as one block (not split between system + user) means
    /// the agent treats it as additional context, not an authoritative
    /// instruction, which is what we want.
    #[test]
    fn output_is_wrapped_in_helmor_context_tag() {
        let prompt = build_helmor_system_prompt(&ctx_with_defaults());
        assert!(prompt.starts_with("<helmor_context>"));
        assert!(prompt.ends_with("</helmor_context>"));
    }
}
