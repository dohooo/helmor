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
import type { ContextCard } from "@/lib/sources/types";
import { EMPTY_QUEUE, useSubmitQueue } from "@/lib/use-submit-queue";
import { cn } from "@/lib/utils";
import { getComposerContextKey } from "@/lib/workspace-helpers";
import {
	type ComposerSubmitPayload,
	useConversationStreaming,
} from "./hooks/use-streaming";
import {
	adaptPermissionToDeferredTool,
	permissionIdFromAdaptedToolUseId,
} from "./permission-as-deferred-tool";

export type { ComposerSubmitPayload } from "./hooks/use-streaming";

/** Outcome the create-workspace flow returns to the composer container. When
 *  `shouldStream` is true, the composer routes the submit through
 *  `handleComposerSubmit` with the override pointing at the freshly-created
 *  workspace + session, so the agent stream starts immediately. When false,
 *  the workspace was created without an immediate agent turn. */
export type ComposerCreatePrepareOutcome =
	| { shouldStream: false }
	| {
			shouldStream: true;
			workspaceId: string;
			sessionId: string;
			contextKey: string;
	  };

export type ComposerCreateContext = {
	/** Called by the composer's submit handler when this composer creates a
	 *  workspace before routing the prompt into the freshly-created session. */
	prepare: (
		payload: ComposerSubmitPayload,
		options?: { startSubmitMode?: "startNow" | "saveForLater" },
	) => Promise<ComposerCreatePrepareOutcome>;
};

export type PendingCreatedWorkspaceSubmit = {
	id: string;
	workspaceId: string;
	sessionId: string;
	payload: ComposerSubmitPayload;
	/** False until `await finalizePromise` resolves. The optimistic user
	 *  bubble is rendered as soon as the pending submit is queued, but the
	 *  actual `handleComposerSubmit` is held back until this flips true so
	 *  the backend's title-gen + sendMessage runs against an operational
	 *  workspace row (not one still in `initializing`). */
	finalized: boolean;
};

type WorkspaceConversationContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	repoId?: string | null;
	sessionSelectionHistory?: string[];
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	onSessionRunStateChange?: (
		sessionId: string,
		workspaceId: string | null,
		sending: boolean,
	) => void;
	onInteractionSessionsChange?: (
		sessionWorkspaceMap: Map<string, string>,
		interactionCounts: Map<string, number>,
	) => void;
	busySessionIds?: Set<string>;
	stoppableSessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	onSessionCompleted?: (sessionId: string, workspaceId: string) => void;
	workspaceChangeRequest?: ChangeRequestInfo | null;
	onSessionAborted?: (sessionId: string, workspaceId: string) => void;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	contextPreviewCard?: ContextCard | null;
	contextPreviewActive?: boolean;
	onSelectContextPreview?: () => void;
	onCloseContextPreview?: () => void;
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
	pendingCreatedWorkspaceSubmit?: PendingCreatedWorkspaceSubmit | null;
	onPendingCreatedWorkspaceSubmitConsumed?: (id: string) => void;
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
	composerOnly?: boolean;
	composerWrapperClassName?: string;
	/** Override placeholder text for the composer's editor. */
	composerPlaceholder?: string;
	/** When true, force the composer to act as if a workspace were
	 *  selected (skip the dim-out / disable applied when
	 *  `displayedWorkspaceId === null`). Used when the composer creates a
	 *  brand-new workspace on submit, so there is no pre-existing workspace ID
	 *  to gate on. */
	composerForceAvailable?: boolean;
	/** Override the composer's context key. Without this the key falls
	 *  back to `getComposerContextKey(displayedWorkspaceId, displayedSessionId)`
	 *  — fine for the regular chat view. Create-workspace surfaces use this
	 *  to scope drafts to the currently-selected repo. */
	composerContextKeyOverride?: string;
	/** Create-workspace intercept. When set, the composer's submit calls
	 *  `composerCreateContext.prepare` first and only fires the agent stream
	 *  if the prepare step says so. */
	composerCreateContext?: ComposerCreateContext | null;
	contextPanelOpen?: boolean;
	onToggleContextPanel?: () => void;
	composerStartSubmitMenu?: boolean;
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
		onSessionRunStateChange,
		onInteractionSessionsChange,
		busySessionIds,
		stoppableSessionIds,
		interactionRequiredSessionIds,
		onSessionCompleted,
		workspaceChangeRequest = null,
		onSessionAborted,
		headerActions,
		headerLeading,
		contextPreviewCard = null,
		contextPreviewActive = false,
		onSelectContextPreview,
		onCloseContextPreview,
		pendingPromptForSession = null,
		pendingCreatedWorkspaceSubmit = null,
		onPendingCreatedWorkspaceSubmitConsumed,
		onPendingPromptConsumed,
		pendingInsertRequests = [],
		onPendingInsertRequestsConsumed,
		onQueuePendingPromptForSession,
		onRequestCloseSession,
		workspaceRootPath,
		onOpenFileReference,
		composerOnly = false,
		composerWrapperClassName,
		composerPlaceholder,
		composerForceAvailable = false,
		composerContextKeyOverride,
		composerCreateContext = null,
		contextPanelOpen = false,
		onToggleContextPanel,
		composerStartSubmitMenu = false,
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

		const composerContextKey =
			composerContextKeyOverride ??
			getComposerContextKey(displayedWorkspaceId, displayedSessionId);
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
			busySessionIds: localBusySessionIds,
		} = useConversationStreaming({
			composerContextKey,
			displayedSelectedModelId,
			displayedSessionId,
			displayedWorkspaceId,
			repoId,
			selectionPending,
			followUpBehavior: settings.followUpBehavior,
			submitQueue: submitQueueApi,
			onSessionRunStateChange,
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

		// True while the freshly-created workspace's first send is queued
		// (we've shown the optimistic user bubble, but
		// `handleComposerSubmit` hasn't fired yet because finalize is still
		// in flight). Treated as "sending" by the panel header / status badge
		// so the loading state appears at click time, not at finalize time.
		const hasPendingOptimisticSubmit = Boolean(
			pendingCreatedWorkspaceSubmit &&
				pendingCreatedWorkspaceSubmit.workspaceId === displayedWorkspaceId &&
				pendingCreatedWorkspaceSubmit.sessionId === displayedSessionId,
		);
		const displayedSessionBusy = displayedSessionId
			? (busySessionIds?.has(displayedSessionId) ?? false)
			: false;
		const displayedSessionStoppable = displayedSessionId
			? (stoppableSessionIds?.has(displayedSessionId) ?? false)
			: false;
		const sendingForPanel =
			isSending || displayedSessionBusy || hasPendingOptimisticSubmit;
		const sendingForComposer = isSending || displayedSessionStoppable;
		const panelBusySessionIds = busySessionIds ?? localBusySessionIds;

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

		// Carry the StartPage composer config (model / effort / permission /
		// fast) into the new workspace's session contextKey. The start surface
		// stores these under `start:repo:<repoId>` in a *different* container
		// instance that unmounts on the surface swap, so without this seed the
		// chips on the new workspace fall back to settings defaults until
		// backend persistence updates the session row at end of turn — and any
		// follow-up sent before that catches up loses the user's choices.
		useEffect(() => {
			if (!pendingCreatedWorkspaceSubmit) return;
			const { workspaceId, sessionId, payload } = pendingCreatedWorkspaceSubmit;
			const targetKey = getComposerContextKey(workspaceId, sessionId);
			setComposerModelSelections((current) =>
				current[targetKey]
					? current
					: { ...current, [targetKey]: payload.model.id },
			);
			setComposerEffortLevels((current) =>
				current[targetKey]
					? current
					: { ...current, [targetKey]: payload.effortLevel },
			);
			setComposerPermissionModes((current) =>
				current[targetKey]
					? current
					: { ...current, [targetKey]: payload.permissionMode },
			);
			setComposerFastModes((current) =>
				targetKey in current
					? current
					: { ...current, [targetKey]: payload.fastMode },
			);
		}, [pendingCreatedWorkspaceSubmit]);

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
				if (composerCreateContext) {
					void (async () => {
						const outcome = await composerCreateContext.prepare(payload, {
							startSubmitMode: payload.startSubmitMode,
						});
						if (outcome.shouldStream) {
							await handleComposerSubmit(payload, {
								sessionId: outcome.sessionId,
								workspaceId: outcome.workspaceId,
								contextKey: outcome.contextKey,
							});
						}
					})();
					return;
				}
				void handleComposerSubmit(payload);
			},
			[handleComposerSubmit, composerCreateContext],
		);
		const dispatchedCreatedWorkspaceSubmitRef = useRef<string | null>(null);
		useEffect(() => {
			if (!pendingCreatedWorkspaceSubmit) {
				dispatchedCreatedWorkspaceSubmitRef.current = null;
				return;
			}
			if (
				pendingCreatedWorkspaceSubmit.workspaceId !== displayedWorkspaceId ||
				pendingCreatedWorkspaceSubmit.sessionId !== displayedSessionId
			) {
				return;
			}
			// Hold off until the App-level handler has awaited finalize. The
			// backend has already written `state=ready` / `setup_pending` by
			// the time `finalized` flips true — no React Query round-trip
			// needed before firing the submit.
			if (!pendingCreatedWorkspaceSubmit.finalized) {
				return;
			}
			if (
				dispatchedCreatedWorkspaceSubmitRef.current ===
				pendingCreatedWorkspaceSubmit.id
			) {
				return;
			}
			dispatchedCreatedWorkspaceSubmitRef.current =
				pendingCreatedWorkspaceSubmit.id;

			void (async () => {
				await handleComposerSubmit(
					{
						...pendingCreatedWorkspaceSubmit.payload,
						workingDirectory:
							workspaceRootPath ??
							pendingCreatedWorkspaceSubmit.payload.workingDirectory,
					},
					{
						sessionId: pendingCreatedWorkspaceSubmit.sessionId,
						workspaceId: pendingCreatedWorkspaceSubmit.workspaceId,
						contextKey: getComposerContextKey(
							pendingCreatedWorkspaceSubmit.workspaceId,
							pendingCreatedWorkspaceSubmit.sessionId,
						),
					},
				);
				onPendingCreatedWorkspaceSubmitConsumed?.(
					pendingCreatedWorkspaceSubmit.id,
				);
			})();
		}, [
			displayedSessionId,
			displayedWorkspaceId,
			handleComposerSubmit,
			onPendingCreatedWorkspaceSubmitConsumed,
			pendingCreatedWorkspaceSubmit,
			workspaceRootPath,
		]);
		const relevantPendingInsertRequests = pendingInsertRequests.filter(
			(request) => {
				return insertRequestMatchesComposer(request, {
					contextKey: composerContextKey,
					workspaceId: displayedWorkspaceId,
					sessionId: displayedSessionId,
				});
			},
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
				{composerOnly ? null : (
					<WorkspacePanelContainer
						selectedWorkspaceId={selectedWorkspaceId}
						displayedWorkspaceId={displayedWorkspaceId}
						selectedSessionId={selectedSessionId}
						displayedSessionId={displayedSessionId}
						sessionSelectionHistory={sessionSelectionHistory}
						sending={sendingForPanel}
						busySessionIds={panelBusySessionIds}
						interactionRequiredSessionIds={interactionRequiredSessionIds}
						modelSelections={composerModelSelections}
						workspaceChangeRequest={workspaceChangeRequest}
						onSelectSession={onSelectSession}
						onResolveDisplayedSession={onResolveDisplayedSession}
						onQueuePendingPromptForSession={onQueuePendingPromptForSession}
						onRequestCloseSession={onRequestCloseSession}
						contextPreviewCard={contextPreviewCard}
						contextPreviewActive={contextPreviewActive}
						onSelectContextPreview={onSelectContextPreview}
						onCloseContextPreview={onCloseContextPreview}
						headerActions={headerActions}
						headerLeading={headerLeading}
						optimisticPendingSubmit={
							pendingCreatedWorkspaceSubmit
								? {
										id: pendingCreatedWorkspaceSubmit.id,
										workspaceId: pendingCreatedWorkspaceSubmit.workspaceId,
										sessionId: pendingCreatedWorkspaceSubmit.sessionId,
										prompt: pendingCreatedWorkspaceSubmit.payload.prompt,
									}
								: null
						}
					/>
				)}

				<div
					className={cn(
						composerOnly ? "w-full" : "mt-auto px-4 pb-4 pt-0",
						composerWrapperClassName,
					)}
				>
					<WorkspaceComposerContainer
						displayedWorkspaceId={displayedWorkspaceId}
						displayedSessionId={displayedSessionId}
						repoId={repoId}
						disabled={selectionPending}
						forceAvailable={composerForceAvailable}
						placeholder={composerPlaceholder}
						contextKeyOverride={composerContextKeyOverride}
						sending={sendingForComposer}
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
						contextPanelOpen={contextPanelOpen}
						onToggleContextPanel={onToggleContextPanel}
						startSubmitMenu={composerStartSubmitMenu}
					/>
				</div>
			</FileLinkProvider>
		);
	},
);
