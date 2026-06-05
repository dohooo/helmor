// React Compiler opt-out: this file has an intentional render-phase ref
// mutation + setState-during-render pattern (see ~line 117) that the
// compiler's rules-of-react check rejects. The pattern is documented as
// intentional and StrictMode-safe in situ.
"use no memo";

import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceComposerContainer } from "@/features/composer/container";
import type { StartSubmitMode } from "@/features/composer/start-submit-mode";
import type { UserInputResponseHandler } from "@/features/composer/user-input";
import { WorkspacePanelContainer } from "@/features/panel/container";
import { FileLinkProvider } from "@/features/panel/message-components/file-link-context";
import type { SessionCloseRequest } from "@/features/panel/use-confirm-session-close";
import {
	type ActiveStreamSummary,
	type ChangeRequestInfo,
	subscribeUiMutations,
	updateSessionSettings,
} from "@/lib/api";
import type { ResolvedComposerInsertRequest } from "@/lib/composer-insert";
import { insertRequestMatchesComposer } from "@/lib/composer-insert";
import { hasUnresolvedPlanReview } from "@/lib/plan-review";
import { sessionThreadMessagesQueryOptions } from "@/lib/query-client";
import { useSettings } from "@/lib/settings";
import type { ContextCard } from "@/lib/sources/types";
import {
	useSubmitQueueApi,
	useSubmitQueueForSession,
} from "@/lib/use-submit-queue";
import { cn } from "@/lib/utils";
import {
	getComposerContextKey,
	parseSessionIdFromContextKey,
} from "@/lib/workspace-helpers";
import {
	type ComposerSubmitPayload,
	useConversationStreaming,
} from "./hooks/use-streaming";

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
		options?: { startSubmitMode?: StartSubmitMode },
	) => Promise<ComposerCreatePrepareOutcome>;
};

export type PendingCreatedWorkspaceSubmit = {
	id: string;
	workspaceId: string;
	sessionId: string;
	/** New workspace's repo, forwarded into the first-turn send so the
	 *  preference prefix stays correct even after navigating away. */
	repoId?: string | null;
	payload: ComposerSubmitPayload;
	/** False until `await finalizePromise` resolves. The optimistic user
	 *  bubble is rendered as soon as the pending submit is queued, but the
	 *  actual `handleComposerSubmit` is held back until this flips true so
	 *  the backend's title-gen + sendMessage runs against an operational
	 *  workspace row (not one still in `initializing`). */
	finalized: boolean;
};

