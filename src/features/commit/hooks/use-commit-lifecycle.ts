import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ChangeRequestInfo,
	checkWorkspaceForgeAuth,
	closeWorkspaceChangeRequest,
	createSession,
	type ForgeActionStatus,
	type ForgeAuthState,
	type ForgeDetection,
	hideSession,
	loadAutoCloseActionKinds,
	loadRepoPreferences,
	mergeWorkspaceChangeRequest,
	pushWorkspaceToRemote,
	refreshWorkspaceChangeRequest,
	stopAgentStream,
	type WorkspaceDetail,
	type WorkspaceGitActionStatus,
	type WorkspaceGroup,
	type WorkspaceSessionSummary,
	type WorkspaceStatus,
} from "@/lib/api";
import {
	deriveCommitButtonMode,
	deriveCommitButtonState,
	getMergeBlockedReason,
	hasNonPassingForgeChecks,
	mergeBlockedDetailText,
} from "@/lib/commit-button-logic";
import {
	buildCommitButtonPrompt,
	isActionSessionMode,
} from "@/lib/commit-button-prompts";
import { formatSource, translateSource } from "@/lib/i18n";
import {
	helmorQueryKeys,
	workspaceForgeQueryOptions,
} from "@/lib/query-client";
import {
	holdSidebarMutation,
	requestSidebarReconcile,
} from "@/lib/sidebar-mutation-gate";
import { moveWorkspaceToGroup } from "@/lib/workspace-helpers";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import type { CommitButtonState, WorkspaceCommitButtonMode } from "../button";
import { useMergeConfirmation } from "./use-merge-confirmation";

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
			return formatSource("commitButtonCreateNameFailed", {
				name: changeRequestName,
			});
		case "commit-and-push":
			return translateSource("commitButtonCommitAndPushFailed");
		case "push":
			return translateSource("commitButtonPushFailed");
		case "fix":
			return translateSource("commitButtonFixCiFailed");
		case "resolve-conflicts":
			return translateSource("commitButtonResolveConflictsFailed");
		case "checks-running":
		case "merge-blocked":
		case "merge":
			return translateSource("commitButtonMergeFailed");
		case "open-pr":
			return formatSource("commitButtonOpenNameFailed", {
				name: changeRequestName,
			});
		case "closed":
			return formatSource("commitButtonCloseNameFailed", {
				name: changeRequestName,
			});
		default:
			return translateSource("commitButtonActionFailed");
	}
}

function getErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

type CommitLifecycle = {
	/** Per-instance id so dismiss timers / done-phase side effects target the
	 *  exact lifecycle that scheduled them, even after the same workspace
	 *  starts a new action. */
	id: number;
	workspaceId: string;
	trackedSessionId: string | null;
	mode: WorkspaceCommitButtonMode;
	phase: "creating" | "streaming" | "verifying" | "done" | "error";
	changeRequest: ChangeRequestInfo | null;
};

const EMPTY_LIFECYCLES: ReadonlyMap<string, CommitLifecycle> = new Map();

/** Per-workspace settle tracking for in-flight action sessions. Kept in a ref
 *  (not state) so updating it never re-renders or re-fires the settle effect. */
type ActionTracking = {
	observedSending: boolean;
	handledSessionId: string | null;
};

export type PendingPromptForSession = {
	sessionId: string;
	prompt: string;
	/** When true, submit must queue if a turn is already streaming —
	 *  regardless of the user's `followUpBehavior` setting. Used for
	 *  host-triggered prompts (e.g. git-pull conflict resolution) that
	 *  must never interrupt the active turn. */
	forceQueue?: boolean;
};

