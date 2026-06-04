import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SerializedEditorState } from "lexical";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import { useShallow } from "zustand/react/shallow";
import type { StartSubmitMode } from "@/features/composer/start-submit-mode";
import type { PendingUserInput } from "@/features/conversation/pending-user-input";
import {
	type PendingPermission as StorePendingPermission,
	useStreamingStore,
} from "@/features/conversation/state/streaming-store";
import type {
	ActiveStreamSummary,
	AgentModelOption,
	CodexGoalState,
} from "@/lib/api";
import {
	findProviderCapabilities,
	generateSessionTitle,
	loadRepoPreferences,
	mutateCodexGoal,
	renameSession,
	respondToPermissionRequest,
	respondToUserInput,
	startAgentMessageStream,
	steerAgentStream,
	stopAgentStream,
} from "@/lib/api";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import { extractError, isRecoverableByPurge } from "@/lib/errors";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	providerCapabilitiesQueryOptions,
	sessionThreadMessagesQueryOptions,
} from "@/lib/query-client";
import { resolveGeneralPreferencePrefix } from "@/lib/repo-preferences-prompts";
import {
	appendUserMessage,
	readSessionThread,
	restoreSnapshot,
	type SessionThreadSnapshot,
} from "@/lib/session-thread-cache";
import type { FollowUpBehavior } from "@/lib/settings";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import type { SubmitQueueApi } from "@/lib/use-submit-queue";
import { showWorkspaceBrokenToast } from "@/lib/workspace-broken-toast";
import {
	createLiveThreadMessage,
	findModelOption,
} from "@/lib/workspace-helpers";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import {
	createStreamEventDispatcher,
	createStreamFlushers,
	type StreamAccumulator,
} from "./dispatch-stream-event";
import { seedSessionTitle } from "./seed-session-title";

const EMPTY_IMAGES: string[] = [];
const EMPTY_FILES: string[] = [];

function buildTitleSeed(prompt: string): string {
	const normalized = prompt
		.trim()
		.split(/\r?\n/g)[0]
		?.trim()
		.replace(/\s+/g, " ");

	if (!normalized) {
		return "Untitled";
	}

	if (normalized.length <= 36) {
		return normalized;
	}

	return `${normalized.slice(0, 33).trimEnd()}...`;
}

/**
 * Re-export from the streaming store — kept here so existing import
 * sites in panels / composer don't have to change paths.
 */
export type PendingPermission = StorePendingPermission;

const EMPTY_PENDING_PERMISSIONS: readonly PendingPermission[] = Object.freeze(
	[],
);

type SubmitPayload = {
	prompt: string;
	imagePaths: string[];
	filePaths: string[];
	customTags: ComposerCustomTag[];
	model: AgentModelOption;
	workingDirectory: string | null;
	effortLevel: string;
	permissionMode: string;
	fastMode: boolean;
	/** When true, route to the follow-up queue instead of steering if a
	 *  turn is already streaming — regardless of the user's
	 *  `followUpBehavior` setting. Set by host-triggered submits (e.g.
	 *  git-pull conflict resolution) that must never interrupt the turn. */
	forceQueue?: boolean;
	/** Per-submit override for `followUpBehavior` — used by the composer's
	 *  "send with opposite follow-up" shortcut. Ignored when `forceQueue`
	 *  is set. */
	followUpBehaviorOverride?: FollowUpBehavior;
	startSubmitMode?: StartSubmitMode;
	/** Snapshot of the editor's full Lexical state at submit time. Captured
	 *  synchronously inside the composer so callers that need to round-trip
	 *  chips/text/images (e.g. the start-composer "backlog" handler that
	 *  copies the draft to a freshly-created session) can do so without
	 *  losing the badge nodes that a plain prompt-string would discard. */
	editorStateSnapshot?: SerializedEditorState;
	/** Composer's pre-allocated UUID. StartPage submit forwards it to
	 *  `prepareChatWorkspace` / `prepareWorkspaceFromRepo` as
	 *  `seedSessionId`; other paths ignore it. */
	provisionalSessionId?: string;
};

export type ComposerSubmitPayload = SubmitPayload;

type UseConversationStreamingArgs = {
	composerContextKey: string;
	displayedSessionId: string | null;
	displayedWorkspaceId: string | null;
	repoId?: string | null;
	displayedSelectedModelId: string | null;
	selectionPending: boolean;
	/** Follow-up behavior when submitting while the agent is already
	 *  responding: `'queue'` stashes the message locally to auto-fire
	 *  as a new turn once the agent finishes; `'steer'` injects into
	 *  the active turn (provider-native mid-turn steer). */
	followUpBehavior: FollowUpBehavior;
	/** App-level queue handle (read + mutate). Shared across session /
	 *  workspace switches so the queue survives navigation. */
	submitQueue: SubmitQueueApi;
	/** Backend-truth active-streams snapshot, owned by App. Drives
	 *  follow-up routing and the queue-drain trigger; survives this
	 *  hook's unmount/remount. */
	activeStreams: readonly ActiveStreamSummary[];
	onInteractionSessionsChange?: (
		sessionWorkspaceMap: Map<string, string>,
		interactionCounts: Map<string, number>,
	) => void;
	onSessionCompleted?: (sessionId: string, workspaceId: string) => void;
	onSessionAborted?: (sessionId: string, workspaceId: string) => void;
};

