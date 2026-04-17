import type {
	AgentModelOption,
	AgentModelSection,
	AgentProvider,
	MessagePart,
	PullRequestInfo,
	ThreadMessageLike,
	WorkspaceDetail,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
	WorkspaceSummary,
} from "./api";

export const OPTIMISTIC_CREATING_WORKSPACE_ID_PREFIX = "creating-workspace:";

export function createOptimisticCreatingWorkspaceId(repoId: string): string {
	return `${OPTIMISTIC_CREATING_WORKSPACE_ID_PREFIX}${repoId}:${crypto.randomUUID()}`;
}

export function isOptimisticCreatingWorkspaceId(
	workspaceId: string | null | undefined,
): boolean {
	return (
		typeof workspaceId === "string" &&
		workspaceId.startsWith(OPTIMISTIC_CREATING_WORKSPACE_ID_PREFIX)
	);
}

export function createOptimisticCreatingWorkspaceDetail(
	row: WorkspaceRow,
	repoId: string,
): WorkspaceDetail {
	return {
		id: row.id,
		title: row.title,
		repoId,
		repoName: row.repoName ?? "",
		repoIconSrc: row.repoIconSrc ?? null,
		repoInitials: row.repoInitials ?? null,
		remote: null,
		remoteUrl: null,
		defaultBranch: null,
		rootPath: null,
		directoryName: row.directoryName ?? row.id,
		state: "initializing",
		hasUnread: false,
		workspaceUnread: 0,
		sessionUnreadTotal: 0,
		unreadSessionCount: 0,
		derivedStatus: row.derivedStatus ?? "in-progress",
		manualStatus: row.manualStatus ?? null,
		activeSessionId: null,
		activeSessionTitle: null,
		activeSessionAgentType: null,
		activeSessionStatus: null,
		branch: row.branch ?? null,
		initializationParentBranch: null,
		intendedTargetBranch: null,
		notes: null,
		pinnedAt: row.pinnedAt ?? null,
		prTitle: null,
		prDescription: null,
		archiveCommit: null,
		sessionCount: 0,
		messageCount: 0,
		attachmentCount: 0,
	};
}

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

export function flattenWorkspaceRowsForNavigation(
	groups: WorkspaceGroup[],
	archivedRows: WorkspaceRow[],
) {
	return [...groups.flatMap((group) => group.rows), ...archivedRows];
}

