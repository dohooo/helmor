// Selection state machine for the workspace shell.
//
// Encapsulates the `selected` vs `displayed` two-track that AppShell used to
// expose directly. `selected*` is the user's most recent intent; `displayed*`
// is what's actually painted (waits for query cache to warm). Race-guards
// ensure rapid switches don't reorder.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	prewarmSlashCommandsForWorkspace,
	triggerWorkspaceFetch,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceRow,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import {
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
	workspaceDetailQueryOptions,
	workspaceSessionsQueryOptions,
} from "@/lib/query-client";
import type { AppSettings } from "@/lib/settings";
import {
	SESSION_SELECTION_HISTORY_MAX,
	WORKSPACE_WARMUP_INITIAL_DELAY_MS,
	WORKSPACE_WARMUP_MAX_COUNT,
	WORKSPACE_WARMUP_STEP_DELAY_MS,
} from "@/shell/constants";
import {
	useLatestRef,
	useStableActions,
} from "@/shell/hooks/use-stable-actions";
import {
	findAdjacentSessionId,
	findAdjacentWorkspaceId,
	flattenWorkspaceRows,
} from "@/shell/layout";

export type ShellViewMode = "conversation" | "editor" | "start";

export type SelectionState = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	viewMode: ShellViewMode;
	reselectTick: number;
};

export type SelectionSnapshot = {
	workspaceId: string | null;
	sessionId: string | null;
	viewMode: ShellViewMode;
};

export type SelectionActions = {
	selectWorkspace(id: string | null): void;
	selectSession(id: string | null): void;
	openStart(opts?: { persist?: boolean }): void;
	setViewMode(mode: ShellViewMode): void;
	navigateWorkspaces(offset: -1 | 1): void;
	navigateSessions(offset: -1 | 1): void;
	resolveDisplayedSession(id: string | null): void;
	rememberSessionSelection(
		workspaceId: string | null,
		sessionId: string | null,
	): void;
	getSessionSelectionHistory(workspaceId: string | null): readonly string[];
	getSnapshot(): SelectionSnapshot;
};

export type SelectionController = {
	state: SelectionState;
	actions: SelectionActions;
};

export type SelectionControllerDeps = {
	queryClient: QueryClient;
	workspaceGroups: WorkspaceGroup[];
	archivedRows: WorkspaceRow[];
	appSettings: AppSettings;
	areSettingsLoaded: boolean;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
	// Fires once after AppShell has rendered with a `selectedWorkspaceId`
	// from persisted settings but before `displayedWorkspaceId` is set,
	// so callers can run startup prefetch.
	onStartupPrefetch?: (workspaceId: string) => Promise<void>;
	// Fires when the user picks a new workspace (NOT on reselect). Use it
	// to clear cross-controller state like the right-sidebar preview.
	onWorkspaceSwitched?: () => void;
	// Fires when the user enters Start mode. Use it to reset start-surface
	// scratch state and align the right-sidebar mode.
	onStartOpened?: (opts: { persist: boolean }) => void;
};

