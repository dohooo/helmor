//! Title + branch-name generation via the bundled local LLM. First link
//! in the title cascade defined in `agents::queries::generate_session_title`:
//! when this succeeds we skip the sidecar (custom-claude → claude → codex
//! → cursor) entirely. Any failure — server not ready, timeout, parse
//! mismatch — bubbles up as an `Err` so the caller can fall through.
//!
//! Prompt + parser intentionally mirror `sidecar/src/title.ts` so the
//! local model returns the same shape the sidecar managers do.

use std::time::Duration;

use anyhow::Result;

use super::Manager;

const TITLE_TIMEOUT: Duration = Duration::from_secs(15);

const DEFAULT_BRANCH_RENAME_PROMPT: &str =
    "When you generate the branch name segment for a new chat:

- Base it on the user's first message.
- Return a short English slug in lowercase with hyphens.
- Omit any branch prefix such as `feat/` or usernames.
- Favor clarity over cleverness.";

const CUSTOM_PREFERENCES_INTRO: &str = "IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.";

const TITLE_SYSTEM_PROMPT: &str = "You are a concise title generator. Follow the user's output-format instructions exactly. Return only the requested lines — no preamble, no explanations, no markdown fences.";

impl Manager {
    /// Generate `(title, optional branch_name)` from the user's first
    /// message using the bundled local LLM.
    ///
    /// Returns `Err` on any failure (server not ready, chat failure,
    /// empty/malformed output), letting the caller cascade to the
    /// sidecar's cloud providers.
    pub fn generate_title(
        &self,
        user_message: &str,
        branch_rename_prompt: Option<&str>,
        generate_branch: bool,
    ) -> Result<(String, Option<String>)> {
        if !self.is_ready() {
            anyhow::bail!("Local LLM not ready");
        }

        // Long user messages (e.g. a pasted error log as the first
        // prompt) get middle-truncated to fit the active model's
        // context window. Otherwise the chat call would bounce back
        // HTTP 400 and we'd cascade to the cloud unnecessarily.
        let trimmed_user_message =
            self.fit_user_message_to_context(TITLE_SYSTEM_PROMPT, user_message);

        let user = build_title_prompt(&trimmed_user_message, branch_rename_prompt, generate_branch);
        let raw = self.chat(TITLE_SYSTEM_PROMPT, &user, TITLE_TIMEOUT)?;
        let (title, branch_name) = parse_title_response(&raw);

        if title.is_empty() {
            anyhow::bail!("Local LLM returned empty title (raw={raw:?})");
        }
        if generate_branch && branch_name.is_none() {
            anyhow::bail!("Local LLM returned empty branch name (raw={raw:?})");
        }
        Ok((title, branch_name))
    }

    /// `enabled && server running` — gates whether a title attempt is
    /// even worth trying. Re-uses `status()` so the same liveness check
    /// the UI sees drives the cascade decision.
    fn is_ready(&self) -> bool {
        let status = self.status();
        status.enabled && status.running
    }
}

fn build_branch_rename_instructions(branch_rename_prompt: Option<&str>) -> String {
    let trimmed_override = branch_rename_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match trimmed_override {
        None => DEFAULT_BRANCH_RENAME_PROMPT.to_string(),
        Some(override_text) => format!(
            "{DEFAULT_BRANCH_RENAME_PROMPT}\n\n{CUSTOM_PREFERENCES_INTRO}\n\n### User Preferences\n\n{override_text}"
        ),
    }
}

fn build_title_prompt(
    user_message: &str,
    branch_rename_prompt: Option<&str>,
    generate_branch: bool,
) -> String {
    if !generate_branch {
        return format!(
            "Based on the following user message, generate a concise session title (use the same language as the user message, max 8 words).\n\n\
             Output EXACTLY in this format (one line, nothing else):\n\
             title: <the title>\n\n\
             User message:\n{user_message}"
        );
    }
    format!(
        "Based on the following user message, generate TWO things:\n\
         1. A concise session title (use the same language as the user message, max 8 words)\n\
         2. A git branch name segment (English only, lowercase, hyphens for spaces, max 4 words, no prefix)\n\n\
         Additional branch naming instructions:\n\
         {branch_instructions}\n\n\
         Output EXACTLY in this format (two lines, nothing else):\n\
         title: <the title>\n\
         branch: <the-branch-name>\n\n\
         User message:\n{user_message}",
        branch_instructions = build_branch_rename_instructions(branch_rename_prompt),
    )
}

fn parse_title_response(raw: &str) -> (String, Option<String>) {
    let mut title = String::new();
    let mut branch = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("title:") {
            title = strip_quotes(trimmed[6..].trim()).to_string();
        } else if lower.starts_with("branch:") {
            branch = sanitize_branch(trimmed[7..].trim());
        }
    }
    // Same fallback as the sidecar's `parseTitleAndBranch`: if structured
    // parsing failed but the model returned something, use the whole raw
    // body as the title.
    if title.is_empty() {
        let r = raw.trim();
        if !r.is_empty() {
            title = strip_quotes(r).to_string();
        }
    }
    let branch_opt = if branch.is_empty() {
        None
    } else {
        Some(branch)
    };
    (title, branch_opt)
}

fn strip_quotes(s: &str) -> &str {
    s.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}'
        )
    })
    .trim()
}

fn sanitize_branch(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars() {
        let allowed = ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-';
        if allowed {
            if ch == '-' {
                if last_dash {
                    continue;
                }
                last_dash = true;
            } else {
                last_dash = false;
            }
            out.push(ch);
        }
    }
    while out.starts_with('-') {
        out.remove(0);
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_two_line_output() {
        let raw = "title: Fix the failing test\nbranch: fix-failing-test";
        let (title, branch) = parse_title_response(raw);
        assert_eq!(title, "Fix the failing test");
        assert_eq!(branch.as_deref(), Some("fix-failing-test"));
    }

    #[test]
    fn parses_title_only_when_branch_missing() {
        let raw = "title: Just a title";
        let (title, branch) = parse_title_response(raw);
        assert_eq!(title, "Just a title");
        assert!(branch.is_none());
    }

    #[test]
    fn strips_smart_quotes_around_title() {
        let raw = "title: \u{201c}Hello world\u{201d}";
        let (title, _) = parse_title_response(raw);
        assert_eq!(title, "Hello world");
    }

    #[test]
    fn sanitizes_branch_invalid_chars_and_dashes() {
        // Mirrors `sidecar/src/title.ts`'s `parseTitleAndBranch`: strips
        // anything outside `[a-z0-9-]` (uppercase / underscores / spaces
        // disappear without case-folding), then collapses runs of dashes
        // and trims leading/trailing ones.
        let raw = "title: Cleanup\nbranch: --fix_the-bug!! --";
        let (_, branch) = parse_title_response(raw);
        assert_eq!(branch.as_deref(), Some("fixthe-bug"));
    }

    #[test]
    fn falls_back_to_raw_body_when_no_title_prefix() {
        let raw = "Just a free-form title without label";
        let (title, _) = parse_title_response(raw);
        assert_eq!(title, "Just a free-form title without label");
    }

    #[test]
    fn build_prompt_omits_branch_instructions_when_not_generating_branch() {
        let prompt = build_title_prompt("fix the test", None, false);
        assert!(prompt.contains("title: <the title>"));
        assert!(!prompt.contains("branch:"));
    }

    #[test]
    fn build_prompt_includes_custom_branch_preferences() {
        let prompt = build_title_prompt("fix the test", Some("Always prefix with chore-"), true);
        assert!(prompt.contains("User Preferences"));
        assert!(prompt.contains("Always prefix with chore-"));
    }
}
