// React Compiler opt-out: this file has an intentional render-phase ref
// mutation + setState-during-render pattern (see ~line 117) that the
// compiler's rules-of-react check rejects. The pattern is documented as
// intentional and StrictMode-safe in situ.
"use no memo";

import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceComposerContainer } from "@/features/composer/container";
import type {
	DeferredToolResponseHandler,
	DeferredToolResponseOptions,
} from "@/features/composer/deferred-tool";
import { WorkspacePanelContainer } from "@/features/panel/container";
import { FileLinkProvider } from "@/features/panel/message-components/file-link-context";
import type { SessionCloseRequest } from "@/features/panel/use-confirm-session-close";
import type { ChangeRequestInfo } from "@/lib/api";
import type { ResolvedComposerInsertRequest } from "@/lib/composer-insert";
import { insertRequestMatchesComposer } from "@/lib/composer-insert";
import { hasUnresolvedPlanReview } from "@/lib/plan-review";
import { sessionThreadMessagesQueryOptions } from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import { EMPTY_QUEUE, useSubmitQueue } from "@/lib/use-submit-queue";
import { getComposerContextKey } from "@/lib/workspace-helpers";
import { useConversationStreaming } from "./hooks/use-streaming";
import {
	adaptPermissionToDeferredTool,
	permissionIdFromAdaptedToolUseId,
} from "./permission-as-deferred-tool";

type WorkspaceConversationContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	repoId?: string | null;
	sessionSelectionHistory?: string[];
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	onSendingWorkspacesChange?: (workspaceIds: Set<string>) => void;
	/** Reports the set of session IDs currently streaming, so App can observe
	 * session-level lifecycle events (e.g. the commit button driver needs to
	 * know when its target session's stream has ended). */
	onSendingSessionsChange?: (sessionIds: Set<string>) => void;
	onInteractionSessionsChange?: (
		sessionWorkspaceMap: Map<string, string>,
		interactionCounts: Map<string, number>,
	) => void;
	interactionRequiredSessionIds?: Set<string>;
	onSessionCompleted?: (sessionId: string, workspaceId: string) => void;
	workspaceChangeRequest?: ChangeRequestInfo | null;
	onSessionAborted?: (sessionId: string, workspaceId: string) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	/** Prompt queued by an external caller (e.g. the inspector Git commit
	 * button) to be auto-submitted once the displayed session matches. */
	pendingPromptForSession?: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
		/** When true, submit must queue if a turn is already streaming,
		 *  regardless of the user's `followUpBehavior` setting. */
		forceQueue?: boolean;
	} | null;
	/** Called after the pending prompt has been handed off to the composer's
	 * submit flow, so the caller can clear the queue. */
	onPendingPromptConsumed?: () => void;
	pendingInsertRequests?: ResolvedComposerInsertRequest[];
	onPendingInsertRequestsConsumed?: (ids: string[]) => void;
	onQueuePendingPromptForSession?: (request: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
	}) => void;
	onRequestCloseSession?: (request: SessionCloseRequest) => void;
	workspaceRootPath?: string | null;
	onOpenFileReference?: (path: string, line?: number, column?: number) => void;
};