export function useSelectionController(
	deps: SelectionControllerDeps,
): SelectionController {
	const {
		queryClient,
		workspaceGroups,
		archivedRows,
		appSettings,
		updateSettings,
	} = deps;

	// Callbacks held by ref so AppShell can pass inline arrows without
	// destabilising every downstream `useCallback`/`useMemo`.
	const onWorkspaceSwitchedRef = useLatestRef(deps.onWorkspaceSwitched);
	const onStartOpenedRef = useLatestRef(deps.onStartOpened);

	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
		null,
	);
	const [displayedWorkspaceId, setDisplayedWorkspaceId] = useState<
		string | null
	>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [displayedSessionId, setDisplayedSessionId] = useState<string | null>(
		null,
	);
	const [viewMode, setViewModeState] = useState<ShellViewMode>("conversation");
	const [reselectTick, setReselectTick] = useState(0);

	const selectedWorkspaceIdRef = useRef<string | null>(null);
	const selectedSessionIdRef = useRef<string | null>(null);
	const viewModeRef = useRef<ShellViewMode>("conversation");
	const workspaceSelectionRequestRef = useRef(0);
	const sessionSelectionRequestRef = useRef(0);
	const startupPrefetchedWorkspaceRef = useRef<string | null>(null);
	const warmedWorkspaceIdsRef = useRef<Set<string>>(new Set());
	const sessionSelectionHistoryByWorkspaceRef = useRef<
		Record<string, string[]>
	>({});

	useEffect(() => {
		selectedWorkspaceIdRef.current = selectedWorkspaceId;
	}, [selectedWorkspaceId]);

	useEffect(() => {
		selectedSessionIdRef.current = selectedSessionId;
	}, [selectedSessionId]);

	useEffect(() => {
		viewModeRef.current = viewMode;
	}, [viewMode]);

	// Persist last session for restore-on-launch. Last workspace is written
	// synchronously inside `selectWorkspace` so surface restore cannot race
	// it.
	useEffect(() => {
		if (selectedSessionId) {
			void updateSettings({ lastSessionId: selectedSessionId });
		}
	}, [selectedSessionId, updateSettings]);

	const primeWorkspaceDisplay = useCallback(
		async (workspaceId: string) => {
			const [workspaceDetail, workspaceSessions] = await Promise.all([
				queryClient.ensureQueryData(workspaceDetailQueryOptions(workspaceId)),
				queryClient.ensureQueryData(workspaceSessionsQueryOptions(workspaceId)),
			]);

			const resolvedSessionId =
				workspaceDetail?.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null;

			if (resolvedSessionId) {
				await queryClient.ensureQueryData(
					sessionThreadMessagesQueryOptions(resolvedSessionId),
				);
			}

			return {
				workspaceId,
				sessionId: resolvedSessionId,
			};
		},
		[queryClient],
	);

	const resolveCachedWorkspaceDisplay = useCallback(
		(workspaceId: string, preferredSessionId?: string | null) => {
			const workspaceDetail = queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);
			const workspaceSessions = queryClient.getQueryData<
				WorkspaceSessionSummary[] | undefined
			>(helmorQueryKeys.workspaceSessions(workspaceId));

			if (!workspaceDetail || !Array.isArray(workspaceSessions)) {
				return null;
			}

			const sessionId =
				preferredSessionId ??
				workspaceDetail.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null;
			const hasSessionMessages =
				sessionId === null ||
				queryClient.getQueryData([
					...helmorQueryKeys.sessionMessages(sessionId),
					"thread",
				]) !== undefined;

			if (!hasSessionMessages) {
				return null;
			}

			return { workspaceId, sessionId };
		},
		[queryClient],
	);

	const resolvePreferredSessionId = useCallback(
		(workspaceId: string) => {
			const sessionHistory =
				sessionSelectionHistoryByWorkspaceRef.current[workspaceId] ?? [];
			const workspaceDetail = queryClient.getQueryData<WorkspaceDetail | null>(
				helmorQueryKeys.workspaceDetail(workspaceId),
			);
			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[] | undefined>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];

			const sessionIds =
				workspaceSessions.length > 0
					? new Set(workspaceSessions.map((session) => session.id))
					: null;

			if (sessionIds) {
				for (let i = sessionHistory.length - 1; i >= 0; i -= 1) {
					const sessionId = sessionHistory[i];
					if (sessionIds.has(sessionId)) {
						return sessionId;
					}
				}
			}

			if (sessionHistory.length > 0) {
				return sessionHistory[sessionHistory.length - 1] ?? null;
			}

			if (
				appSettings.lastSessionId &&
				(!sessionIds || sessionIds.has(appSettings.lastSessionId))
			) {
				return appSettings.lastSessionId;
			}

			return (
				workspaceDetail?.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null
			);
		},
		[queryClient, appSettings.lastSessionId],
	);

	const rememberSessionSelection = useCallback(
		(workspaceId: string | null, sessionId: string | null) => {
			if (!workspaceId || !sessionId) return;
			const current =
				sessionSelectionHistoryByWorkspaceRef.current[workspaceId] ?? [];
			const next = [...current.filter((id) => id !== sessionId), sessionId];
			sessionSelectionHistoryByWorkspaceRef.current[workspaceId] = next.slice(
				-SESSION_SELECTION_HISTORY_MAX,
			);
		},
		[],
	);

	const getSessionSelectionHistory = useCallback(
		(workspaceId: string | null): readonly string[] => {
			if (!workspaceId) return [];
			return sessionSelectionHistoryByWorkspaceRef.current[workspaceId] ?? [];
		},
		[],
	);

	// Startup prefetch when AppShell already has a `selectedWorkspaceId` from
	// settings but `displayedWorkspaceId` is still null.
	useEffect(() => {
		if (!selectedWorkspaceId || displayedWorkspaceId !== null) return;
		if (startupPrefetchedWorkspaceRef.current === selectedWorkspaceId) return;
		startupPrefetchedWorkspaceRef.current = selectedWorkspaceId;
		void primeWorkspaceDisplay(selectedWorkspaceId).catch(() => {
			// Best-effort — first paint stays resilient even if prewarm fails.
		});
	}, [displayedWorkspaceId, primeWorkspaceDisplay, selectedWorkspaceId]);

	// Background warmup for the next few workspaces in the sidebar order.
	useEffect(() => {
		const candidateWorkspaceIds = flattenWorkspaceRows(
			workspaceGroups,
			archivedRows,
		)
			.map((row) => row.id)
			.filter((workspaceId) => workspaceId !== selectedWorkspaceId)
			.slice(0, WORKSPACE_WARMUP_MAX_COUNT);

		if (candidateWorkspaceIds.length === 0) return;

		let cancelled = false;
		let timeoutId: number | null = null;

		const warmNext = async (index: number) => {
			if (cancelled || index >= candidateWorkspaceIds.length) return;
			const workspaceId = candidateWorkspaceIds[index];
			if (!workspaceId || warmedWorkspaceIdsRef.current.has(workspaceId)) {
				void warmNext(index + 1);
				return;
			}
			warmedWorkspaceIdsRef.current.add(workspaceId);
			try {
				await primeWorkspaceDisplay(workspaceId);
			} catch {
				// Best-effort background warmup only.
			}
			if (!cancelled) {
				timeoutId = window.setTimeout(
					() => void warmNext(index + 1),
					WORKSPACE_WARMUP_STEP_DELAY_MS,
				);
			}
		};

		timeoutId = window.setTimeout(
			() => void warmNext(0),
			WORKSPACE_WARMUP_INITIAL_DELAY_MS,
		);

		return () => {
			cancelled = true;
			if (timeoutId !== null) window.clearTimeout(timeoutId);
		};
	}, [
		archivedRows,
		primeWorkspaceDisplay,
		selectedWorkspaceId,
		workspaceGroups,
	]);

	const selectWorkspace = useCallback<SelectionActions["selectWorkspace"]>(
		(workspaceId) => {
			if (workspaceId) {
				void updateSettings({
					lastSurface: "workspace",
					lastWorkspaceId: workspaceId,
				});
			}
			if (viewModeRef.current === "start") {
				setViewModeState("conversation");
			}

			if (workspaceId === selectedWorkspaceIdRef.current) {
				// Re-clicking the same workspace bumps the tick so downstream
				// effects (mark-read) re-evaluate even though the displayed
				// session didn't change.
				if (workspaceId !== null) {
					setReselectTick((tick) => tick + 1);
				}
				return;
			}

			onWorkspaceSwitchedRef.current?.();

			const requestId = workspaceSelectionRequestRef.current + 1;
			workspaceSelectionRequestRef.current = requestId;
			sessionSelectionRequestRef.current += 1;
			selectedWorkspaceIdRef.current = workspaceId;
			const immediateSessionId = workspaceId
				? resolvePreferredSessionId(workspaceId)
				: null;
			selectedSessionIdRef.current = immediateSessionId;
			setSelectedWorkspaceId(workspaceId);
			setSelectedSessionId(immediateSessionId);

			if (workspaceId) {
				// Skip git fetch while the worktree is still initializing.
				const cachedDetail = queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				);
				if (cachedDetail?.state !== "initializing") {
					triggerWorkspaceFetch(workspaceId);
					void prewarmSlashCommandsForWorkspace(workspaceId);
				}
			}

			if (workspaceId === null) {
				if (workspaceSelectionRequestRef.current !== requestId) return;
				setDisplayedWorkspaceId(null);
				setDisplayedSessionId(null);
				return;
			}

			setDisplayedWorkspaceId(workspaceId);
			setDisplayedSessionId(immediateSessionId);

			const cached = resolveCachedWorkspaceDisplay(
				workspaceId,
				immediateSessionId,
			);
			if (cached) {
				selectedSessionIdRef.current = cached.sessionId;
				rememberSessionSelection(workspaceId, cached.sessionId);
				setSelectedSessionId(cached.sessionId);
				if (workspaceSelectionRequestRef.current !== requestId) return;
				setDisplayedWorkspaceId(cached.workspaceId);
				setDisplayedSessionId(cached.sessionId);
				void queryClient.prefetchQuery(
					workspaceDetailQueryOptions(workspaceId),
				);
				void queryClient.prefetchQuery(
					workspaceSessionsQueryOptions(workspaceId),
				);
				if (cached.sessionId) {
					void queryClient.prefetchQuery(
						sessionThreadMessagesQueryOptions(cached.sessionId),
					);
				}
				return;
			}

			void primeWorkspaceDisplay(workspaceId)
				.then(({ sessionId }) => {
					if (workspaceSelectionRequestRef.current !== requestId) return;
					selectedSessionIdRef.current = sessionId;
					rememberSessionSelection(workspaceId, sessionId);
					setSelectedSessionId(sessionId);
					setDisplayedWorkspaceId(workspaceId);
					setDisplayedSessionId(sessionId);
				})
				.catch(() => {
					if (workspaceSelectionRequestRef.current !== requestId) return;
					setDisplayedWorkspaceId(workspaceId);
					setDisplayedSessionId(null);
				});
		},
		[
			primeWorkspaceDisplay,
			queryClient,
			rememberSessionSelection,
			resolveCachedWorkspaceDisplay,
			resolvePreferredSessionId,
			updateSettings,
		],
	);

	const selectSession = useCallback(
		(sessionId: string | null) => {
			if (sessionId === selectedSessionIdRef.current) return;

			const requestId = sessionSelectionRequestRef.current + 1;
			sessionSelectionRequestRef.current = requestId;
			rememberSessionSelection(selectedWorkspaceIdRef.current, sessionId);
			selectedSessionIdRef.current = sessionId;
			setSelectedSessionId(sessionId);

			if (sessionId === null) {
				if (sessionSelectionRequestRef.current !== requestId) return;
				setDisplayedSessionId(null);
				return;
			}

			if (
				queryClient.getQueryData([
					...helmorQueryKeys.sessionMessages(sessionId),
					"thread",
				]) !== undefined
			) {
				if (sessionSelectionRequestRef.current !== requestId) return;
				setDisplayedSessionId(sessionId);
				void queryClient.prefetchQuery(
					sessionThreadMessagesQueryOptions(sessionId),
				);
				return;
			}

			void queryClient
				.ensureQueryData(sessionThreadMessagesQueryOptions(sessionId))
				.then(() => {
					if (sessionSelectionRequestRef.current !== requestId) return;
					setDisplayedSessionId(sessionId);
				})
				.catch(() => {
					if (sessionSelectionRequestRef.current !== requestId) return;
					setDisplayedSessionId(sessionId);
				});
		},
		[queryClient, rememberSessionSelection],
	);

	const openStart = useCallback(
		(options?: { persist?: boolean }) => {
			workspaceSelectionRequestRef.current += 1;
			sessionSelectionRequestRef.current += 1;
			selectedWorkspaceIdRef.current = null;
			selectedSessionIdRef.current = null;
			setSelectedWorkspaceId(null);
			setSelectedSessionId(null);
			setDisplayedWorkspaceId(null);
			setDisplayedSessionId(null);
			setViewModeState("start");

			const persist = options?.persist !== false;
			onStartOpenedRef.current?.({ persist });

			if (persist) {
				void updateSettings({ lastSurface: "workspace-start" });
			}
		},
		[updateSettings],
	);

	const setViewMode = useCallback((mode: ShellViewMode) => {
		setViewModeState(mode);
	}, []);

	const navigateWorkspaces = useCallback(
		(offset: -1 | 1) => {
			const nextWorkspaceId = findAdjacentWorkspaceId(
				workspaceGroups,
				archivedRows,
				selectedWorkspaceIdRef.current,
				offset,
			);
			if (!nextWorkspaceId) return;
			selectWorkspace(nextWorkspaceId);
		},
		[archivedRows, selectWorkspace, workspaceGroups],
	);

	const navigateSessions = useCallback(
		(offset: -1 | 1) => {
			const workspaceId = selectedWorkspaceIdRef.current;
			if (!workspaceId) return;
			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];
			const nextSessionId = findAdjacentSessionId(
				workspaceSessions,
				selectedSessionIdRef.current,
				offset,
			);
			if (!nextSessionId) return;
			selectSession(nextSessionId);
		},
		[queryClient, selectSession],
	);

	const resolveDisplayedSession = useCallback(
		(sessionId: string | null) => {
			rememberSessionSelection(selectedWorkspaceIdRef.current, sessionId);
			selectedSessionIdRef.current = sessionId;
			setSelectedSessionId((current) =>
				current === sessionId ? current : sessionId,
			);
			setDisplayedSessionId((current) =>
				current === sessionId ? current : sessionId,
			);
		},
		[rememberSessionSelection],
	);

	const getSnapshot = useCallback(
		(): SelectionSnapshot => ({
			workspaceId: selectedWorkspaceIdRef.current,
			sessionId: selectedSessionIdRef.current,
			viewMode: viewModeRef.current,
		}),
		[],
	);

	// Stabilise the `actions` reference so downstream `useCallback`/`useMemo`
	// hooks that close over it don't re-create on every controller render.
	const actions = useStableActions<SelectionActions>({
		selectWorkspace,
		selectSession,
		openStart,
		setViewMode,
		navigateWorkspaces,
		navigateSessions,
		resolveDisplayedSession,
		rememberSessionSelection,
		getSessionSelectionHistory,
		getSnapshot,
	});

	const state = useMemo<SelectionState>(
		() => ({
			selectedWorkspaceId,
			displayedWorkspaceId,
			selectedSessionId,
			displayedSessionId,
			viewMode,
			reselectTick,
		}),
		[
			selectedWorkspaceId,
			displayedWorkspaceId,
			selectedSessionId,
			displayedSessionId,
			viewMode,
			reselectTick,
		],
	);

	return { state, actions };
}