export type WorkspaceConversationContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
	repoId?: string | null;
	sessionSelectionHistory?: string[];
	onSelectSession: (sessionId: string | null) => void;
	onResolveDisplayedSession: (sessionId: string | null) => void;
	onInteractionSessionsChange?: (
		sessionWorkspaceMap: Map<string, string>,
		interactionCounts: Map<string, number>,
	) => void;
	/** Backend-truth active-streams snapshot from App's
	 *  `activeStreamsQuery`. Survives this container's unmount/remount,
	 *  so follow-up routing/drain stays correct across start ↔ chat. */
	activeStreams: readonly ActiveStreamSummary[];
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
	 *  button or a drained CLI send) to be auto-submitted once the displayed
	 *  session matches. Per-session config (model / effort / fast-mode /
	 *  permission mode) is pinned onto the session row at create time and
	 *  read off `currentSession` by the composer — it intentionally does NOT
	 *  ride along on this transient handoff. */
	pendingPromptForSession?: {
		sessionId: string;
		prompt: string;
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
	/** Surface-specific focus scope forwarded to the composer. `start-composer`
	 *  on the workspace-start page, `workspace-composer` everywhere else.
	 *  See `WorkspaceComposerContainerProps.focusScope`. */
	composerFocusScope?: "start-composer" | "workspace-composer";
	/** Pre-workspace linked-directories controller. Forwarded to the
	 *  composer; see `WorkspaceComposerContainerProps.linkedDirectoriesController`.
	 *  Used by the start-page composer to collect /add-dir picks before any
	 *  workspace exists. */
	composerLinkedDirectoriesController?: {
		directories: readonly string[];
		onChange: (next: readonly string[]) => void;
	} | null;
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
		onInteractionSessionsChange,
		activeStreams,
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
		composerFocusScope = "workspace-composer",
		composerLinkedDirectoriesController = null,
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
		// P0-B: this file is `"use no memo"` (intentional render-phase ref
		// mutation near the top), so the React Compiler will NOT memoize the
		// FileLink context value for us. An inline object literal would change
		// the context identity on every render of this container and cascade to
		// every file-link consumer in the thread. Memoize by hand.
		const fileLinkValue = useMemo(
			() => ({ openInEditor: onOpenFileReference, workspaceRootPath }),
			[onOpenFileReference, workspaceRootPath],
		);
		const composerContextKey =
			composerContextKeyOverride ??
			getComposerContextKey(displayedWorkspaceId, displayedSessionId);
		const displayedSelectedModelId =
			composerModelSelections[composerContextKey] ?? null;
		const selectionPending =
			selectedWorkspaceId !== displayedWorkspaceId ||
			selectedSessionId !== displayedSessionId;

		// Submit queue is a module-level Zustand singleton — survives this
		// container's unmount (the start-page ↔ workspace toggle renders two
		// independent React subtrees, and the queue must outlive both).
		const { settings } = useSettings();
		const submitQueueApi = useSubmitQueueApi();

		const {
			activeSendError,
			handleComposerSubmit,
			handleUserInputResponse,
			handlePermissionResponse,
			handleStopStream,
			handleSteerQueued,
			handleRemoveQueued,
			handleEditQueued,
			userInputResponsePending,
			isSending,
			pendingUserInput,
			pendingPermissions,
			restoreCustomTags,
			restoreDraft,
			restoreEditorState,
			restoreFiles,
			restoreImages,
			restoreNonce,
			activeFastPreludes,
			clearFastPrelude,
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
			activeStreams,
			onInteractionSessionsChange,
			onSessionCompleted,
			onSessionAborted,
		});

		const queueItems = useSubmitQueueForSession(displayedSessionId);

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

		// Composer picks are persisted to `sessions` immediately so they
		// survive a conversation-container unmount (e.g. switching to start
		// page and back). Memory cache is kept for optimistic UI. Only
		// `session:*` contextKeys map to a session row — start-page /
		// workspace / global keys are memory-only.
		const persistSessionSetting = useCallback(
			(
				contextKey: string,
				patch: Parameters<typeof updateSessionSettings>[1],
			) => {
				const sessionId = parseSessionIdFromContextKey(contextKey);
				if (!sessionId) return;
				void updateSessionSettings(sessionId, patch).catch((error) => {
					console.error(
						"Failed to persist composer setting",
						{ sessionId, patch },
						error,
					);
				});
			},
			[],
		);

		const handleSelectModel = useCallback(
			(contextKey: string, modelId: string) => {
				setComposerModelSelections((current) => ({
					...current,
					[contextKey]: modelId,
				}));
				persistSessionSetting(contextKey, { model: modelId });
			},
			[persistSessionSetting],
		);

		const handleSelectEffort = useCallback(
			(contextKey: string, level: string) => {
				setComposerEffortLevels((current) => ({
					...current,
					[contextKey]: level,
				}));
				persistSessionSetting(contextKey, { effortLevel: level });
			},
			[persistSessionSetting],
		);

		const handleChangePermissionMode = useCallback(
			(contextKey: string, mode: string) => {
				setComposerPermissionModes((current) => ({
					...current,
					[contextKey]: mode,
				}));
				persistSessionSetting(contextKey, { permissionMode: mode });
			},
			[persistSessionSetting],
		);

		const handleChangeFastMode = useCallback(
			(contextKey: string, enabled: boolean) => {
				setComposerFastModes((current) => ({
					...current,
					[contextKey]: enabled,
				}));
				persistSessionSetting(contextKey, { fastMode: enabled });
			},
			[persistSessionSetting],
		);

		// Fast mode didn't engage: flip the toggle off and clear the prelude
		// animation (this turn never ran fast — unlike a mid-stream manual
		// toggle, which keeps the cue).
		useEffect(() => {
			let disposed = false;
			let unlisten: (() => void) | null = null;
			subscribeUiMutations((event) => {
				if (disposed || event.type !== "fastModeUnavailable") return;
				const contextKey = `session:${event.sessionId}`;
				handleChangeFastMode(contextKey, false);
				clearFastPrelude(contextKey);
			})
				.then((cleanup) => {
					if (disposed) cleanup();
					else unlisten = cleanup;
				})
				.catch((error) => {
					console.error(
						"[conversation] fast-mode sync subscribe failed",
						error,
					);
				});
			return () => {
				disposed = true;
				unlisten?.();
			};
		}, [handleChangeFastMode, clearFastPrelude]);

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
			// Not gated on the displayed workspace: the send targets the
			// pending session via `override`, so it must fire even if the user
			// navigated away during finalize. Wait for `finalized` though —
			// the backend row is operational only once it flips true.
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
				// `payload.workingDirectory` is patched by App.tsx with the
				// cwd returned from prepare/finalize, so the first turn never
				// races the workspaceDetail React Query — no need to fall
				// back to `workspaceRootPath` here.
				await handleComposerSubmit(pendingCreatedWorkspaceSubmit.payload, {
					sessionId: pendingCreatedWorkspaceSubmit.sessionId,
					workspaceId: pendingCreatedWorkspaceSubmit.workspaceId,
					contextKey: getComposerContextKey(
						pendingCreatedWorkspaceSubmit.workspaceId,
						pendingCreatedWorkspaceSubmit.sessionId,
					),
					...(pendingCreatedWorkspaceSubmit.repoId !== undefined
						? { repoId: pendingCreatedWorkspaceSubmit.repoId }
						: {}),
				});
				onPendingCreatedWorkspaceSubmitConsumed?.(
					pendingCreatedWorkspaceSubmit.id,
				);
			})();
		}, [
			handleComposerSubmit,
			onPendingCreatedWorkspaceSubmitConsumed,
			pendingCreatedWorkspaceSubmit,
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

		// Permission requests have their own dedicated `permissionRequest`
		// wire event + RPC and render through `PermissionPanel`; user-input
		// requests (AskUserQuestion / MCP elicitation / Codex
		// `requestUserInput`) ride the unified `userInputRequest` event +
		// `respondToUserInput` RPC and render through `UserInputPanel`. Both
		// surface as composer takeovers; the composer picks one panel at a
		// time (user-input takes priority since it's the agent's explicit
		// ask). We pick the head of the permission queue (one-at-a-time
		// same as user-input), and pass both panels' state down to the
		// composer container.
		const headPendingPermission = pendingPermissions[0] ?? null;

		// Type alias for clarity at the prop boundary — the composer takes
		// the same handler shape regardless of which panel is rendered.
		const userInputResponse: UserInputResponseHandler = handleUserInputResponse;

		return (
			<FileLinkProvider value={fileLinkValue}>
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
						restoreEditorState={restoreEditorState}
						restoreNonce={restoreNonce}
						pendingUserInput={pendingUserInput}
						onUserInputResponse={userInputResponse}
						userInputResponsePending={userInputResponsePending}
						pendingPermission={headPendingPermission}
						onPermissionResponse={handlePermissionResponse}
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
						onEditQueued={handleEditQueued}
						contextPanelOpen={contextPanelOpen}
						onToggleContextPanel={onToggleContextPanel}
						startSubmitMenu={composerStartSubmitMenu}
						focusScope={composerFocusScope}
						linkedDirectoriesController={composerLinkedDirectoriesController}
					/>
				</div>
			</FileLinkProvider>
		);
	},
);
