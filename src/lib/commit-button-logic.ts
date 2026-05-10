import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/features/commit/button";
import type {
	ChangeRequestInfo,
	ForgeActionStatus,
	WorkspaceGitActionStatus,
} from "./api";

/**
 * The shape of the commit button lifecycle tracked by App.tsx.
 */
type CommitLifecycleBase = {
	workspaceId: string;
	trackedSessionId: string | null;
	mode: WorkspaceCommitButtonMode;
	phase: "creating" | "streaming" | "verifying" | "done" | "error";
};

type CommitLifecycleRecord = CommitLifecycleBase & {
	changeRequest: ChangeRequestInfo | null;
};

export type CommitLifecycle = CommitLifecycleRecord | null;

function lifecycleChangeRequest(
	lifecycle: CommitLifecycleRecord,
): ChangeRequestInfo | null {
	return lifecycle.changeRequest;
}

/**
 * Derive the commit button's visible mode from the lifecycle + change request +
 * action statuses.
 *
 * During an active lifecycle the mode follows the lifecycle. At rest the
 * mode is derived from the persistent queries so the button reflects the
 * real GitHub / local-git state across page reloads.
 *
 * Priority order when the change request is OPEN (highest wins):
 *   1. resolve-conflicts  — conflicts block everything
 *   2. commit-and-push    — local dirty changes need committing first
 *   3. push               — committed local work is ahead of origin
 *   4. fix                — CI needs fixing before merge
 *   5. merge              — ready to merge, or waiting for CI to finish
 */
export function deriveCommitButtonMode(
	lifecycle: CommitLifecycle,
	changeRequest: ChangeRequestInfo | null,
	forgeActionStatus?: ForgeActionStatus | null,
	gitActionStatus?: WorkspaceGitActionStatus | null,
): WorkspaceCommitButtonMode {
	// ── Active lifecycle takes priority ──────────────────────────────
	if (lifecycle) {
		const lifecycleRequest = lifecycleChangeRequest(lifecycle);
		if (lifecycle.phase === "done" && lifecycleRequest) {
			return lifecycleRequest.isMerged ? "merged" : "merge";
		}
		return lifecycle.mode;
	}

	// ── Resting state — derive from persistent queries ──────────────
	if (changeRequest) {
		if (changeRequest.isMerged) return "merged";

		if (changeRequest.state === "OPEN") {
			// 1. Conflicts block everything
			const hasConflict =
				forgeActionStatus?.mergeable === "CONFLICTING" ||
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
			const hasFailingCheck = forgeActionStatus?.checks?.some(
				(c) => c.status === "failure",
			);
			if (hasFailingCheck) return "fix";

			// 5. Ready to merge, unless state derivation disables this while
			//    GitHub checks are still pending/running.
			return "merge";
		}

		// Closed change request (not merged) → offer to reopen
		if (changeRequest.state === "CLOSED") return "open-pr";
	}

	return "create-pr";
}

/**
 * Derive the commit button's visible state from the lifecycle + action
 * status + visible mode. Returns `"disabled"` only while the user is about
 * to click "Merge" but the provider hasn't finished computing mergeability
 * yet — `mode` already encodes "what action is the button offering"; tying
 * the disabled gate to it avoids accidentally greying out the Fix CI /
 * Push / Commit-and-push buttons (which don't depend on mergeable) and
 * stops `merged`/`closed` ghost-mode buttons from inheriting a stale
 * UNKNOWN that polling no longer refreshes.
 */
export function deriveCommitButtonState(
	lifecycle: CommitLifecycle,
	forgeActionStatus?: ForgeActionStatus | null,
	mode?: WorkspaceCommitButtonMode,
): CommitButtonState {
	if (!lifecycle) {
		if (mode === "merge") {
			if (!forgeActionStatus) {
				return "disabled";
			}
			const hasActiveCheck = forgeActionStatus?.checks?.some(
				(c) => c.status === "pending" || c.status === "running",
			);
			if (forgeActionStatus?.mergeable === "UNKNOWN" || hasActiveCheck) {
				return "disabled";
			}
		}
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
