use anyhow::{Context, Result};

use crate::models::repos::RepoPreferences;

use super::WorkspaceShipActionKind;

#[derive(Debug)]
pub(super) struct PromptContext<'a> {
    pub(super) repo_preferences: &'a RepoPreferences,
    pub(super) target_branch: Option<&'a str>,
    pub(super) remote: Option<&'a str>,
    pub(super) forge_provider: Option<&'a str>,
}

pub(super) fn build_agent_action_prompt(
    action: WorkspaceShipActionKind,
    context: PromptContext<'_>,
) -> Result<String> {
    match action {
        WorkspaceShipActionKind::CommitAndPush => {
            Ok(commit_and_push_prompt(context.remote).trim().to_string())
        }
        WorkspaceShipActionKind::CreatePr => Ok(append_user_preferences(
            &create_pr_prompt(
                forge_prompt_dialect(context.forge_provider),
                require_target_branch("createPr", context.target_branch)?,
                context.remote,
            ),
            context.repo_preferences.create_pr.as_deref(),
        )),
        WorkspaceShipActionKind::FixErrors => Ok(append_user_preferences(
            &fix_errors_prompt(forge_prompt_dialect(context.forge_provider)),
            context.repo_preferences.fix_errors.as_deref(),
        )),
        WorkspaceShipActionKind::ResolveConflicts => Ok(append_user_preferences(
            &resolve_conflicts_prompt(
                require_target_branch("resolveConflicts", context.target_branch)?,
                context.remote,
            ),
            context.repo_preferences.resolve_conflicts.as_deref(),
        )),
        WorkspaceShipActionKind::MergePr | WorkspaceShipActionKind::PullLatest => {
            anyhow::bail!(
                "workspace ship action `{}` does not dispatch an agent prompt",
                action.cli_label()
            )
        }
    }
}

fn commit_and_push_prompt(remote: Option<&str>) -> String {
    let remote_name = normalize_remote(remote);
    format!(
        r#"Commit and push all uncommitted work in this workspace.

Do the following, in order:
1. Run `git status` and `git diff` to survey what's changed.
2. Stage everything that should ship with `git add`.
3. Commit with a concise, Conventional-Commits-style message (`feat:`, `fix:`, `refactor:`, etc.) summarizing the change.
4. Push the current branch to `{remote_name}`. If needed, create the remote tracking branch with `git push -u {remote_name} HEAD`.
5. Report the resulting commit SHA and pushed ref.

Don't stop to ask for confirmation — execute each step automatically. If a pre-commit / pre-push hook fails, report the failure and stop without force-pushing."#
    )
}

fn create_pr_prompt(
    dialect: ForgePromptDialect,
    target_branch: &str,
    remote: Option<&str>,
) -> String {
    let remote_name = normalize_remote(remote);
    let create_command = dialect.create_command(target_branch);
    format!(
        r#"Create a {} for the uncommitted work in this workspace.

Do the following, in order:
1. Run `git status` and `git diff` to survey what's changed.
2. Stage everything that should ship with `git add`.
3. Commit with a concise, Conventional-Commits-style message (`feat:`, `fix:`, `refactor:`, `chore:`, etc.) that summarizes the change in one line.
4. Push the current branch to `{remote_name}`. If needed, create the remote tracking branch with `git push -u {remote_name} HEAD`.
5. Open a {} against `{target_branch}` using `{create_command}`. Use a clear {} title and a body that explains: what changed, why it changed, and any follow-up / test notes.
6. Report the {} URL in your final message so I can click it.

Don't stop to ask for confirmation — execute each step automatically. If you hit an unrecoverable error (e.g. merge conflict, pre-push hook failure), report it clearly so I can intervene."#,
        dialect.change_request_full_name,
        dialect.change_request_full_name,
        dialect.change_request_name,
        dialect.change_request_name,
    )
}

fn fix_errors_prompt(dialect: ForgePromptDialect) -> String {
    format!(
        r#"{} is failing on the current branch. Diagnose and fix it.

Do the following, in order:
1. Use `{}` / `{}` to inspect the most recent failing {} for this branch. Read the logs for each failing job.
2. Identify the root cause — don't just paper over the symptom. Explain your diagnosis briefly before making changes.
3. Apply the minimum set of changes needed to get CI green. Run the relevant tests / linters locally to confirm.
4. Commit the fix with a clear `fix(ci): …` message and push to the same branch so CI re-runs.
5. Report what was broken, what you changed, and whether the re-run is passing."#,
        dialect.ci_system_name,
        dialect.ci_list_command,
        dialect.ci_view_command,
        dialect.ci_job_noun,
    )
}

fn resolve_conflicts_prompt(target_branch: &str, remote: Option<&str>) -> String {
    let remote_name = normalize_remote(remote);
    format!(
        r#"This branch has merge conflicts with `{target_branch}`, this workspace's target branch. Resolve them.

Do the following, in order:
1. Fetch the latest `{target_branch}` from `{remote_name}`.
2. Rebase or merge `{target_branch}` into the current branch.
3. Resolve each conflict, preserving intent from both sides where possible. Explain your resolution choices briefly in the session.
4. Run the relevant tests locally to confirm nothing broke.
5. Commit the resolution and push to `{remote_name}`.
6. Report the conflicted files and how you resolved them.

If a conflict is too ambiguous to resolve automatically, stop and ask."#
    )
}

fn append_user_preferences(base_prompt: &str, preference: Option<&str>) -> String {
    let trimmed_base = base_prompt.trim();
    let Some(trimmed_preference) = preference.map(str::trim).filter(|value| !value.is_empty())
    else {
        return trimmed_base.to_string();
    };
    format!(
        "{trimmed_base}\n\n{CUSTOM_PREFERENCES_INTRO}\n\n### User Preferences\n\n{trimmed_preference}"
    )
}

fn require_target_branch<'a>(key: &str, target_branch: Option<&'a str>) -> Result<&'a str> {
    target_branch
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .with_context(|| format!("Missing workspace target branch for {key} prompt."))
}

fn normalize_remote(remote: Option<&str>) -> String {
    remote
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("origin")
        .to_string()
}

#[derive(Debug, Clone, Copy)]
struct ForgePromptDialect {
    change_request_name: &'static str,
    change_request_full_name: &'static str,
    ci_list_command: &'static str,
    ci_view_command: &'static str,
    ci_system_name: &'static str,
    ci_job_noun: &'static str,
}

impl ForgePromptDialect {
    fn create_command(self, target_branch: &str) -> String {
        if self.change_request_name == "MR" {
            format!("glab mr create --target-branch {target_branch}")
        } else {
            format!("gh pr create --base {target_branch}")
        }
    }
}

fn forge_prompt_dialect(provider: Option<&str>) -> ForgePromptDialect {
    if matches!(provider, Some("gitlab")) {
        return ForgePromptDialect {
            change_request_name: "MR",
            change_request_full_name: "merge request",
            ci_list_command: "glab ci list",
            ci_view_command: "glab ci view",
            ci_system_name: "GitLab CI",
            ci_job_noun: "pipeline",
        };
    }
    ForgePromptDialect {
        change_request_name: "PR",
        change_request_full_name: "pull request",
        ci_list_command: "gh run list",
        ci_view_command: "gh run view",
        ci_system_name: "CI",
        ci_job_noun: "run",
    }
}

const CUSTOM_PREFERENCES_INTRO: &str = "IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.";
