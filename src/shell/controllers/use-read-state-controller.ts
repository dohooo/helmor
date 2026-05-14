// Read-state controller: owns the "settled / aborted / interaction-required"
// session sets, the mark-session-read effect, and the recently-closed
// session ring buffer for "reopen closed session". OS notifications for
// completed sessions and interaction prompts live here too.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	markSessionRead,
	markSessionUnread,
	unhideSession,
	type WorkspaceDetail,
	type WorkspaceGroup,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import {
	recomputeWorkspaceDetailUnread,
	recomputeWorkspaceUnreadInGroups,
} from "@/lib/workspace-helpers";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { RECENTLY_CLOSED_SESSIONS_MAX } from "@/shell/constants";
import {
	useLatestRef,
	useStableActions,
} from "@/shell/hooks/use-stable-actions";

type NotifyFn = (opts: { title: string; body: string }) => void;

export type ReadStateState = {
	settledSessionIds: Set<string>;
	abortedSessionIds: Set<string>;
	interactionRequiredSessionIds: Set<string>;
	interactionRequiredWorkspaceIds: Set<string>;
};

export type ReadStateActions = {
	onSessionCompleted(sessionId: string, workspaceId: string): void;
	onSessionAborted(sessionId: string): void;
	onInteractionSessionsChange(
		nextMap: Map<string, string>,
		counts: Map<string, number>,
	): void;
	onSessionHidden(sessionId: string, workspaceId: string): void;
	reopenClosedSession(): Promise<void>;
};

export type ReadStateController = {
	state: ReadStateState;
	actions: ReadStateActions;
};

export type ReadStateControllerDeps = {
	queryClient: QueryClient;
	notify: NotifyFn;
	pushToast: PushWorkspaceToast;
	// Selection observers — the mark-read effect needs the displayed session
	// + the reselect tick to know when to re-fire. `getSelectedWorkspaceId`
	// gives the matching workspace at IPC time (without forcing the caller
	// to thread it through props on every render).
	displayedSessionId: string | null;
	reselectTick: number;
	getSelectedWorkspaceId(): string | null;
	getSelectedSessionId(): string | null;
	// `reopenClosedSession` reuses the user-facing select handlers so the
	// right-sidebar mode + preview state reset alongside the selection.
	onReopenSelectWorkspace(workspaceId: string): void;
	onReopenSelectSession(sessionId: string): void;
};