export function useWorkspaceCommitLifecycle({
	queryClient,
	selectedWorkspaceId,
	getSelectedWorkspaceId,
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
	/** Resolves the latest selected workspace at call time. Lets the
	 *  callbacks read the current value without depending on a ref the
	 *  caller has to thread through. */
	getSelectedWorkspaceId: () => string | null;
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
	// One in-flight action per workspace, keyed by workspaceId. A single slot
	// would let a second Create-PR (on another workspace) clobber the first
	// before its completion side effects — refresh + auto-close — ever ran.
	const [commitLifecycles, setCommitLifecycles] =
		useState<ReadonlyMap<string, CommitLifecycle>>(EMPTY_LIFECYCLES);
	const lifecycleSeqRef = useRef(0);

	const beginLifecycle = useCallback(
		(value: Omit<CommitLifecycle, "id">): number => {
			const id = ++lifecycleSeqRef.current;
			setCommitLifecycles((prev) => {
				const next = new Map(prev);
				next.set(value.workspaceId, { ...value, id });
				return next;
			});
			return id;
		},
		[],
	);
	const patchLifecycle = useCallback(
		(
			workspaceId: string,
			updater: (prev: CommitLifecycle) => CommitLifecycle | null,
		) => {
			setCommitLifecycles((prev) => {
				const existing = prev.get(workspaceId);
				if (!existing) return prev;
				const updated = updater(existing);
				if (updated === existing) return prev;
				const next = new Map(prev);
				if (updated) next.set(workspaceId, updated);
				else next.delete(workspaceId);
				return next;
			});
		},
		[],
	);
	const clearLifecycle = useCallback((workspaceId: string) => {
		setCommitLifecycles((prev) => {
			if (!prev.has(workspaceId)) return prev;
			const next = new Map(prev);
			next.delete(workspaceId);
			return next;
		});
	}, []);

	const { requestMergeConfirmation, mergeConfirmDialogNode } =
		useMergeConfirmation();
	const currentChangeRequest = changeRequest ?? null;
	const currentForgeActionStatus = forgeActionStatus ?? null;
	const changeRequestName = forgeDetection?.labels.changeRequestName ?? "PR";
	const providerName = forgeDetection?.labels.providerName ?? "Forge";

	// Keep a stable ref so the merge-validation guard in the callback can
	// read the latest value without adding it to the dependency array.
	const forgeActionStatusRef = useRef(currentForgeActionStatus);
	forgeActionStatusRef.current = currentForgeActionStatus;

	// Ref mirror so the done-phase effect can read the live selection without
	// re-firing on every render (the getter is an inline arrow upstream).
	const getSelectedWorkspaceIdRef = useRef(getSelectedWorkspaceId);
	getSelectedWorkspaceIdRef.current = getSelectedWorkspaceId;

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
			requestSidebarReconcile(queryClient);
		},
		[queryClient],
	);

	const handleInspectorCommitAction = useCallback(
		async (
			mode: WorkspaceCommitButtonMode,
			overrides?: {
				modelId?: string | null;
				/** Provider of the override model — pinned as agent_type so a
				 *  slug-based model (e.g. opencode) routes correctly. */
				provider?: string | null;
				effort?: string | null;
				fastMode?: boolean | null;
			},
		) => {
			const workspaceId = getSelectedWorkspaceId();
			if (!workspaceId) {
				console.warn("[commitButton] action ignored: no selected workspace");
				return;
			}

			actionTrackingRef.current.set(workspaceId, {
				observedSending: false,
				handledSessionId: null,
			});
			console.log("[commitButton] begin", { mode, workspaceId });

			const isMergeAction =
				mode === "merge" ||
				mode === "checks-running" ||
				mode === "merge-blocked";
			if (isMergeAction || mode === "closed") {
				// ── Merge pre-validation ─────────────────────────────────
				if (isMergeAction) {
					const currentStatus = forgeActionStatusRef.current;
					const currentMergeable = currentStatus?.mergeable;
					if (currentMergeable === "CONFLICTING") {
						console.warn(
							`[commitButton] merge blocked: ${changeRequestName} has merge conflicts`,
						);
						pushToast?.(
							formatSource("commitMergeConflictsCannotMerge", {
								name: changeRequestName,
							}),
							translateSource("commitMergeBlocked"),
							"destructive",
						);
						return;
					}
					if (currentMergeable === "UNKNOWN") {
						console.warn(
							"[commitButton] merge blocked: mergeable status still computing, please wait",
						);
						pushToast?.(
							translateSource("commitMergeabilityCalculating"),
							translateSource("commitMergeBlocked"),
							"destructive",
						);
						// Trigger a refresh so the status resolves sooner
						void queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
						});
						return;
					}
					const checksHaveNotPassed = hasNonPassingForgeChecks(currentStatus);
					if (checksHaveNotPassed) {
						const confirmed = await requestMergeConfirmation({
							title: translateSource("mergeBeforeChecksPass"),
							description: translateSource("githubChecksHaveNotPassedYet"),
							confirmLabel: translateSource("commitMergeAnyway"),
						});
						if (!confirmed) {
							console.warn(
								"[commitButton] merge cancelled: checks have not passed",
							);
							void queryClient.invalidateQueries({
								queryKey:
									helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
							});
							return;
						}
					}
					const blockedReason = checksHaveNotPassed
						? null
						: getMergeBlockedReason(currentStatus);
					if (blockedReason) {
						const confirmed = await requestMergeConfirmation({
							title: translateSource("tryBlockedMerge"),
							description: mergeBlockedDetailText(blockedReason),
							confirmLabel: translateSource("commitTryAnyway"),
						});
						if (!confirmed) {
							console.warn(
								"[commitButton] merge cancelled: GitHub blocked merge",
							);
							void queryClient.invalidateQueries({
								queryKey:
									helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
							});
							return;
						}
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
								state: isMergeAction ? "MERGED" : "CLOSED",
								isMerged: isMergeAction,
							}
						: null;
				beginLifecycle({
					workspaceId,
					trackedSessionId: null,
					mode: isMergeAction ? "merge" : mode,
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
					isMergeAction ? "done" : "canceled",
				);

				// Gate sidebar flushes during the forge round-trip — without
				// this, mark-read on workspace-switch would refetch the
				// still-pre-merge groups and clobber the optimistic row.
				const release = holdSidebarMutation(queryClient);
				void (async () => {
					try {
						const result = isMergeAction
							? await mergeWorkspaceChangeRequest(workspaceId)
							: await closeWorkspaceChangeRequest(workspaceId);
						queryClient.setQueryData(
							helmorQueryKeys.workspaceChangeRequest(workspaceId),
							result,
						);
					} catch (error) {
						console.error(`[commitButton] ${mode} failed:`, error);
						pushToast?.(
							getErrorMessage(
								error,
								translateSource("commitUnableCompleteAction"),
							),
							getActionFailureTitle(mode, changeRequestName),
							"destructive",
						);
						queryClient.setQueryData(
							helmorQueryKeys.workspaceChangeRequest(workspaceId),
							cachedChangeRequest,
						);
						restoreWorkspaceStatus();
						// If the failure was auth-related, the published
						// workspace's action-status refetch returns
						// `unauthenticated` (401) and flips the Connect CTA — no
						// extra precheck round-trip on the happy path.
						void queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceForgeActionStatus(workspaceId),
						});
						patchLifecycle(workspaceId, (prev) => ({
							...prev,
							phase: "error",
							changeRequest: cachedChangeRequest ?? null,
						}));
					} finally {
						release();
					}
				})();
				return;
			}

			beginLifecycle({
				workspaceId,
				trackedSessionId: null,
				mode,
				phase: "creating",
				changeRequest: null,
			});

			if (mode === "push") {
				try {
					await pushWorkspaceToRemote(workspaceId);
					patchLifecycle(workspaceId, (current) => ({
						...current,
						phase: "done",
					}));
				} catch (error) {
					console.error("[commitButton] Failed to push branch:", error);
					const message = getErrorMessage(
						error,
						translateSource("commitUnablePushBranch"),
					);
					pushToast?.(
						message,
						translateSource("commitButtonPushFailed"),
						"destructive",
					);
					patchLifecycle(workspaceId, (current) => ({
						...current,
						phase: "error",
					}));
				}
				return;
			}

			if (!isActionSessionMode(mode)) {
				console.warn(
					`[commitButton] action ignored: no prompt for mode ${mode}`,
				);
				clearLifecycle(workspaceId);
				return;
			}
			try {
				// create-PR / open-PR (reopen) run `gh pr` / `glab mr` in the
				// agent. Fire the auth check in the BACKGROUND — never block
				// dispatch on it — so the session opens instantly; a logged-out
				// result aborts the turn below. (commit-and-push / fix /
				// resolve-conflicts are git-only — no check.)
				const authVerdict =
					mode === "create-pr" || mode === "open-pr"
						? checkWorkspaceForgeAuth(workspaceId).catch(
								() => "indeterminate" as ForgeAuthState,
							)
						: null;

				// Pin the inspector helper's configured model/effort/fast-mode
				// onto the new session row at creation time. The composer reads
				// these off `currentSession` via the normal fallback chain, so
				// no transient pendingPrompt override is needed for them.
				const { sessionId } = await createSession(workspaceId, {
					actionKind: mode,
					model: overrides?.modelId ?? null,
					agentType: overrides?.provider ?? null,
					effortLevel: overrides?.effort ?? null,
					fastMode: overrides?.fastMode ?? null,
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

				patchLifecycle(workspaceId, (current) =>
					current.phase === "creating"
						? { ...current, trackedSessionId: sessionId }
						: current,
				);

				setPendingPromptForSession({ sessionId, prompt });
				onSelectSession(sessionId);

				// Background auth guard (never blocks dispatch): if the account
				// is logged out, abort the just-started turn — but KEEP the
				// session — then Toast and let the recorded backend verdict
				// surface the Connect CTA via a refetch.
				if (authVerdict) {
					void authVerdict.then((verdict) => {
						if (verdict !== "loggedOut") return;
						void stopAgentStream(sessionId).catch(() => {});
						pushToast?.(
							formatSource("commitReconnectAccountTryAgain", {
								provider: providerName,
							}),
							formatSource("commitProviderNotConnected", {
								provider: providerName,
							}),
							"destructive",
						);
						// Every workspace on this account shares the backend
						// verdict — refetch them ALL (incl. inactive siblings)
						// so the CTA is consistent on switch, not just refocus.
						void queryClient.invalidateQueries({
							predicate: (q) => q.queryKey[0] === "workspaceForgeActionStatus",
							refetchType: "all",
						});
						clearLifecycle(workspaceId);
					});
				}
			} catch (error) {
				console.error("[commitButton] Failed to start session:", error);
				pushToast?.(
					getErrorMessage(error, translateSource("commitUnableStartAction")),
					getActionFailureTitle(mode, changeRequestName),
					"destructive",
				);
				patchLifecycle(workspaceId, (current) => ({
					...current,
					phase: "error",
				}));
			}
		},
		[
			onSelectSession,
			pushToast,
			changeRequestName,
			providerName,
			queryClient,
			selectedRepoId,
			selectedWorkspaceTargetBranch,
			selectedWorkspaceRemote,
			getSelectedWorkspaceId,
			requestMergeConfirmation,
			beginLifecycle,
			patchLifecycle,
			clearLifecycle,
		],
	);

	const queuePendingPromptForSession = useCallback(
		(request: PendingPromptForSession) => {
			// A terminal session has no GUI send pipeline, and injecting text
			// into its TUI is unreliable (mid-turn, permission dialogs,
			// half-typed user input). Host-triggered prompts open a fresh GUI
			// session in the same workspace instead.
			const workspaceId = getSelectedWorkspaceId();
			const target = workspaceId
				? queryClient
						.getQueryData<WorkspaceSessionSummary[]>(
							helmorQueryKeys.workspaceSessions(workspaceId),
						)
						?.find((session) => session.id === request.sessionId)
				: undefined;
			if (target?.sessionKind === "terminal" && workspaceId) {
				void (async () => {
					try {
						const { sessionId } = await createSession(workspaceId);
						await queryClient.invalidateQueries({
							queryKey: helmorQueryKeys.workspaceSessions(workspaceId),
						});
						setPendingPromptForSession({ ...request, sessionId });
						onSelectSession(sessionId);
					} catch (error) {
						console.error(
							"[pendingPrompt] failed to open a chat session for a terminal target:",
							error,
						);
						pushToast?.(
							getErrorMessage(
								error,
								translateSource("commitUnableOpenChatSession"),
							),
							translateSource("commitPromptNotDelivered"),
							"destructive",
						);
					}
				})();
				return;
			}
			setPendingPromptForSession(request);
		},
		[getSelectedWorkspaceId, onSelectSession, pushToast, queryClient],
	);

	const handleInspectorReviewAction = useCallback(
		async ({
			modelId,
			provider,
			effort,
			fastMode,
		}: {
			modelId: string | null;
			/** Provider of the review model — pinned as agent_type. */
			provider?: string | null;
			effort?: string | null;
			fastMode?: boolean | null;
		}) => {
			const workspaceId = getSelectedWorkspaceId();
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
					model: modelId,
					agentType: provider ?? null,
					effortLevel: effort ?? null,
					fastMode: fastMode ?? null,
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
				setPendingPromptForSession({ sessionId, prompt });
				onSelectSession(sessionId);
			} catch (error) {
				console.error("[review] failed to start session:", error);
				pushToast?.(
					getErrorMessage(error, translateSource("commitUnableStartReview")),
					translateSource("commitReviewFailed"),
					"destructive",
				);
			}
		},
		[
			onSelectSession,
			pushToast,
			queryClient,
			selectedRepoId,
			getSelectedWorkspaceId,
			selectedWorkspaceTargetBranch,
			selectedWorkspaceRemote,
		],
	);

	const pendingPromptRef = useRef(pendingPromptForSession);
	pendingPromptRef.current = pendingPromptForSession;

	const handlePendingPromptConsumed = useCallback(() => {
		console.log("[commitButton] pending prompt consumed by composer");
		const consumedSessionId = pendingPromptRef.current?.sessionId ?? null;
		setPendingPromptForSession(null);
		if (!consumedSessionId) return;
		// Only flip the lifecycle whose session the composer just picked up —
		// a sibling workspace mid-dispatch must not be dragged to "streaming".
		setCommitLifecycles((prev) => {
			let changed = false;
			const next = new Map(prev);
			for (const [workspaceId, lc] of prev) {
				if (
					lc.trackedSessionId === consumedSessionId &&
					lc.phase === "creating"
				) {
					next.set(workspaceId, { ...lc, phase: "streaming" });
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, []);

	const commitLifecyclesRef = useRef(commitLifecycles);
	commitLifecyclesRef.current = commitLifecycles;
	// Per-workspace settle tracking (observed-streaming + handled session),
	// keyed by workspaceId. Refs, so mutating them never re-renders.
	const actionTrackingRef = useRef<Map<string, ActionTracking>>(new Map());

	useEffect(() => {
		// Settle EVERY in-flight action, not just the selected workspace's —
		// concurrent Create-PRs each need their own completion side effects.
		for (const [workspaceId, lc] of commitLifecyclesRef.current) {
			if (!lc.trackedSessionId) continue;
			if (lc.phase !== "creating" && lc.phase !== "streaming") continue;

			const trackedSessionId = lc.trackedSessionId;
			const tracking = actionTrackingRef.current.get(workspaceId) ?? {
				observedSending: false,
				handledSessionId: null,
			};

			// Aborted sessions clear the lifecycle — no PR was created, so the
			// button returns to idle rather than proceeding to verify.
			if (abortedSessionIds?.has(trackedSessionId)) {
				console.log(
					"[commitButton] tracked session aborted — clearing lifecycle",
					workspaceId,
				);
				actionTrackingRef.current.delete(workspaceId);
				clearLifecycle(workspaceId);
				continue;
			}

			if (busySessionIds.has(trackedSessionId)) {
				tracking.observedSending = true;
				actionTrackingRef.current.set(workspaceId, tracking);
				continue;
			}

			if (!tracking.observedSending) continue;
			if (!completedSessionIds.has(trackedSessionId)) continue;
			if (interactionRequiredSessionIds.has(trackedSessionId)) continue;
			if (tracking.handledSessionId === trackedSessionId) continue;

			console.log(
				"[commitButton] tracked session completed and settled — verifying",
				workspaceId,
			);
			tracking.observedSending = false;
			tracking.handledSessionId = trackedSessionId;
			actionTrackingRef.current.set(workspaceId, tracking);
			patchLifecycle(workspaceId, (prev) => ({ ...prev, phase: "verifying" }));

			const mode = lc.mode;
			void (async () => {
				try {
					const currentChangeRequest =
						await refreshWorkspaceChangeRequest(workspaceId);
					console.log(
						"[commitButton] refreshWorkspaceChangeRequest result",
						workspaceId,
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
					patchLifecycle(workspaceId, (prev) => ({
						...prev,
						phase: "done",
						changeRequest: currentChangeRequest ?? null,
					}));
					refreshWorkspaceRemoteStatus(workspaceId);
				} catch (error) {
					console.error("[commitButton] PR lookup failed:", error);
					pushToast?.(
						getErrorMessage(
							error,
							translateSource("commitUnableVerifyActionResult"),
						),
						getActionFailureTitle(mode, changeRequestName),
						"destructive",
					);
					patchLifecycle(workspaceId, (prev) => ({
						...prev,
						phase: "error",
					}));
				}
			})();
		}
	}, [
		changeRequestName,
		completedSessionIds,
		abortedSessionIds,
		interactionRequiredSessionIds,
		pushToast,
		queryClient,
		refreshWorkspaceRemoteStatus,
		busySessionIds,
		clearLifecycle,
		patchLifecycle,
	]);

	// Done-phase side effects (auto-close) run once per lifecycle instance; the
	// dismiss timer reschedules if the phase flips (done → error) so the error
	// state still gets its longer display window. Keyed by lifecycle id so a
	// later action on the same workspace can't be dismissed by a stale timer.
	const donePhaseHandledRef = useRef<Set<number>>(new Set());
	const dismissStateRef = useRef<Map<number, { phase: string; timer: number }>>(
		new Map(),
	);

	useEffect(() => {
		for (const [workspaceId, lc] of commitLifecycles) {
			if (lc.phase !== "done" && lc.phase !== "error") continue;
			const prevDismiss = dismissStateRef.current.get(lc.id);
			if (prevDismiss && prevDismiss.phase === lc.phase) continue;

			const { phase, mode, trackedSessionId, id } = lc;

			if (phase === "done" && !donePhaseHandledRef.current.has(id)) {
				donePhaseHandledRef.current.add(id);
				if (mode !== "merge" && mode !== "closed") {
					refreshWorkspaceRemoteStatus(workspaceId);
				}
				queryClient.invalidateQueries({ queryKey: ["workspaceChanges"] });

				void (async () => {
					try {
						if (!trackedSessionId) return;
						if (mode === "checks-running" || mode === "merge-blocked") return;
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
						// Never hijack selection when the user has navigated to another
						// workspace — the cached detail there is stale anyway (inactive
						// queries don't refetch, so activeSessionId may still point at
						// the session we just hid).
						if (getSelectedWorkspaceIdRef.current() !== workspaceId) return;
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

			if (prevDismiss) window.clearTimeout(prevDismiss.timer);
			const timer = window.setTimeout(
				() => {
					dismissStateRef.current.delete(id);
					donePhaseHandledRef.current.delete(id);
					actionTrackingRef.current.delete(workspaceId);
					patchLifecycle(workspaceId, (prev) => (prev.id === id ? null : prev));
				},
				phase === "done" ? 1200 : 1600,
			);
			dismissStateRef.current.set(id, { phase, timer });
		}
	}, [
		commitLifecycles,
		onSelectSession,
		queryClient,
		refreshWorkspaceRemoteStatus,
		patchLifecycle,
	]);

	// Clear any in-flight dismiss timers on unmount.
	useEffect(() => {
		const timers = dismissStateRef.current;
		return () => {
			for (const { timer } of timers.values()) window.clearTimeout(timer);
			timers.clear();
		};
	}, []);

	// The button only ever reflects the selected workspace's in-flight action;
	// sibling lifecycles still settle (refresh + auto-close) in the effects above.
	const activeLifecycle =
		(selectedWorkspaceId
			? commitLifecycles.get(selectedWorkspaceId)
			: undefined) ?? null;

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
		mergeConfirmDialogNode,
		pendingPromptForSession,
		queuePendingPromptForSession,
	};
}
