import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SerializedEditorState } from "lexical";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	buildPendingDeferredTool,
	getDeferredToolResumeModelId,
	type PendingDeferredTool,
} from "@/features/conversation/pending-deferred-tool";
import {
	buildPendingElicitation,
	type PendingElicitation,
} from "@/features/conversation/pending-elicitation";
import { stabilizeStreamingMessages } from "@/features/conversation/streaming-tail-collapse";
import type {
	AgentModelOption,
	CodexGoalState,
	ThreadMessageLike,
} from "@/lib/api";
import {
	generateSessionTitle,
	loadRepoPreferences,
	mutateCodexGoal,
	renameSession,
	respondToDeferredTool,
	respondToElicitationRequest,
	respondToPermissionRequest,
	startAgentMessageStream,
	steerAgentStream,
	stopAgentStream,
} from "@/lib/api";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import { extractError, isRecoverableByPurge } from "@/lib/errors";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
} from "@/lib/query-client";
import { resolveGeneralPreferencePrefix } from "@/lib/repo-preferences-prompts";
import {
	appendUserMessage,
	readSessionThread,
	replaceStreamingTail,
	restoreSnapshot,
	type SessionThreadSnapshot,
	sessionThreadCacheKey,
	shareMessages,
} from "@/lib/session-thread-cache";
import type { FollowUpBehavior } from "@/lib/settings";
import type { SubmitQueueApi } from "@/lib/use-submit-queue";
import { showWorkspaceBrokenToast } from "@/lib/workspace-broken-toast";
import {
	createLiveThreadMessage,
	findModelOption,
} from "@/lib/workspace-helpers";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

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

export type PendingPermission = {
	permissionId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	title?: string | null;
	description?: string | null;
};

const EMPTY_PENDING_PERMISSIONS: PendingPermission[] = [];

