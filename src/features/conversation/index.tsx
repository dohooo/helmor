// React Compiler opt-out: this file has an intentional render-phase ref
// mutation + setState-during-render pattern (see ~line 117) that the
// compiler's rules-of-react check rejects. The pattern is documented as
// intentional and StrictMode-safe in situ.
"use no memo";

import { useQuery } from "@tanstack/react-query";
import { Check, ShieldQuestion, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionRow, ActionRowButton } from "@/components/action-row";
import { WorkspaceComposerContainer } from "@/features/composer/container";
import { WorkspacePanelContainer } from "@/features/panel/container";
import type { PullRequestInfo } from "@/lib/api";
import type { ResolvedComposerInsertRequest } from "@/lib/composer-insert";
import { insertRequestMatchesComposer } from "@/lib/composer-insert";
import { hasUnresolvedPlanReview } from "@/lib/plan-review";
import { sessionThreadMessagesQueryOptions } from "@/lib/query-client";
import { getComposerContextKey } from "@/lib/workspace-helpers";
import { useConversationStreaming } from "./hooks/use-streaming";

type WorkspaceConversationContainerProps = {
	selectedWorkspaceId: string | null;
	displayedWorkspaceId: string | null;
	selectedSessionId: string | null;
	displayedSessionId: string | null;
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
	completedSessionIds?: Set<string>;
	interactionRequiredSessionIds?: Set<string>;
	onSessionCompleted?: (sessionId: string, workspaceId: string) => void;
	workspacePrInfo?: PullRequestInfo | null;
	headerActions?: React.ReactNode;
	headerLeading?: React.ReactNode;
	/** Prompt queued by an external caller (e.g. the inspector Git commit
	 * button) to be auto-submitted once the displayed session matches. */
	pendingPromptForSession?: {
		sessionId: string;
		prompt: string;
		modelId?: string | null;
		permissionMode?: string | null;
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
		onSendingSessionsChange,
		onInteractionSessionsChange,
		completedSessionIds,
		interactionRequiredSessionIds,
		onSessionCompleted,
		workspacePrInfo = null,
		headerActions,
		headerLeading,
		pendingPromptForSession = null,
		onPendingPromptConsumed,
		pendingInsertRequests = [],
		onPendingInsertRequestsConsumed,
		onQueuePendingPromptForSession,
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
		const {
			activeSendError,
			handleComposerSubmit,
			handleDeferredToolResponse,
			handleElicitationResponse,
			handlePermissionResponse,
			handleStopStream,
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
			selectionPending,
			onSendingSessionsChange,
			onSendingWorkspacesChange,
			onInteractionSessionsChange,
			onSessionCompleted,
		});

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

		const toolPermissions = pendingPermissions;

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
					completedSessionIds={completedSessionIds}
					interactionRequiredSessionIds={interactionRequiredSessionIds}
					modelSelections={composerModelSelections}
					workspacePrInfo={workspacePrInfo}
					onSelectSession={onSelectSession}
					onResolveDisplayedSession={onResolveDisplayedSession}
					onQueuePendingPromptForSession={onQueuePendingPromptForSession}
					headerActions={headerActions}
					headerLeading={headerLeading}
				/>

				<div className="mt-auto px-4 pb-4 pt-0">
					<div>
						{toolPermissions.map((perm) => {
							const action = perm.toolName || "Tool";
							const target =
								typeof perm.toolInput?.file_path === "string"
									? perm.toolInput.file_path
									: typeof perm.toolInput?.command === "string"
										? perm.toolInput.command
										: null;
							const label =
								perm.title ??
								(perm.description ? `${action}: ${perm.description}` : null);
							return (
								<ActionRow
									key={perm.permissionId}
									className="relative z-10 mx-auto -mb-px w-[90%] rounded-t-[14px]"
									leading={
										<>
											<ShieldQuestion
												className="size-3.5 shrink-0 text-muted-foreground/60"
												strokeWidth={1.8}
												aria-hidden="true"
											/>
											<span className="truncate text-[12px] font-medium tracking-[0.01em] text-muted-foreground">
												{label ?? (
													<>
														<span className="font-semibold">{action}</span>
														{target && (
															<span className="ml-1.5 text-muted-foreground/60">
																{target}
															</span>
														)}
													</>
												)}
											</span>
										</>
									}
									trailing={
										<>
											<ActionRowButton
												onClick={() =>
													handlePermissionResponse(perm.permissionId, "deny")
												}
											>
												<X className="size-[11px]" strokeWidth={2} />
												Deny
											</ActionRowButton>
											<ActionRowButton
												active
												onClick={() =>
													handlePermissionResponse(perm.permissionId, "allow")
												}
											>
												<Check className="size-[11px]" strokeWidth={2} />
												Allow
											</ActionRowButton>
										</>
									}
								/>
							);
						})}
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
							pendingDeferredTool={pendingDeferredTool}
							onDeferredToolResponse={handleDeferredToolResponse}
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
						/>
					</div>
				</div>
			</>
		);
	},
);