export function findReplacementWorkspaceIdAfterRemoval({
	currentGroups,
	currentArchivedRows,
	nextGroups,
	nextArchivedRows,
	removedWorkspaceId,
}: {
	currentGroups: WorkspaceGroup[];
	currentArchivedRows: WorkspaceRow[];
	nextGroups: WorkspaceGroup[];
	nextArchivedRows: WorkspaceRow[];
	removedWorkspaceId: string;
}): string | null {
	const currentRows = flattenWorkspaceRowsForNavigation(
		currentGroups,
		currentArchivedRows,
	);
	const removedIndex = currentRows.findIndex(
		(row) => row.id === removedWorkspaceId,
	);
	const nextRows = flattenWorkspaceRowsForNavigation(
		nextGroups,
		nextArchivedRows,
	);

	if (nextRows.length === 0) {
		return null;
	}

	if (removedIndex === -1) {
		return nextRows[0]?.id ?? null;
	}

	return nextRows[removedIndex]?.id ?? nextRows[removedIndex - 1]?.id ?? null;
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

/**
 * Map a workspace's status (manual takes precedence over derived) to the
 * sidebar group id it belongs in. Mirrors `helpers::group_id_from_status`
 * in the Rust backend so that optimistic UI placement matches what the
 * canonical query will return on the next invalidation — no flicker as the
 * row jumps groups when the real data lands.
 */
export function workspaceGroupIdFromStatus(
	manualStatus: string | null | undefined,
	derivedStatus: string | null | undefined,
): "done" | "review" | "progress" | "backlog" | "canceled" {
	const raw = (manualStatus ?? derivedStatus ?? "").trim().toLowerCase();
	switch (raw) {
		case "done":
			return "done";
		case "review":
		case "in-review":
			return "review";
		case "backlog":
			return "backlog";
		case "cancelled":
		case "canceled":
			return "canceled";
		default:
			return "progress";
	}
}

export type WorkspaceBranchTone =
	| "working"
	| "open"
	| "merged"
	| "closed"
	| "inactive";

export function getWorkspaceBranchTone({
	workspaceState,
	manualStatus,
	derivedStatus,
	prInfo,
}: {
	workspaceState?: string | null;
	manualStatus?: string | null;
	derivedStatus?: string | null;
	prInfo?: Pick<PullRequestInfo, "state" | "isMerged"> | null;
}): WorkspaceBranchTone {
	if ((workspaceState ?? "").trim().toLowerCase() === "archived") {
		return "inactive";
	}

	if (prInfo) {
		if (prInfo.isMerged || prInfo.state === "MERGED") {
			return "merged";
		}

		if (prInfo.state === "OPEN") {
			return "open";
		}

		if (prInfo.state === "CLOSED") {
			return "closed";
		}
	}

	const raw = (manualStatus ?? derivedStatus ?? "").trim().toLowerCase();
	switch (raw) {
		case "done":
			return "merged";
		case "review":
		case "in-review":
			return "open";
		case "cancelled":
		case "canceled":
			return "closed";
		default:
			return "working";
	}
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

export function resolveSessionSelectedModelId({
	session,
	modelSelections,
	modelSections,
	settingsDefaultModelId,
}: {
	session: Pick<
		WorkspaceSessionSummary,
		"id" | "agentType" | "model" | "lastUserMessageAt"
	> | null;
	modelSelections: Record<string, string>;
	modelSections: AgentModelSection[];
	settingsDefaultModelId?: string | null;
}): string | null {
	const selectedModelId = session
		? (modelSelections[getComposerContextKey(null, session.id)] ?? null)
		: null;
	return (
		selectedModelId ??
		inferDefaultModelId(session, modelSections, settingsDefaultModelId)
	);
}

export function resolveSessionDisplayProvider({
	session,
	modelSelections,
	modelSections,
	settingsDefaultModelId,
}: {
	session: Pick<
		WorkspaceSessionSummary,
		"id" | "agentType" | "model" | "lastUserMessageAt"
	>;
	modelSelections: Record<string, string>;
	modelSections: AgentModelSection[];
	settingsDefaultModelId?: string | null;
}): AgentProvider | null {
	const selectedModelId = resolveSessionSelectedModelId({
		session,
		modelSelections,
		modelSections,
		settingsDefaultModelId,
	});
	const selectedProvider = findModelOption(
		modelSections,
		selectedModelId,
	)?.provider;
	if (selectedProvider) {
		return selectedProvider;
	}
	if (session.agentType === "codex") {
		return "codex";
	}
	if (session.agentType === "claude") {
		return "claude";
	}
	return null;
}

/**
 * Reverse of `summaryToArchivedRow` — used for optimistic archive updates,
 * where we know a workspace is moving from the live groups into the archived
 * list before the backend has confirmed. Optional row fields that are
 * required on the summary fall back to safe defaults; the next query
 * invalidation will replace this object with the canonical backend version.
 */
export function rowToWorkspaceSummary(
	row: WorkspaceRow,
	overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
	return {
		id: row.id,
		title: row.title,
		directoryName: row.directoryName ?? "",
		repoName: row.repoName ?? "",
		repoIconSrc: row.repoIconSrc ?? null,
		repoInitials: row.repoInitials ?? null,
		state: row.state ?? "archived",
		hasUnread: row.hasUnread ?? false,
		workspaceUnread: row.workspaceUnread ?? 0,
		sessionUnreadTotal: row.sessionUnreadTotal ?? 0,
		unreadSessionCount: row.unreadSessionCount ?? 0,
		derivedStatus: row.derivedStatus ?? "in-progress",
		manualStatus: row.manualStatus ?? null,
		branch: row.branch ?? null,
		activeSessionId: row.activeSessionId ?? null,
		activeSessionTitle: row.activeSessionTitle ?? null,
		activeSessionAgentType: row.activeSessionAgentType ?? null,
		activeSessionStatus: row.activeSessionStatus ?? null,
		prTitle: row.prTitle ?? null,
		sessionCount: row.sessionCount,
		messageCount: row.messageCount,
		attachmentCount: row.attachmentCount,
		...overrides,
	};
}

/** Session has never exchanged any messages with an agent. */
export function isNewSession(
	session: Pick<
		WorkspaceSessionSummary,
		"agentType" | "lastUserMessageAt"
	> | null,
): boolean {
	if (!session) return true;
	return !session.agentType && !session.lastUserMessageAt;
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
	session: Pick<
		WorkspaceSessionSummary,
		"agentType" | "model" | "lastUserMessageAt"
	> | null,
	modelSections: AgentModelSection[],
	settingsDefaultModelId?: string | null,
): string | null {
	// Existing session with history → respect whatever model it used
	if (!isNewSession(session)) {
		const sessionModel = session?.model ?? null;
		if (sessionModel && findModelOption(modelSections, sessionModel)) {
			return sessionModel;
		}
	}

	// New session or no history → user setting takes priority
	if (
		settingsDefaultModelId &&
		findModelOption(modelSections, settingsDefaultModelId)
	) {
		return settingsDefaultModelId;
	}

	// Ultimate fallback: first Claude model, then first available model.
	const claudeSection = modelSections.find((s) => s.id === "claude");
	return (
		claudeSection?.options[0]?.id ?? modelSections[0]?.options[0]?.id ?? null
	);
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

/**
 * Split `text` on `@<path>` substrings (longer paths win on overlap),
 * returning interleaved Text and FileMention parts. Mirrors the Rust
 * `split_user_text_with_files` so optimistic and persisted renders match.
 */
export function splitTextWithFiles(
	text: string,
	files: readonly string[],
): MessagePart[] {
	if (files.length === 0 || text.length === 0) {
		return [{ type: "text", text }];
	}
	const sorted = [...files].sort((a, b) => b.length - a.length);
	const matches: { start: number; end: number; path: string }[] = [];
	for (const file of sorted) {
		if (!file) continue;
		const needle = `@${file}`;
		let searchStart = 0;
		while (true) {
			const idx = text.indexOf(needle, searchStart);
			if (idx === -1) break;
			const end = idx + needle.length;
			const overlaps = matches.some((m) => !(end <= m.start || idx >= m.end));
			if (!overlaps) matches.push({ start: idx, end, path: file });
			searchStart = end;
		}
	}
	if (matches.length === 0) return [{ type: "text", text }];
	matches.sort((a, b) => a.start - b.start);
	const parts: MessagePart[] = [];
	let cursor = 0;
	for (const m of matches) {
		if (cursor < m.start) {
			parts.push({ type: "text", text: text.slice(cursor, m.start) });
		}
		parts.push({ type: "file-mention", path: m.path });
		cursor = m.end;
	}
	if (cursor < text.length) {
		parts.push({ type: "text", text: text.slice(cursor) });
	}
	return parts;
}

/** Create a live ThreadMessageLike for optimistic rendering. */
export function createLiveThreadMessage({
	id,
	role,
	text,
	createdAt,
	files = [],
}: {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	createdAt: string;
	files?: readonly string[];
}): ThreadMessageLike {
	return {
		role,
		id,
		createdAt,
		content: splitTextWithFiles(text, files),
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

// No fake default — when the SDK doesn't return effort levels for a model
// (e.g. Claude Haiku), the composer hides the effort picker entirely instead
// of inventing one. Callers must handle the empty-list case.
export function getAvailableEffortLevels(
	modelId: string | null,
	modelSections?: AgentModelSection[],
): string[] {
	if (!modelId || !modelSections) return [];
	const model = findModelOption(modelSections, modelId);
	return model?.effortLevels ? [...model.effortLevels] : [];
}

/** Clamp an effort level to the nearest available one. Empty `available`
 * means the model doesn't expose effort — pass the raw value through. */
export function clampEffort(rawEffort: string, available: string[]): string {
	if (available.length === 0) return rawEffort;
	if (available.includes(rawEffort)) return rawEffort;
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

export function clampEffortToModel(
	rawEffort: string,
	modelId: string | null,
	modelSections?: AgentModelSection[],
): string {
	return clampEffort(
		rawEffort,
		getAvailableEffortLevels(modelId, modelSections),
	);
}
