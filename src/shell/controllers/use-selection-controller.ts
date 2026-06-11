// Selection state machine for the workspace shell.
//
// Stage 3b: the ROUTER is the single source of truth for navigation INTENT
// (`viewMode`, `selectedWorkspaceId`, `selectedSessionId`). The actions set
// that intent through `router.navigate` (memory history; the location commits
// synchronously, so a read of `router.state.location` right after a navigate is
// correct). This controller still OWNS the `displayed*` two-track — what's
// actually painted, which waits for the query cache to warm — plus
// `reselectTick`, the request-id race guards, the warmup/prefetch effects, and
// the session-selection history. `selected*` is read back from the router via
// `getSnapshot()` (synchronous) and `useRouterSelectedWorkspaceId()` (reactive,
// for the prewarm/warmup effects).
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
import { isQuickPanelWindow } from "@/lib/window-role";
import { router } from "@/router";
import { locationToSelection } from "@/router/location-mapping";
import {
	installLocationPersistence,
	navigateSelection,
	suppressNextStartPersist,
} from "@/router/navigate-selection";
import { useRouterSelectedWorkspaceId } from "@/router/use-router-selection";
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

// Trailing window before the per-switch fire-and-forget IPC (git fetch +
// slash-command prewarm) runs. Matches the inspector settle window so a held
// burst coalesces these to the settled workspace; a single switch fires after
// one frame or two (imperceptible for background work).
const WORKSPACE_SWITCH_SIDE_EFFECT_DELAY_MS = 140;

// The store now holds ONLY the paint track + the reselect signal. `selected*`
// and `viewMode` were retired in Stage 3b — they live in the router.
export type SelectionState = {
	displayedWorkspaceId: string | null;
	displayedSessionId: string | null;
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
	displayedWorkspaceId: null,
	displayedSessionId: null,
	reselectTick: 0,
};

