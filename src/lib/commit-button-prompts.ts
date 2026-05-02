import type { WorkspaceCommitButtonMode } from "@/features/commit/button";
import type { ActionKind, ForgeDetection, RepoPreferences } from "@/lib/api";
import { forgePromptDialect } from "@/lib/forge-dialect";
import {
	type RepoPreferenceKey,
	resolveRepoPreferencePrompt,
} from "@/lib/repo-preferences-prompts";

type ButtonActionMode = Exclude<
	WorkspaceCommitButtonMode,
	"push" | "merge" | "closed" | "merged"
>;
type ActionSessionMode = ButtonActionMode | "review";

// Modes that delegate to a `RepoPreferenceKey`. The other action modes
// (`commit-and-push`, `open-pr`) have no user-facing preference slot — they're
// rendered inline below.
type PreferenceBackedMode =
	| "create-pr"
	| "review"
	| "fix"
	| "resolve-conflicts";

const ACTION_MODE_TO_PREFERENCE_KEY: Record<
	PreferenceBackedMode,
	RepoPreferenceKey
> = {
	"create-pr": "createPr",
	review: "review",
	fix: "fixErrors",
	"resolve-conflicts": "resolveConflicts",
};

export function buildCommitButtonPrompt(
	mode: ActionSessionMode,
	repoPreferences?: RepoPreferences | null,
	targetBranch?: string | null,
	forge?: ForgeDetection | null,
	remote?: string | null,
): string {
	const remoteName =
		remote && remote.trim().length > 0 ? remote.trim() : "origin";
	switch (mode) {
		case "commit-and-push":
			// Pure git — no forge involved.
			return `Commit and push all uncommitted work in this workspace.

Do the following, in order:
1. Run \`git status\` and \`git diff\` to survey what's changed.
2. Stage everything that should ship with \`git add\`.
3. Commit with a concise, Conventional-Commits-style message (\`feat:\`, \`fix:\`, \`refactor:\`, etc.) summarizing the change.
4. Push the current branch to \`${remoteName}\`. If needed, create the remote tracking branch with \`git push -u ${remoteName} HEAD\`.
5. Report the resulting commit SHA and pushed ref.

Don't stop to ask for confirmation — execute each step automatically. If a pre-commit / pre-push hook fails, report the failure and stop without force-pushing.`;

		case "open-pr": {
			const dialect = forgePromptDialect(forge);
			return `Reopen the closed ${dialect.changeRequestFullName} for this branch and leave a short comment explaining why it's being reopened.

Use \`${dialect.reopenCommand}\` + \`${dialect.commentCommand}\`. Report the ${dialect.changeRequestName} URL when done.`;
		}

		case "create-pr":
		case "review":
		case "fix":
		case "resolve-conflicts":
			return resolveRepoPreferencePrompt({
				key: ACTION_MODE_TO_PREFERENCE_KEY[mode],
				repoPreferences,
				targetBranch,
				forge,
				remote,
			});
	}
}

export function isActionSessionMode(
	mode: WorkspaceCommitButtonMode,
): mode is ButtonActionMode {
	return (
		mode === "create-pr" ||
		mode === "commit-and-push" ||
		mode === "fix" ||
		mode === "resolve-conflicts" ||
		mode === "open-pr"
	);
}

/** Whether a session created with this `ActionKind` is eligible for the
 *  auto-hide flow (i.e. can be silently hidden once its post-stream verifier
 *  passes). Auto-created action sessions still get fixed titles, but only a
 *  subset are *also* auto-hideable.
 *
 *  Review is intentionally excluded: its whole reason to exist is to surface
 *  a code-review *for the user to read*, so the session must stay visible.
 *  The user's opt-in list (`loadAutoCloseActionKinds`) is filtered through
 *  this gate at every hide call site (and the composer's "Auto Close"
 *  toggle is hidden for non-hideable kinds). */
export function isAutoHideableActionKind(kind: ActionKind): boolean {
	return kind !== "review";
}

export function describeActionKind(actionKind: string): string {
	switch (actionKind) {
		case "create-pr":
			return "Create PR";
		case "review":
			return "Review";
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
