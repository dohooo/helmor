import { useQueryClient } from "@tanstack/react-query";
import { memo, startTransition, useCallback, useState } from "react";
import type { AgentModelOption, SessionMessageRecord } from "@/lib/api";
import {
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
};

export const WorkspaceConversationContainer = memo(
	function WorkspaceConversationContainer({
		selectedWorkspaceId,
		displayedWorkspaceId,
		selectedSessionId,
		displayedSessionId,
		onSelectSession,
		onResolveDisplayedSession,
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
		const [sendingContextKey, setSendingContextKey] = useState<string | null>(
			null,
		);

		const composerContextKey = getComposerContextKey(
			displayedWorkspaceId,
			displayedSessionId,
		);
		const liveMessages = liveMessagesByContext[composerContextKey] ?? [];
		const activeSendError = sendErrorsByContext[composerContextKey] ?? null;
		const isSending = sendingContextKey === composerContextKey;
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

		const handleComposerSubmit = useCallback(
			async ({
				prompt,
				imagePaths,
				model,
				workingDirectory,
			}: {
				prompt: string;
				imagePaths: string[];
				model: AgentModelOption;
				workingDirectory: string | null;
			}) => {
				const trimmedPrompt = prompt.trim();
				if (!trimmedPrompt || selectionPending) {
					return;
				}

				const contextKey = composerContextKey;
				const now = new Date().toISOString();
				const optimisticUserMessage = createLiveMessage({
					id: `${contextKey}:user:${Date.now()}`,
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
				setSendingContextKey(contextKey);

				try {
					const { streamId } = await startAgentMessageStream({
						provider: model.provider,
						modelId: model.id,
						prompt: trimmedPrompt,
						sessionId: providerSessionId,
						helmorSessionId: displayedSessionId,
						workingDirectory,
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

					const cleanup = () => {
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
						startTransition(() => {
							setLiveMessagesByContext((current) => {
								if (haveSameLiveMessages(current[contextKey], nextMessages)) {
									return current;
								}

								return {
									...current,
									[contextKey]: nextMessages,
								};
							});
						});
					};

					const scheduleFlush = () => {
						if (frameId !== null) {
							return;
						}

						frameId = window.requestAnimationFrame(flushStreamMessages);
					};

					unlistenFn = await listenAgentStream(streamId, (event) => {
						if (event.kind === "line") {
							accumulator.addLine(event.line);
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
								void invalidateConversationQueries(
									displayedWorkspaceId,
									displayedSessionId,
								).finally(() => {
									setLiveMessagesByContext((current) => ({
										...current,
										[contextKey]: [],
									}));
								});
							}

							setSendingContextKey((current) =>
								current === contextKey ? null : current,
							);
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
							setSendingContextKey((current) =>
								current === contextKey ? null : current,
							);
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
					setSendingContextKey((current) =>
						current === contextKey ? null : current,
					);
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
					onSelectSession={onSelectSession}
					onResolveDisplayedSession={onResolveDisplayedSession}
				/>

				<div className="mt-auto px-4 pb-4 pt-0">
					<SendingStatusBar active={isSending} />
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
										current[contextKey] === "plan"
											? "acceptEdits"
											: "plan",
								}));
							}}
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

function SendingStatusBar({ active }: { active: boolean }) {
	if (!active) {
		return <div className="h-3" aria-hidden="true" />;
	}

	return (
		<div
			aria-live="polite"
			className="flex h-3 items-center pb-2 text-[11px] text-app-muted"
		>
			<span className="inline-flex items-center gap-1.5">
				<span className="size-1.5 rounded-full bg-app-progress" />
				Sending to agent
			</span>
		</div>
	);
}
