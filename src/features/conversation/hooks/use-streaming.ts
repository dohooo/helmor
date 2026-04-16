import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { AgentModelOption, ThreadMessageLike } from "@/lib/api";
import {
	generateSessionTitle,
	respondToDeferredTool,
	respondToElicitationRequest,
	respondToPermissionRequest,
	startAgentMessageStream,
	stopAgentStream,
} from "@/lib/api";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	sessionThreadMessagesQueryOptions,
} from "@/lib/query-client";
import {
	appendUserMessage,
	readSessionThread,
	replaceStreamingTail,
	restoreSnapshot,
	type SessionThreadSnapshot,
	sessionThreadCacheKey,
	shareMessages,
} from "@/lib/session-thread-cache";
import {
	createLiveThreadMessage,
	findModelOption,
} from "@/lib/workspace-helpers";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";

const EMPTY_IMAGES: string[] = [];
const EMPTY_FILES: string[] = [];

type PendingPermission = {
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
};

type UseConversationStreamingArgs = {
	composerContextKey: string;
	displayedSessionId: string | null;
	displayedWorkspaceId: string | null;
	displayedSelectedModelId: string | null;
	selectionPending: boolean;
	onSendingWorkspacesChange?: (workspaceIds: Set<string>) => void;
	onSendingSessionsChange?: (sessionIds: Set<string>) => void;
	onInteractionSessionsChange?: (
		sessionWorkspaceMap: Map<string, string>,
		interactionCounts: Map<string, number>,
	) => void;
	onSessionCompleted?: (sessionId: string, workspaceId: string) => void;
};

