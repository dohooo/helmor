import type {
	AgentModelOption,
	AgentModelSection,
	SessionMessageRecord,
	ThreadMessageLike,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
	WorkspaceSummary,
} from "./api";

const DEFAULT_CLAUDE_MODEL_ID = "opus-1m";
const DEFAULT_CODEX_MODEL_ID = "gpt-5.4";

export function findInitialWorkspaceId(
	groups: WorkspaceGroup[],
): string | null {
	for (const group of groups) {
		if (group.rows.length > 0) {
			return group.rows[0].id;
		}
	}

	return null;
}

export function hasWorkspaceId(
	workspaceId: string,
	groups: WorkspaceGroup[],
	archived: WorkspaceSummary[],
) {
	return (
		groups.some((group) => group.rows.some((row) => row.id === workspaceId)) ||
		archived.some((workspace) => workspace.id === workspaceId)
	);
}

export function findWorkspaceRowById(
	workspaceId: string,
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	for (const group of groups) {
		const match = group.rows.find((row) => row.id === workspaceId);

		if (match) {
			return match;
		}
	}

	return archivedRows.find((row) => row.id === workspaceId) ?? null;
}

export function clearWorkspaceUnreadFromRow(row: WorkspaceRow): WorkspaceRow {
	return {
		...row,
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
	};
}

export function clearWorkspaceUnreadFromGroups(
	groups: WorkspaceGroup[],
	workspaceId: string,
): WorkspaceGroup[] {
	return groups.map((group) => ({
		...group,
		rows: group.rows.map((row) =>
			row.id === workspaceId ? clearWorkspaceUnreadFromRow(row) : row,
		),
	}));
}

export function clearWorkspaceUnreadFromSummaries(
	summaries: WorkspaceSummary[],
	workspaceId: string,
): WorkspaceSummary[] {
	return summaries.map((summary) =>
		summary.id === workspaceId
			? {
					...summary,
					hasUnread: false,
					workspaceUnread: 0,
					sessionUnreadTotal: 0,
					unreadSessionCount: 0,
				}
			: summary,
	);
}

export function summaryToArchivedRow(summary: WorkspaceSummary): WorkspaceRow {
	return {
		id: summary.id,
		title: summary.title,
		directoryName: summary.directoryName,
		repoName: summary.repoName,
		repoIconSrc: summary.repoIconSrc ?? null,
		repoInitials: summary.repoInitials ?? null,
		state: summary.state,
		hasUnread: summary.hasUnread,
		workspaceUnread: summary.workspaceUnread,
		sessionUnreadTotal: summary.sessionUnreadTotal,
		unreadSessionCount: summary.unreadSessionCount,
		derivedStatus: summary.derivedStatus,
		manualStatus: summary.manualStatus ?? null,
		branch: summary.branch ?? null,
		activeSessionId: summary.activeSessionId ?? null,
		activeSessionTitle: summary.activeSessionTitle ?? null,
		activeSessionAgentType: summary.activeSessionAgentType ?? null,
		activeSessionStatus: summary.activeSessionStatus ?? null,
		prTitle: summary.prTitle ?? null,
		sessionCount: summary.sessionCount,
		messageCount: summary.messageCount,
		attachmentCount: summary.attachmentCount,
	};
}

export function getComposerContextKey(
	workspaceId: string | null,
	sessionId: string | null,
): string {
	if (sessionId) {
		return `session:${sessionId}`;
	}

	if (workspaceId) {
		return `workspace:${workspaceId}`;
	}

	return "global";
}

export function inferDefaultModelId(
	session: WorkspaceSessionSummary | null,
	modelSections: AgentModelSection[],
): string {
	const preferredModelId = session?.model ?? null;
	if (preferredModelId && findModelOption(modelSections, preferredModelId)) {
		return preferredModelId;
	}

	return session?.agentType === "codex"
		? DEFAULT_CODEX_MODEL_ID
		: DEFAULT_CLAUDE_MODEL_ID;
}

