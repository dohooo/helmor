import type { QueryClient } from "@tanstack/react-query";
import {
	type MutableRefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type ChangeRequestInfo,
	closeWorkspaceChangeRequest,
	createSession,
	type ForgeActionStatus,
	type ForgeDetection,
	hideSession,
	loadAutoCloseActionKinds,
	loadRepoPreferences,
	mergeWorkspaceChangeRequest,
	pushWorkspaceToRemote,
	refreshWorkspaceChangeRequest,
	type WorkspaceDetail,
	type WorkspaceGitActionStatus,
	type WorkspaceGroup,
	type WorkspaceStatus,
} from "@/lib/api";
import {
	deriveCommitButtonMode,
	deriveCommitButtonState,
} from "@/lib/commit-button-logic";
import {
	buildCommitButtonPrompt,
	isActionSessionMode,
} from "@/lib/commit-button-prompts";
import {
	helmorQueryKeys,
	workspaceForgeQueryOptions,
} from "@/lib/query-client";
import { moveWorkspaceToGroup } from "@/lib/workspace-helpers";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import type { CommitButtonState, WorkspaceCommitButtonMode } from "../button";

/**
 * Derive the workspace lane this PR state implies. Mirrors the backend's
 * `pr_sync_state_from_change_request` + `sync_workspace_pr_state` mapping
 * in `src-tauri/src/workspace/workspaces.rs` so the optimistic placement
 * lands in the same group the next refetch will choose.
 */
function deriveStatusFromChangeRequest(
	changeRequest: ChangeRequestInfo | null,
): WorkspaceStatus | null {
	if (!changeRequest) return null;
	if (changeRequest.isMerged || changeRequest.state === "MERGED") return "done";
	if (changeRequest.state === "OPEN") return "review";
	if (changeRequest.state === "CLOSED") return "canceled";
	return null;
}

/**
 * Snapshot the slice of caches we touch in an optimistic PR-state update so
 * we can roll back atomically on error. Returned restore() is a no-op once
 * we know the action succeeded.
 */
function applyOptimisticWorkspaceStatus(
	queryClient: QueryClient,
	workspaceId: string,
	nextStatus: WorkspaceStatus,
): () => void {
	const previousGroups = queryClient.getQueryData<WorkspaceGroup[]>(
		helmorQueryKeys.workspaceGroups,
	);
	const previousDetail = queryClient.getQueryData<WorkspaceDetail | null>(
		helmorQueryKeys.workspaceDetail(workspaceId),
	);

	queryClient.setQueryData<WorkspaceGroup[] | undefined>(
		helmorQueryKeys.workspaceGroups,
		(current) => moveWorkspaceToGroup(current, workspaceId, nextStatus),
	);
	queryClient.setQueryData<WorkspaceDetail | null | undefined>(
		helmorQueryKeys.workspaceDetail(workspaceId),
		(detail) => (detail ? { ...detail, status: nextStatus } : detail),
	);

	return () => {
		queryClient.setQueryData(helmorQueryKeys.workspaceGroups, previousGroups);
		queryClient.setQueryData(
			helmorQueryKeys.workspaceDetail(workspaceId),
			previousDetail,
		);
	};
}

function getActionFailureTitle(
	mode: WorkspaceCommitButtonMode,
	changeRequestName = "PR",
): string {
	switch (mode) {
		case "create-pr":
			return `Create ${changeRequestName} failed`;
		case "commit-and-push":
			return "Commit and push failed";
		case "push":
			return "Push failed";
		case "fix":
			return "Fix CI failed";
		case "resolve-conflicts":
			return "Resolve conflicts failed";
		case "merge":
			return "Merge failed";
		case "open-pr":
			return `Open ${changeRequestName} failed`;
		case "closed":
			return `Close ${changeRequestName} failed`;
		default:
			return "Action failed";
	}
}

function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

type CommitLifecycle = {
	workspaceId: string;
	trackedSessionId: string | null;
	mode: WorkspaceCommitButtonMode;
	phase: "creating" | "streaming" | "verifying" | "done" | "error";
	changeRequest: ChangeRequestInfo | null;
};

export type PendingPromptForSession = {
	sessionId: string;
	prompt: string;
	modelId?: string | null;
	/** Effort level override applied alongside `modelId` (e.g. Review helper
	 *  uses settings.reviewEffort). Falls through if null. */
	effort?: string | null;
	/** Fast-mode override applied alongside `modelId` (Review helper uses
	 *  settings.reviewFastMode). Falls through if null/undefined. */
	fastMode?: boolean | null;
	permissionMode?: string | null;
	/** When true, submit must queue if a turn is already streaming —
	 *  regardless of the user's `followUpBehavior` setting. Used for
	 *  host-triggered prompts (e.g. git-pull conflict resolution) that
	 *  must never interrupt the active turn. */
	forceQueue?: boolean;
};

