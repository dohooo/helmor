import type {
	AgentModelOption,
	AgentModelSection,
	AgentProvider,
	ChangeRequestInfo,
	MessagePart,
	ThreadMessageLike,
	WorkspaceDetail,
	WorkspaceGroup,
	WorkspaceRow,
	WorkspaceSessionSummary,
	WorkspaceStatus,
	WorkspaceSummary,
} from "./api";
import { extractError } from "./errors";

export function createOptimisticCreatingWorkspaceDetail(
	row: WorkspaceRow,
	repoId: string,
	initialSessionId: string | null = null,
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
		unreadSessionCount: 0,
		status: row.status ?? "in-progress",
		activeSessionId: initialSessionId,
		activeSessionTitle: initialSessionId ? "Untitled" : null,
		activeSessionAgentType: null,
		activeSessionStatus: initialSessionId ? "idle" : null,
		branch: row.branch ?? null,
		initializationParentBranch: null,
		intendedTargetBranch: null,
		mode: row.mode ?? "worktree",
		pinnedAt: row.pinnedAt ?? null,
		prTitle: null,
		archiveCommit: null,
		sessionCount: initialSessionId ? 1 : 0,
		messageCount: 0,
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
 * Map a workspace's status to the sidebar group id it belongs in.
 * Mirrors `list_workspace_groups` in the
 * Rust backend: pinned rows go to the `pinned` group regardless of status,
 * otherwise status decides. Matching the backend here means optimistic UI
 * placement lands in the same group the next query invalidation will put
 * the row into — no cross-group flicker when real data arrives.
 */
export function workspaceGroupIdFromStatus(
	status: string | null | undefined,
	pinnedAt?: string | null | undefined,
): "pinned" | "done" | "review" | "progress" | "backlog" | "canceled" {
	if (pinnedAt) return "pinned";
	const raw = (status ?? "").trim().toLowerCase();
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

/**
 * Insert `row` into `rows` preserving `createdAt DESC` order (matching the
 * backend's `ORDER BY datetime(created_at) DESC` for non-archived groups).
 * Used for optimistic insertions — placing the row in its final spot avoids
 * the reorder flicker that happens when the refetch returns and re-sorts.
 *
 * Rows without a `createdAt` are treated as newest (sort to the front), so
 * freshly-created workspaces still land at the top as before.
 */
export function insertRowByCreatedAtDesc(
	rows: WorkspaceRow[],
	row: WorkspaceRow,
): WorkspaceRow[] {
	const key = (r: WorkspaceRow): string => r.createdAt ?? "\uFFFF";
	const incoming = key(row);
	const index = rows.findIndex((existing) => key(existing) < incoming);
	if (index === -1) return [...rows, row];
	return [...rows.slice(0, index), row, ...rows.slice(index)];
}

/**
 * Move a workspace row from its current sidebar group to the group implied by
 * `nextStatus`. Preserves the row's existing fields (createdAt, pinnedAt, …)
 * and uses `insertRowByCreatedAtDesc` so the optimistic position matches the
 * spot the server will place the row on refetch — no reorder flicker.
 *
 * Returns `groups` unchanged when the workspace isn't in any live group
 * (likely pinned-only / archived) — we don't fabricate a row out of thin air;
 * the next event-driven invalidation will reconcile.
 */
export function moveWorkspaceToGroup(
	groups: WorkspaceGroup[] | undefined,
	workspaceId: string,
	nextStatus: WorkspaceStatus,
): WorkspaceGroup[] | undefined {
	if (!groups) return groups;

	let row: WorkspaceRow | null = null;
	const stripped = groups.map((group) => {
		const idx = group.rows.findIndex((r) => r.id === workspaceId);
		if (idx === -1) return group;
		row = group.rows[idx]!;
		return { ...group, rows: group.rows.filter((_, i) => i !== idx) };
	});
	if (!row) return groups;

	const sourceRow: WorkspaceRow = row;
	const updatedRow: WorkspaceRow = { ...sourceRow, status: nextStatus };
	const targetGroupId = workspaceGroupIdFromStatus(
		nextStatus,
		updatedRow.pinnedAt,
	);

	return stripped.map((group) =>
		group.id === targetGroupId
			? { ...group, rows: insertRowByCreatedAtDesc(group.rows, updatedRow) }
			: group,
	);
}

export type WorkspaceBranchTone =
	| "working"
	| "open"
	| "merged"
	| "closed"
	| "inactive";

export function getWorkspaceBranchTone({
	workspaceState,
	status,
	changeRequest,
}: {
	workspaceState?: string | null;
	status?: string | null;
	changeRequest?: Pick<ChangeRequestInfo, "state" | "isMerged"> | null;
}): WorkspaceBranchTone {
	if ((workspaceState ?? "").trim().toLowerCase() === "archived") {
		return "inactive";
	}

	if (changeRequest) {
		if (changeRequest.isMerged || changeRequest.state === "MERGED") {
			return "merged";
		}

		if (changeRequest.state === "OPEN") {
			return "open";
		}

		if (changeRequest.state === "CLOSED") {
			return "closed";
		}
	}

	const raw = (status ?? "").trim().toLowerCase();
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

/**
 * Apply "this workspace now has N unread sessions" to the groups cache.
 * `workspaceUnread` is an independent flag — we only clear it optimistically
 * when every session becomes read (matching the backend rule in
 * `clear_workspace_unread_if_no_session_unread_in_transaction`). While any
 * session is still unread we leave the existing `workspaceUnread` alone.
 */
export function recomputeWorkspaceUnreadInGroups(
	groups: WorkspaceGroup[] | undefined,
	workspaceId: string | null,
	remainingUnreadSessionCount: number,
): WorkspaceGroup[] | undefined {
	if (!groups || !workspaceId) return groups;
	return groups.map((group) => ({
		...group,
		rows: group.rows.map((row) => {
			if (row.id !== workspaceId) return row;
			const nextWorkspaceUnread =
				remainingUnreadSessionCount > 0 ? (row.workspaceUnread ?? 0) : 0;
			return {
				...row,
				unreadSessionCount: remainingUnreadSessionCount,
				workspaceUnread: nextWorkspaceUnread,
				hasUnread: remainingUnreadSessionCount > 0 || nextWorkspaceUnread > 0,
			};
		}),
	}));
}

export function recomputeWorkspaceDetailUnread(
	detail: WorkspaceDetail,
	remainingUnreadSessionCount: number,
): WorkspaceDetail {
	const nextWorkspaceUnread =
		remainingUnreadSessionCount > 0 ? (detail.workspaceUnread ?? 0) : 0;
	return {
		...detail,
		unreadSessionCount: remainingUnreadSessionCount,
		workspaceUnread: nextWorkspaceUnread,
		hasUnread: remainingUnreadSessionCount > 0 || nextWorkspaceUnread > 0,
	};
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
		mode: summary.mode ?? "worktree",
		hasUnread: summary.hasUnread,
		workspaceUnread: summary.workspaceUnread,
		unreadSessionCount: summary.unreadSessionCount,
		status: summary.status,
		branch: summary.branch ?? null,
		activeSessionId: summary.activeSessionId ?? null,
		activeSessionTitle: summary.activeSessionTitle ?? null,
		activeSessionAgentType: summary.activeSessionAgentType ?? null,
		activeSessionStatus: summary.activeSessionStatus ?? null,
		primarySessionId: summary.primarySessionId ?? null,
		primarySessionTitle: summary.primarySessionTitle ?? null,
		primarySessionAgentType: summary.primarySessionAgentType ?? null,
		prTitle: summary.prTitle ?? null,
		pinnedAt: summary.pinnedAt ?? null,
		sessionCount: summary.sessionCount,
		messageCount: summary.messageCount,
		createdAt: summary.createdAt,
		updatedAt: summary.updatedAt,
		lastUserMessageAt: summary.lastUserMessageAt ?? null,
	};
}

export function resolveSessionSelectedModelId({
	session,
	modelSelections,
	modelSections,
	settingsDefaultModelId,
	contextKey,
}: {
	session: Pick<
		WorkspaceSessionSummary,
		"id" | "agentType" | "model" | "lastUserMessageAt"
	> | null;
	modelSelections: Partial<Record<string, string>>;
	modelSections: AgentModelSection[];
	settingsDefaultModelId?: string | null;
	contextKey?: string | null;
}): string | null {
	let selectedModelId = contextKey ? modelSelections[contextKey] : undefined;
	if (!selectedModelId && session) {
		selectedModelId = modelSelections[getComposerContextKey(null, session.id)];
	}
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
	modelSelections: Partial<Record<string, string>>;
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
		mode: row.mode ?? "worktree",
		hasUnread: row.hasUnread ?? false,
		workspaceUnread: row.workspaceUnread ?? 0,
		unreadSessionCount: row.unreadSessionCount ?? 0,
		status: row.status ?? "in-progress",
		branch: row.branch ?? null,
		activeSessionId: row.activeSessionId ?? null,
		activeSessionTitle: row.activeSessionTitle ?? null,
		activeSessionAgentType: row.activeSessionAgentType ?? null,
		activeSessionStatus: row.activeSessionStatus ?? null,
		primarySessionId: row.primarySessionId ?? null,
		primarySessionTitle: row.primarySessionTitle ?? null,
		primarySessionAgentType: row.primarySessionAgentType ?? null,
		prTitle: row.prTitle ?? null,
		pinnedAt: row.pinnedAt ?? null,
		sessionCount: row.sessionCount,
		messageCount: row.messageCount,
		createdAt: row.createdAt ?? new Date().toISOString(),
		updatedAt: row.updatedAt,
		lastUserMessageAt: row.lastUserMessageAt ?? null,
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
	const allOptions = modelSections.flatMap((section) => section.options);

	// If the session row carries an explicit model — either from history
	// (streaming finalizer) or from a saveForLater pre-config — respect it.
	// Fresh sessions are created with `model = NULL` so this safely falls
	// through to the user's current settings default below.
	const sessionModel = session?.model ?? null;
	if (sessionModel && findModelOption(modelSections, sessionModel)) {
		return sessionModel;
	}

	// New session or no valid session model → user setting is the only source.
	// `useEnsureDefaultModel` is responsible for making sure this is non-null
	// and valid once the catalog is loaded.
	if (
		settingsDefaultModelId &&
		findModelOption(modelSections, settingsDefaultModelId)
	) {
		return settingsDefaultModelId;
	}

	// Last-resort UI fallback so the composer never renders an empty model chip
	// while settings bootstrap or self-heal catches up.
	return allOptions[0]?.id ?? null;
}

export function describeUnknownError(error: unknown, fallback: string): string {
	return extractError(error, fallback).message;
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
 *
 * `msgId` namespaces the per-part ids to match the Rust side's
 * `{msgId}:txt:N` / `{msgId}:mention:N` scheme so optimistic ids survive
 * the round-trip through the adapter without remounting.
 *
 * `files` and `images` are merged into a single needle pool. Both must
 * be passed in — paths with whitespace can only round-trip when matched
 * against a structured needle, never via regex.
 */
export function splitTextWithFiles(
	text: string,
	files: readonly string[],
	msgId: string,
	images: readonly string[] = [],
): MessagePart[] {
	const textId = (idx: number): string => `${msgId}:txt:${idx}`;
	const mentionId = (idx: number): string => `${msgId}:mention:${idx}`;
	const needles = [...files, ...images];
	if (needles.length === 0 || text.length === 0) {
		return [{ type: "text", id: textId(0), text }];
	}
	const sorted = [...needles].sort((a, b) => b.length - a.length);
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
	if (matches.length === 0) return [{ type: "text", id: textId(0), text }];
	matches.sort((a, b) => a.start - b.start);
	const parts: MessagePart[] = [];
	let cursor = 0;
	let textSeq = 0;
	let mentionSeq = 0;
	for (const m of matches) {
		if (cursor < m.start) {
			parts.push({
				type: "text",
				id: textId(textSeq++),
				text: text.slice(cursor, m.start),
			});
		}
		parts.push({
			type: "file-mention",
			id: mentionId(mentionSeq++),
			path: m.path,
		});
		cursor = m.end;
	}
	if (cursor < text.length) {
		parts.push({ type: "text", id: textId(textSeq), text: text.slice(cursor) });
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
	images = [],
}: {
	id: string;
	role: "user" | "assistant" | "system";
	text: string;
	createdAt: string;
	files?: readonly string[];
	images?: readonly string[];
}): ThreadMessageLike {
	return {
		role,
		id,
		createdAt,
		content: splitTextWithFiles(text, files, id, images),
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
