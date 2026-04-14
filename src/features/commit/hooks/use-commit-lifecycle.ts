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
	closeWorkspacePr,
	createSession,
	hideSession,
	loadAutoCloseActionKinds,
	lookupWorkspacePr,
	mergeWorkspacePr,
	type PullRequestInfo,
	setWorkspaceManualStatus,
	type WorkspaceDetail,
	type WorkspaceGitActionStatus,
	type WorkspacePrActionStatus,
} from "@/lib/api";
import {
	deriveCommitButtonMode,
	deriveCommitButtonState,
} from "@/lib/commit-button-logic";
import { COMMIT_BUTTON_PROMPTS } from "@/lib/commit-button-prompts";
import { helmorQueryKeys } from "@/lib/query-client";
import type { CommitButtonState, WorkspaceCommitButtonMode } from "../button";

type CommitLifecycle = {
	workspaceId: string;
	trackedSessionId: string | null;
	mode: WorkspaceCommitButtonMode;
	phase: "creating" | "streaming" | "verifying" | "done" | "error";
	prInfo: PullRequestInfo | null;
};

export type PendingPromptForSession = {
	sessionId: string;
	prompt: string;
	modelId?: string | null;
	permissionMode?: string | null;
};

export function useWorkspaceCommitLifecycle({
	queryClient,
	selectedWorkspaceId,
	selectedWorkspaceIdRef,
	workspaceManualStatus,
	workspacePrInfo,
	workspacePrActionStatus,
	workspaceGitActionStatus,
	sendingSessionIds,
	onSelectSession,
}: {
	queryClient: QueryClient;
	selectedWorkspaceId: string | null;
	selectedWorkspaceIdRef: MutableRefObject<string | null>;
	workspaceManualStatus: string | null;
	workspacePrInfo: PullRequestInfo | null;
	workspacePrActionStatus: WorkspacePrActionStatus | null;
	workspaceGitActionStatus: WorkspaceGitActionStatus | null;
	sendingSessionIds: Set<string>;
	onSelectSession: (sessionId: string | null) => void;
}) {
	const [pendingPromptForSession, setPendingPromptForSession] =
		useState<PendingPromptForSession | null>(null);
	const [commitLifecycle, setCommitLifecycle] =
		useState<CommitLifecycle | null>(null);

	// Keep a stable ref so the merge-validation guard in the callback can
	// read the latest value without adding it to the dependency array.
	const prActionStatusRef = useRef(workspacePrActionStatus);
	prActionStatusRef.current = workspacePrActionStatus;

	const handleInspectorCommitAction = useCallback(
		async (mode: WorkspaceCommitButtonMode) => {
			const workspaceId = selectedWorkspaceIdRef.current;
			if (!workspaceId) {
				console.warn("[commitButton] action ignored: no selected workspace");
				return;
			}

			console.log("[commitButton] begin", { mode, workspaceId });

			if (mode === "merge" || mode === "closed") {
				// ── Merge pre-validation ─────────────────────────────────
				if (mode === "merge") {
					const currentMergeable = prActionStatusRef.current?.mergeable;
					if (currentMergeable === "CONFLICTING") {
						console.warn(
							"[commitButton] merge blocked: PR has merge conflicts",
						);
						return;
					}
					if (currentMergeable === "UNKNOWN") {
						console.warn(
							"[commitButton] merge blocked: mergeable status still computing, please wait",
						);
						// Trigger a refresh so the status resolves sooner
						void queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspacePrActionStatus(workspaceId),
						});
						return;
					}
				}

				const currentPr = queryClient.getQueryData<PullRequestInfo | null>(
					helmorQueryKeys.workspacePr(workspaceId),
				);
				const optimisticPr: PullRequestInfo | null = currentPr
					? {
							...currentPr,
							state: mode === "merge" ? "MERGED" : "CLOSED",
							isMerged: mode === "merge",
						}
					: null;
				const optimisticStatus = mode === "merge" ? "done" : "canceled";
				const previousStatus = workspaceManualStatus;

				setCommitLifecycle({
					workspaceId,
					trackedSessionId: null,
					mode,
					phase: "done",
					prInfo: optimisticPr,
				});
				queryClient.setQueryData(
					helmorQueryKeys.workspacePr(workspaceId),
					optimisticPr,
				);
				void setWorkspaceManualStatus(workspaceId, optimisticStatus).then(() =>
					queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceGroups,
					}),
				);

				void (async () => {
					try {
						const result =
							mode === "merge"
								? await mergeWorkspacePr(workspaceId)
								: await closeWorkspacePr(workspaceId);
						queryClient.setQueryData(
							helmorQueryKeys.workspacePr(workspaceId),
							result,
						);
					} catch (error) {
						console.error(`[commitButton] ${mode} failed:`, error);
						queryClient.setQueryData(
							helmorQueryKeys.workspacePr(workspaceId),
							currentPr,
						);
						void setWorkspaceManualStatus(workspaceId, previousStatus).then(
							() =>
								queryClient.invalidateQueries({
									queryKey: helmorQueryKeys.workspaceGroups,
								}),
						);
						setCommitLifecycle((prev) =>
							prev
								? { ...prev, phase: "error", prInfo: currentPr ?? null }
								: prev,
						);
					}
				})();
				return;
			}

			const prompt = COMMIT_BUTTON_PROMPTS[mode];
			if (!prompt) {
				console.warn(
					`[commitButton] action ignored: no prompt for mode ${mode}`,
				);
				return;
			}

			setCommitLifecycle({
				workspaceId,
				trackedSessionId: null,
				mode,
				phase: "creating",
				prInfo: null,
			});

			try {
				const { sessionId } = await createSession(workspaceId, mode);
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
				setCommitLifecycle((current) =>
					current ? { ...current, phase: "error" } : current,
				);
			}
		},
		[
			onSelectSession,
			queryClient,
			selectedWorkspaceIdRef,
			workspaceManualStatus,
		],
	);

	const queuePendingPromptForSession = useCallback(
		(request: PendingPromptForSession) => {
			setPendingPromptForSession(request);
		},
		[],
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

	useEffect(() => {
		const current = commitLifecycleRef.current;
		console.log("[commitButton] sendingSessionIds effect fired", {
			sendingIds: Array.from(sendingSessionIds),
			lifecyclePhase: current?.phase ?? null,
			trackedSessionId: current?.trackedSessionId ?? null,
			observedBefore: hasObservedSendingRef.current,
		});

		if (!current?.trackedSessionId) return;
		if (current.phase !== "creating" && current.phase !== "streaming") return;

		const isSending = sendingSessionIds.has(current.trackedSessionId);
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

		console.log(
			"[commitButton] stream ended — transitioning to verifying phase",
		);
		hasObservedSendingRef.current = false;
		setCommitLifecycle((prev) =>
			prev ? { ...prev, phase: "verifying" } : prev,
		);

		const workspaceId = current.workspaceId;
		void (async () => {
			try {
				console.log("[commitButton] calling lookupWorkspacePr", workspaceId);
				const pr = await lookupWorkspacePr(workspaceId);
				console.log("[commitButton] lookupWorkspacePr result", pr);
				setCommitLifecycle((prev) => {
					if (!prev || prev.workspaceId !== workspaceId) return prev;
					return { ...prev, phase: "done", prInfo: pr ?? null };
				});
			} catch (error) {
				console.error("[commitButton] PR lookup failed:", error);
				setCommitLifecycle((prev) =>
					prev && prev.workspaceId === workspaceId
						? { ...prev, phase: "error" }
						: prev,
				);
			}
		})();
	}, [sendingSessionIds]);

	useEffect(() => {
		if (!commitLifecycle) return;
		if (commitLifecycle.phase !== "done" && commitLifecycle.phase !== "error") {
			return;
		}

		const { phase, mode, trackedSessionId, workspaceId } = commitLifecycle;

		if (phase === "done") {
			if (mode !== "merge" && mode !== "closed") {
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspacePr(workspaceId),
				});
			}
			queryClient.invalidateQueries({
				queryKey: ["workspaceChanges"],
			});

			void (async () => {
				try {
					if (mode === "create-pr") {
						await setWorkspaceManualStatus(workspaceId, "review");
						await queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceGroups,
						});
					}

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
	}, [commitLifecycle, onSelectSession, queryClient]);

	// Only honour the lifecycle if it belongs to the currently-selected workspace.
	const activeLifecycle =
		commitLifecycle && commitLifecycle.workspaceId === selectedWorkspaceId
			? commitLifecycle
			: null;

	const commitButtonMode = useMemo<WorkspaceCommitButtonMode>(
		() =>
			deriveCommitButtonMode(
				activeLifecycle,
				workspacePrInfo,
				workspacePrActionStatus,
				workspaceGitActionStatus,
			),
		[
			activeLifecycle,
			workspacePrInfo,
			workspacePrActionStatus,
			workspaceGitActionStatus,
		],
	);

	const commitButtonState = useMemo<CommitButtonState>(
		() => deriveCommitButtonState(activeLifecycle, workspacePrActionStatus),
		[activeLifecycle, workspacePrActionStatus],
	);

	return {
		commitButtonMode,
		commitButtonState,
		handleInspectorCommitAction,
		handlePendingPromptConsumed,
		pendingPromptForSession,
		queuePendingPromptForSession,
	};
}
