import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useStreamingStore } from "@/features/conversation/state/streaming-store";
import {
	generateSessionTitle,
	subscribeUiMutations,
	type UiMutationEvent,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";

type Options = {
	queryClient: QueryClient;
	processPendingCliSends: () => Promise<void> | void;
	reloadSettings: () => Promise<void> | void;
	/**
	 * "Open in Helmor" from the quick panel. Wired in the MAIN window only —
	 * the event broadcasts to every webview, and the quick panel must not
	 * navigate itself.
	 */
	onWorkspaceReveal?: (workspaceId: string, sessionId: string | null) => void;
};

function invalidateAllWorkspaceChanges(queryClient: QueryClient) {
	void queryClient.invalidateQueries({
		predicate: (query) => query.queryKey[0] === "workspaceChanges",
	});
	void queryClient.invalidateQueries({
		predicate: (query) => query.queryKey[0] === "workspaceFiles",
	});
}

function handleUiMutation(
	event: UiMutationEvent,
	queryClient: QueryClient,
	options: Omit<Options, "queryClient">,
) {
	switch (event.type) {
		case "workspaceListChanged":
			// Gate the sidebar-list invalidate so it skips while archive /
			// restore / pin etc. is mid-flight (their `holdSidebarMutation`
			// release will reconcile once they settle). Other queries are
			// unaffected.
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === "workspaceCandidateDirectories",
			});
			return;
		case "workspaceChanged":
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceLinkedDirectories(event.workspaceId),
			});
			return;
		case "sessionListChanged":
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceSessions(event.workspaceId),
			});
			return;
		case "contextUsageChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionContextUsage(event.sessionId),
			});
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === "claudeRichContextUsage" &&
					query.queryKey[1] === event.sessionId,
			});
			return;
		case "codexGoalChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionCodexGoal(event.sessionId),
			});
			return;
		case "sessionPlanChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionPlanState(event.sessionId),
			});
			return;
		case "sessionMessagesAppended":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionMessages(event.sessionId),
			});
			return;
		case "sessionTurnPersisted": {
			// A turn's terminal rows landed in the DB. While THIS client has a
			// live stream (or an in-flight send) for the session, the local
			// dispatcher owns the cache snapshot — its streamed message IDs
			// differ from the DB IDs, so a refetch would clobber it and
			// flicker (the exact thing the dispatcher's done-path refuses to
			// do). Deliberately NOT checked against `liveSessionsByContext`:
			// that is a never-cleared resume-id map, not liveness.
			const contextKey = `session:${event.sessionId}`;
			const streaming = useStreamingStore.getState();
			if (
				streaming.activeSessionByContext[contextKey] !== undefined ||
				streaming.sendingContextKeys.has(contextKey)
			) {
				return;
			}
			// Mark stale without an active refetch: background sessions have
			// no observers anyway, and a late event for the on-screen session
			// must not flash it. The next mount refetches.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionMessages(event.sessionId),
				refetchType: "none",
			});
			return;
		}
		case "workspaceFilesChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(event.workspaceId),
			});
			invalidateAllWorkspaceChanges(queryClient);
			return;
		case "workspaceGitStateChanged":
			// This is the event that fired during restore and clobbered the
			// optimistic move from archived → active. Gate it so it sits
			// out while the restore round-trip holds the gate; reconcile
			// happens when the hold releases.
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceForgeActionStatus(event.workspaceId),
			});
			invalidateAllWorkspaceChanges(queryClient);
			return;
		case "workspaceForgeChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceForge(event.workspaceId),
			});
			// Auth verdicts are per (host, login) and shared repo-wide:
			// when one workspace flips to unauthenticated, siblings on the
			// same repo share the verdict. Refresh every action-status
			// snapshot so the Connect CTA stays consistent across
			// workspaces — refetches hit the backend's in-memory verdict
			// cache, not the network.
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === "workspaceForgeActionStatus",
			});
			// Per-account roster (Settings → Account) re-renders too, since
			// auth flips can mean a new login appeared / disappeared.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.forgeAccountsAll,
			});
			return;
		case "workspaceChangeRequestChanged":
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceChangeRequest(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceForgeActionStatus(event.workspaceId),
			});
			return;
		case "repositoryListChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repositories,
			});
			// Backfill phase 2 also emits this when it clears /
			// re-binds a stale `forge_login`. The chip header,
			// inspector forge section, and inspector PR/MR action
			// status all read off whichever login the workspace's
			// repo is currently bound to — refresh them too so
			// the chip swaps to the new account immediately
			// instead of waiting for the next focus tick.
			void queryClient.invalidateQueries({
				predicate: (query) => {
					const root = query.queryKey[0];
					return (
						root === "workspaceAccountProfile" ||
						root === "workspaceForge" ||
						root === "workspaceForgeActionStatus"
					);
				},
			});
			return;
		case "repositoryChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repositories,
			});
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === "repoScripts" &&
					query.queryKey[1] === event.repoId,
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.repoPreferences(event.repoId),
			});
			void queryClient.invalidateQueries({
				predicate: (query) => query.queryKey[0] === "workspaceDetail",
			});
			requestSidebarReconcile(queryClient);
			return;
		case "repoRunActionsChanged":
			// Settings UI edits + dropdown reorder + create / delete all
			// land here. Invalidate every `repoScripts` query for this
			// repo (one per workspace context — the loader merges DB
			// + helmor.json + workspace overrides per call).
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === "repoScripts" &&
					query.queryKey[1] === event.repoId,
			});
			return;
		case "settingsChanged":
			if (
				event.key === null ||
				event.key.startsWith("app.") ||
				event.key.startsWith("branch_prefix_")
			) {
				void options.reloadSettings();
			}
			if (
				event.key === null ||
				event.key === "auto_close_action_kinds" ||
				event.key === "auto_close_opt_in_asked"
			) {
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.autoCloseActionKinds,
				});
				void queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.autoCloseOptInAsked,
				});
			}
			return;
		case "pendingCliSendQueued":
			void options.processPendingCliSends();
			return;
		case "activeStreamsChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.activeStreams,
			});
			return;
		case "slackWorkspacesChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.slackWorkspaces,
			});
			// New connections also affect the activity feed (now has data)
			// and disconnections clear the cached items — kill every
			// `slackInbox` query in one sweep rather than tracking which
			// team_ids belong to which mutation.
			void queryClient.invalidateQueries({
				predicate: (query) => query.queryKey[0] === "slackInbox",
			});
			return;
		case "slackTokenInvalidated":
			// Token already wiped on the backend; bust the cache so the
			// inbox UI re-fetches and surfaces the auth error state /
			// "Reconnect" affordance.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.slackInbox(event.teamId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.slackWorkspaces,
			});
			return;
		case "triageConfigChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.triageConfig,
			});
			return;
		case "triageActiveStatusChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.triageActiveStatus,
			});
			return;
		case "triageWorkspaceCreated":
			requestSidebarReconcile(queryClient);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.triageActiveStatus,
			});
			return;
		case "pairedDevicesChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.pairedDevices,
			});
			return;
		case "terminalSessionIdle":
			// Terminal turn finished (agent Stop hook). Re-dispatch as the
			// window event the read-state controller already listens on, so
			// the shared completion path (unread + notification) fires.
			window.dispatchEvent(
				new CustomEvent("helmor:terminal-session-idle", {
					detail: {
						sessionId: event.sessionId,
						workspaceId: event.workspaceId,
					},
				}),
			);
			// The session tab's spinner also reads sessions.status from the DB;
			// refetch now or it shows 'streaming' until some other event lands
			// (the sidebar uses activeStreams and was already instant).
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceSessions(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(event.workspaceId),
			});
			return;
		case "terminalPromptCaptured": {
			// Terminal session's first prompt (agent UserPromptSubmit hook).
			// Run the same title + branch generator GUI sessions use; it's
			// gated server-side so only the first turn actually renames.
			const { sessionId, workspaceId, prompt } = event;
			void generateSessionTitle(sessionId, prompt).then((result) => {
				if (result?.title || result?.branchRenamed) {
					requestSidebarReconcile(queryClient);
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
					});
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
					});
				}
			});
			return;
		}
		case "workspaceRevealRequested":
			options.onWorkspaceReveal?.(event.workspaceId, event.sessionId);
			return;
	}
}

export function useUiSyncBridge({
	queryClient,
	processPendingCliSends,
	reloadSettings,
	onWorkspaceReveal,
}: Options) {
	const processPendingCliSendsRef = useRef(processPendingCliSends);
	const reloadSettingsRef = useRef(reloadSettings);
	const onWorkspaceRevealRef = useRef(onWorkspaceReveal);

	useEffect(() => {
		processPendingCliSendsRef.current = processPendingCliSends;
		reloadSettingsRef.current = reloadSettings;
		onWorkspaceRevealRef.current = onWorkspaceReveal;
	}, [processPendingCliSends, reloadSettings, onWorkspaceReveal]);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;

		void subscribeUiMutations((event) => {
			if (disposed) {
				return;
			}

			handleUiMutation(event, queryClient, {
				processPendingCliSends: () => processPendingCliSendsRef.current(),
				reloadSettings: () => reloadSettingsRef.current(),
				onWorkspaceReveal: (workspaceId, sessionId) =>
					onWorkspaceRevealRef.current?.(workspaceId, sessionId),
			});
		}).then((cleanup) => {
			if (disposed) {
				cleanup();
				return;
			}

			unlisten = cleanup;
		});

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [queryClient]);
}