export function useWorkspaceCommitLifecycle({
	queryClient,
	selectedWorkspaceId,
	selectedWorkspaceIdRef,
	selectedRepoId,
	selectedWorkspaceTargetBranch,
	selectedWorkspaceRemote,
	changeRequest,
	forgeDetection,
	forgeActionStatus,
	workspaceGitActionStatus,
	completedSessionIds,
	abortedSessionIds,
	interactionRequiredSessionIds,
	busySessionIds,
	onSelectSession,
	pushToast,
}: {
	queryClient: QueryClient;
	selectedWorkspaceId: string | null;
	selectedWorkspaceIdRef: MutableRefObject<string | null>;
	selectedRepoId: string | null;
	selectedWorkspaceTargetBranch?: string | null;
	/** Git remote name (e.g. "origin") for the selected workspace's repo.
	 *  Threaded into PR/push prompts so the agent gets a concrete remote
	 *  instead of a literal `<remote>` placeholder. */
	selectedWorkspaceRemote?: string | null;
	changeRequest?: ChangeRequestInfo | null;
	forgeDetection?: ForgeDetection | null;
	forgeActionStatus?: ForgeActionStatus | null;
	workspaceGitActionStatus: WorkspaceGitActionStatus | null;
	completedSessionIds: Set<string>;
	abortedSessionIds?: Set<string>;
	interactionRequiredSessionIds: Set<string>;
	busySessionIds: Set<string>;
	onSelectSession: (sessionId: string | null) => void;
	pushToast?: PushWorkspaceToast;
}) {
	const [pendingPromptForSession, setPendingPromptForSession] =
		useState<PendingPromptForSession | null>(null);
	const [commitLifecycle, setCommitLifecycle] =
		useState<CommitLifecycle | null>(null);
	const currentChangeRequest = changeRequest ?? null;
	const currentForgeActionStatus = forgeActionStatus ?? null;
	const changeRequestName = forgeDetection?.labels.changeRequestName ?? "PR";

	// Keep a stable ref so the merge-validation guard in the callback can
	// read the latest value without adding it to the dependency array.
	const forgeActionStatusRef = useRef(currentForgeActionStatus);
	forgeActionStatusRef.current = currentForgeActionStatus;

	// `workspaceChangeRequest` is intentionally NOT invalidated here. Callers
	// that need fresh PR data already write it directly via setQueryData
	// (either from `await refreshWorkspaceChangeRequest(...)` or from an
	// optimistic snapshot), so an invalidation would just trigger a duplicate
	// `gh pr view` round-trip.
	const refreshWorkspaceRemoteStatus = useCallback(
		(workspaceId: string) => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGitActionStatus(workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
			});
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceGroups,
			});
		},
		[queryClient],
	);

	const handleInspectorCommitAction = useCallback(
		async (mode: WorkspaceCommitButtonMode) => {
			const workspaceId = selectedWorkspaceIdRef.current;
			if (!workspaceId) {
				console.warn("[commitButton] action ignored: no selected workspace");
				return;
			}

			completedSessionHandledRef.current = null;
			console.log("[commitButton] begin", { mode, workspaceId });

			if (mode === "merge" || mode === "closed") {
				// ── Merge pre-validation ─────────────────────────────────
				if (mode === "merge") {
					const currentMergeable = forgeActionStatusRef.current?.mergeable;
					if (currentMergeable === "CONFLICTING") {
						console.warn(
							`[commitButton] merge blocked: ${changeRequestName} has merge conflicts`,
						);
						pushToast?.(
							`${changeRequestName} has merge conflicts and cannot be merged yet.`,
							"Merge blocked",
							"destructive",
						);
						return;
					}
					if (currentMergeable === "UNKNOWN") {
						console.warn(
							"[commitButton] merge blocked: mergeable status still computing, please wait",
						);
						pushToast?.(
							"Mergeability is still being calculated. Please wait and try again.",
							"Merge blocked",
							"destructive",
						);
						// Trigger a refresh so the status resolves sooner
						void queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
						});
						return;
					}
				}

				const cachedChangeRequest =
					queryClient.getQueryData<ChangeRequestInfo | null>(
						helmorQueryKeys.workspaceChangeRequest(workspaceId),
					);
				const optimisticChangeRequest: ChangeRequestInfo | null =
					cachedChangeRequest
						? {
								...cachedChangeRequest,
								state: mode === "merge" ? "MERGED" : "CLOSED",
								isMerged: mode === "merge",
							}
						: null;
				setCommitLifecycle({
					workspaceId,
					trackedSessionId: null,
					mode,
					phase: "done",
					changeRequest: optimisticChangeRequest,
				});
				queryClient.setQueryData(
					helmorQueryKeys.workspaceChangeRequest(workspaceId),
					optimisticChangeRequest,
				);
				// Move the workspace to its target sidebar group + flip the
				// detail status in the same tick so the inspector header tone
				// AND the sidebar lane reflect the new state immediately,
				// instead of waiting for the GitHub round-trip + event invalidation.
				const restoreWorkspaceStatus = applyOptimisticWorkspaceStatus(
					queryClient,
					workspaceId,
					mode === "merge" ? "done" : "canceled",
				);

				void (async () => {
					try {
						const result =
							mode === "merge"
								? await mergeWorkspaceChangeRequest(workspaceId)
								: await closeWorkspaceChangeRequest(workspaceId);
						queryClient.setQueryData(
							helmorQueryKeys.workspaceChangeRequest(workspaceId),
							result,
						);
					} catch (error) {
						console.error(`[commitButton] ${mode} failed:`, error);
						pushToast?.(
							getErrorMessage(error, "Unable to complete action."),
							getActionFailureTitle(mode, changeRequestName),
							"destructive",
						);
						queryClient.setQueryData(
							helmorQueryKeys.workspaceChangeRequest(workspaceId),
							cachedChangeRequest,
						);
						restoreWorkspaceStatus();
						setCommitLifecycle((prev) =>
							prev
								? {
										...prev,
										phase: "error",
										changeRequest: cachedChangeRequest ?? null,
									}
								: prev,
						);
					}
				})();
				return;
			}

			setCommitLifecycle({
				workspaceId,
				trackedSessionId: null,
				mode,
				phase: "creating",
				changeRequest: null,
			});

			if (mode === "push") {
				try {
					await pushWorkspaceToRemote(workspaceId);
					setCommitLifecycle((current) =>
						current ? { ...current, phase: "done" } : current,
					);
				} catch (error) {
					console.error("[commitButton] Failed to push branch:", error);
					const message = getErrorMessage(error, "Unable to push branch.");
					pushToast?.(message, "Push failed", "destructive");
					setCommitLifecycle((current) =>
						current ? { ...current, phase: "error" } : current,
					);
				}
				return;
			}

			if (!isActionSessionMode(mode)) {
				console.warn(
					`[commitButton] action ignored: no prompt for mode ${mode}`,
				);
				setCommitLifecycle(null);
				return;
			}
			try {
				const { sessionId } = await createSession(workspaceId, {
					actionKind: mode,
				});
				const repoPreferences = selectedRepoId
					? await loadRepoPreferences(selectedRepoId)
					: null;
				const forge = await queryClient
					.ensureQueryData(workspaceForgeQueryOptions(workspaceId))
					.catch(() => null);
				const prompt = buildCommitButtonPrompt(
					mode,
					repoPreferences,
					selectedWorkspaceTargetBranch,
					forge,
					selectedWorkspaceRemote,
				);
				console.log("[commitButton] session created", { sessionId });

				await queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				});

				setCommitLifecycle((current) =>
					current && current.phase === "creating"
						? { ...current, trackedSessionId: sessionId }
						: current,
				);

				setPendingPromptForSession({ sessionId, prompt });
				onSelectSession(sessionId);
			} catch (error) {
				console.error("[commitButton] Failed to start session:", error);
				pushToast?.(
					getErrorMessage(error, "Unable to start action."),
					getActionFailureTitle(mode, changeRequestName),
					"destructive",
				);
				setCommitLifecycle((current) =>
					current ? { ...current, phase: "error" } : current,
				);
			}
		},
		[
			onSelectSession,
			pushToast,
			changeRequestName,
			queryClient,
			selectedRepoId,
			selectedWorkspaceTargetBranch,
			selectedWorkspaceRemote,
			selectedWorkspaceIdRef,
		],
	);

	const queuePendingPromptForSession = useCallback(
		(request: PendingPromptForSession) => {
			setPendingPromptForSession(request);
		},
		[],
	);

	const handleInspectorReviewAction = useCallback(
		async ({
			modelId,
			effort,
			fastMode,
		}: {
			modelId: string | null;
			effort?: string | null;
			fastMode?: boolean | null;
		}) => {
			const workspaceId = selectedWorkspaceIdRef.current;
			if (!workspaceId) {
				console.warn("[review] action ignored: no selected workspace");
				return;
			}
			console.log("[review] begin", { workspaceId, modelId, effort, fastMode });
			try {
				// Review is auto-created (so it gets a fixed "Review" title
				// instead of an LLM-generated one), but it's NOT auto-hideable
				// — the review output is *for the user to read*, so the
				// session must stay around. The auto-hide gate is enforced
				// independently in `isAutoHideableActionKind`.
				const { sessionId } = await createSession(workspaceId, {
					actionKind: "review",
				});
				const repoPreferences = selectedRepoId
					? await loadRepoPreferences(selectedRepoId)
					: null;
				const forge = await queryClient
					.ensureQueryData(workspaceForgeQueryOptions(workspaceId))
					.catch(() => null);
				const prompt = buildCommitButtonPrompt(
					"review",
					repoPreferences,
					selectedWorkspaceTargetBranch,
					forge,
					selectedWorkspaceRemote,
				);
				await queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
				});
				setPendingPromptForSession({
					sessionId,
					prompt,
					modelId,
					effort: effort ?? null,
					fastMode: fastMode ?? null,
				});
				onSelectSession(sessionId);
			} catch (error) {
				console.error("[review] failed to start session:", error);
				pushToast?.(
					getErrorMessage(error, "Unable to start review."),
					"Review failed",
					"destructive",
				);
			}
		},
		[
			onSelectSession,
			pushToast,
			queryClient,
			selectedRepoId,
			selectedWorkspaceIdRef,
			selectedWorkspaceTargetBranch,
			selectedWorkspaceRemote,
		],
	);

	const handlePendingPromptConsumed = useCallback(() => {
		console.log("[commitButton] pending prompt consumed by composer");
		setPendingPromptForSession(null);
		setCommitLifecycle((current) =>
			current && current.phase === "creating"
				? { ...current, phase: "streaming" }
				: current,
		);
	}, []);

	const commitLifecycleRef = useRef(commitLifecycle);
	commitLifecycleRef.current = commitLifecycle;
	const hasObservedSendingRef = useRef(false);
	const completedSessionHandledRef = useRef<string | null>(null);

	useEffect(() => {
		const current = commitLifecycleRef.current;
		console.log("[commitButton] action-session settlement check", {
			sendingIds: Array.from(busySessionIds),
			completedIds: Array.from(completedSessionIds),
			abortedIds: abortedSessionIds ? Array.from(abortedSessionIds) : [],
			interactionRequiredIds: Array.from(interactionRequiredSessionIds),
			lifecyclePhase: current?.phase ?? null,
			trackedSessionId: current?.trackedSessionId ?? null,
			observedBefore: hasObservedSendingRef.current,
			handledCompletedSessionId: completedSessionHandledRef.current,
		});

		if (!current?.trackedSessionId) return;
		if (current.phase !== "creating" && current.phase !== "streaming") return;

		const trackedSessionId = current.trackedSessionId;

		// Aborted sessions clear the lifecycle — no PR was created, so the
		// button returns to idle rather than proceeding to verify.
		if (abortedSessionIds?.has(trackedSessionId)) {
			console.log(
				"[commitButton] tracked session aborted — clearing lifecycle",
			);
			hasObservedSendingRef.current = false;
			completedSessionHandledRef.current = null;
			setCommitLifecycle(null);
			return;
		}

		const isSending = busySessionIds.has(trackedSessionId);
		if (isSending) {
			console.log("[commitButton] tracked session is streaming");
			hasObservedSendingRef.current = true;
			return;
		}

		if (!hasObservedSendingRef.current) {
			console.log(
				"[commitButton] tracked session not yet observed streaming — waiting",
			);
			return;
		}

		if (!completedSessionIds.has(trackedSessionId)) {
			console.log("[commitButton] tracked session not yet completed — waiting");
			return;
		}

		if (interactionRequiredSessionIds.has(trackedSessionId)) {
			console.log(
				"[commitButton] tracked session still requires interaction — waiting",
			);
			return;
		}

		if (completedSessionHandledRef.current === trackedSessionId) {
			console.log(
				"[commitButton] tracked session completion already handled — skipping",
			);
			return;
		}

		console.log(
			"[commitButton] tracked session completed and settled — transitioning to verifying phase",
		);
		hasObservedSendingRef.current = false;
		completedSessionHandledRef.current = trackedSessionId;
		setCommitLifecycle((prev) =>
			prev ? { ...prev, phase: "verifying" } : prev,
		);

		const workspaceId = current.workspaceId;
		void (async () => {
			try {
				console.log(
					"[commitButton] calling refreshWorkspaceChangeRequest",
					workspaceId,
				);
				const currentChangeRequest =
					await refreshWorkspaceChangeRequest(workspaceId);
				console.log(
					"[commitButton] refreshWorkspaceChangeRequest result",
					currentChangeRequest,
				);
				// Seed caches directly from the result we just awaited so the
				// downstream invalidation in `refreshWorkspaceRemoteStatus`
				// doesn't trigger a duplicate `gh pr view`, and so the sidebar
				// lane / inspector header reflect the PR state on the same
				// frame as the lifecycle transition.
				queryClient.setQueryData(
					helmorQueryKeys.workspaceChangeRequest(workspaceId),
					currentChangeRequest ?? null,
				);
				const optimisticStatus = deriveStatusFromChangeRequest(
					currentChangeRequest ?? null,
				);
				if (optimisticStatus) {
					applyOptimisticWorkspaceStatus(
						queryClient,
						workspaceId,
						optimisticStatus,
					);
				}
				setCommitLifecycle((prev) => {
					if (!prev || prev.workspaceId !== workspaceId) return prev;
					return {
						...prev,
						phase: "done",
						changeRequest: currentChangeRequest ?? null,
					};
				});
				refreshWorkspaceRemoteStatus(workspaceId);
			} catch (error) {
				console.error("[commitButton] PR lookup failed:", error);
				pushToast?.(
					getErrorMessage(error, "Unable to verify action result."),
					getActionFailureTitle(current.mode, changeRequestName),
					"destructive",
				);
				setCommitLifecycle((prev) =>
					prev && prev.workspaceId === workspaceId
						? { ...prev, phase: "error" }
						: prev,
				);
			}
		})();
	}, [
		changeRequestName,
		completedSessionIds,
		abortedSessionIds,
		interactionRequiredSessionIds,
		pushToast,
		queryClient,
		refreshWorkspaceRemoteStatus,
		busySessionIds,
	]);

	useEffect(() => {
		if (!commitLifecycle) return;
		if (commitLifecycle.phase !== "done" && commitLifecycle.phase !== "error") {
			return;
		}

		const { phase, mode, trackedSessionId, workspaceId } = commitLifecycle;

		if (phase === "done") {
			if (mode !== "merge" && mode !== "closed") {
				refreshWorkspaceRemoteStatus(workspaceId);
			}
			queryClient.invalidateQueries({
				queryKey: ["workspaceChanges"],
			});

			void (async () => {
				try {
					if (!trackedSessionId) return;
					const optedIn = await loadAutoCloseActionKinds();
					if (!optedIn.includes(mode)) return;
					await hideSession(trackedSessionId);
					await Promise.all([
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						}),
						queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceDetail(workspaceId),
						}),
					]);
					const detail = queryClient.getQueryData<WorkspaceDetail | null>(
						helmorQueryKeys.workspaceDetail(workspaceId),
					);
					onSelectSession(detail?.activeSessionId ?? null);
				} catch (error) {
					console.error(
						"[commitButton] done-phase side effects failed:",
						error,
					);
				}
			})();
		}

		const timeoutId = window.setTimeout(
			() => {
				setCommitLifecycle(null);
			},
			phase === "done" ? 1200 : 1600,
		);
		return () => window.clearTimeout(timeoutId);
	}, [
		commitLifecycle,
		onSelectSession,
		queryClient,
		refreshWorkspaceRemoteStatus,
	]);

	// Only honour the lifecycle if it belongs to the currently-selected workspace.
	const activeLifecycle =
		commitLifecycle && commitLifecycle.workspaceId === selectedWorkspaceId
			? commitLifecycle
			: null;

	const commitButtonMode = useMemo<WorkspaceCommitButtonMode>(
		() =>
			deriveCommitButtonMode(
				activeLifecycle,
				currentChangeRequest,
				currentForgeActionStatus,
				workspaceGitActionStatus,
			),
		[
			activeLifecycle,
			currentChangeRequest,
			currentForgeActionStatus,
			workspaceGitActionStatus,
		],
	);

	const commitButtonState = useMemo<CommitButtonState>(
		() =>
			deriveCommitButtonState(
				activeLifecycle,
				currentForgeActionStatus,
				commitButtonMode,
			),
		[activeLifecycle, currentForgeActionStatus, commitButtonMode],
	);

	return {
		commitButtonMode,
		commitButtonState,
		handleInspectorCommitAction,
		handleInspectorReviewAction,
		handlePendingPromptConsumed,
		pendingPromptForSession,
		queuePendingPromptForSession,
	};
}
