// Pending-queue controller: tracks inflight composer insert requests, the
// just-created-workspace submit envelope, and the CLI-send drain triggered
// on window focus. These three queues all share the same shape: AppShell
// holds them, the composer / streaming layer consumes them, then the
// `*Consumed` callbacks clear the slot.
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PendingPromptForSession } from "@/features/commit/hooks/use-commit-lifecycle";
import { drainPendingCliSends, triggerWorkspaceFetch } from "@/lib/api";
import {
	type ComposerInsertRequest,
	type ResolvedComposerInsertRequest,
	resolveComposerInsertTarget,
} from "@/lib/composer-insert";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { CLI_SEND_AUTO_SUBMIT_DELAY_MS } from "@/shell/constants";
import {
	useLatestRef,
	useStableActions,
} from "@/shell/hooks/use-stable-actions";

export type PendingQueueState = {
	pendingComposerInserts: ResolvedComposerInsertRequest[];
};

export type PendingQueueActions = {
	insertIntoComposer(request: ComposerInsertRequest): void;
	consumeComposerInserts(ids: string[]): void;
	processPendingCliSends(): Promise<void>;
};

export type PendingQueueController = {
	state: PendingQueueState;
	actions: PendingQueueActions;
};

export type PendingQueueControllerDeps = {
	queryClient: QueryClient;
	pushToast: PushWorkspaceToast;
	getSelectionTargets(): {
		selectedWorkspaceId: string | null;
		displayedWorkspaceId: string | null;
		displayedSessionId: string | null;
	};
	getActiveWorkspaceId(): string | null;
	onCliSendSelectWorkspace(workspaceId: string): void;
	onCliSendSelectSession(sessionId: string): void;
	queuePendingPromptForSession(prompt: PendingPromptForSession): void;
};

export function usePendingQueueController(
	deps: PendingQueueControllerDeps,
): PendingQueueController {
	const { queryClient, pushToast } = deps;

	const [pendingComposerInserts, setPendingComposerInserts] = useState<
		ResolvedComposerInsertRequest[]
	>([]);

	const pushToastRef = useLatestRef(pushToast);
	const getSelectionTargetsRef = useLatestRef(deps.getSelectionTargets);
	const getActiveWorkspaceIdRef = useLatestRef(deps.getActiveWorkspaceId);
	const onCliSendSelectWorkspaceRef = useLatestRef(
		deps.onCliSendSelectWorkspace,
	);
	const onCliSendSelectSessionRef = useLatestRef(deps.onCliSendSelectSession);
	const queuePendingPromptForSessionRef = useLatestRef(
		deps.queuePendingPromptForSession,
	);

	const insertIntoComposer = useCallback((request: ComposerInsertRequest) => {
		const targets = getSelectionTargetsRef.current();
		const resolvedTarget = resolveComposerInsertTarget(request.target, targets);
		const targetContextKey = resolvedTarget.contextKey ?? null;
		const targetWorkspaceId = resolvedTarget.workspaceId;
		if (!targetContextKey && !targetWorkspaceId) {
			pushToastRef.current(
				"Open a workspace before inserting content into the composer.",
				"Can't insert content",
			);
			return;
		}

		const items = request.items.filter((item) => {
			if (item.kind === "text") return item.text.length > 0;
			if (item.kind === "custom-tag") {
				return (
					item.label.trim().length > 0 && item.submitText.trim().length > 0
				);
			}
			return item.path.length > 0;
		});
		if (items.length === 0) return;

		setPendingComposerInserts((current) => [
			...current,
			{
				id: crypto.randomUUID(),
				contextKey: targetContextKey,
				workspaceId: targetWorkspaceId ?? null,
				sessionId: resolvedTarget.sessionId ?? null,
				items,
				behavior: request.behavior ?? "append",
				createdAt: Date.now(),
			},
		]);
	}, []);

	const consumeComposerInserts = useCallback((ids: string[]) => {
		if (ids.length === 0) return;
		const consumed = new Set(ids);
		setPendingComposerInserts((current) =>
			current.filter((r) => !consumed.has(r.id)),
		);
	}, []);

	const processPendingCliSends = useCallback(async () => {
		try {
			const sends = await drainPendingCliSends();
			if (sends.length === 0) return;

			const first = sends[0];

			requestSidebarReconcile(queryClient);
			if (first.workspaceId) {
				await queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(first.workspaceId),
				});
			}

			onCliSendSelectWorkspaceRef.current(first.workspaceId);

			setTimeout(() => {
				// Wait for the workspace-select commit before queuing — the
				// composer reads model/permission off `currentSession` once
				// the new session is the displayed one.
				queuePendingPromptForSessionRef.current({
					sessionId: first.sessionId,
					prompt: first.prompt,
				});
				onCliSendSelectSessionRef.current(first.sessionId);
			}, CLI_SEND_AUTO_SUBMIT_DELAY_MS);
		} catch (error) {
			console.error("[pendingCliSend] drain failed:", error);
		}
	}, [queryClient]);

	// Drain queued CLI sends every time the window regains focus.
	useEffect(() => {
		let unlisten: (() => void) | undefined;

		void import("@tauri-apps/api/event").then(({ listen }) => {
			void listen("tauri://focus", async () => {
				// Smart fetch: refresh target branch for the active workspace so
				// file tree diffs stay current after the user returns.
				const wsId = getActiveWorkspaceIdRef.current();
				if (wsId) {
					triggerWorkspaceFetch(wsId);
				}
				await processPendingCliSends();
			}).then((fn) => {
				unlisten = fn;
			});
		});

		return () => {
			unlisten?.();
		};
	}, [processPendingCliSends]);

	const actions = useStableActions<PendingQueueActions>({
		insertIntoComposer,
		consumeComposerInserts,
		processPendingCliSends,
	});

	const state = useMemo<PendingQueueState>(
		() => ({ pendingComposerInserts }),
		[pendingComposerInserts],
	);

	return { state, actions };
}
