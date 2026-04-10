import type {
	AgentModelOption,
	AgentModelSection,
	MessagePart,
	PullRequestInfo,
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
