import type { WorkspaceCommitButtonMode } from "@/features/commit/button";

type ActionSessionMode = Exclude<
	WorkspaceCommitButtonMode,
	"push" | "merge" | "closed" | "merged"
>;

/**
 * Prompt templates for commit-button modes that still execute through an
 * action session.
 *
 * These aren't terse starter messages — each one is a self-contained
 * instruction set the agent can execute without further clarification. We
 * dispatch them as the user message so they appear in the transcript and
 * the post-stream verifier has something concrete to check against.
 */
export const COMMIT_BUTTON_PROMPTS: Record<ActionSessionMode, string> = {
	"create-pr": `Create a pull request for the uncommitted work in this workspace.

Do the following, in order:
1. Run \`git status\` and \`git diff\` to survey what's changed.
2. Stage everything that should ship with \`git add\`.
3. Commit with a concise, Conventional-Commits-style message (\`feat:\`, \`fix:\`, \`refactor:\`, \`chore:\`, etc.) that summarizes the change in one line.
4. Push the current branch to \`origin\` with \`git push -u origin HEAD\` (create the remote tracking branch if it doesn't exist).
5. Open a pull request against the repository's default branch using \`gh pr create\`. Use a clear PR title and a body that explains: what changed, why it changed, and any follow-up / test notes.
6. Report the PR URL in your final message so I can click it.

Don't stop to ask for confirmation — execute each step automatically. If you hit an unrecoverable error (e.g. merge conflict, pre-push hook failure), report it clearly so I can intervene.`,

	"commit-and-push": `Commit and push all uncommitted work in this workspace.

Do the following, in order:
1. Run \`git status\` and \`git diff\` to survey what's changed.
2. Stage everything that should ship with \`git add\`.
3. Commit with a concise, Conventional-Commits-style message (\`feat:\`, \`fix:\`, \`refactor:\`, etc.) summarizing the change.
4. Push the current branch to \`origin\` with \`git push\`.
5. Report the resulting commit SHA and pushed ref.

Don't stop to ask for confirmation — execute each step automatically. If a pre-commit / pre-push hook fails, report the failure and stop without force-pushing.`,

	fix: `CI is failing on the current branch. Diagnose and fix it.

Do the following, in order:
1. Use \`gh run list\` / \`gh run view\` to inspect the most recent failing run for this branch. Read the logs for each failing job.
2. Identify the root cause — don't just paper over the symptom. Explain your diagnosis briefly before making changes.
3. Apply the minimum set of changes needed to get CI green. Run the relevant tests / linters locally to confirm.
4. Commit the fix with a clear \`fix(ci): …\` message and push to the same branch so CI re-runs.
5. Report what was broken, what you changed, and whether the re-run is passing.`,

	"resolve-conflicts": `This branch has merge conflicts with its target branch. Resolve them.

Do the following, in order:
1. Identify the target branch (usually \`main\` or \`master\` — check the repo's default branch).
2. Fetch the latest from \`origin\` and rebase or merge the target into the current branch.
3. Resolve each conflict, preserving intent from both sides where possible. Explain your resolution choices briefly in the session.
4. Run the relevant tests locally to confirm nothing broke.
5. Commit the resolution and push.
6. Report the conflicted files and how you resolved them.

If a conflict is too ambiguous to resolve automatically, stop and ask.`,

	"open-pr": `Reopen the closed pull request for this branch and leave a short comment explaining why it's being reopened.

Use \`gh pr reopen\` + \`gh pr comment\`. Report the PR URL when done.`,
};

/**
 * Human-readable name for an action kind. Used in tooltips, toasts, and
 * session badges. Accepts any string (not just {@link WorkspaceCommitButtonMode})
 * so callers can pass the raw value pulled from `session.actionKind` without
 * narrowing.
 */
export function describeActionKind(actionKind: string): string {
	switch (actionKind) {
		case "create-pr":
			return "Create PR";
		case "commit-and-push":
			return "Commit and Push";
		case "fix":
			return "Fix CI";
		case "push":
			return "Push";
		case "resolve-conflicts":
			return "Resolve Conflicts";
		case "merge":
			return "Merge";
		case "open-pr":
			return "Open PR";
		case "merged":
			return "Merged";
		case "closed":
			return "Closed";
		default:
			return actionKind;
	}
}
