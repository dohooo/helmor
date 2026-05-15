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

export function workspaceStatusFromGroupId(
	groupId: string,
): WorkspaceStatus | null {
	switch (groupId) {
		case "done":
			return "done";
		case "review":
			return "review";
		case "progress":
			return "in-progress";
		case "backlog":
			return "backlog";
		case "canceled":
			return "canceled";
		default:
			return null;
	}
}

/**
 * Insert `row` into `rows` preserving the backend's sidebar order for
 * non-archived groups: `display_order ASC, created_at DESC`. Mirrors
 * `load_workspace_records` so optimistic inserts land in their final spot
 * and the refetch doesn't visibly reshuffle. Missing `displayOrder` is
 * treated as 0; missing `createdAt` as newest.
 */
export function insertRowBySidebarOrder(
	rows: WorkspaceRow[],
	row: WorkspaceRow,
): WorkspaceRow[] {
	const index = rows.findIndex(
		(existing) => compareSidebarOrder(existing, row) > 0,
	);
	if (index === -1) return [...rows, row];
	return [...rows.slice(0, index), row, ...rows.slice(index)];
}

/**
 * Move a workspace row from its current sidebar group to the group implied by
 * `nextStatus`. Preserves the row's existing fields (createdAt, pinnedAt, …)
 * and uses `insertRowBySidebarOrder` so the optimistic position matches the
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
			? { ...group, rows: insertRowBySidebarOrder(group.rows, updatedRow) }
			: group,
	);
}

const SIDEBAR_ORDER_STEP = 1024;

/**
 * Optimistic mirror of `move_repository_in_sidebar`. Rewrites each row's
 * `repoSidebarOrder` so `regroupByRepo` re-orders buckets immediately.
 *
 * `repoOrder` must match what the user visually sees — i.e. repos sorted
 * by `min(repoSidebarOrder)` ASC, same as `regroupByRepo` and the
 * backend. Walking `groups[].rows[]` directly would yield the workspace
 * display-order sequence instead, which causes a snap-on-refetch.
 */
export function applyRepoReorder(
	groups: WorkspaceGroup[] | undefined,
	movingRepoId: string,
	beforeRepoId: string | null,
): WorkspaceGroup[] | undefined {
	if (!groups) return groups;
	if (beforeRepoId === movingRepoId) return groups;

	const firstSeen = new Map<string, number>();
	const minRepoOrder = new Map<string, number>();
	let seen = 0;
	for (const group of groups) {
		for (const row of group.rows) {
			const id = row.repoId;
			if (!id) continue;
			if (!firstSeen.has(id)) firstSeen.set(id, seen++);
			const candidate = row.repoSidebarOrder ?? 0;
			if (candidate <= 0) continue;
			const current = minRepoOrder.get(id);
			if (current === undefined || candidate < current) {
				minRepoOrder.set(id, candidate);
			}
		}
	}
	if (!firstSeen.has(movingRepoId)) return groups;

	const repoOrder = Array.from(firstSeen.keys()).sort((a, b) => {
		const left = minRepoOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
		const right = minRepoOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
		if (left !== right) return left - right;
		return (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0);
	});

	const withoutMoving = repoOrder.filter((id) => id !== movingRepoId);
	const insertIndex =
		beforeRepoId === null
			? withoutMoving.length
			: withoutMoving.indexOf(beforeRepoId);
	if (beforeRepoId !== null && insertIndex === -1) return groups;
	const boundedInsertIndex =
		insertIndex === -1 ? withoutMoving.length : insertIndex;
	withoutMoving.splice(boundedInsertIndex, 0, movingRepoId);

	const nextOrderByRepo = new Map(
		withoutMoving.map((id, idx) => [id, (idx + 1) * SIDEBAR_ORDER_STEP]),
	);

	return groups.map((group) => ({
		...group,
		rows: group.rows.map((row) => {
			const nextOrder = row.repoId
				? nextOrderByRepo.get(row.repoId)
				: undefined;
			return nextOrder === undefined
				? row
				: { ...row, repoSidebarOrder: nextOrder };
		}),
	}));
}

/**
 * Optimistic mirror of `move_workspace_in_sidebar`. Targets:
 *   - `"pinned"` — sets `pinnedAt`, keeps status
 *   - status lane — clears `pinnedAt`, sets status
 *   - `"repo:<id>"` — clears `pinnedAt`, keeps status
 * Computes a midpoint `displayOrder` so the row lands correctly in
 * either grouping mode.
 */
