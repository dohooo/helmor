import type { WorkspaceSessionSummary } from "@/lib/api";

type SessionSortOptions = {
	sendingSessionIds?: ReadonlySet<string>;
	completedSessionIds?: ReadonlySet<string>;
	interactionRequiredSessionIds?: ReadonlySet<string>;
};

const LIVE_SESSION_STATUSES = new Set([
	"pending",
	"streaming",
	"streaming_input",
	"running",
]);

function isActionSession(session: WorkspaceSessionSummary): boolean {
	return Boolean(session.actionKind);
}

function isSessionAttentionWorthy(
	session: WorkspaceSessionSummary,
	completedSessionIds: ReadonlySet<string>,
	interactionRequiredSessionIds: ReadonlySet<string>,
): boolean {
	return (
		interactionRequiredSessionIds.has(session.id) ||
		session.unreadCount > 0 ||
		completedSessionIds.has(session.id)
	);
}

function isSessionRunning(
	session: WorkspaceSessionSummary,
	sendingSessionIds: ReadonlySet<string>,
): boolean {
	return (
		sendingSessionIds.has(session.id) ||
		LIVE_SESSION_STATUSES.has(session.status)
	);
}

function sessionPriority(
	session: WorkspaceSessionSummary,
	options: Required<SessionSortOptions>,
): number {
	const isAction = isActionSession(session);
	const hasAttention = isSessionAttentionWorthy(
		session,
		options.completedSessionIds,
		options.interactionRequiredSessionIds,
	);
	const isRunning = isSessionRunning(session, options.sendingSessionIds);

	if (!isAction && hasAttention) {
		return 0;
	}
	if (!isAction && isRunning) {
		return 1;
	}
	if (!isAction) {
		return 2;
	}
	if (hasAttention || isRunning) {
		return 3;
	}
	return 4;
}

function attentionPriority(
	session: WorkspaceSessionSummary,
	options: Required<SessionSortOptions>,
): number {
	if (options.interactionRequiredSessionIds.has(session.id)) {
		return 0;
	}
	if (session.unreadCount > 0) {
		return 1;
	}
	if (options.completedSessionIds.has(session.id)) {
		return 2;
	}
	return 3;
}

function compareIsoDateDesc(a?: string | null, b?: string | null): number {
	if (a === b) {
		return 0;
	}
	if (!a) {
		return 1;
	}
	if (!b) {
		return -1;
	}
	return b.localeCompare(a);
}

export function sortWorkspaceSessionsForDisplay(
	sessions: WorkspaceSessionSummary[],
	options: SessionSortOptions = {},
): WorkspaceSessionSummary[] {
	const resolvedOptions: Required<SessionSortOptions> = {
		sendingSessionIds: options.sendingSessionIds ?? new Set(),
		completedSessionIds: options.completedSessionIds ?? new Set(),
		interactionRequiredSessionIds:
			options.interactionRequiredSessionIds ?? new Set(),
	};

	return sessions
		.map((session, index) => ({ session, index }))
		.sort((a, b) => {
			const aPriority = sessionPriority(a.session, resolvedOptions);
			const bPriority = sessionPriority(b.session, resolvedOptions);
			if (aPriority !== bPriority) {
				return aPriority - bPriority;
			}

			const aAttention = attentionPriority(a.session, resolvedOptions);
			const bAttention = attentionPriority(b.session, resolvedOptions);
			if (aAttention !== bAttention) {
				return aAttention - bAttention;
			}

			const updatedAtOrder = compareIsoDateDesc(
				a.session.updatedAt,
				b.session.updatedAt,
			);
			if (updatedAtOrder !== 0) {
				return updatedAtOrder;
			}

			const createdAtOrder = compareIsoDateDesc(
				a.session.createdAt,
				b.session.createdAt,
			);
			if (createdAtOrder !== 0) {
				return createdAtOrder;
			}

			return a.index - b.index;
		})
		.map(({ session }) => session);
}
