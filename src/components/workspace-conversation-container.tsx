import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	memo,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AgentModelOption, ThreadMessageLike } from "@/lib/api";
import {
	generateSessionTitle,
	startAgentMessageStream,
	stopAgentStream,
} from "@/lib/api";
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
	describeUnknownError,
	findModelOption,
	getComposerContextKey,
} from "@/lib/workspace-helpers";
import { WorkspaceComposerContainer } from "./workspace-composer-container";
import { WorkspacePanelContainer } from "./workspace-panel-container";

const EMPTY_IMAGES: string[] = [];
const EMPTY_FILES: string[] = [];

type WorkspaceConversationContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	sessionSelectionHistory?: string[];
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	onSendingWorkspacesChange?: (workspaceIds: Set<string>) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
};

export const WorkspaceConversationContainer = memo(
	function WorkspaceConversationContainer({
		selectedWorkspaceId,
		displayedWorkspaceId,
		selectedSessionId,
		displayedSessionId,
		sessionSelectionHistory = [],
		onSelectSession,
		onResolveDisplayedSession,
		onSendingWorkspacesChange,
		headerActions,
		headerLeading,
	}: WorkspaceConversationContainerProps) {
		const queryClient = useQueryClient();
		const [composerModelSelections, setComposerModelSelections] = useState<
			Record<string, string>
		>({});
		const [composerEffortLevels, setComposerEffortLevels] = useState<
			Record<string, string>
		>({});
		const [composerPermissionModes, setComposerPermissionModes] = useState<
			Record<string, string>
		>({});
		const [composerRestoreState, setComposerRestoreState] = useState<{
			contextKey: string;
			draft: string;
			images: string[];
			files: string[];
			nonce: number;
		} | null>(null);
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
		// Map context key → workspace ID so we can report sending workspaces
		const sendingWorkspaceMapRef = useRef<Map<string, string>>(new Map());

		const composerContextKey = getComposerContextKey(
			displayedWorkspaceId,
			displayedSessionId,
		);
		const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
		const isSending = sendingContextKeys.has(composerContextKey);

		// Resolve the provider implied by the user's current model pick for the
		// displayed session, so the tab icon can reflect a freshly-switched
		// provider before the first message is persisted (which is when
		// session.agentType becomes the source of truth). Stays null when the
		// user hasn't overridden the model — in that case the panel falls back
		// to session.agentType.
		const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
		const displayedSelectedModelId =
			composerModelSelections[composerContextKey] ?? null;
		const selectedProvider = useMemo(() => {
			if (!displayedSelectedModelId) return null;
			const sections = modelSectionsQuery.data ?? [];
			return (
				findModelOption(sections, displayedSelectedModelId)?.provider ?? null
			);
		}, [displayedSelectedModelId, modelSectionsQuery.data]);

		// Derive sending session IDs for tab indicators
		const sendingSessionIds = useMemo(() => {
			const ids = new Set<string>();
			for (const key of sendingContextKeys) {
				if (key.startsWith("session:")) {
					ids.add(key.slice(8));
				}
			}
			return ids;
		}, [sendingContextKeys]);

		// Report sending workspace IDs to parent before paint.
		// useLayoutEffect ensures the sidebar update commits in the same
		// paint as the tab update, so both loading spinners appear together.
		const onSendingWorkspacesChangeRef = useRef(onSendingWorkspacesChange);
		onSendingWorkspacesChangeRef.current = onSendingWorkspacesChange;
		useLayoutEffect(() => {
			const workspaceIds = new Set<string>();
			for (const [, wsId] of sendingWorkspaceMapRef.current) {
				workspaceIds.add(wsId);
			}
			onSendingWorkspacesChangeRef.current?.(workspaceIds);
		}, [sendingContextKeys]);
		const selectionPending =
			selectedWorkspaceId !== displayedWorkspaceId ||
			selectedSessionId !== displayedSessionId;
		const handleStopStream = useCallback(() => {
			const activeSession = activeSessionByContext[composerContextKey];
			if (!activeSession) {
				return;
			}

			void stopAgentStream(activeSession.sessionId, activeSession.provider);
		}, [activeSessionByContext, composerContextKey]);

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
							queryKey: [
								...helmorQueryKeys.sessionMessages(sessionId),
								"thread",
							],
						}),
					);
				}

				await Promise.all(invalidations);
			},
			[queryClient],
		);

		/** Refresh sidebar metadata only — no session messages reload. */
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
				model,
				workingDirectory,
				effortLevel,
				permissionMode,
			}: {
				prompt: string;
				imagePaths: string[];
				filePaths: string[];
				model: AgentModelOption;
				workingDirectory: string | null;
				effortLevel: string;
				permissionMode: string;
			}) => {
				const trimmedPrompt = prompt.trim();
				if (!trimmedPrompt || selectionPending) {
					return;
				}

				const contextKey = composerContextKey;
				const now = new Date().toISOString();
				// Pre-generate the user message ID so the optimistic row already
				// matches the eventual persisted record.
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

				// `displayedSessionId` may be null on the first send for a brand
				// new tab — fall back to the composer context key as a stable
				// stand-in for the cache key. The Rust backend will create the
				// session row and the user follows up with a real id.
				const cacheSessionId = displayedSessionId ?? contextKey;
				// Snapshot the existing thread cache for rollback on error.
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
					// Fire auto-title generation before starting the stream.
					// Runs in background — doesn't block the actual AI response.
					if (displayedSessionId) {
						void generateSessionTitle(displayedSessionId, trimmedPrompt).then(
							(result) => {
								if (result?.title) {
									// Lightweight refresh — only sidebar/tabs, not messages
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
														helmorQueryKeys.workspaceDetail(
															displayedWorkspaceId,
														),
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
					// Full snapshot from the last finalization event.
					let baseMessages: ThreadMessageLike[] = [];
					// Latest streaming partial (replaces trailing message).
					let pendingPartial: ThreadMessageLike | null = null;
					let needsFlush = false;

					// Periodically refresh file changes while the agent is streaming
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
						// Replace the streaming tail starting at the optimistic
						// user message; everything before it stays structurally
						// shared from the prior cache value.
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

					// Single call: Channel<T> in Tauri, SSE in browser — no race.
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
								// Full snapshot from finalization — replace base
								baseMessages = event.messages;
								pendingPartial = null;
								scheduleFlush();
								return;
							}

							if (event.kind === "streamingPartial") {
								// Only the streaming partial changed — lightweight
								pendingPartial = event.message;
								scheduleFlush();
								return;
							}

							if (event.kind === "done" || event.kind === "aborted") {
								// Shared terminal teardown. `aborted` skips the error
								// toast below because the user triggered the stop.
								if (frameId !== null) {
									window.cancelAnimationFrame(frameId);
									frameId = null;
								}
								flushStreamMessages();
								cleanup();

								// Refresh file changes — agent likely modified files
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
									// The cache already holds the full streamed turn —
									// no thread query invalidation, no DB roundtrip,
									// no flicker. Just refresh sidebar metadata.
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
								setSendErrorsByContext((current) => ({
									...current,
									[contextKey]: event.message,
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
									// Messages were persisted incrementally — reload
									// from DB so the cache reflects whatever made it.
									void invalidateConversationQueries(
										displayedWorkspaceId,
										displayedSessionId,
									);
								} else {
									// Nothing was persisted — full rollback to the
									// pre-send snapshot and restore the draft so the
									// user can retry.
									restoreSnapshot(
										queryClient,
										cacheSessionId,
										rollbackSnapshot,
									);
									setComposerRestoreState({
										contextKey,
										draft: trimmedPrompt,
										images: imagePaths,
										files: filePaths,
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
					setSendErrorsByContext((current) => ({
						...current,
						[contextKey]: describeUnknownError(
							error,
							"Unable to send message.",
						),
					}));
					setComposerRestoreState({
						contextKey,
						draft: trimmedPrompt,
						images: imagePaths,
						files: filePaths,
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
				liveSessionsByContext,
				selectionPending,
			],
		);

		const handleSelectModel = useCallback(
			(contextKey: string, modelId: string) => {
				setComposerModelSelections((current) => ({
					...current,
					[contextKey]: modelId,
				}));
			},
			[],
		);

		const handleSelectEffort = useCallback(
			(contextKey: string, level: string) => {
				setComposerEffortLevels((current) => ({
					...current,
					[contextKey]: level,
				}));
			},
			[],
		);

		const handleTogglePlanMode = useCallback((contextKey: string) => {
			setComposerPermissionModes((current) => ({
				...current,
				[contextKey]: current[contextKey] === "plan" ? "acceptEdits" : "plan",
			}));
		}, []);

		const handleComposerSubmitWrapper = useCallback(
			(payload: Parameters<typeof handleComposerSubmit>[0]) => {
				void handleComposerSubmit(payload);
			},
			[handleComposerSubmit],
		);

		const restoreActive =
			composerRestoreState?.contextKey === composerContextKey;
		const restoreDraft = restoreActive ? composerRestoreState.draft : null;
		const restoreImages = restoreActive
			? composerRestoreState.images
			: EMPTY_IMAGES;
		const restoreFiles = restoreActive
			? composerRestoreState.files
			: EMPTY_FILES;
		const restoreNonce = restoreActive ? composerRestoreState.nonce : 0;

		return (
			<>
				<WorkspacePanelContainer
					selectedWorkspaceId={selectedWorkspaceId}
					displayedWorkspaceId={displayedWorkspaceId}
					selectedSessionId={selectedSessionId}
					displayedSessionId={displayedSessionId}
					sessionSelectionHistory={sessionSelectionHistory}
					sending={isSending}
					sendingSessionIds={sendingSessionIds}
					selectedProvider={selectedProvider}
					onSelectSession={onSelectSession}
					onResolveDisplayedSession={onResolveDisplayedSession}
					headerActions={headerActions}
					headerLeading={headerLeading}
				/>

				<div className="mt-auto px-4 pb-4 pt-0">
					<div>
						<WorkspaceComposerContainer
							displayedWorkspaceId={displayedWorkspaceId}
							displayedSessionId={displayedSessionId}
							disabled={selectionPending}
							sending={isSending}
							sendError={activeSendError}
							restoreDraft={restoreDraft}
							restoreImages={restoreImages}
							restoreFiles={restoreFiles}
							restoreNonce={restoreNonce}
							modelSelections={composerModelSelections}
							effortLevels={composerEffortLevels}
							permissionModes={composerPermissionModes}
							onSelectModel={handleSelectModel}
							onSelectEffort={handleSelectEffort}
							onTogglePlanMode={handleTogglePlanMode}
							onSwitchSession={onSelectSession}
							onSubmit={handleComposerSubmitWrapper}
							onStop={handleStopStream}
						/>
					</div>
				</div>
			</>
		);
	},
);
