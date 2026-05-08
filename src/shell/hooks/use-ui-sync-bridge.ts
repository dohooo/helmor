import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { subscribeUiMutations, type UiMutationEvent } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";

type Options = {
	queryClient: QueryClient;
	processPendingCliSends: () => Promise<void> | void;
	reloadSettings: () => Promise<void> | void;
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
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.archivedWorkspaces,
			});
			void queryClient.invalidateQueries({
				predicate: (query) =>
					query.queryKey[0] === "workspaceCandidateDirectories",
			});
			return;
		case "workspaceChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(event.workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceLinkedDirectories(event.workspaceId),
			});
			return;
		case "sessionListChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
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
		case "sessionMessagesAppended":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.sessionMessages(event.sessionId),
			});
			return;
		case "workspaceFilesChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(event.workspaceId),
			});
			invalidateAllWorkspaceChanges(queryClient);
			return;
		case "workspaceGitStateChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
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
			// Per-account roster (Settings → Account) re-renders too, since
			// auth flips can mean a new login appeared / disappeared.
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.forgeAccountsAll,
			});
			return;
		case "workspaceChangeRequestChanged":
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
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
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
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
	}
}

export function useUiSyncBridge({
	queryClient,
	processPendingCliSends,
	reloadSettings,
}: Options) {
	const processPendingCliSendsRef = useRef(processPendingCliSends);
	const reloadSettingsRef = useRef(reloadSettings);

	useEffect(() => {
		processPendingCliSendsRef.current = processPendingCliSends;
		reloadSettingsRef.current = reloadSettings;
	}, [processPendingCliSends, reloadSettings]);

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
