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
type CheckStatus = ForgeActionStatus["checks"][number]["status"];

function lifecycleChangeRequest(
	lifecycle: CommitLifecycleRecord,
): ChangeRequestInfo | null {
	return lifecycle.changeRequest;
}

function hasCheckStatus(
	forgeActionStatus: ForgeActionStatus | null | undefined,
	statuses: ReadonlySet<CheckStatus>,
): boolean {
	return (
		forgeActionStatus?.checks?.some((check) => statuses.has(check.status)) ??
		false
	);
}

const ACTIVE_CHECK_STATUSES = new Set<CheckStatus>(["pending", "running"]);
const FAILED_CHECK_STATUSES = new Set<CheckStatus>(["failure"]);
const NOT_GREEN_CHECK_STATUSES = new Set<CheckStatus>([
	"pending",
	"running",
	"failure",
]);
const BLOCKED_MERGE_STATE_STATUSES = new Set([
	"BEHIND",
	"BLOCKED",
	"DRAFT",
	"UNSTABLE",
]);

export function hasActiveForgeChecks(
	forgeActionStatus: ForgeActionStatus | null | undefined,
): boolean {
	return hasCheckStatus(forgeActionStatus, ACTIVE_CHECK_STATUSES);
}

export function hasFailingForgeChecks(
	forgeActionStatus: ForgeActionStatus | null | undefined,
): boolean {
	return hasCheckStatus(forgeActionStatus, FAILED_CHECK_STATUSES);
}

export function hasNonPassingForgeChecks(
	forgeActionStatus: ForgeActionStatus | null | undefined,
): boolean {
	return hasCheckStatus(forgeActionStatus, NOT_GREEN_CHECK_STATUSES);
}

export function hasBlockedMergeState(
	forgeActionStatus: ForgeActionStatus | null | undefined,
): boolean {
	const state = forgeActionStatus?.mergeStateStatus;
	return state ? BLOCKED_MERGE_STATE_STATUSES.has(state) : false;
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
 *   5. checks-running     — CI is not done yet; merge needs explicit bypass
 *   6. merge-blocked      — branch protection blocks normal merge
 *   7. merge              — ready to merge
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
			if (hasFailingForgeChecks(forgeActionStatus)) return "fix";

			// 5. Pending/running CI should not look ready to merge. Keep the
			// action available, but the click path asks for an explicit bypass.
			if (hasActiveForgeChecks(forgeActionStatus)) return "checks-running";

			// 6. Branch protection can block merge for reasons outside CI,
			// like unresolved conversations. Keep the action explicit.
			if (hasBlockedMergeState(forgeActionStatus)) return "merge-blocked";

			// 7. Ready to merge
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
		if (mode === "merge" && forgeActionStatus?.mergeable === "UNKNOWN") {
			return "disabled";
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
