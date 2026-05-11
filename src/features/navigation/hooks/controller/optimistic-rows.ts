// Pure factories for the optimistic workspace rows / sessions written into
// the React Query cache while a backend create / restore round-trip is in
// flight. Keep both inputs and outputs free of React state so callers can
// run them inside `setQueryData` updaters without ordering surprises.
import type {
	RepositoryCreateOption,
	WorkspaceRow,
	WorkspaceSessionSummary,
	WorkspaceState,
} from "@/lib/api";

export function createPreparedWorkspaceRow(
	repository: RepositoryCreateOption,
	prepared: {
		workspaceId: string;
		initialSessionId: string;
		directoryName: string;
		branch: string;
		state: WorkspaceState;
	},
): WorkspaceRow {
	return {
		id: prepared.workspaceId,
		// Prepare returns the final directory and branch, so the row is
		// already in its terminal shape — no placeholder → real swap.
		title: `${repository.name} workspace`,
		directoryName: prepared.directoryName,
		repoName: repository.name,
		repoIconSrc: repository.repoIconSrc ?? null,
		repoInitials: repository.repoInitials ?? null,
		state: prepared.state,
		hasUnread: false,
		workspaceUnread: 0,
		unreadSessionCount: 0,
		status: "in-progress",
		branch: prepared.branch,
		activeSessionId: prepared.initialSessionId,
		activeSessionTitle: "Untitled",
		activeSessionAgentType: null,
		activeSessionStatus: "idle",
		prTitle: null,
		pinnedAt: null,
		sessionCount: 1,
		messageCount: 0,
		createdAt: new Date().toISOString(),
	};
}

export function createOptimisticWorkspaceSession(
	workspaceId: string,
	sessionId: string,
	createdAt: string,
): WorkspaceSessionSummary {
	return {
		id: sessionId,
		workspaceId,
		title: "Untitled",
		agentType: null,
		status: "idle",
		model: null,
		permissionMode: "default",
		providerSessionId: null,
		effortLevel: null,
		unreadCount: 0,
		fastMode: false,
		createdAt,
		updatedAt: createdAt,
		lastUserMessageAt: null,
		isHidden: false,
		actionKind: null,
		active: true,
	};
}
