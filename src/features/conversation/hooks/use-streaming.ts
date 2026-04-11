import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentModelOption, ThreadMessageLike } from "@/lib/api";
import {
	generateSessionTitle,
	respondToPermissionRequest,
	startAgentMessageStream,
	stopAgentStream,
} from "@/lib/api";
import type { ComposerCustomTag } from "@/lib/composer-insert";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
} from "@/lib/query-client";
import {
	appendUserMessage,
	replaceStreamingTail,
	restoreSnapshot,
	type SessionThreadSnapshot,
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
};

type UseConversationStreamingArgs = {
	composerContextKey: string;
	displayedSessionId: string | null;
	displayedWorkspaceId: string | null;
	displayedSelectedModelId: string | null;
	selectionPending: boolean;
	onSendingWorkspacesChange?: (workspaceIds: Set<string>) => void;
	onSendingSessionsChange?: (sessionIds: Set<string>) => void;
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
	onSessionCompleted,
}: UseConversationStreamingArgs) {
	const queryClient = useQueryClient();
	const pushToast = useWorkspaceToast();
	const [composerRestoreState, setComposerRestoreState] =
		useState<ComposerRestoreState | null>(null);
	const [liveSessionsByContext, setLiveSessionsByContext] = useState<
		Record<string, { provider: string; sessionId?: string | null }>
	>({});
	const [sendErrorsByContext, setSendErrorsByContext] = useState<
		Record<string, string | null>
	>({});
	const [activeSessionByContext, setActiveSessionByContext] = useState<
		Record<string, { sessionId: string; provider: string }>
	>({});
	const [sendingContextKeys, setSendingContextKeys] = useState<Set<string>>(
		() => new Set(),
	);
	const [pendingPermissions, setPendingPermissions] = useState<
		PendingPermission[]
	>([]);
	const sendingWorkspaceMapRef = useRef<Map<string, string>>(new Map());
	const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
	const isSending = sendingContextKeys.has(composerContextKey);

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

	const handleStopStream = useCallback(() => {
		const activeSession = activeSessionByContext[composerContextKey];
		if (!activeSession) {
			return;
		}

		void stopAgentStream(activeSession.sessionId, activeSession.provider);
	}, [activeSessionByContext, composerContextKey]);

	const handlePermissionResponse = useCallback(
		(permissionId: string, behavior: "allow" | "deny") => {
			setPendingPermissions((prev) =>
				prev.filter((permission) => permission.permissionId !== permissionId),
			);
			respondToPermissionRequest(permissionId, behavior).catch((err) =>
				console.error("[helmor] permission response:", err),
			);
		},
		[],
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

	const invalidateSidebarQueries = useCallback(
		(workspaceId: string | null) => {
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
			return Promise.all(invalidations);
		},
		[queryClient],
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
		}: SubmitPayload) => {
			const trimmedPrompt = prompt.trim();
			if (!trimmedPrompt || selectionPending) {
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
					? (previousLiveSession.sessionId ?? undefined)
					: undefined;
			const cacheSessionId = displayedSessionId ?? contextKey;
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
			if (displayedWorkspaceId) {
				sendingWorkspaceMapRef.current.set(contextKey, displayedWorkspaceId);
			}
			setSendingContextKeys((current) => {
				const next = new Set(current);
				next.add(contextKey);
				return next;
			});

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

				const sidecarSessionId = displayedSessionId ?? `tmp-${contextKey}`;
				setActiveSessionByContext((current) => ({
					...current,
					[contextKey]: {
						sessionId: sidecarSessionId,
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
						? [...baseMessages, pendingPartial]
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
							setPendingPermissions((prev) => [
								...prev,
								{
									permissionId: event.permissionId,
									toolName: event.toolName,
									toolInput: event.toolInput,
									title: event.title,
									description: event.description,
								},
							]);
							return;
						}

						if (event.kind === "done" || event.kind === "aborted") {
							if (frameId !== null) {
								window.cancelAnimationFrame(frameId);
								frameId = null;
							}
							flushStreamMessages();
							cleanup();
							setPendingPermissions([]);

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
									sessionId:
										event.sessionId ?? current[contextKey]?.sessionId ?? null,
								},
							}));
							setActiveSessionByContext((current) => {
								if (!(contextKey in current)) {
									return current;
								}

								const next = { ...current };
								delete next[contextKey];
								return next;
							});

							if (event.persisted) {
								void invalidateSidebarQueries(displayedWorkspaceId);
							}

							sendingWorkspaceMapRef.current.delete(contextKey);
							setSendingContextKeys((current) => {
								const next = new Set(current);
								next.delete(contextKey);
								return next;
							});
							return;
						}

						if (event.kind === "error") {
							cleanup();
							setPendingPermissions([]);
							if (event.internal) {
								pushToast(
									"Something went wrong. Please try again.",
									"Error",
									"destructive",
								);
							}
							setSendErrorsByContext((current) => ({
								...current,
								[contextKey]: event.internal ? null : event.message,
							}));
							setActiveSessionByContext((current) => {
								if (!(contextKey in current)) {
									return current;
								}

								const next = { ...current };
								delete next[contextKey];
								return next;
							});

							if (event.persisted) {
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

							sendingWorkspaceMapRef.current.delete(contextKey);
							setSendingContextKeys((current) => {
								const next = new Set(current);
								next.delete(contextKey);
								return next;
							});
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
				sendingWorkspaceMapRef.current.delete(contextKey);
				setSendingContextKeys((current) => {
					const next = new Set(current);
					next.delete(contextKey);
					return next;
				});
			}
		},
		[
			composerContextKey,
			displayedSessionId,
			displayedWorkspaceId,
			invalidateConversationQueries,
			invalidateSidebarQueries,
			liveSessionsByContext,
			pushToast,
			queryClient,
			selectionPending,
		],
	);

	const restoreActive = composerRestoreState?.contextKey === composerContextKey;

	return {
		activeSendError,
		handleComposerSubmit,
		handlePermissionResponse,
		handleStopStream,
		isSending,
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
