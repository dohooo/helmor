// Selection state machine for the workspace shell.
//
// Encapsulates the `selected` vs `displayed` two-track that AppShell used to
// expose directly. `selected*` is the user's most recent intent; `displayed*`
// is what's actually painted (waits for query cache to warm). Race-guards
// ensure rapid switches don't reorder.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
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

export type SelectionStore = StoreApi<SelectionState>;

export type SelectionController = {
	state: SelectionState;
	actions: SelectionActions;
	store: SelectionStore;
};

const INITIAL_SELECTION_STATE: SelectionState = {
	selectedWorkspaceId: null,
	displayedWorkspaceId: null,
	selectedSessionId: null,
	displayedSessionId: null,
	viewMode: "conversation",
	reselectTick: 0,
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

	// Instance-level store (lazy-init via ref, one per controller — NOT a
	// global singleton; deps like queryClient/callbacks are closed over by
	// the actions below, so a module store can't hold them). The six fields
	// live here so panes can subscribe to individual selectors; the
	// `selected*` and `displayed*` tracks plus `viewMode`/`reselectTick`
	// remain a single atomic store written in lockstep by the actions.
	const storeRef = useRef<SelectionStore | null>(null);
	if (storeRef.current === null) {
		storeRef.current = createStore<SelectionState>(() => ({
			...INITIAL_SELECTION_STATE,
		}));
	}
	const store = storeRef.current;

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

	// Reactive reads for the effects below. These mirror what the deleted
	// useState values drove: the persist effect (selectedSessionId) and the
	// prewarm/warmup effects (selectedWorkspaceId + displayedWorkspaceId).
	// Subscribing keeps each effect's re-run cadence identical to the old
	// state-driven version — only the source of truth moved into the store.
	const selectedWorkspaceId = useStore(store, (s) => s.selectedWorkspaceId);
	const displayedWorkspaceId = useStore(store, (s) => s.displayedWorkspaceId);
	const selectedSessionId = useStore(store, (s) => s.selectedSessionId);

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
				viewModeRef.current = "conversation";
				store.setState({ viewMode: "conversation" });
			}

			if (workspaceId === selectedWorkspaceIdRef.current) {
				// Re-clicking the same workspace bumps the tick so downstream
				// effects (mark-read) re-evaluate even though the displayed
				// session didn't change.
				if (workspaceId !== null) {
					store.setState({ reselectTick: store.getState().reselectTick + 1 });
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
			store.setState({
				selectedWorkspaceId: workspaceId,
				selectedSessionId: immediateSessionId,
			});

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
				store.setState({
					displayedWorkspaceId: null,
					displayedSessionId: null,
				});
				return;
			}

			store.setState({
				displayedWorkspaceId: workspaceId,
				displayedSessionId: immediateSessionId,
			});

			const cached = resolveCachedWorkspaceDisplay(
				workspaceId,
				immediateSessionId,
			);
			if (cached) {
				selectedSessionIdRef.current = cached.sessionId;
				rememberSessionSelection(workspaceId, cached.sessionId);
				store.setState({ selectedSessionId: cached.sessionId });
				if (workspaceSelectionRequestRef.current !== requestId) return;
				store.setState({
					displayedWorkspaceId: cached.workspaceId,
					displayedSessionId: cached.sessionId,
				});
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
					store.setState({
						selectedSessionId: sessionId,
						displayedWorkspaceId: workspaceId,
						displayedSessionId: sessionId,
					});
				})
				.catch(() => {
					if (workspaceSelectionRequestRef.current !== requestId) return;
					store.setState({
						displayedWorkspaceId: workspaceId,
						displayedSessionId: null,
					});
				});
		},
		[
			primeWorkspaceDisplay,
			queryClient,
			rememberSessionSelection,
			resolveCachedWorkspaceDisplay,
			resolvePreferredSessionId,
			store,
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
			store.setState({ selectedSessionId: sessionId });

			if (sessionId === null) {
				if (sessionSelectionRequestRef.current !== requestId) return;
				store.setState({ displayedSessionId: null });
				return;
			}

			if (
				queryClient.getQueryData([
					...helmorQueryKeys.sessionMessages(sessionId),
					"thread",
				]) !== undefined
			) {
				if (sessionSelectionRequestRef.current !== requestId) return;
				store.setState({ displayedSessionId: sessionId });
				void queryClient.prefetchQuery(
					sessionThreadMessagesQueryOptions(sessionId),
				);
				return;
			}

			void queryClient
				.ensureQueryData(sessionThreadMessagesQueryOptions(sessionId))
				.then(() => {
					if (sessionSelectionRequestRef.current !== requestId) return;
					store.setState({ displayedSessionId: sessionId });
				})
				.catch(() => {
					if (sessionSelectionRequestRef.current !== requestId) return;
					store.setState({ displayedSessionId: sessionId });
				});
		},
		[queryClient, rememberSessionSelection, store],
	);

	const openStart = useCallback(
		(options?: { persist?: boolean }) => {
			workspaceSelectionRequestRef.current += 1;
			sessionSelectionRequestRef.current += 1;
			selectedWorkspaceIdRef.current = null;
			selectedSessionIdRef.current = null;
			viewModeRef.current = "start";
			store.setState({
				selectedWorkspaceId: null,
				selectedSessionId: null,
				displayedWorkspaceId: null,
				displayedSessionId: null,
				viewMode: "start",
			});

			const persist = options?.persist !== false;
			onStartOpenedRef.current?.({ persist });

			if (persist) {
				void updateSettings({ lastSurface: "workspace-start" });
			}
		},
		[store, updateSettings],
	);

	const setViewMode = useCallback(
		(mode: ShellViewMode) => {
			viewModeRef.current = mode;
			store.setState({ viewMode: mode });
		},
		[store],
	);

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
			const snap = store.getState();
			const nextSelected =
				snap.selectedSessionId === sessionId
					? snap.selectedSessionId
					: sessionId;
			const nextDisplayed =
				snap.displayedSessionId === sessionId
					? snap.displayedSessionId
					: sessionId;
			if (
				nextSelected !== snap.selectedSessionId ||
				nextDisplayed !== snap.displayedSessionId
			) {
				store.setState({
					selectedSessionId: nextSelected,
					displayedSessionId: nextDisplayed,
				});
			}
		},
		[rememberSessionSelection, store],
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

	// Synthesise the legacy `state` object from the store. The store merges
	// on every `setState`, so the snapshot reference changes exactly when a
	// field changes — same identity cadence as the old `useMemo`-over-6-fields
	// version, so `state.X` reads stay byte-for-byte compatible.
	const state = useStore(store, (s) => s);

	return { state, actions, store };
}
