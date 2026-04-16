import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type {
	PullRequestInfo,
	WorkspaceGitActionStatus,
	WorkspacePrActionStatus,
} from "./api";

/**
 * The shape of the commit button lifecycle tracked by App.tsx.
 */
export type CommitLifecycle = {
	workspaceId: string;
	trackedSessionId: string | null;
	mode: WorkspaceCommitButtonMode;
	phase: "creating" | "streaming" | "verifying" | "done" | "error";
	prInfo: PullRequestInfo | null;
} | null;

/**
 * Derive the commit button's visible mode from the lifecycle + PR query +
 * action statuses.
 *
 * During an active lifecycle the mode follows the lifecycle. At rest the
 * mode is derived from the persistent queries so the button reflects the
 * real GitHub / local-git state across page reloads.
 *
 * Priority order when PR is OPEN (highest wins):
 *   1. resolve-conflicts  — conflicts block everything
 *   2. commit-and-push    — local dirty changes need committing first
 *   3. push               — committed local work is ahead of origin
 *   4. fix                — CI needs fixing before merge
 *   5. merge              — ready to merge
 */
export function deriveCommitButtonMode(
	lifecycle: CommitLifecycle,
	prInfo: PullRequestInfo | null,
	prActionStatus?: WorkspacePrActionStatus | null,
	gitActionStatus?: WorkspaceGitActionStatus | null,
): WorkspaceCommitButtonMode {
	// ── Active lifecycle takes priority ──────────────────────────────
	if (lifecycle) {
		if (lifecycle.phase === "done" && lifecycle.prInfo) {
			return lifecycle.prInfo.isMerged ? "merged" : "merge";
		}
		return lifecycle.mode;
	}

	// ── Resting state — derive from persistent queries ──────────────
	if (prInfo) {
		if (prInfo.isMerged) return "merged";

		if (prInfo.state === "OPEN") {
			// 1. Conflicts block everything
			const hasConflict =
				prActionStatus?.mergeable === "CONFLICTING" ||
				(gitActionStatus?.conflictCount ?? 0) > 0;
			if (hasConflict) return "resolve-conflicts";

			// 2. Local uncommitted changes need pushing first
			if ((gitActionStatus?.uncommittedCount ?? 0) > 0) {
				return "commit-and-push";
			}

			// 3. Local commits ahead of origin need pushing before CI / merge
			if (
				gitActionStatus?.pushStatus === "unpublished" ||
				(gitActionStatus?.aheadOfRemoteCount ?? 0) > 0
			) {
				return "push";
			}

			// 4. Any failing CI check → show Fix CI
			const hasFailingCheck = prActionStatus?.checks?.some(
				(c) => c.status === "failure",
			);
			if (hasFailingCheck) return "fix";

			// 5. Ready to merge
			return "merge";
		}

		// PR closed (not merged) → offer to reopen
		if (prInfo.state === "CLOSED") return "open-pr";
	}

	return "create-pr";
}

/**
 * Derive the commit button's visible state from the lifecycle + action
 * status. Returns `"disabled"` while GitHub is still computing the
 * mergeable status so the user can't click Merge prematurely.
 */
export function deriveCommitButtonState(
	lifecycle: CommitLifecycle,
	prActionStatus?: WorkspacePrActionStatus | null,
): CommitButtonState {
	if (!lifecycle) {
		// GitHub is still computing mergeable — disable the button
		if (prActionStatus?.mergeable === "UNKNOWN") return "disabled";
		return "idle";
	}
	switch (lifecycle.phase) {
		case "creating":
		case "streaming":
		case "verifying":
			return "busy";
		case "done":
			return "done";
		case "error":
			return "error";
	}
}

/**
 * Derive what workspace manual_status should be based on PR state.
 * Returns null if no status change is needed.
 */
export function deriveWorkspaceStatusFromPr(
	prInfo: PullRequestInfo | null,
): string | null {
	if (!prInfo) return null;
	if (prInfo.isMerged) return "done";
	if (prInfo.state === "OPEN") return "review";
	if (prInfo.state === "CLOSED") return "canceled";
	return null;
}