export function useConversationStreaming({
	composerContextKey,
	displayedSessionId,
	displayedWorkspaceId,
	displayedSelectedModelId,
	selectionPending,
	onSendingWorkspacesChange,
	onSendingSessionsChange,
	onInteractionSessionsChange,
	onSessionCompleted,
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

	const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
	const selectedProvider = useMemo(() => {
		if (!displayedSelectedModelId) return null;
		const sections = modelSectionsQuery.data ?? [];
		return (
			findModelOption(sections, displayedSelectedModelId)?.provider ?? null
		);
	}, [displayedSelectedModelId, modelSectionsQuery.data]);

	const sendingSessionIds = useMemo(() => {
		const ids = new Set<string>();
		for (const key of sendingContextKeys) {
			if (key.startsWith("session:")) {
				ids.add(key.slice(8));
			}
		}
		return ids;
	}, [sendingContextKeys]);

	const onSendingWorkspacesChangeRef = useRef(onSendingWorkspacesChange);
	onSendingWorkspacesChangeRef.current = onSendingWorkspacesChange;
	const onSendingSessionsChangeRef = useRef(onSendingSessionsChange);
	onSendingSessionsChangeRef.current = onSendingSessionsChange;
	const onInteractionSessionsChangeRef = useRef(onInteractionSessionsChange);
	onInteractionSessionsChangeRef.current = onInteractionSessionsChange;
	const onSessionCompletedRef = useRef(onSessionCompleted);
	onSessionCompletedRef.current = onSessionCompleted;
	useLayoutEffect(() => {
		const workspaceIds = new Set<string>();
		for (const [, workspaceId] of sendingWorkspaceMapRef.current) {
			workspaceIds.add(workspaceId);
		}
		onSendingWorkspacesChangeRef.current?.(workspaceIds);
		onSendingSessionsChangeRef.current?.(sendingSessionIds);
	}, [sendingContextKeys, sendingSessionIds]);
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

	const handleStopStream = useCallback(() => {
		const activeSession = activeSessionByContext[composerContextKey];
		if (!activeSession) {
			return;
		}

		void stopAgentStream(activeSession.stopSessionId, activeSession.provider);
	}, [activeSessionByContext, composerContextKey]);

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

	const pauseSendingState = useCallback((contextKey: string) => {
		sendingWorkspaceMapRef.current.delete(contextKey);
		setSendingContextKeys((current) => {
			if (!current.has(contextKey)) {
				return current;
			}

			const next = new Set(current);
			next.delete(contextKey);
			return next;
		});
	}, []);

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
				if (displayedWorkspaceId) {
					sendingWorkspaceMapRef.current.set(contextKey, displayedWorkspaceId);
				}
				setSendingContextKeys((current) => {
					const next = new Set(current);
					next.add(contextKey);
					return next;
				});
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
			if (displayedWorkspaceId) {
				sendingWorkspaceMapRef.current.set(contextKey, displayedWorkspaceId);
			}
			setSendingContextKeys((current) => {
				const next = new Set(current);
				next.add(contextKey);
				return next;
			});

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
				const errorMsg = error instanceof Error ? error.message : String(error);
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
			pushToast,
			queryClient,
			rememberInteractionWorkspace,
			selectedProvider,
		],
	);

	const handleComposerSubmit = useCallback(
		async ({
			prompt,
			imagePaths,
			filePaths,
			customTags,
			model,
			workingDirectory,
			effortLevel,
			permissionMode,
			fastMode,
		}: SubmitPayload) => {
			const trimmedPrompt = prompt.trim();
			if (!trimmedPrompt || selectionPending || !displayedSessionId) {
				return;
			}

			const contextKey = composerContextKey;

			const now = new Date().toISOString();
			const userMessageId = crypto.randomUUID();
			const optimisticUserMessage = createLiveThreadMessage({
				id: userMessageId,
				role: "user",
				text: trimmedPrompt,
				createdAt: now,
				files: filePaths,
			});
			const previousLiveSession = liveSessionsByContext[contextKey];
			const providerSessionId =
				previousLiveSession?.provider === model.provider
					? (previousLiveSession.providerSessionId ?? undefined)
					: undefined;
			// Always use the real session ID — never fall back to a
			// workspace-level contextKey, which would share cache entries
			// across sessions and leak provider session IDs on resume.
			const cacheSessionId = displayedSessionId;
			const rollbackSnapshot: SessionThreadSnapshot = appendUserMessage(
				queryClient,
				cacheSessionId,
				optimisticUserMessage,
			);
			setComposerRestoreState(null);
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
			rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
			if (displayedWorkspaceId) {
				sendingWorkspaceMapRef.current.set(contextKey, displayedWorkspaceId);
			}
			setSendingContextKeys((current) => {
				const next = new Set(current);
				next.add(contextKey);
				return next;
			});
			if (fastMode) {
				setFastPreludeActive(contextKey);
			} else {
				clearFastPrelude(contextKey);
			}

			try {
				if (displayedSessionId) {
					void generateSessionTitle(displayedSessionId, trimmedPrompt).then(
						(result) => {
							if (result?.title) {
								void Promise.all([
									queryClient.invalidateQueries({
										queryKey: helmorQueryKeys.workspaceGroups,
									}),
									displayedWorkspaceId
										? queryClient.invalidateQueries({
												queryKey:
													helmorQueryKeys.workspaceSessions(
														displayedWorkspaceId,
													),
											})
										: undefined,
									displayedWorkspaceId
										? queryClient.invalidateQueries({
												queryKey:
													helmorQueryKeys.workspaceDetail(displayedWorkspaceId),
											})
										: undefined,
								]);
							}
						},
					);
				}

				const stopSessionId = displayedSessionId;
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
						sessionId: providerSessionId,
						helmorSessionId: displayedSessionId,
						workingDirectory,
						effortLevel,
						permissionMode,
						fastMode,
						userMessageId,
						files: filePaths,
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
							rememberInteractionWorkspace(contextKey, displayedWorkspaceId);
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
								const sid = event.sessionId ?? displayedSessionId;
								if (sid && displayedWorkspaceId) {
									onSessionCompletedRef.current?.(sid, displayedWorkspaceId);
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
								void invalidateConversationQueries(displayedWorkspaceId, null);
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
									displayedWorkspaceId,
									displayedSessionId,
								);
							} else {
								restoreSnapshot(queryClient, cacheSessionId, rollbackSnapshot);
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
					},
				);
			} catch (error) {
				console.error("[conversation] invoke error:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				setSendErrorsByContext((current) => ({
					...current,
					[contextKey]: errorMsg,
				}));
				setComposerRestoreState({
					contextKey,
					draft: trimmedPrompt,
					images: imagePaths,
					files: filePaths,
					customTags,
					nonce: Date.now(),
				});
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
			pushToast,
			queryClient,
			rememberInteractionWorkspace,
			selectionPending,
			refreshSessionThreadFromDb,
			setFastPreludeActive,
		],
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
		sendingSessionIds,
	};
}