type ComposerRestoreState = {
	contextKey: string;
	draft: string;
	images: string[];
	files: string[];
	customTags: ComposerCustomTag[];
	nonce: number;
};

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
	startSubmitMode?: "startNow" | "saveForLater";
	/** Snapshot of the editor's full Lexical state at submit time. Captured
	 *  synchronously inside the composer so callers that need to round-trip
	 *  chips/text/images (e.g. the kanban "backlog" handler that copies the
	 *  draft to a freshly-created session) can do so without losing the
	 *  badge nodes that a plain prompt-string would discard. */
	editorStateSnapshot?: SerializedEditorState;
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
	onSessionRunStateChange?: (
		sessionId: string,
		workspaceId: string | null,
		sending: boolean,
	) => void;
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
	onSessionRunStateChange,
	onInteractionSessionsChange,
	onSessionCompleted,
	onSessionAborted,
}: UseConversationStreamingArgs) {
	const queryClient = useQueryClient();
	const pushToast = useWorkspaceToast();
	const [composerRestoreState, setComposerRestoreState] =
		useState<ComposerRestoreState | null>(null);
	const [liveSessionsByContext, setLiveSessionsByContext] = useState<
		Record<string, { provider: string; providerSessionId?: string | null }>
	>({});
	const [sendErrorsByContext, setSendErrorsByContext] = useState<
		Record<string, string | null>
	>({});
	const [activeSessionByContext, setActiveSessionByContext] = useState<
		Record<string, { stopSessionId: string; provider: string }>
	>({});
	const [sendingContextKeys, setSendingContextKeys] = useState<Set<string>>(
		() => new Set(),
	);
	const sendingContextKeysRef = useRef<Set<string>>(new Set());
	const [pendingPermissionsByContext, setPendingPermissionsByContext] =
		useState<Record<string, PendingPermission[]>>({});
	const [pendingDeferredByContext, setPendingDeferredByContext] = useState<
		Record<string, PendingDeferredTool | null>
	>({});
	const [pendingElicitationByContext, setPendingElicitationByContext] =
		useState<Record<string, PendingElicitation | null>>({});
	const [
		elicitationResponsePendingByContext,
		setElicitationResponsePendingByContext,
	] = useState<Record<string, boolean>>({});
	const [interactionWorkspaceByContext, setInteractionWorkspaceByContext] =
		useState<Record<string, string | null>>({});
	const [planReviewByContext, setPlanReviewByContext] = useState<
		Record<string, boolean>
	>({});
	const [activeFastPreludes, setActiveFastPreludes] = useState<
		Record<string, boolean>
	>({});
	const sendingWorkspaceMapRef = useRef<Map<string, string>>(new Map());
	const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
	const isSending = sendingContextKeys.has(composerContextKey);
	const pendingPermissions =
		pendingPermissionsByContext[composerContextKey] ??
		EMPTY_PENDING_PERMISSIONS;
	const pendingElicitation =
		pendingElicitationByContext[composerContextKey] ?? null;
	const elicitationResponsePending =
		elicitationResponsePendingByContext[composerContextKey] ?? false;
	const hasPlanReview = planReviewByContext[composerContextKey] ?? false;

	const seedSessionTitle = useCallback(
		(sessionId: string, workspaceId: string | null, title: string) => {
			queryClient.setQueryData(
				helmorQueryKeys.workspaceSessions(workspaceId ?? "__none__"),
				(current: Array<Record<string, unknown>> | undefined) =>
					(current ?? []).map((session) =>
						session.id === sessionId ? { ...session, title } : session,
					),
			);
			if (workspaceId) {
				queryClient.setQueryData(
					helmorQueryKeys.workspaceDetail(workspaceId),
					(current: Record<string, unknown> | undefined) => {
						if (!current || current.activeSessionId !== sessionId) {
							return current;
						}
						return {
							...current,
							activeSessionTitle: title,
						};
					},
				);
				queryClient.setQueryData(
					helmorQueryKeys.workspaceGroups,
					(current: Array<Record<string, unknown>> | undefined) =>
						(current ?? []).map((group) => ({
							...group,
							rows: Array.isArray(group.rows)
								? group.rows.map((row: Record<string, unknown>) =>
										row.id === workspaceId && row.activeSessionId === sessionId
											? {
													...row,
													activeSessionTitle: title,
												}
											: row,
									)
								: group.rows,
						})),
				);
			}
		},
		[queryClient],
	);

	const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
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

	const onSessionRunStateChangeRef = useRef(onSessionRunStateChange);
	onSessionRunStateChangeRef.current = onSessionRunStateChange;
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

		for (const [contextKey, deferred] of Object.entries(
			pendingDeferredByContext,
		)) {
			if (!deferred || !contextKey.startsWith("session:")) {
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

		for (const [contextKey, elicitation] of Object.entries(
			pendingElicitationByContext,
		)) {
			if (!elicitation || !contextKey.startsWith("session:")) {
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
		pendingElicitationByContext,
		pendingDeferredByContext,
		pendingPermissionsByContext,
		planReviewByContext,
	]);

	const rememberInteractionWorkspace = useCallback(
		(contextKey: string, workspaceId: string | null | undefined) => {
			if (workspaceId === undefined) {
				return;
			}

			setInteractionWorkspaceByContext((current) => {
				if ((current[contextKey] ?? null) === (workspaceId ?? null)) {
					return current;
				}

				return {
					...current,
					[contextKey]: workspaceId ?? null,
				};
			});
		},
		[],
	);

	const clearPendingPermissions = useCallback((contextKey: string) => {
		setPendingPermissionsByContext((current) => {
			const existing = current[contextKey] ?? EMPTY_PENDING_PERMISSIONS;
			if (existing.length === 0) {
				return current;
			}

			const next = { ...current };
			delete next[contextKey];
			return next;
		});
	}, []);

	const clearPendingElicitation = useCallback((contextKey: string) => {
		setPendingElicitationByContext((current) => {
			if (!(contextKey in current)) {
				return current;
			}

			const next = { ...current };
			delete next[contextKey];
			return next;
		});
		setElicitationResponsePendingByContext((current) => {
			if (!(contextKey in current)) {
				return current;
			}

			const next = { ...current };
			delete next[contextKey];
			return next;
		});
	}, []);

	const clearPlanReview = useCallback((contextKey: string) => {
		setPlanReviewByContext((current) => {
			if (!current[contextKey]) return current;
			const next = { ...current };
			delete next[contextKey];
			return next;
		});
	}, []);

	const setPlanReviewActive = useCallback((contextKey: string) => {
		setPlanReviewByContext((current) => {
			if (current[contextKey]) return current;
			return { ...current, [contextKey]: true };
		});
	}, []);

	const setFastPreludeActive = useCallback((contextKey: string) => {
		setActiveFastPreludes((current) => {
			if (current[contextKey]) return current;
			return { ...current, [contextKey]: true };
		});
	}, []);

	const clearFastPrelude = useCallback((contextKey: string) => {
		setActiveFastPreludes((current) => {
			if (!current[contextKey]) return current;
			const next = { ...current };
			delete next[contextKey];
			return next;
		});
	}, []);

	const appendPendingPermission = useCallback(
		(contextKey: string, permission: PendingPermission) => {
			setPendingPermissionsByContext((current) => ({
				...current,
				[contextKey]: [...(current[contextKey] ?? []), permission],
			}));
		},
		[],
	);

	const handleStopStream = useCallback(async () => {
		const activeSession = activeSessionByContext[composerContextKey];
		if (!activeSession) {
			return;
		}
		const sessionId = activeSession.stopSessionId;
		const goal =
			activeSession.provider === "codex"
				? queryClient.getQueryData<CodexGoalState | null>(
						helmorQueryKeys.sessionCodexGoal(sessionId),
					)
				: null;

		// For codex sessions with an active goal, flip the goal to paused
		// FIRST so codex doesn't auto-spawn a fresh continuation turn the
		// moment we abort the current one. Sequential: mutate -> stop, so
		// the codex child is still alive when mutateCodexGoal needs it.
		// (mutateCodexGoal is best-effort on the sidecar side too — if a
		// race somehow kills the child first it just no-ops.) The user
		// resumes by typing `/goal resume`.
		if (goal && goal.status === "active") {
			try {
				await mutateCodexGoal(sessionId, "pause");
			} catch {
				// Surfaced via toast inside mutateCodexGoal already; don't
				// block the abort.
			}
		}
		await stopAgentStream(sessionId, activeSession.provider);
	}, [activeSessionByContext, composerContextKey, queryClient]);

	const handlePermissionResponse = useCallback(
		(
			permissionId: string,
			behavior: "allow" | "deny",
			options?: { updatedPermissions?: unknown[]; message?: string },
		) => {
			setPendingPermissionsByContext((current) => {
				const permissions =
					current[composerContextKey] ?? EMPTY_PENDING_PERMISSIONS;
				const nextPermissions = permissions.filter(
					(permission) => permission.permissionId !== permissionId,
				);
				if (nextPermissions.length === permissions.length) {
					return current;
				}

				const next = { ...current };
				if (nextPermissions.length > 0) {
					next[composerContextKey] = nextPermissions;
				} else {
					delete next[composerContextKey];
				}
				return next;
			});
			respondToPermissionRequest(permissionId, behavior, options).catch((err) =>
				console.error("[helmor] permission response:", err),
			);
		},
		[composerContextKey],
	);

	const publishSendingState = useCallback(
		(
			contextKey: string,
			workspaceId: string | null | undefined,
			sending: boolean,
		) => {
			if (!contextKey.startsWith("session:")) {
				return;
			}
			onSessionRunStateChangeRef.current?.(
				contextKey.slice(8),
				workspaceId ?? null,
				sending,
			);
		},
		[],
	);

	const markSendingState = useCallback(
		(contextKey: string, workspaceId: string | null | undefined) => {
			const previousWorkspaceId =
				sendingWorkspaceMapRef.current.get(contextKey) ?? null;
			if (workspaceId) {
				sendingWorkspaceMapRef.current.set(contextKey, workspaceId);
			}
			const nextWorkspaceId =
				sendingWorkspaceMapRef.current.get(contextKey) ?? workspaceId ?? null;
			if (sendingContextKeysRef.current.has(contextKey)) {
				if (nextWorkspaceId !== previousWorkspaceId) {
					publishSendingState(contextKey, nextWorkspaceId, true);
				}
				return;
			}

			sendingContextKeysRef.current = new Set(sendingContextKeysRef.current);
			sendingContextKeysRef.current.add(contextKey);
			publishSendingState(contextKey, nextWorkspaceId, true);
			setSendingContextKeys(sendingContextKeysRef.current);
		},
		[publishSendingState],
	);

	const pauseSendingState = useCallback(
		(contextKey: string) => {
			const workspaceId =
				sendingWorkspaceMapRef.current.get(contextKey) ?? null;
			sendingWorkspaceMapRef.current.delete(contextKey);
			if (!sendingContextKeysRef.current.has(contextKey)) {
				return;
			}

			sendingContextKeysRef.current = new Set(sendingContextKeysRef.current);
			sendingContextKeysRef.current.delete(contextKey);
			publishSendingState(contextKey, workspaceId, false);
			setSendingContextKeys(sendingContextKeysRef.current);
		},
		[publishSendingState],
	);

	const clearSendingState = useCallback(
		(contextKey: string) => {
			setActiveSessionByContext((current) => {
				if (!(contextKey in current)) {
					return current;
				}

				const next = { ...current };
				delete next[contextKey];
				return next;
			});
			pauseSendingState(contextKey);
		},
		[pauseSendingState],
	);

	const invalidateConversationQueries = useCallback(
		async (workspaceId: string | null, sessionId: string | null) => {
			const invalidations: Promise<unknown>[] = [
				queryClient.invalidateQueries({
					queryKey: helmorQueryKeys.workspaceGroups,
				}),
			];

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

	const applyDeferredToolEvent = useCallback(
		(contextKey: string, event: PendingDeferredTool) => {
			clearPendingPermissions(contextKey);
			clearPendingElicitation(contextKey);
			setPendingDeferredByContext((current) => ({
				...current,
				[contextKey]: event,
			}));
			setLiveSessionsByContext((current) => ({
				...current,
				[contextKey]: {
					provider: event.provider,
					providerSessionId:
						event.providerSessionId ??
						current[contextKey]?.providerSessionId ??
						null,
				},
			}));
			clearSendingState(contextKey);
		},
		[clearPendingElicitation, clearPendingPermissions, clearSendingState],
	);

	const applyElicitationEvent = useCallback(
		(contextKey: string, event: PendingElicitation) => {
			setPendingDeferredByContext((current) => ({
				...current,
				[contextKey]: null,
			}));
			setPendingElicitationByContext((current) => ({
				...current,
				[contextKey]: event,
			}));
			setElicitationResponsePendingByContext((current) => ({
				...current,
				[contextKey]: false,
			}));
			pauseSendingState(contextKey);
		},
		[pauseSendingState],
	);

	const handleElicitationResponse = useCallback(
		async (
			elicitation: PendingElicitation,
			action: "accept" | "decline" | "cancel",
			content?: Record<string, unknown>,
		) => {
			const contextKey = composerContextKey;
			setSendErrorsByContext((current) => ({
				...current,
				[contextKey]: null,
			}));
			setElicitationResponsePendingByContext((current) => ({
				...current,
				[contextKey]: true,
			}));

			try {
				await respondToElicitationRequest(
					elicitation.elicitationId,
					action,
					content,
				);
				clearPendingElicitation(contextKey);
				rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
				markSendingState(contextKey, displayedWorkspaceId);
			} catch (error) {
				console.error("[conversation] elicitation response:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				setElicitationResponsePendingByContext((current) => ({
					...current,
					[contextKey]: false,
				}));
				setSendErrorsByContext((current) => ({
					...current,
					[contextKey]: errorMsg,
				}));
				pushToast(errorMsg, "Unable to answer request", "destructive");
			}
		},
		[
			clearPendingElicitation,
			composerContextKey,
			displayedWorkspaceId,
			markSendingState,
			pushToast,
			rememberInteractionWorkspace,
		],
	);

	const handleDeferredToolResponse = useCallback(
		async (
			deferred: PendingDeferredTool,
			behavior: "allow" | "deny",
			options?: {
				reason?: string;
				updatedInput?: Record<string, unknown>;
			},
		) => {
			if (!displayedSessionId) return;
			const fallbackModelId =
				selectedProvider === deferred.provider
					? displayedSelectedModelId
					: null;
			const resumeModelId = getDeferredToolResumeModelId(
				deferred,
				fallbackModelId,
			);
			if (!resumeModelId) {
				setSendErrorsByContext((current) => ({
					...current,
					[composerContextKey]:
						"Unable to resume deferred tool: missing modelId.",
				}));
				return;
			}
			const contextKey = composerContextKey;
			const cacheSessionId = displayedSessionId;
			const resumeBaseSnapshot =
				readSessionThread(queryClient, cacheSessionId) ?? [];

			setPendingDeferredByContext((current) => ({
				...current,
				[contextKey]: null,
			}));
			clearPendingElicitation(contextKey);
			clearPendingPermissions(contextKey);
			setSendErrorsByContext((current) => ({
				...current,
				[contextKey]: null,
			}));
			rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
			markSendingState(contextKey, displayedWorkspaceId);

			try {
				await respondToDeferredTool(deferred.toolUseId, behavior, {
					reason: options?.reason,
					updatedInput: options?.updatedInput,
				});

				const stopSessionId = displayedSessionId;
				setActiveSessionByContext((current) => ({
					...current,
					[contextKey]: {
						stopSessionId,
						provider: deferred.provider,
					},
				}));

				let frameId: number | null = null;
				let baseMessages: ThreadMessageLike[] = [];
				let pendingPartial: ThreadMessageLike | null = null;
				let needsFlush = false;

				const changesRefreshInterval = window.setInterval(() => {
					void queryClient.invalidateQueries({
						queryKey: ["workspaceChanges"],
					});
				}, 3_000);

				const flushStreamMessages = () => {
					frameId = null;
					if (!needsFlush) return;
					needsFlush = false;

					const rendered = pendingPartial
						? stabilizeStreamingMessages([...baseMessages, pendingPartial])
						: baseMessages;
					const nextMessages = [...resumeBaseSnapshot, ...rendered];
					queryClient.setQueryData<ThreadMessageLike[]>(
						sessionThreadCacheKey(cacheSessionId),
						(prev) => shareMessages(prev ?? [], nextMessages),
					);
				};

				const scheduleFlush = () => {
					needsFlush = true;
					if (frameId !== null) return;
					frameId = window.requestAnimationFrame(() => flushStreamMessages());
				};

				const cleanup = () => {
					window.clearInterval(changesRefreshInterval);
					if (frameId !== null) {
						window.cancelAnimationFrame(frameId);
						frameId = null;
					}
				};

				await startAgentMessageStream(
					{
						provider: deferred.provider,
						modelId: resumeModelId,
						prompt: "",
						resumeOnly: true,
						sessionId: deferred.providerSessionId,
						helmorSessionId: displayedSessionId,
						workingDirectory: deferred.workingDirectory,
						permissionMode: deferred.permissionMode,
					},
					(event) => {
						if (event.kind === "update") {
							baseMessages = event.messages;
							pendingPartial = null;
							scheduleFlush();
							return;
						}

						if (event.kind === "streamingPartial") {
							pendingPartial = event.message;
							scheduleFlush();
							return;
						}

						if (event.kind === "permissionRequest") {
							rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
							appendPendingPermission(contextKey, {
								permissionId: event.permissionId,
								toolName: event.toolName,
								toolInput: event.toolInput,
								title: event.title,
								description: event.description,
							});
							return;
						}

						if (event.kind === "planCaptured") {
							rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
							setPlanReviewActive(contextKey);
							return;
						}

						if (event.kind === "elicitationRequest") {
							rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
							const nextElicitation = buildPendingElicitation(
								event,
								deferred.modelId,
							);
							if (!nextElicitation) {
								setSendErrorsByContext((current) => ({
									...current,
									[contextKey]:
										"Unable to continue elicitation: missing elicitationId or modelId.",
								}));
								return;
							}
							applyElicitationEvent(contextKey, nextElicitation);
							return;
						}

						if (event.kind === "deferredToolUse") {
							rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
							const nextDeferred = buildPendingDeferredTool(
								event,
								deferred.modelId,
							);
							if (frameId !== null) {
								window.cancelAnimationFrame(frameId);
								frameId = null;
							}
							flushStreamMessages();
							cleanup();
							refreshSessionThreadFromDb(cacheSessionId);
							if (!nextDeferred) {
								setPendingDeferredByContext((current) => ({
									...current,
									[contextKey]: deferred,
								}));
								setSendErrorsByContext((current) => ({
									...current,
									[contextKey]:
										"Unable to continue deferred tool: missing modelId.",
								}));
								clearSendingState(contextKey);
								return;
							}
							applyDeferredToolEvent(contextKey, nextDeferred);
							return;
						}

						if (event.kind === "done" || event.kind === "aborted") {
							if (frameId !== null) {
								window.cancelAnimationFrame(frameId);
								frameId = null;
							}
							flushStreamMessages();
							cleanup();
							clearPendingPermissions(contextKey);
							clearPendingElicitation(contextKey);
							clearFastPrelude(contextKey);

							if (event.kind === "done") {
								const sid = event.sessionId ?? displayedSessionId;
								if (sid && displayedWorkspaceId) {
									onSessionCompletedRef.current?.(sid, displayedWorkspaceId);
								}
							} else if (event.kind === "aborted") {
								const sid = event.sessionId ?? displayedSessionId;
								if (sid && displayedWorkspaceId) {
									onSessionAbortedRef.current?.(sid, displayedWorkspaceId);
								}
							}

							void queryClient.invalidateQueries({
								queryKey: ["workspaceChanges"],
							});

							setLiveSessionsByContext((current) => ({
								...current,
								[contextKey]: {
									provider: event.provider,
									providerSessionId:
										event.sessionId ??
										current[contextKey]?.providerSessionId ??
										null,
								},
							}));
							clearSendingState(contextKey);

							if (event.persisted) {
								void invalidateConversationQueries(displayedWorkspaceId, null);
							}
							return;
						}

						if (event.kind === "error") {
							cleanup();
							clearPendingPermissions(contextKey);
							clearPendingElicitation(contextKey);
							setPendingDeferredByContext((current) => ({
								...current,
								[contextKey]: deferred,
							}));
							if (event.internal) {
								pushToast(
									"Something went wrong. Please try again.",
									"Error",
									"destructive",
								);
							}
							setSendErrorsByContext((current) => ({
								...current,
								[contextKey]:
									event.internal || event.persisted ? null : event.message,
							}));
							clearSendingState(contextKey);

							if (event.persisted) {
								void invalidateConversationQueries(
									displayedWorkspaceId,
									displayedSessionId,
								);
							}
						}
					},
				);
			} catch (error) {
				console.error("[conversation] deferred tool response:", error);
				const { code, message: errorMsg } = extractError(
					error,
					"Failed to resume agent stream.",
				);
				if (isRecoverableByPurge(code) && displayedWorkspaceId) {
					showWorkspaceBrokenToast({
						workspaceId: displayedWorkspaceId,
						pushToast,
						queryClient,
					});
				}
				setPendingDeferredByContext((current) => ({
					...current,
					[contextKey]: deferred,
				}));
				setSendErrorsByContext((current) => ({
					...current,
					[contextKey]: errorMsg,
				}));
				clearSendingState(contextKey);
			}
		},
		[
			applyDeferredToolEvent,
			applyElicitationEvent,
			appendPendingPermission,
			clearSendingState,
			clearPendingElicitation,
			clearPendingPermissions,
			composerContextKey,
			displayedSelectedModelId,
			displayedSessionId,
			displayedWorkspaceId,
			invalidateConversationQueries,
			markSendingState,
			pushToast,
			queryClient,
			rememberInteractionWorkspace,
			selectedProvider,
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

			// Follow-up branch: if a stream is already running for this
			// context, either inject mid-turn (`steer`) or stash locally
			// to fire as a fresh turn when the agent finishes (`queue`).
			// The choice is user-controlled via the Follow-up behavior
			// setting. Plan-review takes precedence over both: submitting
			// a free-form message while a plan is pending means "abandon
			// the plan and start fresh," so fall through to normal send.
			const liveStream = activeSessionByContext[contextKey];
			const hasPlanReviewForContext = planReviewByContext[contextKey] ?? false;
			if (
				sendingContextKeys.has(contextKey) &&
				liveStream &&
				!hasPlanReviewForContext
			) {
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
						},
					);
					setComposerRestoreState(null);
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
				setComposerRestoreState(null);

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
					setComposerRestoreState({
						contextKey,
						draft: trimmedPrompt,
						images: imagePaths,
						files: filePaths,
						customTags,
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
							setSendErrorsByContext((current) => ({
								...current,
								[contextKey]: `Steer rejected: ${response.reason}`,
							}));
						}
					}
					return;
				} catch (err) {
					console.warn("[conversation] steer failed:", err);
					restoreDraftOnFailure();
					setSendErrorsByContext((current) => ({
						...current,
						[contextKey]: err instanceof Error ? err.message : String(err),
					}));
					return;
				}
			}

			const previousLiveSession = liveSessionsByContext[contextKey];
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
				seedSessionTitle(targetSessionId, targetWorkspaceId, titleSeed);
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
				setComposerRestoreState(null);
			}
			setSendErrorsByContext((current) => ({
				...current,
				[contextKey]: null,
			}));
			clearPendingPermissions(contextKey);
			clearPlanReview(contextKey);
			setPendingDeferredByContext((current) => ({
				...current,
				[contextKey]: null,
			}));
			clearPendingElicitation(contextKey);
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
							void Promise.all([
								queryClient.invalidateQueries({
									queryKey: helmorQueryKeys.workspaceGroups,
								}),
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
				setActiveSessionByContext((current) => ({
					...current,
					[contextKey]: {
						stopSessionId,
						provider: model.provider,
					},
				}));

				let frameId: number | null = null;
				let baseMessages: ThreadMessageLike[] = [];
				let pendingPartial: ThreadMessageLike | null = null;
				let needsFlush = false;

				const changesRefreshInterval = window.setInterval(() => {
					void queryClient.invalidateQueries({
						queryKey: ["workspaceChanges"],
					});
				}, 3_000);

				const flushStreamMessages = () => {
					frameId = null;
					if (!needsFlush) return;
					needsFlush = false;

					const rendered = pendingPartial
						? stabilizeStreamingMessages([...baseMessages, pendingPartial])
						: baseMessages;
					replaceStreamingTail(queryClient, cacheSessionId, userMessageId, [
						optimisticUserMessage,
						...rendered,
					]);
				};

				const scheduleFlush = () => {
					needsFlush = true;
					if (frameId !== null) return;
					frameId = window.requestAnimationFrame(() => flushStreamMessages());
				};

				const cleanup = () => {
					window.clearInterval(changesRefreshInterval);
					if (frameId !== null) {
						window.cancelAnimationFrame(frameId);
						frameId = null;
					}
				};

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
					(event) => {
						if (event.kind === "update") {
							baseMessages = event.messages;
							pendingPartial = null;
							scheduleFlush();
							return;
						}

						if (event.kind === "streamingPartial") {
							pendingPartial = event.message;
							scheduleFlush();
							return;
						}

						if (event.kind === "permissionRequest") {
							rememberInteractionWorkspace(contextKey, targetWorkspaceId);
							appendPendingPermission(contextKey, {
								permissionId: event.permissionId,
								toolName: event.toolName,
								toolInput: event.toolInput,
								title: event.title,
								description: event.description,
							});
							return;
						}

						if (event.kind === "planCaptured") {
							rememberInteractionWorkspace(contextKey, targetWorkspaceId);
							setPlanReviewActive(contextKey);
							return;
						}

						if (event.kind === "elicitationRequest") {
							rememberInteractionWorkspace(contextKey, targetWorkspaceId);
							const nextElicitation = buildPendingElicitation(event, model.id);
							if (!nextElicitation) {
								setSendErrorsByContext((current) => ({
									...current,
									[contextKey]:
										"Unable to continue elicitation: missing elicitationId or modelId.",
								}));
								return;
							}
							applyElicitationEvent(contextKey, nextElicitation);
							return;
						}

						if (event.kind === "deferredToolUse") {
							rememberInteractionWorkspace(contextKey, targetWorkspaceId);
							const nextDeferred = buildPendingDeferredTool(event, model.id);
							if (frameId !== null) {
								window.cancelAnimationFrame(frameId);
								frameId = null;
							}
							flushStreamMessages();
							cleanup();
							refreshSessionThreadFromDb(cacheSessionId);
							if (!nextDeferred) {
								setSendErrorsByContext((current) => ({
									...current,
									[contextKey]:
										"Unable to continue deferred tool: missing modelId.",
								}));
								clearSendingState(contextKey);
								return;
							}
							applyDeferredToolEvent(contextKey, nextDeferred);
							return;
						}

						if (event.kind === "done" || event.kind === "aborted") {
							if (frameId !== null) {
								window.cancelAnimationFrame(frameId);
								frameId = null;
							}
							flushStreamMessages();
							cleanup();
							clearPendingPermissions(contextKey);
							clearPendingElicitation(contextKey);
							clearFastPrelude(contextKey);

							if (event.kind === "done") {
								const sid = event.sessionId ?? targetSessionId;
								if (sid && targetWorkspaceId) {
									onSessionCompletedRef.current?.(sid, targetWorkspaceId);
								}
							} else if (event.kind === "aborted") {
								const sid = event.sessionId ?? targetSessionId;
								if (sid && targetWorkspaceId) {
									onSessionAbortedRef.current?.(sid, targetWorkspaceId);
								}
							}

							void queryClient.invalidateQueries({
								queryKey: ["workspaceChanges"],
							});

							setLiveSessionsByContext((current) => ({
								...current,
								[contextKey]: {
									provider: event.provider,
									providerSessionId:
										event.sessionId ??
										current[contextKey]?.providerSessionId ??
										null,
								},
							}));
							clearSendingState(contextKey);

							if (event.persisted) {
								// Sidebar only — don't invalidate session messages
								// here. The streaming snapshot IS the correct data
								// and its message IDs differ from DB IDs, so a
								// refetch would cause a full re-render flicker.
								void invalidateConversationQueries(targetWorkspaceId, null);
							}
							return;
						}

						if (event.kind === "error") {
							cleanup();
							clearPendingPermissions(contextKey);
							clearPendingElicitation(contextKey);
							clearFastPrelude(contextKey);
							if (event.internal) {
								pushToast(
									"Something went wrong. Please try again.",
									"Error",
									"destructive",
								);
							}
							setSendErrorsByContext((current) => ({
								...current,
								[contextKey]:
									event.internal || event.persisted ? null : event.message,
							}));
							clearSendingState(contextKey);

							if (event.persisted) {
								// Error path: DO invalidate session messages — the
								// DB may have partial data that the snapshot doesn't
								// reflect correctly.
								void invalidateConversationQueries(
									targetWorkspaceId,
									targetSessionId,
								);
							} else {
								restoreSnapshot(queryClient, cacheSessionId, rollbackSnapshot);
								if (!isOverride) {
									setComposerRestoreState({
										contextKey,
										draft: trimmedPrompt,
										images: imagePaths,
										files: filePaths,
										customTags,
										nonce: Date.now(),
									});
								}
							}
						}
					},
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
				setSendErrorsByContext((current) => ({
					...current,
					[contextKey]: errorMsg,
				}));
				if (!isOverride) {
					setComposerRestoreState({
						contextKey,
						draft: trimmedPrompt,
						images: imagePaths,
						files: filePaths,
						customTags,
						nonce: Date.now(),
					});
				}
				restoreSnapshot(queryClient, cacheSessionId, rollbackSnapshot);
				clearFastPrelude(contextKey);
				clearSendingState(contextKey);
			}
		},
		[
			applyDeferredToolEvent,
			applyElicitationEvent,
			appendPendingPermission,
			clearSendingState,
			clearPendingElicitation,
			clearPendingPermissions,
			clearFastPrelude,
			composerContextKey,
			displayedSessionId,
			displayedWorkspaceId,
			invalidateConversationQueries,
			liveSessionsByContext,
			markSendingState,
			pushToast,
			queryClient,
			repoId,
			rememberInteractionWorkspace,
			selectionPending,
			refreshSessionThreadFromDb,
			setFastPreludeActive,
			activeSessionByContext,
			sendingContextKeys,
			planReviewByContext,
			followUpBehavior,
			submitQueue,
		],
	);

	// Queue drain — pops the first queued entry for any session whose
	// stream just terminated and replays it through `handleComposerSubmit`
	// using the queued item's stored context (not the currently displayed
	// one). Ref indirection keeps the effect dep list to sending-state
	// only; `queueMicrotask` defers the replay so it doesn't call
	// `setSendingContextKeys` inside a React commit phase.
	const handleComposerSubmitRef = useRef(handleComposerSubmit);
	handleComposerSubmitRef.current = handleComposerSubmit;
	const previousSendingRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const previous = previousSendingRef.current;
		const current = sendingContextKeys;
		const justFinished: string[] = [];
		for (const key of previous) {
			if (!current.has(key)) justFinished.push(key);
		}
		previousSendingRef.current = new Set(current);

		for (const key of justFinished) {
			if (!key.startsWith("session:")) continue;
			const sessionId = key.slice("session:".length);
			const next = submitQueue.popNext(sessionId);
			if (!next) continue;
			queueMicrotask(() => {
				handleComposerSubmitRef.current(next.payload, next.context);
			});
		}
	}, [sendingContextKeys, submitQueue]);

	// Row actions: Steer now / Remove. Both key off the item's stored
	// context (NOT the currently displayed session) so row clicks from
	// session A's queue always target A even if the user has navigated.
	const handleSteerQueued = useCallback(
		async (itemId: string) => {
			const item = submitQueue.findById(itemId);
			if (!item) return;

			const ctx = item.context;
			const liveStream = activeSessionByContext[ctx.contextKey] ?? null;

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
					setSendErrorsByContext((current) => ({
						...current,
						[ctx.contextKey]: response.reason
							? `Steer rejected: ${response.reason}`
							: "Steer rejected — added back to the queue.",
					}));
				}
			} catch (err) {
				console.warn("[conversation] steer-from-queue failed:", err);
				submitQueue.enqueue(ctx, item.payload);
				setSendErrorsByContext((current) => ({
					...current,
					[ctx.contextKey]: err instanceof Error ? err.message : String(err),
				}));
			}
		},
		[activeSessionByContext, submitQueue],
	);

	const handleRemoveQueued = useCallback(
		(itemId: string) => {
			const item = submitQueue.findById(itemId);
			if (!item) return;
			submitQueue.remove(item.context.sessionId, itemId);
		},
		[submitQueue],
	);

	const restoreActive = composerRestoreState?.contextKey === composerContextKey;
	const pendingDeferredTool =
		pendingDeferredByContext[composerContextKey] ?? null;

	return {
		activeSendError,
		activeFastPreludes,
		elicitationResponsePending,
		handleComposerSubmit,
		handleDeferredToolResponse,
		handleElicitationResponse,
		handlePermissionResponse,
		handleStopStream,
		handleSteerQueued,
		handleRemoveQueued,
		hasPlanReview,
		isSending,
		pendingElicitation,
		pendingDeferredTool,
		pendingPermissions,
		restoreCustomTags: restoreActive ? composerRestoreState.customTags : [],
		restoreDraft: restoreActive ? composerRestoreState.draft : null,
		restoreFiles: restoreActive ? composerRestoreState.files : EMPTY_FILES,
		restoreImages: restoreActive ? composerRestoreState.images : EMPTY_IMAGES,
		restoreNonce: restoreActive ? composerRestoreState.nonce : 0,
		selectedProvider,
		busySessionIds,
	};
}
