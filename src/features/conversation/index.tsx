// React Compiler opt-out: this file has an intentional render-phase ref
// mutation + setState-during-render pattern (see ~line 117) that the
// compiler's rules-of-react check rejects. The pattern is documented as
// intentional and StrictMode-safe in situ.
"use no memo";

import { Check, ShieldQuestion, X } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { ActionRow, ActionRowButton } from "@/components/action-row";
import { WorkspaceComposerContainer } from "@/features/composer/container";
import { WorkspacePanelContainer } from "@/features/panel/container";
import type { PullRequestInfo } from "@/lib/api";
import type { ResolvedComposerInsertRequest } from "@/lib/composer-insert";
import { insertRequestMatchesComposer } from "@/lib/composer-insert";
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
	completedSessionIds?: Set<string>;
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
		completedSessionIds,
		onSessionCompleted,
		workspacePrInfo = null,
		headerActions,
		headerLeading,
		pendingPromptForSession = null,
		onPendingPromptConsumed,
		pendingInsertRequests = [],
		onPendingInsertRequestsConsumed,
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
			handlePermissionResponse,
			handleStopStream,
			isSending,
			pendingPermissions,
			restoreCustomTags,
			restoreDraft,
			restoreFiles,
			restoreImages,
			restoreNonce,
			selectedProvider,
			sendingSessionIds,
		} = useConversationStreaming({
			composerContextKey,
			displayedSelectedModelId,
			displayedSessionId,
			displayedWorkspaceId,
			selectionPending,
			onSendingSessionsChange,
			onSendingWorkspacesChange,
			onSessionCompleted,
		});

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
		const relevantPendingInsertRequests = pendingInsertRequests.filter(
			(request) =>
				insertRequestMatchesComposer(request, {
					workspaceId: displayedWorkspaceId,
					sessionId: displayedSessionId,
				}),
		);

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
					selectedProvider={selectedProvider}
					workspacePrInfo={workspacePrInfo}
					onSelectSession={onSelectSession}
					onResolveDisplayedSession={onResolveDisplayedSession}
					headerActions={headerActions}
					headerLeading={headerLeading}
				/>

				<div className="mt-auto px-4 pb-4 pt-0">
					<div>
						{pendingPermissions.map((perm) => {
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
							modelSelections={composerModelSelections}
							effortLevels={composerEffortLevels}
							permissionModes={composerPermissionModes}
							onSelectModel={handleSelectModel}
							onSelectEffort={handleSelectEffort}
							onTogglePlanMode={handleTogglePlanMode}
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
