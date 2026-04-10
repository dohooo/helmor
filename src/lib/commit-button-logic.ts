import type {
	CommitButtonState,
	WorkspaceCommitButtonMode,
} from "@/components/workspace-commit-button";
import type { PullRequestInfo } from "./api";

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
 * Derive the commit button's visible mode from the lifecycle + PR query.
 *
 * During an active lifecycle, the mode follows the lifecycle. At rest, the
 * mode is derived from the persistent PR query so the button reflects the
 * real GitHub state across page reloads.
 */
export function deriveCommitButtonMode(
	lifecycle: CommitLifecycle,
	prInfo: PullRequestInfo | null,
): WorkspaceCommitButtonMode {
	if (lifecycle) {
		if (lifecycle.phase === "done" && lifecycle.prInfo) {
			return lifecycle.prInfo.isMerged ? "merged" : "merge";
		}
		return lifecycle.mode;
	}
	if (prInfo) {
		if (prInfo.isMerged) return "merged";
		if (prInfo.state === "OPEN") return "merge";
		if (prInfo.state === "CLOSED") return "create-pr";
	}
	return "create-pr";
}

/**
 * Derive the commit button's visible state from the lifecycle.
 */
export function deriveCommitButtonState(
	lifecycle: CommitLifecycle,
): CommitButtonState {
	if (!lifecycle) return "idle";
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