export function reorderWorkspaceInSidebar(
	groups: WorkspaceGroup[] | undefined,
	workspaceId: string,
	targetGroupId: string,
	beforeWorkspaceId: string | null,
): WorkspaceGroup[] | undefined {
	if (!groups) return groups;

	let original: WorkspaceRow | null = null;
	const stripped = groups.map((group) => {
		const idx = group.rows.findIndex((row) => row.id === workspaceId);
		if (idx === -1) return group;
		original = group.rows[idx]!;
		return {
			...group,
			rows: group.rows.filter((_, i) => i !== idx),
		};
	});
	if (!original) return groups;
	const sourceRow: WorkspaceRow = original;

	const mutation = resolveTargetGroup(targetGroupId, sourceRow);
	if (!mutation) return groups;
	const updatedRow: WorkspaceRow = {
		...sourceRow,
		status: mutation.status ?? sourceRow.status,
		pinnedAt: mutation.pinnedAt,
	};

	const homeGroupId = workspaceGroupIdFromStatus(
		updatedRow.status,
		updatedRow.pinnedAt,
	);

	// Neighbour scope must match the backend — for a repo target that's
	// every row of the repo (cross-status), not just the row's own lane.
	const neighbours = collectNeighboursForTarget(
		targetGroupId,
		updatedRow,
		stripped,
	);
	const beforeIndex =
		beforeWorkspaceId === null
			? -1
			: neighbours.findIndex((row) => row.id === beforeWorkspaceId);

	updatedRow.displayOrder = pickInsertionOrder(neighbours, beforeIndex);

	// Insert back into the row's status group; `regroupByRepo` re-buckets
	// for the repo view using `displayOrder` as the sort key.
	return stripped.map((group) =>
		group.id === homeGroupId
			? {
					...group,
					rows: [...group.rows, updatedRow].sort(compareSidebarOrder),
				}
			: group,
	);
}

/** Mirrors the backend's three `MoveTarget` scopes. */
function collectNeighboursForTarget(
	targetGroupId: string,
	row: WorkspaceRow,
	groups: WorkspaceGroup[],
): WorkspaceRow[] {
	if (targetGroupId === "pinned") {
		const pinned = groups.find((g) => g.id === "pinned");
		return [...(pinned?.rows ?? [])].sort(compareSidebarOrder);
	}
	if (targetGroupId.startsWith("repo:")) {
		const repoId = targetGroupId.slice("repo:".length);
		return groups
			.flatMap((g) => g.rows)
			.filter(
				(r) => r.repoId === repoId && !r.pinnedAt && r.state !== "archived",
			)
			.sort(compareSidebarOrder);
	}
	const homeId = workspaceGroupIdFromStatus(row.status, row.pinnedAt);
	const homeGroup = groups.find((g) => g.id === homeId);
	return [...(homeGroup?.rows ?? [])].sort(compareSidebarOrder);
}

function pickInsertionOrder(
	sorted: WorkspaceRow[],
	beforeIndex: number,
): number {
	if (beforeIndex === -1) {
		const last = sorted[sorted.length - 1];
		return (last?.displayOrder ?? 0) + SIDEBAR_ORDER_STEP;
	}
	if (beforeIndex === 0) {
		const first = sorted[0];
		const firstOrder = first?.displayOrder ?? SIDEBAR_ORDER_STEP;
		return firstOrder > 1 ? Math.max(1, Math.floor(firstOrder / 2)) : 1;
	}
	const prev = sorted[beforeIndex - 1];
	const next = sorted[beforeIndex];
	const prevOrder = prev?.displayOrder ?? 0;
	const nextOrder = next?.displayOrder ?? prevOrder + SIDEBAR_ORDER_STEP;
	if (nextOrder - prevOrder >= 2) {
		return prevOrder + Math.floor((nextOrder - prevOrder) / 2);
	}
	// Gap exhausted — squeeze in; backend rebalances on commit.
	return prevOrder + 1;
}

function compareSidebarOrder(left: WorkspaceRow, right: WorkspaceRow) {
	const leftOrder = left.displayOrder ?? 0;
	const rightOrder = right.displayOrder ?? 0;
	if (leftOrder !== rightOrder) return leftOrder - rightOrder;
	const leftCreated = Date.parse(left.createdAt ?? "") || 0;
	const rightCreated = Date.parse(right.createdAt ?? "") || 0;
	return rightCreated - leftCreated;
}

type TargetMutation = {
	status: WorkspaceRow["status"] | null;
	pinnedAt: string | null;
};

function resolveTargetGroup(
	targetGroupId: string,
	row: WorkspaceRow,
): TargetMutation | null {
	if (targetGroupId === "pinned") {
		return {
			status: row.status ?? null,
			pinnedAt: row.pinnedAt ?? new Date().toISOString(),
		};
	}
	if (targetGroupId.startsWith("repo:")) {
		// A backlog row dragged into its repo bucket needs to leave the
		// backlog lane, otherwise it stays in the Backlog group regardless
		// of how we reorder its `displayOrder`. Promote to in-progress so
		// it surfaces in the bucket.
		const status =
			row.status === "backlog" ? "in-progress" : (row.status ?? null);
		return { status, pinnedAt: null };
	}
	const status = workspaceStatusFromGroupId(targetGroupId);
	if (!status) return null;
	return { status, pinnedAt: null };
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
		repoId: summary.repoId,
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
		displayOrder: summary.displayOrder,
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
	if (session.agentType === "cursor") {
		return "cursor";
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
		repoId: row.repoId ?? "",
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
		displayOrder: row.displayOrder,
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