export const WorkspaceConversationContainer = memo(
	function WorkspaceConversationContainer({
		selectedWorkspaceId,
		displayedWorkspaceId,
		selectedSessionId,
		displayedSessionId,
		repoId = null,
		sessionSelectionHistory = [],
		onSelectSession,
		onResolveDisplayedSession,
		onSendingWorkspacesChange,
		onSendingSessionsChange,
		onInteractionSessionsChange,
		interactionRequiredSessionIds,
		onSessionCompleted,
		workspaceChangeRequest = null,
		onSessionAborted,
		headerActions,
		headerLeading,
		pendingPromptForSession = null,
		onPendingPromptConsumed,
		pendingInsertRequests = [],
		onPendingInsertRequestsConsumed,
		onQueuePendingPromptForSession,
		onRequestCloseSession,
		workspaceRootPath,
		onOpenFileReference,
	}: WorkspaceConversationContainerProps) {
		const [composerModelSelections, setComposerModelSelections] = useState<
			Record<string, string>
		>({});
		const [composerEffortLevels, setComposerEffortLevels] = useState<
			Record<string, string>
		>({});
		const [composerPermissionModes, setComposerPermissionModes] = useState<
			Record<string, string>
		>({});
		const [composerFastModes, setComposerFastModes] = useState<
			Record<string, boolean>
		>({});

		const composerContextKey = getComposerContextKey(
			displayedWorkspaceId,
			displayedSessionId,
		);
		const displayedSelectedModelId =
			composerModelSelections[composerContextKey] ?? null;
		const selectionPending =
			selectedWorkspaceId !== displayedWorkspaceId ||
			selectedSessionId !== displayedSessionId;

		// App-level follow-up queue. Survives session / workspace
		// switches because this container is mounted once in the App
		// tree (not keyed by session id).
		const { settings } = useSettings();
		const { queuesBySessionId, api: submitQueueApi } = useSubmitQueue();

		const {
			activeSendError,
			handleComposerSubmit,
			handleDeferredToolResponse,
			handleElicitationResponse,
			handlePermissionResponse,
			handleStopStream,
			handleSteerQueued,
			handleRemoveQueued,
			elicitationResponsePending,
			isSending,
			pendingElicitation,
			pendingDeferredTool,
			pendingPermissions,
			restoreCustomTags,
			restoreDraft,
			restoreFiles,
			restoreImages,
			restoreNonce,
			activeFastPreludes,
			sendingSessionIds,
		} = useConversationStreaming({
			composerContextKey,
			displayedSelectedModelId,
			displayedSessionId,
			displayedWorkspaceId,
			repoId,
			selectionPending,
			followUpBehavior: settings.followUpBehavior,
			submitQueue: submitQueueApi,
			onSendingSessionsChange,
			onSendingWorkspacesChange,
			onInteractionSessionsChange,
			onSessionCompleted,
			onSessionAborted,
		});

		const queueItems = displayedSessionId
			? (queuesBySessionId.get(displayedSessionId) ?? EMPTY_QUEUE)
			: EMPTY_QUEUE;

		// Derived from thread messages — survives refresh / session switch.
		const threadQuery = useQuery({
			...sessionThreadMessagesQueryOptions(displayedSessionId ?? "__none__"),
			enabled: Boolean(displayedSessionId),
		});
		const hasPlanReview = useMemo(
			() => hasUnresolvedPlanReview(threadQuery.data ?? []),
			[threadQuery.data],
		);

		// Auto-activate plan button when AI enters plan mode on its own.
		const prevPlanReviewRef = useRef(false);
		useEffect(() => {
			if (hasPlanReview && !prevPlanReviewRef.current) {
				setComposerPermissionModes((current) => ({
					...current,
					[composerContextKey]: "plan",
				}));
			}
			prevPlanReviewRef.current = hasPlanReview;
		}, [hasPlanReview, composerContextKey]);

		// Preset composer model when a pending prompt carries an explicit
		// modelId (e.g. Review uses settings.reviewModelId). Without this
		// the chip below the chat keeps showing the inferred default while the
		// submit silently uses the queued modelId — mismatch the user sees.
		useEffect(() => {
			if (!pendingPromptForSession?.modelId) return;
			const targetKey = getComposerContextKey(
				displayedWorkspaceId,
				pendingPromptForSession.sessionId,
			);
			setComposerModelSelections((current) =>
				current[targetKey] === pendingPromptForSession.modelId
					? current
					: {
							...current,
							[targetKey]: pendingPromptForSession.modelId as string,
						},
			);
		}, [pendingPromptForSession, displayedWorkspaceId]);

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

		const handleChangePermissionMode = useCallback(
			(contextKey: string, mode: string) => {
				setComposerPermissionModes((current) => ({
					...current,
					[contextKey]: mode,
				}));
			},
			[],
		);

		const handleChangeFastMode = useCallback(
			(contextKey: string, enabled: boolean) => {
				setComposerFastModes((current) => ({
					...current,
					[contextKey]: enabled,
				}));
			},
			[],
		);

		const handleComposerSubmitWrapper = useCallback(
			(payload: Parameters<typeof handleComposerSubmit>[0]) => {
				void handleComposerSubmit(payload);
			},
			[handleComposerSubmit],
		);
		const relevantPendingInsertRequests = pendingInsertRequests.filter(
			(request) =>
				insertRequestMatchesComposer(request, {
					workspaceId: displayedWorkspaceId,
					sessionId: displayedSessionId,
				}),
		);

		// Permission requests are rendered through the same `GenericDeferredToolPanel`
		// as deferred-tool requests so both flows share one UI. Pick the head of the
		// queue (one-at-a-time, same as `pendingDeferredTool`) and adapt it. The
		// wrapped response handler routes callbacks back to the correct API.
		const headPendingPermission = pendingPermissions[0] ?? null;
		const permissionAsDeferredTool = useMemo(
			() =>
				headPendingPermission
					? adaptPermissionToDeferredTool(headPendingPermission)
					: null,
			[headPendingPermission],
		);

		const effectivePendingDeferredTool =
			pendingDeferredTool ?? permissionAsDeferredTool;

		const effectiveDeferredToolResponse =
			useCallback<DeferredToolResponseHandler>(
				(deferred, behavior, options?: DeferredToolResponseOptions) => {
					const permissionId = permissionIdFromAdaptedToolUseId(
						deferred.toolUseId,
					);
					if (permissionId !== null) {
						handlePermissionResponse(
							permissionId,
							behavior,
							options?.reason ? { message: options.reason } : undefined,
						);
						return;
					}
					handleDeferredToolResponse(deferred, behavior, options);
				},
				[handlePermissionResponse, handleDeferredToolResponse],
			);

		return (
			<FileLinkProvider
				value={{
					openInEditor: onOpenFileReference,
					workspaceRootPath,
				}}
			>
				<WorkspacePanelContainer
					selectedWorkspaceId={selectedWorkspaceId}
					displayedWorkspaceId={displayedWorkspaceId}
					selectedSessionId={selectedSessionId}
					displayedSessionId={displayedSessionId}
					sessionSelectionHistory={sessionSelectionHistory}
					sending={isSending}
					sendingSessionIds={sendingSessionIds}
					interactionRequiredSessionIds={interactionRequiredSessionIds}
					modelSelections={composerModelSelections}
					workspaceChangeRequest={workspaceChangeRequest}
					onSelectSession={onSelectSession}
					onResolveDisplayedSession={onResolveDisplayedSession}
					onQueuePendingPromptForSession={onQueuePendingPromptForSession}
					onRequestCloseSession={onRequestCloseSession}
					headerActions={headerActions}
					headerLeading={headerLeading}
				/>

				<div className="mt-auto px-4 pb-4 pt-0">
					<WorkspaceComposerContainer
						displayedWorkspaceId={displayedWorkspaceId}
						displayedSessionId={displayedSessionId}
						disabled={selectionPending}
						sending={isSending}
						sendError={activeSendError}
						restoreDraft={restoreDraft}
						restoreImages={restoreImages}
						restoreFiles={restoreFiles}
						restoreCustomTags={restoreCustomTags}
						restoreNonce={restoreNonce}
						pendingElicitation={pendingElicitation}
						onElicitationResponse={handleElicitationResponse}
						elicitationResponsePending={elicitationResponsePending}
						pendingDeferredTool={effectivePendingDeferredTool}
						onDeferredToolResponse={effectiveDeferredToolResponse}
						hasPlanReview={hasPlanReview}
						modelSelections={composerModelSelections}
						effortLevels={composerEffortLevels}
						permissionModes={composerPermissionModes}
						fastModes={composerFastModes}
						activeFastPreludes={activeFastPreludes}
						onSelectModel={handleSelectModel}
						onSelectEffort={handleSelectEffort}
						onChangePermissionMode={handleChangePermissionMode}
						onChangeFastMode={handleChangeFastMode}
						onSwitchSession={onSelectSession}
						onSubmit={handleComposerSubmitWrapper}
						onStop={handleStopStream}
						pendingPromptForSession={pendingPromptForSession}
						onPendingPromptConsumed={onPendingPromptConsumed}
						pendingInsertRequests={relevantPendingInsertRequests}
						onPendingInsertRequestsConsumed={onPendingInsertRequestsConsumed}
						queueItems={queueItems}
						onSteerQueued={handleSteerQueued}
						onRemoveQueued={handleRemoveQueued}
					/>
				</div>
			</FileLinkProvider>
		);
	},
);