export function useReadStateController(
	deps: ReadStateControllerDeps,
): ReadStateController {
	const {
		queryClient,
		notify,
		pushToast,
		displayedSessionId,
		reselectTick,
		getSelectedWorkspaceId,
		getSelectedSessionId,
		onReopenSelectWorkspace,
		onReopenSelectSession,
	} = deps;

	const [settledSessionIds, setSettledSessionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [abortedSessionIds, setAbortedSessionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [interactionRequiredSessions, setInteractionRequiredSessions] =
		useState<Map<string, string>>(() => new Map());

	const interactionRequiredSessionIds = useMemo(
		() => new Set(interactionRequiredSessions.keys()),
		[interactionRequiredSessions],
	);
	const interactionRequiredWorkspaceIds = useMemo(
		() => new Set(interactionRequiredSessions.values()),
		[interactionRequiredSessions],
	);

	// Dedupe key for the mark-read effect. `…ReselectTickRef` makes sure a
	// "manual unread → re-click same workspace" cycle re-fires the IPC even
	// though the displayed session didn't change.
	const lastMarkedReadSessionIdRef = useRef<string | null>(null);
	const lastMarkedReadReselectTickRef = useRef(0);
	const lastInteractionCountsRef = useRef<Map<string, number>>(new Map());
	const recentlyClosedSessionsRef = useRef<
		{ sessionId: string; workspaceId: string }[]
	>([]);

	// Keep latest callbacks accessible inside effects without forcing them
	// into the dep array (callers often pass inline arrows).
	const onReopenSelectWorkspaceRef = useLatestRef(onReopenSelectWorkspace);
	const onReopenSelectSessionRef = useLatestRef(onReopenSelectSession);
	const getSelectedWorkspaceIdRef = useLatestRef(getSelectedWorkspaceId);
	const getSelectedSessionIdRef = useLatestRef(getSelectedSessionId);
	const notifyRef = useLatestRef(notify);
	const pushToastRef = useLatestRef(pushToast);

	useEffect(() => {
		if (!displayedSessionId) {
			lastMarkedReadSessionIdRef.current = null;
			return;
		}
		if (interactionRequiredSessionIds.has(displayedSessionId)) {
			// Reset the dedupe key so once the interaction completes the next
			// effect run will fire the IPC.
			lastMarkedReadSessionIdRef.current = null;
			return;
		}
		if (
			lastMarkedReadSessionIdRef.current === displayedSessionId &&
			reselectTick === lastMarkedReadReselectTickRef.current
		) {
			return;
		}

		const sessionId = displayedSessionId;
		const workspaceId = getSelectedWorkspaceIdRef.current();
		lastMarkedReadSessionIdRef.current = sessionId;
		lastMarkedReadReselectTickRef.current = reselectTick;

		// Snapshot for rollback on IPC failure.
		const previousGroups = queryClient.getQueryData(
			helmorQueryKeys.workspaceGroups,
		);
		const previousDetail = workspaceId
			? queryClient.getQueryData(helmorQueryKeys.workspaceDetail(workspaceId))
			: undefined;
		const previousSessions = workspaceId
			? queryClient.getQueryData(helmorQueryKeys.workspaceSessions(workspaceId))
			: undefined;

		let remainingUnread = 0;
		if (workspaceId) {
			const currentSessions = queryClient.getQueryData<
				WorkspaceSessionSummary[] | undefined
			>(helmorQueryKeys.workspaceSessions(workspaceId));
			if (Array.isArray(currentSessions)) {
				const patched = currentSessions.map((session) =>
					session.id === sessionId ? { ...session, unreadCount: 0 } : session,
				);
				remainingUnread = patched.filter((s) => s.unreadCount > 0).length;
				queryClient.setQueryData<WorkspaceSessionSummary[]>(
					helmorQueryKeys.workspaceSessions(workspaceId),
					patched,
				);
			}
			queryClient.setQueryData<WorkspaceGroup[] | undefined>(
				helmorQueryKeys.workspaceGroups,
				(current) =>
					recomputeWorkspaceUnreadInGroups(
						current,
						workspaceId,
						remainingUnread,
					),
			);
			queryClient.setQueryData<WorkspaceDetail | null | undefined>(
				helmorQueryKeys.workspaceDetail(workspaceId),
				(current) =>
					current
						? recomputeWorkspaceDetailUnread(current, remainingUnread)
						: current,
			);
		}

		void markSessionRead(sessionId)
			.then(() => {
				requestSidebarReconcile(queryClient);
				const invalidations: Promise<void>[] = [];
				if (workspaceId) {
					invalidations.push(
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						}),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						}),
					);
				}
				return Promise.all(invalidations);
			})
			.catch((error) => {
				queryClient.setQueryData(
					helmorQueryKeys.workspaceGroups,
					previousGroups,
				);
				if (workspaceId) {
					queryClient.setQueryData(
						helmorQueryKeys.workspaceDetail(workspaceId),
						previousDetail,
					);
					queryClient.setQueryData(
						helmorQueryKeys.workspaceSessions(workspaceId),
						previousSessions,
					);
				}
				if (lastMarkedReadSessionIdRef.current === sessionId) {
					lastMarkedReadSessionIdRef.current = null;
				}
				console.error("[app] mark session read on view:", error);
			});
	}, [
		displayedSessionId,
		interactionRequiredSessionIds,
		queryClient,
		reselectTick,
	]);

	const onSessionCompleted = useCallback(
		(sessionId: string, workspaceId: string) => {
			setSettledSessionIds((prev) => {
				if (prev.has(sessionId)) return prev;
				const next = new Set(prev);
				next.add(sessionId);
				return next;
			});

			const isCurrentSession = sessionId === getSelectedSessionIdRef.current();
			if (!isCurrentSession) {
				void markSessionUnread(sessionId)
					.then(() => {
						requestSidebarReconcile(queryClient);
						return Promise.all([
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
							}),
							queryClient.invalidateQueries({
								queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
							}),
						]);
					})
					.catch((error) => {
						console.error("[app] mark session unread on completion:", error);
					});
			}
			// Skip OS notification when the user is focused on this session.
			if (document.hasFocus() && isCurrentSession) return;
			const name =
				queryClient.getQueryData<WorkspaceDetail | null>(
					helmorQueryKeys.workspaceDetail(workspaceId),
				)?.title ?? "Workspace";
			notifyRef.current({ title: "Session completed", body: name });
		},
		[queryClient],
	);

	const onSessionAborted = useCallback((sessionId: string) => {
		setAbortedSessionIds((prev) => {
			if (prev.has(sessionId)) return prev;
			const next = new Set(prev);
			next.add(sessionId);
			return next;
		});
	}, []);

	const onInteractionSessionsChange = useCallback(
		(nextMap: Map<string, string>, counts: Map<string, number>) => {
			for (const [sessionId, workspaceId] of nextMap) {
				const count = counts.get(sessionId) ?? 0;
				const prev = lastInteractionCountsRef.current.get(sessionId) ?? 0;
				if (count > prev) {
					const name =
						queryClient.getQueryData<WorkspaceDetail | null>(
							helmorQueryKeys.workspaceDetail(workspaceId),
						)?.title ?? "Workspace";
					notifyRef.current({ title: "Input needed", body: name });
				}
			}
			const nextCounts = new Map<string, number>();
			for (const [sessionId] of nextMap) {
				nextCounts.set(sessionId, counts.get(sessionId) ?? 0);
			}
			lastInteractionCountsRef.current = nextCounts;

			setInteractionRequiredSessions((current) => {
				if (current.size === nextMap.size) {
					let unchanged = true;
					for (const [sessionId, workspaceId] of nextMap) {
						if (current.get(sessionId) !== workspaceId) {
							unchanged = false;
							break;
						}
					}
					if (unchanged) return current;
				}
				return new Map(nextMap);
			});
		},
		[queryClient],
	);

	const onSessionHidden = useCallback(
		(sessionId: string, workspaceId: string) => {
			recentlyClosedSessionsRef.current = [
				{ sessionId, workspaceId },
				...recentlyClosedSessionsRef.current.filter(
					(entry) => entry.sessionId !== sessionId,
				),
			].slice(0, RECENTLY_CLOSED_SESSIONS_MAX);
		},
		[],
	);

	const reopenClosedSession = useCallback(async () => {
		const next = recentlyClosedSessionsRef.current[0];
		if (!next) return;
		recentlyClosedSessionsRef.current =
			recentlyClosedSessionsRef.current.slice(1);
		try {
			await unhideSession(next.sessionId);
			requestSidebarReconcile(queryClient);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceDetail(next.workspaceId),
				}),
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(next.workspaceId),
				}),
			]);
			onReopenSelectWorkspaceRef.current(next.workspaceId);
			onReopenSelectSessionRef.current(next.sessionId);
		} catch (error) {
			pushToastRef.current(
				error instanceof Error ? error.message : String(error),
				"Unable to reopen session",
				"destructive",
			);
		}
	}, [queryClient]);

	const state = useMemo<ReadStateState>(
		() => ({
			settledSessionIds,
			abortedSessionIds,
			interactionRequiredSessionIds,
			interactionRequiredWorkspaceIds,
		}),
		[
			settledSessionIds,
			abortedSessionIds,
			interactionRequiredSessionIds,
			interactionRequiredWorkspaceIds,
		],
	);

	const actions = useStableActions<ReadStateActions>({
		onSessionCompleted,
		onSessionAborted,
		onInteractionSessionsChange,
		onSessionHidden,
		reopenClosedSession,
	});

	return { state, actions };
}