export function describeUnknownError(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim()) {
		return error.message;
	}

	if (typeof error === "string" && error.trim()) {
		return error;
	}

	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string" &&
		error.message.trim()
	) {
		return error.message;
	}

	try {
		const serialized = JSON.stringify(error);
		if (serialized && serialized !== "{}") {
			return serialized;
		}
	} catch {
		// Ignore serialization failures and fall through.
	}

	return fallback;
}

export function findModelOption(
	modelSections: AgentModelSection[],
	modelId: string | null,
): AgentModelOption | null {
	if (!modelId) {
		return null;
	}

	return (
		modelSections
			.flatMap((section) => section.options)
			.find((option) => option.id === modelId) ?? null
	);
}

/** Create a live ThreadMessageLike for optimistic rendering. */
export function createLiveThreadMessage({
	id,
	role,
	text,
	createdAt,
}: {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	createdAt: string;
}): ThreadMessageLike {
	return {
		role,
		id,
		createdAt,
		content: [{ type: "text", text }],
	};
}

/** @deprecated Use createLiveThreadMessage for new code. */
export function createLiveMessage({
	id,
	sessionId,
	role,
	content,
	createdAt,
	model,
}: {
	id: string;
	sessionId: string;
	role: string;
	content: string;
	createdAt: string;
	model: string;
}): SessionMessageRecord {
	return {
		id,
		sessionId,
		role,
		content,
		contentIsJson: false,
		createdAt,
		sentAt: createdAt,
		cancelledAt: null,
		model,
		sdkMessageId: null,
		lastAssistantMessageId: null,
		turnId: null,
		isResumableMessage: null,
		attachmentCount: 0,
	};
}

export function appendLiveThreadMessage(
	current: Record<string, ThreadMessageLike[]>,
	contextKey: string,
	message: ThreadMessageLike,
) {
	return {
		...current,
		[contextKey]: [...(current[contextKey] ?? []), message],
	};
}

export function appendLiveMessage(
	current: Record<string, SessionMessageRecord[]>,
	contextKey: string,
	message: SessionMessageRecord,
) {
	return {
		...current,
		[contextKey]: [...(current[contextKey] ?? []), message],
	};
}

// ── Effort-level helpers ──────────────────────────────────────────────

const EFFORT_RANK: Record<string, number> = {
	minimal: 0,
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4,
	max: 4,
};

export function getAvailableEffortLevels(
	modelId: string | null,
	provider: string,
): string[] {
	if (modelId === "gpt-5.1-codex-mini") return ["medium", "high"];
	if (provider === "codex") return ["low", "medium", "high", "xhigh"];
	if (modelId === "opus-1m" || modelId === "opus")
		return ["low", "medium", "high", "max"];
	return ["low", "medium", "high"];
}

export function clampEffortToModel(
	rawEffort: string,
	modelId: string | null,
	provider: string,
): string {
	const available = getAvailableEffortLevels(modelId, provider);
	const rank = EFFORT_RANK[rawEffort] ?? 3;
	const ranked = available.map((l) => ({
		level: l,
		rank: EFFORT_RANK[l] ?? 0,
	}));
	const minRank = Math.min(...ranked.map((a) => a.rank));
	const maxRank = Math.max(...ranked.map((a) => a.rank));
	const clamped = Math.max(minRank, Math.min(maxRank, rank));
	return (
		ranked.find((a) => a.rank === clamped)?.level ??
		available[available.length - 1]!
	);
}

export function haveSameLiveMessages(
	current: SessionMessageRecord[] | undefined,
	next: SessionMessageRecord[],
) {
	if (!current || current.length !== next.length) return false;

	return current.every((message, index) => {
		const nextMessage = next[index];
		return (
			message.id === nextMessage.id &&
			message.role === nextMessage.role &&
			message.content === nextMessage.content &&
			message.contentIsJson === nextMessage.contentIsJson &&
			message.createdAt === nextMessage.createdAt
		);
	});
}