// Read the authoritative selection intent off the router synchronously.
// `router.state.location` reflects the latest committed navigation immediately
// (memory history commits the location inside the navigate call), so this is
// the synchronous "latest intent" the actions / `getSnapshot` rely on.
function getRouterSelection(): SelectionSnapshot {
	const loc = router.state.location;
	return locationToSelection({
		pathname: loc.pathname,
		search: loc.search as { view?: string },
	});
}

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
	const { queryClient, workspaceGroups, archivedRows, updateSettings } = deps;

	// Callbacks held by ref so AppShell can pass inline arrows without
	// destabilising every downstream `useCallback`/`useMemo`.
	const onWorkspaceSwitchedRef = useLatestRef(deps.onWorkspaceSwitched);
	const onStartOpenedRef = useLatestRef(deps.onStartOpened);
	const updateSettingsRef = useLatestRef(updateSettings);

	// Instance-level store (lazy-init via ref, one per controller — NOT a
	// global singleton; deps like queryClient/callbacks are closed over by
	// the actions below, so a module store can't hold them). The three fields
	// here are the paint track (`displayed*`) plus `reselectTick`; the
	// `selected*` intent moved to the router (Stage 3b).
	const storeRef = useRef<SelectionStore | null>(null);
	if (storeRef.current === null) {
		storeRef.current = createStore<SelectionState>(() => ({
			...INITIAL_SELECTION_STATE,
		}));
	}
	const store = storeRef.current;

	const workspaceSelectionRequestRef = useRef(0);
	const sessionSelectionRequestRef = useRef(0);
	// Trailing-edge timer for the per-switch fire-and-forget IPC (git fetch +
	// slash-command prewarm). During a held-key burst each keypress resets it, so
	// the IPC only fires for the workspace the user lands on. A single switch has
	// no follow-up keypress, so it fires after one short window (~a frame or two)
	// — imperceptible for background work. Cleaned up on unmount.
	const workspaceSwitchSideEffectTimerRef = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (workspaceSwitchSideEffectTimerRef.current !== null) {
				window.clearTimeout(workspaceSwitchSideEffectTimerRef.current);
			}
		},
		[],
	);
	const startupPrefetchedWorkspaceRef = useRef<string | null>(null);
	const warmedWorkspaceIdsRef = useRef<Set<string>>(new Set());
	const sessionSelectionHistoryByWorkspaceRef = useRef<
		Record<string, string[]>
	>({});

	// Single persistence writer: subscribe to the router's `onResolved` and
	// write the SAME settings keys the scattered effects used to
	// (`lastSurface` / `lastWorkspaceId` / `lastSessionId`). Replaces the
	// synchronous write in `selectWorkspace`, the `selectedSessionId` effect,
	// and the `openStart` persist write. Always reads the latest
	// `updateSettings` through the ref so the subscription can mount once.
	useEffect(() => {
		// Only the main window persists its location. The quick panel navigates
		// its own router (start → fresh workspace) and must not clobber the
		// `lastSurface` / `lastWorkspaceId` the main window restores at boot.
		if (isQuickPanelWindow) return;
		return installLocationPersistence((patch) => {
			void updateSettingsRef.current(patch);
		});
	}, [updateSettingsRef]);

	// Reactive selected workspace for the effects below (prewarm / warmup /
	// startup prefetch). Sourced from the router — same re-run cadence as the
	// old store subscription, only the source of truth moved. `displayed*`
	// stays in the store.
	const selectedWorkspaceId = useRouterSelectedWorkspaceId();
	const displayedWorkspaceId = useStore(store, (s) => s.displayedWorkspaceId);

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
				deps.appSettings.lastSessionId &&
				(!sessionIds || sessionIds.has(deps.appSettings.lastSessionId))
			) {
				return deps.appSettings.lastSessionId;
			}

			return (
				workspaceDetail?.activeSessionId ??
				workspaceSessions.find((session) => session.active)?.id ??
				workspaceSessions[0]?.id ??
				null
			);
		},
		[queryClient, deps.appSettings.lastSessionId],
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
			const current = getRouterSelection();

			if (workspaceId === current.workspaceId) {
				// Re-clicking the same workspace bumps the tick so downstream
				// effects (mark-read) re-evaluate even though the displayed
				// session didn't change. The router navigate would be a no-op
				// (same location), so the tick stays an out-of-band store signal.
				if (workspaceId !== null) {
					store.setState({ reselectTick: store.getState().reselectTick + 1 });
				}
				return;
			}

			onWorkspaceSwitchedRef.current?.();

			const requestId = workspaceSelectionRequestRef.current + 1;
			workspaceSelectionRequestRef.current = requestId;
			sessionSelectionRequestRef.current += 1;
			const immediateSessionId = workspaceId
				? resolvePreferredSessionId(workspaceId)
				: null;

			// Set the navigation intent (the router is authoritative). Preserve the
			// current view EXCEPT when leaving the start surface, matching the legacy
			// behavior: the old code only reset `viewMode` to "conversation" when it
			// was "start", so switching workspaces while in the editor stayed in the
			// editor instead of being forced back to conversation.
			const nextViewMode =
				current.viewMode === "start" ? "conversation" : current.viewMode;
			navigateSelection({
				viewMode: nextViewMode,
				workspaceId,
				sessionId: immediateSessionId,
			});

			if (workspaceId) {
				// Defer the per-switch fire-and-forget IPC to a trailing edge so a
				// held-key burst doesn't fire a git fetch + slash-command prewarm for
				// every workspace scrubbed past — only the settled one. Re-read the
				// cached detail at fire time so the `initializing` skip stays accurate.
				if (workspaceSwitchSideEffectTimerRef.current !== null) {
					window.clearTimeout(workspaceSwitchSideEffectTimerRef.current);
				}
				const settleRequestId = requestId;
				workspaceSwitchSideEffectTimerRef.current = window.setTimeout(() => {
					workspaceSwitchSideEffectTimerRef.current = null;
					// Bail if a newer switch superseded this one (race guard parity).
					if (workspaceSelectionRequestRef.current !== settleRequestId) return;
					// Skip git fetch while the worktree is still initializing.
					const cachedDetail = queryClient.getQueryData<WorkspaceDetail | null>(
						helmorQueryKeys.workspaceDetail(workspaceId),
					);
					if (cachedDetail?.state !== "initializing") {
						triggerWorkspaceFetch(workspaceId);
						void prewarmSlashCommandsForWorkspace(workspaceId);
					}
				}, WORKSPACE_SWITCH_SIDE_EFFECT_DELAY_MS);
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
				rememberSessionSelection(workspaceId, cached.sessionId);
				// Refine the URL's session segment if the cache resolved a
				// different session than the immediate guess.
				if (cached.sessionId !== immediateSessionId) {
					navigateSelection({
						viewMode: nextViewMode,
						workspaceId,
						sessionId: cached.sessionId,
					});
				}
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
					rememberSessionSelection(workspaceId, sessionId);
					if (sessionId !== immediateSessionId) {
						navigateSelection({
							viewMode: nextViewMode,
							workspaceId,
							sessionId,
						});
					}
					store.setState({
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
		],
	);

	const selectSession = useCallback(
		(sessionId: string | null) => {
			const current = getRouterSelection();
			if (sessionId === current.sessionId) return;

			const requestId = sessionSelectionRequestRef.current + 1;
			sessionSelectionRequestRef.current = requestId;
			rememberSessionSelection(current.workspaceId, sessionId);

			// Set the navigation intent. Keep the current workspace + view mode;
			// only the session segment changes. (A session is never selected
			// without a workspace, so `current.workspaceId` is non-null here in
			// practice; if it were null `selectionToLocation` collapses to `/`.)
			navigateSelection({
				viewMode:
					current.viewMode === "start" ? "conversation" : current.viewMode,
				workspaceId: current.workspaceId,
				sessionId,
			});

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

			const persist = options?.persist !== false;
			// `persist: false` must NOT re-write `lastSurface` — arm the one-shot
			// suppression BEFORE navigating so the `onResolved` writer skips the
			// `/start` resolve.
			if (!persist) {
				suppressNextStartPersist();
			}
			navigateSelection({
				viewMode: "start",
				workspaceId: null,
				sessionId: null,
			});
			store.setState({
				displayedWorkspaceId: null,
				displayedSessionId: null,
			});

			onStartOpenedRef.current?.({ persist });
		},
		[store],
	);

	const setViewMode = useCallback((mode: ShellViewMode) => {
		// View-mode toggles (conversation ↔ editor) keep the current
		// workspace/session and only flip the `?view` search param. `start` is
		// owned by `openStart`; a `setViewMode("start")` would fall through to
		// `selectionToLocation`, which maps start → `/start`.
		const current = getRouterSelection();
		navigateSelection({
			viewMode: mode,
			workspaceId: current.workspaceId,
			sessionId: current.sessionId,
		});
	}, []);

	const navigateWorkspaces = useCallback(
		(offset: -1 | 1) => {
			const nextWorkspaceId = findAdjacentWorkspaceId(
				workspaceGroups,
				archivedRows,
				getRouterSelection().workspaceId,
				offset,
			);
			if (!nextWorkspaceId) return;
			selectWorkspace(nextWorkspaceId);
		},
		[archivedRows, selectWorkspace, workspaceGroups],
	);

	const navigateSessions = useCallback(
		(offset: -1 | 1) => {
			const workspaceId = getRouterSelection().workspaceId;
			if (!workspaceId) return;
			const workspaceSessions =
				queryClient.getQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
				) ?? [];
			const nextSessionId = findAdjacentSessionId(
				workspaceSessions,
				getRouterSelection().sessionId,
				offset,
			);
			if (!nextSessionId) return;
			selectSession(nextSessionId);
		},
		[queryClient, selectSession],
	);

	const resolveDisplayedSession = useCallback(
		(sessionId: string | null) => {
			// PAINT-track only. The panel calls this when it resolves which session
			// is actually displayable (e.g. the selected one vanished after a
			// close, so it falls back to the workspace's active session). This must
			// NOT rewrite the URL — the URL is the user's SELECTED intent, owned by
			// the explicit `selectSession`/`selectWorkspace` navigations. (Pre-3b
			// `selected*` + `displayed*` were both store fields and this synced
			// them; now `selected` is the router, so we only advance `displayed`.)
			rememberSessionSelection(getRouterSelection().workspaceId, sessionId);
			const snap = store.getState();
			if (snap.displayedSessionId !== sessionId) {
				store.setState({ displayedSessionId: sessionId });
			}
		},
		[rememberSessionSelection, store],
	);

	const getSnapshot = useCallback(
		(): SelectionSnapshot => getRouterSelection(),
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

	// Synthesise the `state` object from the store. The store merges on every
	// `setState`, so the snapshot reference changes exactly when a field
	// changes — same identity cadence as before, so `state.X` reads stay
	// compatible for the `displayed*` / `reselectTick` track.
	const state = useStore(store, (s) => s);

	return { state, actions, store };
}