export function useConversationStreaming({
	composerContextKey,
	displayedSessionId,
	displayedWorkspaceId,
	repoId,
	displayedSelectedModelId,
	selectionPending,
	followUpBehavior,
	submitQueue,
	activeStreams,
	onInteractionSessionsChange,
	onSessionCompleted,
	onSessionAborted,
}: UseConversationStreamingArgs) {
	const queryClient = useQueryClient();
	const pushToast = useWorkspaceToast();
	// All per-context state lives in the module-level Zustand store so the
	// stream's Tauri Channel callback keeps writing to a target that
	// outlives every component unmount / remount. The hook subscribes via
	// selectors below; mutations go through `streamingStore.<action>()`.
	const streamingStore = useStreamingStore;
	// Cross-context slices the interaction-tracking effect / queue / steer
	// fallback read off; `useShallow` keeps these stable for the deps lists.
	const pendingPermissionsByContext = useStreamingStore(
		(state) => state.pendingPermissionsByContext,
	);
	const pendingUserInputByContext = useStreamingStore(
		(state) => state.pendingUserInputByContext,
	);
	const planReviewByContext = useStreamingStore(
		(state) => state.planReviewByContext,
	);
	const interactionWorkspaceByContext = useStreamingStore(
		(state) => state.interactionWorkspaceByContext,
	);
	const sendingContextKeys = useStreamingStore(
		(state) => state.sendingContextKeys,
	);
	const activeFastPreludes = useStreamingStore(
		(state) => state.activeFastPreludes,
	);
	const activeSendError = useStreamingStore(
		(state) => state.sendErrorsByContext[composerContextKey] ?? null,
	);
	const pendingUserInput = useStreamingStore(
		(state) => state.pendingUserInputByContext[composerContextKey] ?? null,
	);
	const userInputResponsePending = useStreamingStore(
		(state) =>
			state.userInputResponsePendingByContext[composerContextKey] ?? false,
	);
	const composerRestoreState = useStreamingStore(
		(state) => state.composerRestore,
	);
	// Action handles. `useShallow` keeps the returned object reference
	// stable so handlers below don't churn their deps every keystroke.
	const storeActions = useStreamingStore(
		useShallow((state) => ({
			setPendingUserInput: state.setPendingUserInput,
			clearPendingUserInput: state.clearPendingUserInput,
			setUserInputResponsePending: state.setUserInputResponsePending,
			appendPendingPermission: state.appendPendingPermission,
			removePendingPermission: state.removePendingPermission,
			clearPendingPermissions: state.clearPendingPermissions,
			markSendingState: state.markSendingState,
			clearSendingState: state.clearSendingState,
			setSendError: state.setSendError,
			setActiveSession: state.setActiveSession,
			clearActiveSession: state.clearActiveSession,
			setLiveSession: state.setLiveSession,
			rememberInteractionWorkspace: state.rememberInteractionWorkspace,
			setPlanReviewActive: state.setPlanReviewActive,
			clearPlanReview: state.clearPlanReview,
			setFastPreludeActive: state.setFastPreludeActive,
			clearFastPrelude: state.clearFastPrelude,
			setComposerRestore: state.setComposerRestore,
		})),
	);
	// Hook-local ref. Maps contextKey → workspaceId captured at send-start;
	// the interaction-tracking effect uses it as a fallback when
	// `interactionWorkspaceByContext` hasn't been populated yet.
	const sendingWorkspaceMapRef = useRef<Map<string, string>>(new Map());
	const isSending = sendingContextKeys.has(composerContextKey);
	const pendingPermissions =
		pendingPermissionsByContext[composerContextKey] ??
		EMPTY_PENDING_PERMISSIONS;
	const hasPlanReview = planReviewByContext[composerContextKey] ?? false;

	const seedSessionTitleCallback = useCallback(
		(sessionId: string, workspaceId: string | null, title: string) => {
			seedSessionTitle(queryClient, sessionId, workspaceId, title);
		},
		[queryClient],
	);

	const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
	// Provider capability table — looked up in `handleStop` to decide
	// whether the active provider has a long-running goal loop that
	// needs an out-of-band pause before the abort. Backed by a
	// synchronous local default (`initialData`) so a cold start never
	// reads stale flags, with a cheap background refetch to reconcile
	// against the live Rust table; reads here are a ref-cell lookup.
	const providerCapabilitiesQuery = useQuery(
		providerCapabilitiesQueryOptions(),
	);
	const providerCapabilitiesTable = providerCapabilitiesQuery.data ?? null;
	// Value-stable fingerprint for effects that only care about the set
	// of active session ids, not the array's reference.
	const activeSessionIdsKey = useMemo(
		() =>
			activeStreams
				.map((stream) => stream.sessionId)
				.sort()
				.join("\n"),
		[activeStreams],
	);
	const selectedProvider = useMemo(() => {
		if (!displayedSelectedModelId) return null;
		const sections = modelSectionsQuery.data ?? [];
		return (
			findModelOption(sections, displayedSelectedModelId)?.provider ?? null
		);
	}, [displayedSelectedModelId, modelSectionsQuery.data]);

	const busySessionIds = useMemo(() => {
		const ids = new Set<string>();
		for (const key of sendingContextKeys) {
			if (key.startsWith("session:")) {
				ids.add(key.slice(8));
			}
		}
		return ids;
	}, [sendingContextKeys]);

	const onInteractionSessionsChangeRef = useRef(onInteractionSessionsChange);
	onInteractionSessionsChangeRef.current = onInteractionSessionsChange;
	const onSessionCompletedRef = useRef(onSessionCompleted);
	onSessionCompletedRef.current = onSessionCompleted;
	const onSessionAbortedRef = useRef(onSessionAborted);
	onSessionAbortedRef.current = onSessionAborted;
	useLayoutEffect(() => {
		const interactionSessions = new Map<string, string>();
		const interactionCounts = new Map<string, number>();

		const resolveWorkspace = (contextKey: string): string | null =>
			interactionWorkspaceByContext[contextKey] ??
			sendingWorkspaceMapRef.current.get(contextKey) ??
			null;

		for (const [contextKey, permissions] of Object.entries(
			pendingPermissionsByContext,
		)) {
			if (permissions.length === 0 || !contextKey.startsWith("session:")) {
				continue;
			}
			const workspaceId = resolveWorkspace(contextKey);
			if (!workspaceId) continue;
			const sessionId = contextKey.slice(8);
			interactionSessions.set(sessionId, workspaceId);
			interactionCounts.set(
				sessionId,
				(interactionCounts.get(sessionId) ?? 0) + permissions.length,
			);
		}

		for (const [contextKey, userInput] of Object.entries(
			pendingUserInputByContext,
		)) {
			if (!userInput || !contextKey.startsWith("session:")) {
				continue;
			}
			const workspaceId = resolveWorkspace(contextKey);
			if (!workspaceId) continue;
			const sessionId = contextKey.slice(8);
			interactionSessions.set(sessionId, workspaceId);
			interactionCounts.set(
				sessionId,
				(interactionCounts.get(sessionId) ?? 0) + 1,
			);
		}

		for (const [contextKey, active] of Object.entries(planReviewByContext)) {
			if (!active || !contextKey.startsWith("session:")) {
				continue;
			}
			const workspaceId = resolveWorkspace(contextKey);
			if (!workspaceId) continue;
			const sessionId = contextKey.slice(8);
			interactionSessions.set(sessionId, workspaceId);
			interactionCounts.set(
				sessionId,
				(interactionCounts.get(sessionId) ?? 0) + 1,
			);
		}

		onInteractionSessionsChangeRef.current?.(
			interactionSessions,
			interactionCounts,
		);
	}, [
		interactionWorkspaceByContext,
		pendingUserInputByContext,
		pendingPermissionsByContext,
		planReviewByContext,
	]);

	const rememberInteractionWorkspace = useCallback(
		(contextKey: string, workspaceId: string | null | undefined) => {
			if (workspaceId === undefined) {
				return;
			}
			storeActions.rememberInteractionWorkspace(
				contextKey,
				workspaceId ?? null,
			);
		},
		[storeActions],
	);

	const clearPendingPermissions = storeActions.clearPendingPermissions;
	const clearPendingUserInput = storeActions.clearPendingUserInput;
	const clearPlanReview = storeActions.clearPlanReview;
	const setPlanReviewActive = storeActions.setPlanReviewActive;
	const setFastPreludeActive = storeActions.setFastPreludeActive;
	const clearFastPrelude = storeActions.clearFastPrelude;
	const appendPendingPermission = storeActions.appendPendingPermission;

	const handleStopStream = useCallback(async () => {
		// Source of truth: the backend's active-streams registry,
		// mirrored via React Query. Looking up by displayed session id
		// (rather than `activeSessionByContext`) keeps abort working
		// after a conversation-container unmount/remount, which used to
		// silently drop the click.
		const sessionId = composerContextKey.startsWith("session:")
			? composerContextKey.slice("session:".length)
			: null;
		if (!sessionId) {
			return;
		}
		const activeStream = activeStreams.find(
			(stream) => stream.sessionId === sessionId,
		);
		// Fall back to the local registry only when the backend hasn't
		// surfaced the stream yet (e.g. the optimistic phase of a
		// freshly-started turn). This is purely belt-and-suspenders —
		// the active-streams event lands on the same tick as registration.
		const provider =
			activeStream?.provider ??
			streamingStore.getState().activeSessionByContext[composerContextKey]
				?.provider ??
			null;
		if (!provider) {
			return;
		}

		// For providers with a long-running goal loop, flip the goal to
		// paused FIRST so the provider doesn't auto-spawn a fresh
		// continuation turn the moment we abort the current one.
		// Sequential: mutate -> stop, so the child is still alive when
		// mutateCodexGoal needs it. (mutateCodexGoal is best-effort on
		// the sidecar side too — if a race somehow kills the child
		// first it just no-ops.) The user resumes by typing
		// `/goal resume`.
		const caps = findProviderCapabilities(
			providerCapabilitiesTable ?? [],
			provider,
		);
		if (caps?.supportsActiveGoal) {
			const goal = queryClient.getQueryData<CodexGoalState | null>(
				helmorQueryKeys.sessionCodexGoal(sessionId),
			);
			if (goal && goal.status === "active") {
				try {
					await mutateCodexGoal(sessionId, "pause");
				} catch {
					// Surfaced via toast inside mutateCodexGoal already; don't
					// block the abort.
				}
			}
		}
		await stopAgentStream(sessionId, provider);
		// Deps reconcile main's store-backed `handleStopStream` (reads
		// `streamingStore.getState()` — `activeSessionByContext` is no
		// longer a local binding) with this PR's capability lookup, which
		// adds `providerCapabilitiesTable`.
	}, [
		activeStreams,
		composerContextKey,
		providerCapabilitiesTable,
		queryClient,
		streamingStore,
	]);

	const handlePermissionResponse = useCallback(
		(
			permissionId: string,
			behavior: "allow" | "deny",
			options?: { updatedPermissions?: unknown[]; message?: string },
		) => {
			storeActions.removePendingPermission(composerContextKey, permissionId);
			respondToPermissionRequest(permissionId, behavior, options).catch((err) =>
				console.error("[helmor] permission response:", err),
			);
		},
		[composerContextKey, storeActions],
	);

	// `sendingContextKeys` lives in the store now so the cross-app "this
	// session is busy" signal survives container unmounts. Local helpers
	// here just thread the workspace-tracking ref in lock-step.
	const markSendingState = useCallback(
		(contextKey: string, workspaceId: string | null | undefined) => {
			if (workspaceId) {
				sendingWorkspaceMapRef.current.set(contextKey, workspaceId);
			}
			storeActions.markSendingState(contextKey);
		},
		[storeActions],
	);

	const pauseSendingState = useCallback(
		(contextKey: string) => {
			sendingWorkspaceMapRef.current.delete(contextKey);
			storeActions.clearSendingState(contextKey);
		},
		[storeActions],
	);

	const clearSendingState = useCallback(
		(contextKey: string) => {
			storeActions.clearActiveSession(contextKey);
			pauseSendingState(contextKey);
		},
		[pauseSendingState, storeActions],
	);

	const invalidateConversationQueries = useCallback(
		async (workspaceId: string | null, sessionId: string | null) => {
			requestSidebarReconcile(queryClient);
			const invalidations: Promise<unknown>[] = [];

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

			if (sessionId) {
				invalidations.push(
					queryClient.invalidateQueries({
						queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread"],
					}),
				);
			}

			await Promise.all(invalidations);
		},
		[queryClient],
	);

	const refreshSessionThreadFromDb = useCallback(
		(sessionId: string | null) => {
			if (!sessionId) {
				return;
			}

			void queryClient
				.fetchQuery({
					...sessionThreadMessagesQueryOptions(sessionId),
					staleTime: 0,
				})
				.catch((error) => {
					console.error("[conversation] refresh session thread:", error);
				});
		},
		[queryClient],
	);

	const applyUserInputEvent = useCallback(
		(contextKey: string, event: PendingUserInput) => {
			clearPendingPermissions(contextKey);
			storeActions.setPendingUserInput(contextKey, event);
			storeActions.setUserInputResponsePending(contextKey, false);
			const previousSessionId =
				streamingStore.getState().liveSessionsByContext[contextKey]
					?.providerSessionId ?? null;
			storeActions.setLiveSession(contextKey, {
				provider: event.provider,
				providerSessionId: event.providerSessionId ?? previousSessionId,
			});
			pauseSendingState(contextKey);
		},
		[clearPendingPermissions, pauseSendingState, storeActions, streamingStore],
	);

	/**
	 * Unified user-input response. The sidecar's parked SDK callback
	 * (canUseTool for AskUserQuestion, onElicitation for MCP, Codex's
	 * `requestUserInput` JSON-RPC handler) resolves over the same live
	 * stream — no new query() / no new process. The original
	 * `startAgentMessageStream` event callback set up in
	 * `handleComposerSubmit` stays wired and receives the follow-on
	 * `update` / `streamingPartial` / next `userInputRequest` / `done`
	 * events on the same channel.
	 */
	const handleUserInputResponse = useCallback(
		async (
			userInput: PendingUserInput,
			action: "submit" | "decline" | "cancel",
			options?: {
				content?: Record<string, unknown>;
				meta?: Record<string, unknown>;
			},
		) => {
			if (!displayedSessionId) return;
			const contextKey = composerContextKey;

			storeActions.setPendingUserInput(contextKey, null);
			clearPendingPermissions(contextKey);
			storeActions.setSendError(contextKey, null);
			storeActions.setUserInputResponsePending(contextKey, true);
			rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
			markSendingState(contextKey, displayedWorkspaceId);

			try {
				await respondToUserInput(
					userInput.userInputId,
					action,
					options?.content,
					options?.meta,
				);
				storeActions.setUserInputResponsePending(contextKey, false);
			} catch (error) {
				console.error("[conversation] user-input response:", error);
				const { code, message: errorMsg } = extractError(
					error,
					"Failed to deliver user-input response.",
				);
				if (isRecoverableByPurge(code) && displayedWorkspaceId) {
					showWorkspaceBrokenToast({
						workspaceId: displayedWorkspaceId,
						pushToast,
						queryClient,
					});
				}
				storeActions.setPendingUserInput(contextKey, userInput);
				storeActions.setUserInputResponsePending(contextKey, false);
				storeActions.setSendError(contextKey, errorMsg);
				clearSendingState(contextKey);
			}
		},
		[
			clearSendingState,
			clearPendingPermissions,
			storeActions,
			composerContextKey,
			displayedSessionId,
			displayedWorkspaceId,
			markSendingState,
			pushToast,
			queryClient,
			rememberInteractionWorkspace,
		],
	);

	const handleComposerSubmit = useCallback(
		async (
			{
				prompt,
				imagePaths,
				filePaths,
				customTags,
				model,
				workingDirectory,
				effortLevel,
				permissionMode,
				fastMode,
				forceQueue,
				followUpBehaviorOverride,
				editorStateSnapshot,
			}: SubmitPayload,
			// Override for drain / queued-steer. When present, all
			// session/workspace lookups use the override instead of the
			// currently displayed view. This is how a queued message from
			// session A fires against A even when the user has since
			// navigated to session B.
			override?: {
				sessionId: string;
				workspaceId: string | null;
				contextKey: string;
			},
		) => {
			const isOverride = override !== undefined;
			const targetSessionId = override?.sessionId ?? displayedSessionId;
			const targetWorkspaceId = override?.workspaceId ?? displayedWorkspaceId;
			const targetContextKey = override?.contextKey ?? composerContextKey;

			const trimmedPrompt = prompt.trim();
			// `selectionPending` is a UI-only guard (user clicked a session
			// that hasn't loaded yet); drain / queued-steer bypass it.
			if (
				!trimmedPrompt ||
				(!isOverride && selectionPending) ||
				!targetSessionId
			) {
				return;
			}

			const contextKey = targetContextKey;

			// Follow-up branch: stream still alive → steer or queue.
			// `activeStreams` is the source of truth (survives remount);
			// `activeSessionByContext` is the optimistic fast-path for the
			// in-flight register window. Plan-review = abandon plan.
			const localLiveStream =
				streamingStore.getState().activeSessionByContext[contextKey];
			const backendLiveStream = activeStreams.find(
				(stream) => stream.sessionId === targetSessionId,
			);
			const liveStream =
				localLiveStream ??
				(backendLiveStream
					? {
							stopSessionId: targetSessionId,
							provider: backendLiveStream.provider,
						}
					: null);
			const hasPlanReviewForContext = planReviewByContext[contextKey] ?? false;
			if (liveStream && !hasPlanReviewForContext) {
				// `forceQueue` is a caller-supplied override that pins
				// the routing to the queue regardless of the user's
				// `followUpBehavior` setting — used for host-triggered
				// prompts (e.g. git-pull) that must never steer.
				// `followUpBehaviorOverride` is the per-submit "opposite"
				// flip from the composer shortcut; subordinate to forceQueue.
				const effectiveBehavior = forceQueue
					? "queue"
					: (followUpBehaviorOverride ?? followUpBehavior);
				if (effectiveBehavior === "queue" && !isOverride) {
					// App-level queue: capture the current (session,
					// workspace, contextKey) so drain can replay faithfully
					// even if the user has navigated away. Without this,
					// a queued message from session A would fire into
					// whatever session is currently displayed.
					submitQueue.enqueue(
						{
							sessionId: targetSessionId,
							workspaceId: targetWorkspaceId,
							contextKey: targetContextKey,
						},
						{
							prompt: trimmedPrompt,
							imagePaths,
							filePaths,
							customTags,
							model,
							workingDirectory,
							effortLevel,
							permissionMode,
							fastMode,
							editorStateSnapshot,
						},
					);
					storeActions.setComposerRestore(null);
					return;
				}

				// Real mid-turn steer. The sidecar routes to the provider's
				// native steer API AND (only after provider ack) emits a
				// `user_prompt` passthrough event into the active stream.
				// The accumulator picks that up, splits the assistant turn,
				// and streaming.rs persists via `persist_turn_message` —
				// one event, one DB row, no separate persistence path.
				const cacheSessionId = targetSessionId;
				const steerMessageId = crypto.randomUUID();
				const optimisticSteer = createLiveThreadMessage({
					id: steerMessageId,
					role: "user",
					text: trimmedPrompt,
					createdAt: new Date().toISOString(),
					files: filePaths,
					images: imagePaths,
				});
				const rollback = appendUserMessage(
					queryClient,
					cacheSessionId,
					optimisticSteer,
				);
				storeActions.setComposerRestore(null);

				// Composer clears its editor synchronously after onSubmit.
				// On steer failure we must seed `composerRestoreState` with
				// the draft so the user's input isn't silently lost — same
				// contract the normal send path upholds on its error path.
				// Skip when this is a drain / queued-steer (isOverride): the
				// composer the user currently sees may belong to a different
				// session, and restoring the draft there would be confusing.
				const restoreDraftOnFailure = () => {
					restoreSnapshot(queryClient, cacheSessionId, rollback);
					if (isOverride) return;
					storeActions.setComposerRestore({
						contextKey,
						draft: trimmedPrompt,
						images: imagePaths,
						files: filePaths,
						customTags,
						editorState: editorStateSnapshot ?? null,
						nonce: Date.now(),
					});
				};

				try {
					const response = await steerAgentStream({
						sessionId: liveStream.stopSessionId,
						provider: liveStream.provider,
						prompt: trimmedPrompt,
						files: filePaths,
						images: imagePaths,
					});
					if (!response.accepted) {
						// Turn already completed / provider rejected —
						// restore the draft so the user can resend it as
						// a fresh turn (or edit before resending).
						restoreDraftOnFailure();
						if (response.reason) {
							storeActions.setSendError(
								contextKey,
								`Steer rejected: ${response.reason}`,
							);
						}
					}
					return;
				} catch (err) {
					console.warn("[conversation] steer failed:", err);
					restoreDraftOnFailure();
					storeActions.setSendError(
						contextKey,
						err instanceof Error ? err.message : String(err),
					);
					return;
				}
			}

			const previousLiveSession =
				streamingStore.getState().liveSessionsByContext[contextKey];
			const providerSessionId =
				previousLiveSession?.provider === model.provider
					? (previousLiveSession.providerSessionId ?? undefined)
					: undefined;
			// Always use the real session ID — never fall back to a
			// workspace-level contextKey, which would share cache entries
			// across sessions and leak provider session IDs on resume.
			const cacheSessionId = targetSessionId;
			const currentThread = readSessionThread(queryClient, cacheSessionId);
			const currentSessions = targetWorkspaceId
				? queryClient.getQueryData<Array<Record<string, unknown>>>(
						helmorQueryKeys.workspaceSessions(targetWorkspaceId),
					)
				: undefined;
			const currentSession = currentSessions?.find(
				(session) => session.id === targetSessionId,
			);
			const currentTitle =
				typeof currentSession?.title === "string"
					? currentSession.title
					: undefined;
			const isCompactCommand = trimmedPrompt === "/compact";
			const isFirstUserMessage =
				(currentThread ?? []).every((message) => message.role !== "user") &&
				(currentTitle == null || currentTitle === "Untitled");
			const repoPreferences = repoId ? await loadRepoPreferences(repoId) : null;
			// The general-preference preamble is prepended ONLY on the wire
			// to the agent (Rust side stitches it onto `prompt_prefix`).
			// `trimmedPrompt` is what the user typed — that's what we
			// optimistically render in the chat bubble and what the Rust
			// side persists to `session_messages` as the user_prompt body.
			const promptPrefix =
				isFirstUserMessage && !isCompactCommand
					? resolveGeneralPreferencePrefix(repoPreferences)
					: null;
			const now = new Date().toISOString();
			const userMessageId = crypto.randomUUID();
			const optimisticUserMessage = createLiveThreadMessage({
				id: userMessageId,
				role: "user",
				text: trimmedPrompt,
				createdAt: now,
				files: filePaths,
				images: imagePaths,
			});
			let titleSeed: string | null = null;
			if (isFirstUserMessage && !isCompactCommand) {
				titleSeed = buildTitleSeed(trimmedPrompt);
				seedSessionTitleCallback(targetSessionId, targetWorkspaceId, titleSeed);
				void renameSession(targetSessionId, titleSeed).catch((error) => {
					console.warn("[conversation] failed to seed session title:", error);
				});
			}
			const rollbackSnapshot: SessionThreadSnapshot = appendUserMessage(
				queryClient,
				cacheSessionId,
				optimisticUserMessage,
			);
			if (!isOverride) {
				storeActions.setComposerRestore(null);
			}
			storeActions.setSendError(contextKey, null);
			clearPendingPermissions(contextKey);
			clearPlanReview(contextKey);
			storeActions.setPendingUserInput(contextKey, null);
			clearPendingUserInput(contextKey);
			rememberInteractionWorkspace(contextKey, targetWorkspaceId);
			markSendingState(contextKey, targetWorkspaceId);
			if (fastMode) {
				setFastPreludeActive(contextKey);
			} else {
				clearFastPrelude(contextKey);
			}

			try {
				if (targetSessionId) {
					void generateSessionTitle(
						targetSessionId,
						trimmedPrompt,
						titleSeed,
					).then((result) => {
						if (result?.title || result?.branchRenamed) {
							requestSidebarReconcile(queryClient);
							void Promise.all([
								targetWorkspaceId
									? queryClient.invalidateQueries({
											queryKey:
												helmorQueryKeys.workspaceSessions(targetWorkspaceId),
										})
									: undefined,
								targetWorkspaceId
									? queryClient.invalidateQueries({
											queryKey:
												helmorQueryKeys.workspaceDetail(targetWorkspaceId),
										})
									: undefined,
							]);
						}
					});
				}

				const stopSessionId = targetSessionId;
				storeActions.setActiveSession(contextKey, {
					stopSessionId,
					provider: model.provider,
				});

				const accumulator: StreamAccumulator = {
					baseMessages: [],
					pendingPartial: null,
					needsFlush: false,
					frameId: null,
				};

				const changesRefreshInterval = window.setInterval(() => {
					if (!workingDirectory) return;
					void queryClient.invalidateQueries({
						queryKey: helmorQueryKeys.workspaceChanges(
							workingDirectory,
							targetWorkspaceId,
						),
					});
				}, 3_000);

				const { flushStreamMessages, scheduleFlush, cleanup } =
					createStreamFlushers({
						accumulator,
						queryClient,
						cacheSessionId,
						userMessageId,
						optimisticUserMessage,
						changesRefreshInterval,
					});

				await startAgentMessageStream(
					{
						provider: model.provider,
						modelId: model.id,
						prompt: trimmedPrompt,
						promptPrefix,
						sessionId: providerSessionId,
						helmorSessionId: targetSessionId,
						workingDirectory,
						effortLevel,
						permissionMode,
						fastMode,
						userMessageId,
						files: filePaths,
						images: imagePaths,
					},
					createStreamEventDispatcher({
						contextKey,
						isOverride,
						targetSessionId,
						targetWorkspaceId,
						cacheSessionId,
						userMessageId,
						trimmedPrompt,
						imagePaths,
						filePaths,
						customTags,
						model,
						optimisticUserMessage,
						rollbackSnapshot,
						accumulator,
						scheduleFlush,
						flushStreamMessages,
						cleanup,
						rememberInteractionWorkspace,
						appendPendingPermission,
						setPlanReviewActive,
						applyUserInputEvent,
						clearPendingPermissions,
						clearPendingUserInput,
						clearFastPrelude,
						clearSendingState,
						invalidateConversationQueries,
						refreshSessionThreadFromDb,
						pushToast,
						onSessionCompleted: onSessionCompletedRef.current,
						onSessionAborted: onSessionAbortedRef.current,
						storeActions: {
							setSendError: storeActions.setSendError,
							setLiveSession: storeActions.setLiveSession,
							setComposerRestore: storeActions.setComposerRestore,
						},
						streamingStore,
						queryClient,
					}),
				);
			} catch (error) {
				console.error("[conversation] invoke error:", error);
				const { code, message: errorMsg } = extractError(
					error,
					"Failed to send message.",
				);
				if (isRecoverableByPurge(code) && displayedWorkspaceId) {
					showWorkspaceBrokenToast({
						workspaceId: displayedWorkspaceId,
						pushToast,
						queryClient,
					});
				}
				storeActions.setSendError(contextKey, errorMsg);
				if (!isOverride) {
					storeActions.setComposerRestore({
						contextKey,
						draft: trimmedPrompt,
						images: imagePaths,
						files: filePaths,
						customTags,
						editorState: editorStateSnapshot ?? null,
						nonce: Date.now(),
					});
				}
				restoreSnapshot(queryClient, cacheSessionId, rollbackSnapshot);
				clearFastPrelude(contextKey);
				clearSendingState(contextKey);
			}
		},
		[
			applyUserInputEvent,
			appendPendingPermission,
			clearSendingState,
			clearPendingUserInput,
			clearPendingPermissions,
			clearFastPrelude,
			composerContextKey,
			displayedSessionId,
			displayedWorkspaceId,
			invalidateConversationQueries,
			markSendingState,
			pushToast,
			queryClient,
			repoId,
			rememberInteractionWorkspace,
			selectionPending,
			refreshSessionThreadFromDb,
			setFastPreludeActive,
			setPlanReviewActive,
			activeStreams,
			planReviewByContext,
			followUpBehavior,
			storeActions,
			streamingStore,
			submitQueue,
		],
	);

	// Queue drain — replay queued entries when a session's backend
	// stream ends. Keys on `activeStreams` (not `sendingContextKeys`,
	// which `userInputRequest` also clears) so pause doesn't trip it.
	// Replay on `setTimeout(0)` so the Done-callback setStates commit
	// first; otherwise the replayed submit reads a stale
	// `activeSessionByContext` and routes back into steer/queue.
	const handleComposerSubmitRef = useRef(handleComposerSubmit);
	handleComposerSubmitRef.current = handleComposerSubmit;
	const activeStreamsRef = useRef(activeStreams);
	activeStreamsRef.current = activeStreams;
	const previousActiveSessionIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const previous = previousActiveSessionIdsRef.current;
		const current = new Set(
			activeStreamsRef.current.map((stream) => stream.sessionId),
		);
		const justEnded: string[] = [];
		for (const sid of previous) {
			if (!current.has(sid)) justEnded.push(sid);
		}
		previousActiveSessionIdsRef.current = current;

		for (const sessionId of justEnded) {
			const next = submitQueue.popNext(sessionId);
			if (!next) continue;
			setTimeout(() => {
				handleComposerSubmitRef.current(next.payload, next.context);
			}, 0);
		}
	}, [activeSessionIdsKey, submitQueue]);

	// Row actions: Steer now / Remove. Both key off the item's stored
	// context (NOT the currently displayed session) so row clicks from
	// session A's queue always target A even if the user has navigated.
	const handleSteerQueued = useCallback(
		async (itemId: string) => {
			const item = submitQueue.findById(itemId);
			if (!item) return;

			const ctx = item.context;
			const liveStream =
				streamingStore.getState().activeSessionByContext[ctx.contextKey] ??
				null;

			if (!liveStream) {
				// No active turn to steer into — the turn must have ended
				// between user click and handler run. Fall back to
				// replaying the payload as a fresh turn so the prompt
				// isn't lost.
				submitQueue.remove(ctx.sessionId, itemId);
				handleComposerSubmitRef.current(item.payload, ctx);
				return;
			}

			// Optimistically remove so the UI reacts instantly; put back
			// on rejection / RPC failure. Without the re-enqueue, a
			// provider-rejected steer silently drops the user's prompt
			// (common race: user clicks Steer just as the turn ends).
			submitQueue.remove(ctx.sessionId, itemId);
			try {
				const response = await steerAgentStream({
					sessionId: liveStream.stopSessionId,
					provider: liveStream.provider,
					prompt: item.payload.prompt,
					files: item.payload.filePaths,
					images: item.payload.imagePaths,
				});
				if (!response.accepted) {
					submitQueue.enqueue(ctx, item.payload);
					storeActions.setSendError(
						ctx.contextKey,
						response.reason
							? `Steer rejected: ${response.reason}`
							: "Steer rejected — added back to the queue.",
					);
				}
			} catch (err) {
				console.warn("[conversation] steer-from-queue failed:", err);
				submitQueue.enqueue(ctx, item.payload);
				storeActions.setSendError(
					ctx.contextKey,
					err instanceof Error ? err.message : String(err),
				);
			}
		},
		[storeActions, streamingStore, submitQueue],
	);

	const handleRemoveQueued = useCallback(
		(itemId: string) => {
			const item = submitQueue.findById(itemId);
			if (!item) return;
			submitQueue.remove(item.context.sessionId, itemId);
		},
		[submitQueue],
	);

	// Edit: pull this row back into the composer and drop it from the
	// queue. Only this row is affected — sibling queued items stay put.
	// Restore prefers the captured Lexical snapshot so badges (image / file
	// / customTag) round-trip exactly as authored; the flattened fields are
	// passed too as a defensive fallback if the snapshot can't be parsed.
	const handleEditQueued = useCallback(
		(itemId: string) => {
			const item = submitQueue.findById(itemId);
			if (!item) return;
			submitQueue.remove(item.context.sessionId, itemId);
			storeActions.setComposerRestore({
				contextKey: item.context.contextKey,
				draft: item.payload.prompt,
				images: item.payload.imagePaths,
				files: item.payload.filePaths,
				customTags: item.payload.customTags,
				editorState: item.payload.editorStateSnapshot ?? null,
				nonce: Date.now(),
			});
		},
		[storeActions, submitQueue],
	);

	const restoreActive = composerRestoreState?.contextKey === composerContextKey;

	return {
		activeSendError,
		activeFastPreludes,
		clearFastPrelude,
		userInputResponsePending,
		handleComposerSubmit,
		handleUserInputResponse,
		handlePermissionResponse,
		handleStopStream,
		handleSteerQueued,
		handleRemoveQueued,
		handleEditQueued,
		hasPlanReview,
		isSending,
		pendingUserInput,
		pendingPermissions,
		restoreCustomTags: restoreActive ? composerRestoreState.customTags : [],
		restoreDraft: restoreActive ? composerRestoreState.draft : null,
		restoreEditorState: restoreActive
			? (composerRestoreState.editorState ?? null)
			: null,
		restoreFiles: restoreActive ? composerRestoreState.files : EMPTY_FILES,
		restoreImages: restoreActive ? composerRestoreState.images : EMPTY_IMAGES,
		restoreNonce: restoreActive ? composerRestoreState.nonce : 0,
		selectedProvider,
		busySessionIds,
	};
}
