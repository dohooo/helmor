import type { WorkspaceCommitButtonMode } from "@/components/workspace-commit-button";

/**
 * Starter messages keyed by the {@link WorkspaceCommitButtonMode} that
 * triggers them. Sourced from Conductor's internal built-in action templates
 * so Helmor's commit button feels behaviorally equivalent.
 *
 * These are intentionally terse — Conductor relies on a generated attachment
 * (e.g. `PR instructions.md`, `Fix errors instructions.md`) computed at
 * runtime from workspace state to carry the detailed instructions. A future
 * iteration of this file will layer in the same attachment synthesis; for
 * now we dispatch the bare starter message and let the agent infer intent
 * from the current branch + diff state.
 *
 * Modes not represented in Conductor's catalog (`merge`, `open-pr`, `merged`,
 * `closed`) fall back to short placeholders so the dispatch contract stays
 * exhaustive for every button state.
 */
export const COMMIT_BUTTON_PROMPTS: Record<WorkspaceCommitButtonMode, string> =
	{
		"create-pr": "Create a PR",
		"commit-and-push": "Commit and push all changes",
		fix: "Fix the failing CI actions. I've attached the failure logs.",
		"resolve-conflicts":
			"Resolve any existing merge conflicts with the remote branch (main). Then, commit and push your changes.",
		merge:
			"Merge this pull request into its base branch and report the merge commit SHA.",
		"open-pr":
			"Reopen this closed pull request and leave a short comment explaining why.",
		merged: "This pull request has already been merged.",
		closed: "This pull request has been closed without merging.",
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
