import { useQueryClient } from "@tanstack/react-query";
import {
	memo,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AgentModelOption, SessionMessageRecord } from "@/lib/api";
import {
	generateSessionTitle,
	listenAgentStream,
	startAgentMessageStream,
	stopAgentStream,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { StreamAccumulator } from "@/lib/stream-accumulator";
import {
	appendLiveMessage,
	createLiveMessage,
	describeUnknownError,
	getComposerContextKey,
	haveSameLiveMessages,
} from "@/lib/workspace-helpers";
import { WorkspaceComposerContainer } from "./workspace-composer-container";
import { WorkspacePanelContainer } from "./workspace-panel-container";

type WorkspaceConversationContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
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
			nonce: number;
		} | null>(null);
		const [liveMessagesByContext, setLiveMessagesByContext] = useState<
			Record<string, SessionMessageRecord[]>
		>({});
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
		const prevContextKeyRef = useRef(composerContextKey);
		// Clear live messages from the previous context when user switches session.
		// This ensures we fall back to DB data when returning to a session.
		if (prevContextKeyRef.current !== composerContextKey) {
			const prevKey = prevContextKeyRef.current;
			prevContextKeyRef.current = composerContextKey;
			if (liveMessagesByContext[prevKey]?.length) {
				setLiveMessagesByContext((current) => {
					const next = { ...current };
					delete next[prevKey];
					return next;
				});
			}
		}
		const liveMessages = liveMessagesByContext[composerContextKey] ?? [];
		const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
		const isSending = sendingContextKeys.has(composerContextKey);

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
							queryKey: helmorQueryKeys.sessionMessages(sessionId),
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
				model,
				workingDirectory,
				effortLevel,
				permissionMode,
			}: {
				prompt: string;
				imagePaths: string[];
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
				// Pre-generate user message ID so it matches the DB primary key.
				// AI message IDs come from the Rust backend via persistedIds.
				const userMessageId = crypto.randomUUID();
				const optimisticUserMessage = createLiveMessage({
					id: userMessageId,
					sessionId: displayedSessionId ?? contextKey,
					role: "user",
					content: trimmedPrompt,
					createdAt: now,
					model: model.id,
				});
				const previousLiveSession = liveSessionsByContext[contextKey];
				const providerSessionId =
					previousLiveSession?.provider === model.provider
						? (previousLiveSession.sessionId ?? undefined)
						: undefined;

				setLiveMessagesByContext((current) =>
					appendLiveMessage(current, contextKey, optimisticUserMessage),
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

					const { streamId } = await startAgentMessageStream({
						provider: model.provider,
						modelId: model.id,
						prompt: trimmedPrompt,
						sessionId: providerSessionId,
						helmorSessionId: displayedSessionId,
						workingDirectory,
						effortLevel,
						permissionMode,
						userMessageId,
					});
					const sidecarSessionId = displayedSessionId ?? `tmp-${streamId}`;
					setActiveSessionByContext((current) => ({
						...current,
						[contextKey]: {
							sessionId: sidecarSessionId,
							provider: model.provider,
						},
					}));

					const accumulator = new StreamAccumulator();
					let unlistenFn: (() => void) | null = null;
					let frameId: number | null = null;

					// Periodically refresh file changes while the agent is streaming
					const changesRefreshInterval = window.setInterval(() => {
						void queryClient.invalidateQueries({
							queryKey: ["workspaceChanges"],
						});
					}, 3_000);

					const cleanup = () => {
						window.clearInterval(changesRefreshInterval);
						if (frameId !== null) {
							window.cancelAnimationFrame(frameId);
							frameId = null;
						}
						if (unlistenFn) {
							unlistenFn();
							unlistenFn = null;
						}
					};

					const flushStreamMessages = () => {
						frameId = null;
						const streamMessages = accumulator.toMessages(
							contextKey,
							displayedSessionId ?? contextKey,
						);
						const nextMessages = [optimisticUserMessage, ...streamMessages];
						const doFlush = () => {
							setLiveMessagesByContext((current) => {
								if (haveSameLiveMessages(current[contextKey], nextMessages)) {
									return current;
								}

								return {
									...current,
									[contextKey]: nextMessages,
								};
							});
						};
						// Always flush synchronously to avoid deferred/split rendering
						// that can cause visual flicker between transition frames.
						doFlush();
					};

					const scheduleFlush = () => {
						if (frameId !== null) {
							return;
						}

						frameId = window.requestAnimationFrame(() => flushStreamMessages());
					};

					unlistenFn = await listenAgentStream(streamId, (event) => {
						if (event.kind === "line") {
							accumulator.addLine(event.line, event.persistedIds);
							scheduleFlush();
							return;
						}

						if (event.kind === "done") {
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
								// Only refresh sidebar metadata (groups, session list).
								// Do NOT invalidate sessionMessages or clear live
								// messages — the live data IS the complete conversation.
								// It stays until the user navigates away from this session.
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
							// Don't show abort errors — the user triggered the stop
							const isAbort =
								event.message?.includes("aborted") ||
								event.message?.includes("abort") ||
								event.message?.includes("cancel");
							if (!isAbort) {
								setSendErrorsByContext((current) => ({
									...current,
									[contextKey]: event.message,
								}));
							}
							setActiveSessionByContext((current) => {
								if (!(contextKey in current)) {
									return current;
								}

								const next = { ...current };
								delete next[contextKey];
								return next;
							});

							if (event.persisted) {
								// Messages were persisted incrementally — reload from DB
								void invalidateConversationQueries(
									displayedWorkspaceId,
									displayedSessionId,
								).then(() => {
									setLiveMessagesByContext((current) => {
										if (!current[contextKey]?.length) return current;
										const next = { ...current };
										delete next[contextKey];
										return next;
									});
								});
							} else {
								// Nothing was persisted — restore the draft
								setComposerRestoreState({
									contextKey,
									draft: trimmedPrompt,
									images: imagePaths,
									nonce: Date.now(),
								});
								setLiveMessagesByContext((current) => ({
									...current,
									[contextKey]: (current[contextKey] ?? []).filter(
										(message) => message.id !== optimisticUserMessage.id,
									),
								}));
							}

							sendingWorkspaceMapRef.current.delete(contextKey);
							setSendingContextKeys((current) => {
								const next = new Set(current);
								next.delete(contextKey);
								return next;
							});
						}
					});
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
						nonce: Date.now(),
					});
					setLiveMessagesByContext((current) => ({
						...current,
						[contextKey]: (current[contextKey] ?? []).filter(
							(message) => message.id !== optimisticUserMessage.id,
						),
					}));
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

		return (
			<>
				<WorkspacePanelContainer
					selectedWorkspaceId={selectedWorkspaceId}
					displayedWorkspaceId={displayedWorkspaceId}
					selectedSessionId={selectedSessionId}
					displayedSessionId={displayedSessionId}
					liveMessages={liveMessages}
					sending={isSending}
					sendingSessionIds={sendingSessionIds}
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
							restoreDraft={
								composerRestoreState?.contextKey === composerContextKey
									? composerRestoreState.draft
									: null
							}
							restoreImages={
								composerRestoreState?.contextKey === composerContextKey
									? composerRestoreState.images
									: []
							}
							restoreNonce={
								composerRestoreState?.contextKey === composerContextKey
									? composerRestoreState.nonce
									: 0
							}
							modelSelections={composerModelSelections}
							effortLevels={composerEffortLevels}
							permissionModes={composerPermissionModes}
							onSelectModel={(contextKey, modelId) => {
								setComposerModelSelections((current) => ({
									...current,
									[contextKey]: modelId,
								}));
							}}
							onSelectEffort={(contextKey, level) => {
								setComposerEffortLevels((current) => ({
									...current,
									[contextKey]: level,
								}));
							}}
							onTogglePlanMode={(contextKey) => {
								setComposerPermissionModes((current) => ({
									...current,
									[contextKey]:
										current[contextKey] === "plan" ? "acceptEdits" : "plan",
								}));
							}}
							onSwitchSession={onSelectSession}
							onSubmit={(payload) => {
								void handleComposerSubmit(payload);
							}}
							onStop={handleStopStream}
						/>
					</div>
				</div>
			</>
		);
	},
);
